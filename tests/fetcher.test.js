'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Jimp = require('jimp');
const { fetchArticle, fetchImage, normalizeImageUrl, detectAnimated } = require('../src/fetcher');

async function withFetch(handler, callback) {
  const original = global.fetch;
  global.fetch = handler;
  try {
    return await callback();
  } finally {
    global.fetch = original;
  }
}

function response({ ok = true, status = 200, statusText = 'OK', body, headers = {} } = {}) {
  return {
    ok, status, statusText,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => typeof body === 'string' ? body : Buffer.from(body || []).toString('utf8'),
    arrayBuffer: async () => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

test('fetcher/补全协议相对 HTTP 图片地址', () => {
  assert.equal(normalizeImageUrl('//example.com/a.png'), 'https://example.com/a.png');
  assert.equal(normalizeImageUrl('http://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(normalizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
});

test('fetcher/文章 HTTP 失败返回可分类错误', async () => {
  await withFetch(async () => response({ ok: false, status: 503, statusText: 'Service Unavailable' }), async () => {
    await assert.rejects(fetchArticle('https://example.invalid/article'), (error) => error.code === 'ARTICLE_HTTP_ERROR' && error.status === 503);
  });
});

test('fetcher/图片使用真实 PNG 尺寸和格式，而不是 URL 后缀', async () => {
  const bitmap = new Jimp(23, 17, 0xffffffff);
  const png = await bitmap.getBufferAsync(Jimp.MIME_PNG);
  await withFetch(async () => response({ body: png, headers: { 'content-type': 'image/jpeg' } }), async () => {
    const image = await fetchImage('https://example.invalid/photo.jpg?wx_fmt=jpeg');
    assert.equal(image.ext, 'png');
    assert.equal(image.sourceExt, 'png');
    assert.equal(image.width, 23);
    assert.equal(image.height, 17);
    assert.equal(image.animated, false);
    assert.ok(image.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  });
});

test('fetcher/非图片响应不会伪装成可嵌入图片', async () => {
  await withFetch(async () => response({ body: '<html>not an image</html>' }), async () => {
    await assert.rejects(fetchImage('https://example.invalid/not-image'), (error) => error.code === 'IMAGE_INVALID_DATA');
  });
});

test('fetcher/检测 GIF 多帧与静态 PNG', () => {
  const animatedGif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xFF\xFF\xFF!\xF9\x04\x00\x00\x00\x00\x00!\xF9\x04\x00\x00\x00\x00\x00;','binary');
  assert.equal(detectAnimated(animatedGif, 'gif'), true);
  assert.equal(detectAnimated(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'png'), false);
});
