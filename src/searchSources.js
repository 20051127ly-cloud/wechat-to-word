'use strict';

/**
 * 搜索源管理：把「按公众号+标题定位文章」抽象成可插拔的数据源。
 *
 * 内置：
 *   - sogou ：搜狗微信搜索（免费，但收录不全且有限流）
 *   - local ：本地链接库（人工补的链接，零成本、零限流，优先级最高）
 * 外部商业数据源（新榜 / 西瓜 / 清博 / 自建服务等）通过配置接入，
 * 用通用 HTTP 适配器描述请求与响应字段映射，无需改业务代码。
 *
 * 配置方式（任选其一，后者覆盖前者）：
 *   1. 环境变量 SEARCH_SOURCES_CONFIG 指向 JSON 文件
 *   2. 项目根目录 config/search-sources.json
 *   3. 环境变量简写：SEARCH_API_URL / SEARCH_API_KEY（用作单个 http 源）
 */

const fs = require('fs');
const path = require('path');
const { normalizeForMatch } = require('./wechatSearch');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'search-sources.json');
const LOCAL_LINKS_FILE = path.join(PROJECT_ROOT, 'config', 'links.json');

/** 用上下文渲染配置里的 ${title} / ${account} / ${env:XXX} 占位符 */
function render(template, context) {
  if (template == null) return template;
  if (typeof template !== 'string') return template;
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const key = expr.trim();
    if (key.startsWith('env:')) return process.env[key.slice(4)] || '';
    return context[key] != null ? String(context[key]) : '';
  });
}

function renderObject(value, context) {
  if (value == null) return value;
  if (typeof value === 'string') return render(value, context);
  if (Array.isArray(value)) return value.map((item) => renderObject(item, context));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[render(key, context)] = renderObject(item, context);
    return result;
  }
  return value;
}

// ==================== 本地链接库 ====================

function loadLocalLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_LINKS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** 本地链接库：key 为归一化的「公众号|标题」或仅「标题」 */
const localSource = {
  name: 'local',
  async search(account, title) {
    const links = loadLocalLinks();
    const keys = [normalizeForMatch(account + '|' + title), normalizeForMatch(title)];
    for (const key of keys) {
      const entry = links[key];
      if (!entry) continue;
      const url = typeof entry === 'string' ? entry : entry.url;
      if (url) {
        return {
          url,
          resultTitle: (typeof entry === 'object' && entry.title) || title,
          resultAccount: (typeof entry === 'object' && entry.account) || account || '（本地链接库）',
        };
      }
    }
    return null;
  },
};

