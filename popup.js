/* 左右日语 · 划词词典 —— 设置与生词本 */

/* 预览用：popup.html?theme=light 强制浅色 */
if (new URLSearchParams(location.search).get('theme') === 'light') {
  document.documentElement.classList.add('force-light');
}

/* 脱离扩展环境直接双击 popup.html 时，用内存数据兜底，方便预览样式 */
if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
  const store = {
    jp_settings: { enabled: true, theme: 'auto', dblclick: true, autoSpeak: false },
    jp_vocab: [
      { id: 'a1', word: '懐かしい', reading: 'なつかしい', pos: 'イ形容词', meaning: '令人怀念的；怀旧的', createdAt: Date.now() },
      { id: 'a2', word: '蘇る', reading: 'よみがえる', pos: '五段动词', meaning: '苏醒；重新浮现', createdAt: Date.now() - 60000 },
      { id: 'a3', word: '駄菓子屋', reading: 'だがしや', pos: '名词', meaning: '卖廉价零食的小店', createdAt: Date.now() - 120000 }
    ]
  };
  window.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(
          typeof key === 'string' ? { [key]: store[key] }
            : Object.keys(store).reduce((o, k) => (o[k] = store[k], o), {})
        ),
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); }
      }
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => setTimeout(() => cb(
        !msg ? null
          : msg.type === 'lookup'
          ? {
              ok: true, matched: msg.word, reading: 'なつかしい',
              pos: 'イ形容词', jlpt: 'N3', cn: '令人怀念的；怀旧的',
              en: ['dear (old)', 'fondly remembered'], cnFrom: 'en'
            }
          : msg.type === 'translate'
          ? {
              ok: true, text: msg.text,
              direction: msg.direction === 'zh2ja' ? 'zh2ja' : 'ja2zh',
              translation: msg.direction === 'zh2ja'
                ? '私は日本に留学したいです。'
                : '寂静的庭院里，只落着一片红叶。',
              cn: msg.direction === 'zh2ja'
                ? '私は日本に留学したいです。'
                : '寂静的庭院里，只落着一片红叶。',
              partial: false
            }
          : null
      ), 260)
    }
  };
}

const DEFAULTS = {
  enabled: true,
  theme: 'auto',
  dblclick: true,
  autoSpeak: false,
  direction: 'ja2zh'
};

let settings = Object.assign({}, DEFAULTS);
let vocab = [];

const $ = (id) => document.getElementById(id);

/* 日语没有空格，用浏览器原生分词判断输入是词还是句子 */
const JA_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

let segmenter = null;
try {
  segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
} catch (e) {
  segmenter = null;
}

function segmentText(text) {
  if (!segmenter) {
    return Array.from(text).filter((c) => JA_RE.test(c));
  }
  const out = [];
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) out.push(s.segment);
  }
  return out;
}

/* 单个假名（は / に / し / た）不是可查的词，去掉免得点开一堆无意义结果 */
function chipTokens(tokens) {
  return (tokens || []).filter((t) => !(t.length === 1 && /[\u3040-\u30ff]/.test(t)));
}

/* 句子判定。
   难点：分词器会把 食べられませんでした 拆成 食/べら/れ/ま/せん/で/した，
   里面带一个「で」，光看“有没有助词”会误判。
   判据取「助词后面还有实词」，即助词不在倒数两位之内——活用链里的助词总在句末。 */
const PARTICLES = new Set([
  'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や',
  'から', 'まで', 'より', 'など', 'しか', 'だけ', 'ばかり'
]);

function looksLikeSentence(text, tokens) {
  const t = String(text).replace(/\s/g, '');
  if (!t) return false;
  if (/[。．！？!?…]/.test(t)) return true;
  if (/\s/.test(String(text).trim())) return true;

  const list = tokens || [];
  if (list.length <= 1) return false;
  if (list.length >= 5 && t.length >= 14) return true;

  const tail = list.length - 2;
  for (let i = 0; i < tail; i++) {
    if (PARTICLES.has(list[i])) return true;
  }
  return false;
}

async function loadSettings() {
  const got = await chrome.storage.local.get('jp_settings');
  settings = Object.assign({}, DEFAULTS, got.jp_settings || {});
}

async function saveSettings() {
  await chrome.storage.local.set({ jp_settings: settings });
}

