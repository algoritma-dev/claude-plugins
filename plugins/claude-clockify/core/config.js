import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = {
  thresholdMin: 10,
  marginMin: 2,
  port: 4747,
  clockifyToken: null,
  workspaceId: null,
  baseUrl: 'https://api.clockify.me/api/v1',
};

const privateDirs = new Set();

/** Data directory (prompt texts and token live here): created/kept private, mode 0o700. */
export function dataDir() {
  const dir = process.env.CLAUDE_CLOCKIFY_HOME ?? path.join(os.homedir(), '.claude-clockify');
  if (!privateDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    privateDirs.add(dir);
  }
  return dir;
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ...DEFAULTS, ...stored };
}

export function saveConfig(partial) {
  const merged = { ...loadConfig(), ...partial };
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return merged;
}
