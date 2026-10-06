import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb, insertEvent } from '../core/db.js';
import { listEntries, setMapping, reconcile } from '../core/entries.js';
import { saveConfig, loadConfig } from '../core/config.js';
import { startServer } from '../server/server.js';
import { checkRequest } from '../server/security.js';
import { startFakeClockify } from './helpers/fake-clockify.js';

const MIN = 60000;
const T0 = new Date(2026, 9, 6, 9, 0).getTime();
const NOW = T0 + 120 * MIN;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');

let home;
let fake;
let uiDir;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-'));
  process.env.CLAUDE_CLOCKIFY_HOME = home;
  fake = await startFakeClockify();
  uiDir = path.join(home, 'ui');
  fs.mkdirSync(uiDir);
  fs.writeFileSync(
    path.join(uiDir, 'index.html'),
    '<html><head><meta name="session-token" content="{{SESSION_TOKEN}}"></head></html>',
  );
  fs.writeFileSync(path.join(uiDir, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(home, 'secret.txt'), 'TOP-SECRET');
});

after(async () => {
  await fake.close();
  delete process.env.CLAUDE_CLOCKIFY_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(home, 'config.json'), { force: true });
  saveConfig({ baseUrl: fake.url, clockifyToken: 'test-token', workspaceId: 'ws1', thresholdMin: 10, marginMin: 2 });
  fake.requests.length = 0;
});

const K = {
  s1: { sessionId: 's1', startTs: T0 }, // proposed, mapped
  s2: { sessionId: 's2', startTs: T0 + 30 * MIN }, // proposed, mapped
  s3: { sessionId: 's3', startTs: NOW - 2 * MIN }, // in_progress
  s4: { sessionId: 's4', startTs: T0 + 40 * MIN }, // proposed, no project
};

async function setup(t, extra = {}) {
  const db = openDb(':memory:');
  setMapping(db, '/proj', { projectId: 'p1', tagIds: ['g1'] });
  const add = (sessionId, ts, type, cwd = '/proj') => insertEvent(db, { sessionId, ts, type, cwd });
  add('s1', T0, 'SessionStart');
  add('s1', T0 + 5 * MIN, 'Stop');
  add('s2', T0 + 30 * MIN, 'SessionStart');
  add('s2', T0 + 35 * MIN, 'Stop');
  add('s3', NOW - 2 * MIN, 'SessionStart');
  add('s3', NOW - 1 * MIN, 'Stop');
  add('s4', T0 + 40 * MIN, 'SessionStart', '/other');
  add('s4', T0 + 43 * MIN, 'Stop', '/other');
  let now = NOW;
  const srv = await startServer({
    port: 0,
    db,
    now: () => now,
    uiDir,
    reconcileIntervalMs: 60000,
    clockifyTimeoutMs: 1000,
    projectsDir: FIXTURES,
    ...extra,
  });
  t.after(() => srv.close());
  return { db, srv, add, setNow: (v) => { now = v; } };
}

function request(srv, method, p, { body, raw, headers = {}, token = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = {};
    if (data !== undefined) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    if (token && method !== 'GET') h['x-session-token'] = srv.sessionToken;
    Object.assign(h, headers);
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: h, agent: false }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(s); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: s, json });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

function openSse(srv) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/events', agent: false }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      const events = [];
      let waiter = null;
      const check = () => {
        if (waiter && events.length >= waiter.n) {
          clearTimeout(waiter.timer);
          const w = waiter;
          waiter = null;
          w.resolve(events[w.n - 1]);
        }
      };
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.event) events.push(ev);
        }
        check();
      });
      res.on('error', () => {});
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitFor(n, ms = 2000) {
          return new Promise((res2, rej2) => {
            waiter = { n, resolve: res2, timer: setTimeout(() => { waiter = null; rej2(new Error(`timeout waiting for event #${n}`)); }, ms) };
            check();
          });
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

const entryOf = (db, key) => listEntries(db).find((e) => e.sessionId === key.sessionId && e.startTs === key.startTs);
const posts = () => fake.requests.filter((r) => r.method === 'POST' && /time-entries$/.test(r.path));

// ---------- security unit ----------

test('checkRequest: host, origin and session token rules', () => {
  const tok = 'a'.repeat(32);
  const mk = (method, headers) => ({ method, headers, socket: { localPort: 5000 } });
  assert.equal(checkRequest(mk('GET', { host: '127.0.0.1:5000' }), tok, 5000).ok, true);
  assert.equal(checkRequest(mk('GET', { host: 'localhost:5000' }), tok, 5000).ok, true);
  assert.equal(checkRequest(mk('GET', { host: 'localhost:5000' }), tok).ok, true, 'port from socket');
  assert.equal(checkRequest(mk('GET', { host: 'evil.example' }), tok, 5000).status, 403);
  assert.equal(checkRequest(mk('GET', { host: '127.0.0.1:5001' }), tok, 5000).status, 403);
  assert.equal(checkRequest(mk('GET', {}), tok, 5000).status, 403);
  assert.equal(checkRequest(mk('GET', { host: '127.0.0.1:5000', origin: 'https://evil.example' }), tok, 5000).status, 403);
  assert.equal(checkRequest(mk('GET', { host: '127.0.0.1:5000', origin: 'null' }), tok, 5000).status, 403);
  assert.equal(checkRequest(mk('GET', { host: '127.0.0.1:5000', origin: 'http://localhost:5000' }), tok, 5000).ok, true);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(checkRequest(mk(m, { host: '127.0.0.1:5000' }), tok, 5000).status, 403, m);
    assert.equal(checkRequest(mk(m, { host: '127.0.0.1:5000', 'x-session-token': 'b'.repeat(32) }), tok, 5000).status, 403);
    assert.equal(checkRequest(mk(m, { host: '127.0.0.1:5000', 'x-session-token': 'short' }), tok, 5000).status, 403);
    assert.equal(checkRequest(mk(m, { host: '127.0.0.1:5000', 'x-session-token': tok }), tok, 5000).ok, true);
  }
});

