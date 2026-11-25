// Converts the Word (.docx) templates in templates-src/ into JSON templates
// that the web app renders into PDF.  Run:  node tools/convert.js
//
// What it keeps: paragraphs (bold/italic/underline/size/color, alignment,
// indents, spacing), numbered and bulleted lists, tables (with borders),
// header and footer, images.  It recognises the variable parts of a
// template (patient name, birth date, date, diagnosis, operation code,
// Word FILLIN prompts) and turns them into {{field}} placeholders.
//
// The doctor's stamp image is NOT exported: it is replaced by a {stamp}
// marker and the user uploads the stamp on their own device.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { unzip } = require('./unzip');
const META = require('./meta');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'templates-src');
const OUT = path.join(ROOT, 'app', 'templates');
const IMG = path.join(ROOT, 'app', 'img');

// md5 prefixes of images that must never be published (doctor's stamp + signature)
const STAMP_HASHES = new Set(['466e8219']);

const EMU = 1 / 12700; // EMU -> pt
const TW = 1 / 20; // twips -> pt

// Which files to convert (the КЛ family comes in a later step)
const INCLUDE = (name) => /^UMC (Портал|Платно) /.test(name);

// ---------------------------------------------------------------- XML helpers
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const kids = (el, name) => {
  const r = [];
  if (!el) return r;
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!name || c.nodeName === name)) r.push(c);
  return r;
};
const kid = (el, name) => {
  if (!el) return null;
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.nodeName === name) return c;
  return null;
};
const desc = (el, name) => (el ? Array.from(el.getElementsByTagName(name)) : []);
const val = (el) => (el ? el.getAttribute('w:val') : null);
const onoff = (el) => {
  if (!el) return undefined;
  const v = el.getAttribute('w:val');
  return !(v === '0' || v === 'false' || v === 'none');
};
const hash = (b) => crypto.createHash('md5').update(b).digest('hex').slice(0, 8);

// ---------------------------------------------------------------- properties
function parseRPr(rPr) {
  const o = {};
  if (!rPr) return o;
  const b = kid(rPr, 'w:b');
  if (b) o.bold = onoff(b);
  const i = kid(rPr, 'w:i');
  if (i) o.italics = onoff(i);
  const u = kid(rPr, 'w:u');
  if (u) o.underline = val(u) !== 'none';
  const st = kid(rPr, 'w:strike');
  if (st) o.strike = onoff(st);
  const sz = kid(rPr, 'w:sz');
  if (sz) o.fontSize = +val(sz) / 2;
  const c = kid(rPr, 'w:color');
  if (c && val(c) && val(c) !== 'auto') o.color = '#' + val(c);
  const caps = kid(rPr, 'w:caps');
  if (caps) o.caps = onoff(caps);
  const vanish = kid(rPr, 'w:vanish');
  if (vanish) o.hidden = onoff(vanish);
  const va = kid(rPr, 'w:vertAlign');
  if (va) o.vertAlign = val(va);
  const shd = kid(rPr, 'w:shd');
  const fill = shd && shd.getAttribute('w:fill');
  if (fill && !/^(auto|FFFFFF)$/i.test(fill)) o.background = '#' + fill;
  const hl = val(kid(rPr, 'w:highlight'));
  if (hl && hl !== 'none') o.highlight = hl;
  return o;
}

function parsePPr(pPr) {
  const o = {};
  if (!pPr) return o;
  const jc = kid(pPr, 'w:jc');
  if (jc) o.align = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[val(jc)] || 'left';
  const ind = kid(pPr, 'w:ind');
  if (ind) {
    const l = ind.getAttribute('w:left') || ind.getAttribute('w:start');
    if (l) o.left = +l * TW;
    const r = ind.getAttribute('w:right') || ind.getAttribute('w:end');
    if (r) o.right = +r * TW;
    const fl = ind.getAttribute('w:firstLine');
    if (fl) o.firstLine = +fl * TW;
    const h = ind.getAttribute('w:hanging');
    if (h) o.firstLine = -h * TW;
  }
  const sp = kid(pPr, 'w:spacing');
  if (sp) {
    const b = sp.getAttribute('w:before');
    const a = sp.getAttribute('w:after');
    const ln = sp.getAttribute('w:line');
    const rule = sp.getAttribute('w:lineRule');
    if (b) o.before = +b * TW;
    if (sp.getAttribute('w:beforeAutospacing') === '1') o.before = 14 * 0.35;
    if (a) o.after = +a * TW;
    if (sp.getAttribute('w:afterAutospacing') === '1') o.after = 14 * 0.35;
    if (ln) {
      if (!rule || rule === 'auto') o.line = +ln / 240;
      else o.lineExact = +ln * TW;
    }
  }
  const num = kid(pPr, 'w:numPr');
  if (num) {
    o.numId = val(kid(num, 'w:numId'));
    o.ilvl = +(val(kid(num, 'w:ilvl')) || 0);
  }
  const shd = kid(pPr, 'w:shd');
  const fill = shd && shd.getAttribute('w:fill');
  if (fill && !/^(auto|FFFFFF)$/i.test(fill)) o.fill = '#' + fill;
  const ps = kid(pPr, 'w:pStyle');
  if (ps) o.style = val(ps);
  if (onoff(kid(pPr, 'w:pageBreakBefore'))) o.pageBreakBefore = true;
  if (onoff(kid(pPr, 'w:contextualSpacing'))) o.contextual = true;
  return o;
}

