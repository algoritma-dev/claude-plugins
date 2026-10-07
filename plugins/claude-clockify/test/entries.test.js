import test, { before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb, insertEvent, listEvents } from '../core/db.js';
import {
  reconcile,
  listEntries,
  updateEntry,
  closeNow,
  setMapping,
  getMapping,
  listMappings,
  markSent,
  dismissEntry,
} from '../core/entries.js';

const MIN = 60000;
const OPTS = { thresholdMin: 10, marginMin: 2 };
const T0 = new Date(2026, 9, 6, 9, 0).getTime();

let home;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entries-'));
  process.env.CLAUDE_CLOCKIFY_HOME = home;
});
after(() => {
  delete process.env.CLAUDE_CLOCKIFY_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function setup() {
  const db = openDb(':memory:');
  const add = (ts, type, over = {}) => insertEvent(db, { sessionId: 's1', ts, type, cwd: '/proj', ...over });
  return { db, add };
}

test('(a) open block -> in_progress; after threshold -> proposed with unchanged minutes', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 6 * MIN, OPTS);
  let [e] = listEntries(db);
  assert.equal(e.status, 'in_progress');
  assert.equal(e.minutes, 15);
  assert.equal(e.computedMin, 7);
  assert.equal(e.startAt, T0);
  assert.equal(e.endTs, T0 + 5 * MIN);
  reconcile(db, T0 + 16 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 1);
  e = all[0];
  assert.equal(e.status, 'proposed');
  assert.equal(e.minutes, 15);
});

test('(b) updateEntry on proposed -> edited; later reconcile keeps minutes; late events form a new entry', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 30 * MIN, OPTS);
  const key = { sessionId: 's1', startTs: T0 };
  const upd = updateEntry(db, key, { minutes: 30, description: 'work' });
  assert.equal(upd.status, 'edited');
  assert.equal(upd.minutes, 30);
  assert.equal(upd.description, 'work');
  add(T0 + 9 * MIN, 'Stop'); // late import after the edited range: a new entry, the edited one is frozen
  reconcile(db, T0 + 30 * MIN, { ...OPTS, full: true });
  const [e, extra] = listEntries(db);
  assert.equal(e.status, 'edited');
  assert.equal(e.minutes, 30);
  assert.equal(e.description, 'work');
  assert.equal(e.computedMin, 7);
  assert.equal(e.endTs, T0 + 5 * MIN);
  assert.equal(extra.startTs, T0 + 9 * MIN);
  assert.equal(extra.status, 'proposed');
  assert.equal(extra.computedMin, 2);
  // a margin change still refreshes the computed value of the frozen entry
  reconcile(db, T0 + 30 * MIN, { thresholdMin: 10, marginMin: 5, full: true });
  assert.equal(listEntries(db)[0].computedMin, 10);
  assert.equal(listEntries(db)[0].minutes, 30);
});

test('(c) updateEntry on in_progress throws', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  reconcile(db, T0 + MIN, OPTS);
  assert.throws(() => updateEntry(db, { sessionId: 's1', startTs: T0 }, { minutes: 5 }), /in progress/);
});

test('(d) event after SessionEnd -> second entry; first sent untouched', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 4 * MIN, 'Stop');
  add(T0 + 5 * MIN, 'SessionEnd');
  reconcile(db, T0 + 6 * MIN, OPTS);
  const sent = markSent(db, { sessionId: 's1', startTs: T0 }, 'ck-1');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.clockifyId, 'ck-1');
  add(T0 + 7 * MIN, 'UserPromptSubmit', { text: 'other' });
  reconcile(db, T0 + 8 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], sent);
  assert.equal(all[1].startTs, T0 + 7 * MIN);
  assert.equal(all[1].status, 'in_progress');
});