// ---------- security over HTTP ----------

test('request with Origin https://evil.example -> 403', async (t) => {
  const { srv } = await setup(t);
  const r = await request(srv, 'GET', '/api/entries', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.kind, 'forbidden');
  const p = await request(srv, 'POST', '/api/import', { headers: { origin: 'https://evil.example' } });
  assert.equal(p.status, 403);
});

test('foreign Host header (DNS rebinding) -> 403', async (t) => {
  const { srv } = await setup(t);
  const r = await request(srv, 'GET', '/', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 403);
  assert.ok(!r.text.includes(srv.sessionToken));
});

test('POST without or with wrong X-Session-Token -> 403, nothing sent', async (t) => {
  const { srv, db } = await setup(t);
  const r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] }, token: false });
  assert.equal(r.status, 403);
  const w = await request(srv, 'POST', '/api/entries/send', {
    body: { keys: [K.s1] }, token: false, headers: { 'x-session-token': 'nope' },
  });
  assert.equal(w.status, 403);
  assert.equal(fake.requests.length, 0);
  assert.equal(entryOf(db, K.s1).status, 'proposed');
});

// ---------- settings ----------

test('GET /api/settings never contains the saved token, also after PUT', async (t) => {
  const { srv } = await setup(t);
  let r = await request(srv, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.equal(r.json.tokenSet, true);
  assert.equal('clockifyToken' in r.json, false);
  assert.ok(!r.text.includes('test-token'));
  assert.equal(r.json.thresholdMin, 10);

  r = await request(srv, 'PUT', '/api/settings', { body: { clockifyToken: 'new-secret-xyz', thresholdMin: 15 } });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('new-secret-xyz'));
  assert.equal(r.json.tokenSet, true);
  assert.equal(r.json.thresholdMin, 15);
  assert.equal(loadConfig().clockifyToken, 'new-secret-xyz');

  r = await request(srv, 'GET', '/api/settings');
  assert.ok(!r.text.includes('new-secret-xyz'));

  r = await request(srv, 'PUT', '/api/settings', { body: { clockifyToken: '' } });
  assert.equal(r.json.tokenSet, false);
  assert.equal(loadConfig().clockifyToken, null);
});

test('PUT /api/settings validation: unknown keys and bad values -> 400 without echoing token', async (t) => {
  const { srv } = await setup(t);
  for (const body of [{ foo: 1 }, { thresholdMin: -1 }, { thresholdMin: 'x' }, { marginMin: -2 }, { port: 70000 },
    { clockifyToken: 5 }, { workspaceId: 3 }, [1], null]) {
    const r = await request(srv, 'PUT', '/api/settings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.kind, 'validation');
  }
  const bad = await request(srv, 'PUT', '/api/settings', { body: { clockifyToken: 'leak-me', foo: 1 } });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes('leak-me'));
  assert.equal(loadConfig().clockifyToken, 'test-token');
});

test('PUT /api/settings changing thresholds re-reconciles and pushes SSE', async (t) => {
  const { srv, db } = await setup(t);
  const sse = await openSse(srv);
  t.after(() => sse.close());
  await sse.waitFor(1);
  // s3 last event at NOW-1min; threshold 0.5 min -> closed -> proposed. The 1-min gap after SessionStart also
  // splits it: the lone SessionStart block is dropped and the Stop block becomes the entry (key moves to NOW-1min).
  const r = await request(srv, 'PUT', '/api/settings', { body: { thresholdMin: 0.5 } });
  assert.equal(r.status, 200);
  const ev = await sse.waitFor(2);
  assert.deepEqual(ev.data.filter((e) => e.sessionId === 's3').map((e) => e.status), ['proposed']);
  assert.deepEqual(listEntries(db).filter((e) => e.sessionId === 's3').map((e) => [e.startTs, e.status]),
    [[NOW - MIN, 'proposed']]);
});

