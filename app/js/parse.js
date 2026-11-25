// Rule-based parser for dictated text (no AI, works offline).
// "хемодектома, Иванов Иван Иванович, 12.03.1975, Shamblin 2, PUMCH 3"
//   -> { templateId, values: { fio, dob, ... } }
(function (global) {
  'use strict';

  const MONTHS = [
    ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['мая', 5], ['май', 5], ['июн', 6],
    ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12],
  ];
  const MONTH_RE = '(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])';
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

  function monthNum(word) {
    const w = norm(word);
    for (const [stem, n] of MONTHS) if (w.startsWith(stem)) return n;
    return 0;
  }
  function validDate(y, m, d) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function fullYear(y) {
    y = +y;
    if (y >= 100) return y;
    const now = new Date().getFullYear() % 100;
    return y > now + 1 ? 1900 + y : 2000 + y;
  }

  // ------------------------------------------------------------ dates
  function findDates(text, today) {
    const out = [];
    const push = (index, len, y, m, d, extra) => {
      if (validDate(y, m, d)) out.push({ index, end: index + len, iso: iso(y, m, d), y, ...extra });
    };
    let m;
    const reNum = /(\d{1,2})\s*[.\/\-]\s*(\d{1,2})\s*[.\/\-]\s*(\d{2,4})/g;
    while ((m = reNum.exec(text))) push(m.index, m[0].length, fullYear(m[3]), +m[2], +m[1]);
    const reWord = new RegExp(`(\\d{1,2})(?:-?[еог]+)?\\s+${MONTH_RE}(?:\\s+(\\d{4}))?`, 'gi');
    while ((m = reWord.exec(text))) {
      if (out.some((o) => m.index >= o.index && m.index < o.end)) continue;
      const mon = monthNum(m[2]);
      let y = m[3] ? +m[3] : today.getFullYear();
      if (!m[3]) {
        // "3 декабря" without a year -> the next such date from today
        const cand = new Date(y, mon - 1, +m[1]);
        if (cand < new Date(today.getFullYear(), today.getMonth(), today.getDate())) y++;
      }
      push(m.index, m[0].length, y, mon, +m[1], { noYear: !m[3] });
    }
    // "1975 года рождения", "1975 г.р.", "рождения 1975"
    const reYear = /(?:(\d{4})\s*(?:г(?:ода?)?\.?\s*р(?:ождения)?\.?|года\s+рождения))|(?:(?:рождения|д\.?\s?р\.?)\s*[:\-]?\s*(\d{4})(?![.\/\-\d]))/gi;
    while ((m = reYear.exec(text))) {
      if (out.some((o) => m.index >= o.index - 2 && m.index < o.end + 2)) continue;
      const y = +(m[1] || m[2]);
      out.push({ index: m.index, end: m.index + m[0].length, iso: null, y, yearOnly: true, dobHint: true });
    }
    // "сегодня", "завтра"
    const reRel = /(сегодня|завтра|послезавтра)/gi;
    while ((m = reRel.exec(text))) {
      const add = { сегодня: 0, завтра: 1, послезавтра: 2 }[norm(m[1])];
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
      out.push({ index: m.index, end: m.index + m[0].length, iso: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()), y: d.getFullYear(), relative: true });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  function classifyDates(text, dates, today, hasOpdate) {
    const res = {};
    const lower = norm(text);
    let prevEnd = 0;
    for (const d of dates) {
      // context = text since the previous date (max 30 chars)
      const before = lower.slice(Math.max(prevEnd, d.index - 30), d.index);
      prevEnd = d.end;
      const after = lower.slice(d.end, d.end + 20);
      const own = lower.slice(d.index, d.end);
      let kind = null;
      if (d.dobHint || /(рожд|д\.?\s?р\.?\s*[:\-]?\s*$|г\.?\s?р)/.test(before) || /^\s*(года?\s+рожд|г\.?\s?р)/.test(after)) kind = 'dob';
      else if (/(операц|госпитализ|поступ|явк|(^|\s)на\s*$)/.test(before)) kind = hasOpdate ? 'opdate' : 'date';
      else if (/(осмотр|консульт|дата\s*$|(^|\s)от\s*$)/.test(before) || /сегодня/.test(own)) kind = 'date';
      if (!kind) {
        if (d.y && d.y <= today.getFullYear() - 1 && !res.dob) kind = 'dob';
        else if (hasOpdate && !res.opdate && d.iso && d.iso > iso(today.getFullYear(), today.getMonth() + 1, today.getDate())) kind = 'opdate';
        else kind = res.date ? (hasOpdate ? 'opdate' : 'date') : 'date';
      }
      if (res[kind]) continue;
      if (kind === 'dob' && d.yearOnly) res.dobYear = d.y;
      else res[kind] = d.iso;
    }
    return res;
  }

  // ------------------------------------------------------------ ИИН
  function findIIN(text) {
    const m = text.match(/(?<!\d)(\d[\d\s\-]{10,22}\d)(?!\d)/g) || [];
    for (const s of m) {
      const digits = s.replace(/\D/g, '');
      if (digits.length === 12) return digits;
    }
    return null;
  }
  function dobFromIIN(iin) {
    const yy = +iin.slice(0, 2);
    const mm = +iin.slice(2, 4);
    const dd = +iin.slice(4, 6);
    const c = +iin[6];
    const century = { 1: 1800, 2: 1800, 3: 1900, 4: 1900, 5: 2000, 6: 2000 }[c];
    if (!century) return null;
    const y = century + yy;
    return validDate(y, mm, dd) ? iso(y, mm, dd) : null;
  }

  // ------------------------------------------------------------ ФИО
  const STOP = new Set(
    ('пациент пациентка пациента больной больная фио ф.и.о год года рождения дата диагноз код операции операция ' +
      'шаблон лист консультативный на от и с в по справа слева др г.р. г р сегодня завтра послезавтра ' +
      'январь января февраль февраля март марта апрель апреля май мая июнь июня июль июля август августа сентябрь сентября ' +
      'октябрь октября ноябрь ноября декабрь декабря тип степень иин shamblin pumch дневной круглосуточный стационар')
      .split(/\s+/)
  );
  const SURNAME = /(ов|ев|ёв|ин|ын|ова|ева|ёва|ина|ына|ский|ская|цкий|цкая|енко|ук|юк|ян|дзе|швили|бек|беков|бекова|баев|баева|улы|кызы|уулу)$/i;
  const cap = (w) => w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');

  function findFIO(text, keywordWords) {
    const words = [];
    const re = /[A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі\-]+/g;
    let m;
    while ((m = re.exec(text))) words.push({ w: m[0], i: m.index, end: m.index + m[0].length });
    const isNameWord = (x) => {
      const n = norm(x.w);
      return x.w.length >= 2 && /[а-яәғқңөұүһі]/i.test(x.w) && !STOP.has(n) && !keywordWords.some((k) => n.startsWith(k)) && !/^\d/.test(n);
    };
    const contiguous = (a, b) => /^[\s]*$/.test(text.slice(a.end, b.i));
    const take = (start) => {
      const out = [words[start]];
      for (let j = start + 1; j < words.length && out.length < 3; j++) {
        if (!contiguous(words[j - 1], words[j]) || !isNameWord(words[j])) break;
        out.push(words[j]);
      }
      return out;
    };
    // 1. after an explicit marker
    for (let i = 0; i < words.length; i++) {
      if (/^(пациент|пациентка|пациента|фио|больной|больная)$/i.test(norm(words[i].w)) && words[i + 1] && isNameWord(words[i + 1])) {
        const t = take(i + 1);
        if (t.length >= 2) return t.map((x) => cap(x.w)).join(' ');
      }
    }
    // 2. a run of Capitalised words that looks like a name
    for (let i = 0; i < words.length; i++) {
      if (!isNameWord(words[i]) || !/^[А-ЯЁӘҒҚҢӨҰҮҺІ]/.test(words[i].w)) continue;
      const t = take(i).filter((x) => /^[А-ЯЁӘҒҚҢӨҰҮҺІ]/.test(x.w));
      if (t.length >= 2) return t.map((x) => cap(x.w)).join(' ');
    }
    // 3. lowercase text: a word with a surname ending followed by 1–2 name words
    for (let i = 0; i < words.length; i++) {
      if (isNameWord(words[i]) && SURNAME.test(words[i].w) && words[i + 1] && isNameWord(words[i + 1])) {
        return take(i).map((x) => cap(x.w)).join(' ');
      }
    }
    return null;
  }

  // ------------------------------------------------------------ sound-alike matching
  // Speech recognition (esp. Apple's) mishears medical terms: «гемодектома», «хемо дектома»,
  // «кемодиктома»… We compare a rough phonetic skeleton and allow 1–2 letter differences.
  const PH = { г: 'к', х: 'к', д: 'т', б: 'п', з: 'с', ц: 'с', в: 'ф', ж: 'ш', щ: 'ш', ч: 'ш', о: 'а', я: 'а',
    е: 'и', ы: 'и', э: 'и', й: 'и', ю: 'у', ь: '', ъ: '' };
  function phon(s) {
    let o = '';
    for (const ch of norm(s)) {
      const c = ch in PH ? PH[ch] : ch;
      if (c && c !== o[o.length - 1]) o += c;
    }
    return o;
  }
  function lev(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  }
  // does a (stem) keyword part sound like the start of some word (or two joined words) of the text?
  function soundsLike(words, part) {
    const p = phon(part);
    if (p.length < 5) return false; // short keywords (эма, хан, порт…) must match exactly
    const tol = p.length >= 9 ? 2 : 1;
    for (let i = 0; i < words.length; i++) {
      for (const w of [words[i], words[i] + (words[i + 1] || '')]) {
        for (let L = p.length - tol; L <= Math.min(w.length, p.length + tol); L++) if (lev(w.slice(0, L), p) <= tol) return true;
      }
    }
    return false;
  }

  // Typical mishearings of medical words by phone speech recognition (Apple / Google)
  const HEARD_FIX = [
    [/кредитн/gi, 'каротидн'],
    [/х[иеэ]д[иеэ]\s*том/gi, 'хемодектом'],
  ];
  function fixHeard(text) {
    let s = HEARD_FIX.reduce((acc, [re, to]) => acc.replace(re, to), text);
    // the whole phrase said/sent twice ("А Б А Б") -> once
    const w = s.trim().split(/\s+/);
    if (w.length >= 2 && w.length % 2 === 0 && norm(w.slice(0, w.length / 2).join(' ')) === norm(w.slice(w.length / 2).join(' '))) s = w.slice(0, w.length / 2).join(' ');
    return s;
  }

  // Phrases the user taught the app: { p: 'кредитная хиде тома', id: '<template id>' }
  const LEARN_STOP = /^(пациент\S*|больн\S*|года?|лет|рождени\S*|лист\S*|консультативн\S*|шаблон\S*|дата|фио|справа|слева|прав\S*|лев\S*|сегодня|завтра|операц\S*|госпитализ\S*|на|от|и|в|с)$/;
  const NUM_WORD = /^(перв|втор|трет|четв|пят|шест|седьм|восьм|девят|десят|одиннад|двенад|тринад|четырнад|пятнад|шестнад|семнад|восемнад|девятнад|двадцат|тридцат|сорок|сто|двест|трист|тысяч|двухтысяч|ноль|нул)/;
  const stem = (w) => w.slice(0, Math.max(4, w.length - 2));
  function learnPhrase(text, result) {
    let t = ' ' + norm(fixHeard(text)) + ' ';
    if (result && result.values && result.values.fio) for (const w of norm(result.values.fio).split(/\s+/)) t = t.split(w).join(' ');
    t = t.replace(new RegExp(MONTH_RE, 'g'), ' ').replace(/[^a-zа-яәғқңөұүһі\s-]/g, ' ');
    const words = t.split(/\s+/).filter((w) => w.length >= 3 && !LEARN_STOP.test(w) && !NUM_WORD.test(w));
    return [...new Set(words)].slice(0, 6).join(' ');
  }
  function learnedMatch(text, learned) {
    const t = norm(text);
    return (learned || []).filter((l) => l.p && l.p.split(' ').every((w) => t.includes(stem(w))));
  }

  // ------------------------------------------------------------ template choice
  function scoreTemplates(text, index, learned) {
    const taught = learnedMatch(text, learned);
    const full = norm(text);
    // words dictated after "диагноз" describe the disease, not the template name
    const cut = full.search(/диагноз/);
    const t = cut > 0 ? full.slice(0, cut) : full;
    const tail = cut > 0 ? full.slice(cut) : '';
    const words = t.split(/[^a-zа-я0-9]+/).filter(Boolean).map(phon);
    const scored = index.map((tpl) => {
      let s = 0;
      for (const k of tpl.keywords || []) {
        const parts = norm(k).split(/\s+/);
        if (parts.every((p) => t.includes(p))) s += k.length + parts.length * 2;
        else if (parts.every((p) => t.includes(p) || soundsLike(words, p))) s += (k.length + parts.length * 2) * 0.6;
        else if (tail && parts.every((p) => tail.includes(p))) s += (k.length + parts.length * 2) * 0.3;
      }
      if (/дневн/.test(t) && tpl.group === 'ds') s += 3;
      if (/круглосуточ/.test(t) && tpl.group === 'ks') s += 3;
      if (/платн/.test(t) && tpl.group === 'paid') s += 5;
      for (const l of taught) if (l.id === tpl.id) s += 50 + l.p.length;
      return { id: tpl.id, title: tpl.title, score: s };
    });
    return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------ Shamblin / PUMCH etc.
  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
  const WORDNUM = { один: 1, первый: 1, первая: 1, два: 2, второй: 2, вторая: 2, три: 3, третий: 3, третья: 3, четыре: 4, четвертый: 4, четвертая: 4 };
  function findGrades(text, tpl) {
    const res = {};
    if (!tpl || !tpl.aliases) return res;
    const t = norm(text);
    for (const f of tpl.fields || []) {
      if (!f.fillin) continue;
      const head = f.label.split(' — ')[0];
      const aliases = (tpl.aliases[head] || [head]).map(norm);
      for (const a of aliases) {
        const re = new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:тип|степень|класс)?\\s*[:\\-]?\\s*([ivx]+|\\d|один|два|три|четыре|перв\\S*|втор\\S*|трет\\S*|четверт\\S*)\\s*([abаб])?(?![a-zа-я])', 'i');
        const m = t.match(re);
        if (m) {
          let n = m[1];
          const num = /^\d$/.test(n) ? +n : WORDNUM[n] || WORDNUM[Object.keys(WORDNUM).find((k) => n.startsWith(k.slice(0, 4)))];
          let v = num ? ROMAN[num] : n.toUpperCase();
          if (m[2]) v += { а: 'a', б: 'b' }[m[2]] || m[2];
          res[f.key] = v;
          break;
        }
      }
    }
    return res;
  }

  // ------------------------------------------------------------ main
  function parse(text, index, getTemplate, today, learned) {
    today = today || new Date();
    text = fixHeard(text);
    const result = { values: {}, notes: [], candidates: [], text };
    const candidates = scoreTemplates(text, index, learned);
    result.candidates = candidates.slice(0, 4);
    result.templateId = candidates[0] ? candidates[0].id : null;
    if (candidates[1] && candidates[1].score === candidates[0].score) result.ambiguous = true;
    const tpl = result.templateId && getTemplate ? getTemplate(result.templateId) : null;
    const hasOpdate = !tpl || (tpl.fields || []).some((f) => f.key === 'opdate');

    const keywordWords = [];
    for (const t of index) for (const k of t.keywords || []) keywordWords.push(...norm(k).split(/\s+/).filter((w) => w.length >= 3));
    for (const l of learned || []) keywordWords.push(...(l.p || '').split(' ').filter((w) => w.length >= 3).map(stem));

    const iin = findIIN(text);
    // remove the IIN digits before looking for dates
    const textNoIIN = iin ? text.replace(/(?<!\d)\d[\d\s\-]{10,22}\d(?!\d)/, (s) => ' '.repeat(s.length)) : text;
    const dates = classifyDates(textNoIIN, findDates(textNoIIN, today), today, hasOpdate);
    if (iin) result.values.iin = iin;
    if (dates.dob) result.values.dob = dates.dob;
    else if (iin && dobFromIIN(iin)) result.values.dob = dobFromIIN(iin);
    else if (dates.dobYear) result.notes.push(`Год рождения ${dates.dobYear} — уточните день и месяц`);
    if (dates.date) result.values.date = dates.date;
    if (dates.opdate) result.values.opdate = dates.opdate;
    if (dates.dobYear && !result.values.dob) result.dobYear = dates.dobYear;

    const fio = findFIO(text, keywordWords);
    if (fio) result.values.fio = fio;

    const lower = norm(text);
    // (\b does not work with Cyrillic in JS regular expressions)
    const L = /слева|левой|левая|левую/.test(lower);
    const R = /справа|правой|правая|правую/.test(lower);
    if (L && !R) result.side = 'left';
    if (R && !L) result.side = 'right';

    Object.assign(result.values, findGrades(text, tpl));

    // explicit diagnosis / operation code
    const dx = text.match(/диагноз\s*[:\-]?\s*(.+?)(?=\s*(?:,?\s*код операции|,?\s*операция|,?\s*дата|,?\s*на\s+\d|$))/i);
    if (dx && dx[1].trim().length > 3) result.values.diagnosis = dx[1].trim().replace(/[,.]$/, '');
    const op = text.match(/код\s+операции\s*[:\-]?\s*(\d{2}\s*[.,]\s*\d{1,4})/i);
    if (op) result.opCode = op[1].replace(/\s/g, '').replace(',', '.');
    return result;
  }

  // Apply side ("справа"/"слева") to a diagnosis text
  function applySide(text, side) {
    if (!text || !side) return text;
    const swap = side === 'left'
      ? [[/справа/g, 'слева'], [/Справа/g, 'Слева'], [/правой/g, 'левой'], [/правая/g, 'левая']]
      : [[/слева/g, 'справа'], [/Слева/g, 'Справа'], [/левой/g, 'правой'], [/левая/g, 'правая']];
    return swap.reduce((s, [re, to]) => s.replace(re, to), text);
  }

  // Parse a single spoken date for a date field: "12 марта 1975", "12.03.75"
  function parseOneDate(text, today) {
    const d = findDates(text, today || new Date()).find((x) => x.iso);
    return d ? d.iso : null;
  }

  global.Parse = { parse, applySide, parseOneDate, dobFromIIN, learnPhrase, fixHeard };
})(typeof window !== 'undefined' ? window : globalThis);