function tableBorders(tblPr) {
  // returns {top,left,bottom,right,insideH,insideV} booleans or undefined
  const b = kid(tblPr, 'w:tblBorders');
  if (!b) return undefined;
  const o = {};
  for (const e of kids(b)) {
    const name = e.nodeName.replace('w:', '').replace('start', 'left').replace('end', 'right');
    const v = val(e);
    o[name] = !!v && v !== 'nil' && v !== 'none';
  }
  return o;
}

// ---------------------------------------------------------------- styles / numbering
function loadStyles(xml) {
  const st = { byId: {}, defaultP: null, defaultTbl: null, docR: {}, docP: {} };
  if (!xml) return st;
  const doc = parseXml(xml);
  const dd = desc(doc, 'w:docDefaults')[0];
  if (dd) {
    st.docR = parseRPr(desc(dd, 'w:rPr')[0]);
    st.docP = parsePPr(desc(dd, 'w:pPr')[0]);
  }
  for (const s of desc(doc, 'w:style')) {
    const id = s.getAttribute('w:styleId');
    const type = s.getAttribute('w:type');
    st.byId[id] = {
      type,
      basedOn: val(kid(s, 'w:basedOn')),
      r: parseRPr(kid(s, 'w:rPr')),
      p: parsePPr(kid(s, 'w:pPr')),
      borders: tableBorders(kid(s, 'w:tblPr')),
    };
    if (s.getAttribute('w:default') === '1') {
      if (type === 'paragraph') st.defaultP = id;
      if (type === 'table') st.defaultTbl = id;
    }
  }
  return st;
}

function styleChain(st, id) {
  const chain = [];
  let guard = 0;
  while (id && st.byId[id] && guard++ < 20) {
    chain.unshift(st.byId[id]);
    id = st.byId[id].basedOn;
  }
  return chain;
}

// Word precedence: doc defaults < table style < paragraph style < numbering < direct
function resolvedStyle(st, id, table) {
  const r = { fontSize: 10, ...st.docR, ...((table && table.r) || {}) };
  const p = { ...st.docP, ...((table && table.p) || {}) };
  for (const s of styleChain(st, id)) {
    Object.assign(r, s.r);
    const sp = { ...s.p };
    delete sp.style;
    Object.assign(p, sp);
  }
  return { r, p };
}

function bulletChar(text, font) {
  if (!text) return '';
  const code = text.charCodeAt(0);
  if (/symbol|wingdings/i.test(font || '') || (code >= 0xf000 && code <= 0xf0ff)) return '•';
  if (text === 'o' && /courier/i.test(font || '')) return '◦';
  return text;
}

function loadNumbering(xml) {
  const nums = {};
  if (!xml) return nums;
  const doc = parseXml(xml);
  const abs = {};
  for (const a of desc(doc, 'w:abstractNum')) {
    const levels = {};
    for (const l of kids(a, 'w:lvl')) {
      const rPr = kid(l, 'w:rPr');
      const font = rPr && kid(rPr, 'w:rFonts') ? kid(rPr, 'w:rFonts').getAttribute('w:ascii') : null;
      const fmt = val(kid(l, 'w:numFmt')) || 'decimal';
      let text = val(kid(l, 'w:lvlText')) || '';
      if (fmt === 'bullet') text = bulletChar(text, font);
      const p = parsePPr(kid(l, 'w:pPr'));
      levels[+l.getAttribute('w:ilvl')] = { fmt, text, start: +(val(kid(l, 'w:start')) || 1), left: p.left, firstLine: p.firstLine };
    }
    abs[a.getAttribute('w:abstractNumId')] = levels;
  }
  for (const n of kids(doc.documentElement, 'w:num')) {
    const id = n.getAttribute('w:numId');
    const levels = JSON.parse(JSON.stringify(abs[val(kid(n, 'w:abstractNumId'))] || {}));
    for (const o of kids(n, 'w:lvlOverride')) {
      const so = kid(o, 'w:startOverride');
      const il = +o.getAttribute('w:ilvl');
      if (so && levels[il]) levels[il].start = +val(so);
    }
    nums[id] = levels;
  }
  return nums;
}

