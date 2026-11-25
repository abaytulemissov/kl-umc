(function () {
  'use strict';

  const VERSION = '0.1.0';
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
      activeRec.stop();
      return;
    }
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = !!continuous && !isPhone;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += (finalText ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      onResult(finalText, interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Разрешите доступ к микрофону в настройках браузера', 5000);
      else if (e.error === 'network') toast('Для распознавания речи нужен интернет');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Ошибка распознавания: ' + e.error);
    };
    rec.onend = () => {
      btn.classList.remove('listening');
      activeRec = null;
      if (onEnd) onEnd(finalText);
    };
    try {
      rec.start();
      activeRec = rec;
      btn.classList.add('listening');
    } catch (e) {
      toast('Не удалось включить микрофон');
    }
  }

  // =============================================================== home
  const GROUP_ORDER = ['ks', 'ds', 'paid', 'other'];
  function templateButtons(list, onPick) {
    const frag = document.createDocumentFragment();
    for (const g of GROUP_ORDER) {
      const items = list.filter((t) => t.group === g);
      if (!items.length) continue;
      frag.append(el('div', { class: 'group-title' }, items[0].groupTitle));
      frag.append(
        el('div', { class: 'tpl-grid' }, items.map((t) => el('button', { type: 'button', class: 'tpl-item', onclick: () => onPick(t.id) }, t.title)))
      );
    }
    return frag;
  }
  function renderTemplateList() {
    const q = $('#search').value.trim().toLowerCase();
    const list = state.index.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.keywords || []).some((k) => k.includes(q)));
    const box = $('#templateList');
    box.innerHTML = '';
    if (!list.length) box.append(el('p', { class: 'hint' }, 'Ничего не найдено'));
    box.append(templateButtons(list, (id) => openForm(id)));
  }

  function renderRecent() {
    const h = store.get('history', []);
    $('#recentSection').hidden = !h.length;
    const box = $('#recentList');
    box.innerHTML = '';
    for (const item of h.slice(0, 5)) {
      const when = new Date(item.ts);
      box.append(
        el(
          'button',
          { type: 'button', class: 'recent-item', onclick: () => openForm(item.id, { values: item.values }) },
          el('span', null, el('b', null, item.fio || 'Без ФИО'), ' · ', item.title),
          el('small', null, `${pad(when.getDate())}.${pad(when.getMonth() + 1)}`)
        )
      );
    }
  }

  async function doParse() {
    const text = $('#dictText').value.trim();
    const out = $('#parseResult');
    if (!text) {
      toast('Сначала надиктуйте или введите текст');
      return;
    }
    await allTemplatesLoaded;
    const r = Parse.parse(text, state.index, (id) => state.cache[id]);
    out.innerHTML = '';
    if (!r.templateId || r.ambiguous) {
      out.hidden = false;
      const cands = r.candidates.length ? r.candidates : [];
      out.append(el('div', null, r.templateId ? 'Подходит несколько шаблонов — выберите:' : 'Не понял, какой нужен шаблон. Выберите:'));
      const choices = el('div', { class: 'choices' });
      for (const c of cands) choices.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => openForm(c.id, r) }, c.title));
      choices.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => pickTemplate((id) => openForm(id, r)) }, 'Все шаблоны…'));
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
    if (parsed && parsed.side && v.diagnosis) v.diagnosis = Parse.applySide(v.diagnosis, parsed.side);
    for (const k in pv) {
      if (!tpl.fields.some((f) => f.key === k)) continue;
      v[k] = k === 'diagnosis' || k === 'operation' ? toDisplay(pv[k]) : pv[k];
    }
    const notes = [];
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

  function renderFields() {
    const form = $('#fields');
    form.innerHTML = '';
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
        if (f.default != null && (f.key === 'diagnosis' || f.key === 'operation')) reset.hidden = input.value === toDisplay(f.default);
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
            }
            if (f.key === 'iin') {
              input.value = input.value.replace(/\D/g, '');
              update();
            }
          },
        })
      );
      mic.addEventListener('pointerdown', () => (base.v = input.value));
      const reset = el('button', { type: 'button', class: 'btn ghost small', hidden: true, onclick: () => {
        input.value = toDisplay(f.default || '');
        update();
      } }, 'Вернуть из шаблона');
      wrap.append(el('div', { class: 'row-input' }, input, mic));
      if (f.key === 'diagnosis' || f.key === 'operation') {
        reset.hidden = (state.values[f.key] || '') === toDisplay(f.default || '');
        wrap.append(el('div', { class: 'row', style: 'margin-top:.35rem' }, reset));
        if (/⟨/.test(state.values[f.key] || '')) wrap.append(el('div', { class: 'sub' }, 'Значения в ⟨скобках⟩ подставляются из полей ниже.'));
      }
      if (f.key === 'dob') sub.textContent = ageText(state.values.dob);
      wrap.append(sub);
      form.append(wrap);
    }
  }

  function updateStampRow() {
    const has = !!state.stamp;
    const cb = $('#useStamp');
    cb.disabled = !has;
    cb.checked = has && store.get('useStamp', true);
    $('#stampHint').textContent = has ? '' : 'Загрузите печать в настройках (⚙), чтобы ставить её автоматически.';
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
  async function buildPdf() {
    await fontsReady;
    const images = await imagesFor(state.tpl);
    const dd = Render.build(state.tpl, effectiveValues(), {
      images,
      stamp: state.stamp,
      useStamp: $('#useStamp').checked,
      title: fileName().replace(/\.pdf$/, ''),
      author: 'Ангиохирург',
    });
    return pdfMake.createPdf(dd);
  }
  const currentKey = () => JSON.stringify([state.tpl && state.tpl.id, state.values, $('#useStamp').checked, !!state.stamp]);
  async function getBlob() {
    const key = currentKey();
    if (state.blob && state.blobKey === key) return state.blob;
    const pdf = await buildPdf();
    const blob = await new Promise((res, rej) => {
      try {
        pdf.getBlob(res);
      } catch (e) {
        rej(e);
      }
    });
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

  async function openPreview() {
    // open the window synchronously (popup blockers), fill it when the PDF is ready
    const win = window.open('', '_blank');
    try {
      const blob = await getBlob();
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else location.href = url;
    } catch (e) {
      if (win) win.close();
      toast('Не удалось создать PDF: ' + e.message, 5000);
    }
  }

  // =============================================================== settings
  function renderSettings() {
    const img = $('#stampImg');
    img.hidden = !state.stamp;
    $('#stampNone').hidden = !!state.stamp;
    if (state.stamp) img.src = state.stamp;
    $('#speechInfo').textContent = SR
      ? 'Распознавание речи встроено в браузер (бесплатно). В Chrome звук обрабатывается серверами Google, поэтому нужен интернет. Можно также пользоваться микрофоном на клавиатуре телефона.'
      : 'В этом браузере встроенного распознавания нет. Пользуйтесь микрофоном на клавиатуре телефона — текст можно надиктовать в любое поле.';
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
    $('#useStamp').addEventListener('change', (e) => {
      store.set('useStamp', e.target.checked);
      schedulePreview();
    });
    $('#downloadBtn').addEventListener('click', download);
    $('#shareBtn').addEventListener('click', share);
    $('#previewBtn').addEventListener('click', openPreview);

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
