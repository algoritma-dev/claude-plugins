import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb, insertEvent, listEvents, EVENT_TYPES } from '../core/db.js';

const ev = (over = {}) => ({ sessionId: 's1', ts: 1000, type: 'SessionStart', cwd: '/p', ...over });

test('insertEvent is idempotent on (sessionId, ts, type)', () => {
  const db = openDb(':memory:');
  assert.equal(insertEvent(db, ev()), true);
  assert.equal(insertEvent(db, ev()), false);
  assert.equal(listEvents(db).length, 1);
});

test('listEvents(sinceTs) excludes earlier events and orders by sessionId, ts', () => {
  const db = openDb(':memory:');
  insertEvent(db, ev({ sessionId: 'b', ts: 3000, type: 'Stop' }));
  insertEvent(db, ev({ sessionId: 'a', ts: 2000, type: 'Stop' }));
  insertEvent(db, ev({ sessionId: 'a', ts: 1000 }));
  assert.deepEqual(listEvents(db).map((e) => [e.sessionId, e.ts]), [['a', 1000], ['a', 2000], ['b', 3000]]);
  assert.deepEqual(listEvents(db, 2000).map((e) => [e.sessionId, e.ts]), [['a', 2000], ['b', 3000]]);
});

test('text is persisted and returned (null when absent)', () => {
  const db = openDb(':memory:');
  insertEvent(db, ev({ type: 'UserPromptSubmit', text: 'hello' }));
  insertEvent(db, ev({ ts: 2000, type: 'Stop' }));
  const [a, b] = listEvents(db);
  assert.equal(a.text, 'hello');
  assert.equal(b.text, null);
  assert.equal(a.cwd, '/p');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-'));

test('schema creation is idempotent and tables exist', () => {
  const file = path.join(tmp(), 'x.sqlite');
  openDb(file).close();
  const db = openDb(file);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('events') && names.includes('mappings'));
  assert.ok(EVENT_TYPES.includes('ManualClose') && Object.isFrozen(EVENT_TYPES));
});

test('openDb() defaults to <CLAUDE_CLOCKIFY_HOME>/data.sqlite', () => {
  const dir = tmp();
  const prev = process.env.CLAUDE_CLOCKIFY_HOME;
  process.env.CLAUDE_CLOCKIFY_HOME = dir;
  try {
    openDb().close();
    assert.ok(fs.existsSync(path.join(dir, 'data.sqlite')));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CLOCKIFY_HOME;
    else process.env.CLAUDE_CLOCKIFY_HOME = prev;
  }
});

test('two connections on the same file insert alternately without SQLITE_BUSY', () => {
  const file = path.join(tmp(), 'c.sqlite');
  const a = openDb(file);
  const b = openDb(file);
  for (let i = 0; i < 20; i++) {
    assert.equal(insertEvent(i % 2 ? a : b, ev({ ts: i })), true);
  }
  assert.equal(listEvents(a).length, 20);
  assert.equal(listEvents(b).length, 20);
});

test('data.sqlite and its WAL/SHM files are private (0o600)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dbperm-'));
  const prev = process.env.CLAUDE_CLOCKIFY_HOME;
  process.env.CLAUDE_CLOCKIFY_HOME = home;
  try {
    const db = openDb();
    insertEvent(db, { sessionId: 's', ts: 1, type: 'Stop', cwd: '/p' });
    for (const f of ['data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm']) {
      const file = path.join(home, f);
      if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600, f);
    }
    assert.ok(fs.existsSync(path.join(home, 'data.sqlite-wal')), 'WAL mode in use');
    db.close();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CLOCKIFY_HOME;
    else process.env.CLAUDE_CLOCKIFY_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('openDb migrates legacy Italian status values to English, idempotently', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  const file = path.join(home, 'data.sqlite');
  try {
    const legacy = { 'in corso': 'in_progress', proposta: 'proposed', modificata: 'edited', inviata: 'sent', sent: 'sent' };
    let db = openDb(file);
    const ins = db.prepare(`INSERT INTO entries (sessionId, startTs, cwd, endTs, computedMin, minutes, startAt, status)
      VALUES (?, 0, '/p', 0, 1, 1, 0, ?)`);
    for (const old of Object.keys(legacy)) ins.run(old, old);
    db.close();
    for (let i = 0; i < 2; i++) {
      db = openDb(file);
      const rows = db.prepare('SELECT sessionId, status FROM entries ORDER BY sessionId').all();
      assert.deepEqual(Object.fromEntries(rows.map((r) => [r.sessionId, r.status])), legacy);
      db.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