function loadRels(zip, part) {
  const relPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const m = {};
  if (!zip[relPath]) return m;
  for (const r of desc(parseXml(zip[relPath]().toString('utf8')), 'Relationship')) {
    m[r.getAttribute('Id')] = r.getAttribute('Target');
  }
  return m;
}

// ---------------------------------------------------------------- drawings
function exportImage(ctx, rid, rels) {
  const target = rels[rid];
  if (!target) return null;
  const p = path.posix.normalize(path.posix.join('word', target));
  if (!ctx.zip[p]) return null;
  const buf = ctx.zip[p]();
  const h = hash(buf);
  if (STAMP_HASHES.has(h)) {
    // keep a local copy (templates-src/ is gitignored) for the PIN-encrypted stamp file
    const local = path.join(SRC, 'stamp' + path.extname(p).toLowerCase());
    if (!fs.existsSync(local)) fs.writeFileSync(local, buf);
    return { stamp: true };
  }
  const name = h + path.extname(p).toLowerCase();
  const out = path.join(IMG, name);
  if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
  return { src: 'img/' + name };
}

function parseDrawing(ctx, d, rels) {
  const box = desc(d, 'wp:inline')[0] || desc(d, 'wp:anchor')[0];
  if (!box) return null;
  const blip = desc(box, 'a:blip')[0];
  if (!blip) return null;
  const img = exportImage(ctx, blip.getAttribute('r:embed'), rels);
  if (!img) return null;
  const ext = kid(box, 'wp:extent');
  img.w = +(+ext.getAttribute('cx') * EMU).toFixed(1);
  img.h = +(+ext.getAttribute('cy') * EMU).toFixed(1);
  if (box.nodeName === 'wp:anchor') {
    const pos = (e) => {
      if (!e) return { from: 'column', off: 0 };
      const o = kid(e, 'wp:posOffset');
      const a = kid(e, 'wp:align');
      return { from: e.getAttribute('relativeFrom'), off: o ? +(+o.textContent * EMU).toFixed(1) : 0, align: a ? a.textContent : undefined };
    };
    img.anchor = { h: pos(kid(box, 'wp:positionH')), v: pos(kid(box, 'wp:positionV')), behind: box.getAttribute('behindDoc') === '1' };
  }
  return img;
}

// ---------------------------------------------------------------- fields
function fieldToken(ctx, instr) {
  const s = instr.trim();
  let m;
  if (/^(DATE|CREATEDATE|SAVEDATE|PRINTDATE|TIME)\b/i.test(s)) {
    m = s.match(/\\@\s*"([^"]*)"/);
    return `{{date|${m ? m[1] : 'dd.MM.yyyy'}}}`;
  }
  if ((m = s.match(/^FILLIN\s+"([^"]*)"/i)) || (m = s.match(/^FILLIN\s+(\S+)/i))) {
    const key = 'f' + ++ctx.fillinCount;
    ctx.fillins[key] = { prompt: m[1].replace(/[:\s]+$/, '') };
    return `{{${key}}}`;
  }
  return null; // unknown field (PAGE etc.) -> keep its displayed result
}

// ---------------------------------------------------------------- paragraphs
const R_KEYS = ['bold', 'italics', 'underline', 'strike', 'fontSize', 'color', 'caps', 'vertAlign', 'background'];
function cleanRun(r) {
  const o = {};
  for (const k of R_KEYS) if (r[k]) o[k] = r[k];
  return o;
}
const runKey = (r) => JSON.stringify(cleanRun(r));