/** 把定位结果写入本地链接库，供后续复用（相当于人工补链接的持久化） */
function rememberLink(account, title, entry) {
  try {
    const links = loadLocalLinks();
    links[normalizeForMatch(account + '|' + title)] = {
      url: entry.url,
      title: entry.resultTitle || title,
      account: entry.resultAccount || account || '',
    };
    fs.mkdirSync(path.dirname(LOCAL_LINKS_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_LINKS_FILE, JSON.stringify(links, null, 2), 'utf8');
  } catch (err) {
    console.error('[链接库] 写入失败:', err.message);
  }
}

// ==================== 通用 HTTP 适配器 ====================

function pickByPath(data, pathExpression) {
  if (!pathExpression) return data;
  return pathExpression.split('.').reduce((node, key) => {
    if (node == null) return null;
    return Array.isArray(node) && /^\d+$/.test(key) ? node[Number(key)] : node[key];
  }, data);
}

/** 配置驱动的 HTTP 数据源，适配任意 REST 接口 */
function createHttpSource(config) {
  const {
    name = 'http',
    url,
    method = 'GET',
    headers = {},
    params = {},
    body = null,
    resultPath = '',
    fields = { title: 'title', account: 'account', url: 'url' },
    timeoutMs = 15000,
  } = config;
  return {
    name,
    async search(account, title) {
      const context = { title, account };
      const target = render(url, context);
      if (!target) return null;
      const options = {
        method: String(method).toUpperCase(),
        headers: renderObject(headers, context),
        signal: AbortSignal.timeout(Number(timeoutMs) || 15000),
      };
      if (options.method === 'GET') {
        const query = new URLSearchParams(renderObject(params, context)).toString();
        const separator = target.includes('?') ? '&' : '?';
        return request(target + (query ? separator + query : ''), options, resultPath, fields, account, title);
      }
      options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
      options.body = JSON.stringify(renderObject(body != null ? body : params, context));
      return request(target, options, resultPath, fields, account, title);
    },
  };

  async function request(target, options, resultPath, fields, account, title) {
    const response = await fetch(target, options);
    if (!response.ok) return null;
    const data = await response.json();
    const list = pickByPath(data, resultPath);
    const items = Array.isArray(list) ? list : [list];
    const want = normalizeForMatch(title);
    const wantAccount = normalizeForMatch(account);
    for (const item of items) {
      if (!item) continue;
      const itemTitle = pickByPath(item, fields.title) || '';
      const itemAccount = pickByPath(item, fields.account) || '';
      const itemUrl = pickByPath(item, fields.url) || '';
      if (!itemUrl) continue;
      if (wantAccount && normalizeForMatch(itemAccount) !== wantAccount) continue;
      const got = normalizeForMatch(itemTitle);
      if (got === want || got.includes(want) || want.includes(got)) {
        return { url: itemUrl, resultTitle: itemTitle, resultAccount: itemAccount || account };
      }
    }
    return null;
  }
}

// ==================== 源加载 ====================

let cachedSogou = null;
function sogouSource() {
  if (!cachedSogou) {
    // 延迟 require，避免模块加载期的循环依赖
    const { searchWechatArticle } = require('./wechatSearch');
    cachedSogou = {
      name: 'sogou',
      async search(account, title) {
        return searchWechatArticle(account, title);
      },
    };
  }
  return cachedSogou;
}

function loadSources() {
  const sources = [localSource]; // 本地链接库优先（零成本、零限流）
  let configFile = process.env.SEARCH_SOURCES_CONFIG || DEFAULT_CONFIG_FILE;
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    config = null;
  }
  if (config && Array.isArray(config.sources)) {
    for (const item of config.sources) {
      if (!item || item.enabled === false) continue;
      if (item.type === 'sogou') sources.push(sogouSource());
      else if (item.type === 'http') sources.push(createHttpSource(item));
    }
  } else if (process.env.SEARCH_API_URL) {
    sources.push(createHttpSource({
      name: process.env.SEARCH_API_NAME || 'http',
      url: process.env.SEARCH_API_URL,
      method: process.env.SEARCH_API_METHOD || 'GET',
      headers: process.env.SEARCH_API_KEY ? { Authorization: `Bearer ${process.env.SEARCH_API_KEY}` } : {},
      params: { keyword: '${title}', account: '${account}' },
      resultPath: process.env.SEARCH_API_RESULT_PATH || '',
    }));
  }
  // 未配置任何外部源时，回落到搜狗
  if (!sources.some((source) => source.name === 'sogou') && sources.length === 1) {
    sources.push(sogouSource());
  }
  return sources;
}

/**
 * 依次尝试所有数据源定位一篇文章；命中即写入本地链接库，供后续零成本复用。
 * @throws 所有源均未命中时抛 SEARCH_NOT_MATCHED
 */
async function locateArticle(account, title) {
  const sources = loadSources();
  const errors = [];
  for (const source of sources) {
    try {
      const found = await source.search(account, title);
      if (found && found.url) {
        rememberLink(account, title, found);
        return { ...found, source: source.name };
      }
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }
  const error = new Error(
    errors.length
      ? `所有数据源均未定位到该文章（${errors.join('；')}）`
      : '所有数据源均未定位到该文章',
  );
  error.code = 'SEARCH_NOT_MATCHED';
  throw error;
}

module.exports = {
  loadSources,
  createHttpSource,
  localSource,
  rememberLink,
  loadLocalLinks,
  locateArticle,
  render,
};
