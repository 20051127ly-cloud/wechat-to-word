'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Jimp = require('jimp');
const { readImageSize } = require('../src/imageSize');

/** 手工拼一个 GIF 文件头（逻辑屏幕描述符即画布尺寸） */
function gifHeader(width, height) {
  const buffer = Buffer.alloc(10);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** VP8L（无损）WebP：尺寸位宽 14 + 14 */
function webpLossless(width, height) {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE(((height - 1) << 14) | (width - 1), 0);
  const payload = Buffer.concat([Buffer.from([0x2f]), bits]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + payload.length, 4);
  header.write('WEBP', 8, 'ascii');
  const chunk = Buffer.alloc(8);
  chunk.write('VP8L', 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, chunk, payload]);
}

/** VP8（有损）WebP：3 字节帧头 + 3 字节起始码 + 宽高 */
function webpLossy(width, height) {
  const payload = Buffer.alloc(10);
  payload.writeUInt8(0x9d, 3);
  payload.writeUInt8(0x01, 4);
  payload.writeUInt8(0x2a, 5);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + payload.length, 4);
  header.write('WEBP', 8, 'ascii');
  const chunk = Buffer.alloc(8);
  chunk.write('VP8 ', 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, chunk, payload]);
}

/** 24 位 BMP：14 字节文件头 + 40 字节 DIB 头 */
function bmpHeader(width, height) {
  const buffer = Buffer.alloc(54);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  return buffer;
}

/** 小端 TIFF：IFD 里放 ImageWidth / ImageLength 两个 SHORT 标签 */
function tiffHeader(width, height) {
  const buffer = Buffer.alloc(8 + 2 + 24 + 4);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  buffer.writeUInt16LE(2, 8); // 目录项数量
  buffer.writeUInt16LE(0x0100, 10); // ImageWidth
  buffer.writeUInt16LE(3, 12); // SHORT
  buffer.writeUInt32LE(1, 14);
  buffer.writeUInt16LE(width, 18);
  buffer.writeUInt16LE(0, 20);
  buffer.writeUInt16LE(0x0101, 22); // ImageLength
  buffer.writeUInt16LE(3, 24);
  buffer.writeUInt32LE(1, 26);
  buffer.writeUInt16LE(height, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt32LE(0, 34); // 下一个 IFD 偏移
  return buffer;
}

test('imageSize/与图形库生成的真实 PNG、JPEG 尺寸一致', async () => {
  for (const [width, height] of [[23, 17], [640, 480], [1000, 750]]) {
    const bitmap = new Jimp(width, height, 0xffffffff);
    const png = await bitmap.getBufferAsync(Jimp.MIME_PNG);
    assert.deepEqual(readImageSize(png, 'png'), { width, height }, `PNG ${width}x${height}`);
    const jpeg = await bitmap.getBufferAsync(Jimp.MIME_JPEG);
    assert.deepEqual(readImageSize(jpeg, 'jpeg'), { width, height }, `JPEG ${width}x${height}`);
  }
});

test('imageSize/渐进式 JPEG 也能从 SOF2 读出尺寸', async () => {
  const jpeg = await new Jimp(321, 123, 0xffffffff).getBufferAsync(Jimp.MIME_JPEG);
  const progressive = Buffer.from(jpeg);
  // 把 baseline 的 SOF0(0xC0) 改成 SOF2(0xC2)，模拟渐进式编码
  for (let i = 0; i + 1 < progressive.length; i++) {
    if (progressive[i] === 0xff && progressive[i + 1] === 0xc0) {
      progressive[i + 1] = 0xc2;
      break;
    }
  }
  assert.deepEqual(readImageSize(progressive, 'jpeg'), { width: 321, height: 123 });
});

test('imageSize/GIF、BMP、TIFF 文件头尺寸', () => {
  assert.deepEqual(readImageSize(gifHeader(300, 200), 'gif'), { width: 300, height: 200 });
  assert.deepEqual(readImageSize(bmpHeader(800, 600), 'bmp'), { width: 800, height: 600 });
  // 自上而下存储的 BMP 高度为负，应取绝对值
  assert.deepEqual(readImageSize(bmpHeader(800, -600), 'bmp'), { width: 800, height: 600 });
  assert.deepEqual(readImageSize(tiffHeader(1024, 768), 'tiff'), { width: 1024, height: 768 });
});

test('imageSize/WebP 三种容器（有损 / 无损 / 扩展）', () => {
  assert.deepEqual(readImageSize(webpLossy(640, 480), 'webp'), { width: 640, height: 480 });
  assert.deepEqual(readImageSize(webpLossless(640, 480), 'webp'), { width: 640, height: 480 });
  const extended = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4 + 8 + 10, 0); return b; })(),
    Buffer.from('WEBPVP8X', 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10, 0); return b; })(),
    (() => {
      const b = Buffer.alloc(10);
      b.writeUIntLE(1279, 4, 3); // 宽 1280
      b.writeUIntLE(719, 7, 3); // 高 720
      return b;
    })(),
  ]);
  assert.deepEqual(readImageSize(extended, 'webp'), { width: 1280, height: 720 });
});

test('imageSize/损坏数据或不明格式返回 null 而不是抛错', () => {
  assert.equal(readImageSize(Buffer.alloc(64), 'png'), null);
  assert.equal(readImageSize(Buffer.from('not an image at all'), 'jpeg'), null);
  assert.equal(readImageSize(null, 'png'), null);
  assert.equal(readImageSize(Buffer.alloc(64), 'svg'), null);
  // 长度被截断的 JPEG 不会越界读
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x00]), 'jpeg'), null);
});
