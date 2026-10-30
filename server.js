'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const AdmZip = require('adm-zip');
const { fetchArticle, fetchImage } = require('./src/fetcher');
const { parseArticle } = require('./src/parser');
const { buildDocx, buildAssembleDocx } = require('./src/docxBuilder');
const { removeQrCodes } = require('./src/qrDetector');
const { mapWithConcurrency } = require('./src/concurrency');
const { buildXlsx } = require('./src/xlsx');
const { normalizeForMatch, currentInterval } = require('./src/wechatSearch');
const { locateArticle, rememberLink } = require('./src/searchSources');
const { canonicalAccountName } = require('./src/accountNames');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // 监听所有网卡，局域网内可访问

// 并发度：图片下载可放宽，文章抓取保守一些以免触发微信限流。
const IMAGE_CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY) || 6;
const ARTICLE_CONCURRENCY = Number(process.env.ARTICLE_CONCURRENCY) || 3;

// 单篇 / 批量抓取支持的类别白名单
// 注：汇编不走单篇/批量，而是独立的整合接口 /api/assemble（多链接合成一个 Word）
const CATEGORIES = ['轻心理', '轻纪实'];

/** 清洗文件名中的非法字符 */
function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/** 搜索定位结果缓存（.cache/search-links.json）：key 为归一化的「公众号|标题」 */
const SEARCH_CACHE_FILE = path.join(__dirname, '.cache', 'search-links.json');
function loadSearchCache() {
  try {
    const data = JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
function saveSearchCache(cache) {
  try {
    fs.mkdirSync(path.dirname(SEARCH_CACHE_FILE), { recursive: true });
    fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[搜索缓存] 写入失败:', err.message);
  }
}

/**
 * 修复被换行断开的微信链接。
 * 长参数链（/s?__biz=...&chksm=...）复制时常被断成多行：
 *   http://mp.weixin.qq.com/s?
 *   __biz=...&chksm=...fd45
 *   2123b6ba...&scene=0#rd
 * 逐行判断：前一行是「尚未结束的参数链」（含域名、未以 #rd 锚点收尾），
 * 且当前行不是新链接（不含域名）但以 URL 字符开头 → 拼回上一行。
 * 标题行（汉字开头或普通文本）不会命中，多链接各占一行也互不影响。
 */
function repairBrokenUrls(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim());
  const out = [];
  for (const line of lines) {
    if (!line) { out.push(''); continue; }
    const prev = out.length ? out[out.length - 1] : '';
    const prevIsBrokenUrl =
      /https?:\/\/mp\.weixin\.qq\.com\/s\?/.test(prev) &&
      !/#r[dD]$|#$/.test(prev);
    const curIsContinuation =
      !line.includes('mp.weixin.qq.com') &&
      /^[A-Za-z0-9=&%_.#~-]/.test(line);
    if (prevIsBrokenUrl && curIsContinuation) {
      out[out.length - 1] = prev + line;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** 从整段文字中提取所有微信公众号文章链接 */
function extractWechatLinks(text) {
  if (!text || typeof text !== 'string') return [];
  const repaired = repairBrokenUrls(text);
  // 兼容两种链接形态：短链 /s/xxxx 与参数链 /s?__biz=...&sn=...
  // 参数链以空白或中文标点/引号/括号结束，避免把尾随标点吃进 URL
  const re = /https?:\/\/mp\.weixin\.qq\.com\/s(?:\/[A-Za-z0-9_-]+|\?[^\s，。；、！？）】」』"'"<>]+)/g;
  const links = repaired.match(re) || [];
  // 去重（保持顺序）
  return [...new Set(links)];
}

/**
 * 抓取并解析单篇文章（含下载正文图片）
 * @param {string} url 文章链接
 * @param {string} category 类别
 * @param {{html?: string}} [options] 传入 html 时跳过网络抓取（复用已保存的页面）
 * @returns {Promise<object>} 文章结构化数据（含图片 buffer）
 */
/**
 * 处理单个图片块：下载、校验尺寸、标记去留状态（原地修改 block）。
 * @param {object} block 图片块
 * @param {(src: string) => Promise<object>} download 带缓存的下载函数
 */
async function resolveImageBlock(block, download) {
  const knownWidth = Number(block.width);
  const knownRatio = Number(block.ratio);
  const hasWidth = Number.isFinite(knownWidth) && knownWidth > 0;
  const hasRatio = Number.isFinite(knownRatio) && knownRatio > 0;
  const needsProbe = !!block.needsImageProbe || !hasWidth || !hasRatio;
  if (block.status === 'filtered' || (hasWidth && knownWidth < 150) || (hasRatio && knownRatio < 0.3)) {
    block.buffer = null;
    block.ext = null;
    block.status = 'filtered';
    block.reason = block.reason || (hasWidth && knownWidth < 150 ? 'image_width_below_150' : 'image_ratio_below_0.3');
    return;
  }
  try {
    const { buffer, ext, animated, width, height, sourceExt } = await download(block.src);
    block.actualWidth = width;
    block.actualHeight = height;
    block.sourceExt = sourceExt;
    if (!hasWidth) block.width = width;
    if (!hasRatio) block.ratio = height / width;
    if (!(Number.isFinite(Number(block.height)) && Number(block.height) > 0)) block.height = height;
    block.needsImageProbe = false;
    if (animated) {
      // 动图：静默剔除，不嵌入 Word、也不生成删除标注。
      block.buffer = null;
      block.ext = null;
      block.status = 'animated';
      block.reason = 'animated_image';
      console.log(`[动图已删除] ${block.src}`);
    } else if (needsProbe && (width < 150 || height / width < 0.3)) {
      block.buffer = null;
      block.ext = null;
      block.status = 'filtered';
      block.reason = width < 150 ? 'image_width_below_150' : 'image_ratio_below_0.3';
    } else {
      block.buffer = buffer;
      block.ext = ext;
      block.status = 'kept';
      block.reason = 'image_validated';
    }
  } catch (e) {
    // 保留原 src 和下载失败标注，同时区分不支持的格式。
    block.type = 'deleted';
    block.label = '图片下载失败';
    block.text = (block.src || '').slice(0, 80);
    block.buffer = null;
    block.ext = null;
    block.status = e.code === 'IMAGE_UNSUPPORTED' ? 'unsupported' : 'download_failed';
    block.reason = e.code || 'IMAGE_DOWNLOAD_FAILED';
    block.errorMessage = e.message;
    console.log(`[图片下载失败] ${block.src} - ${e.message}`);
  }
}

async function fetchAndParse(url, category, options = {}) {
  const html = options.html || await fetchArticle(url);
  const data = parseArticle(html);
  data.category = category;

  // 下载正文图片；已知的小图/扁图不因缺少另一项尺寸而放行。
  // 同一 src 只下载一次（公众号常复用同一张图），并并发下载以缩短单篇耗时。
  const imageBlocks = data.blocks.filter(block => block.type === 'image');
  const downloads = new Map();
  const download = (src) => {
    if (!downloads.has(src)) downloads.set(src, fetchImage(src));
    return downloads.get(src);
  };
  await mapWithConcurrency(imageBlocks, IMAGE_CONCURRENCY, (block) => resolveImageBlock(block, download));

  // 识别并删除文章中的二维码图片（全量遍历 + 版式预筛）。
  await removeQrCodes(data.blocks);
  if (!Array.isArray(data.imageDiagnostics)) data.imageDiagnostics = [];
  for (const block of imageBlocks) {
    if (block.type === 'deleted' && block.label === '二维码图片') {
      block.status = 'filtered';
      block.reason = 'qr_code';
    }
    data.imageDiagnostics.push({
      src: block.src,
      status: block.status,
      reason: block.reason,
      width: block.actualWidth,
      height: block.actualHeight,
      sourceExt: block.sourceExt,
      errorMessage: block.errorMessage,
    });
  }

  return data;
}

// 网络类失败（超时 / 连接异常 / 网关错误）通常重试一次即可成功；内容类错误不重试
const RETRIABLE_CODES = new Set(['ARTICLE_TIMEOUT', 'ARTICLE_NETWORK_ERROR', 'ARTICLE_HTTP_ERROR']);

/** 带一次自动重试的任务执行，用于批量 / 汇编中偶发的抓取超时 */
async function withRetryOnce(task, label) {
  try {
    return await task();
  } catch (error) {
    if (!RETRIABLE_CODES.has(error.code)) throw error;
    console.log(`[重试] ${label}（${error.message}）`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return await task();
  }
}

/**
 * 抓取并生成单篇 Word
 * @returns {Promise<{buffer: Buffer, title: string, filename: string}>}
 */
async function convertOne(url, category) {
  const data = await fetchAndParse(url, category);
  const buffer = await buildDocx(data);
  const title = data.title || '未命名文章';
  const filename = `${sanitizeFilename(title)}（${category}）.docx`;

  // author / account 供批量结果清单（Excel）使用
  return { buffer, title, filename, author: data.author || '', account: data.account || '' };
}

/**
 * POST /api/convert
 * body: { url: string, category: '轻心理' | '轻纪实' }
 */
app.post('/api/convert', async (req, res) => {
  const { url, category } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供文章链接' });
  }
  if (!/^https?:\/\/mp\.weixin\.qq\.com\//.test(url)) {
    return res.status(400).json({ error: '仅支持微信公众号文章链接（mp.weixin.qq.com）' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: '类别无效' });
  }

  try {
    const { buffer, title, filename } = await convertOne(url, category);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));

    console.log(`[成功] ${title} | 类别=${category}`);
  } catch (err) {
    console.error('[失败]', err.message);
    res.status(500).json({ error: err.message || '处理失败，请稍后重试' });
  }
});

/**
 * 构造批量抓取结果清单（Excel 用）。
 * 文件名不含 .docx 后缀；「文章来源」栏默认为「来源 作者」，
 * 轻心理类别按需求只填来源、不带作者名。
 */
function buildSummaryRows(outcomes, category) {
  const withAuthor = category !== '轻心理';
  const rows = [['序号', '状态', '文章原名', '抓取后文件名', '文章来源', '链接', '失败原因']];
  outcomes.forEach((item, index) => {
    // 公众号名按 config/account-names.json 输出规范名（如 KnowYourself → KnowYourself知我心理）
    const sourceParts = withAuthor
      ? [canonicalAccountName(item.account), item.author]
      : [canonicalAccountName(item.account)];
    rows.push([
      index + 1,
      item.ok ? '成功' : '失败',
      item.ok ? item.title : '',
      item.ok ? String(item.filename || '').replace(/\.docx$/i, '') : '',
      item.ok ? sourceParts.filter(Boolean).join(' ') : '',
      item.url,
      item.ok ? '' : item.message,
    ]);
  });
  return rows;
}

/**
 * POST /api/convert-batch
 * body: { text: string, category: '轻心理' | '轻纪实' }
 * 从 text 中提取所有微信链接，批量抓取并打包成 zip
 */
app.post('/api/convert-batch', async (req, res) => {
  const { text, category } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '请粘贴包含文章链接的内容' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: '类别无效' });
  }

  const links = extractWechatLinks(text);
  if (links.length === 0) {
    return res.status(400).json({ error: '未识别到微信公众号文章链接，请确认粘贴的内容包含 mp.weixin.qq.com/s/ 开头的链接' });
  }

  // 并发抓取（限制并发度以免触发微信限流），再按粘贴顺序汇总
  const outcomes = await mapWithConcurrency(links, ARTICLE_CONCURRENCY, async (url, index) => {
    const position = `${index + 1}/${links.length}`;
    try {
      const { buffer, title, filename, author, account } = await withRetryOnce(() => convertOne(url, category), url);
      console.log(`[批量 ${position} 成功] ${title}`);
      return { ok: true, url, buffer, title, filename, author, account };
    } catch (err) {
      console.error(`[批量 ${position} 失败] ${url} - ${err.message}`);
      return { ok: false, url, message: err.message };
    }
  });

  const zip = new AdmZip();
  const results = []; // 每篇的处理结果（文本清单）
  const tableRows = buildSummaryRows(outcomes, category);
  let successCount = 0;
  outcomes.forEach((item) => {
    if (item.ok) {
      zip.addFile(item.filename, Buffer.from(item.buffer));
      results.push(
        `[成功] ${item.title}\n       新文件名：${item.filename}\n       作者：${item.author || '（未识别）'}  来源：${item.account || '（未识别）'}`,
      );
      successCount++;
    } else {
      results.push(`[失败] ${item.url}\n       原因：${item.message}`);
    }
  });

  // 附一份处理结果清单：Excel（可筛选/编辑）+ 纯文本兜底
  const summary = [
    `批量抓取结果（类别：${category}）`,
    `共识别到 ${links.length} 个链接，成功 ${successCount} 个，失败 ${links.length - successCount} 个`,
    '',
    ...results,
  ].join('\n');
  zip.addFile('批量抓取结果.txt', Buffer.from(summary, 'utf8'));

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  zip.addFile(`批量抓取结果_${category}_${dateStr}.xlsx`, buildXlsx('抓取结果', tableRows));

  const zipBuffer = zip.toBuffer();
  const zipFilename = `批量导出_${category}_${dateStr}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipFilename)}`);
  res.send(zipBuffer);

  console.log(`[批量完成] ${category} | 成功 ${successCount}/${links.length}`);
});

