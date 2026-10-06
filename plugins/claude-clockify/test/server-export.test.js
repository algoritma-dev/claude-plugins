import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db.js';
import { saveConfig } from '../core/config.js';
import { startServer } from '../server/server.js';
import { main } from '../export/cli.js';
import { openWorkbook } from '../xlsx/workbook.js';
import { startFakeClockify } from './helpers/fake-clockify.js';
import { makeTemplate } from './helpers/make-template.js';

let home;
let fake;
let srv;
const PROFILE = {
  sheet: 'Hours',
  startRow: 4,
  columns: [{ col: 'A', field: 'date' }, { col: 'B', field: 'project' }, { col: 'C', field: 'hours' }],
  removeSheets: ['Rules'],
};

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-srv-export-'));
  process.env.CLAUDE_CLOCKIFY_HOME = path.join(home, 'data');
  fake = await startFakeClockify();
  saveConfig({ baseUrl: fake.url, clockifyToken: 'test-token', workspaceId: 'ws1' });
  fs.writeFileSync(path.join(home, 'template.xlsx'), makeTemplate());
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify(PROFILE));
  const uiDir = path.join(home, 'ui');
  fs.mkdirSync(uiDir);
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<html></html>');
  srv = await startServer({ port: 0, db: openDb(':memory:'), uiDir, reconcileIntervalMs: 60000, clockifyTimeoutMs: 1000 });
});
after(async () => {
  await srv.close();
  await fake.close();
  delete process.env.CLAUDE_CLOCKIFY_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const call = (method, p, body, token = true) => fetch(`http://127.0.0.1:${srv.port}${p}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-session-token': srv.sessionToken } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('status is "missing" until a profile is saved', async () => {
  const r = await call('GET', '/api/export/status');
  assert.equal((await r.json()).state, 'missing');
  const p = await call('POST', '/api/export/preview', { month: '2026-10' });
  assert.equal(p.status, 409);
});

test('with a profile: status, preview and download', async () => {
  const io = { log() {}, err() {} };
  assert.equal(await main(['save-profile', path.join(home, 'profile.json'), '--template', path.join(home, 'template.xlsx')], io), 0);

  const status = await (await call('GET', '/api/export/status')).json();
  assert.equal(status.state, 'ready');
  assert.equal(status.sheet, 'Hours');
  assert.deepEqual(status.columns, ['date', 'project', 'hours']);
  assert.match(status.month, /^\d{4}-\d{2}$/);

  const prev = await (await call('POST', '/api/export/preview', { month: '2026-10' })).json();
  assert.equal(prev.entries, 2);
  assert.equal(prev.rows, 2);
  assert.equal(prev.totalHours, 1.5);
  assert.deepEqual(prev.preview[0].slice(1), ['Alpha', '1']);

  const dl = await call('POST', '/api/export/download', { month: '2026-10' });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(dl.headers.get('content-disposition'), /filename="clockify-2026-10\.xlsx"/);
  const wb = openWorkbook(Buffer.from(await dl.arrayBuffer()));
  assert.deepEqual(wb.sheetNames(), ['Hours']);
  assert.equal(wb.readCells('Hours').find((c) => c.ref === 'B4').value, 'Alpha');
});

test('validation, token and template-change guards', async () => {
  assert.equal((await call('POST', '/api/export/preview', { month: '2026-13' })).status, 400);
  assert.equal((await call('POST', '/api/export/preview', { month: '2026-10', path: '/etc/passwd' })).status, 400);
  assert.equal((await call('POST', '/api/export/download', { month: '2026-10' }, false)).status, 403);
  fs.appendFileSync(path.join(home, 'template.xlsx'), Buffer.from([0]));
  assert.equal((await (await call('GET', '/api/export/status')).json()).state, 'template_changed');
  assert.equal((await call('POST', '/api/export/download', { month: '2026-10' })).status, 409);
});
