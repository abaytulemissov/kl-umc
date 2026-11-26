(function () {
  'use strict';

  const VERSION = '0.8.1';
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...children) => {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const isPhone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // the live preview column is shown only on wide screens (see style.css)
  const wideScreen = () => !matchMedia('(max-width: 999px)').matches;
  const syncWide = () => document.body.classList.toggle('wide', wideScreen());

  const state = {
    index: [],
    cache: {},
    tpl: null,
    values: {},
    images: {},
    blob: null,
    blobKey: '',
    stamp: store.get('stamp', null),
    folder: store.get('folder', null), // the template section open on the home screen
  };

  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 3000);
  }

  // =============================================================== loading
  async function loadIndex() {
    const r = await fetch('templates/index.json', { cache: 'no-cache' });
    state.index = await r.json();
  }
  async function loadTemplate(id) {
    if (state.cache[id]) return state.cache[id];
    const r = await fetch(`templates/${id}.json`);
    if (!r.ok) throw new Error('Шаблон не найден: ' + id);
    return (state.cache[id] = await r.json());
  }
  function toBase64(buf) {
    let s = '';
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const blobToDataURL = (b) =>
    new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(b);
    });

  async function loadFonts() {
    const files = { normal: 'Arimo-Regular.ttf', bold: 'Arimo-Bold.ttf', italics: 'Arimo-Italic.ttf', bolditalics: 'Arimo-BoldItalic.ttf' };
    const vfs = {};
    await Promise.all(
      Object.values(files).map(async (f) => {
        const r = await fetch('fonts/' + f);
        vfs[f] = toBase64(await r.arrayBuffer());
      })
    );
    pdfMake.vfs = vfs;
    pdfMake.fonts = { Arimo: files };
  }

  async function imagesFor(tpl) {
    const srcs = new Set();
    (function walk(o) {
      if (o && typeof o === 'object') {
        if (typeof o.src === 'string') srcs.add(o.src);
        for (const k in o) walk(o[k]);
      }
    })(tpl);
    await Promise.all(
      [...srcs]
        .filter((s) => !state.images[s])
        .map(async (s) => {
          const r = await fetch(s);
          state.images[s] = await blobToDataURL(await r.blob());
        })
    );
    const out = {};
    for (const s of srcs) if (state.images[s]) out[s] = state.images[s];
    return out;
  }

  // =============================================================== speech
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let activeRec = null;
  function dictate(btn, { onResult, onEnd, continuous }) {
    if (!SR) {
      toast('Голосовой ввод в этом браузере недоступен — используйте микрофон на клавиатуре телефона', 5000);
      return;
    }
    if (activeRec) {
      // the same mic again = "stop"; another mic = drop the old session (it may be stuck on iOS) and start this one
      if (activeRec.btn === btn) {
        activeRec.stop();
        return;
      }
      activeRec.abort();
    }
    // Phones (esp. iPhone Safari) stop listening after every pause. For "continuous" dictation we
    // silently restart recognition until the user taps the mic again or stays silent twice in a row.
    const join = (a, b) => [a, b].map((s) => (s || '').trim()).filter(Boolean).join(' ');
    const low = (s) => (s || '').trim().toLowerCase();
    // iOS Safari re-sends the same phrase (as final + interim, or again after a restart): drop repeats
    const merge = (a, b) => {
      if (!low(b)) return (a || '').trim();
      if (!low(a)) return b.trim();
      if (low(a).endsWith(low(b))) return a.trim();
      if (low(b).startsWith(low(a))) return b.trim();
      return join(a, b);
    };
    let committed = ''; // text from finished recognition runs
    let runs = 0;
    let silentRuns = 0;
    let cur = null;
    let done = false;
    let watchdog = null;
    let pending = ''; // heard in the current run but not yet committed (iOS may never send onend)
    const session = {
      btn,
      userStop: false,
      stop() {
        this.userStop = true;
        try { cur && cur.stop(); } catch (e) {}
        // iOS sometimes never reports the end — close the session ourselves
        clearTimeout(watchdog);
        watchdog = setTimeout(finish, 1500);
      },
      abort() {
        this.userStop = true;
        try { cur && cur.abort(); } catch (e) {}
        finish();
      },
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      btn.classList.remove('listening');
      if (activeRec === session) activeRec = null;
      if (onEnd) onEnd(merge(committed, pending));
    };
    const startRun = () => {
      const rec = new SR();
      cur = rec;
      runs++;
      rec.lang = 'ru-RU';
      rec.interimResults = true;
      rec.continuous = !!continuous && !isPhone;
      let fin = '';
      let interim = '';
      let fatal = false;
      rec.onresult = (e) => {
        // rebuild from all results (avoids duplicated phrases on iOS)
        fin = '';
        interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) fin = merge(fin, r[0].transcript);
          else interim = merge(interim, r[0].transcript);
        }
        if (low(fin).endsWith(low(interim))) interim = '';
        else if (low(interim).startsWith(low(fin))) (fin = ''), (interim = interim.trim());
        pending = merge(fin, interim);
        onResult(merge(committed, fin), interim);
      };
      rec.onerror = (e) => {
        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e.error)) fatal = true;
        if (runs > 1 && fatal) return; // a silent restart was refused — just finish with what we have
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Разрешите доступ к микрофону: Настройки → Safari → Микрофон', 6000);
        else if (e.error === 'network') toast('Для распознавания речи нужен интернет');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Ошибка распознавания: ' + e.error);
      };
      rec.onstart = () => clearTimeout(watchdog);
      rec.onend = () => {
        if (done || cur !== rec) return;
        const got = merge(fin, interim); // iOS sometimes ends without marking the result final
        pending = '';
        if (got) {
          committed = merge(committed, got);
          silentRuns = 0;
        } else silentRuns++;
        onResult(committed, '');
        if (continuous && !session.userStop && !fatal && silentRuns < 2) {
          try {
            startRun();
            // a silent restart that never starts (iOS without a tap) must not leave the mic "stuck"
            clearTimeout(watchdog);
            watchdog = setTimeout(finish, 3000);
            return;
          } catch (e) {}
        }
        finish();
      };
      rec.start();
    };
    try {
      startRun();
      activeRec = session;
      btn.classList.add('listening');
    } catch (e) {
      toast('Не удалось включить микрофон');
    }
  }

  // =============================================================== home
  const GROUP_ORDER = ['ks', 'ds', 'kl', 'paid', 'other'];
  // home screen sections ("folders"); a section with `always` is shown even while it has no templates
  const SECTIONS = [
    { id: 'portal', title: 'Портал (Госпитализация)', sub: 'Листы для госпитализации через портал', groups: ['ks', 'ds'], always: true },
    { id: 'kl', title: 'Консультативный лист', sub: 'Первичный осмотр: жалобы, анамнез, локальный статус, исследования, диагноз, рекомендации', groups: ['kl'], always: true },
    { id: 'paid', title: 'Платные услуги', groups: ['paid'] },
    { id: 'other', title: 'Другое', groups: ['other'] },
  ];
  function templateButtons(list, onPick, strip) {
    const frag = document.createDocumentFragment();
    for (const g of GROUP_ORDER) {
      const items = list.filter((t) => t.group === g);
      if (!items.length) continue;
      const gt = strip ? items[0].groupTitle.replace(strip, '') : items[0].groupTitle;
      if (gt) frag.append(el('div', { class: 'group-title' }, gt));
      frag.append(
        el('div', { class: 'tpl-grid' }, items.map((t) => el('button', { type: 'button', class: 'tpl-item', onclick: () => onPick(t.id) }, t.title)))
      );
    }
    return frag;
  }
  function renderTemplateList() {
    const q = $('#search').value.trim().toLowerCase();
    const box = $('#templateList');
    box.innerHTML = '';
    if (q) {
      // search looks through every section
      const list = state.index.filter((t) => t.title.toLowerCase().includes(q) || (t.keywords || []).some((k) => k.includes(q)));
      if (!list.length) box.append(el('p', { class: 'hint' }, 'Ничего не найдено'));
      box.append(templateButtons(list, (id) => openForm(id)));
      return;
    }
    const sec = SECTIONS.find((s) => s.id === state.folder);
    if (!sec) {
      const list = el('div', { class: 'folder-list' });
      for (const s of SECTIONS) {
        const n = state.index.filter((t) => s.groups.includes(t.group)).length;
        if (!n && !s.always) continue;
        list.append(
          el('button', { type: 'button', class: 'folder', onclick: () => openFolder(s.id) },
            el('span', { class: 'f-text' }, el('span', { class: 'f-title' }, s.title), s.sub ? el('span', { class: 'f-sub' }, s.sub) : ''),
            el('span', { class: 'f-count' }, n ? String(n) : 'пусто'))
        );
      }
      box.append(list);
      return;
    }
    box.append(el('button', { type: 'button', class: 'btn ghost small folder-back', onclick: () => openFolder(null) }, '‹ Все разделы'));
    box.append(el('div', { class: 'folder-head' }, sec.title));
    const items = state.index.filter((t) => sec.groups.includes(t.group));
    if (!items.length) box.append(el('div', { class: 'empty-folder' }, 'Шаблонов пока нет — они появятся здесь, когда мы их добавим.'));
    box.append(templateButtons(items, (id) => openForm(id), /^Портал · /));
  }
  function openFolder(id) {
    state.folder = id;
    store.set('folder', id);
    renderTemplateList();
  }

  function renderRecent() {
    const h = store.get('history', []);
    $('#recentSection').hidden = !h.length;
    const box = $('#recentList');
    box.innerHTML = '';
    for (const item of h.slice(0, 5)) {
      const when = new Date(item.ts);
      const btn = el(
        'button',
        { type: 'button', class: 'recent-item' },
        el('span', null, el('b', null, item.fio || 'Без ФИО'), ' · ', item.title),
        el('small', null, `${pad(when.getDate())}.${pad(when.getMonth() + 1)}`)
      );
      const trash = el('div', { class: 'recent-trash', 'aria-hidden': 'true' });
      trash.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      const row = el('div', { class: 'recent-row' }, trash, btn);
      swipeToDelete(row, btn, () => removeRecent(item.ts));
      btn.addEventListener('click', () => {
        if (!row.dataset.swiped) openForm(item.id, { values: item.values });
      });
      box.append(row);
    }
  }
  function removeRecent(ts) {
    store.set('history', store.get('history', []).filter((x) => x.ts !== ts));
    renderRecent();
  }
  // swipe a row to the left: a red bin shows up; let go past the threshold = delete, otherwise it slides back
  function swipeToDelete(row, item, onDelete) {
    let x0 = 0, y0 = 0, dx = 0, mode = '', id = null;
    const limit = () => Math.min(140, row.offsetWidth * 0.4);
    const set = (x, anim) => {
      item.style.transition = anim ? 'transform .22s ease' : 'none';
      item.style.transform = x ? `translateX(${x}px)` : '';
      row.classList.toggle('armed', -x >= limit());
      row.style.setProperty('--reveal', Math.min(1, -x / limit()));
    };
    item.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; mode = ''; id = e.pointerId;
      delete row.dataset.swiped;
    });
    item.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!mode) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        mode = Math.abs(mx) > Math.abs(my) && mx < 0 ? 'swipe' : 'scroll';
        if (mode === 'swipe') {
          row.dataset.swiped = '1';
          try { item.setPointerCapture(id); } catch (err) {}
        }
      }
      if (mode !== 'swipe') return;
      dx = Math.min(0, mx);
      set(dx, false);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (mode !== 'swipe') return;
      if (-dx >= limit()) {
        set(-row.offsetWidth, true);
        row.classList.add('removing');
        setTimeout(onDelete, 230);
      } else set(0, true);
      // the click that follows a swipe must not open the sheet
      setTimeout(() => delete row.dataset.swiped, 50);
    };
    item.addEventListener('pointerup', end);
    item.addEventListener('pointercancel', end);
  }

  async function doParse() {
    const text = $('#dictText').value.trim();
    const out = $('#parseResult');
    if (!text) {
      toast('Сначала надиктуйте или введите текст');
      return;
    }
    await allTemplatesLoaded;
    const r = Parse.parse(text, state.index, (id) => state.cache[id], null, store.get('learned', []));
    out.innerHTML = '';
    if (!r.templateId || r.ambiguous) {
      out.hidden = false;
      const cands = r.candidates.length ? r.candidates : [];
      out.append(el('div', null, r.templateId ? 'Подходит несколько шаблонов — выберите:' : 'Не понял, какой нужен шаблон. Выберите:'));
      const choices = el('div', { class: 'choices' });
      // after a manual choice, offer to remember how the phone heard the template name
      const chosen = (id) => {
        const phrase = Parse.learnPhrase(text, r);
        const tpl = state.index.find((t) => t.id === id);
        if (phrase && tpl && confirm(`Запомнить, что «${phrase}» — это «${tpl.title}»?\n\nВ следующий раз шаблон определится сам.`)) {
          const learned = store.get('learned', []).filter((l) => l.p !== phrase);
          learned.unshift({ p: phrase, id });
          store.set('learned', learned.slice(0, 100));
          toast('Запомнил');
        }
        openForm(id, r);
      };
      for (const c of cands) choices.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => chosen(c.id) }, c.title));
      choices.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => pickTemplate(chosen) }, 'Все шаблоны…'));
      out.append(choices);
      return;
    }
    out.hidden = true;
    openForm(r.templateId, r);
  }

  function pickTemplate(onPick) {
    const d = $('#picker');
    const box = $('#pickerList');
    box.innerHTML = '';
    box.append(
      templateButtons(state.index, (id) => {
        d.close();
        onPick(id);
      })
    );
    d.showModal();
  }

  // =============================================================== form
  const shortLabel = (f) => (f.label || f.key).split(' — ')[0];
  function toDisplay(text) {
    return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
      const f = state.tpl.fields.find((x) => x.key === k);
      return f ? `⟨${shortLabel(f)}⟩` : m;
    });
  }
  function fromDisplay(text) {
    return String(text || '').replace(/⟨([^⟩]+)⟩/g, (m, l) => {
      const f = state.tpl.fields.find((x) => shortLabel(x) === l);
      return f ? `{{${f.key}}}` : m;
    });
  }
  function effectiveValues() {
    const v = { ...state.values };
    for (const k of ['diagnosis', 'operation']) if (v[k] !== undefined) v[k] = fromDisplay(v[k]);
    return v;
  }
  function ageText(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const now = new Date();
    let a = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
    if (a < 0 || a > 130) return '';
    const w = a % 10 === 1 && a % 100 !== 11 ? 'год' : [2, 3, 4].includes(a % 10) && ![12, 13, 14].includes(a % 100) ? 'года' : 'лет';
    return `Возраст: ${a} ${w}`;
  }

  async function openForm(id, parsed) {
    let tpl;
    try {
      tpl = await loadTemplate(id);
    } catch (e) {
      toast(e.message);
      return;
    }
    state.tpl = tpl;
    state.blob = null;
    const pv = (parsed && parsed.values) || {};
    const v = { date: todayISO() };
    for (const f of tpl.fields) {
      if (f.key === 'diagnosis' || f.key === 'operation') v[f.key] = toDisplay(f.default || '');
    }
    for (const k in pv) {
      if (!tpl.fields.some((f) => f.key === k)) continue;
      v[k] = k === 'diagnosis' || k === 'operation' ? toDisplay(pv[k]) : pv[k];
    }
    const notes = [];
    // only the sheets marked sideAware (tools/content.js) get the "Сторона" switch
    state.sideAware = !!tpl.sideAware;
    v.side = '';
    if (state.sideAware) {
      v.side = (parsed && parsed.side) || Render.sideOf(pv.diagnosis) || '';
      if (v.side) for (const k of ['diagnosis', 'operation']) if (v[k]) v[k] = Render.applySide(v[k], v.side);
      if (parsed && !v.side) notes.push('Сторона не названа — выберите «Справа», «Слева» или обе в поле «Сторона».');
    }
    if (parsed && parsed.opCode && tpl.fields.some((f) => f.key === 'operation')) {
      const def = (tpl.fields.find((f) => f.key === 'operation').default || '').trim();
      if (!def) v.operation = parsed.opCode;
      else if (!def.includes(parsed.opCode)) notes.push(`Вы назвали код операции ${parsed.opCode}, а в шаблоне другой — проверьте поле «Операция».`);
    }
    if (parsed && parsed.notes) notes.push(...parsed.notes);
    if (parsed && parsed.values) {
      const miss = tpl.fields.filter((f) => ['fio', 'dob'].includes(f.key) && !v[f.key]).map((f) => f.label);
      if (miss.length) notes.push('Не распознано: ' + miss.join(', ') + '. Заполните вручную или голосом.');
    }
    if (tpl.dxBuilder) {
      v.dxb = (parsed && Builder.fromText(parsed.text)) || Builder.empty();
      if (Builder.used(v.dxb)) v.diagnosis = Builder.compose(v.dxb, v.side);
    }
    state.values = v;
    $('#formNotes').hidden = !notes.length;
    $('#formNotes').textContent = notes.join(' ');
    $('#tplTitle').textContent = tpl.title;
    const idx = state.index.find((t) => t.id === id);
    $('#tplGroup').textContent = idx ? idx.groupTitle : '';
    renderFields();
    updateStampRow();
    show('form');
    if (history.state !== 'form') history.pushState('form', '', '#form');
    schedulePreview(true);
  }

  function setSide(side) {
    state.values.side = side;
    if (state.tpl.dxBuilder && Builder.used(state.values.dxb)) state.values.diagnosis = Builder.compose(state.values.dxb, side);
    for (const k of ['diagnosis', 'operation']) {
      if (!state.values[k]) continue;
      state.values[k] = Render.applySide(state.values[k], side);
      const inp = $('#f_' + k);
      if (inp && inp.value !== state.values[k]) inp.value = state.values[k];
    }
    paintSide();
    schedulePreview();
  }
  function paintSide() {
    const row = $('#sideRow');
    if (!row) return;
    row.classList.toggle('need', !state.values.side);
    const s = state.values.side;
    row.querySelectorAll('button').forEach((b) => {
      const on = s === 'both' || b.dataset.side === s;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  // each button switches on/off by itself; both on = "с обеих сторон"
  function toggleSide(side) {
    const s = state.values.side;
    const on = { right: s === 'right' || s === 'both', left: s === 'left' || s === 'both' };
    on[side] = !on[side];
    setSide(on.right && on.left ? 'both' : on.right ? 'right' : on.left ? 'left' : '');
  }
  function sideField() {
    const b = (side, text) => el('button', { type: 'button', class: 'side-btn', 'data-side': side, 'aria-pressed': 'false', onclick: () => toggleSide(side) }, text);
    return el('div', { class: 'field side-field', id: 'sideRow' },
      el('label', {}, 'Сторона'),
      el('div', { class: 'side-switch' }, b('right', 'Справа'), b('left', 'Слева')),
      el('div', { class: 'sub' }, 'Можно выбрать обе — тогда в листе будет «с обеих сторон» / «правой и левой». Диагноз, операция и рекомендации меняются сами.'));
  }

  // ---- diagnosis builder (balloon angioplasty): level, lesion, ХАН; the side comes from the «Сторона» switch
  const Builder = {
    LEVELS: [['iliac', 'Подвздошный', 'подвздошного'], ['femoral', 'Бедренный', 'бедренного'], ['popliteal', 'Подколенный', 'подколенного'], ['tibial', 'Тибиальный', 'тибиального']],
    LESIONS: [['stenosis', 'Стеноз'], ['occlusion', 'Окклюзия']],
    KHAN: ['I', 'II', 'III', 'IV'],
    BASE: 'I70.2 – Атеросклероз артерий нижних конечностей.',
    empty: () => ({ levels: [], lesions: [], khan: '' }),
    used: (b) => !!b && (b.levels.length > 0 || b.lesions.length > 0 || !!b.khan),
    compose(b, side) {
      const parts = [Builder.BASE];
      const lv = Builder.LEVELS.filter(([k]) => b.levels.includes(k)).map((x) => x[2]);
      const ls = Builder.LESIONS.filter(([k]) => b.lesions.includes(k)).map((x) => x[1]);
      if (lv.length || ls.length) {
        const what = ls.length ? ls.map((x, i) => (i ? x.toLowerCase() : x)).join(' и ') : 'Поражение';
        const where = lv.length ? ' ' + (lv.length > 1 ? lv.slice(0, -1).join(', ') + ' и ' + lv[lv.length - 1] : lv[0]) + (lv.length > 1 ? ' сегментов' : ' сегмента') : '';
        const sd = side === 'right' ? ' справа' : side === 'left' ? ' слева' : side === 'both' ? ' с обеих сторон' : '';
        parts.push(what + where + sd + '.');
      }
      if (b.khan) parts.push('ХАН ' + b.khan + ' ст.');
      return parts.join(' ');
    },
    // from the dictated text: "окклюзия бедренного и подколенного сегмента справа, хан 3"
    fromText(text) {
      const t = (text || '').toLowerCase();
      const b = Builder.empty();
      if (/подвздош/.test(t)) b.levels.push('iliac');
      if (/бедрен/.test(t)) b.levels.push('femoral');
      if (/подколен/.test(t)) b.levels.push('popliteal');
      if (/тибиал|берцов/.test(t)) b.levels.push('tibial');
      if (/стеноз/.test(t)) b.lesions.push('stenosis');
      if (/окклюз/.test(t)) b.lesions.push('occlusion');
      const m = t.match(/(?:хан|х\.а\.н|ишеми[яи]|степен[ьи])\D{0,10}(iv|i{1,3}|[1-4])(?![0-9a-z])/);
      if (m) b.khan = /^\d$/.test(m[1]) ? Builder.KHAN[+m[1] - 1] : m[1].toUpperCase();
      return Builder.used(b) ? b : null;
    },
  };
  let paintBuilder = () => {};
  function builderPanel(input, update) {
    const b = () => state.values.dxb || (state.values.dxb = Builder.empty());
    const apply = () => {
      input.value = Builder.compose(b(), state.values.side);
      paintBuilder();
      update();
    };
    const chip = (label, isOn, toggle) => {
      const c = el('button', { type: 'button', class: 'chip', onclick: () => (toggle(), apply()) }, label);
      c._on = isOn;
      return c;
    };
    const flip = (arr, k) => (arr.includes(k) ? arr.splice(arr.indexOf(k), 1) : arr.push(k));
    const row = (title, chips) => el('div', { class: 'dxb-row' }, el('span', { class: 'dxb-title' }, title), el('div', { class: 'chips' }, ...chips));
    const panel = el('div', { class: 'dxb' },
      row('Уровень', Builder.LEVELS.map(([k, label]) => chip(label, () => b().levels.includes(k), () => flip(b().levels, k)))),
      row('Поражение', Builder.LESIONS.map(([k, label]) => chip(label, () => b().lesions.includes(k), () => flip(b().lesions, k)))),
      row('ХАН', Builder.KHAN.map((k) => chip(k, () => b().khan === k, () => (b().khan = b().khan === k ? '' : k)))),
      el('div', { class: 'sub' }, 'Отметьте — диагноз соберётся сам. Сторону берём из поля «Сторона». Текст можно поправить вручную или надиктовать.'));
    paintBuilder = () => panel.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c._on()));
    paintBuilder();
    return panel;
  }

  function renderFields() {
    const form = $('#fields');
    form.innerHTML = '';
    if (state.sideAware) {
      form.append(sideField());
      paintSide();
    }
    for (const f of state.tpl.fields) {
      if (f.hidden) continue;
      const id = 'f_' + f.key;
      let input;
      if (f.kind === 'date') input = el('input', { type: 'date', id, value: state.values[f.key] || '' });
      else if (f.kind === 'multiline') input = el('textarea', { id, rows: 3 }, state.values[f.key] || '');
      else input = el('input', { type: 'text', id, value: state.values[f.key] || '', autocapitalize: f.key === 'fio' ? 'words' : 'sentences', inputmode: f.key === 'iin' ? 'numeric' : undefined });
      if (f.key === 'fio') input.placeholder = 'Фамилия Имя Отчество';
      if (f.fillin) input.placeholder = 'например, II';
      const sub = el('div', { class: 'sub' });
      const wrap = el('div', { class: 'field' + (state.values[f.key] ? ' filled' : '') }, el('label', { for: id }, f.label || f.key));
      const update = () => {
        state.values[f.key] = input.value;
        wrap.classList.toggle('filled', !!input.value.trim());
        if (f.key === 'dob') sub.textContent = ageText(input.value);
        if (f.default != null && (f.key === 'diagnosis' || f.key === 'operation')) reset.hidden = input.value === Render.applySide(toDisplay(f.default), state.values.side);
        // a side typed or dictated into the diagnosis/operation switches the whole sheet to it
        if (state.sideAware && (f.key === 'diagnosis' || f.key === 'operation')) {
          const s = Render.sideOf(input.value);
          if (s && s !== state.values.side) setSide(s);
        }
        schedulePreview();
      };
      input.addEventListener('input', update);
      const mic = el('button', { type: 'button', class: 'mic', 'aria-label': 'Надиктовать: ' + f.label });
      mic.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>';
      const base = { v: '' };
      mic.addEventListener('click', () =>
        dictate(mic, {
          continuous: f.kind === 'multiline',
          onResult: (fin, interim) => {
            if (f.kind === 'date') return;
            const text = (fin + ' ' + interim).trim();
            if (f.kind === 'multiline') input.value = (base.v ? base.v.replace(/\s+$/, '') + ' ' : '') + text;
            else input.value = f.key === 'fio' ? text.replace(/(^|[\s-])(\S)/g, (m, a, c) => a + c.toUpperCase()) : text;
            update();
          },
          onEnd: (fin) => {
            if (f.kind === 'date' && fin) {
              const iso = Parse.parseOneDate(fin);
              if (iso) {
                input.value = iso;
                update();
              } else toast('Не понял дату: «' + fin + '»');
            } else if (f.kind === 'date') toast('Не расслышал дату — нажмите микрофон и скажите, например, «10 декабря»');
            if (f.key === 'iin') {
              input.value = input.value.replace(/\D/g, '');
              update();
            }
          },
        })
      );
      mic.addEventListener('pointerdown', () => (base.v = input.value));
      const reset = el('button', { type: 'button', class: 'btn ghost small', hidden: true, onclick: () => {
        input.value = Render.applySide(toDisplay(f.default || ''), state.values.side);
        if (f.key === 'diagnosis' && state.tpl.dxBuilder) {
          state.values.dxb = Builder.empty();
          paintBuilder();
        }
        update();
      } }, 'Вернуть из шаблона');
      if (f.key === 'diagnosis' && state.tpl.dxBuilder) wrap.append(builderPanel(input, update));
      wrap.append(el('div', { class: 'row-input' }, input, mic));
      if (f.key === 'diagnosis' || f.key === 'operation') {
        reset.hidden = (state.values[f.key] || '') === Render.applySide(toDisplay(f.default || ''), state.values.side);
        wrap.append(el('div', { class: 'row', style: 'margin-top:.35rem' }, reset));
        if (/⟨/.test(state.values[f.key] || '')) wrap.append(el('div', { class: 'sub' }, 'Значения в ⟨скобках⟩ подставляются из полей ниже.'));
      }
      if (f.key === 'dob') sub.textContent = ageText(state.values.dob);
      wrap.append(sub);
      form.append(wrap);
    }
  }

  // the stamp is ticked by default on every new sheet; unticking affects only the current sheet
  function updateStampRow() {
    const has = !!state.stamp;
    const cb = $('#useStamp');
    cb.disabled = !has;
    cb.checked = has;
    const hint = $('#stampHint');
    hint.innerHTML = '';
    if (has) return;
    vaultBox.then((box) => {
      if (state.stamp) return;
      hint.innerHTML = '';
      if (box) hint.append(el('button', { type: 'button', class: 'btn ghost small', onclick: (e) => (e.preventDefault(), askPin()) }, 'Ввести PIN печати'));
      else hint.textContent = 'Загрузите печать в настройках (⚙), чтобы ставить её автоматически.';
    });
  }

  // ---- PIN-protected stamp (stamp.enc.json on the site; decrypted once per device)
  const vaultBox = fetch('stamp.enc.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  function askPin() {
    const d = $('#pinDlg');
    const input = $('#pinInput');
    const msg = $('#pinMsg');
    input.value = '';
    msg.textContent = '';
    d.showModal();
    input.focus();
    $('#pinOk').onclick = async (e) => {
      e.preventDefault();
      const box = await vaultBox;
      if (!box || !input.value) return;
      msg.textContent = 'Проверяю…';
      try {
        const url = await Vault.unlock(box, input.value);
        input.value = '';
        if (!store.set('stamp', url)) toast('Не хватает места для печати на устройстве');
        state.stamp = url;
        d.close();
        toast('Печать подключена');
        updateStampRow();
        renderSettings();
        if (state.tpl) schedulePreview(true);
      } catch (err) {
        msg.textContent = 'Неверный PIN';
        input.select();
      }
    };
  }

  // =============================================================== PDF
  let fontsReady = null;
  function shortFio(fio) {
    const p = String(fio || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return 'Пациент';
    return p[0] + (p[1] ? ' ' + p[1][0] + '.' : '') + (p[2] ? p[2][0] + '.' : '');
  }
  function fileName() {
    const v = state.values;
    const d = Render.formatDate(v.date || todayISO(), 'dd.MM.yyyy');
    return `${shortFio(v.fio)} — ${state.tpl.title} — ${d}.pdf`.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  }
  async function buildPdf(compact, flow) {
    await fontsReady;
    const images = await imagesFor(state.tpl);
    return Render.build(state.tpl, effectiveValues(), {
      images,
      stamp: state.stamp,
      useStamp: $('#useStamp').checked,
      title: fileName().replace(/\.pdf$/, ''),
      author: 'Ангиохирург',
      compact,
      flow,
    });
  }
  // dd -> Blob; with check=true returns null when the signature spilled onto a new page alone
  function renderBlob(dd, check) {
    return new Promise((res, rej) => {
      try {
        const pdf = pdfMake.createPdf(dd);
        if (typeof pdf._createDoc !== 'function' || typeof pdf._flushDoc !== 'function') return pdf.getBlob(res);
        pdf._createDoc({}, (doc) => {
          try {
            if (check && Render.orphanSignature(doc._pdfMakePages, dd)) return res(null);
            pdf._flushDoc(doc, (buf) => res(new Blob([buf], { type: 'application/pdf' })));
          } catch (e) {
            rej(e);
          }
        });
      } catch (e) {
        rej(e);
      }
    });
  }
  const currentKey = () => JSON.stringify([state.tpl && state.tpl.id, state.values, $('#useStamp').checked, !!state.stamp]);
  async function getBlob() {
    const key = currentKey();
    if (state.blob && state.blobKey === key) return state.blob;
    // second, tighter layout only if the signature would end up alone on the next page
    const blob =
      (await renderBlob(await buildPdf(false), true)) ||
      (await renderBlob(await buildPdf(true), true)) ||
      (await renderBlob(await buildPdf(true, true), false));
    state.blob = blob;
    state.blobKey = key;
    return blob;
  }

  let previewTimer;
  let previewUrl;
  function schedulePreview(now) {
    clearTimeout(previewTimer);
    // phones: prepare the PDF in the background so "Поделиться" is instant
    previewTimer = setTimeout(async () => {
      try {
        const blob = await getBlob();
        if (!wideScreen()) return;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(blob);
        $('#preview').src = previewUrl + '#toolbar=0&navpanes=0&view=FitH';
        $('#previewLoading').hidden = true;
      } catch (e) {
        console.error(e);
        $('#previewLoading').textContent = 'Ошибка предпросмотра: ' + e.message;
      }
    }, now ? 50 : 600);
  }

  function remember() {
    const h = store.get('history', []).filter((x) => !(x.id === state.tpl.id && x.fio === state.values.fio));
    h.unshift({ id: state.tpl.id, title: state.tpl.title, fio: state.values.fio || '', values: state.values, ts: Date.now() });
    store.set('history', h.slice(0, 20));
  }
  function checkRequired() {
    if (!(state.values.fio || '').trim()) {
      toast('Заполните ФИО пациента');
      $('#f_fio') && $('#f_fio').focus();
      return false;
    }
    if (state.sideAware && !state.values.side) {
      toast('Выберите сторону: «Справа», «Слева» или обе');
      $('#sideRow') && $('#sideRow').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return false;
    }
    return true;
  }

  async function download() {
    if (!checkRequired()) return;
    try {
      const blob = await getBlob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: fileName() });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      remember();
      toast('PDF сохранён');
    } catch (e) {
      toast('Не удалось создать PDF: ' + e.message, 5000);
    }
  }

  async function share() {
    if (!checkRequired()) return;
    const ready = state.blob && state.blobKey === currentKey();
    try {
      const blob = await getBlob();
      const file = new File([blob], fileName(), { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: file.name.replace(/\.pdf$/, '') });
          remember();
        } catch (e) {
          if (e.name === 'NotAllowedError' && !ready) toast('PDF готов — нажмите «Поделиться» ещё раз');
          else if (e.name !== 'AbortError') toast('Не удалось поделиться: ' + e.message);
        }
      } else {
        await download();
        toast('Отправка файлов здесь недоступна — PDF скачан', 4000);
      }
    } catch (e) {
      toast('Не удалось создать PDF: ' + e.message, 5000);
    }
  }

  // Preview inside the app. A new window (window.open + blob URL) stays "about:blank"
  // in the iPhone home-screen app, so the pages are drawn here with pdf.js.
  let pdfjsReady;
  function loadPdfjs() {
    if (!pdfjsReady)
      pdfjsReady = new Promise((res, rej) => {
        const s = el('script', { src: 'vendor/pdfjs/pdf.min.js' });
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
          res(window.pdfjsLib);
        };
        s.onerror = () => {
          pdfjsReady = null;
          rej(new Error('нет связи для загрузки просмотрщика'));
        };
        document.head.append(s);
      });
    return pdfjsReady;
  }
  async function openPreview() {
    const view = $('#pdfView');
    const pages = $('#pdfPages');
    pages.innerHTML = '<div class="pdf-msg">Готовлю PDF…</div>';
    view.hidden = false;
    history.pushState({ pdf: true }, '');
    try {
      const [blob, pdfjsLib] = await Promise.all([getBlob(), loadPdfjs()]);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
      if (view.hidden) return;
      pages.innerHTML = '';
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const css = Math.min(pages.clientWidth - 16, 820);
        const vp = page.getViewport({ scale: (css / page.getViewport({ scale: 1 }).width) * ratio });
        const c = el('canvas');
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        pages.append(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    } catch (e) {
      console.error(e);
      pages.innerHTML = '';
      pages.append(el('div', { class: 'pdf-msg' }, 'Не удалось показать PDF: ' + e.message));
    }
  }
  function closePreview() {
    if ($('#pdfView').hidden) return;
    $('#pdfView').hidden = true;
    $('#pdfPages').innerHTML = '';
    if (history.state && history.state.pdf) history.back();
  }
  window.addEventListener('popstate', () => {
    if (!$('#pdfView').hidden) {
      $('#pdfView').hidden = true;
      $('#pdfPages').innerHTML = '';
    }
  });

  // =============================================================== settings
  function renderSettings() {
    const img = $('#stampImg');
    img.hidden = !state.stamp;
    $('#stampNone').hidden = !!state.stamp;
    if (state.stamp) img.src = state.stamp;
    $('#stampPin').hidden = true;
    vaultBox.then((box) => ($('#stampPin').hidden = !box || !!state.stamp));
    $('#speechInfo').textContent = SR
      ? 'Распознавание речи встроено в браузер (бесплатно). В Chrome звук обрабатывается серверами Google, поэтому нужен интернет. Можно также пользоваться микрофоном на клавиатуре телефона.'
      : 'В этом браузере встроенного распознавания нет. Пользуйтесь микрофоном на клавиатуре телефона — текст можно надиктовать в любое поле.';
    const ll = $('#learnedList');
    ll.innerHTML = '';
    const learned = store.get('learned', []);
    if (!learned.length) ll.append(el('span', { class: 'hint' }, 'Пока нет'));
    for (const l of learned) {
      const tpl = state.index.find((t) => t.id === l.id);
      ll.append(
        el('div', { class: 'learned-row' },
          el('span', null, `«${l.p}» → ${tpl ? tpl.title : l.id}`),
          el('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Удалить', onclick: () => {
            store.set('learned', store.get('learned', []).filter((x) => !(x.p === l.p && x.id === l.id)));
            renderSettings();
          } }, '✕'))
      );
    }
    $('#version').textContent = 'Версия ' + VERSION + ' · данные пациентов не покидают устройство';
  }
  async function loadStampFile(file) {
    if (!file) return;
    const url = await blobToDataURL(file);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    // downscale to keep it small in storage
    const max = 500;
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/png');
    if (!store.set('stamp', data)) {
      toast('Не удалось сохранить: мало места в браузере');
      return;
    }
    state.stamp = data;
    renderSettings();
    updateStampRow();
    state.blob = null;
    toast('Печать сохранена на этом устройстве');
  }

  // =============================================================== navigation
  function show(name) {
    $('#home').hidden = name !== 'home';
    $('#form').hidden = name !== 'form';
    $('#backBtn').hidden = name === 'home';
    window.scrollTo(0, 0);
    if (name === 'home') renderRecent();
  }

  // =============================================================== init
  let allTemplatesLoaded;
  async function init() {
    syncWide();
    window.addEventListener('resize', () => {
      const was = document.body.classList.contains('wide');
      syncWide();
      if (!was && wideScreen() && state.tpl && !$('#form').hidden) schedulePreview(true);
    });
    fontsReady = loadFonts().catch((e) => {
      console.error(e);
      toast('Не удалось загрузить шрифты');
    });
    try {
      await loadIndex();
    } catch (e) {
      $('#templateList').append(el('p', { class: 'hint' }, 'Не удалось загрузить шаблоны. Проверьте интернет и обновите страницу.'));
      return;
    }
    allTemplatesLoaded = Promise.all(state.index.map((t) => loadTemplate(t.id).catch(() => null)));
    renderTemplateList();
    renderRecent();

    $('#search').addEventListener('input', renderTemplateList);
    $('#parseBtn').addEventListener('click', doParse);
    $('#dictText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doParse();
    });
    const dictBase = { v: '' };
    $('#dictMic').addEventListener('pointerdown', () => (dictBase.v = $('#dictText').value));
    $('#dictMic').addEventListener('click', () => {
      const status = $('#micStatus');
      dictate($('#dictMic'), {
        continuous: true,
        onResult: (fin, interim) => {
          $('#dictText').value = (dictBase.v ? dictBase.v.replace(/\s+$/, '') + ' ' : '') + (fin + ' ' + interim).trim();
        },
        onEnd: () => {
          status.hidden = true;
          if ($('#dictText').value.trim() && store.get('autoParse', true)) doParse();
        },
      });
      if (activeRec) {
        status.textContent = 'Слушаю… нажмите ещё раз, чтобы закончить';
        status.hidden = false;
      }
    });

    $('#backBtn').addEventListener('click', () => history.back());
    $('#brand').addEventListener('click', () => {
      if (!$('#form').hidden) history.back();
    });
    window.addEventListener('popstate', () => show(location.hash === '#form' && state.tpl ? 'form' : 'home'));
    if (location.hash === '#form') history.replaceState(null, '', location.pathname);

    $('#changeTpl').addEventListener('click', () =>
      pickTemplate((id) => {
        const keep = { values: {} };
        for (const k of ['fio', 'dob', 'iin', 'date', 'opdate']) if (state.values[k]) keep.values[k] = state.values[k];
        openForm(id, keep);
      })
    );
    $('#useStamp').addEventListener('change', () => schedulePreview());
    $('#stampPin').addEventListener('click', askPin);
    $('#pinCancel').addEventListener('click', () => $('#pinDlg').close());
    $('#downloadBtn').addEventListener('click', download);
    $('#shareBtn').addEventListener('click', share);
    $('#previewBtn').addEventListener('click', openPreview);
    $('#pdfClose').addEventListener('click', closePreview);
    $('#pdfShare').addEventListener('click', share);

    $('#settingsBtn').addEventListener('click', () => {
      renderSettings();
      $('#settings').showModal();
    });
    $('#stampFile').addEventListener('change', (e) => loadStampFile(e.target.files[0]).catch(() => toast('Не удалось прочитать изображение')));
    $('#stampRemove').addEventListener('click', () => {
      localStorage.removeItem('stamp');
      state.stamp = null;
      renderSettings();
      updateStampRow();
      state.blob = null;
    });
    $('#clearHistory').addEventListener('click', () => {
      store.set('history', []);
      renderRecent();
      toast('История очищена');
    });

    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  window.KL = { state, getBlob, buildPdf }; // for debugging in the browser console
  init();
})();