/**
 * POST /api/assemble
 * body: { text: string }
 * 从 text 中提取所有微信链接，按顺序抓取并整合到一个 Word（每篇另起一页）
 */
app.post('/api/assemble', async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '请粘贴包含文章链接的内容' });
  }

  const links = extractWechatLinks(text);
  if (links.length === 0) {
    return res.status(400).json({ error: '未识别到微信公众号文章链接，请确认粘贴的内容包含 mp.weixin.qq.com/s/ 开头的链接' });
  }

  const category = '汇编';
  // 并发抓取，但按粘贴顺序整合，保证 Word 内文章顺序与输入一致
  const outcomes = await mapWithConcurrency(links, ARTICLE_CONCURRENCY, async (url, index) => {
    const position = `${index + 1}/${links.length}`;
    try {
      const data = await withRetryOnce(() => fetchAndParse(url, category), url);
      console.log(`[汇编 ${position} 成功] ${data.title}`);
      return { ok: true, url, data };
    } catch (err) {
      console.error(`[汇编 ${position} 失败] ${url} - ${err.message}`);
      return { ok: false, url, message: err.message };
    }
  });

  const articles = outcomes.filter((item) => item.ok).map((item) => item.data);
  const results = outcomes.map((item) => (
    item.ok ? `[成功] ${item.data.title || '未命名文章'}` : `[失败] ${item.url}\n       原因：${item.message}`
  ));
  const successCount = articles.length;

  if (articles.length === 0) {
    return res.status(500).json({ error: '所有文章均抓取失败，未能生成文档' });
  }

  const buffer = await buildAssembleDocx(articles);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `汇编_${dateStr}.docx`;

  // 通过响应头传递处理结果摘要，前端据此展示成功/失败详情
  const resultMeta = {
    total: links.length,
    success: successCount,
    failed: links.length - successCount,
    results,
  };
  res.setHeader('X-Assemble-Result', encodeURIComponent(JSON.stringify(resultMeta)));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(Buffer.from(buffer));

  console.log(`[汇编完成] 成功 ${successCount}/${links.length}，已整合为一个 Word`);
});

