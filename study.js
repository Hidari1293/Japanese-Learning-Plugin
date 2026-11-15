/* 左右日语 · 词库与抽测
 *
 * 数据来源：
 *   jp_vocab        生词本（划词卡片收进来的词）
 *   deck-n3.js      内置 N3 词库（220 词）
 *   jp_study_stats  每个词库、每个词的学习记录 { w: 错次, r: 对次, lv: 掌握等级 0-5, t: 时间,
 *                                               k: { 题型: { 对, 错 } } }
 *   jp_settings     与 popup 共用（这里读写 theme、quizType）
 *
 * 出题权重 = (6 - 掌握等级) × (1 + min(错次, 6) × 7)
 *   新词最优先；错一次权重 ×8，错六次封顶 ×43；已掌握（lv 5）先不出现。
 *   加权随机（轮盘赌），并从最近 8 个词里排除，避免同一个词连出。
 *
 * 选择题有三类题型：
 *   cn2jp    中文 → 日语（看释义选词）
 *   jp2cn    日语 → 中文（看词选释义）
 *   jp2kana  日语 → 假名（看词选读音）
 *   混合模式按「该词该题型错得多」加权抽取，没做过的题型先给一点加成，保证覆盖面。
 */

/* ---------- 无扩展环境（直接双击 study.html）时用样例数据预览 ---------- */

const HAS_CHROME = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;

if (!HAS_CHROME) {
  const now = Date.now();
  const store = {
    jp_settings: { theme: 'auto', enabled: true },
    jp_vocab: [
      { id: 'a1', word: '懐かしい', reading: 'なつかしい', pos: 'イ形容词', meaning: '令人怀念的；怀旧的', createdAt: now },
      { id: 'a2', word: '蘇る', reading: 'よみがえる', pos: '五段动词', meaning: '苏醒；重新浮现', createdAt: now - 6e4 },
      { id: 'a3', word: '駄菓子屋', reading: 'だがしや', pos: '名词', meaning: '卖廉价零食的小店', createdAt: now - 12e4 },
      { id: 'a4', word: '追われる', reading: 'おわれる', pos: '動詞', meaning: '被追赶；被追捕', createdAt: now - 18e4 },
      { id: 'a5', word: '示す', reading: 'しめす', pos: '他动词・五段', meaning: '出示；表示', createdAt: now - 24e4 }
    ],
    jp_study_stats: {
      vocab: {
        '懐かしい': { w: 2, r: 1, lv: 1, t: now },
        '蘇る': { w: 0, r: 3, lv: 3, t: now },
        '駄菓子屋': { w: 0, r: 5, lv: 5, t: now },
        '追われる': { w: 1, r: 0, lv: 0, t: now }
      }
    }
  };
  window.chrome = {
    storage: {
      local: {
        get: (keys) => {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const out = {};
          list.forEach(k => { if (k in store) out[k] = store[k]; });
          return Promise.resolve(out);
        },
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); }
      },
      onChanged: { addListener: () => {} }
    }
  };
}

/* ---------- 常量 ---------- */

const MAX_LV = 5;          // 掌握等级上限，到 5 就不再出题
const RECENT_LIMIT = 8;    // 最近抽过的词不再连出
const ROUND_MIN = 10;      // 一轮最少题数
const ROUND_MAX = 20;      // 一轮最多题数

/* 选择题题型：from = 题干取哪个字段，to = 选项取哪个字段 */
const QUIZ_TYPES = {
  cn2jp:   { short: '中→日',   label: '中文 → 日语', tag: '看中文，选日语词' },
  jp2cn:   { short: '日→中',   label: '日语 → 中文', tag: '看日语词，选中文释义' },
  jp2kana: { short: '日→假名', label: '日语 → 假名', tag: '看日语词，选读音' }
};
const TYPE_ORDER = ['cn2jp', 'jp2cn', 'jp2kana'];

const DEFAULTS = { theme: 'auto', quizType: 'mix' };

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/* 内置词库的提示里带 <b> 强调，先整体转义再放行这一对标签 */
function noteHtml(s) {
  return esc(s).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
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

/* ---------- 状态 ---------- */

let settings = Object.assign({}, DEFAULTS);
let vocab = [];
let stats = {};
let decks = [];

let curDeckId = null;
let filter = 'all';
let keyword = '';

let quiz = null;   // { deckId, mode, type, curType, scope, single, target, seen, right, streak,
                   //   recent, missed, byType, cur, flipped, judged, opts, choice }

/* ---------- 存取 ---------- */

async function loadAll() {
  const got = await chrome.storage.local.get(['jp_vocab', 'jp_study_stats', 'jp_settings']);
  vocab = got.jp_vocab || [];
  stats = got.jp_study_stats || {};
  settings = Object.assign({}, DEFAULTS, got.jp_settings || {});
  applyTheme();
  decks = buildDecks();
}

let saveTimer = null;
function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local.set({ jp_study_stats: stats });
  }, 320);
}

/* ---------- 词库组装 ---------- */

