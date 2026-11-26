// Content edits agreed with the doctor, applied to every converted template (after the standard
// page 2 is added). Keeping them here means re-importing the Word files never loses them.
const path = require('path');
const PDFDocument = require('@foliojs-fork/pdfkit');

const RED = '#B14A4A';
const textOf = (b) => (b.runs || []).map((r) => r.text || '').join('');
const isBand = (b) => b && b.t === 'p' && !!b.fill;
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- per-sheet diagnosis / operation
// Side words (правой/левой, справа/слева, с обеих сторон) follow the «Сторона» switch on SIDE_SHEETS.
// Sheets with the «Сторона» switch (agreed with the doctor); every other sheet has none.
const SIDE_SHEETS = [
  'portal-oir-ks-balloonangioplasty',
  'portal-oir-ks-renalarterystenting',
  'portal-oir-ks-stenting-sublavia',
  'portal-oir-ks-spsh',
  'portal-oir-ks-patologicheskaya-izvitost-a-carotica-internaa',
  'portal-oir-ks-karotidnaya-endarterektomiya',
  'portal-oir-ks-hemodektoma',
  'portal-oir-ks-varikocele',
  'portal-oir-ks-vbvt',
  'portal-oir-ks-vbnk',
  'portal-oir-ds-vbnk',
  'platno-oir-ds',
  'portal-oir-ks-gae',
];
const DEFAULTS = {
  'portal-oir-ks-renalarterystenting': {
    diagnosis: 'I70.1 – Атеросклероз. Стеноз правой почечной артерии. Вазоренальная гипертензия.',
    operation: '39.764 – Стентирование правой почечной артерии',
  },
  'portal-oir-ks-port-sistema': { diagnosis: '' },
  'portal-oir-ks-spsh': {
    diagnosis: 'I70.2 – Окклюзия левой подключичной артерии.',
    operation: '39.2 – Сонно-подключичное шунтирование слева',
  },
  'portal-oir-ks-balloonangioplasty': {
    diagnosis: 'I70.2 – Атеросклероз артерий нижних конечностей.',
    operation: '39.793 – Баллонная ангиопластика',
  },
  'portal-oir-ks-vbnk': {
    diagnosis: 'I83.1 – ВБНК. Варикозное расширение большой подкожной вены справа. C4.',
    operation: '39.7900 – Радиочастотная абляция большой подкожной вены справа (РЧА БПВ)',
  },
  'portal-oir-ks-karotidnaya-endarterektomiya': {
    diagnosis: 'I65.2 – Атеросклероз. Критический стеноз правой внутренней сонной артерии. ХСМН.',
    operation: '38.121 – Каротидная эндартерэктомия из правой ВСА',
  },
  'portal-oir-ks-hemodektoma': { operation: '38.621 – Эмболизация каротидной хемодектомы справа с её последующей резекцией' },
  'portal-oir-ks-gae': { operation: '39.794 – Эмболизация коленных артерий с обеих сторон.' },
  'platno-oir-ds': { diagnosis: 'Варикозная болезнь. Первичное варикозное расширение вен нижних конечностей с обеих сторон. CEAP: С3S, Еp, Аs, Рr, L1.' },
  'portal-oir-ks-stenting-sublavia': {
    diagnosis: 'I70.2 – Стеноз левой подключичной артерии.',
    operation: '39.792 – Стентирование левой подключичной артерии',
  },
  'portal-oir-ks-vrozhdennaya-avm': {
    diagnosis: 'Q27.8 – Артериовенозная мальформация',
    operation: '39.794 – Эмболизация АВМ',
  },
  'portal-oir-ks-vbvt': {
    diagnosis: 'I86.2 – Варикозная болезнь вен таза. Синдром тазовой венозной конгестии.',
    operation: '39.7944 – Эмболизация левой яичниковой вены',
  },
  'portal-oir-ks-varikocele': {
    diagnosis: 'I86.1 – Варикоцеле слева.',
    operation: '39.7944 – Эмболизация левой яичковой вены',
  },
  'portal-oir-ks-patologicheskaya-izvitost-a-carotica-internaa': {
    diagnosis: 'I65.2 – Патологическая извитость правой внутренней сонной артерии.',
    operation: '38.121 – Редрессация правой внутренней сонной артерии',
  },
  'portal-oir-ks-thpn-avf': { diagnosis: 'N18.0 – Терминальная хроническая почечная недостаточность.' },
  'portal-oir-ds-vbnk': {
    diagnosis: 'I83.9 – Варикозная болезнь нижних конечностей. Варикозное расширение подкожных вен нижних конечностей с обеих сторон. CEAP: C3s Ep As Pr.',
    operation: '39.92 Эндовенозная лазерная коагуляция с обеих сторон',
  },
  'portal-oir-ds-sklero': { operation: '39.92 Склеротерапия ретикулярных вен и телеангиоэктазий нижних конечностей' },
};