/**
 * 解析「按标题搜索汇编」的输入列表。
 * 「公众号：xxx」为其后的文章行设置公众号（可多次出现，切换公众号）；
 * 每行 = 文章标题，行尾括号里的类别标注（轻纪实/轻心理/轻访谈…）单独记录。
 */
function parseTitleList(text) {
  const items = [];
  let account = '';
  for (const rawLine of repairBrokenUrls(String(text || '')).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    const accMatch = line.match(/^(?:公众号|账号|来源)\s*[:：]\s*(.+)$/);
    if (accMatch) {
      account = accMatch[1].replace(/[，,；;]\s*$/, '').trim();
      continue;
    }
    const labelMatch = line.match(/^(?:文章名称|文章|标题)\s*[:：]\s*(.+)$/);
    if (labelMatch) line = labelMatch[1].trim();
    let category = '';
    const categoryMatch = line.match(/^(.*?)\s*[（(]\s*([^（）()]{1,6})\s*[）)]\s*$/);
    if (categoryMatch && /^(轻心理|轻纪实|轻访谈|汇编|轻阅读)$/.test(categoryMatch[2])) {
      line = categoryMatch[1].trim();
      category = categoryMatch[2];
    }
    if (!line) continue;
    // 人工兜底：行内带微信链接时直接使用，跳过搜索（用于搜索失败后人工补链接重跑）
    const urlMatch = line.match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s，,；;]+/);
    if (urlMatch) {
      items.push({ account, title: line.replace(urlMatch[0], '').replace(/[，,;；\s]+$/, '').trim(), category, url: urlMatch[0] });
      continue;
    }
    items.push({ account, title: line, category });
  }
  return items;
}