// ---------- send ----------

test('send on in_progress entry -> rejected (state), no Clockify call', async (t) => {
  const { srv, db } = await setup(t);
  const r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s3] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].ok, false);
  assert.equal(r.json.results[0].error.kind, 'state');
  assert.equal(fake.requests.length, 0);
  assert.equal(entryOf(db, K.s3).status, 'in_progress');
});

test('successful send -> sent with clockifyId; second send without resend rejected; resend uses PUT', async (t) => {
  const { srv, db } = await setup(t);
  let r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(r.status, 200);
  const [res] = r.json.results;
  assert.equal(res.ok, true);
  assert.deepEqual(res.key, K.s1);
  assert.ok(res.clockifyId);
  const e = entryOf(db, K.s1);
  assert.equal(e.status, 'sent');
  assert.equal(e.clockifyId, res.clockifyId);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.projectId, 'p1');
  assert.deepEqual(posts()[0].body.tagIds, ['g1']);
  assert.equal(posts()[0].path, '/api/v1/workspaces/ws1/time-entries');

  r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(r.json.results[0].ok, false);
  assert.equal(r.json.results[0].error.kind, 'state');
  assert.equal(fake.requests.length, 1, 'only one request to fake Clockify');

  r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1], resend: true } });
  assert.equal(r.json.results[0].ok, true);
  assert.equal(r.json.results[0].clockifyId, res.clockifyId);
  const puts = fake.requests.filter((x) => x.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/api/v1/workspaces/ws1/time-entries/${res.clockifyId}`);
  assert.equal(posts().length, 1);
  assert.equal(entryOf(db, K.s1).status, 'sent');
});

test('failNext(429) -> entry unchanged, error.kind rate', async (t) => {
  const { srv, db } = await setup(t);
  const before = entryOf(db, K.s1);
  fake.failNext(429);
  const r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(r.json.results[0].ok, false);
  assert.equal(r.json.results[0].error.kind, 'rate');
  assert.deepEqual(entryOf(db, K.s1), before);
});

test('failNext(401) -> entry unchanged, error.kind auth, token not in response', async (t) => {
  const { srv, db } = await setup(t);
  const before = entryOf(db, K.s1);
  fake.failNext(401);
  const r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(r.json.results[0].error.kind, 'auth');
  assert.ok(!r.text.includes('test-token'));
  assert.deepEqual(entryOf(db, K.s1), before);
});

test('batch of 2 with first failing -> second still attempted, separate results', async (t) => {
  const { srv, db } = await setup(t);
  fake.failNext(500);
  const r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1, K.s2] } });
  assert.equal(r.json.results.length, 2);
  assert.deepEqual(r.json.results[0].key, K.s1);
  assert.equal(r.json.results[0].ok, false);
  assert.equal(r.json.results[0].error.kind, 'other');
  assert.deepEqual(r.json.results[1].key, K.s2);
  assert.equal(r.json.results[1].ok, true);
  assert.equal(posts().length, 2);
  assert.equal(entryOf(db, K.s1).status, 'proposed');
  assert.equal(entryOf(db, K.s2).status, 'sent');
});

test('unknown key -> notfound; missing projectId -> validation; no Clockify call', async (t) => {
  const { srv } = await setup(t);
  const r = await request(srv, 'POST', '/api/entries/send', {
    body: { keys: [{ sessionId: 'nope', startTs: 1 }, K.s4, { sessionId: 5 }] },
  });
  assert.equal(r.json.results[0].error.kind, 'notfound');
  assert.equal(r.json.results[1].error.kind, 'validation');
  assert.equal(r.json.results[2].error.kind, 'validation');
  assert.equal(fake.requests.length, 0);
});

test('send body validation -> 400', async (t) => {
  const { srv } = await setup(t);
  for (const body of [{}, { keys: 'x' }, { keys: [K.s1], resend: 'yes' }, { keys: [K.s1], extra: 1 }]) {
    const r = await request(srv, 'POST', '/api/entries/send', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const bad = await request(srv, 'POST', '/api/entries/send', { raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(fake.requests.length, 0);
});

test('double concurrent send of the same key -> exactly one Clockify POST and one busy', async (t) => {
  const { srv, db } = await setup(t, { clockifyTimeoutMs: 400 });
  fake.hangNext();
  const first = request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  const deadline = Date.now() + 2000;
  while (posts().length === 0) {
    assert.ok(Date.now() < deadline, 'first POST never reached Clockify');
    await new Promise((r) => setTimeout(r, 5));
  }
  const second = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(second.json.results[0].ok, false);
  assert.equal(second.json.results[0].error.kind, 'busy');
  const r1 = await first;
  assert.equal(r1.json.results[0].error.kind, 'network');
  assert.equal(posts().length, 1);
  assert.equal(entryOf(db, K.s1).status, 'proposed');
});

// ---------- entries ----------

test('GET /api/entries with filters', async (t) => {
  const { srv } = await setup(t);
  let r = await request(srv, 'GET', '/api/entries');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 4);
  r = await request(srv, 'GET', '/api/entries?status=in_progress');
  assert.deepEqual(r.json.map((e) => e.sessionId), ['s3']);
  r = await request(srv, 'GET', '/api/entries?from=2026-10-07');
  assert.equal(r.json.length, 0);
  r = await request(srv, 'GET', '/api/entries?from=2026-10-06&to=2026-10-06&status=proposed');
  assert.equal(r.json.length, 3);
  for (const q of ['status=bogus', 'from=yesterday', 'to=2026-1-1']) {
    assert.equal((await request(srv, 'GET', `/api/entries?${q}`)).status, 400, q);
  }
});

test('PATCH entry -> edited, SSE receives entries event', async (t) => {
  const { srv, db } = await setup(t);
  const sse = await openSse(srv);
  t.after(() => sse.close());
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /text\/event-stream/);
  const first = await sse.waitFor(1);
  assert.equal(first.event, 'entries');
  assert.equal(first.data.length, 4);

  const r = await request(srv, 'PATCH', `/api/entries/s1/${T0}`, {
    body: { minutes: 42, description: 'work', tagIds: ['g2'], projectId: 'p2', taskId: null },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'edited');
  assert.equal(r.json.minutes, 42);
  assert.equal(entryOf(db, K.s1).description, 'work');

  const ev = await sse.waitFor(2);
  assert.equal(ev.event, 'entries');
  assert.equal(ev.data.find((e) => e.sessionId === 's1').minutes, 42);
});

test('PATCH errors: in_progress 409, unknown field / bad type 400, unknown entry 404, bad JSON 400', async (t) => {
  const { srv, db } = await setup(t);
  const enc = (k) => `/api/entries/${encodeURIComponent(k.sessionId)}/${k.startTs}`;
  let r = await request(srv, 'PATCH', enc(K.s3), { body: { minutes: 3 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.kind, 'state');
  for (const body of [{ status: 'sent' }, { minutes: 'x' }, { minutes: -1 }, { startAt: 1.5 }, { tagIds: 'g1' },
    { tagIds: [1] }, { projectId: 3 }, { description: 'x'.repeat(501) }, {}, [1]]) {
    r = await request(srv, 'PATCH', enc(K.s1), { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  r = await request(srv, 'PATCH', '/api/entries/nope/1', { body: { minutes: 3 } });
  assert.equal(r.status, 404);
  r = await request(srv, 'PATCH', '/api/entries/s1/abc', { body: { minutes: 3 } });
  assert.equal(r.status, 400);
  r = await request(srv, 'PATCH', enc(K.s1), { raw: '{"minutes":' });
  assert.equal(r.status, 400);
  assert.equal(entryOf(db, K.s1).status, 'proposed');
});

test('PATCH with URL-encoded sessionId', async (t) => {
  const { srv, add } = await setup(t);
  add('a/b c', T0 + 50 * MIN, 'SessionStart');
  add('a/b c', T0 + 52 * MIN, 'Stop');
  await request(srv, 'POST', '/api/import'); // triggers reconcile
  const r = await request(srv, 'PATCH', `/api/entries/${encodeURIComponent('a/b c')}/${T0 + 50 * MIN}`, {
    body: { minutes: 9 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.sessionId, 'a/b c');
});

test('POST close on in_progress entry -> proposed; on proposed -> 409; unknown -> 404', async (t) => {
  const { srv, db } = await setup(t);
  let r = await request(srv, 'POST', `/api/entries/s3/${K.s3.startTs}/close`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'proposed');
  assert.equal(entryOf(db, K.s3).status, 'proposed');
  r = await request(srv, 'POST', `/api/entries/s1/${T0}/close`);
  assert.equal(r.status, 409);
  r = await request(srv, 'POST', '/api/entries/zz/1/close');
  assert.equal(r.status, 404);
});

// ---------- mappings, clockify lists, import ----------

test('GET/PUT /api/mappings', async (t) => {
  const { srv } = await setup(t);
  let r = await request(srv, 'GET', '/api/mappings');
  assert.deepEqual(r.json, [{ cwd: '/proj', projectId: 'p1', taskId: null, tagIds: ['g1'] }]);
  r = await request(srv, 'PUT', '/api/mappings', { body: { cwd: '/other', projectId: 'p2', taskId: 't1', tagIds: ['g2'] } });
  assert.equal(r.status, 200);
  r = await request(srv, 'GET', '/api/mappings');
  assert.deepEqual(r.json[0], { cwd: '/other', projectId: 'p2', taskId: 't1', tagIds: ['g2'] });
  for (const body of [{ projectId: 'p1' }, { cwd: '/x' }, { cwd: '/x', projectId: 'p', tagIds: 'g' }, { cwd: '/x', projectId: 'p', z: 1 }]) {
    assert.equal((await request(srv, 'PUT', '/api/mappings', { body })).status, 400, JSON.stringify(body));
  }
});

test('GET /api/clockify lists with cache and refresh; errors mapped', async (t) => {
  const { srv } = await setup(t);
  let r = await request(srv, 'GET', '/api/clockify/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }, { id: 'big', name: 'Big project' }]);
  r = await request(srv, 'GET', '/api/clockify/projects');
  assert.equal(fake.requests.length, 1, 'cached');
  r = await request(srv, 'GET', '/api/clockify/projects?refresh=1');
  assert.equal(fake.requests.length, 2);
  r = await request(srv, 'GET', '/api/clockify/tags');
  assert.equal(r.json[0].name, 'bug');
  r = await request(srv, 'GET', '/api/clockify/tasks?projectId=p1');
  assert.equal(r.json[0].id, 't1');
  assert.equal(fake.requests.at(-1).path, '/api/v1/workspaces/ws1/projects/p1/tasks');
  assert.equal((await request(srv, 'GET', '/api/clockify/tasks')).status, 400);

  fake.failNext(401);
  r = await request(srv, 'GET', '/api/clockify/tags?refresh=1');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.kind, 'auth');
  fake.failNext(500);
  r = await request(srv, 'GET', '/api/clockify/tags?refresh=1');
  assert.equal(r.status, 502);
  assert.equal(r.json.error.kind, 'other');
  assert.equal((await request(srv, 'GET', '/api/clockify/nope')).status, 404);
});

test('workspace falls back to getUser().defaultWorkspace when not configured', async (t) => {
  saveConfig({ workspaceId: null });
  const { srv } = await setup(t);
  const r = await request(srv, 'GET', '/api/clockify/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(fake.requests.map((x) => x.path), ['/api/v1/user', '/api/v1/workspaces/ws1/projects']);
});

test('POST /api/import imports transcripts, reconciles and returns counts', async (t) => {
  const { srv, db } = await setup(t);
  const r = await request(srv, 'POST', '/api/import');
  assert.equal(r.status, 200);
  assert.equal(r.json.files, 1);
  assert.ok(r.json.inserted > 0);
  assert.ok(listEntries(db).length > 4);
  const again = await request(srv, 'POST', '/api/import');
  assert.equal(again.json.inserted, 0);
});

// ---------- static, routing, limits ----------

test('GET / serves index.html with session token injected', async (t) => {
  const { srv } = await setup(t);
  const r = await request(srv, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(r.text.includes(`content="${srv.sessionToken}"`));
  assert.ok(!r.text.includes('{{SESSION_TOKEN}}'));
  assert.match(srv.sessionToken, /^[0-9a-f]{32}$/);
  const js = await request(srv, 'GET', '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('static: path traversal and missing files -> 404; non-GET -> 405', async (t) => {
  const { srv } = await setup(t);
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt',
    '/missing.html', '/%00', '/ui/../../secret.txt', '/..%5csecret.txt']) {
    const r = await request(srv, 'GET', p);
    assert.equal(r.status, r.status === 400 ? 400 : 404, p);
    assert.ok(!r.text.includes('TOP-SECRET'), p);
  }
  assert.equal((await request(srv, 'POST', '/')).status, 405);
});

test('unknown API route -> 404; wrong method -> 405; body too large -> 413', async (t) => {
  const { srv } = await setup(t);
  let r = await request(srv, 'GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.kind, 'notfound');
  r = await request(srv, 'DELETE', '/api/settings');
  assert.equal(r.status, 405);
  r = await request(srv, 'GET', '/api/entries/send');
  assert.equal(r.status, 405);
  r = await request(srv, 'PUT', '/api/settings', { raw: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }) });
  assert.equal(r.status, 413);
});

test('periodic reconcile pushes SSE only when entries change', async (t) => {
  const { srv, add, setNow } = await setup(t, { reconcileIntervalMs: 20 });
  const sse = await openSse(srv);
  t.after(() => sse.close());
  await sse.waitFor(1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sse.events.length, 1, 'no event while nothing changes');
  add('s9', NOW + MIN, 'SessionStart');
  setNow(NOW + 2 * MIN);
  const ev = await sse.waitFor(2);
  assert.ok(ev.data.some((e) => e.sessionId === 's9'));
});

test('close() leaves an injected db open and stops serving', async (t) => {
  const db = openDb(':memory:');
  const srv = await startServer({ port: 0, db, uiDir, reconcileIntervalMs: 60000 });
  assert.equal(srv.url, `http://127.0.0.1:${srv.port}`);
  const sse = await openSse(srv);
  await sse.waitFor(1);
  await srv.close();
  sse.close();
  assert.deepEqual(listEntries(db), []);
  await assert.rejects(request(srv, 'GET', '/api/entries'));
  db.close();
});

