/* 左右日语 · 划词词典 —— 后台查询层
 * 职责：本地词库 → Jisho（读音/词性/JLPT/英文释义）→ MyMemory（中文释义）
 * 三层缓存避免重复请求，Jisho 与 MyMemory 均无需 API Key。
 */

importScripts('dict-local.js');

const LOCAL = self.__JP_LOCAL_DICT__ || Object.create(null);

const JISHO_API = 'https://jisho.org/api/v1/search/words?keyword=';
const MYMEMORY_API = 'https://api.mymemory.translated.net/get';
// v2：修复复合词误匹配后升级，避免命中 v1 里存下的错误结果
const CACHE_KEY = 'jp_lookup_cache_v2';
const LEGACY_CACHE_KEYS = ['jp_lookup_cache_v1'];
const CACHE_MAX = 900;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 14; // 14 天

let memCache = null;

async function loadCache() {
  if (memCache) return memCache;
  try {
    const got = await chrome.storage.local.get(CACHE_KEY);
    memCache = got[CACHE_KEY] || {};
    // 顺手清掉旧版本缓存，避免占空间
    try { await chrome.storage.local.remove(LEGACY_CACHE_KEYS); } catch (e2) { /* 忽略 */ }
  } catch (e) {
    memCache = {};
  }
  return memCache;
}

async function saveCache(map) {
  const keys = Object.keys(map);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => (map[a].t || 0) - (map[b].t || 0));
    const drop = keys.length - CACHE_MAX;
    for (let i = 0; i < drop; i++) delete map[keys[i]];
  }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: map });
  } catch (e) {
    /* 存储超限就放弃缓存，不影响查询 */
  }
}

async function cacheGet(key) {
  const map = await loadCache();
  const hit = map[key];
  if (!hit) return null;
  if (Date.now() - (hit.t || 0) > CACHE_TTL) {
    delete map[key];
    return null;
  }
  return hit.v;
}

async function cacheSet(key, value) {
  const map = await loadCache();
  map[key] = { t: Date.now(), v: value };
  await saveCache(map);
}

/* ---------------- 词性中文化 ---------------- */

const POS_MAP = [
  [/godan verb/i, '五段动词'],
  [/ichidan verb/i, '一段动词'],
  [/suru verb/i, 'サ变动词'],
  [/kuru verb/i, 'カ变动词'],
  [/irregular verb/i, '不规则动词'],
  [/transitive verb/i, '他动词'],
  [/intransitive verb/i, '自动词'],
  [/i-adjective/i, 'イ形容词'],
  [/na-adjective/i, 'ナ形容词'],
  [/adverbial noun/i, '副词性名词'],
  [/noun/i, '名词'],
  [/adverb/i, '副词'],
  [/particle/i, '助词'],
  [/conjunction/i, '接续词'],
  [/interjection/i, '感叹词'],
  [/pronoun/i, '代词'],
  [/counter/i, '量词'],
  [/prefix/i, '前缀'],
  [/suffix/i, '后缀'],
  [/auxiliary/i, '助动词'],
  [/expression/i, '惯用表达'],
  [/numeric/i, '数词']
];

function posToZh(list) {
  if (!Array.isArray(list)) return '';
  const out = [];
  for (const p of list) {
    for (const [re, zh] of POS_MAP) {
      if (re.test(p)) {
        if (!out.includes(zh)) out.push(zh);
        break;
      }
    }
  }
  return out.slice(0, 2).join(' · ');
}

const JP_TAG_ZH = {
  '動詞': '动词', '名詞': '名词', '形容詞': '形容词', '形容動詞': '形容动词',
  '副詞': '副词', '接続詞': '接续词', 'カタカナ語': '片假名语', '感動詞': '感叹词',
  '連体詞': '连体词', '自動詞': '自动词', '他動詞': '他动词', '他動詞サ変': '他动词',
  '五段': '五段', '一段': '一段', 'サ変': 'サ变动词', 'イ形容詞': 'イ形容词',
  'ナ形容詞': 'ナ形容词', '慣用句': '惯用句', '自他ペア': '自他动词对'
};

function localPosToZh(p) {
  if (!p) return '';
  const out = [];
  for (const raw of p.split(/[・·]/)) {
    const part = raw.trim();
    if (!part) continue;
    let zh = JP_TAG_ZH[part];
    if (!zh) {
      const m = part.match(/^(.+?)[（(](.+?)[）)]$/);
      zh = m ? (JP_TAG_ZH[m[1]] || m[1]) : part;
    }
    if (!out.includes(zh)) out.push(zh);
  }
  return out.slice(0, 2).join(' · ');
}

