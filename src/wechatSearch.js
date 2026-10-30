'use strict';

/**
 * 公众号文章搜索定位模块
 *
 * 通过搜狗微信搜索（weixin.sogou.com/weixin?type=2）按标题定位文章，
 * 解析转链拿到真实 mp.weixin.qq.com 链接，供抓取流程使用。
 *
 * 注意：转链链接有时效性（数小时内），拿到后需立即抓取。
 * 搜狗对高频访问有限流（验证码），调用方应控制频率（见 DEFAULT_SEARCH_INTERVAL_MS）。
 */

const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SOGOU_HOST = 'https://weixin.sogou.com';
const SEARCH_PATH = '/weixin?type=2&query=';

// 进程级 cookie jar：SNUID 等首次请求获得后复用
let cookieJar = [];

// 自适应限速：搜狗在短时间内请求过多会软限流（返回空/无关结果）。
// 连续失败时自动拉长间隔与冷却，恢复后回到较快节奏。
let currentIntervalMs = 2500;
let consecutiveFailures = 0;
const BASE_INTERVAL_MS = 2500;
const MAX_INTERVAL_MS = 10000;
function noteSearchResult(succeeded) {
  if (succeeded) {
    consecutiveFailures = 0;
    currentIntervalMs = BASE_INTERVAL_MS;
  } else {
    consecutiveFailures += 1;
    currentIntervalMs = Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS + consecutiveFailures * 2500);
  }
}
/** 当前建议的请求间隔（供调用方在篇与篇之间使用） */
function currentInterval() {
  return currentIntervalMs;
}

function updateCookies(response) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0];
    const name = pair.split('=')[0];
    if (!name) continue;
    const index = cookieJar.findIndex((existing) => existing.startsWith(name + '='));
    if (index >= 0) cookieJar[index] = pair;
    else cookieJar.push(pair);
  }
}

function cookieHeader() {
  return cookieJar.join('; ');
}

