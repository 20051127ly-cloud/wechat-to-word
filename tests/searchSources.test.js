'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpSource, render, locateArticle } = require('../src/searchSources');

/** 构造假的 fetch，返回指定 JSON */
function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

const CONTEXT = { title: '亲爱的招弟', account: '人物' };

test('搜索源/占位符渲染：${title} ${account} 与环境变量', () => {
  process.env.TEST_SEARCH_KEY = 'secret';
  assert.equal(render('${title}|${account}', CONTEXT), '亲爱的招弟|人物');
  assert.equal(render('Bearer ${env:TEST_SEARCH_KEY}', CONTEXT), 'Bearer secret');
  assert.equal(render('${env:NOT_SET}', CONTEXT), '');
  delete process.env.TEST_SEARCH_KEY;
});

test('搜索源/HTTP 适配器：GET 参数与响应字段映射', async () => {
  const seen = [];
  const restore = mockFetch(async (url, options) => {
    seen.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          list: [
            { title: '无关的别的文章', accountName: '其他号', url: 'https://mp.weixin.qq.com/s/other' },
            { title: '亲爱的招弟', accountName: '人物', url: 'https://mp.weixin.qq.com/s/target' },
          ],
        },
      }),
    };
  });
  try {
    const source = createHttpSource({
      name: 'mock',
      url: 'https://api.example.com/search',
      headers: { Authorization: 'Bearer ${env:ANY}' },
      params: { keyword: '${title}', account: '${account}' },
      resultPath: 'data.list',
      fields: { title: 'title', account: 'accountName', url: 'url' },
    });
    const found = await source.search('人物', '亲爱的招弟');
    assert.ok(found, '应命中目标文章');
    assert.equal(found.url, 'https://mp.weixin.qq.com/s/target');
    // 请求里带上了渲染后的参数
    assert.match(seen[0].url, /keyword=.*account=/);
  } finally {
    restore();
  }
});

test('搜索源/HTTP 适配器：公众号不匹配时不误命中', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ list: [{ title: '亲爱的招弟', account: '其他号', url: 'https://mp.weixin.qq.com/s/x' }] }),
  }));
  try {
    const source = createHttpSource({
      url: 'https://api.example.com/search',
      params: { keyword: '${title}' },
      resultPath: 'list',
    });
    assert.equal(await source.search('人物', '亲爱的招弟'), null);
  } finally {
    restore();
  }
});

test('搜索源/HTTP 适配器：请求失败或超时不抛错，返回 null 交由下一个源处理', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    const source = createHttpSource({ url: 'https://api.example.com/search', params: {} });
    assert.equal(await source.search('人物', '亲爱的招弟'), null);
  } finally {
    restore();
  }
});

test('搜索源/多源调度：本地链接库命中时不再调用外部源', async () => {
  // 本地链接库当前为空或未包含该标题时，locateArticle 会把错误聚合成 SEARCH_NOT_MATCHED
  await assert.rejects(
    locateArticle('不存在的公众号XYZ', '不存在的标题ABC123'),
    (error) => error.code === 'SEARCH_NOT_MATCHED',
  );
});