function parseParagraph(ctx, p, rels, fs_) {
  const own = parsePPr(kid(p, 'w:pPr'));
  const styleId = own.style || ctx.styles.defaultP;
  const rs = resolvedStyle(ctx.styles, styleId, ctx.tableStyle);
  let numLvl = null;
  const numId = own.numId != null ? own.numId : rs.p.numId;
  const ilvl = own.ilvl != null ? own.ilvl : rs.p.ilvl || 0;
  if (numId && numId !== '0' && ctx.numbering[numId]) numLvl = ctx.numbering[numId][ilvl] || null;
  const pp = { ...rs.p };
  if (numLvl) {
    if (numLvl.left != null) pp.left = numLvl.left;
    if (numLvl.firstLine != null) pp.firstLine = numLvl.firstLine;
  }
  Object.assign(pp, own);

  // run properties from the paragraph mark (used for empty paragraphs)
  const markR = { ...rs.r, ...parseRPr(kid(kid(p, 'w:pPr'), 'w:rPr')) };

  const block = { t: 'p', runs: [], fs: markR.fontSize };
  for (const k of ['align', 'left', 'right', 'firstLine', 'before', 'after', 'line', 'lineExact', 'pageBreakBefore', 'contextual', 'fill']) {
    if (pp[k] != null && pp[k] !== false) block[k] = typeof pp[k] === 'number' ? +pp[k].toFixed(1) : pp[k];
  }
  if (styleId) block.style = styleId;
  if (numLvl) block.num = { id: numId, lvl: ilvl, fmt: numLvl.fmt, text: numLvl.text, start: numLvl.start };

  const pushText = (text, rpr) => {
    if (!text || rpr.hidden || fs_.skip) return;
    if (rpr.caps) text = text.toUpperCase();
    const last = block.runs[block.runs.length - 1];
    const k = runKey(rpr);
    if (last && last._k === k) last.text += text;
    else block.runs.push({ text, ...cleanRun(rpr), _k: k });
  };
  const addImage = (img) => {
    if (!img || fs_.skip) return;
    img.at = block.runs.reduce((a, r) => a + r.text.length, 0);
    (block.images = block.images || []).push(img);
  };

  const runEl = (r) => {
    const rPrEl = kid(r, 'w:rPr');
    let rpr = { ...rs.r };
    const rStyle = val(kid(rPrEl, 'w:rStyle'));
    if (rStyle) for (const s of styleChain(ctx.styles, rStyle)) Object.assign(rpr, s.r);
    Object.assign(rpr, parseRPr(rPrEl));
    for (const c of kids(r)) {
      switch (c.nodeName) {
        case 'w:t':
          pushText(c.textContent, rpr);
          break;
        case 'w:tab':
        case 'w:ptab':
          pushText('\t', rpr);
          break;
        case 'w:br':
          if (c.getAttribute('w:type') === 'page') {
            if (block.runs.length) block.breakAfter = true;
            else block.pageBreakBefore = true;
          } else pushText('\n', rpr);
          break;
        case 'w:cr':
          pushText('\n', rpr);
          break;
        case 'w:noBreakHyphen':
          pushText('-', rpr);
          break;
        case 'w:sym':
          pushText('•', rpr);
          break;
        case 'w:fldChar': {
          const t = c.getAttribute('w:fldCharType');
          if (t === 'begin') {
            fs_.depth++;
            if (fs_.depth === 1) Object.assign(fs_, { instr: '', collect: true, rpr });
          } else if (t === 'separate') {
            if (fs_.depth === 1) {
              fs_.collect = false;
              const tok = fieldToken(ctx, fs_.instr);
              if (tok) {
                pushText(tok, fs_.rpr);
                fs_.skip = true;
              }
            }
          } else if (t === 'end') {
            if (fs_.depth === 1) {
              if (fs_.collect) {
                fs_.collect = false;
                const tok = fieldToken(ctx, fs_.instr);
                if (tok) pushText(tok, fs_.rpr);
              }
              fs_.skip = false;
            }
            fs_.depth = Math.max(0, fs_.depth - 1);
          }
          break;
        }
        case 'w:instrText':
          if (fs_.collect && fs_.depth === 1) fs_.instr += c.textContent;
          break;
        case 'w:drawing':
          addImage(parseDrawing(ctx, c, rels));
          break;
        case 'mc:AlternateContent': {
          const ch = kid(c, 'mc:Choice');
          for (const d of kids(ch, 'w:drawing')) addImage(parseDrawing(ctx, d, rels));
          break;
        }
      }
    }
  };

  const walk = (el) => {
    for (const c of kids(el)) {
      switch (c.nodeName) {
        case 'w:r':
          runEl(c);
          break;
        case 'w:hyperlink':
        case 'w:smartTag':
        case 'w:ins':
        case 'w:customXml':
          walk(c);
          break;
        case 'w:sdt':
          walk(kid(c, 'w:sdtContent'));
          break;
        case 'w:fldSimple': {
          const tok = fieldToken(ctx, c.getAttribute('w:instr') || '');
          if (tok) pushText(tok, { ...rs.r });
          else walk(c);
          break;
        }
      }
    }
  };
  walk(p);
  for (const r of block.runs) delete r._k;
  if (!block.runs.length) delete block.runs;
  return block;
}

