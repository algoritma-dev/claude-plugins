import { loadConfig } from './config.js';
import { insertEvent } from './db.js';
import { computeBlocks } from './blocks.js';

/** @typedef {'in_progress'|'proposed'|'edited'|'sent'|'dismissed'} EntryStatus */
/**
 * @typedef {{sessionId: string, startTs: number, cwd: string, endTs: number, computedMin: number,
 *   minutes: number, startAt: number, projectId: string|null, taskId: string|null, tagIds: string[],
 *   description: string|null, status: EntryStatus, clockifyId: string|null, day: string}} Entry
 */

const UNEDITED = new Set(['in_progress', 'proposed']);
const PATCHABLE = new Set(['minutes', 'startAt', 'projectId', 'taskId', 'tagIds', 'description']);
const DESC_MAX = 500;

const pad = (n) => String(n).padStart(2, '0');
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function toEntry(row) {
  const { tagIds, ...rest } = row;
  return { ...rest, tagIds: tagIds ? JSON.parse(tagIds) : [], day: localDay(row.startTs) };
}

function getRow(db, { sessionId, startTs }) {
  return db.prepare('SELECT * FROM entries WHERE sessionId = ? AND startTs = ?').get(sessionId, startTs);
}

function getEntry(db, key) {
  const row = getRow(db, key);
  if (!row) throw new Error(`entry not found: ${key.sessionId}@${key.startTs}`);
  return toEntry(row);
}

const MIN_MS = 60000;

function describe(block) {
  const text = block.texts.join('; ');
  return text ? text.slice(0, DESC_MAX) : null;
}

const groupBySession = (list) => {
  const m = new Map();
  for (const x of list) {
    let arr = m.get(x.sessionId);
    if (!arr) m.set(x.sessionId, (arr = []));
    arr.push(x);
  }
  return m;
};

/**
 * Recomputes blocks and upserts entries.
 *
 * Rows that are `edited`/`sent` are frozen: the events inside their [startTs, endTs] are excluded from
 * the block computation, so they are never re-split or merged and no other block spans across them; only their
 * computedMin is refreshed (first..last event in range + margin).
 *
 * Modes: `full: true` recomputes every session (used after an import, a settings change and at server start).
 * Otherwise (periodic tick) only sessions with events at or after the watermark are recomputed:
 * W = min(startTs of entries `in_progress`, max endTs of all entries) - threshold. Hook events always carry the
 * current time, so they are always after W; back-dated events only come from an import, which runs full.
 *
 * Everything is computed outside the write transaction; BEGIN IMMEDIATE only wraps the writes (with status
 * guards, so concurrent edits are never overwritten).
 * @param {number} now ms
 * @param {{thresholdMin?: number, marginMin?: number, full?: boolean}} [opts] overrides config
 * @returns {{writes: number}}
 */
