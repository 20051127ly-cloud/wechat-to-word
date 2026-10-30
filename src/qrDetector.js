'use strict';

/**
 * 二维码图片识别模块
 * 用于识别「文章开头/结尾」位置的图片是否为二维码（公众号引导关注 / 尾部引流二维码）。
 * 采用 jsQR 解码 QR Code：能解码出内容即判定为二维码。
 *
 * 保守原则：任何解码失败（格式不支持、图片过大、非二维码等）一律返回 false，不误删。
 */

const jsQR = require('jsqr');

// 图形库只在进入深度解码时才加载，普通文章（无候选图）不付出加载成本。
let jimpLib = null;
function loadJimp() {
  if (!jimpLib) jimpLib = require('jimp');
  return jimpLib;
}

// 解码上限：过大的图跳过（二维码通常较小，超限基本不是二维码，且解码开销大）
const MAX_DIMENSION = 1600;
const MAX_BYTES = 4 * 1024 * 1024; // 4MB

/** 读取图片 magic bytes，识别真实格式（不依赖扩展名） */
function sniffFormat(buffer) {
  if (!buffer || buffer.length < 12) return 'unknown';
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  // WebP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'webp';
  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  return 'unknown';
}

/** 对一张已解码的 RGBA 位图执行 jsQR 解码（尝试多种尺寸/反色） */
/** jsQR 返回结果但 data 为空串时属误报：真实二维码必然编码了非空内容（URL / 文本） */
function isDecoded(result) {
  return !!result && typeof result.data === 'string' && result.data.trim().length > 0;
}

function decodeRgba(rgba, width, height) {
  // jsQR 对 600-1000px 的二维码识别率最高。
  // 较小图（如公众号底部二维码图裁剪后 320x320）模块像素少，定位精度不够 → 先放大
  let data = rgba;
  let w = width;
  let h = height;
  if (Math.max(w, h) < 600) {
    const scale = 800 / Math.max(w, h);
    w = Math.max(100, Math.round(w * scale));
    h = Math.max(100, Math.round(h * scale));
    const resized = nearestResize(rgba, width, height, w, h);
    if (resized) data = resized.data;
  }

  let result = jsQR(data, w, h, { inversionAttempts: 'attemptBoth' });
  if (isDecoded(result)) return true;

  // 原图过大时缩放到合适尺寸再试（提高识别率）
  if (w > 1000 || h > 1000) {
    const scale = 800 / Math.max(w, h);
    const w2 = Math.max(100, Math.round(w * scale));
    const h2 = Math.max(100, Math.round(h * scale));
    const canvas = nearestResize(data, w, h, w2, h2);
    if (canvas) {
      result = jsQR(canvas.data, w2, h2, { inversionAttempts: 'attemptBoth' });
      if (isDecoded(result)) return true;
    }
  }
  return false;
}

/** 用最近邻采样把 RGBA 缩放为 w2*h2，返回 { data: Uint8ClampedArray } 或 null */
function nearestResize(rgba, width, height, w2, h2) {
  if (w2 <= 0 || h2 <= 0) return null;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / h2));
    for (let x = 0; x < w2; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / w2));
      const si = (sy * width + sx) * 4;
      const di = (y * w2 + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out };
}