function paintSettings() {
  $('enabled').checked = settings.enabled !== false;
  $('dblclick').checked = settings.dblclick !== false;
  $('autospeak').checked = !!settings.autoSpeak;
  document.querySelectorAll('#theme button').forEach(b => {
    b.classList.toggle('on', b.dataset.theme === settings.theme);
  });

  const toJa = settings.direction === 'zh2ja';
  document.querySelectorAll('#dir button').forEach(b => {
    b.classList.toggle('on', b.dataset.dir === (toJa ? 'zh2ja' : 'ja2zh'));
  });

  const q = $('q');
  if (q) q.placeholder = toJa ? '输入中文，翻成日语，回车' : '粘贴日语查词，回车';
  const btn = $('qbtn');
  if (btn) btn.textContent = toJa ? '译' : '查';
  const note = $('dirnote');
  if (note) note.textContent = toJa ? '中文 → 日语整句/词组' : '查日语词或整句';
}

async function loadVocab() {
  const got = await chrome.storage.local.get('jp_vocab');
  vocab = got.jp_vocab || [];
}

function paintVocab() {
  const list = $('vlist');
  list.textContent = '';
  $('count').textContent = vocab.length;

  if (!vocab.length) {
    const empty = document.createElement('div');
    empty.className = 'vempty';
    empty.innerHTML = '还没有收录生词。<br>在网页上选中日语，点卡片里的「生词本」。<br>' +
      '收够了词，点上面的「词库 / 抽测」开始背。';
    list.appendChild(empty);
    return;
  }

  vocab.forEach(item => {
    const row = document.createElement('div');
    row.className = 'vitem';

    const main = document.createElement('div');
    main.className = 'vmain';

    const top = document.createElement('div');
    top.className = 'vtop';

    const word = document.createElement('span');
    word.className = 'vword';
    word.textContent = item.word;
    top.appendChild(word);

    if (item.reading && item.reading !== item.word) {
      const rd = document.createElement('span');
      rd.className = 'vread';
      rd.textContent = item.reading;
      top.appendChild(rd);
    }

    if (item.pos) {
      const pos = document.createElement('span');
      pos.className = 'vpos';
      pos.textContent = item.pos;
      top.appendChild(pos);
    }

    main.appendChild(top);

    if (item.meaning) {
      const mean = document.createElement('div');
      mean.className = 'vmean';
      mean.textContent = item.meaning;
      main.appendChild(mean);
    }

    row.appendChild(main);

    const del = document.createElement('button');
    del.className = 'vdel';
    del.type = 'button';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      vocab = vocab.filter(v => v.id !== item.id);
      await chrome.storage.local.set({ jp_vocab: vocab });
      paintVocab();
    });
    row.appendChild(del);

    list.appendChild(row);
  });
}

/* 词库 / 抽测：整页打开，比 360px 的小面板适合背词 */
function openStudy() {
  let url = 'study.html';
  try {
    if (chrome.runtime && chrome.runtime.getURL) url = chrome.runtime.getURL('study.html');
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
      window.close();
      return;
    }
  } catch (e) { /* 预览环境，走下面的 window.open */ }
  window.open(url, '_blank');
}