export function reconcile(db, now, opts = {}) {
  const cfg = loadConfig();
  const thresholdMin = opts.thresholdMin ?? cfg.thresholdMin;
  const marginMin = opts.marginMin ?? cfg.marginMin;
  const thresholdMs = thresholdMin * MIN_MS;

  let watermark = null;
  if (!opts.full) {
    const w = db.prepare(`SELECT (SELECT min(startTs) FROM entries WHERE status = 'in_progress') AS live,
      (SELECT max(endTs) FROM entries) AS lastEnd`).get();
    if (w.lastEnd !== null) watermark = Math.min(w.live ?? Infinity, w.lastEnd) - thresholdMs;
  }
  const touched = 'sessionId IN (SELECT DISTINCT sessionId FROM events WHERE ts >= ?)';
  const evSql = 'SELECT sessionId, ts, type, cwd, text FROM events';
  const rowSql = 'SELECT * FROM entries';
  const events = watermark === null
    ? db.prepare(`${evSql} ORDER BY sessionId, ts`).all()
    : db.prepare(`${evSql} WHERE ${touched} ORDER BY sessionId, ts`).all(watermark);
  const rows = watermark === null
    ? db.prepare(`${rowSql} ORDER BY sessionId, startTs`).all()
    : db.prepare(`${rowSql} WHERE ${touched} ORDER BY sessionId, startTs`).all(watermark);

  const rowsBySession = groupBySession(rows);
  const frozen = new Map();
  for (const [sid, list] of rowsBySession) {
    const ranges = list.filter((r) => !UNEDITED.has(r.status)).map((r) => [r.startTs, r.endTs]);
    if (ranges.length) frozen.set(sid, ranges.sort((a, b) => a[0] - b[0]));
  }
  const blocksBySession = groupBySession(computeBlocks(events, { thresholdMin, marginMin, now, frozen }));
  const eventsBySession = groupBySession(events);

  const ops = []; // [statement, args]
  const updFixed = db.prepare(`UPDATE entries SET computedMin = ? WHERE sessionId = ? AND startTs = ?
    AND status IN ('edited', 'sent')`);
  const updLive = db.prepare(`UPDATE entries SET startTs = ?, startAt = ?, computedMin = ?, minutes = ?, endTs = ?,
    description = ?, status = ? WHERE sessionId = ? AND startTs = ? AND status IN ('in_progress', 'proposed')`);
  const ins = db.prepare(`INSERT INTO entries (sessionId, startTs, cwd, endTs, computedMin, minutes, startAt,
    projectId, taskId, tagIds, description, status, clockifyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const del = db.prepare(
    "DELETE FROM entries WHERE sessionId = ? AND startTs = ? AND status IN ('in_progress', 'proposed')",
  );
  const mappings = new Map();
  const mappingOf = (cwd) => {
    if (!mappings.has(cwd)) mappings.set(cwd, getMapping(db, cwd));
    return mappings.get(cwd);
  };
  const overlaps = (r, a, b) => r.startTs <= b && a <= r.endTs;

  const sessions = new Set([...rowsBySession.keys(), ...blocksBySession.keys()]);
  for (const sid of sessions) {
    const sessionRows = rowsBySession.get(sid) ?? [];
    const live = sessionRows.filter((r) => UNEDITED.has(r.status));
    const fixed = sessionRows.filter((r) => !UNEDITED.has(r.status));
    const blocks = blocksBySession.get(sid) ?? [];

    // frozen rows: computedMin from the events inside their own range
    if (fixed.length) {
      const last = new Array(fixed.length).fill(null);
      let p = 0;
      for (const e of eventsBySession.get(sid) ?? []) {
        while (p < fixed.length && fixed[p].endTs < e.ts) p++;
        if (p === fixed.length) break;
        if (fixed[p].startTs <= e.ts) last[p] = e.ts;
      }
      fixed.forEach((r, k) => {
        if (last[k] === null) return;
        const computedMin = (last[k] - r.startTs) / MIN_MS + marginMin;
        if (computedMin !== r.computedMin) ops.push([updFixed, [computedMin, sid, r.startTs]]);
      });
    }

    // blocks and unedited rows are both sorted and non-overlapping: match with one cursor
    const matched = new Set();
    let j = 0;
    for (const b of blocks) {
      while (j < live.length && live[j].startTs < b.startTs) j++;
      const status = b.closed ? 'proposed' : 'in_progress';
      const description = describe(b);
      if (j < live.length && live[j].startTs <= b.lastTs) {
        const r = live[j++];
        matched.add(r);
        if (r.startTs !== b.startTs || r.startAt !== b.startTs || r.computedMin !== b.durationMin
          || r.minutes !== b.durationMin || r.endTs !== b.lastTs || r.description !== description || r.status !== status) {
          ops.push([updLive, [b.startTs, b.startTs, b.durationMin, b.durationMin, b.lastTs, description, status,
            sid, r.startTs]]);
        }
      } else {
        const m = mappingOf(b.cwd);
        ops.push([ins, [sid, b.startTs, b.cwd, b.lastTs, b.durationMin, b.durationMin, b.startTs,
          m?.projectId ?? null, m?.taskId ?? null, m ? JSON.stringify(m.tagIds) : null, description, status]]);
      }
    }
    for (const r of live) {
      if (matched.has(r)) continue;
      // a row whose events are all frozen inside an edited/sent entry is kept unless a block took them over
      const shadowed = fixed.some((f) => overlaps(r, f.startTs, f.endTs));
      if (shadowed && !blocks.some((b) => overlaps(r, b.startTs, b.lastTs))) continue;
      ops.push([del, [sid, r.startTs]]);
    }
  }

  if (ops.length === 0) return { writes: 0 };
  // deletes first, so a re-keyed or inserted row can never collide with a row about to disappear
  ops.sort((a, b) => (a[0] === del ? 0 : 1) - (b[0] === del ? 0 : 1));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [stmt, args] of ops) stmt.run(...args);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { writes: ops.length };
}

/**
 * Deleted (`dismissed`) entries are listed only with `status: 'dismissed'`.
 * @param {{from?: string, to?: string, status?: string}} [filter] from/to: 'YYYY-MM-DD' local, inclusive
 * @returns {Entry[]} ordered by startTs
 */
export function listEntries(db, filter = {}) {
  const where = [];
  const args = [];
  if (filter.from) { where.push('startTs >= ?'); args.push(dayStart(filter.from)); }
  if (filter.to) {
    const [y, m, d] = filter.to.split('-').map(Number);
    where.push('startTs < ?');
    args.push(new Date(y, m - 1, d + 1).getTime());
  }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); } else where.push("status != 'dismissed'");
  const sql = `SELECT * FROM entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY startTs, sessionId`;
  return db.prepare(sql).all(...args).map(toEntry);
}

/** @returns {Entry} */
export function updateEntry(db, key, patch) {
  for (const k of Object.keys(patch)) if (!PATCHABLE.has(k)) throw new Error(`field not editable: ${k}`);
  const cur = getEntry(db, key);
  if (cur.status === 'in_progress') throw new Error('cannot edit an entry that is in progress');
  if (cur.status === 'dismissed') throw new Error('cannot edit an entry that was deleted');
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(k === 'tagIds' ? JSON.stringify(v ?? []) : v);
  }
  sets.push('status = ?');
  args.push(cur.status === 'sent' ? 'sent' : 'edited');
  db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE sessionId = ? AND startTs = ?`)
    .run(...args, key.sessionId, key.startTs);
  const updated = getEntry(db, key);
  // spec "Mapping": created at the first assignment of a project to the folder, then reused
  if (typeof patch.projectId === 'string' && patch.projectId && !getMapping(db, updated.cwd)) {
    setMapping(db, updated.cwd, { projectId: updated.projectId, taskId: updated.taskId, tagIds: updated.tagIds });
  }
  return updated;
}

