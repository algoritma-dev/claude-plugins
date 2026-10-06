// "perDay" layout: one fixed row per day of the month (row = firstDayRow + day - 1), as in attendance sheets.
// Times are deduced from the Clockify entries; tags can mark absences (leave, sick, permit) that replace them.
import { colToNum, numToCol } from '../xlsx/workbook.js';

export const DAY_FIELDS = ['morningIn', 'morningOut', 'afternoonIn', 'afternoonOut', 'note'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COL_RE = /^[A-Z]{1,3}$/;
const pad = (n) => String(n).padStart(2, '0');

export function validateDayProfile(p) {
  const fail = (msg) => {
    throw new Error(`Invalid export profile: ${msg}`);
  };
  if (typeof p.sheet !== 'string' || !p.sheet) fail('"sheet" is required');
  if (!Number.isInteger(p.firstDayRow) || p.firstDayRow < 1) fail('"firstDayRow" must be a positive integer');
  if (!Array.isArray(p.dayColumns) || p.dayColumns.length === 0) fail('"dayColumns" must be a non-empty array');
  for (const c of p.dayColumns) {
    if (!COL_RE.test(c?.col ?? '')) fail(`column letter invalid: ${JSON.stringify(c)}`);
    if (c.formula !== undefined) {
      if (typeof c.formula !== 'string' || !c.formula || c.field !== undefined) {
        fail(`column ${c.col}: use either "field" or a non-empty "formula" string`);
      }
    } else if (!DAY_FIELDS.includes(c.field)) {
      fail(`unknown day field "${c.field}" (allowed: ${DAY_FIELDS.join(', ')})`);
    }
  }
  const conditionalFormulas = p.conditionalFormulas ?? [];
  if (!Array.isArray(conditionalFormulas)
    || conditionalFormulas.some((r) => typeof r?.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to)) {
    fail('"conditionalFormulas" must be an array of { from, to } formula strings');
  }
  const cloneConditionalFormats = p.cloneConditionalFormats ?? [];
  const RANGE_RE = /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/;
  if (!Array.isArray(cloneConditionalFormats)
    || cloneConditionalFormats.some((r) => !RANGE_RE.test(r?.from ?? '') || !RANGE_RE.test(r?.to ?? ''))) {
    fail('"cloneConditionalFormats" must be an array of { from: "C13:C43", to: "D13:D43" }');
  }
  if (p.locale !== undefined && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(p.locale)) fail('"locale" must be a language tag such as "it"');
  const splitTime = p.splitTime ?? '13:00';
  if (!TIME_RE.test(splitTime)) fail('"splitTime" must be HH:MM');
  const tagRules = p.tagRules ?? [];
  if (!Array.isArray(tagRules)) fail('"tagRules" must be an array');
  for (const r of tagRules) {
    if (typeof r?.tag !== 'string' || !r.tag || typeof r.note !== 'string') fail('each tag rule needs "tag" and "note"');
    if (r.blankTimes !== undefined && typeof r.blankTimes !== 'boolean') fail('"blankTimes" must be a boolean');
  }
  let holidays = p.holidays ?? null;
  if (holidays !== null) {
    if (typeof holidays.note !== 'string' || !holidays.note) fail('holidays.note is required');
    const f = holidays.fill ?? null;
    if (f !== null && (!COL_RE.test(f?.from ?? '') || !COL_RE.test(f?.to ?? '') || !/^[0-9A-Fa-f]{6}$/.test(f?.rgb ?? ''))) {
      fail('holidays.fill must be { from: "A", to: "P", rgb: "C0C0C0" }');
    }
    holidays = { ...holidays, fill: f };
  }
  const meta = p.meta ?? [];
  if (!Array.isArray(meta) || meta.some((m) => !/^[A-Z]{1,3}[1-9]\d*$/.test(m?.cell ?? '') || !['string', 'number'].includes(typeof m.value))) {
    fail('"meta" must be an array of { cell: "B1", value: "text, number or {{month}}/{{monthNumber}}/{{monthName}}/{{year}}" }');
  }
  const removeSheets = p.removeSheets ?? [];
  if (!Array.isArray(removeSheets) || removeSheets.some((s) => typeof s !== 'string')) fail('"removeSheets" must be an array of names');
  if (removeSheets.includes(p.sheet)) fail('"removeSheets" cannot contain the sheet to fill');
  return { ...p, splitTime, tagRules, holidays, conditionalFormulas, cloneConditionalFormats, meta, removeSheets };
}

const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
const clockSerial = (min) => Math.round(min) / 1440;
const hhmm = (min) => `${pad(Math.floor(Math.round(min) / 60))}:${pad(Math.round(min) % 60)}`;
const hoursText = (h) => String(Math.round(h * 100) / 100);

/** One record per day of the month: worked time, deduced times, note and whether the row is a holiday. */
export function buildDays(entries, profile, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const split = Number(profile.splitTime.slice(0, 2)) * 60 + Number(profile.splitTime.slice(3));
  const rules = profile.tagRules.map((r) => ({ ...r, tag: r.tag.toLowerCase() }));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // An entry crossing midnight is cut at midnight: each day gets its own part.
  const byDay = new Map();
  const add = (start, end, tags) => {
    const arr = byDay.get(start.getDate()) ?? [];
    arr.push({ start, end, tags });
    byDay.set(start.getDate(), arr);
  };
  for (const e of entries) {
    const tags = (e.tags ?? []).map((t) => t.toLowerCase());
    const end = new Date(e.end);
    let start = new Date(e.start);
    if (!(end > start)) continue;
    while (start < end) {
      const nextMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      const partEnd = end < nextMidnight ? end : nextMidnight;
      if (start.getFullYear() === y && start.getMonth() + 1 === m) add(start, partEnd, tags);
      start = nextMidnight;
    }
  }

  const days = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(y, m - 1, day);
    const list = byDay.get(day) ?? [];
    const absences = new Map(); // rule -> hours
    const work = [];
    for (const e of list) {
      const rule = rules.find((r) => e.tags.includes(r.tag));
      if (rule) absences.set(rule, (absences.get(rule) ?? 0) + (e.end - e.start) / 3600000);
      else work.push(e);
    }

    let morning = null;
    let afternoon = null;
    let ms = 0;
    let coveredTo = 0;
    for (const e of [...work].sort((a, b) => a.start - b.start)) {
      // overlapping entries count once
      const from = Math.max(e.start.getTime(), coveredTo);
      if (e.end.getTime() > from) {
        ms += e.end.getTime() - from;
        coveredTo = e.end.getTime();
      }
    }
    for (const e of work) {
      const s = minutesOfDay(e.start);
      const en = s + (e.end - e.start) / 60000;
      if (s < split) {
        const out = Math.min(en, split);
        morning = { in: Math.min(morning?.in ?? s, s), out: Math.max(morning?.out ?? out, out) };
      }
      if (en > split) {
        const inn = Math.max(s, split);
        afternoon = { in: Math.min(afternoon?.in ?? inn, inn), out: Math.max(afternoon?.out ?? en, en) };
      }
    }

    const notes = [];
    let blank = false;
    for (const rule of rules) {
      if (!absences.has(rule)) continue;
      notes.push(rule.note.replace(/\{\{hours\}\}/g, hoursText(absences.get(rule))));
      if (rule.blankTimes && work.length === 0) blank = true;
    }
    let holiday = false;
    // A past weekday with nothing in Clockify can only be a holiday.
    if (profile.holidays && work.length === 0 && notes.length === 0 && date.getDay() !== 0 && date.getDay() !== 6
      && date < today) {
      holiday = true;
      notes.push(profile.holidays.note);
      blank = true;
    }
    if (blank) {
      morning = null;
      afternoon = null;
    }
    days.push({
      day, date, ms, morning, afternoon, note: notes.join('; '), holiday,
      hasContent: ms > 0 || notes.length > 0,
    });
  }
  return days;
}

