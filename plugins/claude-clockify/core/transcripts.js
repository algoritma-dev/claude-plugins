import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { insertEvent } from './db.js';

const MAX_TEXT = 200;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Synchronous line-by-line reader (64KB chunks): never loads the whole file. */
function* readLines(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const dec = new StringDecoder('utf8');
  let rest = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      rest += dec.write(buf.subarray(0, n));
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        yield rest.slice(0, i);
        rest = rest.slice(i + 1);
      }
    }
    rest += dec.end();
    if (rest) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

/** Human prompt text, or null if the line is not a real prompt. */
function promptText(line) {
  if (line.isMeta || line.isSidechain) return null;
  const c = line.message?.content;
  if (typeof c === 'string') return c.trim() ? c.slice(0, MAX_TEXT) : null;
  if (Array.isArray(c)) {
    const t = c.find((b) => b?.type === 'text' && typeof b.text === 'string');
    return t && t.text.trim() ? t.text.slice(0, MAX_TEXT) : null;
  }
  return null;
}

function importFile(db, file) {
  let inserted = 0;
  let skipped = 0;
  let lastCwd = null;
  const started = new Set();
  db.exec('BEGIN');
  try {
    for (const raw of readLines(file)) {
      if (!raw.trim()) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      if (line === null || typeof line !== 'object') {
        skipped++;
        continue;
      }
      if (line.type !== 'user' && line.type !== 'assistant') continue; // irrelevant types
      const ts = typeof line.timestamp === 'string' && ISO_RE.test(line.timestamp) ? Date.parse(line.timestamp) : NaN;
      if (Number.isNaN(ts) || typeof line.sessionId !== 'string' || !line.sessionId) {
        skipped++;
        continue;
      }
      if (typeof line.cwd === 'string' && line.cwd) lastCwd = line.cwd;
      const cwd = lastCwd;
      if (!cwd) {
        skipped++;
        continue;
      }
      if (line.isSidechain) continue;
      let type;
      let text;
      if (line.type === 'assistant') type = 'Stop';
      else {
        text = promptText(line);
        if (text === null) continue;
        type = 'UserPromptSubmit';
      }
      const sessionId = line.sessionId;
      if (!started.has(sessionId)) {
        started.add(sessionId);
        if (insertEvent(db, { sessionId, ts, type: 'SessionStart', cwd })) inserted++;
      }
      if (insertEvent(db, { sessionId, ts, type, cwd, ...(text !== undefined && { text }) })) inserted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, skipped };
}

/**
 * Backfill the events table from Claude Code transcripts (rootDir/<project>/*.jsonl).
 * Idempotent: INSERT OR IGNORE on (sessionId, ts, type).
 * @returns {{files: number, inserted: number, skipped: number}}
 */
export function importTranscripts(db, rootDir = defaultProjectsDir()) {
  const result = { files: 0, inserted: 0, skipped: 0 };
  let projects;
  try {
    projects = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const p of projects) {
    if (!p.isDirectory() || p.name === 'memory') continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(rootDir, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try {
        const r = importFile(db, path.join(rootDir, p.name, f.name));
        result.files++;
        result.inserted += r.inserted;
        result.skipped += r.skipped;
      } catch {
        // a failing file must not stop the others
      }
    }
  }
  return result;
}