function exportVocab() {
  if (!vocab.length) return;
  const payload = {
    app: 'zrjp-vocab',
    version: 1,
    exportedAt: new Date().toISOString(),
    words: vocab
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `划词生词本-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---------------- 手动查词 ---------------- */

function askBackground(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function addToVocab(entry, btn) {
  const exists = vocab.some(v => v.word === entry.matched);
  if (exists) {
    btn.classList.add('done');
    btn.textContent = '已在生词本';
    return;
  }
  vocab.unshift({
    id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word: entry.matched,
    reading: entry.reading || '',
    pos: entry.pos || '',
    meaning: entry.cn || (entry.en || []).slice(0, 2).join('; '),
    createdAt: Date.now()
  });
  chrome.storage.local.set({ jp_vocab: vocab });
  paintVocab();
  btn.classList.add('done');
  btn.textContent = '已收进生词本';
}

function renderQResult(entry) {
  const box = $('qres');
  box.textContent = '';
  box.hidden = false;

  const top = document.createElement('div');
  top.className = 'qtop';

  const w = document.createElement('span');
  w.className = 'qword';
  w.textContent = entry.matched;
  top.appendChild(w);

  if (entry.reading && entry.reading !== entry.matched) {
    const r = document.createElement('span');
    r.className = 'qread';
    r.textContent = entry.reading;
    top.appendChild(r);
  }

  if (entry.pos) {
    const p = document.createElement('span');
    p.className = 'qpos';
    p.textContent = entry.pos;
    top.appendChild(p);
  }

  if (entry.jlpt) {
    const l = document.createElement('span');
    l.className = 'qpos';
    l.style.background = 'transparent';
    l.style.color = 'var(--dim)';
    l.textContent = entry.jlpt;
    top.appendChild(l);
  }

  box.appendChild(top);

  if (entry.cn) {
    const m = document.createElement('div');
    m.className = 'qmean';
    m.textContent = entry.cn;
    box.appendChild(m);
  }

  if (entry.en && entry.en.length && entry.cnFrom !== 'en') {
    const e = document.createElement('div');
    e.className = 'qen';
    e.textContent = entry.en.slice(0, 3).join('; ');
    box.appendChild(e);
  }

  const act = document.createElement('div');
  act.className = 'qact';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '收进生词本';
  btn.addEventListener('click', () => addToVocab(entry, btn));
  act.appendChild(btn);
  box.appendChild(act);
}

function renderQError(text, reason) {
  const box = $('qres');
  box.textContent = '';
  box.hidden = false;
  const p = document.createElement('div');
  p.className = 'qerr';
  p.textContent = reason === 'network'
    ? '网络查询失败，检查一下网络连接。'
    : `没有查到「${text}」。可能是专有名词，或换一个更短的词试试。`;
  box.appendChild(p);
}

function renderQSentence(res, tokens) {
  const box = $('qres');
  box.textContent = '';
  box.hidden = false;

  const src = document.createElement('div');
  src.className = 'qsrc';
  src.textContent = res.text;
  box.appendChild(src);

  if (res.cn) {
    const cn = document.createElement('div');
    cn.className = 'qcn';
    cn.textContent = res.cn;
    box.appendChild(cn);
  } else {
    const fail = document.createElement('div');
    fail.className = 'qerr';
    fail.textContent = '这句没译出来，点下面的词单独查。';
    box.appendChild(fail);
  }

  if (res.partial) {
    const note = document.createElement('div');
    note.className = 'qnote';
    note.textContent = '句子较长，只译出了前几段。';
    box.appendChild(note);
  }

  if (tokens && tokens.length) {
    const row = document.createElement('div');
    row.className = 'qtoks';
    chipTokens(tokens).slice(0, 60).forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qtok';
      b.textContent = t;
      b.addEventListener('click', () => {
        const input = $('q');
        input.value = t;
        doLookup();
      });
      row.appendChild(b);
    });
    box.appendChild(row);
  }

  if (res.cn) {
    const act = document.createElement('div');
    act.className = 'qact';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '复制译文';
    btn.addEventListener('click', () => {
      copyText(res.cn);
      btn.classList.add('done');
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.classList.remove('done');
        btn.textContent = '复制译文';
      }, 1400);
    });
    act.appendChild(btn);
    box.appendChild(act);
  }
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) { /* 退化到 execCommand */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
  ta.remove();
}

function speakJa(text) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 0.92;
    const v = window.speechSynthesis.getVoices().find(x => /^ja/i.test(x.lang));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch (e) { /* 忽略 */ }
}

/* 中 → 日：源中文 + 日语译文 + 译文分词（点词可看这个词的词条） */
function renderQZhJa(res) {
  const box = $('qres');
  box.textContent = '';
  box.hidden = false;

  const src = document.createElement('div');
  src.className = 'qsrc';
  src.textContent = res.text;
  box.appendChild(src);

  const ja = res.translation || res.cn || '';

  if (!ja) {
    const fail = document.createElement('div');
    fail.className = 'qerr';
    fail.textContent = '这句没翻出来，换个说法或短一点的句子再试。';
    box.appendChild(fail);
    return;
  }

  const out = document.createElement('div');
  out.className = 'qja';
  out.textContent = ja;
  box.appendChild(out);

  if (res.partial) {
    const note = document.createElement('div');
    note.className = 'qnote';
    note.textContent = '内容较长，只译出了前几段。';
    box.appendChild(note);
  }

  const tokens = segmentText(ja);
  if (tokens.length) {
    const row = document.createElement('div');
    row.className = 'qtoks';
    chipTokens(tokens).slice(0, 60).forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qtok';
      b.textContent = t;
      b.addEventListener('click', () => lookupFromChip(t));
      row.appendChild(b);
    });
    box.appendChild(row);
  }

  const act = document.createElement('div');
  act.className = 'qact';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制译文';
  copy.addEventListener('click', () => {
    copyText(ja);
    copy.classList.add('done');
    copy.textContent = '已复制';
    setTimeout(() => {
      copy.classList.remove('done');
      copy.textContent = '复制译文';
    }, 1400);
  });
  act.appendChild(copy);

  const speak = document.createElement('button');
  speak.type = 'button';
  speak.textContent = '朗读';
  speak.addEventListener('click', () => speakJa(ja));
  act.appendChild(speak);

  box.appendChild(act);
}

/* 点译文里的分词：直接查这个词条（日→中），不改当前翻译方向 */
async function lookupFromChip(word) {
  const box = $('qres');
  box.hidden = false;
  box.textContent = '';
  const load = document.createElement('div');
  load.className = 'qerr';
  load.textContent = '查询中…';
  box.appendChild(load);

  const res = await askBackground({ type: 'lookup', word });
  if (!res || !res.ok) {
    renderQError(word, res && res.error);
    return;
  }
  renderQResult(res);
}

async function doLookup() {
  const input = $('q');
  const raw = (input.value || '').trim();
  if (!raw) { input.focus(); return; }

  const text = raw.replace(/\s+/g, ' ').trim();
  const toJa = settings.direction === 'zh2ja';
  const box = $('qres');
  box.hidden = false;
  box.textContent = '';

  const load = document.createElement('div');
  load.className = 'qerr';
  load.textContent = '翻译中…';
  box.appendChild(load);

  $('qbtn').disabled = true;

  if (toJa) {
    const res = await askBackground({ type: 'translate', text, direction: 'zh2ja' });
    $('qbtn').disabled = false;
    if (!res) { renderQError(text, 'network'); return; }
    renderQZhJa(res);
    return;
  }

  const tokens = segmentText(text);
  const sentence = looksLikeSentence(text, tokens);

  if (sentence) {
    const res = await askBackground({ type: 'translate', text, direction: 'ja2zh' });
    $('qbtn').disabled = false;
    if (!res) { renderQError(text, 'network'); return; }
    renderQSentence(res, tokens);
    return;
  }

  const res = await askBackground({ type: 'lookup', word: text.replace(/\s/g, '') });
  $('qbtn').disabled = false;
  if (!res || !res.ok) {
    renderQError(text, res && res.error);
    return;
  }
  renderQResult(res);
}

async function checkPageSupport() {
  const hint = $('qhint');
  if (!hint) return;
  // 截图 / 预览时可以把提示行关掉：popup.html?nohint=1
  if (new URLSearchParams(location.search).get('nohint') === '1') {
    hint.textContent = '';
    return;
  }

  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
    hint.className = 'qhint warn';
    hint.textContent = '这是样式预览页。装进浏览器后，网页上划词即可查询。';
    return;
  }

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) { tab = null; }

  if (!tab || tab.id == null) return;

  const alive = await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'ping' }, (r) => {
        void chrome.runtime.lastError;
        resolve(!!(r && r.ok));
      });
    } catch (e) {
      resolve(false);
    }
  });

  if (alive) {
    hint.className = 'qhint';
    hint.textContent = '当前页面可划词。选中日语，或双击单词直接查。';
  } else {
    hint.className = 'qhint warn';
    hint.textContent =
      '这个页面不能划词：Chrome 内置 PDF 阅读器、浏览器内置页面，或扩展刚装好还没刷新。' +
      '可以先在上面输入 / 粘贴词语查。';
  }
}

function bind() {
  $('qbtn').addEventListener('click', doLookup);
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doLookup();
    }
  });

  $('enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    saveSettings();
  });

  $('dblclick').addEventListener('change', (e) => {
    settings.dblclick = e.target.checked;
    saveSettings();
  });

  $('autospeak').addEventListener('change', (e) => {
    settings.autoSpeak = e.target.checked;
    saveSettings();
  });

  document.querySelectorAll('#theme button').forEach(b => {
    b.addEventListener('click', () => {
      settings.theme = b.dataset.theme;
      paintSettings();
      saveSettings();
    });
  });

  document.querySelectorAll('#dir button').forEach(b => {
    b.addEventListener('click', () => {
      settings.direction = b.dataset.dir === 'zh2ja' ? 'zh2ja' : 'ja2zh';
      paintSettings();
      saveSettings();
      // 换了方向，上一次的结果不再适用，清掉
      const box = $('qres');
      if (box) { box.hidden = true; box.textContent = ''; }
      const q = $('q');
      if (q) { q.focus(); q.select(); }
    });
  });

  $('export').addEventListener('click', exportVocab);
  $('openStudy').addEventListener('click', openStudy);

  $('clear').addEventListener('click', async () => {
    if (!vocab.length) return;
    if (!confirm(`确定清空全部 ${vocab.length} 个生词？此操作不可撤销，建议先导出。`)) return;
    vocab = [];
    await chrome.storage.local.set({ jp_vocab: [] });
    paintVocab();
  });
}

(async function init() {
  await loadSettings();

  // 预览用：?dir=zh2ja 临时切方向，不写入存储
  const previewDir = new URLSearchParams(location.search).get('dir');
  if (previewDir === 'zh2ja' || previewDir === 'ja2zh') settings.direction = previewDir;

  await loadVocab();
  paintSettings();
  paintVocab();
  bind();
  checkPageSupport();
  // 打开即聚焦输入框，PDF 里复制后可直接 Ctrl+V
  const q = $('q');
  if (q) setTimeout(() => { try { q.focus(); } catch (e) {} }, 30);

  // 预览用：?demo=懐かしい 直接演示一次查询
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && q) {
    q.value = demo === '1' ? '懐かしい' : demo;
    setTimeout(doLookup, 120);
  }
})();
