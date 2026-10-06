// Developer helper: runs the real server with seeded data and a fake Clockify, to exercise the UI by hand.
//   node test/helpers/dev-server.js        (PORT=5000 node test/helpers/dev-server.js to change port)
// Everything lives in a temporary CLAUDE_CLOCKIFY_HOME that is removed on Ctrl-C.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeClockify } from './fake-clockify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const MIN = 60000;

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dev-'));
  process.env.CLAUDE_CLOCKIFY_HOME = home;

  // Imported after setting the env so every module uses the temp home.
  const { saveConfig } = await import('../../core/config.js');
  const { openDb, insertEvent } = await import('../../core/db.js');
  const { setMapping } = await import('../../core/entries.js');
  const { startServer } = await import('../../server/server.js');

  const fake = await startFakeClockify();
  saveConfig({ baseUrl: fake.url, clockifyToken: 'dev-token', workspaceId: null, thresholdMin: 60, marginMin: 2 });

  const now = Date.now();
  const d = new Date(now);
  const yesterdayAt = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime();
  const ALPHA = '/home/dev/projects/alpha';
  const BETA = '/home/dev/projects/beta';

  const db = openDb();
  setMapping(db, ALPHA, { projectId: 'p1', taskId: 't1', tagIds: ['g1'] });
  const ev = (sessionId, ts, type, cwd, text) => insertEvent(db, { sessionId, ts, type, cwd, text });
  // yesterday: two closed blocks in two cwd's (gaps stay below the 60 min threshold)
  ev('dev-y1', yesterdayAt(9, 0), 'SessionStart', ALPHA);
  ev('dev-y1', yesterdayAt(9, 1), 'UserPromptSubmit', ALPHA, 'Implement the login with <b>OAuth</b> & "redirect"');
  ev('dev-y1', yesterdayAt(9, 40), 'Stop', ALPHA);
  ev('dev-y1', yesterdayAt(10, 5), 'UserPromptSubmit', ALPHA, 'Add the tests');
  ev('dev-y1', yesterdayAt(10, 30), 'Stop', ALPHA);
  ev('dev-y2', yesterdayAt(14, 0), 'SessionStart', BETA);
  ev('dev-y2', yesterdayAt(14, 2), 'UserPromptSubmit', BETA, 'Fix the parser tests');
  ev('dev-y2', yesterdayAt(14, 40), 'Stop', BETA);
  ev('dev-y2', yesterdayAt(15, 10), 'SessionEnd', BETA);
  // today: one block closed by SessionEnd, one still running (in_progress)
  ev('dev-t1', now - 200 * MIN, 'SessionStart', BETA);
  ev('dev-t1', now - 199 * MIN, 'UserPromptSubmit', BETA, 'Review the documentation');
  ev('dev-t1', now - 160 * MIN, 'SessionEnd', BETA);
  ev('dev-live', now - 25 * MIN, 'SessionStart', ALPHA);
  ev('dev-live', now - 24 * MIN, 'UserPromptSubmit', ALPHA, 'Add the dashboard');
  ev('dev-live', now - 2 * MIN, 'Stop', ALPHA);
  db.close();

  // Export tab: a tiny template plus a saved profile, so the tab is "ready" out of the box.
  const { makeTemplate } = await import('./make-template.js');
  const { main: exportCli } = await import('../../export/cli.js');
  fs.writeFileSync(path.join(home, 'template.xlsx'), makeTemplate());
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({
    sheet: 'Hours',
    startRow: 4,
    columns: [{ col: 'A', field: 'date' }, { col: 'B', field: 'project' }, { col: 'C', field: 'hours' }],
    removeSheets: ['Rules'],
  }));
  await exportCli(['save-profile', path.join(home, 'profile.json'), '--template', path.join(home, 'template.xlsx')], { log() {}, err: console.error });

  const port = process.env.PORT ? Number(process.env.PORT) : 4747;
  const srv = await startServer({
    port,
    reconcileIntervalMs: 3000,
    projectsDir: path.join(PKG, 'test', 'fixtures', 'projects'),
  });

  console.log(`Claude Clockify dev server: ${srv.url}/`);
  console.log(`Fake Clockify: ${fake.url} (requests are logged below)`);
  console.log(`Temp home: ${home}`);
  console.log('Ctrl-C to stop.');

  const seen = { n: 0 };
  const logTimer = setInterval(() => {
    while (seen.n < fake.requests.length) {
      const r = fake.requests[seen.n++];
      console.log(`[fake clockify] ${r.method} ${r.path}${r.query}${r.body ? ` ${JSON.stringify(r.body)}` : ''}`);
    }
  }, 500);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(logTimer);
    await srv.close();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
    console.log('Dev server stopped, temp home removed.');
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Runs only when executed directly (`node test/helpers/dev-server.js`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