/**
 * Soft delete: the row stays as `dismissed`, so reconcile treats it like an edited/sent one (events frozen, never
 * recreated) and new activity after it becomes a new entry. Local only: nothing is removed from Clockify.
 */
export function dismissEntry(db, key) {
  const { status } = getEntry(db, key);
  if (status === 'in_progress') throw new Error('cannot delete an entry that is in progress; close it first');
  db.prepare("UPDATE entries SET status = 'dismissed' WHERE sessionId = ? AND startTs = ?")
    .run(key.sessionId, key.startTs);
}

/** Inserts a ManualClose event for the session and reconciles. */
export function closeNow(db, sessionId, now, opts) {
  const last = db.prepare('SELECT ts, cwd FROM events WHERE sessionId = ? ORDER BY ts DESC LIMIT 1').get(sessionId);
  if (!last) throw new Error(`no events for session ${sessionId}`);
  insertEvent(db, { sessionId, ts: Math.max(now, last.ts + 1), type: 'ManualClose', cwd: last.cwd });
  reconcile(db, now, opts);
}

/** @returns {Entry} */
export function markSent(db, key, clockifyId) {
  const { status } = getEntry(db, key);
  if (status === 'in_progress') throw new Error('cannot send an entry that is in progress');
  if (status === 'dismissed') throw new Error('cannot send an entry that was deleted');
  db.prepare("UPDATE entries SET status = 'sent', clockifyId = ? WHERE sessionId = ? AND startTs = ?")
    .run(clockifyId, key.sessionId, key.startTs);
  return getEntry(db, key);
}

/**
 * Persists a send that Clockify already accepted: clockifyId + 'sent', whatever the current status (no status
 * guard, the entry exists on Clockify now). If the key moved meanwhile (re-keyed by a reconcile), the unsent row of
 * the session whose range contains the original start is updated instead.
 * @returns {boolean} false if no row could be found
 */
export function recordSent(db, key, clockifyId) {
  const byKey = db.prepare("UPDATE entries SET status = 'sent', clockifyId = ? WHERE sessionId = ? AND startTs = ?")
    .run(clockifyId, key.sessionId, key.startTs);
  if (byKey.changes > 0) return true;
  const byRange = db.prepare(`UPDATE entries SET status = 'sent', clockifyId = ? WHERE rowid = (
    SELECT rowid FROM entries WHERE sessionId = ? AND clockifyId IS NULL AND startTs <= ? AND endTs >= ?
    ORDER BY startTs DESC LIMIT 1)`).run(clockifyId, key.sessionId, key.startTs, key.startTs);
  return byRange.changes > 0;
}

/**
 * Saves the folder mapping and applies it to the folder's existing unedited entries that have no project yet.
 * @param {{projectId: string, taskId?: string|null, tagIds?: string[]}} m
 */
export function setMapping(db, cwd, { projectId, taskId = null, tagIds = [] }) {
  const tags = JSON.stringify(tagIds);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO mappings (cwd, projectId, taskId, tagIds) VALUES (?, ?, ?, ?)
      ON CONFLICT(cwd) DO UPDATE SET projectId = excluded.projectId, taskId = excluded.taskId, tagIds = excluded.tagIds`)
      .run(cwd, projectId, taskId, tags);
    db.prepare(`UPDATE entries SET projectId = ?, taskId = ?, tagIds = ?
      WHERE cwd = ? AND status IN ('in_progress', 'proposed') AND projectId IS NULL`)
      .run(projectId, taskId, tags, cwd);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** @returns {{cwd: string, projectId: string|null, taskId: string|null, tagIds: string[]}|null} */
export function getMapping(db, cwd) {
  const row = db.prepare('SELECT cwd, projectId, taskId, tagIds FROM mappings WHERE cwd = ?').get(cwd);
  if (!row) return null;
  return { ...row, tagIds: row.tagIds ? JSON.parse(row.tagIds) : [] };
}

/** @returns {Array<{cwd: string, projectId: string|null, taskId: string|null, tagIds: string[]}>} ordered by cwd */
export function listMappings(db) {
  return db.prepare('SELECT cwd, projectId, taskId, tagIds FROM mappings ORDER BY cwd').all()
    .map((row) => ({ ...row, tagIds: row.tagIds ? JSON.parse(row.tagIds) : [] }));
}
