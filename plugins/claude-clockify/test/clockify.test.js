import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ClockifyError, toClockifyEntry } from '../clockify/client.js';
import { startFakeClockify } from './helpers/fake-clockify.js';

const TOKEN = 'secret-token-123';
let fake;
let client;

before(async () => {
  fake = await startFakeClockify();
  client = createClient({ token: TOKEN, baseUrl: fake.url });
});
after(async () => {
  await fake.close();
});

const entry = (extra = {}) => ({
  start: '2026-10-06T07:00:00.000Z',
  end: '2026-10-06T08:30:00.000Z',
  description: 'x',
  projectId: 'p1',
  ...extra,
});

test('X-Api-Key and JSON content type on every request', async () => {
  fake.requests.length = 0;
  await client.getUser();
  await client.listProjects('ws1');
  await client.listTasks('ws1', 'p1');
  await client.listTags('ws1');
  await client.createEntry('ws1', entry());
  await client.updateEntry('ws1', 'e9', entry());
  assert.equal(fake.requests.length, 6);
  for (const r of fake.requests) {
    assert.equal(r.headers['x-api-key'], TOKEN);
    assert.equal(r.headers['content-type'], 'application/json');
  }
});

test('getUser and list endpoints return plain data', async () => {
  assert.deepEqual(await client.getUser(), { id: 'u1', defaultWorkspace: 'ws1' });
  assert.deepEqual(await client.listProjects('ws1'), [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
    { id: 'big', name: 'Big project' },
  ]);
  assert.deepEqual(await client.listTasks('ws1', 'p1'), [
    { id: 't1', name: 'Development' },
    { id: 't2', name: 'Analysis' },
  ]);
  assert.deepEqual(await client.listTags('ws1'), [
    { id: 'g1', name: 'bug' },
    { id: 'g2', name: 'feature' },
  ]);
  const last = fake.requests.at(-1);
  assert.equal(last.path, '/api/v1/workspaces/ws1/tags');
});

test('createEntry posts body and returns id', async () => {
  fake.requests.length = 0;
  const r = await client.createEntry('ws1', entry({ taskId: 't1', tagIds: ['g1'] }));
  assert.match(r.id, /^e\d+$/);
  const req = fake.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/v1/workspaces/ws1/time-entries');
  assert.equal(req.body.taskId, 't1');
  assert.deepEqual(req.body.tagIds, ['g1']);
});

test('createEntry omits taskId/tagIds when empty', async () => {
  fake.requests.length = 0;
  await client.createEntry('ws1', entry({ taskId: undefined, tagIds: [] }));
  const body = fake.requests[0].body;
  assert.equal('taskId' in body, false);
  assert.equal('tagIds' in body, false);
  assert.equal(body.projectId, 'p1');
});

test('updateEntry uses PUT on /time-entries/{id}', async () => {
  fake.requests.length = 0;
  const r = await client.updateEntry('ws1', 'e42', entry());
  assert.deepEqual(r, { id: 'e42' });
  assert.equal(fake.requests[0].method, 'PUT');
  assert.equal(fake.requests[0].path, '/api/v1/workspaces/ws1/time-entries/e42');
});

test('toClockifyEntry: 90 min gives exactly 5400000 ms', () => {
  const startAt = Date.UTC(2026, 9, 6, 7, 0);
  const e = toClockifyEntry({ startAt, minutes: 90, description: 'd', projectId: 'p1', taskId: null, tagIds: [] });
  assert.equal(e.start, '2026-10-06T07:00:00.000Z');
  assert.equal(Date.parse(e.end) - Date.parse(e.start), 5400000);
  assert.equal('taskId' in e, false);
  assert.equal('tagIds' in e, false);
  assert.equal(e.description, 'd');
  assert.equal(e.projectId, 'p1');
});

test('toClockifyEntry: includes taskId/tagIds and handles fractional minutes', () => {
  const e = toClockifyEntry({ startAt: 0, minutes: 1.5, description: '', projectId: 'p', taskId: 't1', tagIds: ['g1'] });
  assert.equal(e.taskId, 't1');
  assert.deepEqual(e.tagIds, ['g1']);
  assert.equal(Date.parse(e.end) - Date.parse(e.start), 90000);
});