function buildDecks() {
  const list = [];

  {
    list.push({
      id: 'vocab',
      name: '生词本',
      badge: '划词收藏',
      desc: '网页上划词、查词时随手收进来的词',
      words: vocab.map(v => ({
        id: 'v:' + v.word,
        word: v.word,
        reading: v.reading || '',
        pos: v.pos || '',
        meaning: v.meaning || '',
        note: '',
        tag: '',
        raw: v
      }))
    });
  }

  const n3 = window.N3_DECK;
  if (n3 && Array.isArray(n3.words)) {
    list.push({
      id: 'n3',
      name: n3.title || 'N3 词库',
      badge: '内置',
      desc: n3.subtitle || 'JLPT N3 核心词汇',
      words: n3.words.map(d => {
        const parts = String(d.w || '').split('|');
        const reading = parts.length > 1 ? parts[0] : '';
        const word = parts.length > 1 ? parts[1] : parts[0];
        return {
          id: 'n3:' + d.w,
          word,
          reading: reading && reading !== word ? reading : '',
          pos: d.p || '',
          meaning: d.e || '',
          note: d.k || '',
          tag: d.u || ''
        };
      })
    });
  }

  return list;
}

function deckById(id) {
  return decks.find(d => d.id === id) || null;
}

/* ---------- 学习记录 ---------- */

function peek(deckId, word) {
  const s = stats[deckId] && stats[deckId][word];
  return s || { w: 0, r: 0, lv: 0, t: 0 };
}

function ensure(deckId, word) {
  if (!stats[deckId]) stats[deckId] = {};
  if (!stats[deckId][word]) stats[deckId][word] = { w: 0, r: 0, lv: 0, t: 0 };
  return stats[deckId][word];
}

function judge(deckId, word, ok, type) {
  const s = ensure(deckId, word);
  if (ok) {
    s.r++;
    s.lv = Math.min(MAX_LV, s.lv + 1);
  } else {
    s.w++;
    s.lv = Math.max(0, s.lv - 1);
  }
  // 分题型记录：认识意思不等于记得读音，两件事分开算
  if (type && QUIZ_TYPES[type]) {
    if (!s.k) s.k = {};
    const k = s.k[type] || (s.k[type] = { r: 0, w: 0 });
    if (ok) k.r++; else k.w++;
  }
  s.t = Date.now();
  saveStats();
}

/* 这个词能不能出这种题 */
function canType(w, type) {
  if (!w) return false;
  if (type === 'jp2kana') return !!(w.reading && w.reading !== w.word);
  return !!(w.meaning && String(w.meaning).trim());
}

/* 某个题型在该词库里有没有可出的词 */
function typesInDeck(deck) {
  if (!deck) return [];
  return TYPE_ORDER.filter(t => deck.words.some(w => canType(w, t)));
}

function optionText(w, type) {
  if (type === 'cn2jp') return w.word;
  if (type === 'jp2kana') return w.reading;
  return w.meaning;
}

/* 出题权重：掌握等级低 + 错得多 → 权重高 */
function weightOf(deckId, word) {
  const s = peek(deckId, word);
  const byLv = MAX_LV + 1 - s.lv;                 // 6 … 1
  const byWrong = 1 + Math.min(s.w, 6) * 7;       // 1 … 43
  return byLv * byWrong;
}

function deckSummary(deck) {
  let mastered = 0, wrongWords = 0, right = 0, wrong = 0;
  deck.words.forEach(w => {
    const s = peek(deck.id, w.word);
    if (s.lv >= MAX_LV) mastered++;
    if (s.w > 0) wrongWords++;
    right += s.r;
    wrong += s.w;
  });
  const total = deck.words.length;
  const acc = right + wrong ? Math.round(right / (right + wrong) * 100) : null;
  return { total, mastered, wrongWords, right, wrong, acc };
}

/* ---------- 顶栏统计 ---------- */

function paintTop() {
  const all = decks.reduce((o, d) => {
    const s = deckSummary(d);
    o.mastered += s.mastered;
    o.words += s.total;
    o.right += s.right;
    o.wrong += s.wrong;
    return o;
  }, { mastered: 0, words: 0, right: 0, wrong: 0 });

  $('tsDecks').textContent = decks.length;
  $('tsWords').textContent = all.words;
  $('tsMastered').textContent = all.mastered;
  const tries = all.right + all.wrong;
  $('tsAcc').textContent = tries ? Math.round(all.right / tries * 100) + '%' : '—';
}

/* ---------- 视图切换 ---------- */

function show(view) {
  $('v-list').hidden = view !== 'list';
  $('v-deck').hidden = view !== 'deck';
  $('v-quiz').hidden = view !== 'quiz';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- ① 词库列表 ---------- */

function ringSvg(pct) {
  const r = 23;
  const c = 2 * Math.PI * r;
  const on = Math.max(0, Math.min(1, pct)) * c;
  return `
    <svg viewBox="0 0 54 54" width="54" height="54">
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3"
              stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}"/>
    </svg>`;
}

function renderList() {
  const box = $('decks');
  box.textContent = '';

  if (!decks.length) {
    box.innerHTML = '<div class="empty">还没有词库。<br>在网页上划词，点卡片里的「生词本」就能攒起来。</div>';
    return;
  }

  decks.forEach(d => {
    const s = deckSummary(d);
    const pct = s.total ? s.mastered / s.total : 0;
    const empty = !s.total;

    const el = document.createElement('div');
    el.className = 'deck';
    el.innerHTML = `
      <div class="dring">
        ${ringSvg(pct)}
        <div class="val">${Math.round(pct * 100)}<em>%</em></div>
      </div>
      <div class="dmain">
        <div class="dname">${esc(d.name)}<span class="badge">${esc(d.badge)}</span></div>
        <div class="dmeta">
          <span><b>${s.total}</b> 词</span>
          <span>已掌握 <b>${s.mastered}</b></span>
          <span>错过的 <b>${s.wrongWords}</b></span>
          <span>正确率 <b>${s.acc == null ? '—' : s.acc + '%'}</b></span>
        </div>
        <div class="dmeta" style="margin-top:2px"><span>${esc(d.desc)}</span></div>
      </div>
      <div class="dacts">
        <button class="btn ghost" data-open="${esc(d.id)}" type="button">打开</button>
        <button class="btn primary" data-quiz="${esc(d.id)}" type="button" ${empty ? 'disabled' : ''}>抽测</button>
      </div>`;
    box.appendChild(el);
  });

  box.querySelectorAll('[data-open]').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); openDeck(b.dataset.open); });
  });
  box.querySelectorAll('[data-quiz]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = deckById(b.dataset.quiz);
      if (d) startQuiz(d.id, 'choice', { type: effectiveType(d) });
    });
  });
  box.querySelectorAll('.deck').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.querySelector('[data-open]').dataset.open;
      openDeck(id);
    });
  });
}

