'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const Jimp = require('jimp');

const { fetchAndParse, extractWechatLinks, buildSummaryRows } = require('../server');
const SERVER_PATH = join(__dirname, '..', 'server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function response({ ok = true, status = 200, statusText = 'OK', body = Buffer.alloc(0), headers = {} } = {}) {
  return {
    ok, status, statusText,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body)),
    arrayBuffer: async () => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

/** 构造一个 mock fetch：文章 URL 返回 HTML，图片 URL 返回同一张 PNG */
function mockFetch(html, png, { delayMs = 0 } = {}) {
  const calls = [];
  const handler = async (url) => {
    calls.push(url);
    if (String(url).includes('mp.weixin.qq.com')) return response({ body: Buffer.from(html, 'utf8') });
    await sleep(delayMs);
    return response({ body: png, headers: { 'content-type': 'image/png' } });
  };
  return { calls, handler };
}

function articleHtml(imageUrls) {
  const body = imageUrls
    .map((url) => `<p><img data-src="${url}" data-w="1000" data-ratio="0.78"></p>`)
    .join('');
  return `<!doctype html><html><body><h1 id="activity-name">并发测试文章</h1><span id="js_name">测试号</span><div id="js_content">${body}</div></body></html>`;
}

async function withSilentConsole(callback) {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

async function runFetchAndParse(html, png, options) {
  const { calls, handler } = mockFetch(html, png, options);
  return withSilentConsole(async () => {
    const original = global.fetch;
    global.fetch = handler;
    try {
      return { data: await fetchAndParse('https://mp.weixin.qq.com/s/test', '轻心理'), calls };
    } finally {
      global.fetch = original;
    }
  });
}

test('pipeline/链接提取同时支持短链与参数链形态', () => {
  const text = [
    'https://mp.weixin.qq.com/s/R5EazIPJkDmDKQX5lNT7XA',
    'https://mp.weixin.qq.com/s?__biz=MzU2MDEwMTIwMg==&mid=2247656493&idx=1&sn=caa5d35ae93764fc3f0f373f09c6d5bb&scene=0#rd',
  ].join('\n');
  assert.deepEqual(extractWechatLinks(text), [
    'https://mp.weixin.qq.com/s/R5EazIPJkDmDKQX5lNT7XA',
    'https://mp.weixin.qq.com/s?__biz=MzU2MDEwMTIwMg==&mid=2247656493&idx=1&sn=caa5d35ae93764fc3f0f373f09c6d5bb&scene=0#rd',
  ]);
  // 尾随中文标点不吃进 URL
  assert.deepEqual(
    extractWechatLinks('看这篇：https://mp.weixin.qq.com/s/abcDEF123，写得不错。'),
    ['https://mp.weixin.qq.com/s/abcDEF123'],
  );
  assert.deepEqual(extractWechatLinks('没有链接的内容'), []);
});

test('pipeline/批量结果清单：文件名去后缀，来源与作者合并为「文章来源」', () => {
  const outcomes = [
    { ok: true, url: 'https://mp.weixin.qq.com/s/a', title: 'AI正在「惩罚」那些用它写作业的中学生', filename: 'AI正在「惩罚」那些用它写作业的中学生（轻纪实）.docx', author: '王青', account: '人物' },
    { ok: true, url: 'https://mp.weixin.qq.com/s/b', title: '阁楼上的物理「天才」', filename: '阁楼上的物理「天才」（轻纪实）.docx', author: '罗兰', account: '谷雨实验室' },
    { ok: false, url: 'https://mp.weixin.qq.com/s/c', message: '文章抓取超时（20000ms）' },
  ];
  const rows = buildSummaryRows(outcomes, '轻纪实');
  assert.deepEqual(rows[0], ['序号', '状态', '文章原名', '抓取后文件名', '文章来源', '链接', '失败原因']);
  assert.deepEqual(rows[1], [
    1, '成功', 'AI正在「惩罚」那些用它写作业的中学生',
    'AI正在「惩罚」那些用它写作业的中学生（轻纪实）', // 无 .docx
    '人物 王青', // 来源在前、作者在后
    'https://mp.weixin.qq.com/s/a', '',
  ]);
  assert.equal(rows[2][4], '谷雨实验室 罗兰');

  // 轻心理：文章来源只填来源，不带作者名
  const light = buildSummaryRows([outcomes[0]], '轻心理');
  assert.equal(light[1][4], '人物', '轻心理的文章来源不应包含作者');

  // 失败行：文件名与来源留空，链接与原因保留
  assert.equal(rows[3][1], '失败');
  assert.equal(rows[3][3], '');
  assert.equal(rows[3][4], '');
  assert.equal(rows[3][6], '文章抓取超时（20000ms）');
});

test('pipeline/公众号名按映射输出规范名', () => {
  const outcomes = [
    { ok: true, url: 'https://mp.weixin.qq.com/s/a', title: '一种情绪', filename: '一种情绪（轻心理）.docx', author: '某某', account: 'KnowYourself' },
  ];
  // 轻心理：文章来源只填来源，且用规范名
  const light = buildSummaryRows(outcomes, '轻心理');
  assert.equal(light[1][4], 'KnowYourself知我心理');
  // 其它类别：来源（规范名）+ 作者
  const rich = buildSummaryRows(outcomes, '轻纪实');
  assert.equal(rich[1][4], 'KnowYourself知我心理 某某');
  // 未配置的公众号保持原名
  const other = buildSummaryRows([{ ...outcomes[0], account: '人物' }], '轻心理');
  assert.equal(other[1][4], '人物');
});

test('pipeline/断行链接修复：粘贴时被换行断开的长参数链能完整提取', () => {
  // 复刻用户截图的输入：长参数链被断成 2-3 行
  const text = [
    'http://mp.weixin.qq.com/s?',
    '__biz=MjEwMzA5NTcyMQ==&mid=2653256355&idx=1&sn=8d7b00a08b8ffe09c5797bb68b0e802b&chksm=4f5a1a24013ae7ec5f6655e3eed44fe2086a12eb9d660417ddfe8e39d0a60f9532affdbfdd13&scene=0&xtrack=1#rd',
    'http://mp.weixin.qq.com/s?',
    '__biz=MjEwMzA5NTcyMQ==&mid=2653256000&idx=1&sn=352b9caddb9366e641744acc6e61a10f&chksm=4fa1b07dc514d7bfd4982bd2293d9169f167cbefb38b04268fd45',
    '2123b6ba7ofde38a1be821c&scene=0&xtrack=1#rd',
  ].join('\n');
  const links = extractWechatLinks(text);
  assert.equal(links.length, 2, '两个断行链接应完整提取');
  assert.match(links[0], /sn=8d7b00a08b8ffe09c5797bb68b0e802b/);
  assert.match(links[1], /sn=352b9caddb9366e641744acc6e61a10f/);
  assert.match(links[1], /2123b6ba7ofde38a1be821c&scene=0&xtrack=1#rd$/, '参数值中段的断行也要拼回');

  // 正常输入不受影响：两个完整链接各占一行
  const normal = extractWechatLinks([
    'https://mp.weixin.qq.com/s/abcDEF123',
    'https://mp.weixin.qq.com/s?__biz=x&mid=1&sn=y#rd',
  ].join('\n'));
  assert.equal(normal.length, 2);
  // 标题行（汉字开头）不会被误拼进链接
  const withTitles = extractWechatLinks([
    'https://mp.weixin.qq.com/s/abc123',
    '另一个标题',
  ].join('\n'));
  assert.equal(withTitles.length, 1);
});

test('pipeline/重复图片地址只下载一次', async () => {
  const png = await new Jimp(300, 200, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const url = 'https://mmbiz.qpic.cn/mmbiz_png/same.png';
  const { data, calls } = await runFetchAndParse(articleHtml([url, url, url]), png);

  const imageCalls = calls.filter((u) => u === url);
  assert.equal(imageCalls.length, 1, '同一 src 的三处引用应共用一次下载');
  assert.equal(data.blocks.filter((b) => b.type === 'image').length, 3, '三处引用都要保留为独立图片块');
  assert.ok(data.imageDiagnostics.every((item) => item.status === 'kept'));
});

test('pipeline/多张图片并发下载，耗时不随图片数量线性累加', async () => {
  const png = await new Jimp(300, 200, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const urls = Array.from({ length: 8 }, (_, i) => `https://mmbiz.qpic.cn/mmbiz_png/p${i}.png`);
  const started = Date.now();
  const { data } = await runFetchAndParse(articleHtml(urls), png, { delayMs: 60 });
  const elapsed = Date.now() - started;

  assert.equal(data.imageDiagnostics.length, 8);
  assert.ok(data.imageDiagnostics.every((item) => item.status === 'kept'));
  assert.ok(elapsed < 8 * 60 * 0.6, `8 张图并发耗时应明显短于串行，实际 ${elapsed}ms`);
});

test('pipeline/纯 PNG 文章走完流程仍未加载图形库', async () => {
  // 图形库加载是进程级副作用，必须在独立子进程里验证
  const png = await new Jimp(300, 234, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const html = articleHtml(['https://mmbiz.qpic.cn/mmbiz_png/lazy.png']);
  const code = `
    (async () => {
      const { fetchAndParse } = require(${JSON.stringify(SERVER_PATH)});
      const html = ${JSON.stringify(html)};
      const png = Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64');
      const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      global.fetch = async () => ({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => 'image/png' },
        text: async () => html,
        arrayBuffer: async () => toArrayBuffer(png),
      });
      console.log = () => {};
      const data = await fetchAndParse('https://mp.weixin.qq.com/s/lazy', '轻心理');
      const jimpLoaded = Object.keys(require.cache).some((key) => key.includes('/node_modules/jimp/'));
      process.stdout.write(JSON.stringify({
        jimpLoaded,
        kept: data.imageDiagnostics.filter((item) => item.status === 'kept').length,
      }));
    })().catch((error) => { process.stdout.write(JSON.stringify({ error: error.message })); });
  `;
  const output = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.error, undefined, `子进程异常：${result.error}`);
  assert.equal(result.kept, 1, '图片应正常嵌入');
  assert.equal(result.jimpLoaded, false, 'PNG/JPEG 直通路径不应加载图形库');
});

test('pipeline/下载失败的图片保留可诊断状态而不中断整篇', async () => {
  const png = await new Jimp(300, 200, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const urls = [
    'https://mmbiz.qpic.cn/mmbiz_png/ok.png',
    'https://mmbiz.qpic.cn/mmbiz_png/bad.png',
  ];
  const html = articleHtml(urls);
  await withSilentConsole(async () => {
    const original = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('mp.weixin.qq.com')) return response({ body: Buffer.from(html, 'utf8') });
      if (String(url).includes('bad.png')) return response({ ok: false, status: 404, statusText: 'Not Found' });
      return response({ body: png });
    };
    try {
      const data = await fetchAndParse('https://mp.weixin.qq.com/s/test', '轻心理');
      const statuses = data.imageDiagnostics.map((item) => item.status);
      assert.deepEqual(statuses, ['kept', 'download_failed']);
      assert.ok(data.blocks.some((b) => b.type === 'deleted' && b.label === '图片下载失败'));
    } finally {
      global.fetch = original;
    }
  });
});