test('toClockifyEntry: exact duration across DST change (Europe/Rome)', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Europe/Rome';
  try {
    const startAt = new Date(2026, 2, 29, 0, 30).getTime(); // local 00:30, DST starts 02:00 -> 03:00
    const e = toClockifyEntry({ startAt, minutes: 180, description: 'd', projectId: 'p1' });
    assert.equal(Date.parse(e.end) - Date.parse(e.start), 180 * 60000);
    assert.equal(e.start, new Date(startAt).toISOString());
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test('createEntry sends exact ms difference across DST', async () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Europe/Rome';
  try {
    fake.requests.length = 0;
    const startAt = new Date(2026, 2, 29, 0, 30).getTime();
    await client.createEntry('ws1', toClockifyEntry({ startAt, minutes: 180, description: 'd', projectId: 'p1' }));
    const { start, end } = fake.requests[0].body;
    assert.match(start, /Z$/);
    assert.match(end, /Z$/);
    assert.equal(Date.parse(end) - Date.parse(start), 10800000);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

for (const [status, kind] of [
  [401, 'auth'],
  [403, 'auth'],
  [429, 'rate'],
  [500, 'other'],
  [404, 'other'],
]) {
  test(`failNext(${status}) -> kind ${kind}`, async () => {
    fake.failNext(status);
    await assert.rejects(
      () => client.getUser(),
      (err) => {
        assert.ok(err instanceof ClockifyError);
        assert.equal(err.kind, kind);
        assert.equal(err.status, status);
        assert.equal(err.message.includes(TOKEN), false);
        if (kind === 'other') assert.match(err.message, new RegExp(String(status)));
        return true;
      },
    );
    // next request succeeds: failNext is one-shot, no retry consumed it
    assert.equal((await client.getUser()).id, 'u1');
  });
}

test('no automatic retry: one request per failure', async () => {
  fake.requests.length = 0;
  fake.failNext(500);
  await assert.rejects(() => client.listTags('ws1'));
  assert.equal(fake.requests.length, 1);
});

test('closed server -> kind network', async () => {
  const f2 = await startFakeClockify();
  const c2 = createClient({ token: TOKEN, baseUrl: f2.url });
  await f2.close();
  await assert.rejects(
    () => c2.getUser(),
    (err) => {
      assert.ok(err instanceof ClockifyError);
      assert.equal(err.kind, 'network');
      assert.equal(err.status, null);
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
});

test('null/empty token -> auth without any network call', async () => {
  for (const token of [null, '']) {
    const c = createClient({ token, baseUrl: fake.url });
    fake.requests.length = 0;
    const calls = [
      () => c.getUser(),
      () => c.listProjects('ws1'),
      () => c.listTasks('ws1', 'p1'),
      () => c.listTags('ws1'),
      () => c.createEntry('ws1', entry()),
      () => c.updateEntry('ws1', 'e1', entry()),
    ];
    for (const call of calls) {
      await assert.rejects(call, (err) => {
        assert.ok(err instanceof ClockifyError);
        assert.equal(err.kind, 'auth');
        assert.equal(err.status, null);
        return true;
      });
    }
    assert.equal(fake.requests.length, 0);
  }
});

test('lists follow pagination until the last page', async () => {
  fake.requests.length = 0;
  const tasks = await client.listTasks('ws1', 'big');
  assert.equal(tasks.length, 450);
  assert.equal(tasks[449].id, 'bt450');
  assert.deepEqual(fake.requests.map((r) => r.query), ['?page-size=200', '?page-size=200&page=2', '?page-size=200&page=3']);
});

test('list endpoints send ?page-size=200', async () => {
  fake.requests.length = 0;
  await client.listProjects('ws1');
  await client.listTasks('ws1', 'p1');
  await client.listTags('ws1');
  assert.equal(fake.requests.length, 3);
  for (const r of fake.requests) assert.equal(r.query, '?page-size=200');
});

test('hung server -> network error after timeoutMs, token not leaked', async () => {
  const f2 = await startFakeClockify();
  const c2 = createClient({ token: TOKEN, baseUrl: f2.url, timeoutMs: 100 });
  f2.hangNext();
  const t0 = Date.now();
  await assert.rejects(
    () => c2.getUser(),
    (err) => {
      assert.ok(err instanceof ClockifyError);
      assert.equal(err.kind, 'network');
      assert.equal(err.status, null);
      assert.match(err.message, /timeout/i);
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 1500);
  await f2.close();
});

test('2xx with empty body (204): write methods -> other, no TypeError', async () => {
  for (const call of [
    () => client.createEntry('ws1', entry()),
    () => client.updateEntry('ws1', 'e1', entry()),
    () => client.getUser(),
    () => client.listTags('ws1'),
  ]) {
    fake.respondNext(204, '');
    await assert.rejects(call, (err) => {
      assert.ok(err instanceof ClockifyError);
      assert.equal(err.kind, 'other');
      assert.match(err.message, /unexpected response/);
      return true;
    });
  }
});

test('unexpected body shapes -> ClockifyError other', async () => {
  const cases = [
    [() => client.createEntry('ws1', entry()), '{"id":5}'],
    [() => client.updateEntry('ws1', 'e1', entry()), '[]'],
    [() => client.getUser(), 'null'],
    [() => client.listProjects('ws1'), '{"a":1}'],
    [() => client.listTasks('ws1', 'p1'), 'not json'],
  ];
  for (const [call, text] of cases) {
    fake.respondNext(200, text);
    await assert.rejects(call, (err) => err instanceof ClockifyError && err.kind === 'other');
  }
});
