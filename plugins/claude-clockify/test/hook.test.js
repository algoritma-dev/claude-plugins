import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, listEvents } from '../core/db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'hooks', 'record.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-'));
}

function run(home, input) {
  return spawnSync(process.execPath, [script], {
    input,
    env: { ...process.env, CLAUDE_CLOCKIFY_HOME: home },
    encoding: 'utf8',
  });
}

function events(home) {
  const f = path.join(home, 'data.sqlite');
  if (!fs.existsSync(f)) return [];
  const db = openDb(f);
  try {
    return listEvents(db);
  } finally {
    db.close();
  }
}

test('valid stdin records one event', () => {
  const home = tmp();
  const r = run(home, JSON.stringify({ session_id: 's1', cwd: '/p', hook_event_name: 'UserPromptSubmit', prompt: 'hello' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const ev = events(home);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'UserPromptSubmit');
  assert.equal(ev[0].cwd, '/p');
  assert.equal(ev[0].text, 'hello');
  assert.equal(ev[0].sessionId, 's1');
});

test('prompt truncated to 200 chars; non-prompt events have no text', () => {
  const home = tmp();
  run(home, JSON.stringify({ session_id: 's1', cwd: '/p', hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(500) }));
  run(home, JSON.stringify({ session_id: 's1', cwd: '/p', hook_event_name: 'Stop', prompt: 'ignored' }));
  const ev = events(home);
  assert.equal(ev.find((e) => e.type === 'UserPromptSubmit').text.length, 200);
  assert.equal(ev.find((e) => e.type === 'Stop').text, null);
});

test('empty stdin exits 0 with no events', () => {
  const home = tmp();
  const r = run(home, '');
  assert.equal(r.status, 0);
  assert.equal(events(home).length, 0);
});

test('invalid json does not crash', () => {
  const home = tmp();
  const r = run(home, 'not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(events(home).length, 0);
});

test('unknown hook_event_name and missing fields are ignored', () => {
  const home = tmp();
  assert.equal(run(home, JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'PreToolUse' })).status, 0);
  assert.equal(run(home, JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'ManualClose' })).status, 0);
  assert.equal(run(home, JSON.stringify({ cwd: '/p', hook_event_name: 'Stop' })).status, 0);
  assert.equal(run(home, JSON.stringify({ session_id: 's', hook_event_name: 'Stop' })).status, 0);
  assert.equal(events(home).length, 0);
});

test('DB failure still exits 0 with empty stdout', () => {
  const home = tmp();
  const file = path.join(home, 'afile');
  fs.writeFileSync(file, 'x');
  const r = run(path.join(file, 'sub'), JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'Stop' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hooks.json registers exactly the four events', () => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(j.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(j.hooks)) {
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].hooks, [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/record.js"' }]);
  }
});

test('hook-errors.log is created with mode 0o600', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'data.sqlite')); // the DB cannot be opened -> error logged
  const r = run(home, JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'Stop' }));
  assert.equal(r.status, 0);
  const log = path.join(home, 'hook-errors.log');
  assert.ok(fs.existsSync(log), 'error logged');
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});