test('startServer rejects when the port is already in use', async (t) => {
  const { srv } = await setup(t);
  const db = openDb(':memory:');
  t.after(() => db.close());
  await assert.rejects(startServer({ port: srv.port, db, uiDir }), { code: 'EADDRINUSE' });
});

// ---------- reconcile modes (C1) ----------

test('settings change runs a full reconcile (also sessions older than the watermark)', async (t) => {
  const { srv, db } = await setup(t);
  // s2: SessionStart@T0+30, Stop@T0+35. Threshold 4 -> the lone SessionStart is dropped, key moves to the Stop.
  const r = await request(srv, 'PUT', '/api/settings', { body: { thresholdMin: 4 } });
  assert.equal(r.status, 200);
  assert.deepEqual(listEntries(db).filter((e) => e.sessionId === 's2').map((e) => e.startTs), [T0 + 35 * MIN]);
});

test('server start runs a full reconcile (back-dated event in an old session is applied)', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  insertEvent(db, { sessionId: 'old', ts: T0, type: 'Stop', cwd: '/proj' });
  insertEvent(db, { sessionId: 'live', ts: NOW - MIN, type: 'Stop', cwd: '/proj' });
  const pre = await startServer({ port: 0, db, now: () => NOW, uiDir, reconcileIntervalMs: 60000 });
  await pre.close();
  insertEvent(db, { sessionId: 'old', ts: T0 - 3 * MIN, type: 'UserPromptSubmit', cwd: '/proj', text: 'earlier' });
  const srv = await startServer({ port: 0, db, now: () => NOW, uiDir, reconcileIntervalMs: 60000 });
  t.after(() => srv.close());
  const old = listEntries(db).filter((e) => e.sessionId === 'old');
  assert.deepEqual(old.map((e) => [e.startTs, e.description]), [[T0 - 3 * MIN, 'earlier']]);
});