/** 比对用的归一化：白名单式，只保留英文数字汉字（大小写、标点、引号形式差异全部抹平） */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function stripTags(html) {
  return String(html || '')
    .replace(/<!--red_beg-->|<!--red_end-->/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** 解析搜索结果页 → [{ title, account, link }] */
function parseSearchResults(html) {
  const blocks = html.split(/<li id="sogou_vr_\d+_box_\d+/).slice(1);
  return blocks
    .map((block) => {
      const linkMatch = block.match(/<h3>[\s\S]*?<a[^>]*href="([^"]+)"/);
      const titleMatch = block.match(/<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
      const accountMatch = block.match(/<span class="all-time-y2">([^<]*)<\/span>/);
      return {
        title: titleMatch ? stripTags(titleMatch[1]) : '',
        account: accountMatch ? accountMatch[1].trim() : '',
        link: linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : null,
      };
    })
    .filter((item) => item.link);
}

/** 搜狗转链页是 JS 多段拼接（url += 'xxx'），收集全部片段合成真实链接 */
function extractRealUrl(page) {
  const parts = [...page.matchAll(/url \+= '([^']*)'/g)].map((m) => m[1]);
  const url = parts.join('');
  return /^https?:\/\/mp\.weixin\.qq\.com\//.test(url) ? url : null;
}

async function requestSearchPage(query) {
  const response = await fetch(SOGOU_HOST + SEARCH_PATH + encodeURIComponent(query), {
    headers: {
      'User-Agent': UA_DESKTOP,
      Referer: SOGOU_HOST + '/',
      Accept: 'text/html,application/xhtml+xml',
      Cookie: cookieHeader(),
    },
    redirect: 'follow',
  });
  updateCookies(response);
  const html = await response.text();
  if (response.status !== 200 || /antispider|seccodeimage|请输入验证码/i.test(html)) {
    const error = new Error('搜索被限流（验证码），请稍后重试或减少单次数量');
    error.code = 'SEARCH_RATE_LIMITED';
    throw error;
  }
  if (!html.includes('txt-box')) {
    // 无结果或页面结构变化
    if (/结果数为?0|暂无相关/i.test(html)) return '';
    return '';
  }
  return html;
}

async function resolveSogouLink(linkPath) {
  const response = await fetch(SOGOU_HOST + linkPath, {
    headers: {
      'User-Agent': UA_DESKTOP,
      Referer: SOGOU_HOST + '/',
      Cookie: cookieHeader(),
    },
    redirect: 'follow',
  });
  updateCookies(response);
  const page = await response.text();
  const url = extractRealUrl(page);
  if (!url) {
    const error = new Error('搜索转链解析失败，无法取得文章链接');
    error.code = 'SEARCH_LINK_RESOLVE_FAILED';
    throw error;
  }
  return url;
}

/**
 * 从结果列表里挑公众号匹配 + 标题归一化后相等或互含的最佳候选
 */
function pickBestMatch(results, account, title) {
  const wantAccount = normalizeForMatch(account);
  const wantTitle = normalizeForMatch(title);
  if (!wantTitle) return null;
  const matchesAccount = (result) =>
    !wantAccount ||
    normalizeForMatch(result.account) === wantAccount ||
    normalizeForMatch(result.account).includes(wantAccount) ||
    wantAccount.includes(normalizeForMatch(result.account));

  const candidates = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => matchesAccount(result))
    .map(({ result, index }) => {
      const got = normalizeForMatch(result.title);
      let score = -1;
      if (got && got === wantTitle) score = 100;
      else if (got && (got.includes(wantTitle) || wantTitle.includes(got))) score = 60 + Math.min(20, Math.abs(got.length - wantTitle.length));
      return { result, index, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates.length ? candidates[0].result : null;
}

/**
 * 生成查询池。
 * 实测经验：搜狗对「公众号名+长标题」会触发严格匹配返回空；
 * 「标题片段的关键词组合」召回最好（如「生命中第一个 娜拉」），
 * 但常见词（「小姨」）会把目标挤出结果，所以要遍历片段两两组合。
 * 单片段标题退化为完整标题（若含敏感词仍无召回，属搜索引擎限制，需人工补链接）。
 */
function buildQueryPool(title, account) {
  const clean = String(title || '').replace(/[“”‘’「」『』《》"'？！?!.。～~\s]+/g, ' ').trim();
  const segments = clean.split(/[，,；;：:！!？?\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  const queries = [];
  const push = (q) => {
    q = String(q || '').trim().replace(/\s+/g, ' ');
    if (q && !queries.includes(q)) queries.push(q);
  };
  if (segments.length >= 2) {
    // 片段两两组合：长片段优先（更有区分度）。
    // 搜狗分词对词序不敏感，无需正反两个方向——减少请求数以降低限流触发。
    const pairs = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        pairs.push({ a: segments[i], b: segments[j] });
      }
    }
    pairs.sort((x, y) => (y.a.length + y.b.length) - (x.a.length + x.b.length));
    for (const { a, b } of pairs.slice(0, 4)) {
      push(`${a.slice(0, 12)} ${b.slice(0, 12)}`);
    }
  }
  if (account) push(`${account} ${clean.slice(0, 24)}`);
  push(clean.slice(0, 24));
  return queries.slice(0, 10);
}

/**
 * 按公众号 + 标题定位一篇文章。
 * 遍历查询池（片段关键词组合优先），每级间隔限速；仍无匹配则抛 SEARCH_NOT_MATCHED。
 * @param {string} account 公众号名（用于过滤结果）
 * @param {string} title 文章标题
 * @returns {Promise<{url: string, resultTitle: string, resultAccount: string}>}
 */
async function searchWechatArticle(account, title) {
  const trimmed = String(title || '').trim();
  if (!trimmed) {
    const error = new Error('文章标题为空');
    error.code = 'SEARCH_EMPTY_QUERY';
    throw error;
  }
  const queries = buildQueryPool(trimmed, String(account || '').trim());
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let networkRetries = 0;
  let consecutiveEmpty = 0; // 连续空结果：疑似触发搜狗软限流（不弹验证码，直接返回空/无关结果）
  for (const [index, query] of queries.entries()) {
    let html;
    try {
      html = await requestSearchPage(query);
    } catch (error) {
      // 网络瞬断：整个流程最多重试 2 次
      if (error.code === 'SEARCH_RATE_LIMITED' || networkRetries >= 2) throw error;
      networkRetries += 1;
      await sleep(4000);
      html = await requestSearchPage(query);
    }
    const results = parseSearchResults(html);
    const match = pickBestMatch(results, account, trimmed);
    if (match) {
      const url = await resolveSogouLink(match.link);
      noteSearchResult(true);
      return { url, resultTitle: match.title, resultAccount: match.account };
    }
    if (!results.length) {
      consecutiveEmpty += 1;
      // 连续空结果 → 疑似限流：长冷却并重置会话（换新 cookie），而非继续空耗请求
      if (consecutiveEmpty >= 2 && index < queries.length - 1) {
        resetSearchSession();
        await sleep(60000);
        consecutiveEmpty = 0;
      }
    } else {
      consecutiveEmpty = 0;
    }
    if (index < queries.length - 1) await sleep(currentIntervalMs);
  }
  noteSearchResult(false);
  const error = new Error(`搜索结果中未找到「${account || '任意公众号'}」的文章（可能未被收录或含搜索受限词）`);
  error.code = 'SEARCH_NOT_MATCHED';
  throw error;
}

/** 重置 cookie（限流后可调用） */
function resetSearchSession() {
  cookieJar = [];
}

module.exports = {
  searchWechatArticle,
  parseSearchResults,
  normalizeForMatch,
  resetSearchSession,
  currentInterval,
};
