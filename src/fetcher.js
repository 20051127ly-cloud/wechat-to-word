'use strict';

/**
 * 微信文章抓取模块
 * 负责：抓取文章 HTML、下载图片资源
 */

const { readImageSize } = require('./imageSize');
const DEFAULT_TIMEOUT_MS = 20000;

// 图形库只在真正需要转码时才加载，避免为「读尺寸」付出启动成本。
let jimpLib = null;
function loadJimp() {
  if (!jimpLib) jimpLib = require('jimp');
  return jimpLib;
}

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function buildHeaders() {
  return {
    'User-Agent': UA_MOBILE,
    Referer: 'https://mp.weixin.qq.com/',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
}

function resourceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function fetchResource(url, kind, bodyMethod, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const label = kind === 'IMAGE' ? '图片下载' : '文章抓取';
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = resourceError(`${kind}_TIMEOUT`, `${label}超时（${timeoutMs}ms）`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const res = await fetch(url, {
        headers: buildHeaders(),
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok) {
        const error = resourceError(`${kind}_HTTP_ERROR`, `${label}失败：HTTP ${res.status} ${res.statusText || ''}`.trim());
        error.status = res.status;
        throw error;
      }
      return res[bodyMethod]();
    })();
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith(`${kind}_`)) throw error;
    throw resourceError(`${kind}_NETWORK_ERROR`, `${label}失败：${error.message || '网络连接异常'}`, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取文章 HTML
 * @param {string} url 文章链接
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<string>} HTML 文本
 */
async function fetchArticle(url, options = {}) {
  const html = await fetchResource(url, 'ARTICLE', 'text', options);

  // 校验是否成功拿到文章内容
  if (html.includes('环境异常') || html.includes('访问过于频繁') || html.includes('请在微信客户端打开')) {
    throw new Error('抓取被微信拦截，请稍后重试或换一篇再试');
  }
  if (!html.includes('js_content')) {
    throw new Error('未识别到文章正文，链接可能无效');
  }

  return html;
}

/**
 * 补全图片 URL（协议相对地址 → 完整 https 地址）
 */
function normalizeImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return url.replace('http://', 'https://');
  return url;
}

/**
 * 检测图片是否为动图（GIF 多帧 / WebP 动画）
 * 依据文件头 magic bytes 判断，不依赖扩展名
 * @param {Buffer} buffer 图片数据
 * @param {string} ext 扩展名（辅助判断）
 * @returns {boolean}
 */
function detectAnimated(buffer, ext) {
  if (!buffer || buffer.length < 16) return false;

  // GIF：GIF87a / GIF89a
  const isGif =
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
    buffer[3] === 0x38 && (buffer[4] === 0x39 || buffer[4] === 0x37) && buffer[5] === 0x61;
  if (isGif || ext === 'gif') {
    // 统计 Graphic Control Extension(0x21 0xF9)：动图每帧一个，≥2 个视为动图
    let gce = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9) {
        gce++;
        if (gce >= 2) return true;
      }
    }
    return false;
  }

  // WebP：RIFF....WEBP，动图含 ANIM chunk
  const isWebp =
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  if (isWebp || ext === 'webp') {
    return buffer.indexOf(Buffer.from('ANIM')) !== -1;
  }

  if (sniffImageFormat(buffer) === 'png') {
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (offset + length + 12 > buffer.length) break;
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL' && length >= 8) {
        return buffer.readUInt32BE(offset + 8) > 1;
      }
      offset += length + 12;
    }
  }
  return false;
}

/** 图片格式只以文件签名为准，不信任 URL 和 Content-Type。 */
function sniffImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (buffer.length >= 4 && (buffer.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || buffer.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))) return 'tiff';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'heif/avif';
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buffer.toString('utf8', 0, 512))) return 'svg';
  return 'unknown';
}

/**
 * 下载并验证图片；可转换的非 PNG/JPEG 静图统一输出合法 PNG。
 * animated=true 时保留原始格式供上层删除，不应嵌入 Word。
 * @param {string} url
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<{buffer: Buffer, ext: string, animated: boolean, width: number, height: number, sourceExt: string}>}
 */
async function fetchImage(url, options = {}) {
  const full = normalizeImageUrl(typeof url === 'string' ? url.trim() : '');
  if (!full) throw resourceError('IMAGE_INVALID_URL', '图片地址为空');
  let parsedUrl;
  try {
    parsedUrl = new URL(full);
  } catch (error) {
    throw resourceError('IMAGE_INVALID_URL', '图片地址无效', error);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw resourceError('IMAGE_INVALID_URL', '图片地址仅支持 HTTP/HTTPS');
  }

  let buffer = Buffer.from(await fetchResource(full, 'IMAGE', 'arrayBuffer', options));
  const sourceExt = sniffImageFormat(buffer);
  if (sourceExt === 'unknown') {
    throw resourceError('IMAGE_INVALID_DATA', '图片数据无效：无法识别图片文件签名');
  }
  const animated = detectAnimated(buffer, sourceExt);
  const size = readImageSize(buffer, sourceExt);
  if (animated) {
    if (!size) throw resourceError('IMAGE_INVALID_DATA', '图片数据损坏：无法读取动画尺寸');
    return { buffer, ext: sourceExt, animated, width: size.width, height: size.height, sourceExt };
  }
  if (!['png', 'jpeg', 'gif', 'bmp', 'tiff'].includes(sourceExt)) {
    throw resourceError('IMAGE_UNSUPPORTED', `不支持的图片格式：${sourceExt}，当前图片解码器无法转换为 PNG`);
  }

  // PNG / JPEG 可直接嵌入 Word：尺寸从文件头读取，无需解码像素。
  if (sourceExt === 'png' || sourceExt === 'jpeg') {
    if (!size) throw resourceError('IMAGE_INVALID_DATA', `图片数据损坏：无法读取图片尺寸（${sourceExt}）`);
    return { buffer, ext: sourceExt, animated: false, width: size.width, height: size.height, sourceExt };
  }

  // GIF / BMP / TIFF 静图需转码为 PNG，只有这条路径才会加载图形库。
  try {
    const Jimp = loadJimp();
    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('图片尺寸无效');
    }
    buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    return { buffer, ext: 'png', animated: false, width, height, sourceExt };
  } catch (error) {
    throw resourceError('IMAGE_INVALID_DATA', `图片数据损坏或解码失败（${sourceExt}）：${error.message}`, error);
  }
}

module.exports = { fetchArticle, fetchImage, normalizeImageUrl, detectAnimated };
