import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords, fillTemplate, validateProfile, previewTable, profileColumns, rowCount, expandMeta } from '../core/export.js';
import { openWorkbook } from '../xlsx/workbook.js';
import { readZip } from '../xlsx/zip.js';
import { makeDayTemplate } from './helpers/make-template.js';

const PROFILE = {
  layout: 'perDay',
  sheet: 'Attendance',
  firstDayRow: 13,
  dayColumns: [
    { col: 'C', field: 'morningIn' }, { col: 'D', field: 'morningOut' },
    { col: 'F', field: 'afternoonIn' }, { col: 'G', field: 'afternoonOut' },
    { col: 'K', field: 'note' },
  ],
  splitTime: '13:00',
  tagRules: [
    { tag: 'Leave', note: 'Leave', blankTimes: true },
    { tag: 'Sick', note: 'Sick', blankTimes: true },
    { tag: 'Permit', note: '{{hours}}H Permit' },
  ],
  holidays: { note: 'HOLIDAY', fill: { from: 'A', to: 'P', rgb: 'C0C0C0' } },
  meta: [
    { cell: 'S1', value: '{{monthNumber}}' },
    { cell: 'P9', value: '{{year}}' },
    { cell: 'E9', value: 'Jane Doe' },
  ],
};
const E = (start, end, tags = [], extra = {}) => ({ start, end, description: 'x', project: 'P', task: '', tags, ...extra });
const ENTRIES = [
  E('2026-09-07T09:00:00', '2026-09-07T12:30:00'), // Monday: morning + afternoon
  E('2026-09-07T14:00:00', '2026-09-07T18:15:00'),
  E('2026-09-07T10:00:00', '2026-09-07T10:30:00'), // inside the morning range
  E('2026-09-08T09:00:00', '2026-09-08T17:00:00'), // spans the split
  E('2026-09-09T09:00:00', '2026-09-09T17:00:00', ['leave']), // absence, case-insensitive
  E('2026-09-10T08:00:00', '2026-09-10T11:30:00'),
  E('2026-09-10T11:30:00', '2026-09-10T13:00:00', ['Permit']), // permit on a worked day
  E('2026-09-12T09:00:00', '2026-09-12T11:00:00'), // Saturday worked
];

const cells = (buf) => Object.fromEntries(openWorkbook(buf).readCells('Attendance').map((c) => [c.ref, c.value]));
const clock = (h, m = 0) => String(((h * 60 + m) / 1440));

test('validateProfile accepts perDay and rejects bad ones', () => {
  assert.equal(validateProfile(PROFILE).splitTime, '13:00');
  assert.throws(() => validateProfile({ ...PROFILE, firstDayRow: 0 }), /firstDayRow/);
  assert.throws(() => validateProfile({ ...PROFILE, dayColumns: [{ col: 'C', field: 'hours' }] }), /unknown day field/);
  assert.throws(() => validateProfile({ ...PROFILE, splitTime: '25:00' }), /splitTime/);
  assert.throws(() => validateProfile({ ...PROFILE, holidays: { note: '' } }), /holidays.note/);
  assert.throws(() => validateProfile({ ...PROFILE, tagRules: [{ tag: 'a' }] }), /tag rule/);
});

test('times are deduced per day, clipped at the split time', () => {
  const profile = validateProfile(PROFILE);
  const days = buildRecords(ENTRIES, profile, '2026-09');
  assert.equal(days.length, 30);
  const d7 = days[6];
  assert.deepEqual([d7.morning.in, d7.morning.out, d7.afternoon.in, d7.afternoon.out], [540, 750, 840, 1095]);
  const d8 = days[7];
  assert.deepEqual([d8.morning.in, d8.morning.out, d8.afternoon.in, d8.afternoon.out], [540, 780, 780, 1020]);
});

test('absence tags blank the times and write the note; permit keeps the worked times', () => {
  const profile = validateProfile(PROFILE);
  const days = buildRecords(ENTRIES, profile, '2026-09');
  const d9 = days[8];
  assert.equal(d9.note, 'Leave');
  assert.equal(d9.morning, null);
  assert.equal(d9.ms, 0);
  const d10 = days[9];
  assert.equal(d10.note, '1.5H Permit');
  assert.deepEqual([d10.morning.in, d10.morning.out], [480, 690]);
  assert.equal(d10.afternoon, null);
});