const VALUE = {
  morningIn: (d) => (d.morning ? clockSerial(d.morning.in) : null),
  morningOut: (d) => (d.morning ? clockSerial(d.morning.out) : null),
  afternoonIn: (d) => (d.afternoon ? clockSerial(d.afternoon.in) : null),
  afternoonOut: (d) => (d.afternoon ? clockSerial(d.afternoon.out) : null),
  note: (d) => (d.note === '' ? null : d.note),
};

/** Writes the days into the sheet. Cells not covered by a day are left untouched. */
export function fillDays(wb, profile, days) {
  const { sheet, firstDayRow, dayColumns, holidays } = profile;
  for (const r of profile.cloneConditionalFormats) wb.cloneConditionalFormat(sheet, r.from, r.to);
  for (const r of profile.conditionalFormulas) {
    if (wb.replaceConditionalFormula(sheet, r.from, r.to) === 0) {
      throw new Error(`No conditional format rule with the formula "${r.from}": the template changed, regenerate the profile`);
    }
  }
  for (const d of days) {
    const row = firstDayRow + d.day - 1;
    for (const c of dayColumns) {
      const ref = `${c.col}${row}`;
      if (c.formula) wb.setFormula(sheet, ref, c.formula.replace(/\{row\}/g, String(row)));
      else wb.setCell(sheet, ref, VALUE[c.field](d));
    }
    if (d.holiday && holidays.fill) {
      const { from, to, rgb } = holidays.fill;
      for (let n = colToNum(from); n <= colToNum(to); n++) {
        const ref = `${numToCol(n)}${row}`;
        wb.setStyle(sheet, ref, wb.deriveFillStyle(wb.styleOf(sheet, ref), rgb.toUpperCase()));
      }
    }
  }
}

export function previewDays(days, limit = 31) {
  const span = (x) => (x ? `${hhmm(x.in)}-${hhmm(x.out)}` : '');
  return days.filter((d) => d.hasContent).slice(0, limit)
    .map((d) => [`${pad(d.date.getDate())}/${pad(d.date.getMonth() + 1)}`, span(d.morning), span(d.afternoon), d.note]);
}
