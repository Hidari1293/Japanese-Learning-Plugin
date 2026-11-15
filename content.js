/* 左右日语 · 划词词典 —— 页面层
 * 划词 / 双击 → 悬浮词典卡片（Shadow DOM 隔离，不受站点样式影响）
 */

(() => {
  if (window.__JP_LOOKUP_READY__) return;
  window.__JP_LOOKUP_READY__ = true;

  const JA_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3005\u3006]/;
  const DEFAULT_SETTINGS = {
    enabled: true,
    theme: 'auto',
    dblclick: true,
    autoSpeak: false,
    direction: 'ja2zh'
  };

  let S = Object.assign({}, DEFAULT_SETTINGS);
  let host = null;
  let shadow = null;
  let card = null;
  let lastRange = null;
  let reqSeq = 0;
  let currentEntry = null;
  let currentWord = '';
  let vocabIds = new Set();

  let segmenter = null;
  try {
    segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  } catch (e) {
    segmenter = null;
  }

  /* ---------------- 工具 ---------------- */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const isEditable = (node) => {
    let n = node;
    while (n && n.nodeType === 1) {
      const tag = n.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (n.isContentEditable) return true;
      n = n.parentElement;
    }
    return false;
  };

  const isDarkSystem = () =>
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  const resolveTheme = () =>
    S.theme === 'dark' ? 'dark' : S.theme === 'light' ? 'light' : (isDarkSystem() ? 'dark' : 'light');

  function segmentText(text) {
    if (!segmenter) {
      return Array.from(text).filter(c => JA_RE.test(c)).map(c => c);
    }
    const out = [];
    for (const s of segmenter.segment(text)) {
      if (s.isWordLike) out.push(s.segment);
    }
    return out;
  }

  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'runtime' });
          else resolve(res || { ok: false, error: 'empty' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'closed' });
      }
    });
  }

  /* ---------------- 样式 ---------------- */

  const CSS = `
    :host, * { box-sizing: border-box; }
    .card {
      --paper: #f4f1ea;
      --card: #fffdf9;
      --ink: #24211c;
      --dim: #8a8175;
      --line: #e3ddd1;
      --accent: #2f6b52;
      --accent-soft: #e8f0ea;
      --shadow: 0 1px 2px rgba(60,50,35,.06), 0 20px 48px -20px rgba(60,50,35,.34);
      --serif: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Noto Serif JP", "MS Mincho", "Songti SC", "SimSun", Georgia, serif;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;

      position: absolute;
      width: 348px;
      max-width: calc(100vw - 20px);
      max-height: calc(100vh - 24px);
      overflow-y: auto;
      overscroll-behavior: contain;
      background: var(--card);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      font-family: var(--sans);
      font-size: 13px;
      line-height: 1.6;
      padding: 0;
      text-align: left;
      direction: ltr;
    }
    .card[data-theme="dark"] {
      --paper: #141316;
      --card: #201f1d;
      --ink: #e9e4da;
      --dim: #8f887c;
      --line: #343230;
      --accent: #7fb89a;
      --accent-soft: #243026;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 20px 48px -16px rgba(0,0,0,.7);
    }
    @media (prefers-reduced-motion: reduce) {
      .card { transition: none !important; }
    }

    .hd { padding: 17px 20px 13px; }
    .word-row { display: flex; align-items: flex-start; gap: 8px; }
    .word {
      font-family: var(--serif);
      font-size: 27px;
      line-height: 1.25;
      letter-spacing: .01em;
      word-break: break-all;
      flex: 1;
      min-width: 0;
    }
    .reading {
      font-family: var(--serif);
      font-size: 13.5px;
      color: var(--dim);
      margin-top: 3px;
      letter-spacing: .04em;
    }
    .sub-row { display: flex; align-items: center; gap: 8px; margin-top: 5px; flex-wrap: wrap; }
    .tags { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
    .tag {
      font-size: 10px;
      letter-spacing: .05em;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--accent-soft);
      color: var(--accent);
      white-space: nowrap;
      font-weight: 500;
    }
    .tag.ghost {
      background: transparent;
      border: 1px solid var(--line);
      color: var(--dim);
      font-weight: 400;
    }
    .tag.lvl { font-variant-numeric: tabular-nums; }

    .divider { height: 1px; background: var(--line); margin: 0 20px; opacity: .85; }

    .body { padding: 13px 20px 15px; }
    .cn {
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--ink);
      margin: 0;
      word-break: break-word;
    }
    .cn-placeholder { color: var(--dim); font-size: 12.5px; font-style: italic; }
    .en {
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--dim);
      margin: 7px 0 0;
      word-break: break-word;
    }
    .note {
      font-size: 11.5px;
      line-height: 1.6;
      color: var(--dim);
      margin: 10px 0 0;
      padding: 8px 11px;
      background: var(--paper);
      border-left: 2px solid var(--accent);
      border-radius: 0 6px 6px 0;
      word-break: break-word;
    }
    .note b { color: var(--accent); font-weight: 600; }
    .approx {
      font-size: 11.5px;
      line-height: 1.6;
      color: var(--dim);
      margin: 0 0 8px;
      padding: 6px 10px;
      background: var(--accent-soft);
      border-radius: 6px;
      word-break: break-word;
    }

    .ft {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 9px 14px 10px 16px;
      border-top: 1px dashed var(--line);
      background: var(--paper);
      border-radius: 0 0 14px 14px;
    }
    .act {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: none;
      background: transparent;
      color: var(--dim);
      font-family: var(--sans);
      font-size: 11.5px;
      padding: 4px 7px;
      border-radius: 6px;
      cursor: pointer;
      transition: color .13s, background .13s;
      white-space: nowrap;
    }
    .act:hover { color: var(--accent); background: var(--accent-soft); }
    .act.done { color: var(--accent); cursor: default; }
    .act svg { display: block; }
    .grow { flex: 1; }
    .src {
      font-size: 9.5px;
      color: var(--dim);
      letter-spacing: .04em;
      opacity: .75;
      white-space: nowrap;
    }

    /* 句子模式 */
    .sent-src {
      font-family: var(--serif);
      font-size: 15px;
      line-height: 1.85;
      margin: 0 0 10px;
      word-break: break-word;
      color: var(--ink);
      text-wrap: pretty;
    }
    .sent-cn {
      font-size: 13.5px;
      line-height: 1.7;
      color: var(--ink);
      margin: 0;
      padding: 9px 11px;
      background: var(--paper);
      border-left: 2px solid var(--accent);
      border-radius: 0 7px 7px 0;
      word-break: break-word;
    }
    .tokens { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 12px; }
    .tok {
      font-family: var(--serif);
      font-size: 12.5px;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      transition: background-color .13s, border-color .13s, color .13s;
    }
    .tok:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

    /* 骨架屏 */
    .sk { background: var(--line); border-radius: 4px; animation: pulse 1.1s ease-in-out infinite; }
    .sk.w1 { height: 26px; width: 44%; margin-bottom: 9px; }
    .sk.w2 { height: 11px; width: 26%; margin-bottom: 16px; }
    .sk.w3 { height: 12px; width: 88%; margin-bottom: 7px; }
    .sk.w4 { height: 12px; width: 64%; }
    @keyframes pulse { 0%,100% { opacity: .5; } 50% { opacity: .95; } }

    .empty {
      padding: 26px 20px 22px;
      text-align: center;
      color: var(--dim);
      font-size: 12.5px;
      line-height: 1.75;
    }
    .empty strong { display: block; font-family: var(--serif); font-size: 15px; color: var(--ink); margin-bottom: 5px; font-weight: 500; }
    .empty .empty-tip {
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
      font-size: 11.5px;
      color: var(--dim);
      opacity: .85;
    }
    .empty .empty-time { font-size: 11px; color: var(--dim); opacity: .7; }
    .empty button.retry {
      margin-top: 10px;
      padding: 6px 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--card);
      color: var(--accent);
      font-family: var(--sans);
      font-size: 12px;
      cursor: pointer;
    }
    .empty button.retry:hover { border-color: var(--accent); background: var(--accent-soft); }

    .card::-webkit-scrollbar { width: 8px; }
    .card::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; border: 2px solid var(--card); }
    .card::-webkit-scrollbar-track { background: transparent; }
  `;

  /* ---------------- DOM 挂载 ---------------- */

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.setAttribute('data-jp-lookup', '1');
    host.style.cssText =
      'all:initial !important;position:fixed !important;inset:0 !important;' +
      'width:auto !important;height:auto !important;z-index:2147483647 !important;pointer-events:none !important;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
  }

  function newCard() {
    ensureHost();
    if (card && card.parentNode) card.remove();
    card = el('div', 'card');
    card.setAttribute('data-theme', resolveTheme());
    card.style.pointerEvents = 'auto';
    shadow.appendChild(card);
    return card;
  }

  function closeCard() {
    if (card && card.parentNode) card.remove();
    card = null;
    currentEntry = null;
    lastRange = null;
    reqSeq++;
  }

  function place(anchorRect) {
    if (!card) return;
    const M = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 卡片在 iframe 里时，容器可能只有两三百像素宽，先收窄再量
    const maxW = Math.max(220, vw - M * 2);
    if (card.offsetWidth > maxW) {
      card.style.width = maxW + 'px';
    }

    const W = card.offsetWidth || 348;
    const H = card.offsetHeight || 180;

    let left = anchorRect.left + anchorRect.width / 2 - W / 2;
    left = Math.max(M, Math.min(left, vw - W - M));

    let top = anchorRect.bottom + 10;
    if (top + H > vh - M) {
      const above = anchorRect.top - 10 - H;
      top = above >= M ? above : Math.max(M, vh - H - M);
    }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function reveal(anchorRect) {
    if (!card) return;
    const c = card;

    // 先定位再显示，不做「隐藏 → 显示」的切换，避免任何情况下卡片留在不可见状态
    c.style.transform = 'translateY(6px)';
    place(anchorRect);
    c.style.visibility = 'visible';

    requestAnimationFrame(() => {
      if (card !== c) return;
      place(anchorRect);
      c.style.transition = 'transform .16s cubic-bezier(.2,.8,.3,1)';
      c.style.transform = 'none';
    });

    setTimeout(() => {
      if (card !== c) return;
      c.style.transition = 'none';
      c.style.transform = 'none';
    }, 220);
  }

  /* 按住卡片头部可拖动，拖走后固定在原处，不再跟随滚动 */
  function setupDrag(handle) {
    if (!handle) return;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();

      const box = card.getBoundingClientRect();
      const offX = e.clientX - box.left;
      const offY = e.clientY - box.top;
      let moved = false;

      card.style.transition = 'none';
      handle.style.cursor = 'grabbing';

      const onMove = (ev) => {
        if (!card) return;
        moved = true;
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        let left = ev.clientX - offX;
        let top = ev.clientY - offY;
        left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
        card.dataset.fixed = '1';
      };

      const onUp = () => {
        handle.style.cursor = 'grab';
        if (card) card.style.transition = '';
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (moved) lastRange = null;
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  /* ---------------- 渲染 ---------------- */

  const ICON = {
    speak: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    add: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5.5 5.5L20 6"/></svg>',
    copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
    book: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5z"/><path d="M8 3v18"/></svg>',
    x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };

  function iconBtn(label, svg) {
    const b = el('button', 'act');
    b.innerHTML = svg;
    const span = el('span', null, label);
    b.appendChild(span);
    b.type = 'button';
    return b;
  }

  function renderLoading(anchorRect) {
    newCard();
    const hd = el('div', 'hd');
    hd.appendChild(el('div', 'sk w1'));
    hd.appendChild(el('div', 'sk w2'));
    card.appendChild(hd);
    const b = el('div', 'body');
    b.appendChild(el('div', 'sk w3'));
    b.appendChild(el('div', 'sk w4'));
    card.appendChild(b);
    reveal(anchorRect);
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = 0.92;
      const voices = window.speechSynthesis.getVoices();
      const ja = voices.find(v => /^ja/i.test(v.lang));
      if (ja) u.voice = ja;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  function isSaved(word) {
    return vocabIds.has(word);
  }

  async function loadVocabIds() {
    try {
      const got = await chrome.storage.local.get('jp_vocab');
      const list = got.jp_vocab || [];
      vocabIds = new Set(list.map(v => v.word));
    } catch (e) {
      vocabIds = new Set();
    }
  }

  async function addToVocab(entry, btn) {
    try {
      const got = await chrome.storage.local.get('jp_vocab');
      const list = got.jp_vocab || [];
      if (list.some(v => v.word === entry.matched)) return;
      list.unshift({
        id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        word: entry.matched,
        reading: entry.reading || '',
        pos: entry.pos || '',
        meaning: entry.cn || (entry.en || []).join('; '),
        createdAt: Date.now()
      });
      await chrome.storage.local.set({ jp_vocab: list });
      vocabIds.add(entry.matched);
      if (btn) {
        btn.classList.add('done');
        btn.innerHTML = ICON.check;
        btn.appendChild(el('span', null, '已收录'));
      }
    } catch (e) { /* 忽略 */ }
  }

  function copyText(entry) {
    const parts = [entry.matched];
    if (entry.reading && entry.reading !== entry.matched) parts[0] += '（' + entry.reading + '）';
    if (entry.pos) parts.push(entry.pos);
    let line = parts.join(' ');
    if (entry.cn) line += '：' + entry.cn;
    else if (entry.en && entry.en.length) line += '：' + entry.en.join('; ');
    const text = line;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
  }

  function renderWord(entry, anchorRect) {
    newCard();
    currentEntry = entry;
    currentWord = entry.matched;

    const hd = el('div', 'hd');

    const wordRow = el('div', 'word-row');
    const wordEl = el('div', 'word', entry.matched);
    wordRow.appendChild(wordEl);
    hd.appendChild(wordRow);

    const subRow = el('div', 'sub-row');
    if (entry.reading && entry.reading !== entry.matched) {
      subRow.appendChild(el('div', 'reading', entry.reading));
    }
    const tags = el('div', 'tags');
    if (entry.pos) tags.appendChild(el('span', 'tag', entry.pos));
    if (entry.jlpt) tags.appendChild(el('span', 'tag ghost lvl', entry.jlpt));
    if (entry.approx) {
      tags.appendChild(el('span', 'tag ghost', '含此词'));
    } else if (entry.query && entry.matched && entry.query !== entry.matched) {
      tags.appendChild(el('span', 'tag ghost', '原形'));
    } else if (entry.common) {
      tags.appendChild(el('span', 'tag ghost', '常用'));
    }
    if (tags.childNodes.length) subRow.appendChild(tags);
    hd.appendChild(subRow);
    card.appendChild(hd);
    setupDrag(hd);

    card.appendChild(el('div', 'divider'));

    const body = el('div', 'body');
    if (entry.approx && entry.query) {
      const tip = el('p', 'approx');
      tip.textContent = '词典里没有「' + entry.query + '」这个词，下面是最接近的词条。';
      body.appendChild(tip);
    }
    if (entry.cn) {
      body.appendChild(el('p', 'cn', entry.cn));
    } else if (entry.en && entry.en.length) {
      body.appendChild(el('p', 'cn', entry.en[0]));
    } else {
      body.appendChild(el('p', 'cn cn-placeholder', '暂无释义'));
    }
    if (entry.en && entry.en.length) {
      body.appendChild(el('p', 'en', entry.en.slice(0, 2).join('; ')));
    }
    if (entry.note) {
      const note = el('p', 'note');
      // 先整体转义，再只还原数据源自带的 <b> 加粗
      const safe = String(entry.note)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/&lt;b&gt;/g, '<b>')
        .replace(/&lt;\/b&gt;/g, '</b>');
      note.innerHTML = safe;
      body.appendChild(note);
    }
    card.appendChild(body);

    const ft = el('div', 'ft');

    const btnSpeak = iconBtn('发音', ICON.speak);
    btnSpeak.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(entry.matched);
    });
    ft.appendChild(btnSpeak);

    const btnAdd = el('button', 'act');
    btnAdd.type = 'button';
    if (isSaved(entry.matched)) {
      btnAdd.classList.add('done');
      btnAdd.innerHTML = ICON.check;
      btnAdd.appendChild(el('span', null, '已收录'));
    } else {
      btnAdd.innerHTML = ICON.add;
      btnAdd.appendChild(el('span', null, '生词本'));
      btnAdd.addEventListener('click', (e) => {
        e.stopPropagation();
        addToVocab(entry, btnAdd);
      });
    }
    ft.appendChild(btnAdd);

    const btnCopy = iconBtn('复制', ICON.copy);
    btnCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(entry);
      const span = btnCopy.querySelector('span');
      if (span) {
        span.textContent = '已复制';
        setTimeout(() => { span.textContent = '复制'; }, 1100);
      }
    });
    ft.appendChild(btnCopy);

    ft.appendChild(el('span', 'grow'));

    const srcText = entry.inLocal
      ? '本地词库'
      : entry.cnFrom === 'en'
        ? 'Jisho · MyMemory'
        : entry.cn
          ? 'MyMemory'
          : 'Jisho';
    ft.appendChild(el('span', 'src', srcText));
    card.appendChild(ft);

    reveal(anchorRect);
    if (S.autoSpeak) speak(entry.matched);
  }

  function renderSentence(text, translation, tokens, anchorRect, speakText) {
    newCard();

    const hd = el('div', 'hd');
    hd.appendChild(el('p', 'sent-src', text));
    card.appendChild(hd);
    setupDrag(hd);

    card.appendChild(el('div', 'divider'));

    const body = el('div', 'body');
    if (translation) {
      body.appendChild(el('p', 'sent-cn', translation));
    } else {
      body.appendChild(el('p', 'cn cn-placeholder', '暂时没能翻译这句，点下面的词单独查'));
    }

    if (tokens && tokens.length) {
      const row = el('div', 'tokens');
      // 单个假名（は / に / て）不是一个词，去掉更干净
      tokens.filter(t => !(t.length === 1 && /[\u3040-\u30ff]/.test(t)))
        .slice(0, 40).forEach(t => {
          const b = el('button', 'tok', t);
          b.type = 'button';
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            requestWord(t, b.getBoundingClientRect());
          });
          row.appendChild(b);
        });
      body.appendChild(row);
    }
    card.appendChild(body);

    const ft = el('div', 'ft');
    const btnSpeak = iconBtn('朗读', ICON.speak);
    btnSpeak.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(speakText || text);
    });
    ft.appendChild(btnSpeak);
    ft.appendChild(el('span', 'grow'));
    ft.appendChild(el('span', 'src', translation ? 'MyMemory' : ''));
    card.appendChild(ft);

    reveal(anchorRect);
  }

  /* 查不到分三种情况，提示不能混：
       network —— 两个接口都没响应，是网络问题
       off     —— 消息没送到后台（service worker 没起来 / 页面是重载扩展前打开的）
       notfound—— 接口正常返回，确实没这个词
     以前后两种共用「可能是专有名词」，排查时会被带到错的方向。 */
  function renderEmpty(text, anchorRect, reason, detail) {
    newCard();
    const off = reason === 'runtime' || reason === 'closed' || reason === 'empty';

    const box = el('div', 'empty');
    box.appendChild(el('strong', null, '没有查到「' + text + '」'));
    box.appendChild(document.createTextNode(
      reason === 'network' ? '查询接口没有响应。'
        : off ? '扩展后台没有响应，查询根本没发出去。'
        : '可能是专有名词，或换选一个更短的词试试。'
    ));

    if (off) {
      const tip = el('div', 'empty-tip');
      tip.textContent = '先刷新这个页面；还不行就到 chrome://extensions 点扩展的刷新按钮。扩展重载后，旧页面里的脚本会失联。';
      box.appendChild(tip);
    } else if (reason === 'network') {
      const tip = el('div', 'empty-tip');
      tip.textContent = '本地词库里的词仍然离线可用。面板里点「自检」能看到两个接口各自的返回。';
      box.appendChild(tip);
      if (detail) {
        const code = el('div', 'empty-time');
        code.textContent = '返回：' + detail;
        box.appendChild(code);
      }
    }

    const retry = el('button', 'retry', '再查一次');
    retry.type = 'button';
    retry.addEventListener('click', () => requestWord(text, anchorRect));
    box.appendChild(retry);

    card.appendChild(box);
    reveal(anchorRect);
  }

  /* ---------------- 查询流程 ---------------- */

  async function requestWord(word, anchorRect) {
    const seq = ++reqSeq;
    renderLoading(anchorRect);

    let res = await ask({ type: 'lookup', word });
    // 后台被回收后，冷启动期间的第一条消息容易丢，隔一下再试一次
    if (res && !res.ok && (res.error === 'runtime' || res.error === 'closed' || res.error === 'empty')) {
      await new Promise(r => setTimeout(r, 400));
      if (seq !== reqSeq) return;
      const again = await ask({ type: 'lookup', word });
      if (again && again.ok) res = again;
    }

    if (seq !== reqSeq) return;
    if (!res || !res.ok) {
      renderEmpty(word, anchorRect, res && res.error, res && res.detail);
      return;
    }
    renderWord(res, anchorRect);
  }

  async function requestSentence(text, anchorRect, direction) {
    const seq = ++reqSeq;
    const toJa = direction === 'zh2ja';
    renderLoading(anchorRect);
    const res = await ask({ type: 'translate', text, direction: toJa ? 'zh2ja' : 'ja2zh' });
    if (seq !== reqSeq) return;
    const out = res && res.ok ? (res.translation || res.cn) : '';
    // 中→日时，可点的分词要用译文（日语），而不是原文中文
    const tokens = toJa ? segmentText(out) : segmentText(text);
    renderSentence(text, out, tokens, anchorRect, toJa ? out : text);
  }

  function handleSelection(sel, anchorRect) {
    // 零宽字符与不换行空格常见于 PDF / 排版网站，留着会让分词和查询都失效
    let text = sel.toString()
      .replace(/[\u200b-\u200f\u2028\u2029\ufeff\u00a0]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    if (!JA_RE.test(text)) return;

    // 划得太多时截断处理，而不是静默无反应
    const MAXLEN = 300;
    if (text.length > MAXLEN) {
      text = text.slice(0, MAXLEN).replace(/[、，,]\s*$/, '') + '…';
    }

    // 中→日模式：选中的若是纯中文（没有假名），直接翻成日语
    const hasKana = /[\u3040-\u30ff]/.test(text);
    if (S.direction === 'zh2ja' && !hasKana) {
      requestSentence(text, anchorRect, 'zh2ja');
      return;
    }

    const tokens = segmentText(text);
    const isSentence = tokens.length > 3 || text.length > 11;

    if (isSentence) {
      requestSentence(text, anchorRect);
    } else {
      // 优先把选中内容当作一个整体词查；若不像词，取最长的 token
      const single = text.replace(/[\s「」『』、。！？!?,.\s…]/g, '');
      const target = single.length <= 12 ? single : (tokens.sort((a, b) => b.length - a.length)[0] || single);
      if (!target) return;
      requestWord(target, anchorRect);
    }
  }

  /* ---------------- 事件 ---------------- */

  function anchorFromRange(range) {
    const rects = Array.from(range.getClientRects()).filter(r => r.width || r.height);
    if (!rects.length) {
      const r = range.getBoundingClientRect();
      return (r.width || r.height) ? r : null;
    }
    return rects[rects.length - 1];
  }

  function trySelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const sc = range.startContainer;
    if (isEditable(sc.nodeType === 1 ? sc : sc.parentElement)) return false;
    const rect = anchorFromRange(range);
    if (!rect) return false;
    lastRange = range.cloneRange();
    handleSelection(sel, rect);
    return true;
  }

  function onMouseUp(e) {
    if (!S.enabled) return;
    if (e.button !== 0) return;
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    if (isEditable(e.target)) return;

    // 先同步读：部分站点会在 mouseup 之后立刻清空选区
    if (trySelection()) return;
    // 再给浏览器一帧完成选区落定
    setTimeout(() => { trySelection(); }, 16);
  }

  function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        range = document.createRange();
        range.setStart(p.offsetNode, p.offset);
        range.collapse(true);
      }
    }
    if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return null;

    const node = range.startContainer;
    const full = node.textContent || '';
    const off = range.startOffset;

    if (!segmenter) {
      // 退化方案：向两侧扩展到空白/标点
      let s = off, e = off;
      while (s > 0 && JA_RE.test(full[s - 1])) s--;
      while (e < full.length && JA_RE.test(full[e])) e++;
      if (s === e) return null;
      const r = document.createRange();
      r.setStart(node, s);
      r.setEnd(node, e);
      return { text: full.slice(s, e), range: r };
    }

    for (const seg of segmenter.segment(full)) {
      if (!seg.isWordLike) continue;
      if (off >= seg.index && off < seg.index + seg.segment.length) {
        if (!JA_RE.test(seg.segment)) return null;
        const r = document.createRange();
        r.setStart(node, seg.index);
        r.setEnd(node, seg.index + seg.segment.length);
        return { text: seg.segment, range: r };
      }
    }
    return null;
  }

  function onDblClick(e) {
    if (!S.enabled || !S.dblclick) return;
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    if (isEditable(e.target)) return;

    const hit = wordAtPoint(e.clientX, e.clientY);
    if (!hit || !JA_RE.test(hit.text)) return;
    const rect = anchorFromRange(hit.range);
    if (!rect) return;
    lastRange = hit.range.cloneRange();
    requestWord(hit.text, rect);
  }

  function onMouseDown(e) {
    if (!card) return;
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    closeCard();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && card) closeCard();
  }

  let scrollTick = false;
  function onScroll() {
    if (!card || !lastRange) return;
    if (card.dataset.fixed === '1') return; // 手动拖走后保持原位
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (!card || !lastRange) return;
      const rect = anchorFromRange(lastRange);
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        closeCard();
        return;
      }
      place(rect);
    });
  }

  /* ---------------- 设置同步 ---------------- */

  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get('jp_settings');
      S = Object.assign({}, DEFAULT_SETTINGS, got.jp_settings || {});
    } catch (e) { /* 用默认 */ }
    if (card) card.setAttribute('data-theme', resolveTheme());
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.jp_settings) {
      S = Object.assign({}, DEFAULT_SETTINGS, changes.jp_settings.newValue || {});
      if (!S.enabled) closeCard();
      if (card) card.setAttribute('data-theme', resolveTheme());
    }
    if (changes.jp_vocab) {
      const list = changes.jp_vocab.newValue || [];
      vocabIds = new Set(list.map(v => v.word));
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg) return;

    // 供设置面板自检：确认这个页面/这一帧是否已注入
    if (msg.type === 'ping') {
      if (respond) respond({ ok: true, framed: window !== window.top });
      return;
    }

    if (msg.type === 'settings-changed') {
      S = Object.assign({}, DEFAULT_SETTINGS, msg.settings || {});
      if (card) card.setAttribute('data-theme', resolveTheme());
    }
    if (msg.type === 'lookup-selection' && msg.text) {
      const text = String(msg.text).trim();
      if (!JA_RE.test(text)) return;
      const sel = window.getSelection();
      let rect = null;
      if (sel && sel.rangeCount) rect = anchorFromRange(sel.getRangeAt(0));
      if (!rect) {
        rect = { left: window.innerWidth / 2, top: window.innerHeight / 3, width: 0, height: 0, bottom: window.innerHeight / 3 };
      }
      const tokens = segmentText(text);
      const hasKana = /[\u3040-\u30ff]/.test(text);
      if (S.direction === 'zh2ja' && !hasKana) {
        requestSentence(text, rect, 'zh2ja');
      } else if (tokens.length > 3 || text.length > 11) {
        requestSentence(text, rect);
      } else {
        requestWord(text.replace(/\s/g, ''), rect);
      }
    }
  });

  window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener && window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (card && S.theme === 'auto') card.setAttribute('data-theme', resolveTheme());
    });

  /* ---------------- 启动 ---------------- */

  (async function init() {
    await loadSettings();
    await loadVocabIds();
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', () => { if (card) closeCard(); }, true);
  })();
})();