test('holiday: empty past weekday gets blank row, note and grey fill; not weekends, worked days or future days', () => {
  const profile = validateProfile(PROFILE);
  const apr = buildRecords([E('2026-04-07T09:00:00', '2026-04-07T10:00:00')], profile, '2026-04');
  assert.equal(apr[5].holiday, true); // Monday April 6, nothing tracked
  assert.equal(apr[5].note, 'HOLIDAY');
  assert.equal(apr[6].holiday, false); // worked
  assert.equal(apr[2].holiday, true); // Friday April 3
  assert.equal(apr[3].holiday, false); // Saturday April 4: already grey, no note
  assert.equal(apr[3].note, '');
  assert.equal(apr[5].morning, null);
  const future = buildRecords([], profile, '2999-01');
  assert.equal(future.some((d) => d.holiday), false);

  const buf = fillTemplate(makeDayTemplate(), profile, apr, '2026-04');
  const wb = openWorkbook(buf);
  const grey = wb.styleOf('Attendance', 'A18'); // day 6 -> row 18
  assert.notEqual(grey, wb.styleOf('Attendance', 'A19'));
  assert.equal(wb.styleOf('Attendance', 'P18'), grey);
  assert.equal(cells(buf).K18, 'HOLIDAY');
});

test('fillTemplate writes the right rows, meta numbers, formats and clears the rest', () => {
  const profile = validateProfile(PROFILE);
  const out = cells(fillTemplate(makeDayTemplate(), profile, buildRecords(ENTRIES, profile, '2026-09'), '2026-09'));
  assert.equal(out.S1, '9');
  assert.equal(out.P9, '2026');
  assert.equal(out.E9, 'Jane Doe');
  assert.equal(Number(out.C19), Number(clock(9))); // day 7 -> row 19
  assert.equal(Number(out.G19), Number(clock(18, 15)));
  assert.equal(out.K21, 'Leave');
  assert.equal(out.K22, '1.5H Permit');
  assert.equal(out.C20 !== undefined, true);
  assert.equal(out.C13, undefined); // day 1: no entries, nothing written
  assert.equal(out.A13, undefined); // untouched columns stay as the template had them
});

test('time cells keep the template time format', () => {
  const profile = validateProfile(PROFILE);
  const wb = openWorkbook(fillTemplate(makeDayTemplate(), profile, buildRecords(ENTRIES, profile, '2026-09'), '2026-09'));
  assert.equal(wb.styleOf('Attendance', 'C19'), '1');
  assert.equal(wb.styleOf('Attendance', 'K19'), '0');
});

test('preview, columns and row count for perDay', () => {
  const profile = validateProfile(PROFILE);
  const days = buildRecords(ENTRIES, profile, '2026-09');
  assert.deepEqual(profileColumns(profile), ['day', 'morning', 'afternoon', 'note']);
  assert.equal(rowCount(days), 23); // 5 days with content + 18 empty weekdays (holidays)
  assert.deepEqual(previewTable(days, profile)[4], ['07/09', '09:00-12:30', '14:00-18:15', '']);
});

test('expandMeta numeric placeholders', () => {
  assert.equal(expandMeta('{{monthNumber}}', '2026-09'), 9);
  assert.equal(expandMeta('{{year}}', '2026-09'), 2026);
  assert.equal(expandMeta('{{month}} / {{monthNumber}}', '2026-09'), '2026-09 / 9');
  assert.equal(expandMeta(5, '2026-09'), 5);
});

const OVERTIME = 'IF(OR(WEEKDAY($A{row})=1,WEEKDAY($A{row})=7),$H{row},MAX(0,$H{row}-TIME(8,0,0)))';
const WEEKEND_CF = 'OR(WEEKDAY(A13)=1,WEEKDAY(A13)=7)';

