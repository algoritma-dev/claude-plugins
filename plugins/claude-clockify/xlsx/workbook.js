// Reads and edits the cells of an .xlsx workbook in place: only the touched sheet XML changes, so styles,
// column widths, merged cells and the rest of the template are preserved.
import { readZip, writeZip } from './zip.js';

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
// eslint-disable-next-line no-control-regex
const escapeXml = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function attrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

export function colToNum(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: m[1].toUpperCase(), row: Number(m[2]) };
}

const text = (files, name) => {
  const buf = files.get(name);
  return buf ? buf.toString('utf8') : null;
};

function sharedStrings(files) {
  const xml = text(files, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join(''));
}

function sheetList(files) {
  const wb = text(files, 'xl/workbook.xml');
  const rels = text(files, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('Not an .xlsx workbook (workbook.xml missing)');
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    target.set(a.Id, a.Target);
  }
  return [...wb.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => {
    const a = attrs(m[1]);
    const t = target.get(a['r:id']);
    if (!t) throw new Error(`Sheet "${a.name}" has no relationship target`);
    const file = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    return { name: a.name, rid: a['r:id'], file };
  });
}

function parseSheet(xml) {
  const sd = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sd) throw new Error('Sheet has no sheetData');
  const rows = [];
  for (const r of (sd[1] ?? '').matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const a = attrs(r[1]);
    const cells = [];
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      cells.push({ attrs: attrs(c[1]), inner: c[2] ?? '' });
    }
    rows.push({ attrs: a, rawAttrs: r[1], cells, num: Number(a.r) });
  }
  return { sd, rows };
}

function cellValue(cell, shared) {
  const t = cell.attrs.t;
  const f = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell.inner);
  if (f) return f[1] ? `=${decode(f[1])}` : '=(shared formula)';
  if (t === 's') return shared[Number(/<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1])] ?? '';
  if (t === 'inlineStr') return [...cell.inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
  const v = /<v>([\s\S]*?)<\/v>/.exec(cell.inner);
  return v ? decode(v[1]) : '';
}

function serializeRow(row) {
  const attrStr = Object.entries(row.attrs).filter(([k]) => k !== 'spans').map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
  const cells = row.cells.map((c) => {
    const a = Object.entries(c.attrs).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
    return c.inner === '' ? `<c ${a}/>` : `<c ${a}>${c.inner}</c>`;
  });
  return cells.length === 0 ? `<row ${attrStr}/>` : `<row ${attrStr}>${cells.join('')}</row>`;
}