test('(e) closeNow brings entry to proposed', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 3 * MIN, 'Stop');
  reconcile(db, T0 + 4 * MIN, OPTS);
  assert.equal(listEntries(db)[0].status, 'in_progress');
  closeNow(db, 's1', T0 + 4 * MIN, OPTS);
  const [e] = listEntries(db);
  assert.equal(e.status, 'proposed');
  assert.equal(e.endTs, T0 + 4 * MIN);
  const last = listEvents(db).at(-1);
  assert.equal(last.type, 'ManualClose');
  assert.equal(last.cwd, '/proj');
});

test('closeNow uses ts > latest event when now is not after it, and throws for unknown session', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'x' });
  closeNow(db, 's1', T0, OPTS);
  assert.equal(listEvents(db).at(-1).ts, T0 + 1);
  assert.equal(listEntries(db)[0].status, 'proposed');
  assert.throws(() => closeNow(db, 'nope', T0, OPTS));
});

test('(f) saved mapping prefills new entry', () => {
  const { db, add } = setup();
  setMapping(db, '/proj', { projectId: 'p1', taskId: 't1', tagIds: ['a', 'b'] });
  assert.deepEqual(getMapping(db, '/proj'), { cwd: '/proj', projectId: 'p1', taskId: 't1', tagIds: ['a', 'b'] });
  assert.equal(getMapping(db, '/other'), null);
  add(T0, 'SessionStart');
  reconcile(db, T0 + MIN, OPTS);
  const [e] = listEntries(db);
  assert.equal(e.projectId, 'p1');
  assert.equal(e.taskId, 't1');
  assert.deepEqual(e.tagIds, ['a', 'b']);
  assert.equal(e.status, 'in_progress');
});

test('(g) entry starting 23:50 local has day of start', () => {
  const { db, add } = setup();
  const ts = new Date(2026, 9, 6, 23, 50).getTime();
  add(ts, 'SessionStart');
  add(ts + 9 * MIN, 'Stop');
  add(ts + 18 * MIN, 'Stop'); // 00:08 next day, same block
  reconcile(db, ts + 60 * MIN, OPTS);
  assert.equal(listEntries(db).length, 1);
  const [e] = listEntries(db);
  assert.equal(e.day, '2026-10-06');
  assert.equal(listEntries(db, { from: '2026-10-06', to: '2026-10-06' }).length, 1);
  assert.equal(listEntries(db, { from: '2026-10-07' }).length, 0);
});

test('(h) reconcile twice creates no duplicates', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 2 * MIN, 'Stop');
  reconcile(db, T0 + 3 * MIN, OPTS);
  const first = listEntries(db);
  reconcile(db, T0 + 3 * MIN, OPTS);
  assert.deepEqual(listEntries(db), first);
  assert.equal(first.length, 1);
});

test('description joins distinct prompt texts of the block with "; ", max 500 chars', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'one' });
  add(T0 + MIN, 'UserPromptSubmit', { text: 'two' });
  add(T0 + 2 * MIN, 'Stop');
  reconcile(db, T0 + 3 * MIN, OPTS);
  assert.equal(listEntries(db)[0].description, 'one; two');
  for (let i = 0; i < 5; i++) add(T0 + (3 + i) * MIN, 'UserPromptSubmit', { text: String(i).repeat(200) });
  reconcile(db, T0 + 9 * MIN, OPTS);
  assert.equal(listEntries(db)[0].description.length, 500);
});

test('earlier imported event re-keys unedited entry to new block start', () => {
  const { db, add } = setup();
  add(T0 + 5 * MIN, 'UserPromptSubmit', { text: 'b' });
  reconcile(db, T0 + 6 * MIN, OPTS);
  add(T0, 'UserPromptSubmit', { text: 'a' });
  reconcile(db, T0 + 6 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].startTs, T0);
  assert.equal(all[0].startAt, T0);
  assert.equal(all[0].description, 'a; b');
});

