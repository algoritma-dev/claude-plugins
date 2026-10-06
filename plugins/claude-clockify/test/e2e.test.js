import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, insertEvent } from '../core/db.js';
import { listEntries, setMapping } from '../core/entries.js';
import { saveConfig } from '../core/config.js';
import { startServer } from '../server/server.js';
import { startFakeClockify } from './helpers/fake-clockify.js';

const MIN = 60000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CWD = '/home/dev/projects/alpha';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
}

test('e2e: hook -> proposed -> edited -> sent -> new in_progress entry', async (t) => {
  const home = tmpHome();
  process.env.CLAUDE_CLOCKIFY_HOME = home;
  const fake = await startFakeClockify();
  t.after(async () => {
    await fake.close();
    delete process.env.CLAUDE_CLOCKIFY_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });
  saveConfig({ baseUrl: fake.url, clockifyToken: 'e2e-token', workspaceId: 'ws1', thresholdMin: 10, marginMin: 2 });

  // (1) One real hook spawn proves hook -> DB; the remaining events are injected with controlled timestamps.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'record.js')], {
    input: JSON.stringify({ session_id: 'sess-1', cwd: CWD, hook_event_name: 'SessionStart' }),
    env: { ...process.env, CLAUDE_CLOCKIFY_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const db = openDb();
  t.after(() => db.close());
  const first = db.prepare("SELECT ts FROM events WHERE sessionId = 'sess-1' AND type = 'SessionStart'").get();
  assert.ok(first, 'hook recorded SessionStart');
  const T0 = first.ts;
  insertEvent(db, { sessionId: 'sess-1', ts: T0 + 1 * MIN, type: 'UserPromptSubmit', cwd: CWD, text: 'Implement the login' });
  insertEvent(db, { sessionId: 'sess-1', ts: T0 + 5 * MIN, type: 'Stop', cwd: CWD });
  setMapping(db, CWD, { projectId: 'p1', tagIds: ['g1'] });

  let now = T0 + 6 * MIN;
  const srv = await startServer({ port: 0, db, now: () => now, reconcileIntervalMs: 20, clockifyTimeoutMs: 2000 });
  t.after(() => srv.close());

  const page = await fetch(`${srv.url}/`);
  assert.equal(page.status, 200);
  const token = /name="session-token" content="([0-9a-f]+)"/.exec(await page.text())?.[1];
  assert.equal(token, srv.sessionToken);
  const api = async (method, url, body) => {
    const res = await fetch(`${srv.url}${url}`, {
      method,
      headers: { 'X-Session-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  // the server reconciles on a short timer; wait until the predicate holds
  const settle = async (fetchList, ok) => {
    for (let i = 0; i < 100; i += 1) {
      const { json } = await fetchList();
      if (ok(json)) return json;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('entries did not settle');
  };

  // still within the threshold: running
  let { json: list } = await api('GET', '/api/entries');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'in_progress');

  // (2) time moves past the threshold -> proposed
  now = T0 + 30 * MIN;
  list = await settle(() => api('GET', '/api/entries'), (l) => l[0]?.status === 'proposed');
  assert.equal(list.length, 1);
  const e1 = list[0];
  assert.equal(e1.status, 'proposed');
  assert.equal(e1.computedMin, 7);
  assert.equal(e1.projectId, 'p1');
  assert.equal(e1.description, 'Implement the login');

  // (3) edit task, minutes, project -> edited
  const key = `/api/entries/${encodeURIComponent(e1.sessionId)}/${e1.startTs}`;
  const patched = await api('PATCH', key, { taskId: 't1', minutes: 90, projectId: 'p1' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, 'edited');
  assert.equal(patched.json.minutes, 90);

  // (4) send -> exactly one POST to Clockify with the right payload
  const sent = await api('POST', '/api/entries/send', { keys: [{ sessionId: e1.sessionId, startTs: e1.startTs }] });
  assert.equal(sent.json.results[0].ok, true);
  const posts = fake.requests.filter((q) => q.method === 'POST');
  assert.equal(posts.length, 1);
  const body = posts[0].body;
  assert.equal(body.projectId, 'p1');
  assert.equal(body.taskId, 't1');
  assert.deepEqual(body.tagIds, ['g1']);
  assert.equal(new Date(body.end).getTime() - new Date(body.start).getTime(), 90 * MIN);
  assert.equal(new Date(body.start).getTime(), e1.startTs);
  assert.match(body.start, /Z$/);
  assert.match(body.end, /Z$/);
  const sentEntry = listEntries(db).find((e) => e.startTs === e1.startTs);
  assert.equal(sentEntry.status, 'sent');
  assert.ok(sentEntry.clockifyId);

  // (5) new activity after a gap in the same session -> NEW entry in_progress; sent entry untouched
  insertEvent(db, { sessionId: 'sess-1', ts: T0 + 60 * MIN, type: 'UserPromptSubmit', cwd: CWD, text: 'Add the tests' });
  now = T0 + 61 * MIN;
  await settle(() => api('GET', '/api/entries'), (l) => l.length === 2);
  const all = listEntries(db);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((e) => e.startTs === e1.startTs), sentEntry);
  const live = all.find((e) => e.startTs !== e1.startTs);
  assert.equal(live.status, 'in_progress');
  assert.equal(live.sessionId, 'sess-1');
  assert.equal(live.clockifyId, null);

  // (6) sending the in-corso entry is rejected and Clockify sees nothing more
  const rejected = await api('POST', '/api/entries/send', { keys: [{ sessionId: live.sessionId, startTs: live.startTs }] });
  assert.equal(rejected.json.results[0].ok, false);
  assert.equal(rejected.json.results[0].error.kind, 'state');
  assert.equal(fake.requests.filter((q) => q.method === 'POST').length, 1);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('main.js: starts, prints Dashboard URL, serves the page, exits on SIGTERM', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'main.js'), '--no-open'], {
    env: { ...process.env, CLAUDE_CLOCKIFY_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no Dashboard line, output: ${out}`)), 10000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /Dashboard: (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', () => reject(new Error(`exited early, output: ${out}`)));
  });
  assert.equal(url, `http://127.0.0.1:${port}`);
  assert.equal((await fetch(`${url}/`)).status, 200);

  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.ok(code === 0 || signal === 'SIGTERM', `unexpected exit code=${code} signal=${signal}`);
});

function runMain(home, args = ['--no-open'], extraNodeArgs = []) {
  const child = spawn(process.execPath, [...extraNodeArgs, path.join(ROOT, 'server', 'main.js'), ...args], {
    env: { ...process.env, CLAUDE_CLOCKIFY_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const killer = setTimeout(() => child.kill('SIGKILL'), 15000); // never hang the suite
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    clearTimeout(killer);
    resolve({ code, signal, out, err });
  }));
  return { child, exited, output: () => out };
}

test('main.js: a second instance on the same port finds the running dashboard and exits 0', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }));
  const first = runMain(home);
  t.after(() => first.child.kill('SIGKILL'));
  const deadline = Date.now() + 10000;
  while (!/Dashboard: /.test(first.output())) {
    assert.ok(Date.now() < deadline, 'first instance did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  const second = await runMain(home).exited;
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, new RegExp(`Dashboard already running: http://127\\.0\\.0\\.1:${port}`));
  first.child.kill('SIGTERM');
  await first.exited;
});

test('main.js: port taken by something else -> clear error, exit 1', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const other = http.createServer((req, res) => res.end('hello'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    other.close(r);
    other.closeAllConnections();
  }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: other.address().port }));
  const r = await runMain(home).exited;
  assert.equal(r.code, 1);
  assert.match(r.err, /port \d+ is already in use by another program/);
});

test('main.js: Node older than 22.13 -> clear message, exit 1', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: await freePort() }));
  const fake = "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'22.12.0'})";
  const r = await runMain(home, ['--no-open'], ['--import', fake]).exited;
  assert.equal(r.code, 1);
  assert.match(r.err, /Node\.js 22\.13 or later is required/);
  assert.equal(r.out, '');
});

test('dev-server helper does nothing when imported (runs only as the main module)', async () => {
  const env = { ...process.env, PORT: '0' };
  delete env.NODE_TEST_CONTEXT;
  const helper = pathToFileURL(path.join(ROOT, 'test', 'helpers', 'dev-server.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(helper)});`], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const killer = setTimeout(() => child.kill('SIGTERM'), 5000);
  const code = await new Promise((resolve) => child.once('exit', (c) => resolve(c)));
  clearTimeout(killer);
  assert.equal(code, 0);
  assert.equal(out, '');
});