test('periodic tick is skipped when events are unchanged and nothing is in_progress', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  insertEvent(db, { sessionId: 'a', ts: T0, type: 'Stop', cwd: '/proj' });
  insertEvent(db, { sessionId: 'b', ts: T0 + 20 * MIN, type: 'Stop', cwd: '/proj' });
  let now = NOW;
  const srv = await startServer({ port: 0, db, now: () => now, uiDir, reconcileIntervalMs: 10 });
  t.after(() => srv.close());
  assert.equal(listEntries(db).length, 2);
  // a row removed behind the server's back is not recreated while the tick has nothing to do
  db.prepare("DELETE FROM entries WHERE sessionId = 'b'").run();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(listEntries(db).map((e) => e.sessionId), ['a']);
  // a new (hook-like) event changes the signature: the tick runs again
  now = NOW + MIN;
  insertEvent(db, { sessionId: 'c', ts: NOW, type: 'UserPromptSubmit', cwd: '/proj', text: 'x' });
  const deadline = Date.now() + 2000;
  while (!listEntries(db).some((e) => e.sessionId === 'c')) {
    assert.ok(Date.now() < deadline, 'tick never ran');
    await new Promise((r) => setTimeout(r, 10));
  }
});

// ---------- I3: mappings over HTTP ----------