test('earlier imported event does not re-key an edited entry', () => {
  const { db, add } = setup();
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 30 * MIN, OPTS);
  updateEntry(db, { sessionId: 's1', startTs: T0 + 5 * MIN }, { minutes: 15 });
  add(T0, 'SessionStart');
  reconcile(db, T0 + 30 * MIN, { ...OPTS, full: true });
  const all = listEntries(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].startTs, T0 + 5 * MIN);
  assert.equal(all[0].status, 'edited');
  assert.equal(all[0].minutes, 15);
  assert.equal(all[0].computedMin, 2, 'frozen range: the earlier SessionStart is not merged in');
});

test('unedited entry matching no block is deleted (blocks merged by import)', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 15 * MIN, 'Stop');
  reconcile(db, T0 + 30 * MIN, OPTS);
  assert.equal(listEntries(db).length, 2);
  add(T0 + 8 * MIN, 'Stop'); // bridges the gap -> one block
  reconcile(db, T0 + 30 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].startTs, T0);
  assert.equal(all[0].computedMin, 17);
});

test('updateEntry: rejects unknown keys, sent stays sent, tagIds round-trip, filter by status', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 1, 'SessionEnd');
  reconcile(db, T0 + MIN, OPTS);
  const key = { sessionId: 's1', startTs: T0 };
  assert.throws(() => updateEntry(db, key, { status: 'sent' }), /status/);
  markSent(db, key, 'ck');
  const e = updateEntry(db, key, { tagIds: ['t'], startAt: T0 + MIN });
  assert.equal(e.status, 'sent');
  assert.deepEqual(e.tagIds, ['t']);
  assert.equal(e.startAt, T0 + MIN);
  assert.equal(listEntries(db, { status: 'sent' }).length, 1);
  assert.equal(listEntries(db, { status: 'proposed' }).length, 0);
});

test('proposed whose block reopens goes back to in_progress with updated minutes', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 16 * MIN, OPTS);
  assert.equal(listEntries(db)[0].status, 'proposed');
  add(T0 + 14 * MIN, 'Stop'); // within threshold of lastTs (T0+5)
  reconcile(db, T0 + 16 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'in_progress');
  assert.equal(all[0].minutes, 15);
  assert.equal(all[0].computedMin, 16);
});

test('markSent on in_progress throws', () => {
  const { db, add } = setup();
  add(T0, 'SessionStart');
  reconcile(db, T0 + MIN, OPTS);
  assert.throws(() => markSent(db, { sessionId: 's1', startTs: T0 }, 'ck'), /in progress/);
  assert.equal(listEntries(db)[0].status, 'in_progress');
});

test('reconcile without opts reads thresholds from config', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  reconcile(db, T0 + 11 * MIN);
  const [e] = listEntries(db);
  assert.equal(e.status, 'proposed');
  assert.equal(e.computedMin, 2);
});

test('listMappings returns all mappings ordered by cwd with parsed tagIds', () => {
  const { db } = setup();
  assert.deepEqual(listMappings(db), []);
  setMapping(db, '/b', { projectId: 'p2' });
  setMapping(db, '/a', { projectId: 'p1', taskId: 't1', tagIds: ['g1'] });
  assert.deepEqual(listMappings(db), [
    { cwd: '/a', projectId: 'p1', taskId: 't1', tagIds: ['g1'] },
    { cwd: '/b', projectId: 'p2', taskId: null, tagIds: [] },
  ]);
});

// ---------- I2: description dedupe ----------

test('identical prompt texts (hook + import) appear once in the description', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'fix bug' });
  add(T0 + 1000, 'UserPromptSubmit', { text: 'fix bug' });
  add(T0 + 2 * MIN, 'UserPromptSubmit', { text: 'other' });
  add(T0 + 3 * MIN, 'UserPromptSubmit', { text: 'fix bug' });
  add(T0 + 4 * MIN, 'Stop');
  reconcile(db, T0 + 30 * MIN, OPTS);
  assert.equal(listEntries(db)[0].description, 'fix bug; other');
});

// ---------- I1: threshold changes never touch time already edited/sent ----------

