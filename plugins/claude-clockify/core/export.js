// Monthly export of Clockify entries into a user-supplied .xlsx template, driven by a saved profile.
import crypto from 'node:crypto';
import { openWorkbook } from '../xlsx/workbook.js';
import { buildDays, fillDays, previewDays, validateDayProfile } from './export-day.js';

export const FIELDS = ['date', 'start', 'end', 'hours', 'minutes', 'duration', 'project', 'task', 'description', 'tags'];
const GROUPABLE = new Set(['date', 'project', 'task', 'description']);

export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`Invalid month "${month}" (expected YYYY-MM)`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}

export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const hashBuffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const isRef = (x) => typeof x === 'string' && /^[A-Z]{1,3}[1-9]\d*$/.test(x);

/** Validates a profile and returns it normalized; throws with a precise message otherwise. */
export function validateProfile(p) {
  if (p !== null && typeof p === 'object' && p.layout === 'perDay') return validateDayProfile(p);
  const fail = (msg) => {
    throw new Error(`Invalid export profile: ${msg}`);
  };
  if (p === null || typeof p !== 'object') fail('not an object');
  if (typeof p.sheet !== 'string' || !p.sheet) fail('"sheet" (name of the sheet to fill) is required');
  if (!Number.isInteger(p.startRow) || p.startRow < 1) fail('"startRow" must be a positive integer');
  if (!Array.isArray(p.columns) || p.columns.length === 0) fail('"columns" must be a non-empty array');
  for (const c of p.columns) {
    if (!c || !/^[A-Z]{1,3}$/.test(c.col ?? '')) fail(`column letter invalid: ${JSON.stringify(c)}`);
    if (!FIELDS.includes(c.field)) fail(`unknown field "${c.field}" (allowed: ${FIELDS.join(', ')})`);
  }
  const groupBy = p.groupBy ?? null;
  if (groupBy !== null) {
    if (!Array.isArray(groupBy) || groupBy.length === 0 || groupBy.some((g) => !GROUPABLE.has(g))) {
      fail(`"groupBy" must be a non-empty array of: ${[...GROUPABLE].join(', ')}`);
    }
    for (const c of p.columns) {
      if (!GROUPABLE.has(c.field) && !['hours', 'minutes', 'duration'].includes(c.field)) {
        fail(`field "${c.field}" cannot be used with "groupBy" (use date, project, task, description, hours, minutes, duration)`);
      }
    }
  }
  const meta = p.meta ?? [];
  if (!Array.isArray(meta) || meta.some((m) => !isRef(m?.cell) || !['string', 'number'].includes(typeof m.value))) {
    fail('"meta" must be an array of { cell: "B1", value: "text with {{month}}" }');
  }
  const removeSheets = p.removeSheets ?? [];
  if (!Array.isArray(removeSheets) || removeSheets.some((s) => typeof s !== 'string')) fail('"removeSheets" must be an array of names');
  if (removeSheets.includes(p.sheet)) fail('"removeSheets" cannot contain the sheet to fill');
  return { ...p, groupBy, meta, removeSheets };
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Excel serial dates count days from 1899-12-30; local wall-clock components are used on purpose.
const excelDate = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 25569;
const excelTime = (d) => (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
const round2 = (n) => Math.round(n * 100) / 100;

function toRecord(e) {
  const start = new Date(e.start);
  const end = new Date(e.end);
  return { start, end, ms: end - start, project: e.project, task: e.task, description: e.description, tags: e.tags ?? [] };
}

const CELL = {
  date: (r) => excelDate(r.start),
  start: (r) => excelTime(r.start),
  end: (r) => excelTime(r.end),
  hours: (r) => round2(r.ms / 3600000),
  minutes: (r) => Math.round(r.ms / 60000),
  duration: (r) => r.ms / 86400000,
  project: (r) => r.project,
  task: (r) => r.task,
  description: (r) => r.description,
  tags: (r) => r.tags.join(', '),
};

/** Entries -> sorted records, optionally aggregated by the profile's groupBy fields. */
export function buildRecords(entries, profile, month) {
  if (profile.layout === 'perDay') return buildDays(entries, profile, month);
  const records = entries.map(toRecord).sort((a, b) => a.start - b.start);
  if (!profile.groupBy) return records;
  const keyOf = (r) => profile.groupBy.map((g) => (g === 'date' ? localDate(r.start) : r[g])).join('\u0001');
  const groups = new Map();
  for (const r of records) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { ...r, descs: r.description ? [r.description] : [] });
    } else {
      g.ms += r.ms;
      g.end = r.end > g.end ? r.end : g.end;
      if (r.description && !g.descs.includes(r.description)) g.descs.push(r.description);
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    description: profile.groupBy.includes('description') ? g.description : g.descs.join('; '),
  }));
}

