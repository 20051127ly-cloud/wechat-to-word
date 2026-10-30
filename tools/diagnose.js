'use strict';

/**
 * 单篇文章诊断工具
 *
 * 用法：
 *   node tools/diagnose.js <文章链接>
 *   node tools/diagnose.js --html ./saved.html          # 复用已保存的 HTML，不重复请求微信
 *   node tools/diagnose.js <链接> --save-html           # 保存原始 HTML 到 .cache/
 *   node tools/diagnose.js <链接> --no-images           # 跳过图片下载，只看解析结果（更快）
 *   node tools/diagnose.js <链接> --text                # 只打印正文文本流（不看块属性）
 *
 * 目的：把 parser 的分类结果摊开，定位「标题误判 / 图注误判 / 噪声残留 / 图片丢失」等问题。
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchArticle } = require('../src/fetcher');
const { parseArticle } = require('../src/parser');
const { fetchAndParse } = require('../server');

const CACHE_DIR = path.join(__dirname, '..', '.cache');

function parseArgs(argv) {
  const options = { saveHtml: false, noImages: false, textOnly: false, raw: false, htmlFile: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--save-html') options.saveHtml = true;
    else if (arg === '--no-images') options.noImages = true;
    else if (arg === '--text') options.textOnly = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--html') options.htmlFile = argv[++i];
    else options.positional.push(arg);
  }
  return options;
}

function cachePathFor(url) {
  // 兼容两种链接形态：短链 /s/xxxx 与参数链 /s?...&sn=xxxx（否则参数链会互相覆盖缓存）
  const sn = (url.match(/[?&]sn=([A-Za-z0-9_-]+)/) || [])[1];
  const id = sn || (url.match(/\/s\/([A-Za-z0-9_-]+)/) || [])[1] || 'article';
  return path.join(CACHE_DIR, `${id}.html`);
}

async function loadHtml(target, options) {
  if (target.startsWith('http')) {
    const html = await fetchArticle(target);
    if (options.saveHtml) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const file = cachePathFor(target);
      fs.writeFileSync(file, html, 'utf8');
      console.log(`[HTML 已保存] ${file}`);
    }
    return html;
  }
  return fs.readFileSync(target, 'utf8');
}

const LABELS = {
  paragraph: '正文  ',
  subheading: '标题  ',
  caption: '图注  ',
  image: '图片  ',
  copyright: '版权  ',
  deleted: '已删  ',
  quote: '引用  ',
  video: '视频  ',
};

function describe(block, index) {
  const label = LABELS[block.type] || `${block.type}`.padEnd(5);
  const prefix = `[${String(index).padStart(2)}] ${label}`;
  if (block.type === 'image') {
    const size = block.actualWidth ? `${block.actualWidth}x${block.actualHeight}` : `${block.width || '?'}x${block.height || '?'}`;
    const state = block.status ? ` status=${block.status}` : '';
    const reason = block.reason ? ` reason=${block.reason}` : '';
    return `${prefix} ${size}${state}${reason} ${(block.src || '').slice(0, 60)}`;
  }
  const meta = [];
  if (block.level) meta.push(`L${block.level}`);
  if (block.style && block.style.fontSize) meta.push(`${block.style.fontSize}px`);
  if (block.label) meta.push(`(${block.label})`);
  const text = (block.text || '').replace(/\s+/g, ' ').trim();
  const shown = text.length > 70 ? `${text.slice(0, 70)}…` : text;
  return `${prefix} ${meta.join(' ')} ${shown}`;
}

/**
 * 打印解析前的原始版面结构，用于和解析结果对照（找误判的 ground truth）。
 * 只输出有文本或图片的元素，跳过纯容器。
 */