/** 从 RGBA 中裁剪子区域 (x,y,w,h) */
function cropRgba(rgba, width, _height, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * width + (x + xx)) * 4;
      const di = (yy * w + xx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/**
 * 公众号二维码图常见版式：
 *  - 横向长条（宽高比≈2:1）："左半二维码 + 右半文字"，二维码在左/右半。
 *  - 竖向长条（高宽比≈1.5-2.5）：引导关注 banner，二维码可能在顶部/中部/底部任意位置。
 * 直接对整图解码会被文字/装饰干扰失败，需裁剪"正方形子区域"尝试，最后用滑动窗口兜底。
 */
function decodeWithRegionFallback(rgba, width, height) {
  if (decodeRgba(rgba, width, height)) return true;

  // 横向长条（宽高比 > 1.3）：二维码常在左半或右半，裁剪正方形区域
  if (width > height * 1.3) {
    const side = height;
    if (side >= 200) {
      // 左半正方形
      if (decodeRgba(cropRgba(rgba, width, height, 0, 0, side, side), side, side)) return true;
      // 右半正方形
      if (decodeRgba(cropRgba(rgba, width, height, width - side, 0, side, side), side, side)) return true;
    }
  }
  // 竖向长条（高宽比 > 1.3）：二维码常在上半或下半
  else if (height > width * 1.3) {
    const side = width;
    if (side >= 200) {
      if (decodeRgba(cropRgba(rgba, width, height, 0, 0, side, side), side, side)) return true;
      if (decodeRgba(cropRgba(rgba, width, height, 0, height - side, side, side), side, side)) return true;
    }
  }
  return false;
}

/**
 * 滑动窗口兜底：二维码可能出现在长图（竖版 banner）的任意位置，
 * 用多个尺寸的正方形窗口扫描整图，逐个裁剪解码。
 */
function decodeWithSlidingWindow(rgba, width, height) {
  if (decodeWithRegionFallback(rgba, width, height)) return true;

  // 窗口尺寸从大到小尝试（二维码通常是图中较大的方块）
  const sizes = [Math.min(width, height, 600), Math.min(width, height, 460), Math.min(width, height, 340)];
  for (const win of sizes) {
    if (win < 120) continue;
    const step = Math.max(40, Math.floor(win / 2));
    for (let y = 0; y + win <= height; y += step) {
      for (let x = 0; x + win <= width; x += step) {
        if (decodeRgba(cropRgba(rgba, width, height, x, y, win, win), win, win)) return true;
      }
    }
  }
  return false;
}

/**
 * 判断图片 Buffer 是否为二维码
 * @param {Buffer} buffer 图片二进制
 * @param {string} ext 扩展名（jpeg/png/gif/bmp 等）
 * @param {boolean} verbose 是否打印诊断日志
 * @returns {Promise<boolean>}
 */
async function isQrCode(buffer, ext, verbose = false) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.length > MAX_BYTES) return false;
  // 动图(gif)不可能是静态二维码图，直接跳过
  if (ext === 'gif') return false;

  const real = sniffFormat(buffer);
  if (real === 'gif') return false;
  // jimp 不支持 webp：命中即视为无法确认，保守保留（并记录）
  if (real === 'webp') {
    if (verbose) console.log('      [二维码检测] 格式=webp（jimp 不支持，保守保留）');
    return false;
  }

  try {
    const image = await loadJimp().read(buffer);
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    if (!width || !height) return false;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;

    const rgba = new Uint8ClampedArray(image.bitmap.data);
    return decodeWithSlidingWindow(rgba, width, height);
  } catch (e) {
    if (verbose) console.log('      [二维码检测] 解码异常:', e.message);
    return false;
  }
}

/**
 * 版式预筛：判断一张图是否「可能是二维码图」。
 * 只有命中以下版式才做后续 jsQR 深度解码，其余（普通照片比例）直接跳过：
 *   - 横向长条 banner（宽高比 ≥ 1.3）：公众号引导关注 / 咨询师卡片等
 *   - 竖向长条 banner（宽高比 ≤ 1/1.3 ≈ 0.77）：竖版引导关注长图
 *   - 接近正方形（宽高比 0.8～1.25）：二维码本体通常是正方形
 * 4:3、3:2、16:9 等普通照片比例被跳过，既降低开销，也避免把正文配图/截图误判为二维码。
 * 预筛用估算尺寸（data-w / data-ratio），在 Jimp 解码前即可完成，几乎零成本。
 */
function isCandidateQrImage(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  if (ratio >= 1.3) return true;                 // 横向长条 banner
  if (ratio <= 1 / 1.3) return true;             // 竖向长条 banner
  if (ratio >= 0.8 && ratio <= 1.25) return true; // 接近正方形
  return false;                                   // 普通照片比例，跳过
}

/**
 * 识别并删除文章中的二维码图片（原地修改 blocks）。
 * 遍历全文所有图片：先用版式预筛（isCandidateQrImage）过滤掉普通照片，
 * 再对候选图做 jsQR 深度解码；确认是二维码才删除。
 * 保守原则：无法确认是二维码的（解码失败/非二维码）一律保留。
 *
 * @param {Array} blocks 文章块数组（image 块需已含 buffer/ext）
 * @returns {Promise<void>}
 */
async function removeQrCodes(blocks) {
  // 打印所有图片块概况，便于排查
  console.log(`[二维码检测] 共 ${blocks.length} 块，全量遍历图片`);
  const candidates = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'image') continue;
    const h = b.ratio ? Math.round(b.width * b.ratio) : 0;
    const cand = isCandidateQrImage(b.width, h);
    console.log(
      `  [图] idx=${i} w=${b.width} h=${h || '?'} 候选=${cand ? '是' : '否'} ext=${b.ext} src=${(b.src || '').slice(0, 90)}`
    );
    if (b.buffer && cand) candidates.push(i);
  }

  let checked = 0;
  for (const i of candidates) {
    const b = blocks[i];
    checked++;
    const real = sniffFormat(b.buffer);
    const qr = await isQrCode(b.buffer, b.ext, true);
    console.log(
      `[二维码检测] idx=${i} ext=${b.ext} 实际=${real} 尺寸=${b.width}x${b.ratio ? Math.round(b.width * b.ratio) : '?'} 结果=${qr ? '是二维码→删除' : '否'} src=${(b.src || '').slice(0, 80)}`
    );
    if (qr) {
      b.type = 'deleted';
      b.label = '二维码图片';
      b.text = (b.src || '').slice(0, 80);
      b.buffer = null;
      b.ext = null;
      console.log(`  [二维码图片已删除] ${b.src}`);
    }
  }
  console.log(`[二维码检测] 候选图 ${candidates.length} 张，已深度检测 ${checked} 张`);
}

module.exports = { isQrCode, isCandidateQrImage, removeQrCodes };
