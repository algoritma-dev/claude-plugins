const MIN_MS = 60000;
/** A turn (UserPromptSubmit without its Stop yet) keeps the block open for at most this long after the prompt. */
export const TURN_CAP_MS = 4 * 60 * MIN_MS;
const CLOSING = new Set(['SessionEnd', 'ManualClose']);
const WORK = new Set(['UserPromptSubmit', 'Stop']);

const bySessionThenTs = (a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.ts - b.ts);

/**
 * Pure: groups events into activity blocks per session.
 *
 * Rules (see spec "Activity blocks"):
 * - consecutive events closer than the threshold stay in the same block;
 * - between a UserPromptSubmit and the next Stop of the session (turn in progress) the block is never split and
 *   stays open, for at most TURN_CAP_MS after the prompt; then the threshold rule applies again;
 * - SessionEnd/ManualClose close the block; after a gap they only close the previous block, never open one;
 * - a closed block without any UserPromptSubmit or Stop (SessionStart/SessionEnd/ManualClose only) is dropped;
 * - events inside a frozen range (an edited/sent entry) are skipped and no block spans across that range.
 *
 * @param {Array<{sessionId:string, ts:number, type:string, cwd:string, text?:string|null}>} events
 * @param {{thresholdMin:number, marginMin:number, now:number,
 *   frozen?: Map<string, Array<[number, number]>>}} opts frozen: per session, sorted [startTs, endTs] ranges
 * @returns {Array<{sessionId:string, cwd:string, startTs:number, lastTs:number, durationMin:number,
 *   closed:boolean, texts:string[]}>} texts: distinct prompt texts in order
 */
export function computeBlocks(events, { thresholdMin, marginMin, now, frozen }) {
  const thresholdMs = thresholdMin * MIN_MS;
  const sorted = [...events].sort(bySessionThenTs);
  const blocks = [];

  function finish(block, closed) {
    if (closed && !block.work) return;
    blocks.push({
      sessionId: block.sessionId,
      cwd: block.cwd,
      startTs: block.startTs,
      lastTs: block.last.ts,
      durationMin: (block.last.ts - block.startTs) / MIN_MS + marginMin,
      closed,
      texts: block.texts,
    });
  }

  let i = 0;
  while (i < sorted.length) {
    const sessionId = sorted[i].sessionId;
    const ranges = frozen?.get(sessionId) ?? [];
    let ri = 0;
    let cur = null;
    let turnStart = null;
    for (; i < sorted.length && sorted[i].sessionId === sessionId; i++) {
      const e = sorted[i];
      while (ri < ranges.length && ranges[ri][1] < e.ts) ri++;
      if (ri < ranges.length && ranges[ri][0] <= e.ts) continue; // belongs to an edited/sent entry
      const closing = CLOSING.has(e.type);
      if (cur) {
        const turnOpen = turnStart !== null && e.ts - turnStart < TURN_CAP_MS;
        if (cur.seg !== ri || CLOSING.has(cur.last.type) || (!turnOpen && e.ts - cur.last.ts >= thresholdMs)) {
          finish(cur, true);
          cur = null;
          turnStart = null;
        }
      }
      if (!cur) {
        if (closing) continue; // a close never opens a block
        cur = { sessionId, cwd: e.cwd, startTs: e.ts, seg: ri, work: false, texts: [], seen: new Set() };
      }
      cur.last = e;
      if (WORK.has(e.type)) cur.work = true;
      if (e.type === 'UserPromptSubmit') {
        turnStart = e.ts;
        if (e.text && !cur.seen.has(e.text)) {
          cur.seen.add(e.text);
          cur.texts.push(e.text);
        }
      } else if (e.type === 'Stop' || closing) {
        turnStart = null;
      }
    }
    if (cur) {
      const turnOpen = turnStart !== null && now - turnStart < TURN_CAP_MS;
      finish(cur, CLOSING.has(cur.last.type) || (!turnOpen && now - cur.last.ts >= thresholdMs));
    }
  }

  return blocks.sort((a, b) => a.startTs - b.startTs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}