function printRawStructure(html) {
  const $ = cheerio.load(html);
  const root = $('#js_content');
  const scope = root.length ? root : $('body');
  const BLOCK = /^(p|section|div|blockquote|h1|h2|h3|h4|h5|h6|li|td)$/;
  const SKIP = /^(script|style|svg|path|br)$/;

  // 收集「块级叶子」：内部不再含有块级元素的块，正好对应一个逻辑段落 / 图片组
  const leaves = [];
  const walk = (element) => {
    const tag = (element[0].tagName || '').toLowerCase();
    if (SKIP.test(tag)) return;
    const children = element.children().toArray();
    const blockChildren = children.filter((child) => BLOCK.test((child.tagName || '').toLowerCase()));
    if (blockChildren.length) {
      for (const child of children) walk($(child));
      return;
    }
    if (BLOCK.test(tag)) leaves.push({ element, tag });
    else for (const child of children) walk($(child));
  };
  scope.children().each((index, child) => walk($(child)));

  leaves.forEach(({ element, tag }, index) => {
    const images = element.find('img').toArray().map((img) => {
      const $img = $(img);
      const src = $img.attr('data-src') || $img.attr('src') || '';
      return `w=${$img.attr('data-w') || $img.attr('width') || '?'} ratio=${$img.attr('data-ratio') || '-'} ${src.slice(0, 60)}`;
    });
    const text = element.text().replace(/\s+/g, ' ').trim();
    // 取该段内出现过的最小字号（公众号常用小字号标图注），以及是否整体加粗
    const sizes = element.find('*').addBack().toArray()
      .map((node) => Number(((($(node).attr('style') || '').match(/font-size:\s*([\d.]+)px/) || [])[1])))
      .filter((n) => Number.isFinite(n) && n > 0);
    const fontSize = sizes.length ? Math.min(...sizes) : null;
    const bold = element.find('strong,b').length > 0
      || /font-weight:\s*(bold|[6-9]00)/.test(element.attr('style') || '');
    const align = ((element.attr('style') || '').match(/text-align:\s*([a-z]+)/) || [])[1]
      || ((element.find('*').attr('style') || '').match(/text-align:\s*([a-z]+)/) || [])[1] || '';

    const meta = [fontSize ? `${fontSize}px` : '', align, bold ? 'B' : ''].filter(Boolean).join(' ');
    const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    console.log(`[${String(index).padStart(2)}] <${tag}> ${meta} ${shown}`);
    for (const image of images) console.log(`    └─ <img> ${image}`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.htmlFile || options.positional[0];
  if (!target) {
    console.error('用法：node tools/diagnose.js <文章链接|--html 文件路径> [--no-images] [--save-html] [--text] [--raw]');
    process.exit(1);
  }

  if (options.raw) {
    printRawStructure(await loadHtml(target, options));
    return;
  }

  const started = Date.now();
  // 先取 HTML（来自链接或本地文件），再决定是否下载图片，避免重复请求文章页
  const html = await loadHtml(target, options);
  const data = options.noImages
    ? parseArticle(html)
    : await fetchAndParse(target, '轻心理', { html });
  data.category = data.category || '轻心理';

  console.log('============================================');
  console.log(`标题：${data.title}`);
  console.log(`公众号：${data.account || '(空)'}  作者：${data.author || '(空)'}  编辑：${data.editor || '(空)'}`);
  if (data.category) console.log(`类别：${data.category}`);
  console.log(`块数量：${data.blocks.length}  参考文献：${(data.references || []).length}  耗时：${Date.now() - started}ms`);
  console.log('============================================');

  if (options.textOnly) {
    for (const [index, block] of data.blocks.entries()) {
      if (block.type === 'image') { console.log(`[${index}] <图片>`); continue; }
      console.log(`[${index}] ${block.text || ''}`);
    }
  } else {
    for (const [index, block] of data.blocks.entries()) console.log(describe(block, index));
  }

  if (Array.isArray(data.references) && data.references.length) {
    console.log('--- 参考文献 ---');
    for (const item of data.references) console.log(`  - ${item}`);
  }

  if (Array.isArray(data.imageDiagnostics) && data.imageDiagnostics.length) {
    const summary = new Map();
    for (const item of data.imageDiagnostics) {
      const key = `${item.status}/${item.reason || '-'}`;
      summary.set(key, (summary.get(key) || 0) + 1);
    }
    console.log('--- 图片状态汇总 ---');
    for (const [key, count] of summary) console.log(`  ${key}: ${count}`);
  }
}

main().catch((error) => {
  console.error('[诊断失败]', error.message);
  process.exit(1);
});
