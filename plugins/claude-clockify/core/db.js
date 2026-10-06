import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './config.js';

/** @typedef {'SessionStart'|'UserPromptSubmit'|'Stop'|'SessionEnd'|'ManualClose'} EventType */
/** @typedef {{sessionId: string, ts: number, type: EventType, cwd: string, text?: string}} Event */

export const EVENT_TYPES = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'ManualClose']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  sessionId TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  text TEXT,
  PRIMARY KEY (sessionId, ts, type)
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS mappings (
  cwd TEXT PRIMARY KEY,
  projectId TEXT,
  taskId TEXT,
  tagIds TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  sessionId TEXT NOT NULL,
  startTs INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  endTs INTEGER NOT NULL,
  computedMin REAL NOT NULL,
  minutes REAL NOT NULL,
  startAt INTEGER NOT NULL,
  projectId TEXT,
  taskId TEXT,
  tagIds TEXT,
  description TEXT,
  status TEXT NOT NULL,
  clockifyId TEXT,
  PRIMARY KEY (sessionId, startTs)
);
`;

// Defensive, idempotent: early development builds stored the entry status as Italian words.
const MIGRATE_STATUS = `UPDATE entries SET status = CASE status
  WHEN 'in corso' THEN 'in_progress' WHEN 'proposta' THEN 'proposed'
  WHEN 'modificata' THEN 'edited' WHEN 'inviata' THEN 'sent' ELSE status END
  WHERE status IN ('in corso', 'proposta', 'modificata', 'inviata')`;

/** @param {string} [file] path or ':memory:'; defaults to <dataDir>/data.sqlite */
export function openDb(file) {
  const target = file ?? path.join(dataDir(), 'data.sqlite');
  const db = new DatabaseSync(target, { timeout: 5000 });
  const onDisk = target !== ':memory:';
  if (onDisk) makePrivate(target); // before WAL/SHM exist: SQLite creates them with the main file's mode
  db.exec('PRAGMA busy_timeout=5000');
  if (onDisk) db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  db.exec(MIGRATE_STATUS);
  if (onDisk) for (const suffix of ['-wal', '-shm']) makePrivate(target + suffix);
  return db;
}

/** chmod 0o600 if the file exists (the DB holds prompt texts). Never throws. */
function makePrivate(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // missing file or not ours: nothing to do
  }
}

/** @returns {boolean} true if inserted, false if duplicate */
export function insertEvent(db, e) {
  const r = db
    .prepare('INSERT OR IGNORE INTO events (sessionId, ts, type, cwd, text) VALUES (?, ?, ?, ?, ?)')
    .run(e.sessionId, e.ts, e.type, e.cwd, e.text ?? null);
  return r.changes > 0;
}

/** @returns {Event[]} ordered by sessionId, ts */
export function listEvents(db, sinceTs = 0) {
  return db
    .prepare('SELECT sessionId, ts, type, cwd, text FROM events WHERE ts >= ? ORDER BY sessionId, ts')
    .all(sinceTs)
    .map((r) => ({ ...r }));
}