// ---------------------------------------------------------------- tables
function parseTable(ctx, tbl, rels, fs_) {
  const widths = kids(kid(tbl, 'w:tblGrid'), 'w:gridCol').map((g) => +(+g.getAttribute('w:w') * TW).toFixed(1));
  const tblPr = kid(tbl, 'w:tblPr');
  const styleId = val(kid(tblPr, 'w:tblStyle')) || ctx.styles.defaultTbl;
  let tb = {};
  const tStyle = { r: {}, p: {} };
  for (const s of styleChain(ctx.styles, styleId)) {
    if (s.borders) Object.assign(tb, s.borders);
    Object.assign(tStyle.r, s.r);
    Object.assign(tStyle.p, s.p);
  }
  delete tStyle.p.style;
  const outerTableStyle = ctx.tableStyle;
  ctx.tableStyle = tStyle;
  Object.assign(tb, tableBorders(tblPr) || {});
  const rows = [];
  const trs = kids(tbl, 'w:tr');
  trs.forEach((tr, ri) => {
    const row = [];
    let col = 0;
    for (const tc of kids(tr, 'w:tc')) {
      const tcPr = kid(tc, 'w:tcPr');
      const span = +(val(kid(tcPr, 'w:gridSpan')) || 1);
      const vm = kid(tcPr, 'w:vMerge');
      const vmerge = vm ? val(vm) || 'continue' : null;
      const cb = kid(tcPr, 'w:tcBorders');
      const border = [
        col === 0 ? !!tb.left : !!tb.insideV,
        ri === 0 ? !!tb.top : !!tb.insideH,
        col + span >= widths.length ? !!tb.right : !!tb.insideV,
        ri === trs.length - 1 ? !!tb.bottom : !!tb.insideH,
      ];
      if (cb) {
        const sides = ['left', 'top', 'right', 'bottom'];
        for (const e of kids(cb)) {
          const name = e.nodeName.replace('w:', '').replace('start', 'left').replace('end', 'right');
          const i = sides.indexOf(name);
          if (i >= 0) border[i] = !!val(e) && val(e) !== 'nil' && val(e) !== 'none';
        }
      }
      const shd = kid(tcPr, 'w:shd');
      const fill = shd && shd.getAttribute('w:fill') && !/^(auto|FFFFFF)$/i.test(shd.getAttribute('w:fill')) ? '#' + shd.getAttribute('w:fill') : undefined;
      const cell = { col, span, border, blocks: parseBlocks(ctx, tc, rels, fs_) };
      if (vmerge) cell.vmerge = vmerge;
      if (fill) cell.fill = fill;
      row.push(cell);
      col += span;
    }
    rows.push(row);
  });
  ctx.tableStyle = outerTableStyle;
  return { t: 'table', widths, rows };
}

function parseBlocks(ctx, el, rels, fs_) {
  const out = [];
  for (const c of kids(el)) {
    if (c.nodeName === 'w:p') out.push(parseParagraph(ctx, c, rels, fs_));
    else if (c.nodeName === 'w:tbl') out.push(parseTable(ctx, c, rels, fs_));
    else if (c.nodeName === 'w:sdt') out.push(...parseBlocks(ctx, kid(c, 'w:sdtContent'), rels, fs_));
  }
  return out;
}

// ---------------------------------------------------------------- semantic pass
function flatten(blocks, out = [], cellCtx = null) {
  for (const b of blocks) {
    if (b.t === 'p') out.push({ b, cellCtx });
    else if (b.t === 'table')
      b.rows.forEach((row) => row.forEach((cell, ci) => flatten(cell.blocks, out, { row, ci })));
  }
  return out;
}
const textOf = (b) => (b.runs || []).map((r) => r.text).join('');

// Replace everything in paragraph b from character offset `from` with `token`.
// Returns the removed text.
function replaceFrom(b, from, token) {
  const runs = b.runs || [];
  const kept = [];
  let pos = 0;
  let removed = '';
  let style = null;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end <= from) kept.push(r);
    else {
      if (pos < from) {
        kept.push({ ...r, text: r.text.slice(0, from - pos) });
        removed += r.text.slice(from - pos);
      } else removed += r.text;
      if (!style && r.text.slice(Math.max(0, from - pos)).trim()) style = r;
      if (!style) style = r;
    }
    pos = end;
  }
  if (!style) style = runs[runs.length - 1] || {};
  const { text, ...st } = style;
  kept.push({ ...st, text: token });
  b.runs = kept;
  return removed;
}

// Replace characters [start, end) of paragraph b with token, keeping run styles.
function replaceRange(b, start, end, token) {
  const out = [];
  let pos = 0;
  let inserted = false;
  for (const r of b.runs || []) {
    const s = pos;
    const e = pos + r.text.length;
    pos = e;
    if (e <= start || s >= end) {
      out.push(r);
      continue;
    }
    if (s < start) out.push({ ...r, text: r.text.slice(0, start - s) });
    if (!inserted) {
      out.push({ ...r, text: token });
      inserted = true;
    }
    if (e > end) out.push({ ...r, text: r.text.slice(end - s) });
  }
  b.runs = out;
}