// ---------------------------------------------------------------- text fixes (page 1)
const TEXT_FIXES = [
  [/!!!/g, ''],
  [/направляются с поликлиник/g, 'направляются из поликлиник'],
  [/операционного лечения/g, 'оперативного лечения'],
  [/«портал Бюро Госпитализации»/g, 'портал «Бюро Госпитализации»'],
  [/(\S?)\s*Замена ЧЧХС\s*$/g, (m, c) => (c ? c + ' ' : '') + '(замена ЧЧХС).'],
  [/Профиль койки/g, 'профиль койки'],
  [/"Селективная флебография (.*?)"\s*\.\s*\(МКБ 10 - Q 27\.3, Код операции - 39\.794\.\)\./, '«Селективная флебография $1» (МКБ 10 – Q27.3, код операции – 39.794).'],
  [/(\S) {2,}(?=\S)/g, '$1 '],
];
// the same sentence twice in a row: "…по месту жительства. Для оформления … выписку из амбулаторной карты" + the full one
const DUP_TAIL = /\s*Для оформления госпитализации необходимо направить выписку из амбулаторной карты\s*$/;

// ---------------------------------------------------------------- analyses table
const ROW_FIX = [
  [/^Б\/хАК/, 'Биохимический анализ крови'],
  [/^(ФЛГ|Флюорография ОГК|Флюорография)$/, 'Флюорография органов грудной клетки'],
  [/^Маркеры вирусных гепатитов B и C/, 'Кровь на маркеры вирусных гепатитов В и С'],
  [/\(\+ контраст\)/, 'с контрастированием'],
  [/резус фактор/g, 'резус-фактор'],
  [/Рентге\/МРТ-ангиография коленных суставов/, 'Рентгенография/МРТ коленных суставов'],
  [/([а-я]ых) артерии/g, '$1 артерий'],
  [/; артерии/g, '; артерий'],
  [/АЛТ, АСТ/g, 'АлТ, АсТ'],
  [/\s*;\s*$/, ''],
  [/\s*\.\s*$/, ''],
  [/\s{2,}/g, ' '],
  [/,\s*,/g, ','],
];
const ROW_FOR = {
  'portal-oir-ks-renalarterystenting': [
    [/^УЗДГ артерий нижних конечностей.*/, 'УЗДГ сосудов почек'],
    [/^КТ грудной и брюшной аорты.*/, 'КТ-ангиография брюшной аорты и почечных артерий с контрастированием'],
  ],
  'portal-oir-ks-spsh': [[/^КТ грудной и брюшной аорты.*/, 'КТ-ангиография брахиоцефальных артерий и дуги аорты с контрастированием']],
  'portal-oir-ks-port-sistema': [[/\s*\(при наличии диуреза\)/, '']],
};
// rows that must not be on a sheet
const ROW_DROP = { 'portal-oir-ks-gae': /ФГДС|гастроскоп/i };
function term(s) {
  s = s.trim().replace(/^(не более|до)\s*/i, '').replace(/-го/, '');
  const m = s.match(/^(\d+)\s*(дн|мес)/i);
  if (!m) return s ? 'до ' + s : '';
  const n = +m[1];
  if (/^дн/i.test(m[2])) return `до ${n} ${n % 10 === 1 && n !== 11 ? 'дня' : 'дней'}`;
  return `до ${n} ${n === 1 ? 'месяца' : 'месяцев'}`;
}
// "Общий анализ крови (не более 14 дней);" -> ["Общий анализ крови", "до 14 дней"]
function splitItem(t) {
  const m = t.match(/^(.*?)[;\s]*\(((?:не более|до)[^)]*)\)\s*[;.]?\s*$/i);
  return m ? [m[1], term(m[2])] : [t, ''];
}
function normRow(id, name, due) {
  for (const [re, to] of ROW_FIX) name = name.replace(re, to);
  for (const [re, to] of ROW_FOR[id] || []) name = name.replace(re, to);
  name = name.trim();
  due = term(due || '');
  if (/^ЭХОКГ|эхокардиограф/i.test(name)) due = 'до 30 дней';
  if (/^Осмотр терапевта/i.test(name)) due = 'до 30 дней';
  return [name, due];
}
function cellText(c) {
  return (c.blocks || []).map(textOf).join(' ').trim();
}
function analysesTable(tpl) {
  const body = tpl.body;
  const band = body.findIndex((b) => isBand(b) && /анализ/i.test(textOf(b)));
  if (band < 0) return;
  let rows = [];
  let end = band + 1;
  let fs = 12;
  if (body[end] && body[end].t === 'table') {
    const t = body[end];
    for (const r of t.rows) {
      const cells = r.map(cellText);
      // [№, name, term] or [name, term]
      const name = cells.length >= 3 ? cells[1] : cells[0];
      const due = cells.length >= 3 ? cells[2] : cells[1] || '';
      if (name) rows.push([name, due]);
      const f = r.flatMap((c) => c.blocks || []).find((b) => b.fs);
      if (f) fs = f.fs;
    }
    end++;
  } else {
    while (body[end] && body[end].num) {
      const t = textOf(body[end]).trim();
      if (t) rows.push(splitItem(t));
      fs = body[end].fs || fs;
      end++;
    }
  }
  if (!rows.length) return;
  rows = rows.map(([n, d]) => normRow(tpl.id, n, d));
  if (ROW_DROP[tpl.id]) rows = rows.filter(([n]) => !ROW_DROP[tpl.id].test(n));
  const colW = tpl.page.w - tpl.page.left - tpl.page.right;
  const p = (text) => ({ t: 'p', runs: text ? [{ text, fontSize: fs }] : [], fs, after: 0, line: 1 });
  const table = {
    t: 'table',
    widths: [24, colW - 24 - 96, 96],
    rows: rows.map(([name, due], i) => {
      const border = [false, i > 0, false, true];
      return [
        { col: 0, span: 1, border, blocks: [p(String(i + 1))] },
        { col: 1, span: 1, border, blocks: [p(name)] },
        { col: 2, span: 1, border, blocks: [p(due)] },
      ];
    }),
  };
  body.splice(band + 1, end - band - 1, table);
}

