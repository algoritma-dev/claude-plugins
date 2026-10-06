import fs from 'node:fs';
import path from 'node:path';

const TYPES = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);

async function logError(err) {
  try {
    const { dataDir } = await import('../core/config.js');
    const line = `${new Date().toISOString()} ${err?.stack ?? err}\n`;
    fs.appendFileSync(path.join(dataDir(), 'hook-errors.log'), line, { mode: 0o600 });
  } catch {
    // never throw
  }
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }
  if (!raw.trim()) return;
  const input = JSON.parse(raw);
  const type = input?.hook_event_name;
  if (!TYPES.has(type) || !input.session_id || !input.cwd) return;
  const text = type === 'UserPromptSubmit' && typeof input.prompt === 'string' ? input.prompt.slice(0, 200) : undefined;
  const { openDb, insertEvent } = await import('../core/db.js');
  const db = openDb();
  try {
    insertEvent(db, { sessionId: String(input.session_id), ts: Date.now(), type, cwd: String(input.cwd), text });
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (err) {
  await logError(err);
}
process.exit(0);