test('formula columns are written per day row with {row} replaced and no cached value', () => {
  const profile = validateProfile({ ...PROFILE, dayColumns: [...PROFILE.dayColumns, { col: 'I', formula: OVERTIME }] });
  const out = cells(fillTemplate(makeDayTemplate(), profile, buildRecords(ENTRIES, profile, '2026-09'), '2026-09'));
  assert.equal(out.I13, `=${OVERTIME.replaceAll('{row}', '13')}`);
  assert.equal(out.I42, `=${OVERTIME.replaceAll('{row}', '42')}`);
  assert.equal(out.I43, undefined); // September has 30 days: row 43 (day 31) is left alone
  assert.throws(() => validateProfile({ ...PROFILE, dayColumns: [{ col: 'I', formula: 'A1', field: 'note' }] }), /either "field" or/);
});

test('conditionalFormulas rewrite the template rule; a rule that is not found fails loudly', () => {
  const to = `AND(${WEEKEND_CF},$H13=0)`;
  const profile = validateProfile({ ...PROFILE, conditionalFormulas: [{ from: WEEKEND_CF, to }] });
  const buf = fillTemplate(makeDayTemplate(), profile, buildRecords(ENTRIES, profile, '2026-09'), '2026-09');
  const xml = readZip(buf).get('xl/worksheets/sheet1.xml').toString();
  assert.ok(xml.includes(`<formula>${to}</formula>`));
  assert.ok(!xml.includes(`<formula>${WEEKEND_CF}</formula>`));
  const missing = validateProfile({ ...PROFILE, conditionalFormulas: [{ from: 'NOPE()', to: 'TRUE' }] });
  assert.throws(() => fillTemplate(makeDayTemplate(), missing, buildRecords(ENTRIES, missing, '2026-09'), '2026-09'), /No conditional format rule/);
});

test('{{monthName}} follows the profile locale and is capitalized', () => {
  assert.equal(expandMeta('{{monthName}}', '2026-09', 'it'), 'Settembre');
  assert.equal(expandMeta('{{monthName}} {{year}}', '2026-09'), 'September 2026');
  assert.throws(() => validateProfile({ ...PROFILE, locale: 'italian' }), /locale/);
});

test('cloneConditionalFormats copies a rule to a range that lacks it, before formulas are rewritten', () => {
  const to = `AND(${WEEKEND_CF},$H13=0)`;
  const profile = validateProfile({
    ...PROFILE,
    cloneConditionalFormats: [{ from: 'A13:A43', to: 'D13:D43' }],
    conditionalFormulas: [{ from: WEEKEND_CF, to }],
  });
  const buf = fillTemplate(makeDayTemplate(), profile, buildRecords(ENTRIES, profile, '2026-09'), '2026-09');
  const xml = readZip(buf).get('xl/worksheets/sheet1.xml').toString();
  assert.equal([...xml.matchAll(/<conditionalFormatting sqref="([^"]+)"/g)].map((m) => m[1]).join(','), 'A13:A43,D13:D43');
  assert.equal(xml.split(`<formula>${to}</formula>`).length - 1, 2); // both rules rewritten
  assert.deepEqual([...xml.matchAll(/priority="(\d+)"/g)].map((m) => m[1]), ['1', '2']);
  assert.throws(() => validateProfile({ ...PROFILE, cloneConditionalFormats: [{ from: 'A', to: 'B' }] }), /cloneConditionalFormats/);
});

test('messy week: overlaps count once, midnight is split, partial absence keeps worked times', () => {
  const days = buildRecords([
    E('2026-09-07T09:00:00', '2026-09-07T12:00:00'), E('2026-09-07T10:00:00', '2026-09-07T13:30:00'), // overlap
    E('2026-09-07T11:00:00', '2026-09-07T11:30:00'), // nested
    E('2026-09-08T22:00:00', '2026-09-09T02:00:00'), // crosses midnight
    E('2026-09-10T08:00:00', '2026-09-10T13:00:00'), E('2026-09-10T15:00:00', '2026-09-10T16:00:00', ['leave']),
  ], validateProfile(PROFILE), '2026-09');
  const d = (n) => days[n - 1];
  assert.equal(d(7).ms / 3600000, 4.5);
  assert.deepEqual(d(7).morning, { in: 540, out: 780 });
  assert.deepEqual(d(8).afternoon, { in: 1320, out: 1440 });
  assert.deepEqual(d(9).morning, { in: 0, out: 120 });
  assert.equal(d(9).ms / 3600000, 2);
  assert.deepEqual(d(10).morning, { in: 480, out: 780 });
  assert.equal(d(10).note, 'Leave');
});