/* ---------------- 在线查询 ---------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function jishoSearch(keyword) {
  const url = JISHO_API + encodeURIComponent(keyword);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('jisho-' + res.status);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function translateText(text, from = 'ja', to = 'zh-CN', opts) {
  const q = String(text || '').slice(0, 480).trim();
  if (!q) return '';
  const url = `${MYMEMORY_API}?q=${encodeURIComponent(q)}&langpair=${from}|${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('mm-' + res.status);
  const json = await res.json();
  let t = json && json.responseData ? json.responseData.translatedText : '';
  t = decodeEntities(t).trim();
  if (!t || /^MYMEMORY WARNING/i.test(t) || /^PLEASE SELECT/i.test(t)) return '';
  // 与原文相同通常意味着没翻出来。但中→日有些词本来就同形（猫 / 学校），由调用方决定是否接受
  if (t.toLowerCase() === q.toLowerCase() && !(opts && opts.allowSame)) return '';
  return t;
}

/* MyMemory 的译文常带 "译文[原文]" 这类残留，清一下 */
function cleanZh(t) {
  return String(t || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；、）])/g, '$1')
    .replace(/\s*([；;])\s*/g, '；')
    .replace(/^[；;、，。\s]+|[；;、，。\s]+$/g, '')
    .replace(/([^，。；、\s])[吧呢啊呀]$/, '$1')
    .trim();
}

/* 译文质量粗筛：太短、过长、或明显没翻译，都判为不可用 */
function looksTranslated(src, dst) {
  if (!dst) return false;
  const s = src.replace(/\s+/g, '');
  const d = dst.replace(/\s+/g, '');
  if (!d || d.length < 1) return false;
  if (d.toLowerCase() === s.toLowerCase()) return false;
  if (d.length > s.length * 4) return false;
  if (/[?？!！]\s*$/.test(dst) && !/[?？!！]\s*$/.test(src)) return false; // 单词被翻成问句
  return true;
}

/* ---------------- 主查询 ---------------- */

/* ---------------- 活用还原（应对 Jisho 的复合词误匹配） ---------------- */

// 五段动词未然形：あ段 → う段
const A2U = { 'わ': 'う', 'か': 'く', 'が': 'ぐ', 'さ': 'す', 'た': 'つ', 'な': 'ぬ', 'ば': 'ぶ', 'ま': 'む', 'ら': 'る', 'は': 'う' };
// 連用形：い段 → う段
const I2U = { 'い': 'う', 'き': 'く', 'ぎ': 'ぐ', 'し': 'す', 'ち': 'つ', 'に': 'ぬ', 'び': 'ぶ', 'み': 'む', 'り': 'る' };
// 仮定形／可能形：え段 → う段
const E2U = { 'え': 'う', 'け': 'く', 'げ': 'ぐ', 'せ': 'す', 'て': 'つ', 'ね': 'ぬ', 'べ': 'ぶ', 'め': 'む', 'れ': 'る' };

function swapEnd(w, map) {
  if (!w) return null;
  const last = w.slice(-1);
  if (!map[last]) return null;
  return w.slice(0, -1) + map[last];
}

/** 把变形词还原成几个可能的辞书形，按可信度排序 */
function deinflect(w) {
  const out = [];
  const add = (x) => {
    if (x && x.length > 1 && x !== w && !out.includes(x)) out.push(x);
  };

  // 被动：五段「〜れる」/ 一段「〜られる」
  if (w.endsWith('られる')) add(w.slice(0, -3) + 'る');
  if (w.endsWith('れる')) {
    const stem = w.slice(0, -2);
    add(swapEnd(stem, A2U));   // 追われる → 追う
    add(stem + 'る');          // 食べられる → 食べる
  }

  // 使役：〜させる / 〜せる
  if (w.endsWith('させる')) {
    add(w.slice(0, -3) + 'る');
    add(w.slice(0, -3) + 'する');
  }
  if (w.endsWith('せる')) {
    const stem = w.slice(0, -2);
    add(swapEnd(stem, A2U));
    add(stem + 'る');
  }

  // 否定：〜ない
  if (w.endsWith('ない')) {
    const stem = w.slice(0, -2);
    add(swapEnd(stem, A2U));
    add(stem + 'る');
  }

  // ます / たい
  if (w.endsWith('ます')) {
    const stem = w.slice(0, -2);
    add(swapEnd(stem, I2U));
    add(stem + 'る');
  }
  if (w.endsWith('たい')) add(swapEnd(w.slice(0, -2), I2U));

  // て形 / た形
  const TE_MAP = [['って', ['う', 'つ', 'る']], ['んで', ['ぬ', 'ぶ', 'む']], ['いて', ['く']], ['いで', ['ぐ']], ['して', ['す']]];
  for (const [suf, cands] of TE_MAP) {
    for (const tail of ['て', 'た']) {
      const s = suf.slice(0, -1) + tail;
      if (w.endsWith(s)) {
        const stem = w.slice(0, -s.length);
        for (const c of cands) add(stem + c);
      }
    }
  }
  if (w.endsWith('て') || w.endsWith('た')) add(w.slice(0, -1) + 'る');

  // 仮定形：〜ば
  if (w.endsWith('ば')) add(swapEnd(w.slice(0, -1), E2U));

  // 可能形：え段 + る
  if (w.endsWith('る') && w.length > 2) {
    const to = E2U[w.slice(-2, -1)];
    if (to) add(w.slice(0, -2) + to);
  }

  // 五段动词只选了未然形词干（書か → 書く、読ま → 読む）
  const a2u = A2U[w.slice(-1)];
  if (a2u) add(w.slice(0, -1) + a2u);

  // 兜底：一段动词只选了词干（食べ → 食べる）。
  // 这条放在最后，候选会经过 Jisho 精确匹配验证，误报自然被淘汰。
  if (/[いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ]$/.test(w)) {
    add(w + 'る');
  }

  return out;
}

