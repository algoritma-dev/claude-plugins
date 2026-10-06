import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb, insertEvent, listEvents } from '../core/db.js';
import { importTranscripts } from '../core/transcripts.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'projects');
const T = (iso) => Date.parse(iso);

test('imports valid lines as events plus SessionStart; counts bad lines as skipped', () => {
  const db = openDb(':memory:');
  const r = importTranscripts(db, FIXTURES);
  assert.deepEqual(r, { files: 1, inserted: 4, skipped: 2 });
  assert.deepEqual(
    listEvents(db).map((e) => [e.type, e.ts, e.cwd, e.text]),
    [
      ['SessionStart', T('2026-01-01T10:00:00.000Z'), '/tmp/demo', null],
      ['UserPromptSubmit', T('2026-01-01T10:00:00.000Z'), '/tmp/demo', 'first prompt'],
      ['Stop', T('2026-01-01T10:00:05.000Z'), '/tmp/demo', null],
      ['UserPromptSubmit', T('2026-01-01T10:01:00.000Z'), '/tmp/demo', 'second prompt'],
    ].sort((a, b) => a[1] - b[1]),
  );
});

test('second import inserts nothing', () => {
  const db = openDb(':memory:');
  importTranscripts(db, FIXTURES);
  const r = importTranscripts(db, FIXTURES);
  assert.equal(r.inserted, 0);
  assert.equal(listEvents(db).length, 4);
});

test('events already inserted by hooks are not duplicated', () => {
  const db = openDb(':memory:');
  insertEvent(db, { sessionId: 'sess-a', ts: T('2026-01-01T10:00:05.000Z'), type: 'Stop', cwd: '/tmp/demo' });
  const r = importTranscripts(db, FIXTURES);
  assert.equal(r.inserted, 3);
  assert.equal(listEvents(db).filter((e) => e.type === 'Stop').length, 1);
});

function tmpRoot(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tr-'));
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return root;
}

test('prompt text is truncated to 200 chars', () => {
  const root = tmpRoot([
    { type: 'user', sessionId: 's', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/c', message: { content: 'x'.repeat(500) } },
  ]);
  const db = openDb(':memory:');
  importTranscripts(db, root);
  const p = listEvents(db).find((e) => e.type === 'UserPromptSubmit');
  assert.equal(p.text.length, 200);
  fs.rmSync(root, { recursive: true });
});

test('lines without cwd and no prior cwd are skipped', () => {
  const root = tmpRoot([
    { type: 'assistant', sessionId: 's', timestamp: '2026-01-01T10:00:00.000Z', message: {} },
  ]);
  const db = openDb(':memory:');
  assert.deepEqual(importTranscripts(db, root), { files: 1, inserted: 0, skipped: 1 });
  fs.rmSync(root, { recursive: true });
});

test('missing rootDir returns zeros', () => {
  const db = openDb(':memory:');
  assert.deepEqual(importTranscripts(db, '/nonexistent/clockify-xyz'), { files: 0, inserted: 0, skipped: 0 });
});
