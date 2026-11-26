// Turns a JSON template + field values into a pdfmake document definition.
(function (global) {
  'use strict';

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const BLANK = '____________________';
  const pad = (n) => String(n).padStart(2, '0');

  function formatDate(iso, fmt) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return (fmt || 'dd.MM.yyyy').replace(/'([^']*)'|yyyy|yy|MMMM|MM|M|dd|d/g, (t, lit) => {
      if (lit !== undefined) return lit;
      switch (t) {
        case 'yyyy': return String(y);
        case 'yy': return String(y).slice(2);
        case 'MMMM': return MONTHS[m - 1];
        case 'MM': return pad(m);
        case 'M': return String(m);
        case 'dd': return pad(d);
        default: return String(d);
      }
    });
  }

  // ------------------------------------------------------------ placeholders
  // ------------------------------------------------------------ side (справа / слева)
  // whole words only: "справа/слева" and adjective forms "правой, левого, правую…"
  const NL = '(^|[^А-Яа-яЁё])', NR = '(?![А-Яа-яЁё])';
  const ADV = new RegExp(NL + '([Сс])(права|лева)' + NR, 'g');
  const ADJ = new RegExp(NL + '(Прав|прав|Лев|лев)(ая|ой|ую|ое|ого|ому|ом|ые|ых|ым|ыми|ый)' + NR, 'g');
  // both sides, as written by applySide(…, 'both') or said explicitly
  const ADJ_END = '(ая|ой|ую|ое|ого|ому|ом|ые|ых|ым|ыми|ый)';
  const BOTH_ADJ = new RegExp(NL + '(Прав|прав|Лев|лев)' + ADJ_END + '\\s+и\\s+(?:прав|лев)' + ADJ_END + NR, 'g');
  const BOTH_ADV = new RegExp(NL + '([Сс])\\s+обеих\\s+сторон' + NR, 'g');
  const BOTH_SAID = /с\s+обеих\s+сторон|с\s+двух\s+сторон|двусторонн|билатерал/i;
  // "правой и левой" → "правой", "с обеих сторон" → "справа" (so a side can be applied again)
  const collapse = (t) =>
    String(t)
      .replace(BOTH_ADJ, (m, p, w, end) => p + w + end)
      .replace(BOTH_ADV, (m, p, c) => p + c + 'права');
  function sides(text) {
    const s = { right: false, left: false, both: false };
    const t = String(text || '');
    if (BOTH_SAID.test(t) || BOTH_ADJ.test(t)) s.both = true;
    BOTH_ADJ.lastIndex = 0;
    t.replace(ADV, (m, p, c, w) => ((s[w === 'права' ? 'right' : 'left'] = true), m));
    t.replace(ADJ, (m, p, w) => ((s[/^п/i.test(w) ? 'right' : 'left'] = true), m));
    return s;
  }
  // 'right' | 'left' | 'both' (only when said explicitly) | '' (none, or unclear)
  function sideOf(text) {
    const s = sides(text);
    if (s.both) return 'both';
    return s.right && !s.left ? 'right' : s.left && !s.right ? 'left' : '';
  }
  function applySide(text, side) {
    if (!text || !['left', 'right', 'both'].includes(side)) return text;
    const t = collapse(text);
    if (side === 'both')
      return t
        .replace(ADV, (m, p, c) => p + c + ' обеих сторон')
        .replace(ADJ, (m, p, w, end) => p + (w[0] === w[0].toUpperCase() ? 'Прав' : 'прав') + end + ' и лев' + end);
    const L = side === 'left';
    return t
      .replace(ADV, (m, p, c) => p + c + (L ? 'лева' : 'права'))
      .replace(ADJ, (m, p, w, end) => {
        const up = w[0] === w[0].toUpperCase();
        return p + (L ? (up ? 'Лев' : 'лев') : up ? 'Прав' : 'прав') + end;
      });
  }

  function makeExpander(tpl, values) {
    const fields = {};
    for (const f of tpl.fields || []) fields[f.key] = f;
    const expand = (text, depth = 0) =>
      text.replace(/\{\{([^}|]+)(?:\|([^}]*))?\}\}/g, (_, key, fmt) => {
        const f = fields[key] || { kind: 'text' };
        let v = values[key];
        if (v === undefined || v === null) v = f.default || '';
        if (f.kind === 'date') v = formatDate(v, fmt || 'dd.MM.yyyy');
        else if (depth < 3) v = expand(String(v), depth + 1);
        return v && String(v).trim() ? v : BLANK;
      });
    return expand;
  }

  // ------------------------------------------------------------ numbering
  const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  const RU = 'абвгдежзиклмнопрстуфхцчшщэюя';
  function numText(n, fmt) {
    switch (fmt) {
      case 'lowerLetter': return String.fromCharCode(96 + (((n - 1) % 26) + 1));
      case 'upperLetter': return String.fromCharCode(64 + (((n - 1) % 26) + 1));
      case 'lowerRoman':
      case 'upperRoman': {
        let s = '';
        for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
        return fmt === 'upperRoman' ? s.toUpperCase() : s;
      }
      case 'russianLower': return RU[(n - 1) % RU.length];
      case 'russianUpper': return RU[(n - 1) % RU.length].toUpperCase();
      default: return String(n);
    }
  }
  function numberLabel(num, counters) {
    if (num.fmt === 'bullet') return num.text || '•';
    if (num.fmt === 'none') return '';
    const c = (counters[num.id] = counters[num.id] || []);
    c[num.lvl] = c[num.lvl] == null ? num.start : c[num.lvl] + 1;
    c.length = num.lvl + 1;
    return (num.text || '%1.').replace(/%(\d)/g, (_, k) => numText(c[k - 1] == null ? 1 : c[k - 1], num.fmt));
  }

  // ------------------------------------------------------------ blocks
  function runStyle(r) {
    const s = {};
    if (r.bold) s.bold = true;
    if (r.italics) s.italics = true;
    const deco = [];
    if (r.underline) deco.push('underline');
    if (r.strike) deco.push('lineThrough');
    if (deco.length) s.decoration = deco.length === 1 ? deco[0] : deco;
    if (r.fontSize) s.fontSize = r.fontSize;
    if (r.color && r.color.toLowerCase() !== '#000000') s.color = r.color;
    if (r.vertAlign === 'superscript') s.sup = true;
    if (r.vertAlign === 'subscript') s.sub = true;
    if (r.background) s.background = r.background;
    return s;
  }

  function imageNode(img, ctx, region) {
    if (img.stamp) {
      if (!ctx.stamp) return null;
    } else if (!ctx.images[img.src]) return null;
    const node = { image: img.stamp ? 'stamp' : img.src, width: img.w, height: img.h };
    if (!img.anchor) return node;
    const { h, v } = img.anchor;
    const p = ctx.page;
    let x = h.off;
    if (h.align === 'center') x = (h.from === 'page' ? (p.w - img.w) / 2 : p.left + (p.w - p.left - p.right - img.w) / 2);
    else if (h.from !== 'page') x = p.left + h.off;
    if (v.from === 'page') {
      node.absolutePosition = { x, y: v.off };
    } else if (v.from === 'margin' || v.from === 'topMargin') {
      node.absolutePosition = { x, y: (region === 'footer' ? p.h - ctx.margins[3] : ctx.margins[1]) + v.off };
    } else if (region === 'header') {
      node.absolutePosition = { x, y: p.header + v.off };
    } else if (region === 'footer') {
      node.absolutePosition = { x, y: p.h - ctx.margins[3] + v.off };
    } else {
      // paragraph-relative in the body: detached block, does not take space
      node.relativePosition = { x: x - p.left, y: v.off };
    }
    return node;
  }

  function paragraph(b, ctx, region, prev) {
    const fs = b.fs || 10;
    let runs = (b.runs || []).map((r) => ({ text: ctx.expand(r.text).replace(/\t/g, '    '), ...runStyle(r) }));
    const hasText = runs.some((r) => r.text.trim());
    // A whole line in superscript (e.g. "(подпись, печать)" under the signature):
    // print it small instead of raised, otherwise it overlaps the line above.
    if (hasText && runs.every((r) => r.sup || !r.text.trim())) {
      runs = runs.map(({ sup, ...r }) => ({ ...r, fontSize: Math.round((r.fontSize || fs) * 0.7 * 10) / 10 }));
    }
    const images = (b.images || []).map((i) => imageNode(i, ctx, region)).filter(Boolean);
    const inline = images.filter((n) => !n.absolutePosition && !n.relativePosition);
    const floating = images.filter((n) => n.absolutePosition || n.relativePosition);

    if (!runs.length || !runs.some((r) => r.text)) runs = [{ text: ' ' }];

    // compact = second attempt when the signature would otherwise end up alone on a new page
    const k = ctx.compact && region === 'body' ? 0.4 : 1;
    let before = (b.before || 0) * k;
    let after = (b.after || 0) * k;
    if (b.contextual && prev && prev.style === b.style) before = 0;
    const left = b.left || 0;
    const right = b.right || 0;
    const firstLine = b.firstLine || 0;
    let lineHeight = (b.line || 1) * (ctx.compact && region === 'body' ? 0.94 : 1);
    if (b.lineExact) lineHeight = Math.max(0.8, b.lineExact / (fs * 1.17));

    let node;
    if (b.num && b.num.fmt !== 'none') {
      const label = numberLabel(b.num, ctx.counters);
      const labelFs = (b.runs && b.runs[0] && b.runs[0].fontSize) || fs;
      // the number must never wrap ("1" / "0.") — make its column wide enough
      const hang = Math.max(-firstLine, 10, label.length * labelFs * 0.56 + 3);
      if (!hasText && !inline.length) {
        node = { text: label, noWrap: true, fontSize: labelFs, lineHeight, margin: [Math.max(0, left + Math.min(0, firstLine)), before, right, after] };
      } else node = {
        columns: [
          { width: hang, text: label, noWrap: true, fontSize: labelFs, lineHeight },
          { width: '*', text: runs, alignment: b.align || 'left', lineHeight },
        ],
        columnGap: 0,
        margin: [Math.max(0, left - hang), before, right, after],
      };
    } else {
      node = { text: runs, alignment: b.align || 'left', lineHeight, fontSize: fs, preserveLeadingSpaces: true, margin: [left + Math.min(0, firstLine), before, right, after] };
      if (firstLine > 0) node.leadingIndent = firstLine;
      if (!hasText && inline.length) {
        node = { stack: inline.map((i) => ({ ...i, alignment: b.align || 'left' })), margin: [left, before, right, after] };
      } else if (inline.length) {
        node = { stack: [node, ...inline] };
      }
    }
    if (b.fill) {
      // shaded paragraph (coloured heading band): one-cell table with background
      const m = node.margin || [0, 0, 0, 0];
      node.margin = [0, 0, 0, 0];
      node = {
        table: { widths: ['*'], body: [[{ stack: [node], fillColor: b.fill, border: [false, false, false, false] }]] },
        layout: { paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 1, paddingBottom: () => 1 },
        margin: m,
      };
    }
    // unbreakable: lay the stamp out together with its line, so near the bottom of a page
    // it is not pushed onto the next page on its own
    if (floating.length) node = { stack: [...floating, node], unbreakable: (b.images || []).some((i) => i.stamp) };
    // flow = last resort when page 1 does not fit even compacted: page 2 just follows on
    if (b.pageBreakBefore && !(b.page2 && ctx.flow)) node.pageBreak = 'before';
    if (b.breakAfter) node.pageBreak = 'after';
    return node;
  }

  function table(t, ctx, region) {
    const ncol = t.widths.length;
    const grid = t.rows.map((row) => {
      const arr = new Array(ncol).fill(null);
      for (const c of row) if (c.col < ncol) arr[c.col] = c;
      return arr;
    });
    const body = grid.map((arr, ri) => {
      const out = [];
      for (let ci = 0; ci < ncol; ci++) {
        const c = arr[ci];
        if (!c) {
          out.push({ text: '', border: [false, false, false, false] });
          continue;
        }
        const span = Math.min(c.span || 1, ncol - ci);
        if (c.vmerge === 'continue') {
          out.push({});
          for (let k = 1; k < span; k++) out.push({});
          ci += span - 1;
          continue;
        }
        const node = { stack: blocks(c.blocks, ctx, region), border: c.border };
        if (span > 1) node.colSpan = span;
        if (c.fill) node.fillColor = c.fill;
        if (c.vmerge === 'restart') {
          let rs = 1;
          while (grid[ri + rs] && grid[ri + rs][ci] && grid[ri + rs][ci].vmerge === 'continue') rs++;
          if (rs > 1) node.rowSpan = rs;
        }
        out.push(node);
        for (let k = 1; k < span; k++) out.push({});
        ci += span - 1;
      }
      return out;
    });
    const avail = ctx.page.w - ctx.page.left - ctx.page.right;
    const total = t.widths.reduce((a, b) => a + b, 0);
    const scale = total > avail ? avail / total : 1;
    return {
      table: { widths: t.widths.map((w) => Math.max(4, w * scale - 6)), body, dontBreakRows: true },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        paddingLeft: () => 3,
        paddingRight: () => 3,
        // compact: rows without the extra point above and below the text
        paddingTop: () => (ctx.compact ? 0 : 1),
        paddingBottom: () => (ctx.compact ? 0 : 1),
      },
    };
  }

  const isEmpty = (b) => b.t === 'p' && !(b.runs || []).some((r) => r.text.trim()) && !(b.images || []).length;

  // Empty paragraphs right before a page break only push content onto an
  // extra blank page; drop them and let the break happen on the next block.
  function tidy(list) {
    const out = list.slice();
    for (let i = 0; i < out.length; i++) {
      if (out[i].pageBreakBefore && isEmpty(out[i]) && out[i + 1]) {
        out[i + 1] = { ...out[i + 1], pageBreakBefore: true };
        out.splice(i, 1);
        i--;
      }
    }
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i].pageBreakBefore) {
        let j = i - 1;
        while (j >= 0 && isEmpty(out[j]) && !out[j].pageBreakBefore) j--;
        out.splice(j + 1, i - j - 1);
        i = j + 1;
      }
    }
    // trailing empty paragraphs only create a blank last page
    while (out.length > 1 && isEmpty(out[out.length - 1])) out.pop();
    return out;
  }

  function blocks(list, ctx, region) {
    const out = [];
    let prev = null;
    // optional lines (e.g. "Дата госпитализации") are left out entirely when their field is empty
    for (const b of tidy((list || []).filter((x) => (!x.onlyIf || ctx.has(x.onlyIf)) && !(x.onlyIfNot && ctx.has(x.onlyIfNot))))) {
      if (b.t === 'p' && b.keepWithPrev && out.length) {
        const last = out.pop();
        const id = last.id;
        delete last.id;
        out.push({ stack: [last, paragraph(b, ctx, region, prev)], unbreakable: true, id });
      } else if (b.t === 'p') {
        const node = paragraph(b, ctx, region, prev);
        if (b.sig) node.id = 'sig';
        out.push(node);
      }
      else if (b.t === 'table') out.push(table(b, ctx, region));
      prev = b;
    }
    return out;
  }

  // rough height of header/footer content, used for page margins
  function estimateHeight(list) {
    let h = 0;
    for (const b of list || []) {
      if (b.t === 'table') {
        for (const row of b.rows) h += Math.max(...row.map((c) => estimateHeight(c.blocks)), 0) + 2;
        continue;
      }
      const fs = Math.max(b.fs || 10, ...(b.runs || []).map((r) => r.fontSize || 0));
      const text = (b.runs || []).map((r) => r.text).join('');
      const lines = text.split('\n').length;
      const inl = (b.images || []).filter((i) => !i.anchor).reduce((m, i) => Math.max(m, i.h), 0);
      h += Math.max(lines * fs * 1.17 * (b.line || 1), inl) + (b.before || 0) + (b.after || 0);
    }
    return h;
  }

  function floatingBottom(list, p) {
    let m = 0;
    for (const b of list || [])
      for (const i of b.images || [])
        if (i.anchor) {
          const y = i.anchor.v.from === 'page' ? i.anchor.v.off : p.header + i.anchor.v.off;
          m = Math.max(m, y + i.h);
        }
    return m;
  }

  function build(tpl, values, opts) {
    opts = opts || {};
    const p = tpl.page;
    const headerH = tpl.header ? Math.max(p.header + estimateHeight(tpl.header), floatingBottom(tpl.header, p) + 4) : 0;
    const footerH = tpl.footer ? p.footer + estimateHeight(tpl.footer) + 2 : 0;
    const margins = [p.left, Math.max(p.top, headerH), p.right, Math.max(p.bottom, footerH)];
    const ctx = {
      page: p,
      margins,
      images: opts.images || {},
      stamp: opts.useStamp !== false ? opts.stamp : null,
      compact: !!opts.compact,
      flow: !!opts.flow,
      expand: ((x, side) => (t) => applySide(x(t), side))(makeExpander(tpl, values || {}), values && values.side),
      has: (k) => !!(values && values[k] && String(values[k]).trim()),
      counters: {},
    };
    const images = { ...ctx.images };
    if (ctx.stamp) images.stamp = ctx.stamp;

    const content = blocks(tpl.body, ctx, 'body');
    const headerContent = tpl.header ? blocks(tpl.header, { ...ctx, counters: {} }, 'header') : null;
    const footerContent = tpl.footer ? blocks(tpl.footer, { ...ctx, counters: {} }, 'footer') : null;

    const dd = {
      pageSize: { width: p.w, height: p.h },
      pageMargins: margins,
      info: { title: opts.title || tpl.title, author: opts.author || '' },
      defaultStyle: { font: 'Arimo', fontSize: 10, lineHeight: 1 },
      images,
      header: headerContent ? () => ({ stack: headerContent, margin: [p.left, p.header, p.right, 0] }) : undefined,
      footer: footerContent ? () => ({ stack: footerContent, margin: [p.left, 0, p.right, 0] }) : undefined,
      content,
    };
    // the sheet has the standard page 2: the signature must stay on page 1
    if (tpl.body.some((b) => b.page2)) Object.defineProperty(dd, 'klPage2', { value: true });
    return dd;
  }

  // After layout (pdfmake's pages): did the doctor's signature land at the very top of a new
  // page, i.e. it spilled over on its own? Then the caller rebuilds with { compact: true }.
  function orphanSignature(pages, dd) {
    if (!pages) return false;
    const top = dd.pageMargins[1];
    const page2 = !!dd.klPage2;
    for (let i = 0; i < pages.length; i++) {
      for (const it of pages[i].items) {
        const inl = it.item && it.item.inlines;
        if (!inl) continue;
        const t = inl.map((x) => x.text).join('');
        // within the first ~3 lines of a new page = spilled over (alone or with a line or two)
        if (/Абай Канатович|Тулемисов Абай/.test(t)) return i > 0 && (page2 || it.item.y - top < 60);
      }
    }
    return false;
  }

  global.Render = { build, formatDate, BLANK, orphanSignature, sides, sideOf, applySide };
})(typeof window !== 'undefined' ? window : globalThis);