export function openWorkbook(buf) {
  const files = readZip(buf);
  const sheets = sheetList(files);
  const shared = sharedStrings(files);
  const parsed = new Map(); // sheet name -> { sd, rows, xml }

  function sheet(name) {
    const info = sheets.find((s) => s.name === name);
    if (!info) throw new Error(`Sheet "${name}" not found (sheets: ${sheets.map((s) => s.name).join(', ')})`);
    if (!parsed.has(name)) {
      const xml = text(files, info.file);
      if (xml === null) throw new Error(`Sheet file ${info.file} missing`);
      parsed.set(name, { ...parseSheet(xml), xml, info });
    }
    return parsed.get(name);
  }

  function getRow(sh, num, create) {
    let idx = sh.rows.findIndex((r) => r.num >= num);
    if (idx >= 0 && sh.rows[idx].num === num) return sh.rows[idx];
    if (!create) return null;
    const row = { attrs: { r: String(num) }, rawAttrs: '', cells: [], num };
    if (idx < 0) idx = sh.rows.length;
    sh.rows.splice(idx, 0, row);
    return row;
  }

  const derived = new Map();

  function ensureCell(sh, ref) {
    const { col, row } = splitRef(ref);
    const r = getRow(sh, row, true);
    const colNum = colToNum(col);
    let idx = r.cells.findIndex((c) => colToNum(splitRef(c.attrs.r).col) >= colNum);
    if (idx >= 0 && splitRef(r.cells[idx].attrs.r).col === col) return r.cells[idx];
    const cell = { attrs: { r: `${col}${row}` }, inner: '' };
    if (idx < 0) idx = r.cells.length;
    r.cells.splice(idx, 0, cell);
    return cell;
  }

  return {
    sheetNames: () => sheets.map((s) => s.name),

    /** Non-empty cells of a sheet as [{ ref, value }] (formulas as "=..."). */
    readCells(name) {
      const sh = sheet(name);
      const out = [];
      for (const row of sh.rows) {
        for (const c of row.cells) {
          const value = cellValue(c, shared);
          if (value !== '') out.push({ ref: c.attrs.r, value });
        }
      }
      return out;
    },

    /** Style index (s attribute) of a cell, or null. */
    styleOf(name, ref) {
      const { col, row } = splitRef(ref);
      const r = getRow(sheet(name), row, false);
      return r?.cells.find((c) => splitRef(c.attrs.r).col === col)?.attrs.s ?? null;
    },

    /** Sets a cell to a number or string. `style` (s index) overrides; otherwise the existing style is kept. */
    setCell(name, ref, value, style = null) {
      const cell = ensureCell(sheet(name), ref);
      const keep = { r: cell.attrs.r };
      const s = style ?? cell.attrs.s;
      if (s != null) keep.s = String(s);
      cell.attrs = keep;
      if (value === null || value === undefined || value === '') {
        cell.inner = '';
      } else if (typeof value === 'number') {
        cell.inner = `<v>${value}</v>`;
      } else {
        cell.attrs.t = 'inlineStr';
        cell.inner = `<is><t xml:space="preserve">${escapeXml(value)}</t></is>`;
      }
    },

    /** Sets a formula (without the leading "="); the cached result is left empty so readers recalculate. */
    setFormula(name, ref, formula, style = null) {
      const cell = ensureCell(sheet(name), ref);
      const keep = { r: cell.attrs.r };
      const s = style ?? cell.attrs.s;
      if (s != null) keep.s = String(s);
      cell.attrs = keep;
      cell.inner = `<f>${escapeXml(formula.replace(/^=/, ''))}</f>`;
    },

    /**
     * Rewrites the formula of every conditional-format rule that equals `from` (compared as written in the
     * file). Returns the number of rules changed.
     */
    replaceConditionalFormula(name, from, to) {
      const sh = sheet(name);
      let n = 0;
      sh.xml = sh.xml.replace(/<formula>([\s\S]*?)<\/formula>/g, (whole, body) => {
        if (decode(body) !== from) return whole;
        n += 1;
        return `<formula>${escapeXml(to)}</formula>`;
      });
      return n;
    },

    /** Copies the conditional-format rules of range `from` onto range `to` (same formula text and style). */
    cloneConditionalFormat(name, from, to) {
      const sh = sheet(name);
      const re = new RegExp(`<conditionalFormatting\\b[^>]*sqref="${from}"[^>]*>[\\s\\S]*?</conditionalFormatting>`);
      const block = re.exec(sh.xml);
      if (!block) throw new Error(`No conditional format on ${from}`);
      const top = Math.max(0, ...[...sh.xml.matchAll(/\bpriority="(\d+)"/g)].map((m) => Number(m[1])));
      let n = top;
      const copy = block[0]
        .replace(/sqref="[^"]*"/, `sqref="${to}"`)
        .replace(/\bpriority="\d+"/g, () => `priority="${++n}"`);
      sh.xml = sh.xml.replace(block[0], block[0] + copy);
    },

    /** Changes only the style of a cell (creating it if missing), keeping its content. */
    setStyle(name, ref, style) {
      const cell = ensureCell(sheet(name), ref);
      cell.attrs = { ...cell.attrs, s: String(style) };
    },

    /** Returns the index of a style like `base` (or the default one) with a solid fill (rgb "RRGGBB"). */
    deriveFillStyle(base, rgb) {
      const key = `${base ?? 0}:${rgb}`;
      if (derived.has(key)) return derived.get(key);
      let xml = text(files, 'xl/styles.xml');
      if (xml === null) throw new Error('Workbook has no styles.xml');
      const fills = /<fills\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/.exec(xml);
      const xfs = /<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
      if (!fills || !xfs) throw new Error('Unsupported styles.xml (fills or cellXfs missing)');
      const fillId = Number(fills[1]);
      const list = [...xfs[2].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
      const baseXf = list[Number(base ?? 0)];
      if (!baseXf) throw new Error(`Style ${base} not found`);
      const open = /^<xf\b[^>]*?(\/?)>/.exec(baseXf);
      let head = open[0].replace(/\sfillId="\d+"/, '').replace(/\sapplyFill="\d"/, '');
      head = head.replace(/^<xf\b/, `<xf fillId="${fillId}" applyFill="1"`);
      const newXf = baseXf.replace(open[0], head);
      const newFill = `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
      xml = xml
        .replace(fills[0], fills[0].replace(/count="\d+"/, `count="${fillId + 1}"`).replace('</fills>', `${newFill}</fills>`))
        .replace(xfs[0], xfs[0].replace(/count="\d+"/, `count="${list.length + 1}"`).replace('</cellXfs>', `${newXf}</cellXfs>`));
      files.set('xl/styles.xml', xml);
      derived.set(key, list.length);
      return list.length;
    },

    /** Removes sheets (refuses when sheet-scoped defined names would break). */
    removeSheets(names) {
      let wb = text(files, 'xl/workbook.xml');
      let rels = text(files, 'xl/_rels/workbook.xml.rels');
      let ct = text(files, '[Content_Types].xml');
      if (names.length > 0 && /<definedName\b[^>]*localSheetId=/.test(wb)) {
        throw new Error('Cannot remove sheets: the workbook has sheet-scoped defined names');
      }
      for (const name of names) {
        const info = sheets.find((s) => s.name === name);
        if (!info) throw new Error(`Sheet "${name}" not found`);
        if (sheets.length - names.length < 1) throw new Error('Cannot remove every sheet');
        wb = wb.replace(new RegExp(`<sheet\\b[^>]*r:id="${info.rid}"[^>]*?/>`), '');
        rels = rels.replace(new RegExp(`<Relationship\\b[^>]*Id="${info.rid}"[^>]*?/>`), '');
        ct = ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${info.file}"[^>]*?/>`), '');
        files.delete(info.file);
        files.delete(info.file.replace(/([^/]+)$/, '_rels/$1.rels'));
        parsed.delete(name);
      }
      wb = wb.replace(/\bactiveTab="\d+"/, 'activeTab="0"').replace(/\bfirstSheet="\d+"/, 'firstSheet="0"');
      files.set('xl/workbook.xml', wb);
      files.set('xl/_rels/workbook.xml.rels', rels);
      files.set('[Content_Types].xml', ct);
    },

    toBuffer() {
      for (const [, sh] of parsed) {
        // Cached formula results are stale after an edit: drop them so every reader has to recalculate.
        for (const row of sh.rows) {
          for (const c of row.cells) {
            if (!/<f\b/.test(c.inner)) continue;
            c.inner = c.inner.replace(/<v>[\s\S]*?<\/v>/, '');
            if (c.attrs.t && c.attrs.t !== 'inlineStr') delete c.attrs.t;
          }
        }
        const body = sh.rows.map(serializeRow).join('');
        let xml = sh.xml.replace(sh.sd[0], `<sheetData>${body}</sheetData>`);
        const last = sh.rows.at(-1);
        const maxCol = Math.max(1, ...sh.rows.flatMap((r) => r.cells.map((c) => colToNum(splitRef(c.attrs.r).col))));
        if (last) xml = xml.replace(/<dimension\b[^>]*?\/>/, `<dimension ref="A1:${numToCol(maxCol)}${last.num}"/>`);
        files.set(sh.info.file, xml);
      }
      // Cached formula results are stale after an edit: drop the calc chain and ask Excel to recalculate on open.
      if (files.has('xl/calcChain.xml')) {
        files.delete('xl/calcChain.xml');
        files.set('xl/_rels/workbook.xml.rels', text(files, 'xl/_rels/workbook.xml.rels')
          .replace(/<Relationship\b[^>]*calcChain[^>]*?\/>/, ''));
        files.set('[Content_Types].xml', text(files, '[Content_Types].xml')
          .replace(/<Override\b[^>]*calcChain[^>]*?\/>/, ''));
      }
      let wb = text(files, 'xl/workbook.xml');
      if (/<calcPr\b/.test(wb)) {
        if (!/fullCalcOnLoad=/.test(wb)) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
      } else {
        const tag = '<calcPr fullCalcOnLoad="1"/>';
        wb = wb.includes('<extLst') ? wb.replace('<extLst', `${tag}<extLst`) : wb.replace('</workbook>', `${tag}</workbook>`);
      }
      files.set('xl/workbook.xml', wb);
      return writeZip(files);
    },
  };
}