test('threshold 10 -> 5 after sending: sent entry is not re-split, no new entry for sent time', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'a' });
  add(T0 + 6 * MIN, 'Stop');
  add(T0 + 12 * MIN, 'Stop');
  reconcile(db, T0 + 60 * MIN, OPTS);
  const sent = markSent(db, { sessionId: 's1', startTs: T0 }, 'ck-1');
  assert.equal(sent.computedMin, 14);
  reconcile(db, T0 + 60 * MIN, { thresholdMin: 5, marginMin: 2, full: true });
  assert.deepEqual(listEntries(db), [sent]);
});

test('threshold 10 -> 15: an unsent proposed after a sent entry is neither merged nor deleted', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'a' });
  add(T0 + 5 * MIN, 'Stop');
  add(T0 + 17 * MIN, 'UserPromptSubmit', { text: 'b' });
  add(T0 + 20 * MIN, 'Stop');
  reconcile(db, T0 + 60 * MIN, OPTS);
  assert.equal(listEntries(db).length, 2);
  const sent = markSent(db, { sessionId: 's1', startTs: T0 }, 'ck-1');
  reconcile(db, T0 + 60 * MIN, { thresholdMin: 15, marginMin: 2, full: true });
  const all = listEntries(db);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], sent);
  assert.equal(all[1].startTs, T0 + 17 * MIN);
  assert.equal(all[1].status, 'proposed');
  assert.equal(all[1].computedMin, 5);
  assert.equal(all[1].description, 'b');
});

test('events on both sides of an edited entry are never merged across it', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 4 * MIN, 'Stop');
  reconcile(db, T0 + 60 * MIN, { thresholdMin: 3, marginMin: 2 });
  assert.equal(listEntries(db).length, 2);
  updateEntry(db, { sessionId: 's1', startTs: T0 + 4 * MIN }, { minutes: 10 });
  add(T0 + 2 * MIN, 'Stop'); // late: within threshold of T0 and of T0+4 (edited)
  add(T0 + 6 * MIN, 'Stop'); // late: after the edited range
  reconcile(db, T0 + 60 * MIN, { thresholdMin: 10, marginMin: 2, full: true });
  const all = listEntries(db);
  assert.deepEqual(all.map((e) => [e.startTs - T0, e.endTs - T0, e.status]), [
    [0, 2 * MIN, 'proposed'], [4 * MIN, 4 * MIN, 'edited'], [6 * MIN, 6 * MIN, 'proposed'],
  ]);
});

test('an unedited row overlapping an edited one is not deleted when its events are frozen', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 5 * MIN, 'Stop');
  add(T0 + 10 * MIN, 'Stop');
  reconcile(db, T0 + 60 * MIN, OPTS);
  updateEntry(db, { sessionId: 's1', startTs: T0 }, { minutes: 20 });
  // legacy inconsistent row (pre-freeze data): a proposed inside the edited range
  db.prepare(`INSERT INTO entries (sessionId, startTs, cwd, endTs, computedMin, minutes, startAt, status)
    VALUES ('s1', ?, '/proj', ?, 2, 2, ?, 'proposed')`).run(T0 + 5 * MIN, T0 + 5 * MIN, T0 + 5 * MIN);
  reconcile(db, T0 + 60 * MIN, { ...OPTS, full: true });
  assert.deepEqual(listEntries(db).map((e) => [e.startTs - T0, e.status]), [[0, 'edited'], [5 * MIN, 'proposed']]);
});

// ---------- C1: single pass, watermark ----------

function seed(db, sessions, perSession, base) {
  // perSession events per session, in blocks of 10 events 1 min apart separated by 30-min pauses
  db.exec('BEGIN');
  for (let s = 0; s < sessions; s++) {
    const sid = `sess-${String(s).padStart(4, '0')}`;
    const start = base + s * 7 * MIN;
    for (let i = 0; i < perSession; i++) {
      const ts = start + i * MIN + Math.floor(i / 10) * 30 * MIN;
      const type = i % 10 === 0 ? 'UserPromptSubmit' : 'Stop';
      insertEvent(db, { sessionId: sid, ts, type, cwd: `/p${s % 7}`, ...(type === 'UserPromptSubmit' && { text: `t${i % 3}` }) });
    }
  }
  db.exec('COMMIT');
}