test('PATCH assigning a project to an unmapped folder creates the mapping; PUT /api/mappings fills entries', async (t) => {
  const { srv, db, add } = await setup(t);
  add('s5', T0 + 45 * MIN, 'Stop', '/other');
  await request(srv, 'POST', '/api/import'); // full reconcile picks up s5
  const r = await request(srv, 'PATCH', `/api/entries/s4/${K.s4.startTs}`, { body: { projectId: 'p2', tagIds: ['g2'] } });
  assert.equal(r.status, 200);
  const maps = await request(srv, 'GET', '/api/mappings');
  assert.deepEqual(maps.json.find((m) => m.cwd === '/other'), { cwd: '/other', projectId: 'p2', taskId: null, tagIds: ['g2'] });
  assert.equal(listEntries(db).find((e) => e.sessionId === 's5').projectId, 'p2');

  add('s6', T0 + 50 * MIN, 'Stop', '/third');
  await request(srv, 'POST', '/api/import');
  assert.equal(listEntries(db).find((e) => e.sessionId === 's6').projectId, null);
  const put = await request(srv, 'PUT', '/api/mappings', { body: { cwd: '/third', projectId: 'p1', taskId: 't2' } });
  assert.equal(put.status, 200);
  const s6 = listEntries(db).find((e) => e.sessionId === 's6');
  assert.equal(s6.projectId, 'p1');
  assert.equal(s6.taskId, 't2');
});

