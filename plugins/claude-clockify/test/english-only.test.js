import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
const EXTS = new Set(['.js', '.html', '.css', '.md', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Built from fragments so this file never matches itself.
const ACCENTS = new RegExp(`[${['\u00e0', '\u00e8', '\u00e9', '\u00ec', '\u00f2', '\u00f9'].join('')}]`, 'i');
const LEGACY_STATUS = ['propost' + 'a', 'modificat' + 'a', 'inviat' + 'a', 'in ' + 'corso'];
const WORDS = [
  'vo' + 'ce', 'vo' + 'ci', 'inv' + 'ia', 'impostaz' + 'ioni', 'mappat' + 'ura', 'mappat' + 'ure', 'sess' + 'ione',
  'sog' + 'lia', 'err' + 'ore', 'prog' + 'etto', 'cart' + 'ella', 'salv' + 'ato', 'ripr' + 'ova', 'ades' + 'so',
  'chi' + 'udi', 'del' + 'la', 'att' + 'ivit', 'svil' + 'uppo', 'anal' + 'isi',
  ...LEGACY_STATUS,
];
const WORD_RE = new RegExp(`\\b(?:${WORDS.join('|')})\\b`, 'i');
const LEGACY_RE = new RegExp(`\\b(?:${LEGACY_STATUS.join('|')})\\b`, 'i');
const WORD_ONLY_RE = new RegExp(`\\b(?:${WORDS.filter((w) => !LEGACY_STATUS.includes(w)).join('|')})\\b`, 'i');
// The defensive status migration (and its test) must name the legacy values; nothing else may.
const LEGACY_ALLOWED = new Set(['core/db.js', 'test/db.test.js']);

function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) yield* walk(path.join(dir, d.name));
    } else if (EXTS.has(path.extname(d.name))) {
      yield path.join(dir, d.name);
    }
  }
}

test('plugin sources, UI and docs are English only', () => {
  const hits = [];
  let scanned = 0;
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel === SELF.split(path.sep).join('/')) continue;
    scanned += 1;
    const legacyOk = LEGACY_ALLOWED.has(rel);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const bad = ACCENTS.test(line) || (legacyOk ? WORD_ONLY_RE.test(line) : WORD_RE.test(line));
      if (bad) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.ok(scanned > 20, `scanned only ${scanned} files`);
  assert.deepEqual(hits, [], `Italian text found:\n${hits.join('\n')}`);
});

test('the guard regexes catch what they are meant to catch', () => {
  assert.ok(WORD_RE.test(`la ${'vo' + 'ce'} del giorno`));
  assert.ok(LEGACY_RE.test(`status '${'propost' + 'a'}'`));
  assert.ok(ACCENTS.test(`gi${'\u00e0'}`));
  assert.ok(!WORD_RE.test('the voice of reason, error, invoice, session, adessor'));
});
