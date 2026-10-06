// Monthly xlsx export.
//   node export/cli.js inspect <template.xlsx>
//   node export/cli.js save-profile <profile.json> --template <template.xlsx>
//   node export/cli.js run [--month YYYY-MM] [--out file.xlsx] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { collectMonth, ensureXlsx, loadProfileState, profileFile } from '../core/export-service.js';
import { createClient } from '../clockify/client.js';
import { openWorkbook } from '../xlsx/workbook.js';
import {
  currentMonth, fillTemplate, hashBuffer, monthRange, previewRows, rowCount, validateProfile,
} from '../core/export.js';

const MAX_CELLS_PER_SHEET = 500;
const profilePath = profileFile;

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function inspect(file, io) {
  const templatePath = ensureXlsx(file);
  const buf = fs.readFileSync(templatePath);
  const wb = openWorkbook(buf);
  io.log(`Template: ${path.resolve(templatePath)}`);
  io.log(`Sheets: ${wb.sheetNames().join(', ')}`);
  for (const name of wb.sheetNames()) {
    const cells = wb.readCells(name);
    io.log(`\n=== Sheet "${name}" (${cells.length} non-empty cells) ===`);
    for (const c of cells.slice(0, MAX_CELLS_PER_SHEET)) io.log(`${c.ref}: ${c.value}`);
    if (cells.length > MAX_CELLS_PER_SHEET) io.log(`... ${cells.length - MAX_CELLS_PER_SHEET} more cells not shown`);
  }
  return 0;
}

function saveProfile(file, template, io) {
  const templatePath = ensureXlsx(template);
  const profile = validateProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
  const buf = fs.readFileSync(templatePath);
  const wb = openWorkbook(buf);
  const names = wb.sheetNames();
  for (const n of [profile.sheet, ...profile.removeSheets]) {
    if (!names.includes(n)) throw new Error(`Invalid export profile: sheet "${n}" not found in the template (${names.join(', ')})`);
  }
  const out = { ...profile, templatePath: path.resolve(templatePath), templateSha256: hashBuffer(buf) };
  fs.writeFileSync(profilePath(), JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.chmodSync(profilePath(), 0o600);
  io.log(`Profile saved: ${profilePath()}`);
  return 0;
}

async function run(argv, io, deps) {
  const st = loadProfileState();
  if (st.state === 'missing') {
    io.err('No export profile yet. Run the profile setup first (see /clockify-export).');
    return 2;
  }
  if (st.state === 'invalid') {
    io.err(`${st.message}. Regenerate the profile (see /clockify-export).`);
    return 2;
  }
  if (st.state === 'template_missing') {
    io.err(`Template file not found: ${st.templatePath}. Regenerate the profile with the new path.`);
    return 3;
  }
  if (st.state === 'template_changed') {
    io.err(`The template changed since the profile was created: ${st.templatePath}. Regenerate the profile.`);
    return 3;
  }
  const { profile, templateBuf } = st;

  const month = flag(argv, '--month') ?? currentMonth();
  monthRange(month);
  const cfg = loadConfig();
  const client = deps.client ?? createClient({ token: cfg.clockifyToken, baseUrl: cfg.baseUrl });
  const { entries, records, totalHours } = await collectMonth({ client, workspaceId: cfg.workspaceId, month, profile });
  io.log(`Month ${month}: ${entries.length} entries -> ${rowCount(records)} rows, ${totalHours.toFixed(2)} h`);

  if (argv.includes('--dry-run')) {
    previewRows(records, profile).forEach((l) => io.log(l));
    const n = rowCount(records);
    if (n > 15) io.log(`... ${n - 15} more rows`);
    return 0;
  }
  if (rowCount(records) === 0) {
    io.err('No entries in that month: nothing to export.');
    return 4;
  }
  const out = path.resolve(flag(argv, '--out') ?? `clockify-${month}.xlsx`);
  fs.writeFileSync(out, fillTemplate(templateBuf, profile, records, month));
  io.log(`Written: ${out}`);
  return 0;
}

export async function main(argv, io = { log: console.log, err: console.error }, deps = {}) {
  try {
    const [cmd, arg] = argv;
    if (cmd === 'inspect' && arg) return inspect(arg, io);
    if (cmd === 'save-profile' && arg && flag(argv, '--template')) return saveProfile(arg, flag(argv, '--template'), io);
    if (cmd === 'run') return await run(argv, io, deps);
    io.err('Usage: cli.js inspect <template> | save-profile <profile.json> --template <template> | run [--month YYYY-MM] [--out file] [--dry-run]');
    return 1;
  } catch (e) {
    io.err(`Error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