/** Placeholders: {{month}} (YYYY-MM), {{year}}, {{monthNumber}}, {{monthName}} (capitalized, profile `locale`). A value that is exactly a numeric placeholder becomes a number. */
export function expandMeta(value, month, locale = 'en') {
  if (typeof value === 'number') return value;
  if (value === '{{year}}') return Number(month.slice(0, 4));
  if (value === '{{monthNumber}}') return Number(month.slice(5));
  return value
    .replace(/\{\{month\}\}/g, month)
    .replace(/\{\{year\}\}/g, month.slice(0, 4))
    .replace(/\{\{monthNumber\}\}/g, String(Number(month.slice(5))))
    .replace(/\{\{monthName\}\}/g, () => {
      const name = new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1));
      return name.charAt(0).toUpperCase() + name.slice(1);
    });
}

/** Fills the template with the records; returns the new .xlsx buffer. */
export function fillTemplate(templateBuf, profile, records, month) {
  const wb = openWorkbook(templateBuf);
  const { sheet, startRow, columns, meta } = profile;
  wb.sheetNames(); // throws on a broken workbook
  if (profile.layout === 'perDay') {
    fillDays(wb, profile, records);
    for (const m of meta) wb.setCell(sheet, m.cell, expandMeta(m.value, month, profile.locale));
    if (profile.removeSheets.length > 0) wb.removeSheets(profile.removeSheets);
    return wb.toBuffer();
  }
  const styles = columns.map((c) => wb.styleOf(sheet, `${c.col}${startRow}`));
  records.forEach((r, i) => {
    columns.forEach((c, j) => wb.setCell(sheet, `${c.col}${startRow + i}`, CELL[c.field](r), styles[j]));
  });
  for (const m of meta) wb.setCell(sheet, m.cell, expandMeta(m.value, month));
  if (profile.removeSheets.length > 0) wb.removeSheets(profile.removeSheets);
  return wb.toBuffer();
}

const PREVIEW = {
  ...CELL,
  date: (r) => localDate(r.start),
  start: (r) => `${pad(r.start.getHours())}:${pad(r.start.getMinutes())}`,
  end: (r) => `${pad(r.end.getHours())}:${pad(r.end.getMinutes())}`,
};

/** Readable cell values of the first rows, one array per row (what the export would write). */
export function previewTable(records, profile, limit = 15) {
  if (profile.layout === 'perDay') return previewDays(records, limit);
  return records.slice(0, limit).map((r) => profile.columns.map((c) => String(PREVIEW[c.field](r))));
}

/** Plain-text preview of the first rows, for the confirmation step. */
export function previewRows(records, profile, limit = 15) {
  return previewTable(records, profile, limit).map((cells) => cells.join(' | '));
}

/** Column labels of the preview table. */
export function profileColumns(profile) {
  return profile.layout === 'perDay' ? ['day', 'morning', 'afternoon', 'note'] : profile.columns.map((c) => c.field);
}

/** Rows that would actually carry data (per-day layouts always have one record per day). */
export function rowCount(records) {
  return records.filter((r) => r.hasContent !== false).length;
}