/**
 * 构造「待重跑清单」：只包含未定位/未抓取成功的篇目，格式与搜索汇编的输入格式完全一致
 * （按公众号分组 + 「标题（类别）」），可直接粘贴回输入框重跑。
 */
function buildRetryInput(outcomes) {
  const lines = [];
  let currentAccount = null;
  for (const item of outcomes) {
    if (item.ok) continue;
    if (item.account && item.account !== currentAccount) {
      currentAccount = item.account;
      lines.push(`公众号：${currentAccount}`);
    }
    lines.push(item.category ? `${item.title}（${item.category}）` : item.title);
  }
  return lines.join('\n');
}

/**
 * POST /api/assemble-search
 * body: { text: string }
 * 输入「公众号：xxx + 文章标题列表」，逐篇搜索定位文章链接，再汇编成一个 Word。
 * 返回 zip：汇编 Word + 搜索定位结果清单（Excel + 文本）。
 */
app.post('/api/assemble-search', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '请粘贴文章标题列表' });
  }
  const items = parseTitleList(text);
  if (items.length === 0) {
    return res.status(400).json({ error: '未识别到文章标题。请按「公众号：xxx」+ 每行一个标题的格式粘贴' });
  }
  if (items.length > 60) {
    return res.status(400).json({ error: `单次最多 60 篇（当前 ${items.length} 篇），请分批处理` });
  }

  console.log(`[搜索汇编] 共 ${items.length} 篇，开始逐篇定位链接（含限速，预计 ${Math.ceil(items.length * 8 / 60)} 分钟左右）`);
  const searchOutcomes = [];

  // 定位结果持久缓存：命中过的「公众号|标题 → 链接」存本地，重跑时直接复用、不再消耗搜索配额。
  // 多跑几遍（限流恢复后）即可逐步逼近全量定位。
  const searchCache = loadSearchCache();
  const saveLocated = (item, found) => {
    searchCache[normalizeForMatch(item.account + '|' + item.title)] = {
      url: found.url, resultTitle: found.resultTitle, resultAccount: found.resultAccount,
    };
    saveSearchCache(searchCache);
  };

  const locate = async (item, position) => {
    try {
      if (item.url) {
        // 人工已补链接：跳过搜索，并写入本地链接库（之后不再需要人工）
        console.log(`[搜索 ${position} 跳过] ${item.title}（已提供链接）`);
        const result = { ...item, resultTitle: item.title, resultAccount: item.account || '（人工提供）', ok: true };
        saveLocated(item, result);
        rememberLink(item.account, item.title, result);
        return result;
      }
      const cached = searchCache[normalizeForMatch(item.account + '|' + item.title)];
      if (cached && cached.url) {
        console.log(`[搜索 ${position} 缓存] ${item.title}`);
        return { ...item, ...cached, ok: true };
      }
      // 多数据源依次尝试（本地链接库 → 配置的商业数据源 → 搜狗）
      const found = await locateArticle(item.account, item.title);
      console.log(`[搜索 ${position} 成功] ${item.title} → ${found.resultAccount} | ${found.resultTitle}（源：${found.source}）`);
      saveLocated(item, found);
      return { ...item, ...found, ok: true };
    } catch (err) {
      console.error(`[搜索 ${position} 失败] ${item.title} - ${err.message}`);
      return { ...item, ok: false, message: err.message };
    }
  };

  // 首轮
  for (const [index, item] of items.entries()) {
    searchOutcomes.push(await locate(item, `${index + 1}/${items.length}`));
    // 限速：搜索模块的间隔会随连续失败自适应拉长（疑似限流时自动减速）
    await new Promise((resolve) => setTimeout(resolve, currentInterval()));
  }

  // 二轮：首轮结束后限流大概率仍在持续，冷却后对未定位的篇目整体重试一轮
  const firstRoundFailed = searchOutcomes.filter((item) => !item.ok);
  if (firstRoundFailed.length > 0) {
    const locatedCount = items.length - firstRoundFailed.length;
    console.log(`[搜索汇编] 首轮定位 ${locatedCount}/${items.length}，${firstRoundFailed.length} 篇未定位，冷却 90 秒后重试一轮`);
    await new Promise((resolve) => setTimeout(resolve, 90000));
    for (const [index, item] of firstRoundFailed.entries()) {
      const retry = await locate(item, `重试 ${index + 1}/${firstRoundFailed.length}`);
      if (retry.ok) Object.assign(item, retry, { ok: true, message: undefined });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  // 逐篇抓取解析（并发，保序）
  const located = searchOutcomes.filter((item) => item.ok);
  const parseOutcomes = await mapWithConcurrency(located, ARTICLE_CONCURRENCY, async (item, index) => {
    const position = `${index + 1}/${located.length}`;
    try {
      const data = await withRetryOnce(() => fetchAndParse(item.url, '汇编'), item.url);
      console.log(`[抓取 ${position} 成功] ${data.title}`);
      return { ok: true, item, data };
    } catch (err) {
      console.error(`[抓取 ${position} 失败] ${item.url} - ${err.message}`);
      return { ok: false, item, message: err.message };
    }
  });

  // 汇编 Word（保持输入顺序）
  const parsedByUrl = new Map();
  for (const outcome of parseOutcomes) {
    if (outcome.ok) parsedByUrl.set(outcome.item.url, outcome.data);
  }
  const articles = searchOutcomes
    .filter((item) => item.ok && parsedByUrl.has(item.url))
    .map((item) => parsedByUrl.get(item.url));

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 全部失败时也要给出清单（含可续跑输入），否则用户拿不到下一步的输入
  if (articles.length === 0) {
    const failedRows = [['序号', '输入标题', '类别', '公众号', '失败原因']];
    searchOutcomes.forEach((item, index) => {
      failedRows.push([index + 1, item.title, item.category || '', item.account || '', item.ok ? '抓取失败' : item.message]);
    });
    // 全失败时清单包含全部篇目（含「已定位但抓取失败」的）
    const retryInput = buildRetryInput(items.map((item) => ({ ...item, ok: false })));
    const failZip = new AdmZip();
    failZip.addFile(`搜索定位结果_${dateStr}.xlsx`, buildXlsx('搜索定位结果', failedRows));
    failZip.addFile('搜索定位结果.txt', Buffer.from(
      `本次 0 篇成功（共 ${items.length} 篇）：\n${failedRows.slice(1).map((row) => `[失败] ${row[1]}：${row[4]}`).join('\n')}\n`,
      'utf8',
    ));
    failZip.addFile('待重跑清单.txt', Buffer.from(
      `# 以下 ${items.length} 篇未成功，可粘贴回输入框续跑\n${retryInput}\n`,
      'utf8',
    ));
    res.setHeader('X-Assemble-Result', encodeURIComponent(JSON.stringify({
      total: items.length,
      success: 0,
      failed: items.length,
      account: items.find((item) => item.account)?.account || '',
      retryTitles: items.map((item) => (item.category ? `${item.title}（${item.category}）` : item.title)),
      results: searchOutcomes.map((item) => `[失败] ${item.title}：${item.ok ? '抓取失败' : item.message}`),
    })));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`搜索定位结果_${dateStr}.zip`)}`);
    res.send(failZip.toBuffer());
    console.log(`[搜索汇编完成] 0 篇成功，已输出失败清单供续跑`);
    return;
  }

  const buffer = await buildAssembleDocx(articles);

  // 搜索定位结果清单（Excel）
  const summaryRows = [['序号', '状态', '输入标题', '类别', '定位到的公众号', '定位到的标题', '文章链接', '失败原因']];
  searchOutcomes.forEach((item, index) => {
    summaryRows.push([
      index + 1,
      item.ok && parsedByUrl.has(item.url) ? '成功' : '失败',
      item.title,
      item.category || '',
      item.ok ? canonicalAccountName(item.resultAccount) : '',
      item.ok ? item.resultTitle : '',
      item.ok ? item.url : '',
      item.ok ? '' : item.message,
    ]);
  });

  const failedOutcomes = searchOutcomes.filter((item) => !item.ok || !parsedByUrl.has(item.url));
  const retryInput = buildRetryInput(failedOutcomes);

  const zip = new AdmZip();
  zip.addFile(`汇编_按标题搜索_${dateStr}.docx`, Buffer.from(buffer));
  zip.addFile(`搜索定位结果_${dateStr}.xlsx`, buildXlsx('搜索定位结果', summaryRows));
  zip.addFile('搜索定位结果.txt', Buffer.from(
    [
      `搜索定位结果（共 ${items.length} 篇，定位成功 ${located.length} 篇，汇编成功 ${articles.length} 篇）`,
      '',
      ...summaryRows.slice(1).map((row) =>
        row[1] === '成功' ? `[成功] ${row[2]} → ${row[6]}` : `[失败] ${row[2]}：${row[7]}`,
      ),
    ].join('\n'),
    'utf8',
  ));
  // 待重跑清单：格式与输入一致，可直接粘贴回输入框继续跑（配合定位缓存，已成功的不会重复搜索）
  if (retryInput) {
    zip.addFile('待重跑清单.txt', Buffer.from(
      `# 共 ${failedOutcomes.length} 篇未成功，复制以下内容粘贴回「🔍 搜索汇编」输入框即可续跑\n${retryInput}\n`,
      'utf8',
    ));
  }

  const zipFilename = `汇编_按标题搜索_${dateStr}.zip`;
  res.setHeader('X-Assemble-Result', encodeURIComponent(JSON.stringify({
    total: items.length,
    success: articles.length,
    failed: failedOutcomes.length,
    account: items.find((item) => item.account)?.account || '',
    // 前端据此生成可粘贴的重跑清单（只含失败篇目，带类别后缀）
    retryTitles: failedOutcomes.map((item) => (item.category ? `${item.title}（${item.category}）` : item.title)),
    results: searchOutcomes.map((item) =>
      item.ok && parsedByUrl.has(item.url) ? `[成功] ${item.title}` : `[失败] ${item.title}：${item.ok ? '抓取失败' : item.message}`,
    ),
  })));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipFilename)}`);
  res.send(zip.toBuffer());

  console.log(`[搜索汇编完成] 定位 ${located.length}/${items.length}，汇编 ${articles.length} 篇`);
});

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log('==============================================');
    console.log('  微信公众号文章 → Word 自动化工具已启动');
    console.log('  本机访问：  http://localhost:' + PORT);
    console.log('  局域网访问：http://<本机IP>:' + PORT);
    console.log('==============================================');
  });
  // 搜索汇编耗时较长（限速搜索 + 逐篇抓取），禁用请求超时
  server.requestTimeout = 0;
}

module.exports = {
  app,
  fetchAndParse,
  convertOne,
  extractWechatLinks,
  buildSummaryRows,
  parseTitleList,
  buildRetryInput,
};