// ---------------------------------------------------------------- date at the top
function dateOnTop(tpl) {
  const body = tpl.body;
  const sig = body.findIndex((b) => b.sig);
  // "Дата: …" lines under the signature go
  for (let i = body.length - 1; i > sig; i--) if (/^Дата:\s*\{\{date/.test(textOf(body[i]).trim())) body.splice(i, 1);
  if (JSON.stringify(body.slice(0, sig)).includes('{{date')) {
    // "Дата: dd.MM.yyyy" at the top -> "Дата осмотра: 25 ноября 2026 г."
    const b = body.find((x) => /^Дата(?: осмотра)?:\s*\{\{date/.test(textOf(x).trim()));
    if (b) b.runs = [{ text: 'Дата осмотра: ', bold: true, fontSize: b.fs || 12 }, { text: "{{date|d MMMM yyyy 'г.'}}", fontSize: b.fs || 12 }];
    return;
  }
  const fio = body.find((x) => /^Ф\.И\.О\./.test(textOf(x).trim()) && x.t === 'p');
  if (!fio) return;
  const d = clone(fio);
  d.runs = [{ text: 'Дата осмотра: ', bold: true, fontSize: fio.fs || 12 }, { text: "{{date|d MMMM yyyy 'г.'}}", fontSize: fio.fs || 12 }];
  delete d.onlyIf;
  body.splice(body.indexOf(fio), 0, d);
}

// ---------------------------------------------------------------- arrival (round-the-clock hospital)
const ARRIVAL = 'Явка на госпитализацию: с 08:30 до 12:00, приёмное отделение (блок 1А) клинической базы «Ана мен Бала» КФ UMC, г. Астана, ул. Туран, 32.';
function arrival(tpl) {
  const b = tpl.body.find((x) => /^Явка на госпитализацию/.test(textOf(x).trim()));
  if (b) b.runs = [{ text: ARRIVAL, bold: true, fontSize: b.fs || 12 }];
}

// ---------------------------------------------------------------- closing notes after the analyses (round-the-clock hospital)
const CLOSE_1 = 'При патологическом изменении параметров в анализах или исследованиях – дополнительная консультация профильных специалистов и проведение лечения;';
const CLOSE_2 = 'При отсутствии анализов (параметров) или исследований – принимающий доктор вправе отказать в госпитализации в стационар, а талон на госпитализацию – аннулируется.';
function closingNotes(tpl) {
  const body = tpl.body;
  const ti = body.findIndex((b) => b.t === 'table' && b.rows.length > 5);
  const ai = body.findIndex((b) => /^Явка на госпитализацию/.test(textOf(b).trim()));
  if (ti < 0 || ai < ti) return;
  const keep = [];
  for (let i = ti + 1; i < ai; i++) {
    const t = textOf(body[i]).trim();
    if (t && !/^При (наличии|выявлении|патологическом|отсутствии)/.test(t)) keep.push(t);
  }
  const p = (text) => ({ t: 'p', runs: [{ text, fontSize: 12 }], fs: 12, align: 'justify', left: 0, before: 6, after: 0, line: 1 });
  body.splice(ti + 1, ai - ti - 1, p(CLOSE_1), ...keep.map(p), p(CLOSE_2));
}

// ---------------------------------------------------------------- signature line
let pdf;
function width(text, bold, fs) {
  pdf = pdf || new PDFDocument({ autoFirstPage: false });
  const f = path.join(__dirname, '..', 'app', 'fonts', bold ? 'Arimo-Bold.ttf' : 'Arimo-Regular.ttf');
  return pdf.font(f).fontSize(fs).widthOfString(text);
}
const SIG_PRE = 'Врач-ангиохирург: ';
const SIG_LINE = '____________________';
const SIG_NAME = ' Абай Канатович Тулемисов';
function signature(tpl) {
  const body = tpl.body;
  const i = body.findIndex((b) => b.sig);
  if (i < 0) return;
  const s = body[i];
  const fs = 12;
  const colW = tpl.page.w - tpl.page.left - tpl.page.right;
  const full = width(SIG_PRE + SIG_LINE + SIG_NAME, true, fs);
  const start = colW - full + width(SIG_PRE, true, fs); // right-aligned: where the line starts
  const lineW = width(SIG_LINE, true, fs);
  s.runs = [{ text: SIG_PRE + SIG_LINE + SIG_NAME, bold: true, fontSize: fs }];
  s.align = 'right';
  s.left = 0;
  s.fs = fs;
  s.images = [{ stamp: true, w: 86, h: 86, anchor: { h: { from: 'column', off: Math.round(start + lineW / 2 - 43) }, v: { from: 'paragraph', off: -36 }, behind: true }, at: 0 }];
  // "(подпись, печать)" centred under the line
  let j = i + 1;
  while (body[j] && body[j].keepWithPrev && /подпись/.test(textOf(body[j]))) body.splice(j, 1);
  body.splice(i + 1, 0, {
    t: 'p',
    runs: [{ text: '(подпись, печать)', fontSize: 9, italics: true }],
    fs: 9,
    align: 'center',
    left: Math.round(start),
    right: Math.round(colW - start - lineW),
    before: 3,
    after: 0,
    line: 1,
    keepWithPrev: true,
  });
}

// ---------------------------------------------------------------- child sheet: page 2 for children
function childPage2(tpl) {
  const body = tpl.body;
  const p2 = body.findIndex((b) => b.page2);
  if (p2 < 0) return;
  const part = body.slice(p2);
  const rulesBand = part.find((b) => isBand(b) && /Правила/.test(textOf(b)));
  const thingsBand = part.find((b) => isBand(b) && /вещи/.test(textOf(b)));
  const rule = part.find((b) => b.num && b.left && !isBand(b));
  const note = part.find((b) => !b.num && !isBand(b) && /^\(/.test(textOf(b).trim()));
  const item = part.filter((b) => b.num).pop();
  const intro = part.find((b) => /необходимо иметь при себе/i.test(textOf(b)));
  const tail = part[part.length - 1];
  const R = (t) => ({ ...clone(rule), runs: [{ ...(rule.runs[0] || {}), text: t }] });
  const N = (t) => ({ ...clone(note), runs: [{ ...(note.runs[0] || {}), text: t }] });
  const I = (t) => ({ ...clone(item), runs: [{ ...(item.runs[0] || {}), text: t }] });
  const out = [
    { ...clone(rulesBand), pageBreakBefore: true, page2: true },
    R('Ногти ребёнка должны быть коротко подстрижены, без декоративного покрытия'),
    N('(необходимо для соблюдения инфекционной безопасности и визуального контроля кожных покровов).'),
    R('Ношение украшений, часов и пирсинга запрещено'),
    N('(риск инфицирования и потери личных вещей).'),
    R('Законный представитель обязан иметь при себе оригиналы медицинских документов и результаты обследований ребёнка'),
    N('(необходимы для подтверждения показаний, оценки рисков и допуска к оперативному лечению).'),
    R('Администрация отделения не несёт ответственности за сохранность личных ценных вещей'),
    clone(thingsBand),
    { ...clone(intro), runs: [{ ...(intro.runs[0] || {}), text: 'Необходимо иметь при себе:' }] },
    I('Свидетельство о рождении (удостоверение личности) ребёнка и документ, удостоверяющий личность законного представителя;'),
    I('Направление на госпитализацию и результаты обследований (оригиналы);'),
    I('Постоянно принимаемые ребёнком лекарственные препараты с указанием дозировок;'),
    I('Личные столовые принадлежности (кружка, ложка);'),
    I('Средства личной гигиены (для детей раннего возраста — подгузники, влажные салфетки);'),
    I('Сменную удобную одежду и тапочки для ребёнка и сопровождающего.'),
    clone(tail),
  ];
  body.splice(p2, body.length - p2, ...out);
}

// ---------------------------------------------------------------- entry
function editContent(tpl) {
  const id = tpl.id;
  const d = DEFAULTS[id] || {};
  for (const f of tpl.fields) {
    if (d[f.key] !== undefined) f.default = d[f.key];
    // one way to write a code: "I70.2 – Название", "39.93 – Название"
    if ((f.key === 'diagnosis' || f.key === 'operation') && f.default)
      f.default = f.default.replace(/^\(?([A-ZА-ЯЁ]?\d{1,3}(?:\.\d+)?)\.?\)?\s*[-–]?\s+(?=[А-ЯЁA-Z(])/, '$1 – ');
  }

  const p2 = tpl.body.findIndex((b) => b.page2);
  const page1 = p2 < 0 ? tpl.body : tpl.body.slice(0, p2);
  for (const b of page1) {
    if (b.t !== 'p' || b.sig || !b.runs) continue;
    for (const r of b.runs) if (r.text) for (const [re, to] of TEXT_FIXES) r.text = r.text.replace(re, to);
    // drop the half-sentence that is repeated in full right below
    const t = textOf(b);
    if (DUP_TAIL.test(t)) {
      let keep = t.replace(DUP_TAIL, '').length;
      for (const r of b.runs) {
        const n = (r.text || '').length;
        r.text = (r.text || '').slice(0, Math.max(0, keep));
        keep -= n;
      }
      b.runs = b.runs.filter((r) => r.text);
    }
  }
  // "г. Астана, ул. Туран д. 32." on a line of its own -> joined to the sentence above
  for (let i = 1; i < tpl.body.length; i++) {
    const b = tpl.body[i];
    if (/^г\. Астана, ул\. Туран д\. 32\.?$/.test(textOf(b).trim()) && tpl.body[i - 1].runs) {
      const prev = tpl.body[i - 1];
      const last = prev.runs[prev.runs.length - 1];
      last.text = last.text.replace(/\.?\s*$/, ', г. Астана, ул. Туран, 32.');
      tpl.body.splice(i, 1);
    }
  }
  // no phone number in the footer
  if (tpl.footer) tpl.footer = tpl.footer.filter((b) => !/^Тел\.?:/.test(textOf(b).trim()));
  analysesTable(tpl);
  // no blank line right after the analyses table
  const ti = tpl.body.findIndex((b) => b.t === 'table' && b.rows.length > 5);
  while (ti >= 0 && tpl.body[ti + 1] && tpl.body[ti + 1].t === 'p' && !textOf(tpl.body[ti + 1]).trim() && !tpl.body[ti + 1].images && !tpl.body[ti + 1].sig)
    tpl.body.splice(ti + 1, 1);
  if (tpl.group === 'ks') dateOnTop(tpl);
  if (tpl.group === 'ks' && id !== 'portal-oir-ks-detskie') {
    arrival(tpl);
    closingNotes(tpl);
  }
  signature(tpl);
  if (id === 'portal-oir-ks-detskie') childPage2(tpl);
  tpl.sideAware = SIDE_SHEETS.includes(id);
  if (id === 'portal-oir-ks-balloonangioplasty') tpl.dxBuilder = 'limb';
}

module.exports = { editContent };
