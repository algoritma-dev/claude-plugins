import test from 'node:test';
import assert from 'node:assert/strict';
import { readZip, writeZip } from '../xlsx/zip.js';
import { openWorkbook } from '../xlsx/workbook.js';
import { makeTemplate } from './helpers/make-template.js';

test('zip round trip keeps names, order and content', () => {
  const files = new Map([['a.txt', Buffer.from('hello')], ['dir/b.bin', Buffer.alloc(5000, 7)], ['caf\u00c4.txt', Buffer.from('x')]]);
  const back = readZip(writeZip(files));
  assert.deepEqual([...back.keys()], [...files.keys()]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
});

test('readZip rejects non-zip data', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely')), /Not a zip/);
});

test('readCells resolves shared strings and formulas', () => {
  const wb = openWorkbook(makeTemplate());
  assert.deepEqual(wb.sheetNames(), ['Hours', 'Rules']);
  const hours = wb.readCells('Hours');
  assert.deepEqual(hours.map((c) => c.ref), ['A1', 'A3', 'B3', 'C3', 'B30']);
  assert.equal(hours[0].value, 'Month');
  assert.equal(hours.at(-1).value, '=SUM(C4:C29)');
  assert.equal(wb.readCells('Rules')[0].value, 'Start at row 4. One row per day and project & sum the hours.');
});

test('setCell keeps styles, escapes text and survives a reload', () => {
  const wb = openWorkbook(makeTemplate());
  wb.setCell('Hours', 'A4', 46000, wb.styleOf('Hours', 'A4'));
  wb.setCell('Hours', 'B4', 'A <&> "B"', wb.styleOf('Hours', 'B4'));
  wb.setCell('Hours', 'D5', 1.5); // new cell in a new row
  const again = openWorkbook(wb.toBuffer());
  const byRef = Object.fromEntries(again.readCells('Hours').map((c) => [c.ref, c.value]));
  assert.equal(byRef.A4, '46000');
  assert.equal(byRef.B4, 'A <&> "B"');
  assert.equal(byRef.D5, '1.5');
  assert.equal(again.styleOf('Hours', 'A4'), '1');
  assert.equal(again.styleOf('Hours', 'B4'), '2');
});

test('toBuffer drops the calc chain and requests a recalculation', () => {
  const wb = openWorkbook(makeTemplate());
  wb.setCell('Hours', 'A4', 1);
  const files = readZip(wb.toBuffer());
  assert.equal(files.has('xl/calcChain.xml'), false);
  assert.ok(!/calcChain/.test(files.get('[Content_Types].xml').toString()));
  assert.ok(!/calcChain/.test(files.get('xl/_rels/workbook.xml.rels').toString()));
  assert.match(files.get('xl/workbook.xml').toString(), /<calcPr fullCalcOnLoad="1"\/>/);
});

test('removeSheets deletes the sheet everywhere and resets the active tab', () => {
  const wb = openWorkbook(makeTemplate());
  wb.removeSheets(['Rules']);
  const files = readZip(wb.toBuffer());
  assert.equal(files.has('xl/worksheets/sheet2.xml'), false);
  assert.ok(!/Rules/.test(files.get('xl/workbook.xml').toString()));
  assert.match(files.get('xl/workbook.xml').toString(), /activeTab="0"/);
  assert.deepEqual(openWorkbook(wb.toBuffer()).sheetNames(), ['Hours']);
});

test('unknown sheet gives a helpful error', () => {
  assert.throws(() => openWorkbook(makeTemplate()).readCells('Nope'), /Sheet "Nope" not found \(sheets: Hours, Rules\)/);
});

test('toBuffer drops cached formula results of edited sheets', () => {
  const wb = openWorkbook(makeTemplate());
  wb.setCell('Hours', 'A4', 1);
  const xml = readZip(wb.toBuffer()).get('xl/worksheets/sheet1.xml').toString();
  assert.match(xml, /<f>SUM\(C4:C29\)<\/f><\/c>/);
});