// ---------- I5: state after Clockify accepted the entry; busy while sending ----------

async function sendHeld(srv, key, during) {
  const held = fake.holdNext();
  const pending = request(srv, 'POST', '/api/entries/send', { body: { keys: [key] } });
  await held.arrived;
  const extra = await during();
  held.release();
  return { res: await pending, extra };
}

test('created on Clockify but the row changed meanwhile: still saved as sent, ok', async (t) => {
  const { srv, db } = await setup(t);
  const { res } = await sendHeld(srv, K.s1, () => {
    db.prepare("UPDATE entries SET status = 'in_progress' WHERE sessionId = 's1'").run(); // block reopened
  });
  const [r] = res.json.results;
  assert.equal(r.ok, true);
  const e = entryOf(db, K.s1);
  assert.equal(e.status, 'sent');
  assert.equal(e.clockifyId, r.clockifyId);
  const again = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s1] } });
  assert.equal(again.json.results[0].error.kind, 'state');
  assert.equal(posts().length, 1, 'no duplicate on retry');
});

test('created on Clockify but the key moved meanwhile: the moved row is marked sent', async (t) => {
  const { srv, db } = await setup(t);
  const { res } = await sendHeld(srv, K.s1, () => {
    db.prepare("UPDATE entries SET startTs = startTs - 60000, startAt = startAt - 60000 WHERE sessionId = 's1'").run();
  });
  const [r] = res.json.results;
  assert.equal(r.ok, true);
  const moved = listEntries(db).find((e) => e.sessionId === 's1');
  assert.equal(moved.startTs, T0 - MIN);
  assert.equal(moved.status, 'sent');
  assert.equal(moved.clockifyId, r.clockifyId);
});

test('created on Clockify but the row is gone: state error carrying the clockifyId', async (t) => {
  const { srv, db } = await setup(t);
  const { res } = await sendHeld(srv, K.s1, () => {
    db.prepare("DELETE FROM entries WHERE sessionId = 's1'").run();
  });
  const [r] = res.json.results;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'state');
  assert.equal(r.error.message, 'Created on Clockify but not saved locally');
  assert.match(r.error.clockifyId, /^e\d+$/);
  assert.equal(posts().length, 1);
});

test('PATCH and close on an entry being sent -> 409 busy', async (t) => {
  const { srv, db } = await setup(t);
  const { res, extra } = await sendHeld(srv, K.s1, async () => ({
    patch: await request(srv, 'PATCH', `/api/entries/s1/${T0}`, { body: { minutes: 50 } }),
    close: await request(srv, 'POST', `/api/entries/s1/${T0}/close`),
  }));
  assert.equal(extra.patch.status, 409);
  assert.equal(extra.patch.json.error.kind, 'busy');
  assert.equal(extra.close.status, 409);
  assert.equal(extra.close.json.error.kind, 'busy');
  assert.equal(res.json.results[0].ok, true);
  assert.equal(entryOf(db, K.s1).minutes, 7);
  const later = await request(srv, 'PATCH', `/api/entries/s1/${T0}`, { body: { minutes: 50 } });
  assert.equal(later.status, 200);
});

// ---------- minors ----------

test('Content-Security-Policy header on API, error and SSE responses', async (t) => {
  const { srv } = await setup(t);
  const csp = "default-src 'self'; frame-ancestors 'none'";
  assert.equal((await request(srv, 'GET', '/api/entries')).headers['content-security-policy'], csp);
  assert.equal((await request(srv, 'GET', '/api/nope')).headers['content-security-policy'], csp);
  assert.equal((await request(srv, 'POST', '/api/import', { token: false })).headers['content-security-policy'], csp);
  const sse = await openSse(srv);
  t.after(() => sse.close());
  assert.equal(sse.headers['content-security-policy'], csp);
});