test('watermark reconcile gives the same entries as a full reconcile', () => {
  const BASE = T0 - 3 * 24 * 60 * MIN;
  const make = () => {
    const db = openDb(':memory:');
    seed(db, 60, 40, BASE);
    return db;
  };
  const a = make();
  const b = make();
  const t1 = BASE + 6 * 60 * MIN; // some sessions still running
  reconcile(a, t1, { ...OPTS, full: true });
  reconcile(b, t1, { ...OPTS, full: true });
  for (const db of [a, b]) {
    const list = listEntries(db);
    updateEntry(db, list[3], { minutes: 99 });
    markSent(db, list[10], 'ck');
    const live = list.find((e) => e.status === 'in_progress');
    assert.ok(live, 'fixture has a running entry');
    // hook-like events (timestamps at "now") in a running session and in a brand new session
    insertEvent(db, { sessionId: live.sessionId, ts: t1 + MIN, type: 'Stop', cwd: live.cwd });
    insertEvent(db, { sessionId: 'new', ts: t1 + 2 * MIN, type: 'UserPromptSubmit', cwd: '/n', text: 'fresh' });
  }
  for (const now of [t1 + 3 * MIN, t1 + 40 * MIN, t1 + 300 * MIN]) {
    reconcile(a, now, OPTS);
    reconcile(b, now, { ...OPTS, full: true });
    assert.deepEqual(listEntries(a), listEntries(b), `at now=${now}`);
  }
});

test('reconcile is linear: 20k events / 400 sessions well under 1 s', () => {
  const BASE = T0 - 30 * 24 * 60 * MIN;
  const now = BASE + 400 * 7 * MIN + 24 * 60 * MIN;
  const run = (sessions) => {
    const db = openDb(':memory:');
    seed(db, sessions, 50, BASE);
    const t = performance.now();
    reconcile(db, now, { ...OPTS, full: true });
    const ms = performance.now() - t;
    const n = listEntries(db).length;
    db.close();
    return { ms, n };
  };
  run(40); // warm-up
  const small = Math.min(...[0, 1, 2].map(() => run(40).ms));
  let big = Infinity;
  for (let i = 0; i < 2; i++) {
    const r = run(400);
    assert.equal(r.n, 400 * 5);
    big = Math.min(big, r.ms);
  }
  assert.ok(big < 1000, `20k events took ${big.toFixed(0)} ms`);
  assert.ok(big / Math.max(small, 2) < 30, `2k: ${small.toFixed(1)} ms, 20k: ${big.toFixed(1)} ms`);
});

// ---------- I3: mapping created on first assignment and applied to existing entries ----------

test('first project assignment creates the mapping; later patches do not rewrite it', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 30 * MIN, 'Stop');
  add(T0 + 60 * MIN, 'Stop');
  reconcile(db, T0 + 90 * MIN, OPTS);
  const [e1, e2, e3] = listEntries(db);
  updateEntry(db, e1, { description: 'text only' });
  assert.equal(getMapping(db, '/proj'), null, 'no projectId in patch -> no mapping');
  updateEntry(db, e1, { projectId: null });
  assert.equal(getMapping(db, '/proj'), null, 'projectId null -> no mapping');
  updateEntry(db, e2, { projectId: 'p1', taskId: 't1', tagIds: ['g1'] });
  assert.deepEqual(getMapping(db, '/proj'), { cwd: '/proj', projectId: 'p1', taskId: 't1', tagIds: ['g1'] });
  // the mapping reaches the other unassigned, unedited entries of the folder (e3), not the edited one (e1)
  const after = listEntries(db);
  assert.equal(after[0].projectId, null);
  assert.equal(after[2].projectId, 'p1');
  assert.equal(after[2].status, 'proposed');
  updateEntry(db, e3, { projectId: 'p2' });
  assert.equal(getMapping(db, '/proj').projectId, 'p1', 'later patches do not rewrite the mapping');
});

