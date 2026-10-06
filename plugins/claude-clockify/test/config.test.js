import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, dataDir } from '../core/config.js';

beforeEach(() => {
  process.env.CLAUDE_CLOCKIFY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-'));
});

test('loadConfig without a file returns the defaults', () => {
  const c = loadConfig();
  assert.equal(c.thresholdMin, 10);
  assert.equal(c.marginMin, 2);
  assert.equal(c.port, 4747);
  assert.equal(c.clockifyToken, null);
  assert.equal(c.workspaceId, null);
  assert.equal(typeof c.baseUrl, 'string');
});

test('saveConfig merges on disk and keeps the other defaults', () => {
  saveConfig({ thresholdMin: 15 });
  const c = loadConfig();
  assert.equal(c.thresholdMin, 15);
  assert.equal(c.marginMin, 2);
});

test('the config file has mode 0o600', () => {
  saveConfig({ thresholdMin: 15 });
  const f = path.join(dataDir(), 'config.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('data dir is created with mode 0o700, also fixing an existing looser one', () => {
  const base = process.env.CLAUDE_CLOCKIFY_HOME;
  process.env.CLAUDE_CLOCKIFY_HOME = path.join(base, 'fresh');
  assert.equal(fs.statSync(dataDir()).mode & 0o777, 0o700);
  const loose = path.join(base, 'loose');
  fs.mkdirSync(loose, { mode: 0o775 });
  fs.chmodSync(loose, 0o775);
  process.env.CLAUDE_CLOCKIFY_HOME = loose;
  dataDir();
  assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
});