/* ---------- ② 单个词库 ---------- */

function openDeck(id) {
  const deck = deckById(id);
  if (!deck) return;
  curDeckId = id;
  filter = 'all';
  keyword = '';
  const s = $('search');
  if (s) s.value = '';
  document.querySelectorAll('#filters .chip').forEach(c => {
    c.classList.toggle('on', c.dataset.f === 'all');
  });
  show('deck');
  renderDeck();
}

function visibleWords(deck) {
  let list = deck.words;
  if (filter === 'wrong') list = list.filter(w => peek(deck.id, w.word).w > 0);
  else if (filter === 'weak') list = list.filter(w => peek(deck.id, w.word).lv < MAX_LV);
  else if (filter === 'done') list = list.filter(w => peek(deck.id, w.word).lv >= MAX_LV);

  const k = keyword.trim().toLowerCase();
  if (k) {
    list = list.filter(w =>
      w.word.toLowerCase().includes(k) ||
      (w.reading || '').toLowerCase().includes(k) ||
      (w.meaning || '').toLowerCase().includes(k)
    );
  }
  return list;
}

function lvDots(deckId, word) {
  const s = peek(deckId, word);
  let html = '<div class="lv">';
  for (let i = 0; i < MAX_LV; i++) {
    const on = i < s.lv;
    html += `<i class="${on ? (s.w > 0 && s.lv <= 2 ? 'warn' : 'on') : ''}"></i>`;
  }
  return html + '</div>';
}

function renderDeck() {
  const deck = deckById(curDeckId);
  if (!deck) return;

  const s = deckSummary(deck);
  $('dtitle').textContent = deck.name;
  $('dsub').textContent = `${s.total} 词 · 已掌握 ${s.mastered} · 错过的 ${s.wrongWords}` +
    (s.acc == null ? '' : ` · 正确率 ${s.acc}%`);
  paintTypeChips();

  const box = $('words');
  const list = visibleWords(deck);
  box.textContent = '';

  if (!deck.words.length) {
    box.innerHTML = '<div class="empty" style="grid-column:1/-1">这个词库还是空的。<br>' +
      '在网页上划词，点卡片里的「生词本」收词，或者点上面的「导入生词 JSON」。</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="grid-column:1/-1">这个筛选下没有词。</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach(w => {
    const st = peek(deck.id, w.word);
    const cls = 'wrow' + (st.lv >= MAX_LV ? ' done' : '') + (st.w >= 2 ? ' weak' : '');
    const row = document.createElement('div');
    row.className = cls;
    row.innerHTML = `
      <div class="wbody">
        <div class="wline">
          <span class="ww">${esc(w.word)}</span>
          ${w.reading && w.reading !== w.word ? `<span class="wrd">${esc(w.reading)}</span>` : ''}
          ${w.pos ? `<span class="wpos">${esc(w.pos)}</span>` : ''}
        </div>
        <div class="wm">${esc(w.meaning)}</div>
        ${lvDots(deck.id, w.word)}
      </div>`;
    row.addEventListener('click', () => openSheet(w));
    frag.appendChild(row);
  });
  box.appendChild(frag);
}

/* 题型选择器：这个词库里没有的题型置灰（比如全是假名词，就出不了「日 → 假名」） */
function effectiveType(deck) {
  const cur = settings.quizType || 'mix';
  if (cur === 'mix') return 'mix';
  if (deck && deck.words.some(w => canType(w, cur))) return cur;
  return 'mix';
}

function paintTypeChips() {
  const deck = deckById(curDeckId);
  const usable = typesInDeck(deck);
  const cur = effectiveType(deck);
  const box = $('qtypes');
  if (!box) return;

  box.querySelectorAll('.chip').forEach(b => {
    const t = b.dataset.t;
    const ok = t === 'mix' ? usable.length > 0 : usable.indexOf(t) >= 0;
    b.classList.toggle('on', t === cur);
    b.disabled = !ok;
    b.title = ok ? '' : '这个词库里没有适合这个词型的词';
  });

  const btn = $('qChoice');
  if (btn) btn.disabled = !usable.length;
}

async function setQuizType(t) {
  settings.quizType = t;
  paintTypeChips();
  await chrome.storage.local.set({ jp_settings: settings });
}

/* ---------- 词条详情 ---------- */