test('setMapping fills existing in_progress/proposed entries without a project of that cwd only', () => {
  const { db, add } = setup();
  add(T0, 'Stop');
  add(T0 + 30 * MIN, 'Stop');
  add(T0 + 60 * MIN, 'Stop');
  add(T0, 'Stop', { sessionId: 's2', cwd: '/other' });
  add(T0 + 89 * MIN, 'Stop', { sessionId: 's3' });
  reconcile(db, T0 + 90 * MIN, OPTS);
  const [a, b] = listEntries(db).filter((e) => e.sessionId === 's1');
  updateEntry(db, a, { minutes: 5 }); // edited, no project
  markSent(db, b, 'ck');
  db.prepare("UPDATE entries SET projectId = 'pX' WHERE sessionId = 's1' AND startTs = ?").run(T0 + 60 * MIN);
  setMapping(db, '/proj', { projectId: 'p1', taskId: 't1', tagIds: ['g1'] });
  const byKey = Object.fromEntries(listEntries(db).map((e) => [`${e.sessionId}@${(e.startTs - T0) / MIN}`, e]));
  assert.equal(byKey['s1@0'].projectId, null, 'edited untouched');
  assert.equal(byKey['s1@30'].projectId, null, 'sent untouched');
  assert.equal(byKey['s1@60'].projectId, 'pX', 'already assigned untouched');
  assert.equal(byKey['s2@0'].projectId, null, 'other cwd untouched');
  assert.equal(byKey['s3@89'].status, 'in_progress');
  assert.equal(byKey['s3@89'].projectId, 'p1');
  assert.equal(byKey['s3@89'].taskId, 't1');
  assert.deepEqual(byKey['s3@89'].tagIds, ['g1']);
});

test('dismissEntry hides a proposed entry and reconcile never brings it back', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'x' });
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 16 * MIN, OPTS);
  const [e] = listEntries(db);
  dismissEntry(db, e);
  assert.deepEqual(listEntries(db), []);
  reconcile(db, T0 + 20 * MIN, OPTS);
  reconcile(db, T0 + 30 * MIN, { ...OPTS, full: true });
  assert.deepEqual(listEntries(db), []);
  assert.equal(listEntries(db, { status: 'dismissed' }).length, 1);
});

test('activity after a dismissed entry creates a new entry', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'x' });
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 16 * MIN, OPTS);
  dismissEntry(db, listEntries(db)[0]);
  add(T0 + 60 * MIN, 'UserPromptSubmit', { text: 'later' });
  add(T0 + 62 * MIN, 'Stop');
  reconcile(db, T0 + 80 * MIN, OPTS);
  const all = listEntries(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].startTs, T0 + 60 * MIN);
  assert.equal(all[0].status, 'proposed');
});

test('dismissEntry works on edited and sent entries (local only), throws for in_progress and unknown', () => {
  const { db, add } = setup();
  add(T0, 'UserPromptSubmit', { text: 'x' });
  add(T0 + 5 * MIN, 'Stop');
  reconcile(db, T0 + 6 * MIN, OPTS);
  assert.throws(() => dismissEntry(db, listEntries(db)[0]), /in progress/);
  reconcile(db, T0 + 16 * MIN, OPTS);
  const key = listEntries(db)[0];
  updateEntry(db, key, { minutes: 30 });
  markSent(db, key, 'c1');
  dismissEntry(db, key);
  assert.deepEqual(listEntries(db), []);
  const [gone] = listEntries(db, { status: 'dismissed' });
  assert.equal(gone.clockifyId, 'c1');
  assert.throws(() => dismissEntry(db, { sessionId: 'nope', startTs: 1 }), /not found/);
  assert.throws(() => updateEntry(db, key, { minutes: 5 }), /deleted/);
  assert.throws(() => markSent(db, key, 'c2'), /deleted/);
});