const cleanDefault = (s) =>
  s
    .replace(/_{2,}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:.\-–]+/, '')
    .trim();

function semantic(tpl, ctx) {
  const flat = flatten(tpl.body);
  const fields = {};
  const setField = (key, def) => {
    if (!fields[key]) fields[key] = { key };
    if (def != null && def !== '') fields[key].default = def;
  };

  const LABELS = [
    { key: 'fio', re: /^\s*(Ф\.?\s*И\.?\s*О\.?|ФИО)\s*пациента\s*:?/i },
    { key: 'dob', re: /^\s*Дата\s+рождения(\s+пациента)?\s*:?/i },
    { key: 'iin', re: /^\s*ИИН\s*:?/i },
  ];
  const DX_INLINE = /^\s*(Диагноз\s*\(МКБ[\s-]*10\)|\(МКБ[\s-]*10\)\s*Диагноз|Диагноз)\s*:\s*/i;
  const DX_HEAD = /^\s*(\(МКБ[\s-]*10\)\s*)?Диагноз(\s*\(МКБ[\s-]*10\))?\s*:?\s*$/i;
  const OP_INLINE = /^\s*(Код операции\s*\(МКБ[\s-]*9\)|\(МКБ[\s-]*9\)\s*(Код операции|Планируемое оперативное лечение))\s*:\s*/i;
  const OP_HEAD = /^\s*(\(МКБ[\s-]*9\)\s*)?(Код операции|Планируемое оперативное лечение)(\s*\(МКБ[\s-]*9\))?\s*:?\s*$/i;

  const nextNonEmpty = (i) => {
    for (let j = i + 1; j < flat.length && j < i + 4; j++) if (textOf(flat[j].b).trim()) return flat[j];
    return null;
  };

  let dxDone = false;
  let opDone = false;
  flat.forEach((item, i) => {
    const b = item.b;
    let t = textOf(b);
    if (!t.trim()) return;

    // literal placeholder "Дата операции" inside a sentence -> planned date field
    const od = t.search(/(?<=\S\s+)Дата операции/);
    if (od > 0) {
      replaceRange(b, od, od + 'Дата операции'.length, '{{opdate}}');
      setField('opdate');
      t = textOf(b);
    }
    // "Планировать госпитализацию на __02. 2026 г." -> planned date field
    const pd = t.match(/(госпитализаци\S*\s+на\s+)(_*[\d_.\s]*\d{4})/i);
    if (pd && /_/.test(pd[2])) {
      const start = pd.index + pd[1].length;
      replaceRange(b, start, start + pd[2].length, '{{opdate}}');
      setField('opdate');
      t = textOf(b);
    }

    for (const L of LABELS) {
      const m = t.match(L.re);
      if (!m || fields[L.key]) continue;
      const rest = cleanDefault(t.slice(m[0].length).replace(/\{\{f\d+\}\}/g, ''));
      if (item.cellCtx && !rest) {
        // label in a table cell -> value goes into the next cell
        const next = item.cellCtx.row[item.cellCtx.ci + 1];
        if (next && next.blocks[0] && next.blocks[0].t === 'p') {
          const nb = next.blocks[0];
          const style = (nb.runs && nb.runs[0]) || (b.runs && b.runs[b.runs.length - 1]) || {};
          const { text, ...st } = style;
          setField(L.key, cleanDefault(textOf(nb)) || undefined);
          nb.runs = [{ ...st, bold: false, text: `{{${L.key}}}` }];
          next.blocks.splice(1).forEach(() => {});
          continue;
        }
      }
      replaceFrom(b, m[0].length, (/\s$/.test(m[0]) ? '' : ' ') + `{{${L.key}}}`);
      setField(L.key); // the example value from the template is not kept
    }

    if (!dxDone) {
      let m = t.match(DX_INLINE);
      if (m && cleanDefault(t.slice(m[0].length)) !== undefined && !DX_HEAD.test(t)) {
        const removed = replaceFrom(b, m[0].length, '{{diagnosis}}');
        setField('diagnosis', cleanDefault(removed));
        if (!fields.diagnosis.default) fields.diagnosis.default = '';
        dxDone = true;
      } else if (DX_HEAD.test(t)) {
        const n = nextNonEmpty(i);
        if (n && !OP_HEAD.test(textOf(n.b)) && !/^Рекоменд/i.test(textOf(n.b))) {
          const removed = replaceFrom(n.b, 0, '{{diagnosis}}');
          setField('diagnosis', cleanDefault(removed));
          dxDone = true;
        }
      }
    }
    if (!opDone) {
      let m = t.match(OP_INLINE);
      if (m && !OP_HEAD.test(t)) {
        const removed = replaceFrom(b, m[0].length, '{{operation}}');
        setField('operation', cleanDefault(removed));
        if (!fields.operation.default) fields.operation.default = '';
        opDone = true;
      } else if (OP_HEAD.test(t)) {
        const n = nextNonEmpty(i);
        if (n) {
          const removed = replaceFrom(n.b, 0, '{{operation}}');
          setField('operation', cleanDefault(removed));
          opDone = true;
        }
      }
    }
  });

  // which tokens remain in the document?
  const all = JSON.stringify(tpl) + JSON.stringify(fields);
  if (/\{\{date\|/.test(all)) setField('date');
  // Templates without a DATE field still need a date for the file name
  if (!fields.date) fields.date = { key: 'date', hidden: true };

  // FILLIN prompts still present -> extra fields; label them using the word before
  const promptCount = {};
  for (const k in ctx.fillins) promptCount[ctx.fillins[k].prompt] = (promptCount[ctx.fillins[k].prompt] || 0) + 1;
  for (const k in ctx.fillins) {
    if (!all.includes(`{{${k}}}`)) continue;
    let label = ctx.fillins[k].prompt;
    const before = all.split(`{{${k}}}`)[0].replace(/\\n/g, ' ').match(/([A-Za-zА-Яа-яЁё]+)[\s:,.]*$/);
    if (before && (promptCount[label] > 1 || label.length < 4)) label = `${before[1]} — ${label.toLowerCase()}`;
    else if (before && /^степен/i.test(label)) label = `${before[1]} — ${label.toLowerCase()}`;
    fields[k] = { key: k, label, fillin: true };
  }

  const LABEL = { fio: 'Ф.И.О. пациента', dob: 'Дата рождения', iin: 'ИИН', date: 'Дата консультации', opdate: 'Дата госпитализации', diagnosis: 'Диагноз (МКБ-10)', operation: 'Операция / код (МКБ-9)' };
  const KIND = { dob: 'date', date: 'date', opdate: 'date', diagnosis: 'multiline', operation: 'multiline' };
  const ORDER = ['fio', 'dob', 'iin', 'date', 'opdate', 'diagnosis', 'operation'];
  const list = Object.values(fields)
    .map((f) => ({ label: LABEL[f.key], kind: KIND[f.key] || 'text', ...f }))
    .sort((a, b) => (ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99));
  return list;
}

// ---------------------------------------------------------------- whole document
function convert(file) {
  const zip = unzip(fs.readFileSync(file));
  const read = (p) => (zip[p] ? zip[p]().toString('utf8') : null);
  const ctx = {
    zip,
    styles: loadStyles(read('word/styles.xml')),
    numbering: loadNumbering(read('word/numbering.xml')),
    fillinCount: 0,
    fillins: {},
  };
  const docRels = loadRels(zip, 'word/document.xml');
  const doc = parseXml(read('word/document.xml'));
  const body = desc(doc, 'w:body')[0];
  const fs_ = { depth: 0, skip: false, collect: false, instr: '' };
  const blocks = parseBlocks(ctx, body, docRels, fs_);

  const sect = kid(body, 'w:sectPr') || desc(doc, 'w:sectPr').pop();
  const pgSz = kid(sect, 'w:pgSz');
  const pgMar = kid(sect, 'w:pgMar');
  const g = (el, a, d) => (el && el.getAttribute(a) ? +el.getAttribute(a) * TW : d);
  const page = {
    w: +g(pgSz, 'w:w', 595.3).toFixed(1),
    h: +g(pgSz, 'w:h', 841.9).toFixed(1),
    top: g(pgMar, 'w:top', 56.7),
    bottom: g(pgMar, 'w:bottom', 56.7),
    left: g(pgMar, 'w:left', 85),
    right: g(pgMar, 'w:right', 42.5),
    header: g(pgMar, 'w:header', 35.4),
    footer: g(pgMar, 'w:footer', 35.4),
  };

  const part = (type) => {
    const ref = kids(sect, `w:${type}Reference`).find((r) => r.getAttribute('w:type') === 'default');
    if (!ref) return null;
    const target = docRels[ref.getAttribute('r:id')];
    const p = path.posix.join('word', target);
    const x = read(p);
    if (!x) return null;
    const pd = parseXml(x);
    const bl = parseBlocks(ctx, pd.documentElement, loadRels(zip, p), { depth: 0, skip: false, collect: false, instr: '' });
    // drop trailing empty paragraphs
    while (bl.length && bl[bl.length - 1].t === 'p' && !bl[bl.length - 1].runs && !bl[bl.length - 1].images) bl.pop();
    return bl.length ? bl : null;
  };

  const tpl = { page, header: part('header'), footer: part('footer'), body: blocks };
  tpl.fields = semantic(tpl, ctx);
  addHospLine(tpl);
  addStamp(tpl);
  return tpl;
}

// Every template gets a "Дата госпитализации" field. Templates that do not already
// mention it get an extra line after the operation (or diagnosis) paragraph, printed
// only when the date is filled in (onlyIf).
function addHospLine(tpl) {
  if (tpl.fields.some((f) => f.key === 'opdate')) return;
  const find = (key) => {
    let hit = null;
    const walk = (arr) =>
      arr.forEach((b, i) => {
        if (hit) return;
        if (b.t === 'p' && textOf(b).includes(`{{${key}}}`)) hit = { arr, i, b };
        else if (b.t === 'table') b.rows.forEach((r) => r.forEach((c) => walk(c.blocks)));
      });
    walk(tpl.body);
    return hit;
  };
  const at = find('operation') || find('diagnosis');
  if (!at) return;
  const fs = at.b.fs || 12;
  const size = ((at.b.runs || []).find((r) => r.fontSize) || {}).fontSize || fs;
  at.arr.splice(at.i + 1, 0, {
    t: 'p', fs, left: at.b.left || 0, before: 4, after: Math.max(at.b.after || 0, 4), line: 1, onlyIf: 'opdate',
    runs: [
      { text: 'Дата госпитализации: ', bold: true, fontSize: size },
      { text: "{{opdate|d MMMM yyyy 'г.'}}", fontSize: size },
    ],
  });
  const di = tpl.fields.findIndex((f) => f.key === 'date');
  tpl.fields.splice(di + 1, 0, { label: 'Дата госпитализации', kind: 'date', key: 'opdate' });
}

// Templates whose Word original has no stamp image: put it over the signature
// blank on the doctor's line ("Ангиохирург: ______ Тулемисов …").
function addStamp(tpl) {
  if (JSON.stringify(tpl.body).includes('"stamp":true')) return;
  const target = tpl.body.find((b) => b.t === 'p' && /хирург/i.test(textOf(b)) && /Тулемисов/.test(textOf(b)));
  if (!target) return;
  const t = textOf(target).replace(/\s+$/, '');
  const width = tpl.page.w - tpl.page.left - tpl.page.right;
  const cw = (target.fs || 12) * 0.56; // average Arial character width
  let x;
  const u = t.match(/_+/);
  if (!u) x = 290; // "Врач-ангиохирург \t\t\t Абай Канатович Тулемисов" — same place as in the other templates
  else {
    const len = t.length * cw;
    const start = target.align === 'right' ? width - len : target.align === 'center' ? (width - len) / 2 : target.left || 0;
    x = start + (u.index + u[0].length / 2) * cw - 43;
  }
  target.images = [...(target.images || []), { stamp: true, w: 86, h: 86, anchor: { h: { from: 'column', off: Math.round(x) }, v: { from: 'paragraph', off: -36 }, behind: true }, at: 0 }];
}

// ---------------------------------------------------------------- main
function slug(s) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return s
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function group(name) {
  if (/\(КС\)/.test(name)) return { id: 'ks', title: 'Портал · круглосуточный стационар' };
  if (/Портал ОИР \(ДС\)/.test(name)) return { id: 'ds', title: 'Портал · дневной стационар' };
  if (/Платно/.test(name)) return { id: 'paid', title: 'Платные услуги' };
  return { id: 'other', title: 'Другое' };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(IMG, { recursive: true });
  const index = [];
  for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.docx') && INCLUDE(f)).sort()) {
    const base = f.replace(/\.docx$/, '');
    const meta = META[base] || {};
    const id = slug(base.replace(/^UMC /, ''));
    try {
      const tpl = convert(path.join(SRC, f));
      const g = group(base);
      const title = meta.title || base.replace(/^UMC (Портал|Платно) ОИР \((КС|ДС)\)\.?\s*/, '') || base;
      Object.assign(tpl, { id, title, group: g.id, source: f, aliases: meta.aliases || undefined });
      fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(tpl));
      index.push({ id, title, group: g.id, groupTitle: g.title, keywords: meta.keywords || [] });
      console.log('ok  ', id.padEnd(55), tpl.fields.map((x) => x.key + (x.default ? '*' : '')).join(','));
    } catch (e) {
      console.log('FAIL', f, e.stack);
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(index.length, 'templates');
}

main();
