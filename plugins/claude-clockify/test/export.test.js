import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRecords, fillTemplate, validateProfile, monthRange, currentMonth, previewRows } from '../core/export.js';
import { openWorkbook } from '../xlsx/workbook.js';
import { main } from '../export/cli.js';
import { makeTemplate, ENTRIES } from './helpers/make-template.js';

const PROFILE = {
  sheet: 'Hours',
  startRow: 4,
  columns: [{ col: 'A', field: 'date' }, { col: 'B', field: 'project' }, { col: 'C', field: 'hours' }],
  meta: [{ cell: 'B1', value: '{{month}} ({{year}})' }],
  removeSheets: ['Rules'],
};

const cells = (buf, sheet) => Object.fromEntries(openWorkbook(buf).readCells(sheet).map((c) => [c.ref, c.value]));

test('validateProfile accepts a good profile and explains bad ones', () => {
  assert.equal(validateProfile(PROFILE).groupBy, null);
  assert.throws(() => validateProfile({ ...PROFILE, columns: [{ col: 'A', field: 'nope' }] }), /unknown field "nope"/);
  assert.throws(() => validateProfile({ ...PROFILE, startRow: 0 }), /startRow/);
  assert.throws(() => validateProfile({ ...PROFILE, removeSheets: ['Hours'] }), /cannot contain the sheet to fill/);
  assert.throws(() => validateProfile({ ...PROFILE, meta: [{ cell: 'b1', value: 'x' }] }), /meta/);
  assert.throws(() => validateProfile({ ...PROFILE, groupBy: ['date'], columns: [{ col: 'A', field: 'start' }] }), /cannot be used with "groupBy"/);
});

test('monthRange and currentMonth', () => {
  const { start, end } = monthRange('2026-12');
  assert.equal(start.getMonth(), 11);
  assert.equal(end.getFullYear(), 2027);
  assert.equal(end.getMonth(), 0);
  assert.throws(() => monthRange('2026-13'), /Invalid month/);
  assert.equal(currentMonth(new Date(2026, 9, 6)), '2026-10');
});

test('one row per entry, sorted, with Excel serial dates and decimal hours', () => {
  const records = buildRecords([...ENTRIES].reverse(), validateProfile(PROFILE));
  assert.equal(records.length, 3);
  const out = cells(fillTemplate(makeTemplate(), validateProfile(PROFILE), records, '2026-10'), 'Hours');
  assert.equal(out.A4, '46296'); // 2026-10-01
  assert.equal(out.B4, 'Alpha');
  assert.equal(out.C4, '2.5');
  assert.equal(out.C5, '1');
  assert.equal(out.A6, '46297');
  assert.equal(out.B1, '2026-10 (2026)');
});

test('groupBy sums per day and project and joins descriptions', () => {
  const profile = validateProfile({
    ...PROFILE,
    groupBy: ['date', 'project'],
    columns: [...PROFILE.columns, { col: 'D', field: 'description' }],
  });
  const records = buildRecords(ENTRIES, profile);
  assert.equal(records.length, 2);
  const out = cells(fillTemplate(makeTemplate(), profile, records, '2026-10'), 'Hours');
  assert.equal(out.C4, '3.5');
  assert.equal(out.D4, 'Alpha work; Alpha review');
  assert.equal(out.D5, 'Beta <&> work');
});

test('template styles are applied to every written row and the Rules sheet is removed', () => {
  const profile = validateProfile(PROFILE);
  const buf = fillTemplate(makeTemplate(), profile, buildRecords(ENTRIES, profile), '2026-10');
  const wb = openWorkbook(buf);
  assert.deepEqual(wb.sheetNames(), ['Hours']);
  assert.equal(wb.styleOf('Hours', 'A6'), '1');
  assert.equal(wb.styleOf('Hours', 'C5'), '3');
});

test('previewRows shows readable values', () => {
  const profile = validateProfile({ ...PROFILE, columns: [{ col: 'A', field: 'date' }, { col: 'B', field: 'start' }, { col: 'C', field: 'hours' }] });
  assert.deepEqual(previewRows(buildRecords(ENTRIES, profile), profile)[0], '2026-10-01 | 08:00 | 2.5');
});

// ---- CLI ----
let dir;
let prevHome;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockify-export-'));
  prevHome = process.env.CLAUDE_CLOCKIFY_HOME;
  process.env.CLAUDE_CLOCKIFY_HOME = path.join(dir, 'home');
  fs.writeFileSync(path.join(dir, 'template.xlsx'), makeTemplate());
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(PROFILE));
});
after(() => {
  if (prevHome === undefined) delete process.env.CLAUDE_CLOCKIFY_HOME;
  else process.env.CLAUDE_CLOCKIFY_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { log: (l) => out.push(l), err: (l) => err.push(l) } };
};
const fakeClient = {
  getUser: async () => ({ id: 'u1', defaultWorkspace: 'ws1' }),
  listTimeEntries: async () => ENTRIES,
};

test('cli: run without a profile explains what to do', async () => {
  const c = capture();
  assert.equal(await main(['run'], c.io, { client: fakeClient }), 2);
  assert.match(c.err[0], /No export profile/);
});

test('cli: inspect prints both sheets', async () => {
  const c = capture();
  assert.equal(await main(['inspect', path.join(dir, 'template.xlsx')], c.io), 0);
  const text = c.out.join('\n');
  assert.match(text, /Sheets: Hours, Rules/);
  assert.match(text, /A1: Start at row 4/);
});

test('cli: save-profile, dry-run and export end to end', async () => {
  let c = capture();
  assert.equal(await main(['save-profile', path.join(dir, 'profile.json'), '--template', path.join(dir, 'template.xlsx')], c.io), 0);
  const mode = fs.statSync(path.join(dir, 'home', 'export-profile.json')).mode & 0o777;
  assert.equal(mode, 0o600);

  c = capture();
  assert.equal(await main(['run', '--month', '2026-10', '--dry-run'], c.io, { client: fakeClient }), 0);
  assert.match(c.out[0], /3 entries -> 3 rows, 4.50 h/);
  assert.equal(c.out[1], '2026-10-01 | Alpha | 2.5');

  c = capture();
  const outFile = path.join(dir, 'out.xlsx');
  assert.equal(await main(['run', '--month', '2026-10', '--out', outFile], c.io, { client: fakeClient }), 0);
  assert.equal(cells(fs.readFileSync(outFile), 'Hours').B6, 'Beta');
});

test('cli: a changed template invalidates the profile', async () => {
  fs.appendFileSync(path.join(dir, 'template.xlsx'), Buffer.from([0]));
  const c = capture();
  assert.equal(await main(['run', '--month', '2026-10'], c.io, { client: fakeClient }), 3);
  assert.match(c.err[0], /template changed/);
});