test('periodic reconcile errors are logged, at most once per minute', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  insertEvent(db, { sessionId: 'a', ts: NOW - MIN, type: 'Stop', cwd: '/proj' });
  const logs = [];
  const srv = await startServer({
    port: 0, db, now: () => NOW, uiDir, reconcileIntervalMs: 5, log: (...args) => logs.push(args.join(' ')),
  });
  t.after(() => srv.close());
  db.exec('DROP TABLE entries');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /^\[clockify\] reconcile failed: .*entries/);
  assert.ok(!logs[0].includes('test-token'));
});

test('DELETE entry hides it, SSE pushes the new list, reconcile does not bring it back', async (t) => {
  const { srv, db } = await setup(t);
  const sse = await openSse(srv);
  t.after(() => sse.close());
  await sse.waitFor(1);
  const r = await request(srv, 'DELETE', `/api/entries/s1/${T0}`);
  assert.equal(r.status, 200);
  const ev = await sse.waitFor(2);
  assert.equal(ev.data.length, 3);
  assert.ok(!ev.data.some((e) => e.sessionId === 's1'));
  reconcile(db, NOW + MIN, { thresholdMin: 10, marginMin: 2, full: true });
  const list = await request(srv, 'GET', '/api/entries');
  assert.equal(list.json.length, 3);
  assert.ok(!list.json.some((e) => e.sessionId === 's1'));
  const gone = await request(srv, 'GET', '/api/entries?status=dismissed');
  assert.deepEqual(gone.json.map((e) => e.sessionId), ['s1']);
});

test('DELETE errors: in_progress 409, unknown / already deleted 404, no token 403, bad key 400', async (t) => {
  const { srv, db } = await setup(t);
  let r = await request(srv, 'DELETE', `/api/entries/s3/${K.s3.startTs}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.kind, 'state');
  assert.equal(entryOf(db, K.s3).status, 'in_progress');
  r = await request(srv, 'DELETE', '/api/entries/nope/1');
  assert.equal(r.status, 404);
  r = await request(srv, 'DELETE', `/api/entries/s1/${T0}`, { token: false });
  assert.equal(r.status, 403);
  assert.equal(entryOf(db, K.s1).status, 'proposed');
  r = await request(srv, 'DELETE', '/api/entries/s1/abc');
  assert.equal(r.status, 400);
  assert.equal((await request(srv, 'DELETE', `/api/entries/s1/${T0}`)).status, 200);
  r = await request(srv, 'DELETE', `/api/entries/s1/${T0}`);
  assert.equal(r.status, 404);
});

test('a deleted entry cannot be patched or sent, and a delete during a send is busy', async (t) => {
  const { srv, db } = await setup(t);
  await request(srv, 'DELETE', `/api/entries/s2/${K.s2.startTs}`);
  let r = await request(srv, 'PATCH', `/api/entries/s2/${K.s2.startTs}`, { body: { minutes: 3 } });
  assert.equal(r.status, 404);
  r = await request(srv, 'POST', '/api/entries/send', { body: { keys: [K.s2] } });
  assert.equal(r.json.results[0].error.kind, 'notfound');
  assert.equal(posts().length, 0);

  const { extra } = await sendHeld(srv, K.s1, () => request(srv, 'DELETE', `/api/entries/s1/${T0}`));
  assert.equal(extra.status, 409);
  assert.equal(extra.json.error.kind, 'busy');
  assert.equal(entryOf(db, K.s1).status, 'sent');
});

test('POST /api/import validates the optional period', async (t) => {
  const { srv } = await setup(t);
  const bad1 = await request(srv, 'POST', '/api/import', { body: { from: 'x' } });
  assert.equal(bad1.status, 400);
  const bad2 = await request(srv, 'POST', '/api/import', { body: { from: 5, to: 1 } });
  assert.equal(bad2.status, 400);
  const bad3 = await request(srv, 'POST', '/api/import', { body: { foo: 1 } });
  assert.equal(bad3.status, 400);
  const ok = await request(srv, 'POST', '/api/import', { body: { from: 0, to: Date.now() } });
  assert.equal(ok.status, 200);
});

test('DELETE /api/mappings removes a mapping; unknown or malformed -> 404 / 400', async (t) => {
  const { srv } = await setup(t);
  await request(srv, 'PUT', '/api/mappings', { body: { cwd: '/gone', projectId: 'p1' } });
  assert.equal((await request(srv, 'DELETE', '/api/mappings', { body: {} })).status, 400);
  assert.equal((await request(srv, 'DELETE', '/api/mappings', { body: { cwd: '/nope' } })).status, 404);
  const r = await request(srv, 'DELETE', '/api/mappings', { body: { cwd: '/gone' } });
  assert.equal(r.status, 200);
  assert.ok(!r.json.some((m) => m.cwd === '/gone'));
});
