// Shared by the CLI and the dashboard: saved profile state and the month's records from Clockify.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { dataDir } from './config.js';
import { buildRecords, hashBuffer, monthRange, validateProfile } from './export.js';

export const profileFile = () => path.join(dataDir(), 'export-profile.json');

/**
 * state: 'missing' (no profile), 'invalid', 'template_missing', 'template_changed' or 'ready'.
 * Only 'ready' carries the validated profile and the template bytes.
 */
export function loadProfileState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', message: 'The saved export profile is not valid JSON' };
  }
  let profile;
  try {
    profile = { ...validateProfile(raw), templatePath: raw.templatePath, templateSha256: raw.templateSha256 };
  } catch (e) {
    return { state: 'invalid', message: e.message };
  }
  let templateBuf;
  try {
    templateBuf = fs.readFileSync(profile.templatePath);
  } catch {
    return { state: 'template_missing', templatePath: profile.templatePath };
  }
  if (hashBuffer(templateBuf) !== profile.templateSha256) {
    return { state: 'template_changed', templatePath: profile.templatePath };
  }
  return { state: 'ready', profile, templateBuf, templatePath: profile.templatePath };
}

/** Finished entries of the month from Clockify, turned into export records. */
export async function collectMonth({ client, workspaceId, month, profile }) {
  const { start, end } = monthRange(month);
  const user = await client.getUser();
  const entries = await client.listTimeEntries(workspaceId ?? user.defaultWorkspace, user.id, start.toISOString(), end.toISOString());
  const records = buildRecords(entries, profile, month);
  const totalHours = records.reduce((s, r) => s + r.ms, 0) / 3600000;
  return { entries, records, totalHours };
}

/**
 * Legacy .xls templates are converted once to .xlsx (LibreOffice) into the data dir; returns the .xlsx path.
 * .xlsx files are returned unchanged. The profile then points at the converted copy.
 */
export function ensureXlsx(file) {
  const abs = path.resolve(file);
  if (path.extname(abs).toLowerCase() !== '.xls') return abs;
  const outDir = path.join(dataDir(), 'templates');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', outDir, abs], { stdio: 'ignore', timeout: 120000 });
  } catch {
    throw new Error('Could not convert the .xls template: install LibreOffice (soffice) or save the template as .xlsx');
  }
  const out = path.join(outDir, `${path.basename(abs, path.extname(abs))}.xlsx`);
  if (!fs.existsSync(out)) throw new Error('The .xls conversion produced no file');
  return out;
}
