import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBlocks } from '../core/blocks.js';

const MIN = 60000;
// Default type is Stop: it counts as work but never opens a turn, so threshold/margin rules apply plainly.
const ev = (min, type = 'Stop', over = {}) => ({
  sessionId: 's1', ts: min * MIN, type, cwd: '/p', ...over,
});
const opts = (over = {}) => ({ thresholdMin: 10, marginMin: 2, now: 1000 * MIN, ...over });

test('(a) events at 0, 5, 12 min with threshold 10 form one block of 14 min', () => {
  const blocks = computeBlocks([ev(0, 'SessionStart'), ev(5), ev(12)], opts());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startTs, 0);
  assert.equal(blocks[0].lastTs, 12 * MIN);
  assert.equal(blocks[0].durationMin, 14);
  assert.equal(blocks[0].cwd, '/p');
});

test('(b) gap of 30 min splits blocks; single-event block lasts the margin', () => {
  const blocks = computeBlocks([ev(0), ev(30)], opts());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].durationMin, 2);
  assert.equal(blocks[1].startTs, 30 * MIN);
});

test('gap exactly equal to the threshold starts a new block; unsorted input is sorted', () => {
  const blocks = computeBlocks([ev(10), ev(0)], opts());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].startTs, 0);
  assert.equal(blocks[0].durationMin, 2);
});

test('(c) SessionEnd then a later event opens a new block; the first is closed', () => {
  const blocks = computeBlocks([ev(0, 'SessionStart'), ev(2), ev(3, 'SessionEnd'), ev(5)], opts());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[0].durationMin, 5);
  assert.equal(blocks[1].startTs, 5 * MIN);
  assert.equal(blocks[1].durationMin, 2);
});

test('(d) closed when last event is at least threshold before now, open otherwise', () => {
  const old = computeBlocks([ev(0)], opts({ now: 11 * MIN }));
  assert.equal(old[0].closed, true);
  const recent = computeBlocks([ev(0)], opts({ now: 3 * MIN }));
  assert.equal(recent[0].closed, false);
});

test('(e) interleaved sessions produce separate blocks per sessionId', () => {
  const blocks = computeBlocks(
    [ev(0, 'SessionStart', { sessionId: 'a' }), ev(1, 'SessionStart', { sessionId: 'b', cwd: '/q' }),
      ev(4, 'Stop', { sessionId: 'a' }), ev(6, 'Stop', { sessionId: 'b', cwd: '/q' })],
    opts({ now: 7 * MIN }),
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.sessionId), ['a', 'b']);
  assert.equal(blocks[0].durationMin, 6);
  assert.equal(blocks[1].durationMin, 7);
  assert.equal(blocks[1].cwd, '/q');
});

test('(f) ManualClose closes the block like SessionEnd', () => {
  const blocks = computeBlocks([ev(0), ev(4, 'ManualClose'), ev(6)], opts({ now: 7 * MIN }));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[0].durationMin, 6);
  assert.equal(blocks[1].closed, false);
});

// ---------- turn model (C2) ----------

test('autonomous turn longer than the threshold is one block from prompt to Stop; lone SessionStart/SessionEnd dropped', () => {
  const blocks = computeBlocks(
    [ev(0, 'SessionStart'), ev(20, 'UserPromptSubmit'), ev(55, 'Stop'), ev(180, 'SessionEnd')],
    opts({ now: 200 * MIN }),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startTs, 20 * MIN);
  assert.equal(blocks[0].lastTs, 55 * MIN);
  assert.equal(blocks[0].durationMin, 37);
  assert.equal(blocks[0].closed, true);
});

test('open turn stays in_progress while now is far later but under the 4 h cap', () => {
  const blocks = computeBlocks([ev(0, 'UserPromptSubmit')], opts({ now: 3 * 60 * MIN }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closed, false);
  assert.equal(blocks[0].durationMin, 2);
});

test('open turn beyond the 4 h cap falls back to the normal threshold rule', () => {
  const capped = computeBlocks([ev(0, 'UserPromptSubmit')], opts({ now: 4 * 60 * MIN }));
  assert.equal(capped[0].closed, true);
  const split = computeBlocks([ev(0, 'UserPromptSubmit'), ev(5 * 60, 'Stop')], opts({ now: 6 * 60 * MIN }));
  assert.equal(split.length, 2);
  assert.equal(split[0].durationMin, 2);
  assert.equal(split[1].startTs, 5 * 60 * MIN);
});

test('closed blocks with only SessionStart / SessionEnd / ManualClose are dropped; open ones are kept', () => {
  assert.deepEqual(computeBlocks([ev(0, 'SessionStart'), ev(3, 'SessionEnd')], opts()), []);
  assert.deepEqual(computeBlocks([ev(0, 'SessionStart'), ev(1, 'ManualClose')], opts()), []);
  assert.deepEqual(computeBlocks([ev(0, 'SessionStart')], opts({ now: 11 * MIN })), []);
  const open = computeBlocks([ev(0, 'SessionStart')], opts({ now: 3 * MIN }));
  assert.equal(open.length, 1);
  assert.equal(open[0].closed, false);
});

test('SessionEnd after a gap closes the previous block without opening a new one', () => {
  const blocks = computeBlocks([ev(0), ev(2), ev(40, 'SessionEnd'), ev(41, 'ManualClose')], opts({ now: 42 * MIN }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lastTs, 2 * MIN);
  assert.equal(blocks[0].closed, true);
});

test('(e) imported transcript style (dense assistant lines) is split by the threshold as before', () => {
  const blocks = computeBlocks([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { text: 'a' }), ev(1), ev(3), ev(8),
    ev(30, 'UserPromptSubmit', { text: 'b' }), ev(31), ev(33),
  ], opts({ now: 60 * MIN }));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.startTs / MIN, b.lastTs / MIN, b.durationMin]), [[0, 8, 10], [30, 33, 5]]);
  assert.deepEqual(blocks.map((b) => b.texts), [['a'], ['b']]);
});

test('prompt texts of a block are collected once each, in order', () => {
  const [b] = computeBlocks([
    ev(0, 'UserPromptSubmit', { text: 'fix bug' }), ev(0.5, 'UserPromptSubmit', { text: 'fix bug' }),
    ev(1, 'UserPromptSubmit', { text: 'other' }), ev(2, 'UserPromptSubmit'), ev(3),
  ], opts());
  assert.deepEqual(b.texts, ['fix bug', 'other']);
});

test('frozen ranges: events inside are excluded and never merged across', () => {
  const frozen = new Map([['s1', [[5 * MIN, 8 * MIN]]]]);
  const blocks = computeBlocks([ev(0), ev(5), ev(8), ev(9), ev(12)], opts({ frozen }));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.startTs / MIN, b.lastTs / MIN]), [[0, 0], [9, 12]]);
  assert.equal(blocks[0].closed, true);
});
