import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../core/db.js';
import { startServer } from '../server/server.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

let home;
let srv;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-'));
  process.env.CLAUDE_CLOCKIFY_HOME = home;
  srv = await startServer({ port: 0, db: openDb(':memory:'), uiDir: UI_DIR, reconcileIntervalMs: 60000 });
});

after(async () => {
  await srv.close();
  delete process.env.CLAUDE_CLOCKIFY_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

test('GET / serves index.html with the session token substituted', async () => {
  const res = await fetch(`${srv.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.ok(!html.includes('{{SESSION_TOKEN}}'));
  const m = /<meta\s+name="session-token"\s+content="([^"]*)"/.exec(html);
  assert.ok(m, 'session-token meta tag present');
  assert.match(m[1], /^(?:[0-9a-f]{32,}|[A-Za-z0-9+/=_-]{64,})$/);
  assert.equal(m[1], srv.sessionToken);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'self'/);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
});

test('GET /app.js and /style.css are served with the right content types', async () => {
  const js = await fetch(`${srv.url}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.equal(js.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
  await js.text();
  const css = await fetch(`${srv.url}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  await css.text();
});

test('app.js never assigns HTML strings to the DOM', () => {
  const src = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  assert.doesNotMatch(src, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/);
});

test('index.html has no inline scripts, styles or event handlers (CSP friendly)', () => {
  const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc=/, 'script tags must load external files');
    assert.equal(m[2].trim(), '', 'script tags must have no inline body');
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son\w+\s*=/i);
});

test('import message labels skipped lines as invalid; batch send excludes rows with unsaved edits', () => {
  const src = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  assert.match(src, /skipped \?\? 0\} invalid lines skipped/);
  assert.doesNotMatch(src, /already present/);
  const dialog = src.slice(src.indexOf('async function openSendDialog'), src.indexOf('async function confirmSendDialog'));
  assert.match(dialog, /saveFailed/);
  assert.match(dialog, /unsaved edit/);
});

test('rows have a Delete button that confirms (warns for sent entries) and calls DELETE', () => {
  const js = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  assert.match(js, /class: 'delete'/);
  assert.match(js, /api\('DELETE', entryPath\(ctl\.entry\)\)/);
  assert.match(js, /the entry on Clockify is NOT removed/);
});
