'use strict';

const copyrightKeywords = require('./copyrightKeywords.json');

function normalizeRiskText(text) {
  return String(text || '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/gu, '').toLowerCase();
}

function containsCopyright(text) {
  const normalized = normalizeRiskText(text);
  return copyrightKeywords.some((keyword) => normalized.includes(normalizeRiskText(keyword)));
}

/**
 * 文末标注的头图/封面/题图/首图片名：「头图/封面 《我，到点下班》」
 * 片名会被提取到文章开头图片后作为图注（见 parser.extractHeadImageCredit）。
 */
const HEAD_IMAGE_CREDIT_RE =
  /^(?:头图|封面图?|题图|首图)(?:[\/及和、,，]*(?:头图|封面图?|题图|首图))*\s*[：:]?\s*(《[^》]+》)\s*$/;

function isCaptionText(text) {
  const t = (text || '').trim();
  return /^(图片来源|题图来源|图源|图片|图\s*[\/|｜丨]|▲|△)/.test(t) ||
    (/©|ⓒ/.test(t) && t.length <= 30) ||
    // 文末图片来源声明（「头图、封面图及配图来自文中人物。」），不依赖是否紧跟图片。
    // 「除剧照外…由作者提供」这类以连词开头的豁免说明不在此列，仍按正文保留。
    /^(头图|封面图?|题图|配图|文中配图|文章配图|图片说明)[、，,]?[^。！？]{0,30}(?:来自|来源|由|提供|摄影|摄)[^。！？]{0,15}[。！]?$/.test(t) ||
    // 文末标注头图/封面片名（「头图/封面 《我，到点下班》」「封面及首图 《我的姐姐》」）
    HEAD_IMAGE_CREDIT_RE.test(t);
}

function isCaptionCandidate(text, { afterImage = false, style = {} } = {}) {
  const t = (text || '').trim();
  if (!t || containsCopyright(t)) return false;
  if (t.length < 2) return false; // 单字（如署名行被拆剩的「文」）不构成图注
  if (isCaptionText(t)) return true;
  if (!afterImage || t.length > 60 || /^[一二三四五六七八九十\d]+$/.test(t)) return false;
  if (/^[\d一二三四五六七八九十]+[、．.]/.test(t)) return false;
  if (/^(?:拍摄|摄影|供图)\s*[：:｜|]/.test(t)) return true;
  if (/^《[^》]+》$/.test(t) || /^\*《[^》]+》[\u4e00-\u9fffA-Za-z0-9\s,，。·]{0,20}$/.test(t)) return true;
  if (/[！？?!]$/.test(t)) return false;
  // 叙述和转折不能仅凭图片邻接关系改成图注。
  const narrative = /^(?:但|而|可是|不过|所以|因此|如果|因为|虽然|这时|那时|随后|后来|今天|明天|第二天|这是一|那是一|故事|他|她|它|我|你|我们|他们|她们)/.test(t);
  if (narrative) return false;
  // 小字号 + 居中/非黑是「辅助信号」：图片说明性的小字段落几乎不会以句号结尾，
  // 用「无句末标点」排除图片后的普通导语（完整句子），比限死长度更准——
  // 「2025年5月6日，瑞士，熊羽诺与教授交流学术问题」这类 30+ 字图注才不会漏判。
  const visual = style.fontSize != null && style.fontSize <= 14 && t.length <= 60
    && !/[。！？!?]$/.test(t)
    && (style.color && style.color !== '000000' || style.alignment === 'center');
  const shortPhrase = t.length >= 2 && t.length <= 20 && !/[。！？…；，、,：:]/.test(t);
  const shortLabel = t.length <= 12 && /^[\u4e00-\u9fffA-Za-z·\s]+。?$/.test(t);
  const description = t.length >= 8 && t.length <= 45 && !/[。！？…；：:]/.test(t) && (t.match(/[，,]/g) || []).length <= 1;
  return shortPhrase || shortLabel || description || !!visual;
}

function normalizeCaptionText(text) {
  return (text || '').replace(/(\S)(?=(?:图源|图片来源|供图)\s*[^，。；;]{0,20}$)/, '$1 ').trim();
}

function classifyCaptions(blocks) {
  return blocks.map((block, index) => {
    if (block.type !== 'paragraph' || block.postEndNote) return block;
    if (!isCaptionCandidate(block.text, { afterImage: index > 0 && blocks[index - 1].type === 'image', style: block.style })) return block;
    return { ...block, type: 'caption', text: normalizeCaptionText(block.text) };
  });
}

module.exports = {
  containsCopyright,
  isCaptionText,
  isCaptionCandidate,
  normalizeCaptionText,
  classifyCaptions,
  HEAD_IMAGE_CREDIT_RE,
};