function pickJishoEntry(list, query) {
  if (!list.length) return null;
  // 优先完全匹配词形的条目
  const exact = list.find(e =>
    (e.japanese || []).some(j => j.word === query || j.reading === query)
  );
  const entry = exact || list[0];
  const ja = (entry.japanese || [])[0] || {};
  const sense = (entry.senses || [])[0] || {};
  const levels = (entry.jlpt || [])
    .filter(x => /^jlpt-n\d$/.test(x))
    .map(x => parseInt(x.replace('jlpt-n', ''), 10));
  const jlptNum = levels.length ? Math.max(...levels) : 0; // 一词多级时取最基础的一档
  return {
    matched: ja.word || ja.reading || query,
    reading: ja.reading || '',
    exactMatch: !!exact,
    en: (sense.english_definitions || []).slice(0, 4),
    posEn: sense.parts_of_speech || [],
    pos: posToZh(sense.parts_of_speech),
    jlpt: jlptNum ? 'N' + jlptNum : '',
    common: !!entry.is_common,
    more: (list[1] ? (list[1].japanese || [])[0] : null) || null
  };
}

async function lookupWord(rawWord) {
  const word = String(rawWord || '').trim();
  if (!word) return { ok: false, error: 'empty' };

  const cacheKey = 'w:' + word;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const local = LOCAL[word] || null;

  let jisho = null;
  let jishoFailed = false;
  let approx = false;
  try {
    const list = await jishoSearch(word);
    jisho = pickJishoEntry(list, word);

    // Jisho 不是精确匹配时，要区分它是「还原对了」还是「匹配错了」：
    //   比查询词短 → 它自己把变形还原成了辞书形（食べました → 食べる），信任它
    //   比查询词长 → 拿了个包含查询词的复合词（追われる → 追われる身）
    //   与查询词等长但不同 → 按读音片段凑了个别字（書か → 書架）
    // 后两种用本地规则还原成辞书形再查，拿到精确词条才替换。
    const qLen = word.length;
    const mLen = (jisho && jisho.matched ? jisho.matched.length : 0);
    if (jisho && !jisho.exactMatch && mLen >= qLen && jisho.matched !== word) {
      approx = true;
      for (const stem of deinflect(word).slice(0, 3)) {
        try {
          const list2 = await jishoSearch(stem);
          const picked2 = pickJishoEntry(list2, stem);
          if (picked2 && picked2.exactMatch) {
            jisho = picked2;
            approx = false;
            break;
          }
        } catch (e2) {
          /* 换下一个候选 */
        }
      }
    }
  } catch (e) {
    jishoFailed = true;
  }

  // 中文：本地词库 → 翻译 Jisho 的英文释义（比直译单词准确得多）→ 兜底直译原词
  let cn = (local && local.e) ? local.e : '';
  let cnFrom = cn ? 'local' : '';

  if (!cn && jisho && jisho.en && jisho.en.length) {
    const phrase = jisho.en.slice(0, 3).join('; ');
    try {
      const t = cleanZh(await translateText(phrase, 'en', 'zh-CN'));
      if (looksTranslated(phrase, t)) { cn = t; cnFrom = 'en'; }
    } catch (e) { /* 忽略 */ }
  }

  if (!cn) {
    try {
      const t = cleanZh(await translateText(word, 'ja', 'zh-CN'));
      if (looksTranslated(word, t)) { cn = t; cnFrom = 'word'; }
    } catch (e) { /* 忽略 */ }
  }

  const result = {
    ok: true,
    query: word,
    matched: (jisho && jisho.matched) || word,
    reading: (local && local.r) || (jisho && jisho.reading) || '',
    pos: localPosToZh(local && local.p) || (jisho && jisho.pos) || '',
    posAlt: localPosToZh(local && local.p) ? (jisho && jisho.pos) || '' : '',
    jlpt: (jisho && jisho.jlpt) || (local && local.s === 'n3' ? 'N3' : '') || '',
    common: !!(jisho && jisho.common),
    cn: cn || '',
    cnFrom: cnFrom,
    en: (jisho && jisho.en) || [],
    note: (local && local.k) || '',
    tag: (local && local.u) || '',
    inLocal: !!local,
    approx: approx,
    offlineOnly: jishoFailed && !cn
  };

  if (!result.cn && !result.reading && !result.pos && !(result.en && result.en.length)) {
    return { ok: false, error: jishoFailed ? 'network' : 'notfound', query: word };
  }

  await cacheSet(cacheKey, result);
  return result;
}

