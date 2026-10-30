'use strict';

/**
 * 图片尺寸解析模块
 * 只读取文件头/元数据，不解码像素，因此不依赖任何图形库。
 * 用途：替代 Jimp 取宽高，避免为「读两个数字」付出加载图形库的成本。
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 扫描 SOF 段取 JPEG 尺寸； progressive / baseline 都覆盖。 */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    // 无长度字段的标记：填充字节、独立标记、重启标记
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function gifSize(buffer) {
  if (buffer.length < 10) return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** WebP：VP8（有损）/ VP8L（无损）/ VP8X（扩展，含动图）三种容器。 */
function webpSize(buffer) {
  if (buffer.length < 16) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const riffSize = buffer.readUInt32LE(4);
  const end = Math.min(buffer.length, 8 + (riffSize > 0 ? riffSize : buffer.length));
  let offset = 12;
  while (offset + 8 <= end) {
    const fourcc = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (fourcc === 'VP8X' && payload + 10 <= end) {
      const width = buffer.readUIntLE(payload + 4, 3) + 1;
      const height = buffer.readUIntLE(payload + 7, 3) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (fourcc === 'VP8 ' && payload + 10 <= end) {
      const width = buffer.readUInt16LE(payload + 6) & 0x3fff;
      const height = buffer.readUInt16LE(payload + 8) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (fourcc === 'VP8L' && payload + 5 <= end) {
      const bits = buffer.readUInt32LE(payload + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (size <= 0) break;
    offset = payload + size + (size % 2); // chunk 按偶数字节对齐
  }
  return null;
}

function bmpSize(buffer) {
  if (buffer.length < 26 || buffer.toString('ascii', 0, 2) !== 'BM') return null;
  // DIB 头紧跟 14 字节文件头：offset 14 = 头长度，18 = 宽，22 = 高
  const dibSize = buffer.readUInt32LE(14);
  // BITMAPCOREHEADER（12 字节）的宽高是 16 位，其余头（40 字节起）是 32 位
  if (dibSize === 12) {
    if (buffer.length < 22) return null;
    const width = buffer.readUInt16LE(18);
    const height = buffer.readUInt16LE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  // 高度可能为负（自上而下存储），取绝对值
  return width > 0 && height !== 0 ? { width, height: Math.abs(height) } : null;
}

function tiffSize(buffer) {
  if (buffer.length < 8) return null;
  const bom = buffer.toString('ascii', 0, 2);
  if (bom !== 'II' && bom !== 'MM') return null;
  const little = bom === 'II';
  const readUInt16 = (offset) => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readUInt32 = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const ifdOffset = readUInt32(4);
  if (ifdOffset + 2 > buffer.length) return null;
  const count = readUInt16(ifdOffset);
  let width = null;
  let height = null;
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > buffer.length) break;
    const tag = readUInt16(entry);
    // 0x0100 ImageWidth / 0x0101 ImageLength；值可能是 SHORT 或 LONG
    const value = readUInt16(entry + 2) === 3 ? readUInt16(entry + 8) : readUInt32(entry + 8);
    if (tag === 0x0100 && width == null) width = value;
    if (tag === 0x0101 && height == null) height = value;
    if (width != null && height != null) break;
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

const PARSERS = {
  png: pngSize,
  jpeg: jpegSize,
  gif: gifSize,
  webp: webpSize,
  bmp: bmpSize,
  tiff: tiffSize,
};

/**
 * 读取图片像素尺寸
 * @param {Buffer} buffer 图片数据
 * @param {string} ext 由文件签名识别出的格式（见 fetcher.sniffImageFormat）
 * @returns {{width: number, height: number}|null} 解析失败返回 null
 */
function readImageSize(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  const parser = PARSERS[ext];
  if (!parser) return null;
  try {
    return parser(buffer);
  } catch {
    return null;
  }
}

module.exports = { readImageSize };