let sheetWord = null;

function openSheet(w) {
  sheetWord = w;
  const deck = deckById(curDeckId);
  const s = peek(deck.id, w.word);
  const isVocab = deck.id === 'vocab';

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <button class="sclose" type="button" aria-label="关闭">×</button>
      <div class="qword">${esc(w.word)}</div>
      ${w.reading && w.reading !== w.word ? `<div class="qread">${esc(w.reading)}</div>` : ''}
      <div class="wline" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        ${w.pos ? `<span class="wpos">${esc(w.pos)}</span>` : ''}
        ${w.tag ? `<span class="wpos" style="background:transparent;color:var(--dim)">${esc(w.tag)}</span>` : ''}
      </div>
      <div class="qmean">${esc(w.meaning || '（没有释义）')}</div>
      ${w.note ? `<div class="qnote">${noteHtml(w.note)}</div>` : ''}
      <div class="sstats">
        <span>对<b>${s.r}</b></span>
        <span>错<b>${s.w}</b></span>
        <span>等级<b>${s.lv}/${MAX_LV}</b></span>
      </div>
      ${(() => {
        const k = s.k || {};
        const rows = TYPE_ORDER.filter(t => k[t] && (k[t].r + k[t].w) > 0)
          .map(t => `${QUIZ_TYPES[t].short} <b>${k[t].r}</b>/${k[t].r + k[t].w}`);
        return rows.length ? `<div class="sktypes">题型 ${rows.join(' · ')}</div>` : '';
      })()}
      <div class="actions">
        <button class="btn" data-a="speak" type="button">发音</button>
        <button class="btn primary" data-a="drill" type="button">只练这个</button>
        ${isVocab ? '<button class="btn bad" data-a="del" type="button">从生词本删掉</button>' : ''}
      </div>
    </div>`;

  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.sclose').addEventListener('click', close);

  mask.querySelector('[data-a="speak"]').addEventListener('click', () => speakJa(w.word));

  mask.querySelector('[data-a="drill"]').addEventListener('click', () => {
    close();
    startQuiz(deck.id, 'flip', { single: w.word });
  });

  const del = mask.querySelector('[data-a="del"]');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm(`把「${w.word}」从生词本删掉？`)) return;
      vocab = vocab.filter(v => v.word !== w.word);
      await chrome.storage.local.set({ jp_vocab: vocab });
      if (stats.vocab) delete stats.vocab[w.word];
      await chrome.storage.local.set({ jp_study_stats: stats });
      decks = buildDecks();
      close();
      renderDeck();
      paintTop();
    });
  }

  // Esc 关闭由 bind() 的全局 keydown 统一处理
}

/* ---------- ③ 抽测：出题 ---------- */

function quizPool() {
  const deck = deckById(quiz.deckId);
  let list = deck.words;

  if (quiz.single) list = list.filter(w => w.word === quiz.single);
  else if (quiz.scope === 'wrong') list = list.filter(w => peek(deck.id, w.word).w > 0);

  // 指定题型时只留能出这个题型的词（假名题要有读音），免得抽到就退化成翻卡片
  if (quiz.mode === 'choice' && quiz.type && quiz.type !== 'mix') {
    const typed = list.filter(w => canType(w, quiz.type));
    if (typed.length) list = typed;
  }

  const fresh = list.filter(w => peek(deck.id, w.word).lv < MAX_LV);
  return fresh.length ? fresh : list;   // 全掌握了就循环复习
}

function pickWord() {
  const pool = quizPool();
  if (!pool.length) return null;

  // 小词库别让「最近抽过」把候选取空：池子小就只避开最近一两个
  const avoid = Math.min(RECENT_LIMIT, Math.max(1, Math.floor(pool.length * 0.4)));
  const recent = quiz.recent.slice(-avoid);

  let cand = pool.filter(w => recent.indexOf(w.word) < 0);
  if (!cand.length) { quiz.recent = []; cand = pool; }

  let total = 0;
  const ws = cand.map(w => { const x = weightOf(quiz.deckId, w.word); total += x; return x; });
  if (total <= 0) return cand[Math.floor(Math.random() * cand.length)];

  let r = Math.random() * total;
  for (let i = 0; i < cand.length; i++) {
    r -= ws[i];
    if (r <= 0) return cand[i];
  }
  return cand[cand.length - 1];
}

/* 选择题干扰项：优先同词性、同分类，意思 / 读音重复的剔掉 */
function buildOptions(answer, deck, type) {
  const right = optionText(answer, type);
  if (!right) return [];

  const seenText = new Set([right]);
  const pool = deck.words.filter(w => {
    if (w.word === answer.word) return false;
    if (!canType(w, type)) return false;
    const t = optionText(w, type);
    if (!t || seenText.has(t)) return false;
    // 释义一样、读音一样，选它也算对，不能当干扰项
    if (type === 'cn2jp' && w.meaning === answer.meaning) return false;
    if (type === 'jp2kana' && w.reading === answer.reading) return false;
    return true;
  });

  const near = pool.filter(w => (w.pos && w.pos === answer.pos) || (w.tag && w.tag === answer.tag));
  const far = pool.filter(w => near.indexOf(w) < 0);

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const picked = [];
  const take = (arr) => {
    for (const w of shuffle(arr)) {
      if (picked.length >= 3) return;
      const t = optionText(w, type);
      if (seenText.has(t)) continue;
      seenText.add(t);
      picked.push(w);
    }
  };
  take(near);
  take(far);

  const opts = picked.map(w => ({ text: optionText(w, type), right: false }));
  opts.push({ text: right, right: true });
  return shuffle(opts);
}

/* 混合模式下，同一题型里错得多的更常出现；没做过的给点加成，先把三类都过一遍 */
function typeWeight(deckId, word, type) {
  const s = peek(deckId, word);
  const k = (s.k && s.k[type]) || { r: 0, w: 0 };
  return 1 + Math.min(k.w, 5) * 2 + (k.r + k.w === 0 ? 1.5 : 0);
}

/* 给某道题挑一个题型（混合模式） */
function pickTypeFor(w, deck) {
  const types = TYPE_ORDER.filter(t => canType(w, t) && buildOptions(w, deck, t).length >= 2);
  if (!types.length) return null;

  let total = 0;
  const ws = types.map(t => { const x = typeWeight(quiz.deckId, w.word, t); total += x; return x; });
  let r = Math.random() * total;
  for (let i = 0; i < types.length; i++) {
    r -= ws[i];
    if (r <= 0) return types[i];
  }
  return types[types.length - 1];
}

/* ---------- 抽测：开始 ---------- */

function startQuiz(deckId, mode, opt) {
  opt = opt || {};
  const deck = deckById(deckId);
  if (!deck || !deck.words.length) {
    alert('这个词库还没有词。');
    return;
  }

  let type = null;
  let note = '';
  if (mode === 'choice') {
    const usable = typesInDeck(deck);
    const want = opt.type || settings.quizType || 'mix';

    if (!usable.length) {
      mode = 'flip';
      note = '这个词库里还没有释义，先看卡片';
    } else if (want === 'mix' || usable.indexOf(want) < 0) {
      type = 'mix';
      if (want !== 'mix' && QUIZ_TYPES[want]) {
        note = `这个词库里没有「${QUIZ_TYPES[want].label}」的词，已改用混合题型`;
      }
    } else {
      type = want;
    }
  }

  quiz = {
    deckId,
    mode,
    type,
    curType: null,
    scope: opt.single ? 'single' : (opt.scope === 'wrong' ? 'wrong' : 'all'),
    single: opt.single || null,
    target: 0,
    seen: 0,
    right: 0,
    streak: 0,
    recent: [],
    missed: [],
    byType: {},
    cur: null,
    flipped: false,
    judged: false,
    opts: [],
    choice: null
  };

  const poolSize = quizPool().length;
  quiz.target = opt.single ? 3 : Math.min(ROUND_MAX, Math.max(ROUND_MIN, poolSize));

  // 只练错的，但这个库里还没有错题 —— 退回全部，别让人对着空白页
  if (quiz.scope === 'wrong' && !poolSize) {
    quiz.scope = 'all';
    filter = 'all';
    document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('on', c.dataset.f === 'all'));
  }

  const label = mode === 'choice'
    ? '选择题 · ' + (type === 'mix' ? '混合题型' : QUIZ_TYPES[type].label)
    : '翻卡片';
  const extra = quiz.single ? ` · 只练「${quiz.single}」`
    : quiz.scope === 'wrong' ? ' · 只练错过的' : '';
  $('qmode').textContent = `${deck.name} · ${label}${extra}${note ? ' · ' + note : ''}`;

  $('qSeen').textContent = '0';
  $('qRight').textContent = '0';
  $('qStreak').textContent = '0';

  show('quiz');
  nextCard();
}

function paintQuizStat() {
  $('qSeen').textContent = quiz.seen;
  $('qRight').textContent = quiz.right;
  $('qStreak').textContent = quiz.streak;
  const pct = quiz.target ? Math.min(100, quiz.seen / quiz.target * 100) : 0;
  $('qfill').style.width = pct.toFixed(1) + '%';
}

/* ---------- 抽测：翻卡片 ---------- */

function nextCard() {
  if (!quiz) return;
  if (quiz.seen >= quiz.target) { renderFinish(); return; }

  const w = pickWord();
  if (!w) { renderFinish('这个词库里没有可练的词。'); return; }

  quiz.cur = w;
  quiz.curType = null;
  quiz.flipped = false;
  quiz.judged = false;

  if (quiz.mode === 'choice') renderChoice();
  else renderFlip();

  paintQuizStat();
}

function lvLine(deckId, word) {
  const s = peek(deckId, word);
  return `<span>等级 ${s.lv}/${MAX_LV} · 对 ${s.r} · 错 ${s.w}</span>`;
}

function renderFlip() {
  const w = quiz.cur;
  const body = $('qbody');
  body.innerHTML = `
    <div class="qstage">
      <div class="fcard" id="fcard">
        <div class="face front">
          <div class="qtag">这个词是</div>
          <div class="center">
            <div class="qword">${esc(w.word)}</div>
            ${w.reading && w.reading !== w.word ? `<div class="qread">${esc(w.reading)}</div>` : ''}
          </div>
          <div class="flipnote">
            <span>点卡片 / 空格 翻面</span>
            ${lvLine(quiz.deckId, w.word)}
          </div>
        </div>
        <div class="face back">
          <div class="qtag">释义</div>
          <div class="center">
            <div class="qmean">${esc(w.meaning || '（没有释义）')}</div>
            ${w.note ? `<div class="qnote">${noteHtml(w.note)}</div>` : ''}
          </div>
          <div class="flipnote">
            <span>${esc(w.pos || w.tag || '')}</span>
            <span>记住了吗</span>
          </div>
        </div>
      </div>
    </div>
    <div class="actions" id="qacts"></div>`;

  const card = $('fcard');
  card.addEventListener('click', () => flipCard());

  paintFlipActions();
}

function paintFlipActions() {
  const acts = $('qacts');
  if (!acts) return;
  if (!quiz.flipped) {
    acts.innerHTML = `
      <button class="btn ghost" data-a="speak" type="button">发音</button>
      <button class="btn primary" data-a="flip" type="button">翻面</button>`;
  } else {
    acts.innerHTML = `
      <button class="btn bad" data-a="no" type="button">没记住 <kbd style="opacity:.6">1</kbd></button>
      <button class="btn ok" data-a="yes" type="button">记住了 <kbd style="opacity:.6">2</kbd></button>`;
  }

  acts.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'speak') speakJa(quiz.cur.word);
      else if (a === 'flip') flipCard();
      else if (a === 'yes') answer(true);
      else if (a === 'no') answer(false);
    });
  });
}

function flipCard() {
  if (!quiz || quiz.judged || quiz.mode !== 'flip') return;
  quiz.flipped = !quiz.flipped;
  const card = $('fcard');
  if (card) card.classList.toggle('flipped', quiz.flipped);
  paintFlipActions();
}

/* ---------- 抽测：选择题 ---------- */

/* 题干下的小标签：词性 + 分类，分类里已经含词性时就去重 */
function typeMeta(w) {
  const pos = (w.pos || '').trim();
  const tag = (w.tag || '').trim();
  if (!pos) return tag;
  if (tag && tag.indexOf(pos) >= 0) return tag;
  return tag ? pos + ' · ' + tag : pos;
}

/* 题干：中文题型给释义，日语题型给词（假名题不能露读音） */
function renderPrompt(w, type) {
  if (type === 'cn2jp') {
    return `
      <div class="qwordbox cn">
        <div class="qcn">${esc(w.meaning)}</div>
        ${typeMeta(w) ? `<div class="qmeta">${esc(typeMeta(w))}</div>` : ''}
      </div>`;
  }
  if (type === 'jp2kana') {
    return `
      <div class="qwordbox">
        <div class="qword">${esc(w.word)}</div>
        ${typeMeta(w) ? `<div class="qmeta">${esc(typeMeta(w))}</div>` : ''}
      </div>`;
  }
  return `
    <div class="qwordbox">
      <div class="qword">${esc(w.word)}</div>
      ${w.reading && w.reading !== w.word ? `<div class="qread">${esc(w.reading)}</div>` : ''}
      ${typeMeta(w) ? `<div class="qmeta">${esc(typeMeta(w))}</div>` : ''}
    </div>`;
}

function renderChoice() {
  const w = quiz.cur;
  const deck = deckById(quiz.deckId);

  let type = quiz.type;
  if (type === 'mix' || !type) type = pickTypeFor(w, deck);
  if (!type) { degradeToFlip('这个词没有能出的题型，已切到翻卡片'); return; }

  const opts = buildOptions(w, deck, type);
  // 词库太小凑不出两个选项时，退回翻卡片
  if (opts.length < 2) { degradeToFlip('凑不出选项，已切到翻卡片'); return; }

  quiz.curType = type;
  quiz.opts = opts;
  quiz.choice = null;

  const optClass = type === 'jp2cn' ? 'opt' : (type === 'jp2kana' ? 'opt kana' : 'opt jp');

  const body = $('qbody');
  body.innerHTML = `
    <div class="qtype">${QUIZ_TYPES[type].tag}</div>
    ${renderPrompt(w, type)}
    <div class="opts" id="opts">
      ${opts.map((o, i) => `
        <button class="${optClass}" data-i="${i}" type="button">
          <span class="k">${i + 1}</span>
          <span class="otext">${esc(o.text)}</span>
        </button>`).join('')}
    </div>
    <div class="verdict" id="verdict"></div>`;

  body.querySelectorAll('.opt').forEach(b => {
    b.addEventListener('click', () => choose(Number(b.dataset.i)));
  });
}

function degradeToFlip(msg) {
  quiz.mode = 'flip';
  quiz.curType = null;
  $('qmode').textContent += ' · ' + msg;
  renderFlip();
}

function choose(i) {
  if (!quiz || quiz.judged) return;
  const opt = quiz.opts[i];
  if (!opt) return;

  quiz.judged = true;
  quiz.choice = i;

  const rightIdx = quiz.opts.findIndex(o => o.right);
  const body = $('qbody');
  body.querySelectorAll('.opt').forEach((b, idx) => {
    b.disabled = true;
    if (idx === rightIdx) b.classList.add('right');
    else if (idx === i && !opt.right) b.classList.add('wrong');
    else b.classList.add('dim');
  });

  answer(opt.right);
  renderVerdict(opt.right, rightIdx);
}

/* 判完补上题干里没给的信息：
 *   中→日 补读音、日→中 补提示、日→假名 补释义 */
function verdictSub(w) {
  const reading = w.reading && w.reading !== w.word ? `（${esc(w.reading)}）` : '';
  if (quiz.curType === 'jp2kana') return esc(w.word) + reading + (w.meaning ? ` · ${esc(w.meaning)}` : '');
  if (quiz.curType === 'jp2cn') return w.note ? noteHtml(w.note) : '';
  return esc(w.word) + reading;
}

function renderVerdict(ok, rightIdx) {
  const w = quiz.cur;
  const sub = verdictSub(w);

  const v = $('verdict');
  v.innerHTML = `
    <span class="mk ${ok ? 'ok' : 'bad'}">${ok ? '✓ 对' : '✗ 错'}</span>
    <div class="vtext">
      <div class="vmain">${ok ? '记住了' : '正解：' + esc(quiz.opts[rightIdx].text)}</div>
      ${sub ? `<div class="vsub">${sub}</div>` : ''}
    </div>
    <span class="grow"></span>
    <button class="btn ghost mini2" data-a="speak" type="button" title="朗读这个词">听</button>
    <button class="btn primary" data-a="next" type="button">下一题 →</button>`;
  v.querySelector('[data-a="next"]').addEventListener('click', nextCard);
  v.querySelector('[data-a="speak"]').addEventListener('click', () => speakJa(w.word));
}

/* ---------- 判分 ---------- */

function answer(ok) {
  const w = quiz.cur;
  const type = quiz.mode === 'choice' ? quiz.curType : null;

  judge(quiz.deckId, w.word, ok, type);

  quiz.seen++;
  if (ok) quiz.right++;
  else if (quiz.missed.indexOf(w.word) < 0) quiz.missed.push(w.word);
  quiz.streak = ok ? quiz.streak + 1 : 0;

  if (type) {
    const b = quiz.byType[type] || (quiz.byType[type] = { seen: 0, right: 0 });
    b.seen++;
    if (ok) b.right++;
  }

  quiz.recent.push(w.word);
  if (quiz.recent.length > RECENT_LIMIT) quiz.recent.shift();

  paintQuizStat();

  if (quiz.mode === 'flip') setTimeout(nextCard, 90);
}

/* ---------- 结束 ---------- */

function renderFinish(msg) {
  const deck = deckById(quiz.deckId);
  const acc = quiz.seen ? Math.round(quiz.right / quiz.seen * 100) : 0;

  // 本轮错过的词
  const wrongWords = quiz.missed
    .map(word => deck.words.find(x => x.word === word))
    .filter(Boolean);

  const typeRows = TYPE_ORDER
    .filter(t => quiz.byType[t])
    .map(t => {
      const b = quiz.byType[t];
      return `<span class="tstat"><i>${QUIZ_TYPES[t].short}</i><b class="${b.right === b.seen ? 'ok' : (b.right * 2 < b.seen ? 'bad' : '')}">${b.right}</b>/${b.seen}</span>`;
    });

  $('qfill').style.width = '100%';
  $('qbody').innerHTML = `
    <div class="finish">
      <div class="big">${msg ? esc(msg) : '这一轮结束了'}</div>
      <div class="small">
        做了 <b>${quiz.seen}</b> 题 · 正确 <b>${quiz.right}</b> 题 · 正确率 <b>${acc}%</b><br>
        ${acc >= 90 ? '状态很好，可以再拉一轮新的。' :
          acc >= 70 ? '差不多了，错的那几个再滚一遍就稳。' :
          '错的词权重已经调高了，下一轮会更集中地考它们。'}
      </div>
      ${typeRows.length > 1 ? `<div class="tstats">${typeRows.join('')}</div>` : ''}
      ${wrongWords.length ? `
        <div class="small" style="margin-top:16px">这一轮错过的词（点一个单独练）</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:8px">
          ${wrongWords.map(w => `<button class="chip" data-w="${esc(w.word)}" type="button">${esc(w.word)}</button>`).join('')}
        </div>` : ''}
      <div class="actions">
        <button class="btn primary" data-a="again" type="button">再来一轮</button>
        <button class="btn" data-a="deck" type="button">看词库</button>
        <button class="btn ghost" data-a="home" type="button">回词库列表</button>
      </div>
    </div>`;

  const again = () => startQuiz(quiz.deckId, quiz.mode === 'choice' ? 'choice' : 'flip',
    { single: quiz.single, type: quiz.type });

  const body = $('qbody');
  body.querySelector('[data-a="again"]').addEventListener('click', again);
  body.querySelectorAll('[data-w]').forEach(b => {
    b.addEventListener('click', () => {
      startQuiz(quiz.deckId, quiz.mode === 'choice' ? 'choice' : 'flip',
        { single: b.dataset.w, type: quiz.type });
    });
  });
  body.querySelector('[data-a="deck"]').addEventListener('click', () => {
    curDeckId = quiz.deckId;
    show('deck');
    renderDeck();
    paintTop();
  });
  body.querySelector('[data-a="home"]').addEventListener('click', () => {
    show('list');
    renderList();
    paintTop();
  });
}

/* ---------- 主题 ---------- */

function applyTheme() {
  const t = settings.theme || 'auto';
  document.documentElement.setAttribute('data-theme', t === 'light' || t === 'dark' ? t : 'auto');
  const btn = $('themeBtn');
  if (btn) btn.textContent = t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统';
}

async function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const i = order.indexOf(settings.theme || 'auto');
  settings.theme = order[(i + 1) % order.length];
  applyTheme();
  await chrome.storage.local.set({ jp_settings: settings });
}

/* ---------- 导入生词 ---------- */

function importVocab() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : (data.words || []);
      const words = arr
        .map(x => ({
          id: x.id || 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          word: String(x.word || x.w || '').trim(),
          reading: String(x.reading || x.kana || '').trim(),
          pos: String(x.pos || '').trim(),
          meaning: String(x.meaning || x.cn || x.e || '').trim(),
          createdAt: x.createdAt || Date.now()
        }))
        .filter(x => x.word);

      if (!words.length) { alert('这个文件里没有可识别的词。'); return; }

      const seen = new Set(vocab.map(v => v.word));
      let added = 0;
      words.forEach(w => {
        if (seen.has(w.word)) return;
        seen.add(w.word);
        vocab.unshift(w);
        added++;
      });

      await chrome.storage.local.set({ jp_vocab: vocab });
      decks = buildDecks();
      renderList();
      paintTop();
      alert(`导入完成：新增 ${added} 个词${added < words.length ? `，跳过重复 ${words.length - added} 个` : ''}。`);
    } catch (e) {
      alert('文件读不出来，确认是「导出」得到的 JSON。');
    }
  });
  input.click();
}

/* ---------- 事件 ---------- */

function bind() {
  $('themeBtn').addEventListener('click', cycleTheme);
  $('importBtn').addEventListener('click', importVocab);
  $('backHome').addEventListener('click', () => {
    show('list');
    renderList();
    paintTop();
  });

  $('qFlip').addEventListener('click', () => startQuiz(curDeckId, 'flip', { scope: filter }));
  $('qChoice').addEventListener('click', () => {
    startQuiz(curDeckId, 'choice', { type: effectiveType(deckById(curDeckId)), scope: filter });
  });
  $('qtypes').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    setQuizType(b.dataset.t);
  });
  $('quitQuiz').addEventListener('click', () => {
    curDeckId = quiz ? quiz.deckId : curDeckId;
    show('deck');
    renderDeck();
    paintTop();
  });

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filter = b.dataset.f;
    document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('on', c === b));
    renderDeck();
  });

  let t = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(t);
    const v = e.target.value;
    t = setTimeout(() => { keyword = v; renderDeck(); }, 120);
  });

  document.addEventListener('keydown', (e) => {
    const mask = document.querySelector('.mask');
    if (mask) {
      if (e.key === 'Escape') mask.remove();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('v-quiz').hidden) { $('quitQuiz').click(); return; }
      if (!$('v-deck').hidden) { $('backHome').click(); return; }
      return;
    }
    if (!$('v-quiz').hidden && quiz) {
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        if (quiz.mode === 'choice') {
          const v = $('verdict');
          const next = v && v.querySelector('[data-a="next"]');
          if (next) next.click();
          else flipCard();
        } else if (quiz.flipped) {
          answer(true);
        } else {
          flipCard();
        }
        return;
      }
      if (quiz.mode === 'choice') {
        const n = Number(e.key);
        if (n >= 1 && n <= 4) { choose(n - 1); return; }
      } else if (quiz.flipped) {
        if (e.key === '1') answer(false);
        else if (e.key === '2') answer(true);
      }
    }
  });

  // 生词本在别处被改动（划词收藏、popup 删除）时同步
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.jp_vocab) {
        vocab = changes.jp_vocab.newValue || [];
        decks = buildDecks();
        if (!$('v-list').hidden) renderList();
        if (!$('v-deck').hidden) renderDeck();
        paintTop();
      }
      if (changes.jp_settings && changes.jp_settings.newValue) {
        const t2 = changes.jp_settings.newValue.theme;
        if (t2 && t2 !== settings.theme) { settings.theme = t2; applyTheme(); }
      }
    });
  }
}

/* ---------- 启动 ---------- */

(async function init() {
  await loadAll();

  // 预览 / 深链：study.html?deck=n3&quiz=choice
  const q = new URLSearchParams(location.search);
  const forced = q.get('theme');
  if (forced === 'light' || forced === 'dark') document.documentElement.setAttribute('data-theme', forced);

  paintTop();
  renderList();
  bind();

  const wantDeck = q.get('deck');
  if (wantDeck && deckById(wantDeck)) {
    openDeck(wantDeck);
    const mode = q.get('quiz');
    if (mode === 'flip' || mode === 'choice') {
      const wantType = q.get('type');
      if (TYPE_ORDER.indexOf(wantType) >= 0 || wantType === 'mix') {
        settings.quizType = wantType;
        paintTypeChips();
      }
      startQuiz(wantDeck, mode, { type: effectiveType(deckById(wantDeck)) });
      if (q.get('flip') === '1' && quiz && quiz.mode === 'flip') flipCard();

      // 预览：?finish=1 —— 直接看结算页（含题型统计）
      if (q.get('finish') === '1' && quiz && quiz.mode === 'choice') {
        quiz.byType = { cn2jp: { seen: 5, right: 4 }, jp2kana: { seen: 3, right: 1 } };
        quiz.seen = 8;
        quiz.right = 5;
        quiz.missed = [deckById(wantDeck).words[0].word];
        renderFinish();
      }
    }
    const w = q.get('word');
    if (w) {
      const deck = deckById(wantDeck);
      const hit = deck.words.find(x => x.word === w);
      if (hit) openSheet(hit);
    }

    // 预览：?quiz=choice&pick=1 —— 直接演示「选错」的判定态
    const pick = q.get('pick');
    if (pick != null && quiz && quiz.mode === 'choice') choose(Number(pick));
  }
})();