/* 长句要分段送翻译：接口对单次文本有长度上限，
   整段硬塞会被截断，只剩前半句的译文。按句末标点切，保持语义完整。 */
function splitForTranslate(text, limit = 420) {
  const units = String(text).match(/[^。．！？!?…\n]+[。．！？!?…]*/g) || [String(text)];
  const chunks = [];
  let cur = '';

  for (const raw of units) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.length > limit) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < piece.length; i += limit) chunks.push(piece.slice(i, i + limit));
      continue;
    }
    if (cur && cur.length + piece.length > limit) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [String(text)];
}

async function translateSentence(rawText, direction) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'empty' };

  const toJa = direction === 'zh2ja';
  const from = toJa ? 'zh-CN' : 'ja';
  const to = toJa ? 'ja' : 'zh-CN';

  const cacheKey = (toJa ? 'z2j:' : 's2:') + text;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const chunks = splitForTranslate(text);
  const out = [];

  try {
    for (const piece of chunks) {
      // 中→日：短词同形（猫 / 学校 / 学生）是正常译文，不能当失败
      const allowSame = toJa && piece.length <= 8;
      const t = await translateText(piece, from, to, { allowSame });
      if (t) out.push(t);
    }
    const translated = out.join('');
    const result = {
      ok: !!translated,
      text,
      direction: toJa ? 'zh2ja' : 'ja2zh',
      translation: translated,
      cn: translated,
      partial: out.length > 0 && out.length < chunks.length,
      chunks: chunks.length,
      error: translated ? '' : 'no-result'
    };
    if (translated) await cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    return {
      ok: out.length > 0, text, direction: toJa ? 'zh2ja' : 'ja2zh',
      translation: out.join(''), cn: out.join(''), error: 'network'
    };
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'lookup') {
    lookupWord(msg.word)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'translate') {
    translateSentence(msg.text, msg.direction)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'open-popup') {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
    return;
  }
});

/* ---------------- 右键菜单 ---------------- */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'jp-lookup-selection',
      title: '查「%s」',
      contexts: ['selection']
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
buildMenus();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'jp-lookup-selection' || !tab || !tab.id) return;
  const text = String(info.selectionText || '').trim();
  if (!text) return;
  chrome.tabs.sendMessage(tab.id, { type: 'lookup-selection', text }, () => {
    void chrome.runtime.lastError;
  });
});

/* 快捷键：Alt+J 临时开关 */
chrome.commands.onCommand.addListener(async (cmd) => {
  // PDF、图片页等无法划词的地方：直接唤出查词框
  if (cmd === 'open-lookup') {
    try {
      await chrome.action.openPopup();
    } catch (e) {
      // 某些环境不支持程序化打开弹窗，退化为切换开关
    }
    return;
  }

  if (cmd !== 'toggle-enabled') return;
  const got = await chrome.storage.local.get('jp_settings');
  const s = got.jp_settings || {};
  s.enabled = s.enabled === false ? true : false;
  await chrome.storage.local.set({ jp_settings: s });
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id) {
      chrome.tabs.sendMessage(t.id, { type: 'settings-changed', settings: s }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
});

/* 设置一变就通知所有已打开的页面，不用刷新才生效（方向、主题、开关都走这里） */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.jp_settings) return;
  const settings = changes.jp_settings.newValue || {};
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (!t || t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'settings-changed', settings }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
});
