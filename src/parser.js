'use strict';

/**
 * 微信文章解析模块
 * 递归遍历正文，扁平化为结构化块（标题/段落/图片/图注/参考文献/噪声）
 */

const cheerio = require('cheerio');
const { containsCopyright, isCaptionText, isCaptionCandidate, normalizeCaptionText, classifyCaptions, HEAD_IMAGE_CREDIT_RE } = require('./articleRules');
const { nodeStyle, extractTextFormat, sameHeadingStyle } = require('./textStyle');

/**
 * 清洗文本：把会导致 Word 乱码的特殊空白/不可见字符转为正常字符
 * - \u00A0（&nbsp; 不间断空格）在宋体中渲染成波浪号/方块 → 转普通空格
 * - 零宽字符、BOM 等 → 删除
 */
function cleanText(text) {
  if (!text) return text;
  return text
    .replace(/\u00A0/g, ' ') // 不间断空格 → 普通空格
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '') // 零宽字符、BOM → 删除
    .replace(/\u2028|\u2029/g, ' '); // 行分隔符 → 空格
}

// 内联标签：这些标签内的文本应与相邻文本合并为同一段落，不单独换行
// （微信文章常用 <strong>/<span> 实现「部分文字加粗/变色」，不应被拆成多段）
const INLINE_TAGS = new Set([
  'span', 'strong', 'b', 'em', 'i', 'u', 'a', 'font', 'label', 'sub', 'sup',
  'small', 'big', 'code', 's', 'del', 'ins', 'abbr', 'cite', 'q', 'mark', 'time',
]);

// 媒体选择器：段落内遇到媒体时断开（图片/视频/音频单独成块，不并入正文文本）
const MEDIA_SELECTOR = 'img, video, mp-common-videosnap, mpvoice, [data-mpvid], [voice_encode_fileid]';

// 噪声关键词分类
// - keywords（强信号）：任何位置命中即整段删除
// - weakKeywords（弱信号）：仅在「段长 ≤ 40 字」的短段才删
// - segmentKeywords（段位关键词）：必须出现于「段首或段尾」才命中，
//   用于"相关推荐 / 相关阅读 / 推荐阅读 / 点击图片跳转"这类公众号文末固定话术。
//   也要求段长 ≤ 40 字；正文里偶然提到通常位于中段且段落较长，不会被误删。
const NOISE_RULES = [
  {
    type: '顶部二维码',
    keywords: [
      '扫码关注', '长按识别二维码', '点击上方', '点击蓝字', '星标', '标星',
      // 不使用单独的「置顶」：正文常写「朋友圈置顶」，会误判为二维码引导
      '置顶公众号', '置顶本号',
      // 文末「请长按下方图片 / 识别二维码关注」引导（洞见等公众号文末固定模板）
      '请长按下方图片',
      '识别二维码关注',
      '识别二维码 关注',
      '看更多走心好文章',
      '长按图片识别',
      '长按二维码关注',
      // 「星标关注《XX》微信公号 / 精彩故事永不错过」这类引导的第二行
      '永不错过', '永不失联',
    ],
  },
  {
    // 音频播放引导（洞见等公众号开头/文中的「点上方播放按钮可收听…朗读音频」提示，无正文价值）
    type: '音频播放引导',
    keywords: [
      '点上方播放按钮',
      '点下方播放按钮',
      '点上方绿标',
      '点下方绿标',
      '播放按钮可收听',
      '朗读音频',
      '点击收听',
      '点此收听',
    ],
  },
  {
    // 公众号关注引导（文章开头的「洞见（DJxxxxxx）——不一样的观点...点击标题下蓝字"洞见"关注...」类头部介绍）
    type: '公众号关注引导',
    keywords: [
      '不一样的观点，不一样的故事',
      '万人订阅的微信大号',
      '为您提供有价值、有意思的延伸阅读',
      '点击标题下蓝字',
      '不一样的视角，不一样的故事',
      '不一样的观点，一样的故事',
    ],
  },
  {
    type: '底部推广',
    keywords: [
      // 强信号（已移除"点赞/在看/招聘/转发/欢迎使用/立减"等易误删的宽泛词）
      '合作请联系', '商务合作', '菜单栏', '搜索文章', '转载',
      '预约咨询', '在线咨询',
      '点亮红心', '点点小红心', '侵权必究',
      // 文末「在看」引导为明确强信号
      '点个在看', '点亮在看',
      '微信又双叒叕', '都看到这里啦', '请戳', '本文关键词', '欢迎大家在',
      '购买测试', '限时优惠', '侵权请联系',
      // 公众号文末版权/原创声明（"公众号原创文章归XX版权所有"等，不应算正文）
      '版权所有', '版权归', '公众号原创文章', '原创文章归',
      // 公众号文末「阅读原文」固定链接区
      '点击阅读原文',
      // 网易人间工作室等文末固定合作说明/头图声明/投稿邀稿（特征词极独特，正文几乎不会出现）
      '本文头图选自',     // 头图来源声明
      '特此声明',          // 文末声明
      '稿件一经刊用',      // 投稿稿酬说明
      '投稿人间栏目',      // 网易人间「人间」栏目投稿
      '投稿戏局栏目',      // 网易人间「戏局」栏目投稿
      '欢迎于微信后台',    // 文末合作联系方式
      // emoji 引导符（修复"👆点击开始免费测试"等漏删）；⬆️⬇️ 为 emoji 粗箭头（U+2B07）
      '👆', '👇', '⬆', '⬇', '⬆️', '⬇️',
    ],
    patterns: [
      // 文末原创声明：「文章为每日人物原创」「本文为XX原创」
      // 不用「原创」做关键词——正文常说「原创设计」「原创歌曲」，会误删。
      /^(?:文章|本文|本篇)为[^\s，。；、]{1,15}原创[。！!]?$/,
    ],
    weakKeywords: [
      // 弱信号：长段（> 40 字）跳过，短段才删（保护正文）
      '点亮', '小红心', '红心',
      // 这些词也可能出现在正常正文，仅在短段时才视为推广引导
      '小程序', 'APP下载', '下载App', '分享到朋友圈', '欢迎大家在',
      // 文末「你若喜欢，为xxx点个♡哦」点赞引导（高度特征化，正文几乎不出现）
      '为洞见点个', '点个♡', '点个❤', '为我们点个',
    ],
    segmentKeywords: [
      // 段位关键词：必须出现于「段首或段尾」、段长 ≤ 40 字才命中
      // 例：「相关推荐，点击图片跳转：猛戳这里看更多」→ 段首/段尾有匹配 → 删
      //     「本期为大家介绍相关推荐算法」→ 关键词在中段 → 保留
      '相关推荐', '相关阅读', '推荐阅读', '点击图片跳转',
      // 文末图书/商品推广行（「《人物》「时间的力量」系列图书」「点击图片购买↓↓↓」）。
      // 「系列图书」放段位匹配而非关键词包含，避免「他出版了一系列图书」这类正文被误删。
      '系列图书', '点击图片购买', '点击购买', '扫码购买',
    ],
  },
  {
    // 文末结束符（真实故事计划等公众号文末固定标记，如 -END- / —END— / · END · 等）
    // 这类符号本身是纯装饰性标记，不是正文，加粗后易被误识别为小标题，需提前拦截
    type: '文末结束符',
    keywords: [
      '-END-', '- END -', '—END—', '— END —', '·END·', '· END ·',
      '-end-', '- end -', '—end—', '— end —',
      '【END】', '【end】',
    ],
  },
  {
    type: '留言互动区',
    keywords: ['今日互动', '每人互动', '你怎么看', '欢迎留言', '写留言', '互动话题'],
    // 「留言区」「评论区」是正文高频词（如「在她的社交网络评论区，至今仍有…」），
    // 包含匹配会误删正文。改为段首/段尾弱信号：仅短段且出现在段首或段尾才删
    //（真正的互动引导如「评论区聊聊」「去留言区看看」）。
    segmentKeywords: ['留言区', '评论区'],
  },
  {
    // 文末营销话术（早鸟优惠 / 扫描二维码 / 添加顾问 / 赠送价值 等）
    // 命中即视为已进入文末：其后续图片（海报/二维码）也会被丢弃
    type: '文末营销',
    keywords: [
      '早鸟优惠', '早鸟报名', '早鸟价', '早鸟票',
      '扫描下方二维码', '扫描二维码', '扫码了解', '扫码咨询', '扫码领取', '扫码报名', '扫码领',
      '添加顾问', '添加老师', '顾问老师', '咨询顾问', '咨询老师', '咨询报名',
      '赠送价值', '报名享', '报名从速', '报名通道', '报名优惠', '立省', '领福利', '抢购',
      '点击下方', '戳下方', '戳这里', '下方二维码', '了解详情', '详情咨询',
      '限时折扣', '优惠名额', '优惠仅剩', '优惠倒计时',
      // 新增：修复"点击开始免费测试"等漏删
      '点击开始', '点击参与', '点击领取', '点击报名',
      '免费测试', '免费测评', '免费评估', '免费试听',
      '立即参与', '立即领取', '限时免费',
      '戳链接', '戳我', '戳图片',
      // 「简单心理」平台文末固定营销：仅保留平台强特征词，避免误删正文
      '预约简单心理',
      '低价心理咨询',
      '咨询收费',
      '限额一次预约',
    ],
  },
];

function findNoiseType(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const longSeg = t.length > 40;
  for (const rule of NOISE_RULES) {
    if (rule.type === '文末结束符' && !isArticleEndMarker(t)) continue;
    for (const kw of rule.keywords || []) {
      if (t.includes(kw)) return rule.type;
    }
    // 正则规则：用于「文章为XX原创」这类需要形态约束、无法用固定词命中/排除的噪声
    for (const pattern of rule.patterns || []) {
      if (pattern.test(t)) return rule.type;
    }
    // 段位关键词：段首或段尾命中，且长段跳过（保护正文）
    if (!longSeg && Array.isArray(rule.segmentKeywords)) {
      for (const kw of rule.segmentKeywords) {
        if (t.startsWith(kw) || t.endsWith(kw)) return rule.type;
      }
    }
    // 弱信号：长段跳过，短段才删
    if (longSeg) continue;
    for (const kw of rule.weakKeywords || []) {
      if (t.includes(kw)) return rule.type;
    }
  }
  return null;
}

function isAllBold($, el) {
  return extractTextFormat($, el).style.boldRatio >= 0.85;
}

function extractMaxFontSize($, el) {
  return extractTextFormat($, el).style.fontSize;
}

function extractMinLeafFontSize($, el) {
  return extractTextFormat($, el).style.minFontSize ?? Infinity;
}

/** 判断元素内文字是否为红色/橙红强调色（正文强调句，非标题） */
function hasAccentColor($, el) {
  let accent = false;
  const scan = (node) => {
    if (accent) return;
    const style = $(node).attr('style') || '';
    const m = style.match(/color\s*:\s*rgba?\(([^)]*)\)/i);
    if (m) {
      const parts = m[1].split(',').map((s) => parseInt(s.trim(), 10));
      const r = parts[0] || 0;
      const g = parts[1] || 0;
      const b = parts[2] || 0;
      if (r > 100 && r > g + 30 && r > b + 30) accent = true;
    }
    $(node)
      .children()
      .each((i, c) => scan(c));
  };
  scan(el);
  return accent;
}

/**
 * 检测容器内文字是否为白色/浅色（用于识别印在深色背景图上的横幅标题）。
 * 此类标题文字颜色通常为 rgb(255,255,255)，而正文多为深灰（如 rgb(62,62,62)）。
 */
function isWhiteText($, el) {
  let white = false;
  const scan = (node) => {
    if (white) return;
    const style = $(node).attr('style') || '';
    const m = style.match(/color\s*:\s*rgba?\(([^)]*)\)/i);
    if (m) {
      const parts = m[1].split(',').map((s) => parseInt(s.trim(), 10));
      const r = parts[0] || 0;
      const g = parts[1] || 0;
      const b = parts[2] || 0;
      if (r > 230 && g > 230 && b > 230) white = true;
    }
    $(node).children().each((i, c) => scan(c));
  };
  scan(el);
  return white;
}

/** 检测容器自身或近祖先是否有背景图（background-image） */
function hasBackgroundImage($, el) {
  let cur = el;
  for (let i = 0; i < 4; i++) {
    const style = $(cur).attr('style') || '';
    if (/background-image\s*:\s*url\(/i.test(style)) return true;
    const p = $(cur).parent()[0];
    if (!p || p.tagName === 'html') break;
    cur = p;
  }
  return false;
}

/**
 * 判断一个容器（section/div/h1-h6）整体是否是一个标题。
 * 标题特征：无媒体、短文本（≤40字）、整体加粗。
 * - 字号：仅排除极小字（<13px），不对字号做上限要求；
 *   不同账号小标题字号差异大，靠加粗 + 格式一致性后处理兜底。
 * - 标点：仅拒绝句号结尾（完整陈述句），问号/感叹号均允许。
 * - 颜色：不限制强调色；账号可能整批用彩色做小标题，
 *   依赖「≥2 个 + 格式一致」的后处理过滤单个误判。
 * 命中后应整体输出，不再递归拆散（解决标题被内部多个 span 拆散的问题）。
 */
function isHeadingContainer($, el) {
  if (containsCopyright($(el).text()) || isCaptionText($(el).text()) || stripSlideHints($(el).text()).trim() === '') return false;
  // 视频/音频：标题不可能是音视频，直接排除
  if ($(el).find('video, mp-common-videosnap, mpvoice, [data-mpvid], [voice_encode_fileid]').length > 0) return false;
  // 图片：允许「极扁装饰线」（ratio < 0.3，walk 阶段本就不会进 Word），
  // 但若含正文配图（ratio ≥ 0.3），说明这不是纯标题容器，仍排除。
  const imgs = $(el).find('img');
  for (let i = 0; i < imgs.length; i++) {
    const ratio = parseFloat($(imgs[i]).attr('data-ratio') || '0.75');
    if (ratio >= 0.3) return false;
  }
  const t = cleanText($(el).text()).trim();
  // 标题至少一个字符；单字标题仍需通过加粗、字号及全文格式一致性等后续校验。
  if (t.length < 1 || t.length > 40) return false;
  // 投稿署名（@网友名，如 @匿名 / @liz / @Rebecca🍃）单独成行时是署名不是小标题。
  if (/^@/.test(t)) return false;
  // 噪声文本（文末营销/互动引导等）交由 processTextBlock 统一删除，不提前识别为标题。
  if (findNoiseType(t)) return false;
  // 作者信息区署名行、图片来源署名（如「图｜受访者供图」「图｜张三」）不是标题。
  if (BYLINE_PREFIX_RE.test(t) || PHOTO_CREDIT_LOOSE_RE.test(t)) return false;
  // 句号结尾视为完整陈述句，不是标题；问号/感叹号均允许。
  // 例外：被中文引号完整包裹的居中加粗短句（引言块），允许句号结尾。
  const isQuoted = /^“.*”$/.test(t) || /^".*"$/.test(t) || /^「.*」$/.test(t) || /^『.*』$/.test(t);
  if (!isQuoted && /[。]/.test(t)) return false;
  if (!isAllBold($, el)) return false;
  // 字号双重检查：
  //   1) 最大字号 < 13px → 极小文字，需白字+背景图才放行
  //   2) 最小叶子字号 < 14px → 内层文字实际渲染为小字，即便外层容器声明了大字号也不算标题
  //      （例：<strong style="17px"><span style="12px">…</span></strong>，叶子 12px < 14 → 排除）
  const minLeaf = extractMinLeafFontSize($, el);
  if (minLeaf < 14) return false;
  const maxSize = extractMaxFontSize($, el);
  if (maxSize != null && maxSize < 13) {
    if (!(isWhiteText($, el) && hasBackgroundImage($, el))) return false;
  }
  return true;
}

/**
 * 署名区中的图片来源行（如「图｜受访者供图」「图｜（除特殊标注外）记者提供」）。
 *
 * 写法差异很大，因此分两层判定，并统一由位置护栏保护图注：
 *   1. PHOTO_CREDIT_BYLINE_RE：以「图 + 分隔符」开头，且整行以来源类词收尾 —— 可独立成立。
 *   2. PHOTO_CREDIT_LOOSE_RE：以「图 + 分隔符」开头的短行（来源写法未穷尽，如「图｜张三」
 *      「图｜东方IC」），仅在紧邻其他署名行时才按署名区处理。
 * 位置护栏：紧跟在图片之后的同类文字一律视为图注，不走署名区（见 processTextBlock）。
 */
// 图片来源署名的分隔符：丨 | ｜ / ： :
const PHOTO_CREDIT_SEP = '丨|｜/:：';
// 来源类收尾词（供图/摄影/授权 等），用于无需上下文即可确认的署名行
const PHOTO_CREDIT_SOURCE_WORDS = '供图|提供|摄影|摄制|拍摄|拍摄者|摄|配图|图源|来源|授权';
const PHOTO_CREDIT_BYLINE_RE = new RegExp(
  `^图\\s*[${PHOTO_CREDIT_SEP}]\\s*(?:[（(][^）)]{0,30}[）)])?\\s*[^，。；;！？]{0,15}(?:${PHOTO_CREDIT_SOURCE_WORDS})\\s*$`
);
// 宽松形态：只要求「图 + 分隔符 + 短内容」，覆盖来源写法未穷尽的情况
const PHOTO_CREDIT_LOOSE_RE = new RegExp(
  `^图\\s*[${PHOTO_CREDIT_SEP}]\\s*(?:[（(][^）)]{0,30}[）)])?\\s*[^，。；;！？]{1,20}$`
);

/**
 * 作者信息区署名行的前缀（「文 | 许峥」「编辑 | Yang」「运营 | 歪歪」）。
 * 必须紧跟分隔符才算署名，避免吃掉「运营一家公司」「设计一套方案」这类正文。
 */
const BYLINE_PREFIX_RE =
  /^(?:编辑|作者|采写|文|实习|责编|责任编辑|策划|撰文|整理|出品|运营|主编|监制|校对|排版|制图|设计|摄影)[丨|｜:：\s]/;

/**
 * 判断图注容器：兼容「图片说明 + 小字号图源」合在同一 <p> 的排版。
 * 例如「胡博在西撒哈拉（……）图源受访者」中，末尾“图源受访者”为 12px 子 span。
 * 仅在图源子节点实际为 ≤14px 小字且位于段末时判定，避免普通正文提及“图源”被误伤。
 */
function isCaptionBlock($, el, text) {
  if (isCaptionText(text)) return true;
  const t = (text || '').trim();
  if (!/(?:图源|图片来源|供图)\s*[^，。；;]{0,20}$/.test(t)) return false;

  let hasSmallSourceSuffix = false;
  $(el).find('*').each((i, node) => {
    if (hasSmallSourceSuffix) return;
    const nodeText = $(node).text().trim();
    if (!/(?:图源|图片来源|供图)/.test(nodeText)) return;
    const size = nodeStyle($, node).fontSize;
    if (size != null && size <= 14) hasSmallSourceSuffix = true;
  });
  return hasSmallSourceSuffix;
}

/**
 * 为「图片说明 + 图源」的混排图注补一个可读空格。
 * 例：「胡博的房车停在加州一号公路海岸线上图源受访者」
 *   →「胡博的房车停在加州一号公路海岸线上 图源受访者」。
 */
function normalizeCaptionSourceSpacing(text) {
  return (text || '')
    .replace(/(\S)(?=(?:图源|图片来源|供图)\s*[^，。；;]{0,20}$)/, '$1 ')
    .trim();
}

/** 是否为独立成行、特殊排版的正文结束符。 */
function isArticleEndMarker(text) {
  const t = (text || '').trim();
  return /^(?:【\s*END\s*】|(?:[-—–―－·]\s*){1,3}END\s*(?:[-—–―－·]\s*){1,3}|(?:[—–―－-]\s*){2,}完\s*(?:[—–―－-]\s*){2,})$/i.test(t);
}

/**
 * 删除图片/长图浏览操作提示分句，保留其余文字。
 * 表述并不穷尽，因此按「方向 + 滑动动作 + 查看目标」的结构识别，兼容：
 * 左滑查看更多、可向下滑动查看、下滑查看、⬅️左右滑动查看更多➡️ 等。
 * - 整段仅为提示：返回空串（调用方据此丢弃整段）。
 * - 提示只是句子一部分：连同紧邻的分隔标点和方向箭头一起删除，其余正文/图注保留。
 */
function stripSlideHints(text) {
  const arrow = '[⬅➡↔←→]\\uFE0F?';
  const direction = '(?:左右|上下|(?:向\\s*)?[左右上下])';
  const action = '(?:滑动|划动|滑|划)';
  const view = '(?:查看|观看|浏览|看)\\s*(?:更多|全部|后续)?\\s*(?:图片|图|内容)?';
  const hint = `(?:${arrow}\\s*)*(?:(?:请|可)\\s*)?${direction}\\s*${action}\\s*${view}(?:\\s*${arrow})*`;
  return (text || '')
    .replace(new RegExp(`(?:^|[，,、；;：:]|\\n)\\s*${hint}[。！？!?]?(?=\\s*$|[，,；;])`, 'gmu'), '')
    .trim();
}

/**
 * 是否涉及版权风险图库。
 * 视觉中国、东方 IC、人民视觉等关键词属于最高优先级风险信号：不受文本长度、
 * 图源措辞、参考文献、噪声区或正文结束符影响，命中即保留并在 Word 中标红。
 */
function isCopyrightNotice(text) {
  return containsCopyright((text || '').trim());
}

/**
 * 剥离标题末尾粘连的「@网友名」。
 * 投稿类文章的小标题有时与投稿人署名(@xxx) 被夹在同一个 <h1> 容器里，
 * 导致提取出的标题文本变成「标题@署名」。署名以 @ 开头、其后为名字字符
 * （中英日文/emoji/点号等），不含句末标点与空白；据此安全剥离，避免把署名带进小标题。
 */
function stripTrailingMention(text) {
  if (!text) return text;
  const idx = text.indexOf('@');
  if (idx <= 0) return text;
  const rest = text.slice(idx + 1);
  if (!rest) return text;
  // 署名部分仅由名字字符组成（不含空白、句末标点）
  if (/^[^。！？\s]+$/.test(rest)) {
    return text.slice(0, idx).trim();
  }
  return text;
}

// ==================== 二级标题（小标题）识别 ====================
// 中文数字（一级标题序号常见：一、二、三……十一、十二、二十）
const CN_NUM_CHARS = '一二三四五六七八九十';

/**
 * 识别带序号的「小标题（二级标题）」行。
 * 返回：
 *  - null：不是序号标题（普通标题/正文）
 *  - { level: 2, numType, num, pureNumber, subText }：二级标题
 *  - { level: 3 }：三级标题（多级序号，如 01.1 / 1.1 / 1-1 / 一.1），按正文处理
 *
 * 核心原则「宁缺毋滥」：多级序号判定为三级；仅单级序号才识别为二级。
 */
function parseSubheading(text) {
  const t = (text || '').trim();
  if (!t || t.length > 60) return null;

  // 三级标题：只接受点号或连字符连接的多级序号，如 01.1、1.1、1-1。
  // 顿号「、」只表示一级序号与标题正文的分隔，绝不作为层级连接符，
  // 因此「1、25岁的焦虑」「2、一个床位」「1、2」「2、一」都按一级序号标题处理。
  const multiLevel = new RegExp(
    `^[【\\[(（]?\\s*(?:0*\\d{1,2}|[${CN_NUM_CHARS}]{1,2})\\s*[】\\])）]?\\s*[.\\-－]\\s*(?:\\d{1,2}|[${CN_NUM_CHARS}]{1,2})(?=\\s|[.、．，:：\\-－]|$)`
  );
  if (multiLevel.test(t)) return { level: 3 };

  // 阿拉伯数字序号（支持前导零、包裹符号【】()[]、分隔符 . 、 等）
  const arabic = t.match(/^[【\[(（]?\s*0*(\d{1,2})\s*[】\])）]?\s*[.、．，:：\s]*(.*)$/);
  if (arabic && arabic[1]) {
    const num = String(parseInt(arabic[1], 10)); // 去前导零：01 -> 1
    const rest = (arabic[2] || '').replace(/^[.、．，:：\s]+/, '');
    return { level: 2, numType: 'arabic', num, pureNumber: !rest, subText: rest };
  }

  // 中文数字序号（一、二、三……十一、十二、二十）。
  // 普通中文标题中「一」常是词语的一部分（如「一个小小的分子，改变了世界」），
  // 因此裸中文数字只有三种形式才视为序号：
  //   1) 纯序号「一」；2) 有空格/标点分隔「一 标题」「一、标题」；3) 有包裹符「（一）标题」。
  // 容忍「误解/真相/原因...」等固定类别前缀 + 中文数字（如「误解一」）。
  let body = t;
  const prefixM = body.match(/^(?:误解|真相|原因|误区|问题|观点|要点|错误|常见|建议|总结|结论|核心|关键|重点|提醒|提示|注意|警告|本质|盲区|雷区|陷阱|好处|坏处|优点|缺点)/);
  if (prefixM) body = body.slice(prefixM[0].length);

  // 注意：不在数字后预先吞掉空格；空格本身是「一 标题」作为序号的有效分隔符。
  const chinese = body.match(new RegExp(`^[【\\[(（]?\\s*([${CN_NUM_CHARS}]{1,2})(.*)$`));
  if (chinese && chinese[1]) {
    const num = chinese[1];
    const rawTail = chinese[2] || '';
    const hasWrapper = new RegExp(`^[【\\[(（]\\s*${num}\\s*[】\\])）]`).test(body);
    const tail = hasWrapper ? rawTail.replace(/^\s*[】\])）]\s*/, '') : rawTail;
    const separator = tail.match(/^[.、．，:：\s]+/);
    const rest = separator ? tail.slice(separator[0].length) : tail;
    // 纯序号、带包裹符，或数字后存在明确分隔符时才成立。
    if (!tail || hasWrapper || separator) {
      return { level: 2, numType: 'chinese', num, pureNumber: !rest, subText: rest };
    }
  }

  return null;
}

/** 从一行文本提取作者名 */
function extractAuthor(text) {
  const t = cleanText(text).trim();
  const m = t.match(/^(?:作者|采写|撰文|撰|文)\s*[：:｜|丨/]\s*(.{1,20})$/);
  if (!m) return null;
  let name = m[1].trim();
  name = name.split(/[|｜]/)[0].trim(); // 按竖线分隔防止"饶桐语编辑|张轻松"粘连
  // 再切除「空格 + 角色关键词」（如"何 玥编辑"→"何 玥"，"饶桐语 编辑"→"饶桐语"）
  name = name.replace(/\s+(?:编辑|责编|责任编辑|实习编辑|出品|整理|采写|撰文|作者|策划|摄影|设计|排版).*$/, '').trim();
  name = name.replace(/[。，,；;、].*$/, '').trim();
  name = name.replace(/[（(].*$/, '').trim();
  // 中文姓名字符间可能有微信排版产生的空格（如「何 玥」），去掉相邻中文字符间的空白
  name = name.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2').trim();
  if (!name || name.length > 15) return null;
  return name;
}

/** 从一行文本提取编辑名（编辑/责编/责任编辑/实习编辑等） */
function extractEditor(text) {
  const t = cleanText(text).trim();
  const m = t.match(/^(?:责任编辑|责编|实习编辑|编辑)\s*[：:｜|丨/]\s*(.{1,20})$/);
  if (!m) return null;
  let name = m[1].trim();
  name = name.split(/[|｜\s]/)[0].trim(); // 取第一段，防止"编辑|张轻松 排版|李四"粘连
  name = name.replace(/[。，,；;、].*$/, '').trim();
  name = name.replace(/[（(].*$/, '').trim();
  if (!name || name.length > 15) return null;
  return name;
}

/** 是否为参考文献标记 */
function isReferenceMarker(text) {
  // 兼容「📄 参考文献」「▨ 参考资料」等图标前缀，不把图标视作正文。
  return /^(?:[^\w\u4e00-\u9fff]{0,4}\s*)?(References?|参考文献|参考资料|参考来源|引用文献)\s*[：:]?/i.test(text.trim());
}

// 装饰性图标的 Unicode 区段（常见方块/几何/符号/Dingbats）
// 注意：▲(U+25B2)、△(U+25B3) 在 Geometric Shapes 内但属于图注标记，需排除
const ICON_CODEPOINT_RANGES = [
  [0x25A0, 0x25FF], // Geometric Shapes（◍ ▨ ◆ ★ ● ▶ ■ 等）
  [0x2580, 0x259F], // Block Elements（▀ ▄ ▌ ▐ 等）
  [0x2600, 0x26FF], // Misc Symbols（☀ ☂ ★ 等）
  [0x2700, 0x27BF], // Dingbats（✂ ✈ ✉ 等）
  [0x1F300, 0x1F5FF], // Misc Symbols and Pictographs（🌟 等）
  [0x1F600, 0x1F64F], // Emoticons
];

/** 单字符是否为装饰性图标（▲ △ 除外） */
function isDecorativeIconChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  if (cp === 0x25B2 || cp === 0x25B3) return false; // ▲ △ 是图注标记
  return ICON_CODEPOINT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** 段落是否仅由装饰性图标组成（▲ △ 除外），用于直接剔除 */
function isDecorativeIconParagraph(text) {
  const t = text.trim();
  if (!t || t.length > 4) return false;
  if (!isDecorativeIconChar(t[0])) return false;
  // 后续字符只能由「装饰图标 + 空格」组成，不能有中文/英文/数字（避免误删）
  for (const ch of t) {
    if (isDecorativeIconChar(ch) || /\s/.test(ch)) continue;
    return false;
  }
  return true;
}

/**
 * 判断段落是否为「纯标点」短段（用于吸收到前一段末尾）
 *
 * 微信 HTML 里经常出现独立成段的"。"、"！"、"？"、"……"、"——"等，
 * 用来做视觉停顿。但 walk 会把它当作独立段落输出，导致 Word 里
 * 「标点单独成行 / 标点出现在句首」等排版问题。
 *
 * 规则：长度 ≤ 4 且只由标点 / 空白组成（不含汉字 / 数字 / 字母）
 */
function isPurePunctOnly(text) {
  const t = (text || '').trim();
  if (!t || t.length > 4) return false;
  // 标点集合：CJK 标点 + 全角符号 + 英文标点 + 省略号 + 破折号 + 引号
  return /^[\s\u3000-\u303f\uff00-\uffef\u2014\u2015\u2026\u00b7\u2018\u2019\u201c\u201d]+$/.test(t);
}

function stripReferenceMarker(text) {
  return text
    .trim()
    .replace(/^(?:[^\w\u4e00-\u9fff]{0,4}\s*)?(References?|参考文献|参考资料|参考来源|引用文献)\s*[：:]?\s*/i, '');
}

/**
 * 元素的最后一个非空节点是否为 <br>。
 * 段末换行符不具备分段语义（「文 | 雪鸮<br>」是一行，不是两行），
 * 含这种尾部 br 的内联元素仍应与前后文本合并，否则署名行会被腰斩成两段。
 */
function endsWithTrailingBr(el) {
  let node = el && el.cheerio ? el[0] : el;
  if (!node) return false;
  for (;;) {
    const children = node.children || [];
    let last = null;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.type === 'text' && !(child.data || '').trim()) continue;
      last = child;
      break;
    }
    if (!last) return false;
    if (last.type === 'tag' && String(last.tagName || '').toLowerCase() === 'br') return true;
    if (last.type === 'tag') { node = last; continue; }
    return false;
  }
}

// 参考文献末尾噪声截断点
const REF_END_MARKERS = ['本文关键词', '欢迎大家在', '图片源自网络', '搜索文章', '点亮', '戳菜单栏', '编辑 /', '作者 /'];

function cutReferenceNoise(text) {
  let t = text;
  for (const kw of REF_END_MARKERS) {
    const i = t.indexOf(kw);
    if (i !== -1) {
      t = t.slice(0, i);
      break;
    }
  }
  return t.trim();
}

/** 定位正文容器 */
function containerFor(content, $) {
  if (!content.length) return content;
  const children = content.children();
  if (children.length <= 2) {
    const first = children.first();
    if (first && first.prop('tagName') && first.prop('tagName').toUpperCase() === 'SECTION') {
      const totalLen = content.text().length;
      const firstLen = first.text().length;
      if (totalLen > 0 && firstLen / totalLen > 0.85) {
        return first;
      }
    }
  }
  return content;
}

/**
 * 从文末的「头图/封面 《片名》」标注里取片名，用于挂到文章开头图片后作为图注。
 * 只认文章后半部分的标注，避免正文里提到「封面 《xxx》」时被误提取。
 * @returns {string} 形如「《我，到点下班》」，没有则为空串
 */
function extractHeadImageCredit(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const start = Math.floor(list.length * 0.5);
  for (let i = list.length - 1; i >= start; i--) {
    const match = HEAD_IMAGE_CREDIT_RE.exec((list[i].text || '').trim());
    if (match) return match[1];
  }
  return '';
}

/**
 * 去掉标题中的账号署名（「… | 谷雨」「谷雨 | …」）。
 * 简称只需是账号名的前缀即可命中（账号「谷雨实验室」的文章标题常简写成「| 谷雨」），
 * 避免为每个公众号维护硬编码列表；长度 ≥ 2 且为账号名前缀才删，防止误伤正文词。
 */
function stripAccountMark(title, account) {
  const acc = (account || '').trim();
  if (!acc || !title) return title;
  const parts = title.split(/\s*[|｜]\s*/);
  if (parts.length === 2) {
    const [head, tail] = parts;
    if (tail && tail.trim().length >= 2 && acc.startsWith(tail.trim())) return head.trim();
    if (head && head.trim().length >= 2 && acc.startsWith(head.trim())) return tail.trim();
  }
  return title;
}

/**
 * 主解析函数
 */
function parseArticle(html) {
  const $ = cheerio.load(html);

  // 1. 标题
  let title = $('#activity-name').text().trim();
  if (!title) {
    const m = html.match(/var\s+msg_title\s*=\s*'([^']*)'/);
    if (m) title = m[1];
  }
  title = cleanText(title.replace(/\.html\(false\)/g, '')).trim();

  // 2. 公众号名
  let account = '';
  const nickM = html.match(/var\s+nickname\s*=\s*htmlDecode\("([^"]*)"\)/);
  if (nickM) account = nickM[1];
  if (!account) account = $('#js_name').text().trim();
  if (!account) {
    const m2 = html.match(/var\s+nickname\s*=\s*"([^"]*)"/);
    if (m2) account = m2[1];
  }

  // 账号固定署名/栏目后缀不属于文章主标题（通用规则见 stripAccountMark）。
  title = stripAccountMark(title, account);
  if (account.trim() === '正午故事') {
    // 正午系的栏目名（正午书架 / 正午视觉…）不是账号名前缀，通用规则覆盖不到，单独处理。
    title = title
      .replace(/^正午[^|｜]*[|｜]\s*/, '')
      .replace(/\s*[|｜]\s*正午[^|｜]*$/, '')
      .trim();
  }

  // 正文有时会再次排版文章标题；需基于清理后的最终标题判断正文副本。
  const bodyTitle = title.split(/[|｜]/)[0].trim();

  const content = $('#js_content');

  // 预扫描：识别三类「装饰分隔图」（独立成行、无链接、同尺寸成组 ≥2 张）——
  //   1) 序号图（§ 1/6 等数字章节序号，较小 w ≤ 480 近方形）→ data-chapter-sep；
  //   2) 全宽章节序号条（谷雨实验室等：绿色「1.」圆标横条，w 可达 1080、ratio 0.04~0.18）→ data-chapter-sep；
  //   3) 纯装饰分隔图（如鲸鱼插画，481 ≤ w ≤ 700 近方形）→ data-deco-sep，walk 阶段直接丢弃。
  // 保守标准：无链接 + 独立成行 + 同尺寸成组出现（≥2 张），区别于头图 / 正文大配图 / 极扁分隔线。
  // 注意：命中窗口的图本来也会因 small_or_flat 被过滤，标记为序号/装饰只会影响其呈现方式，不会丢本应保留的图。
  if (content.length) {
    const candidates = [];
    content.find('img').each((i, el) => {
      const $el = $(el);
      const src = $el.attr('data-src') || $el.attr('src') || '';
      if (!src) return;
      const w = parseInt($el.attr('data-w') || '0', 10);
      const ratio = parseFloat($el.attr('data-ratio') || '0');
      // 尺寸窗口 A：小/中等近方形图；窗口 B：全宽极扁的章节序号条
      const smallSquare = w >= 120 && w <= 700 && ratio >= 0.3 && ratio <= 0.8;
      const wideNumberBar = w >= 600 && ratio >= 0.04 && ratio <= 0.18;
      if (!smallSquare && !wideNumberBar) return;
      const wide = !smallSquare;
      // 无链接（非小程序 / 跳转图）
      const isLinked =
        $el.closest(
          'a[href], a[data-linktype], a.weapp_image_link, a.js_weapp_entry, [data-miniprogram-imageurl], [data-miniprogram-appid]'
        ).length > 0;
      if (isLinked) return;
      // 独立成行：所在容器除图片外无文字
      const $p = $el.closest('p');
      const $container = $p.length ? $p : $el.parent();
      const $clone = $container.clone();
      $clone.find('img').remove();
      if ($clone.text().trim() !== '') return;
      candidates.push({ $el, src, w, ratio, wide });
    });
    if (candidates.length >= 2) {
      // 按 (宽, 高比) 分组（ratio 取 3 位小数容差，兼容微信 data-ratio 精度不一的情况），
      // 每组数量 ≥ 2 才认定；按宽度区分「序号图(小)」与「纯装饰图(中等)」。
      const groups = new Map();
      for (const c of candidates) {
        const key = `${c.w}|${Math.round(c.ratio * 1000)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      // 全宽扁条的判定更严格：章节序号条是同一套模板，整篇只会有一组同尺寸图；
      // 而装饰分隔图往往尺寸各异（多个组）。无法确认时按装饰图丢弃，
      // 宁可不输出序号，也不要凭装饰图凭空造出「1. 2. 3.」。
      const wideGroups = [...groups.values()].filter((g) => g.length >= 2 && g[0].wide);
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        let isChapterSep;
        if (g[0].wide) {
          isChapterSep = wideGroups.length === 1;
        } else {
          // 小近方形图按宽度区分序号图与纯装饰图
          isChapterSep = g[0].w <= 480;
        }
        const mark = isChapterSep ? 'data-chapter-sep' : 'data-deco-sep';
        for (const c of g) c.$el.attr(mark, '1');
      }
    }
  }

  // 3. 提取作者（取文本最短的匹配元素，避免"文|饶桐语 编辑|张轻松"粘连）
  let author = '';
  if (content.length) {
    let bestLen = Infinity;
    content.find('p, span, strong, section').each((i, el) => {
      const t = $(el).text().trim();
      if (t.length >= 3 && t.length < 30 && t.length < bestLen) {
        const a = extractAuthor(t);
        if (a) {
          bestLen = t.length;
          author = a;
        }
      }
    });
  }

  // 3.1 提取编辑（编辑/责编/责任编辑等，有则显示，取最短匹配避免粘连）
  let editor = '';
  if (content.length) {
    let bestLen = Infinity;
    content.find('p, span, strong, section').each((i, el) => {
      const t = $(el).text().trim();
      if (t.length >= 3 && t.length < 30 && t.length < bestLen) {
        const e = extractEditor(t);
        if (e) {
          bestLen = t.length;
          editor = e;
        }
      }
    });
  }

  // 4. 递归扁平化正文
  const blocks = [];
  const imageDiagnostics = [];
  const positions = new WeakMap();
  content.find('*').each((index, el) => positions.set(el, index));
  const bodyPositions = [];
  let scannedEnd = false;
  content.find('p,section,div,h1,h2,h3,h4,h5,h6').each((_, el) => {
    if ($(el).find('p,section,div,h1,h2,h3,h4,h5,h6').length) return;
    const text = cleanText($(el).text()).trim();
    if (isArticleEndMarker(text)) scannedEnd = true;
    if (!scannedEnd && text.length > 60 && !findNoiseType(text) && !isReferenceMarker(text)) bodyPositions.push(positions.get(el));
  });
  let referenceItems = [];
  let inReference = false;
  let afterNoiseOrRef = false; // 进入尾部噪声/参考文献区域后，图片不再保留
  let reachedArticleEnd = false; // 命中独立成行的正文结束标记后，默认仅继续保留版权风险声明
  let keepNextPostEndText = false; // 正午故事例外：结束符后的第一句正文仍需保留
  let seenBodyCount = 0; // 已输出的正文文字块数（paragraph/heading/subheading），用于区分头部/底部二维码
  let pendingInteractionPrompt = false; // 命中「留言互动区」后，紧随的提问句同属互动区

  // 留言互动区标题（「每人互动」「今日互动」等）之后的提问句是互动话题本身，一并删除；
  // 只吃紧随其后的一句，且限于短疑问句，避免吃掉正常正文。
  const takeInteractionPrompt = (text) => {
    if (!pendingInteractionPrompt) return false;
    pendingInteractionPrompt = false;
    return text.length <= 40 && /[？?]$/.test(text);
  };

  // 判断 <a> 是否为微信站内跳转链接（文末「相关推荐/相关阅读」类）
  const isRecommendLink = ($a) => {
    const href = $a.attr('href') || '';
    const linkType = $a.attr('data-linktype') || '';
    const tab = $a.attr('tab') || '';
    return linkType === '2' || tab === 'innerlink' || href.includes('wechat_redirect');
  };

  // 判断节点内文字是否「全部由推荐内链 + 分隔符」构成（即整段都是相关推荐链接）
  const isRecommendLinkOnly = (el) => {
    const $el = $(el);
    const isSelfLink = $el.is('a');
    const links = isSelfLink ? $el : $el.find('a');
    if (links.length === 0) return false;
    let allInner = true;
    links.each((i, a) => {
      if (!isRecommendLink($(a))) allInner = false;
    });
    if (!allInner) return false;
    // 去掉所有 <a> 后剩余文字必须为空（只允许分隔符/空白）
    const clone = $el.clone();
    clone.find('a').remove();
    if (isSelfLink) clone.text('');
    const rest = clone.text();
    return rest.replace(/[\s\u00a0|｜·•、:：–—-]/g, '') === '';
  };

  const processTextBlock = (text, $el) => {
    let t = cleanText(text).trim();
    if (!t) return;

    let format = extractTextFormat($, $el);
    const syncFormatToText = () => {
      const runText = cleanText((format.runs || []).map((run) => run.text || '').join('')).trim();
      if (runText !== t) {
        format = {
          ...format,
          runs: [{ ...format.style, bold: (format.style.boldRatio || 0) >= 0.85, text: t }],
        };
      }
    };
    syncFormatToText();
    if (containsCopyright(t)) {
      blocks.push({ type: 'copyright', text: t, ...format });
      return;
    }
    if (isArticleEndMarker(t)) {
      if (!reachedArticleEnd) keepNextPostEndText = account.trim() === '正午故事';
      reachedArticleEnd = true;
      afterNoiseOrRef = true;
      return;
    }
    if (reachedArticleEnd) {
      if (keepNextPostEndText) {
        keepNextPostEndText = false;
        if (!findNoiseType(t) && stripSlideHints(t)) {
          const sentence = (t.match(/^[\s\S]*?[。！？!?](?:[”」』"])?/) || [t])[0];
          blocks.push({ type: 'paragraph', text: sentence, postEndNote: true, ...format });
        }
      }
      return;
    }

    // 互动话题的提问句（「你如何看待这些继承人们的故事？」）紧跟互动区标题，同属互动区
    if (takeInteractionPrompt(t)) {
      blocks.push({ type: 'deleted', label: '留言互动区', text: t.slice(0, 50) });
      return;
    }

    // 长图浏览操作提示（左滑查看更多 / 可向下滑动查看 / 下滑查看）：
    // 整段仅为提示 → 丢弃；提示只是分句 → 删掉该分句，保留其余正文/图注。
    t = stripSlideHints(t);
    if (!t) return;
    syncFormatToText();

    // 「作者信息区」署名行（编辑丨xxx / 实习丨xxx / 作者丨xxx / 文丨xxx / 出品丨xxx 等）：
    // 无论位于文章开头还是结尾，署名行本身都标记为作者信息区（作者名已由 data.author 单独提取展示），
    // 不影响其后图片的保留。
    // 「图｜受访者供图」这类图片来源行同属署名区；但紧跟在图片之后的同类文字是图注，需排除。
    // 来源写法未穷尽，故紧邻其他署名行时放宽为「图 + 分隔符 + 短内容」即可判定。
    const prevBlock = blocks[blocks.length - 1];
    const isCaptionPosition = !!prevBlock && prevBlock.type === 'image';
    const prevIsByline =
      !!prevBlock && prevBlock.type === 'deleted' && prevBlock.label === '作者信息区';
    const isPhotoCreditByline =
      !isCaptionPosition &&
      (PHOTO_CREDIT_BYLINE_RE.test(t) || (prevIsByline && PHOTO_CREDIT_LOOSE_RE.test(t)));
    if (
      t.length < 80 &&
      (
        BYLINE_PREFIX_RE.test(t) ||
        isPhotoCreditByline
      )
    ) {
      blocks.push({ type: 'deleted', label: '作者信息区', text: t.slice(0, 50) });
      return;
    }

    // 只有段首参考文献标记才能改变区域，正文中提及参考资料不触发截断。
    const refIdx = isReferenceMarker(t) ? 0 : -1;
    if (refIdx !== -1) {
      afterNoiseOrRef = true;
      let refPart = t.slice(refIdx);
      const before = t.slice(0, refIdx).trim();
      if (before) {
        const noiseType = findNoiseType(before) || '留言互动区';
        blocks.push({ type: 'deleted', label: noiseType, text: before.slice(0, 50) });
      }
      inReference = true;
      refPart = cutReferenceNoise(stripReferenceMarker(refPart));
      if (refPart) referenceItems.push(refPart);
      return;
    }

    if (inReference) {
      // 参考文献区结束：出现噪声词，后续文本走正常噪声/正文逻辑
      if (findNoiseType(t)) {
        inReference = false;
      } else if (/^\[\d+\]/.test(t) || /^\d{1,3}[\.、\)](?!\d)/.test(t)) {
        // 新条目：以 [数字] 或「数字. / 数字、」开头（编号与内容可能分行）。
        // 编号后不要求空格——「1、《xxx》」是常见写法，漏掉会把整组文献拼成一条。
        // 用 (?!\d) 排除「3.14」「2021.12」这类正文数字，避免误切。
        referenceItems.push(t);
        return;
      } else {
        // 续行：追加到上一条（期刊名 / doi / 页码等被拆到独立节点）
        if (referenceItems.length === 0) {
          referenceItems.push(t);
        } else {
          const prev = referenceItems[referenceItems.length - 1];
          const sep = /^[.,;:)\]）】」』]/.test(t) ? '' : ' ';
          referenceItems[referenceItems.length - 1] = prev + sep + t;
        }
        return;
      }
    }

    // 噪声
    const noiseType = findNoiseType(t);
    if (noiseType) {
      // 正文结束的强信号：互动区 / 文末营销 / 标星引导 / 点亮红心 / 相关推荐区 等，其后图片属尾部推广不再保留
      const endWords = [
        '微信又双叒叕', '标星', '星标', '点亮', '红心', '点点', '都看到这里啦',
        // 公众号文末「相关推荐」固定模块：话术 + 紧随的图片营销区都应被剔除
        '相关推荐', '点击图片跳转', '相关阅读', '推荐阅读',
        // 公众号文末「阅读原文」链接区
        '点击阅读原文', '阅读原文',
        // 文末版权声明（"* 版权声明：腾讯新闻出品内容…"）→ 其后底部品牌图/二维码不再保留
        '版权声明',
      ];
      // 「扫码关注/长按识别二维码/点击上方/点击蓝字」等词：出现在正文之后实为底部二维码，
      // 同样触发尾部判定（丢弃其后的二维码图）；出现在正文之前（文章开头）仍是头部引导，不动。
      const isBottomQr = noiseType === '顶部二维码' && seenBodyCount >= 1;
      // 尾部关键词只有在正文已经开始后才可截断后续图片。
      // 文章开头常有「点击上方星标，以防失联」等顶部引导；此前其中的“星标”会误把
      // afterNoiseOrRef 永久置为 true，导致正文内全部图片被过滤。
      const isEndWordAfterBody = seenBodyCount >= 1 && endWords.some((w) => t.includes(w));
      const hasLaterBody = bodyPositions.some((position) => position > (positions.get($el[0]) ?? -1));
      if (!hasLaterBody && seenBodyCount > 0 && (
        noiseType === '留言互动区' || noiseType === '文末营销' || isBottomQr || isEndWordAfterBody
      )) afterNoiseOrRef = true;
      if (noiseType === '留言互动区') pendingInteractionPrompt = true;
      blocks.push({ type: 'deleted', label: isBottomQr ? '底部二维码' : noiseType, text: t.slice(0, 50) });
      return;
    }

    if (isCaptionBlock($, $el, t) || isCaptionCandidate(t, { afterImage: isCaptionPosition, style: format.style })) {
      blocks.push({ type: 'caption', text: normalizeCaptionSourceSpacing(t), ...format });
      return;
    }

    // 纯数字序号段（单独成行的 "01"/"02"/"1"/"12" 等章节序号）：
    // 先记为文字型 chapterSeparator，是否保留（≥2 成组）由后处理统一判断，
    // 避免正文里偶发单个数字被误判成小标题。
    if (/^0*\d{1,2}$/.test(t)) {
      blocks.push({ type: 'chapterSeparator', text: t, fromText: true });
      return;
    }

    // 装饰性图标（▲ △ 之外）→ 直接剔除，不进入正文
    if (isDecorativeIconParagraph(t)) {
      return;
    }

    // ★ 纯标点短段 → 吸收到前一段末尾（修复「。」单独成行 / 标点出现在句首）
    // 微信 HTML 中常出现独立成段的"。"、"！"、"？"、"……"作为视觉停顿，
    // 这些段本应和前一段拼成一句，被 walk 拆散后会变成 Word 排版 bug。
    if (isPurePunctOnly(t)) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.type === 'paragraph' || b.type === 'subheading' || b.type === 'caption') {
          b.text = (b.text || '') + t;
          return;
        }
        // 跨 deleted/image/video/audio 段粘连有风险，放弃吸收（直接丢弃）
        if (b.type === 'deleted' || b.type === 'image' || b.type === 'video' || b.type === 'audio') {
          return;
        }
      }
      return; // 没找到可吸收的前一段，丢弃
    }

    // 文末「相关推荐」链接：整段都是微信站内跳转链接（如「表白暴力 | 男性凝视 | 无性恋」）
    // 标记为独立类型，由 docxBuilder 在汇编板块删除并红色预警，单篇板块保留原文
    if (isRecommendLinkOnly($el)) {
      blocks.push({ type: 'recommendLink', text: t });
      return;
    }

    // 正文同时保留样式证据，供序号恢复和图注统一判定。
    blocks.push({ type: 'paragraph', text: t, ...format });
    seenBodyCount++;
  };

  /** 递归遍历，扁平化内容节点 */
  const walk = (node) => {
    const $node = $(node);
    const tag = ($node.prop('tagName') || '').toLowerCase();

    if (/^(script|style)$/.test(tag)) return;
    if (reachedArticleEnd && (tag === 'img' || tag.includes('video') || tag.includes('voice') || tag === 'audio')) {
      if (tag === 'img') imageDiagnostics.push({ src: $node.attr('data-src') || $node.attr('src') || '', status: 'filtered', reason: 'article_end' });
      return;
    }
    const standaloneText = tag === 'img' ? '' : cleanText($node.text()).trim();
    const hasBlockDescendants = $node.find('p,section,div,h1,h2,h3,h4,h5,h6,br').length > 0;
    // 版权词优先于标题、署名、噪声和结束符处理；仅处理单一文本容器，避免父容器吞并相邻推广段。
    if (!hasBlockDescendants && standaloneText && containsCopyright(standaloneText)) {
      processTextBlock(standaloneText, $node);
      return;
    }
if (!hasBlockDescendants && isReferenceMarker(standaloneText)) {
      processTextBlock(standaloneText, $node);
      return;
    }
    if (!hasBlockDescendants && !$node.find(MEDIA_SELECTOR).length && isArticleEndMarker(standaloneText)) {
      processTextBlock(standaloneText, $node);
      return;
    }

    // 微信正文开头有时会重复排版一次文章标题；Word 已在开头输出主标题，正文副本直接跳过，
    // 避免它成为“第一个小标题”并干扰后续格式校准。仅限正文前几块，防止误删后文回扣标题。
    if (seenBodyCount <= 3 && bodyTitle && (standaloneText === title || standaloneText === bodyTitle)) {
      return;
    }

    // 图片
    if (tag === 'img') {
      const src = $node.attr('data-src') || $node.attr('src') || '';
      const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
      const style = $node.attr('style') || '';
      const w = positive($node.attr('data-w')) || positive($node.attr('width')) || positive((style.match(/(?:^|;)\s*width\s*:\s*([\d.]+)px/i) || [])[1]);
      const h = positive($node.attr('height')) || positive((style.match(/(?:^|;)\s*height\s*:\s*([\d.]+)px/i) || [])[1]);
      const ratio = positive($node.attr('data-ratio')) || (w && h ? h / w : undefined);
      const linked = $node.closest('a[href], a[data-linktype], a.weapp_image_link, a.js_weapp_entry, [data-miniprogram-imageurl], [data-miniprogram-appid]').length > 0;
      // 章节序号图（含全宽扁条）必须先于 small_or_flat 判断——扁条 ratio < 0.3，
      // 若先按尺寸过滤，序号标记永远轮不到生效（谷雨实验室版式踩中此坑）。
      const isChapterSep = !!$node.attr('data-chapter-sep');
      const isDecoSep = !!$node.attr('data-deco-sep');
      const smallOrFlat = (w != null && w < 150 || ratio != null && ratio < 0.3);
      const reason = !src ? 'missing_url' : afterNoiseOrRef ? 'tail_or_references' : linked ? 'linked_image' :
        isDecoSep ? 'decorative_separator' : !isChapterSep && smallOrFlat ? 'small_or_flat' : null;
      if (reason) {
        imageDiagnostics.push({ src, status: 'filtered', reason });
      } else if ($node.attr('data-chapter-sep')) {
        blocks.push({ type: 'chapterSeparator', src });
        imageDiagnostics.push({ src, status: 'filtered', reason: 'chapter_separator' });
      } else {
        blocks.push({ type: 'image', src, width: w, ratio, needsImageProbe: w == null || ratio == null, status: 'pending' });
      }
      return;
    }

    // 视频
    if (tag.includes('video') || tag === 'mp-common-videosnap' || $node.attr('data-mpvid')) {
      const link = $node.attr('data-mpvid') || $node.attr('vid') || $node.attr('data-link') || '';
      blocks.push({ type: 'video', links: link ? [link] : [] });
      return;
    }

    // 音频
    if (tag.includes('voice') || tag === 'mpvoice' || $node.attr('voice_encode_fileid')) {
      const link = $node.attr('voice_encode_fileid') || $node.attr('data-link') || '';
      blocks.push({ type: 'audio', links: link ? [link] : [] });
      return;
    }

    // 标题容器整体判断（section/div/h1-h6/p）：
    // 命中则整体输出一个标题块，不再递归，解决标题被内部多个 span 拆散的问题。
    // p 也纳入判断：公众号小标题常用 <p><strong>标题</strong></p> 结构（加粗短句、无句末标点、字号较大），
    // 若不加判断会被当普通段落输出，漏掉小标题。
    if (
      !reachedArticleEnd &&
      (tag === 'section' || tag === 'div' || /^h[1-6]$/.test(tag) || tag === 'p') &&
      isHeadingContainer($, $node)
    ) {
      const rawHeading = cleanText($node.text()).trim();
      const headingText = stripTrailingMention(rawHeading) || rawHeading;
      const sub = parseSubheading(headingText);
      const format = extractTextFormat($, $node);
      const afterImage = blocks.length > 0 && blocks[blocks.length - 1].type === 'image';
      const caption = !sub && afterImage && (isCaptionBlock($, $node, headingText) ||
        (format.style.fontSize != null && format.style.fontSize <= 14 && isCaptionCandidate(headingText, { afterImage, style: format.style })));
      if (caption) {
        blocks.push({ type: 'caption', text: normalizeCaptionSourceSpacing(headingText), ...format });
        return;
      }
      blocks.push({
        type: 'subheading', level: sub ? sub.level : 2, text: headingText,
        numType: sub && sub.numType || null, num: sub && sub.num || '',
        pureNumber: !!(sub && sub.pureNumber), subText: sub && sub.subText != null ? sub.subText : headingText,
        fontSize: format.style.fontSize, ...format,
      });
      seenBodyCount++;
      // 若标题里粘连了投稿人署名(@xxx)，剥离标题后把署名作为正文段落保留，避免丢信息
      if (headingText && headingText !== rawHeading) {
        const mention = rawHeading.slice(rawHeading.indexOf('@')).trim();
        if (mention) {
          blocks.push({ type: 'paragraph', text: mention });
          seenBodyCount++;
        }
      }
      return;
    }

    // 按文档顺序处理段内媒体和 br，结束符前后的图片不互相影响。
    if (tag === 'p') {
      const beforeLen = blocks.length;
      const wasAfter = afterNoiseOrRef;
      let line = '';
      const flushLine = () => {
        if (line.trim()) processTextBlock(line, $node);
        line = '';
      };
      const visit = (child) => {
        if (child.type === 'text') { line += child.data || ''; return; }
        const childTag = (child.tagName || '').toLowerCase();
        if (childTag === 'br') { flushLine(); return; }
        if (/^(img|video|audio|mpvoice|mp-common-videosnap|section|div|p)$/.test(childTag)) { flushLine(); walk(child); return; }
        if (/^(script|style)$/.test(childTag)) return;
        for (const sub of child.children || []) visit(sub);
      };
      $node.contents().each((_, child) => visit(child));
      flushLine();
      if (!wasAfter && afterNoiseOrRef && !reachedArticleEnd) {
        for (let i = blocks.length - 1; i >= beforeLen; i--) {
          if (blocks[i].type === 'image') {
            imageDiagnostics.push({ src: blocks[i].src, status: 'filtered', reason: 'same_paragraph_promotion' });
            blocks.splice(i, 1);
          }
        }
      }
      return;
    }

    // 叶子文本
    const children = $node.children();
    if (children.length === 0) {
      const text = cleanText($node.text()).trim();
      if (text) processTextBlock(text, $node);
      return;
    }

    // 递归子节点（含文本节点）：处理「文本 + <br> + 文本」这类混合内容。
    // 关键：同一段落容器内的相邻内联文本（span/strong/a/b 等，含加粗/变色）应合并为
    // 一段，只有遇到块级元素（section/div/p/h1-h6 等）或媒体（图片/视频/音频）时才断开。
    // 否则 <strong>…</strong><span>。…</span> 会被拆成两段，导致加粗句块单独换行、
    // 句号跑到下一段句首。
    let buf = '';
    const flush = () => {
      // 折叠标签间混入的换行/缩进空白，避免「文字\n    。文字」这类排版噪声
      const text = cleanText(buf)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
      if (text) processTextBlock(text, $node);
      buf = '';
    };
    const isMediaNode = (el) => {
      const t = ($(el).prop('tagName') || '').toLowerCase();
      return (
        t === 'img' ||
        t.includes('video') ||
        t.includes('voice') ||
        t === 'mp-common-videosnap' ||
        t === 'mpvoice' ||
        !!(el.attribs && (el.attribs['data-mpvid'] || el.attribs['voice_encode_fileid']))
      );
    };

    $node.contents().each((i, c) => {
      if (c.type === 'text') {
        buf += c.data || '';
        return;
      }
      if (c.type !== 'tag') return;
      const ctag = ($(c).prop('tagName') || '').toLowerCase();
      // 媒体：先冲刷累积文本，再单独输出媒体块
      if (isMediaNode(c)) {
        flush();
        walk(c);
        return;
      }
      // 内联元素且内部不含媒体、不含 <br> 换行：并入当前段落（不递归，避免拆散）
      // 含 <br> 的内联元素需递归处理，保留「段内换行」的分段语义；
      // 但 br 位于元素末尾时只是段落收尾，仍应并入（否则「文 | 雪鸮<br>」被腰斩成两段）
      if (
        INLINE_TAGS.has(ctag) &&
        $(c).find(MEDIA_SELECTOR).length === 0 &&
        ($(c).find('br').length === 0 || endsWithTrailingBr(c))
      ) {
        buf += $(c).text();
        return;
      }
      // 块级元素（section/div/p/h1-h6 等）或含媒体的内联元素：先冲刷再递归
      flush();
      walk(c);
    });
    flush();
  };

  walk(containerFor(content, $));

  // 5. 参考文献：收集阶段已按条目切分，这里统一清洗空白
  const references = referenceItems
    .map((s) => cleanText(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // 5.5 悬挂句末标点归位：把「。正是…」这类句首的句末标点还到上一段末尾
  //     （修复 <strong>…连结</strong><span>。正是…</span> 被拆成两段后句号跑到句首）
  const punctMergedBlocks = mergeLeadingSentencePunct(blocks);

  // 6. 合并孤立的 ▲ 与其后的图注文字
  const mergedBlocks = [];
  for (let i = 0; i < punctMergedBlocks.length; i++) {
    const b = punctMergedBlocks[i];
    if (b.type === 'caption' && /^[▲△]\s*$/.test(b.text)) {
      const next = punctMergedBlocks[i + 1];
      if (next && (next.type === 'paragraph' || next.type === 'caption')) {
        mergedBlocks.push({ type: 'caption', text: '▲ ' + next.text });
        i++;
        continue;
      }
    }
    mergedBlocks.push(b);
  }

  // 6.5 纯数字序号段成组判断：单独成行的 "01"/"02"/"1"/"12" 等文字型章节序号，
  //     ≥2 个才保留为 chapterSeparator（汇编下由 docxBuilder 替换为 1/2/3），否则降级为普通正文。
  const textNumSepCount = mergedBlocks.filter((b) => b.type === 'chapterSeparator' && b.fromText).length;
  if (textNumSepCount < 2) {
    for (const b of mergedBlocks) {
      if (b.type === 'chapterSeparator' && b.fromText) {
        b.type = 'paragraph';
        delete b.fromText;
      }
    }
  }

  restoreSequenceHeadings(mergedBlocks);

  // 纯序号仅与视觉样式一致的标题文字合并，不吞掉短正文。
  const mergedSubBlocks = [];
  for (let i = 0; i < mergedBlocks.length; i++) {
    const b = mergedBlocks[i];
    if (b.type === 'subheading' && b.level === 2 && b.pureNumber) {
      const next = mergedBlocks[i + 1];
      const continuationStyle = next && next.style && b.style &&
        Math.abs((b.style.fontSize || 0) - (next.style.fontSize || 0)) <= 1 &&
        (b.style.boldRatio || 0) >= 0.85 && (next.style.boldRatio || 0) >= 0.85;
      const continuationText = next && next.text && next.text.trim();
      const isContinuation = next && continuationText && continuationText.length <= 40 && continuationStyle &&
        ((next.type === 'subheading' && next.level === 2 && next.numType === null) ||
          (next.type === 'paragraph' && !/[。！？?!]$/.test(continuationText)));
      if (isContinuation) {
        mergedSubBlocks.push({ ...b, pureNumber: false, subText: continuationText, text: b.text + ' ' + continuationText,
          runs: [...(b.runs || []), { text: ' ' }, ...(next.runs || [])] });
        i++;
        continue;
      }
    }
    mergedSubBlocks.push(b);
  }

  // 8. 删除「前后都是强营销段落」的图片（营销 banner 配图）
  const marketingCleaned = dropImagesBetweenMarketing(mergedSubBlocks);

  // 8.5 账号特定噪声清理（针对已知固定模板的特殊处理）
  const accountCleaned = dropAccountSpecificImages(marketingCleaned, account);

  // 9. 标题有时由「编号 + 第一行标题」和下一行同样式标题续句组成。
  //    先合并这种跨容器续行，再处理相邻小标题拆分，避免 Word 把一套标题排成两段。
  const headingLineMerged = mergeHeadingLineContinuations(accountCleaned);
  const merged9 = mergeAdjacentSubheadings(headingLineMerged);

  // 9.5 章节内细分标题降级：识别「01/02/03 章节 + 章节内 1./2./3. 细分点」
  //     被误判为同一级小标题的情况，将细分点降为 level 3（归属于上一个章节）。
  const demoted = demoteNestedSubheadings(merged9);

  // 9.6 首个可信小标题格式校准：当至少两个候选与第一个小标题的编号形式、字号一致时，
  //     即实锤存在稳定的小标题体系；其余格式不同的加粗短句降为正文。
  const calibrated = calibrateSubheadingsByFirstFormat(demoted);

  // 10. 小标题一致性过滤：
  //    a) 数量 < 2 → 全部降为 paragraph（单个加粗短句不构成小标题体系）
  //    b) numType 一致性 → 若同时出现多种显式序号类型（arabic + chinese），
  //       保留数量最多的那种，其余降为 paragraph。
  const finalBlocks = filterSubheadingsByConsistency(calibrated);
  const captionBlocks = classifyCaptions(finalBlocks);
  // 文末「头图/封面 《片名》」的片名，供 Word 挂到开头图片后作为图注
  const headImageCredit = extractHeadImageCredit(captionBlocks);
  return { title, account, author, editor, blocks: captionBlocks, references, imageDiagnostics, headImageCredit };
}

function restoreSequenceHeadings(blocks) {
  const chineseValue = (text) => {
    if (!/^[一二三四五六七八九十]{1,3}$/.test(text)) return null;
    const digits = '零一二三四五六七八九';
    if (text.includes('十')) {
      const [a, b] = text.split('十');
      return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
    }
    return text.length === 1 ? digits.indexOf(text) : null;
  };
  let group = [];
  const flush = () => {
    const anchors = group.filter(({ block }) => block.type === 'subheading' && block.level === 2 && block.pureNumber);
    if (group.length >= 3 && anchors.length >= 2 && anchors.every(({ block }) => sameHeadingStyle(anchors[0].block.style, block.style))) {
      for (const { block } of group) {
        if (block.type !== 'paragraph' || block.postEndNote || block.style?.alignment !== 'center' || block.style.fontSize != null && block.style.fontSize < 14) continue;
        Object.assign(block, { type: 'subheading', level: 2, numType: 'chinese', num: block.text, pureNumber: true, subText: '',
          style: { ...anchors[0].block.style }, fontSize: anchors[0].block.fontSize, classificationReason: 'continuous_centered_sequence' });
      }
    }
    group = [];
  };
  for (const block of blocks) {
    const value = chineseValue((block.text || '').trim());
    if (value != null && ['paragraph', 'subheading'].includes(block.type)) {
      if (group.length && value !== group[group.length - 1].value + 1) flush();
      group.push({ block, value });
    } else if (block.type === 'subheading') flush();
  }
  flush();
}

/**
 * 按第一个小标题的格式校准全文同级标题。
 *
 * 「实锤」条件：至少两个 level-2 候选与首个候选的格式一致。
 * 格式包括：
 *   1) 是否带编号；带编号时编号类型必须相同；
 *   2) 有可靠字号时，字号差不得超过 1px。
 *
 * 实锤后，格式不同的候选通常是图注、强调语或章节内细分项，降为普通正文。
 * 若字号信息不足或首个格式没有重复出现，则不做激进校准，交给后续一致性规则处理。
 */
function calibrateSubheadingsByFirstFormat(blocks) {
  const subs = blocks.filter((b) => b.type === 'subheading' && b.level === 2);
  const matches = (a, b) => {
    if ((a.numType || null) !== (b.numType || null)) return false;
    // 有明确编号时，编号体系和字号优先于颜色/字体；同一文章的章节色彩可能交替变化。
    if (a.numType != null) {
      const left = a.fontSize ?? a.style?.fontSize;
      const right = b.fontSize ?? b.style?.fontSize;
      return left == null || right == null || Math.abs(left - right) <= 1;
    }
    return sameHeadingStyle(a.style || { fontSize: a.fontSize }, b.style || { fontSize: b.fontSize });
  };
  const reference = subs.find((candidate) => subs.filter((other) => matches(candidate, other)).length >= 2);
  if (!reference) return blocks;
  return blocks.map((b) => b.type === 'subheading' && b.level === 2 && !matches(reference, b)
    ? { ...b, type: 'paragraph', level: undefined, preserveFormat: true, classificationReason: 'different_heading_style' }
    : b);
}

/**
 * 小标题一致性过滤。
 *
 * 规则一：若全文 level-2 subheading 数量 < 2，全部降为 paragraph。
 *   单个加粗短句不构成小标题体系，大概率是强调引言或孤立标注。
 *
 * 规则二：若同时出现多种显式序号类型（arabic + chinese），
 *   保留数量最多的那种，其余降为 paragraph。
 *   纯文字型（numType: null）不参与竞争，始终与主体组保留。
 */
function filterSubheadingsByConsistency(blocks) {
  const subs = blocks.filter((b) => b.type === 'subheading' && b.level === 2);

  // 规则一：数量 < 2 → 全部降级
  if (subs.length < 2) {
    return blocks.map((b) =>
      b.type === 'subheading' && b.level === 2
        ? { ...b, type: 'paragraph', level: undefined, preserveFormat: true, classificationReason: 'unconfirmed_heading' }
        : b
    );
  }

  // 规则二：显式序号类型一致性
  const counts = {};
  for (const s of subs) {
    if (s.numType !== null) counts[s.numType] = (counts[s.numType] || 0) + 1;
  }
  const explicitTypes = Object.keys(counts);
  if (explicitTypes.length > 1) {
    // 有多种显式序号，保留最多的那种
    const dominant = explicitTypes.reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    return blocks.map((b) => {
      if (b.type === 'subheading' && b.level === 2 && b.numType !== null && b.numType !== dominant) {
        return { type: 'paragraph', text: b.text };
      }
      return b;
    });
  }

  return blocks;
}

/**
 * 章节内细分标题降级。
 *
 * 典型场景：公众号文章用两套视觉分组的编号系统——
 *   - 章节标题：01/02/03（前导零、字号大、颜色深）
 *   - 章节内的细分点：1./2./3./4.（不带前导零、字号明显更小）
 * parseSubheading 只按「单级阿拉伯数字序号」识别，两套编号都会被判定为同一 level=2
 * 的小标题，导致本应从属于第 3 个章节的细分点被拉平成与 1-3 并列的独立小标题。
 *
 * 识别依据（需同时满足，避免误伤正常的单层小标题序列）：
 *   1) 序号出现「非递增」的回退（如 03 之后又从 1 开始）；
 *   2) 回退之后的一组内部彼此数字连续递增（1,2,3,4…），像是独立的一套子序号；
 *   3) 回退处开始的一组，字号比之前一组明显更小（差值 ≥4px）——
 *      没有可比字号信息时不做判断，保守跳过，避免误伤。
 * 命中后，回退组整体降级为 level 3（细分标题），numType/level 2 一致性过滤
 * （filterSubheadingsByConsistency）不会再处理它们，保留其归属于上一章节的语义。
 */
function demoteNestedSubheadings(blocks) {
  const idxs = [];
  blocks.forEach((b, i) => {
    if (b.type === 'subheading' && b.level === 2 && b.numType === 'arabic') idxs.push(i);
  });
  if (idxs.length < 4) return blocks;

  const nums = idxs.map((i) => parseInt(blocks[i].num, 10));
  const fontSizes = idxs.map((i) => blocks[i].fontSize || 0);

  // 找第一个序号“回退到 1”的位置（前面至少要有 2 个才算独立的「章节」序列）
  let splitPos = -1;
  for (let k = 1; k < idxs.length; k++) {
    if (nums[k] === 1 && nums[k - 1] > 1) {
      splitPos = k;
      break;
    }
  }
  if (splitPos < 2) return blocks;

  // 回退后半段数字必须连续递增，否则不是有效的独立子序号系统
  for (let k = splitPos + 1; k < idxs.length; k++) {
    if (nums[k] !== nums[k - 1] + 1) return blocks;
  }

  // 字号差异校验：前半段（章节）平均字号需明显大于后半段（细分点）
  const before = fontSizes.slice(0, splitPos).filter(Boolean);
  const after = fontSizes.slice(splitPos).filter(Boolean);
  if (!before.length || !after.length) return blocks;
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  if (avg(before) - avg(after) < 4) return blocks;

  const demoteIdxs = new Set(idxs.slice(splitPos));
  return blocks.map((b, i) => (demoteIdxs.has(i) ? { ...b, level: 3 } : b));
}

/**
 * 悬挂句末标点归位。
 *
 * 微信排版常把一句话拆成「加粗部分 + 普通部分」，句号被放到下一段的开头，
 * 例如：<strong>…互相连结</strong><span>。正是…</span>。
 * walk 会输出「…互相连结」和「。正是…」两个段落，导致 Word 里句号出现在句首。
 *
 * 规则：段落以 。！？…‥ 等句末标点开头，且前一段是 paragraph 且未以句末标点结尾时，
 * 把开头的句末标点归还到前一段末尾。
 */
function mergeLeadingSentencePunct(blocks) {
  const LEAD_RE = /^[。！？…‥]+/;
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'paragraph' || typeof b.text !== 'string') {
      result.push(b);
      continue;
    }
    const m = b.text.match(LEAD_RE);
    if (!m) {
      result.push(b);
      continue;
    }
    const lead = m[0];
    const rest = b.text.slice(lead.length);
    const prev = result[result.length - 1];
    if (prev && prev.type === 'paragraph' && typeof prev.text === 'string' && !/[。！？…]$/.test(prev.text)) {
      prev.text += lead;
      if (rest.trim()) {
        b.text = rest.trim();
        result.push(b);
      }
      continue;
    }
    result.push(b);
  }
  return result;
}

/**
 * 删除「前后都是强营销段落」的图片（营销 banner 配图）。
 * 规则：一张 image 块，若其前后紧邻的块均为强营销删除块（文末营销/底部推广），
 * 则该图片也标记为删除（营销配图）。
 * 用于清理"营销文字 + banner 图 + 营销文字"这类文末推广结构。
 */
/**
 * 账号特定图片噪声清理。
 * 针对已知公众号的固定模板装饰图，在账号匹配时精准删除，其他账号完全不受影响。
 *
 * 真实故事计划：在每节小标题前插入 PNG 竖向箭头图标（ratio≈1.38，固定模板）。
 *   删除条件：PNG 格式 + ratio>1（竖向）+ 下一可见块是 subheading。
 *   三条同时满足，即便将来该账号在正文中使用 PNG 竖向图（无图注且紧跟小标题除外），
 *   也不会被误删——因为正文 PNG 竖向图后通常有 paragraph/caption，第三条不满足。
 */
function dropAccountSpecificImages(blocks, account) {
  const acc = (account || '').trim();

  // 真实故事计划：固定尺寸 PNG 装饰箭头图（w=1034, ratio≈1.377，同一张图）
  // 三条同时满足才删：精确尺寸 + PNG + 下一可见块是 subheading
  if (acc === '真实故事计划') {
    const nextVisible = (arr, from) => {
      for (let i = from + 1; i < arr.length; i++) {
        if (arr[i].type !== 'deleted') return arr[i];
      }
      return null;
    };
    return blocks.filter((b, i) => {
      if (b.type !== 'image') return true;
      // 精确锁定尺寸：w=1034 ±5px，ratio 在 1.35~1.41 之间
      if (b.width < 1029 || b.width > 1039) return true;
      if (!b.ratio || b.ratio < 1.35 || b.ratio > 1.41) return true;
      if (!/_png\//i.test(b.src || '')) return true;
      const nxt = nextVisible(blocks, i);
      if (!nxt || nxt.type !== 'subheading') return true;
      return false;
    });
  }

  // 谷雨实验室：文末固定的腾讯新闻圆形图标与“（来源：腾讯新闻）”尾注。
  // 必须同时命中账号、固定图文件标识、804px 近方形尺寸，并且紧随段落以该来源尾注结尾。
  // 仅删除这组模板，正常正文图片与正常的“来源”文字不受影响。
  if (acc === '谷雨实验室') {
    const sourceSuffix = /（来源：腾讯新闻）\s*$/;
    return blocks.reduce((out, b, i) => {
      const next = blocks[i + 1];
      const isTencentNewsIcon =
        b.type === 'image' &&
        /YulpgP4g2QLtwd7aY4PhcYIYapVuObiaC/i.test(b.src || '') &&
        b.width >= 799 && b.width <= 809 &&
        b.ratio >= 0.99 && b.ratio <= 1.01 &&
        next && next.type === 'paragraph' && sourceSuffix.test(next.text || '');
      if (isTencentNewsIcon) return out;
      if (b.type === 'paragraph') {
        // 谷雨文末说明前的装饰圆点（如「◦ 文中人物均为化名。」）不保留；正文仍保留。
        const text = (b.text || '')
          .replace(sourceSuffix, '')
          .replace(/^◦\s*/, '')
          .trim();
        if (text !== b.text) {
          if (text) {
            out.push({
              ...b,
              text,
              runs: [{ ...(b.style || {}), bold: (b.style?.boldRatio || 0) >= 0.85, text }],
            });
          }
          return out;
        }
      }
      out.push(b);
      return out;
    }, []);
  }

  return blocks;
}

function dropImagesBetweenMarketing(blocks) {
  const isMarketing = (b) =>
    !!b && b.type === 'deleted' && (b.label === '文末营销' || b.label === '底部推广');

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'image') continue;
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    if (isMarketing(prev) && isMarketing(next)) {
      b.type = 'deleted';
      b.label = '营销配图';
      b.text = (b.src || '').slice(0, 80);
      b.buffer = null;
      b.ext = null;
    }
  }
  return blocks;
}

/**
 * 续行判断用的版式比较：比 sameHeadingStyle 少一条颜色约束。
 * 公众号常见「编号行用主题色、下一行用正文色」的配色（如 507BAA + 25282A），
 * 同一句标题被拆成两行时颜色往往不一致，字号/对齐/加粗才是可靠的同标题信号。
 */
function sameHeadingLayout(a, b) {
  if (!a || !b) return true;
  if (a.fontSize != null && b.fontSize != null && Math.abs(a.fontSize - b.fontSize) > 1) return false;
  if (a.alignment && b.alignment && a.alignment !== b.alignment) return false;
  if (a.boldRatio != null && b.boldRatio != null && Math.abs(a.boldRatio - b.boldRatio) > 0.2) return false;
  return true;
}

/**
 * 判断标题的下一行是否更像同一标题的续行。
 * 依据的是「同一个小标题内部的排版一致」：字号、颜色、对齐、加粗程度一致，
 * 且下一行没有自己的编号；标点只作为强信号，不再是能不能合并的门槛。
 */
function shouldMergeHeadingContinuation(current, next) {
  if (!(current?.type === 'subheading' && current.level === 2)) return false;
  const nextIsUnnumberedHeading = next?.type === 'subheading' && next.level === 2 && next.numType == null;
  if (!nextIsUnnumberedHeading && next?.type !== 'paragraph') return false;

  const text = current.text || '';
  const body = (current.subText || text).trim();
  const continuation = (next.text || '').trim();
  if (!continuation || continuation.length > 60) return false;
  if (!sameHeadingLayout(current.style, next.style)) return false;

  // 下一行必须同属这套标题排版：已判为无编号标题、本身加粗，
  // 或与上一行同色且字号不小于它（公众号标题常靠颜色/字号而非加粗区分）。
  const nextLooksLikeHeading = nextIsUnnumberedHeading ||
    (next.style?.boldRatio || 0) >= 0.85 ||
    (next.style?.fontSize != null && current.style?.fontSize != null &&
      next.style.fontSize >= current.style.fontSize - 1 &&
      next.style.color && current.style.color && next.style.color === current.style.color);
  if (!nextLooksLikeHeading) return false;

  // 明确续接标点仍直接合并。
  if (/[：:，、；;…—-]$/.test(text)) return true;

  // 疑问句/感叹句标题后的同样式短行，多半是它的下一句
  // （如「想要情绪价值？」+「来岩馆听取「夸」声一片」）。
  if (/[？?！!]$/.test(text) && continuation.length <= 24) return true;

  // 无标点拆行不能一刀切。只在前一行语义明显未闭合时合并，避免把
  // 「二、故事」+「恋爱」这类“章节标题 + 细分标题”误合成一个标题。
  if (current.pureNumber) return true;
  if (!body || continuation.length > 24 || /[。！？?!]$/.test(continuation)) return false;
  return /(?:[的地得之与和及或把被让使给向对为在从将于因以而但并比]|对抗|面对|抵抗|摆脱|克服|逃离|进入|走出|走向|看见|看到|寻找|找到|获得|拥有|建立|重建|改变|理解|解释|解决|处理|回应|激发|唤醒|治愈|接纳|接受|拒绝|成为|变成|回到|带回|带向|放下|拿回|夺回|穿越|跨过|翻越|打破|打败|战胜|告别|拥抱|靠近|远离)$/.test(body);
}

/**
 * 合并「紧挨」的小标题（subheading）。
 * 微信常把一句加粗引文/标题拆成两行两个容器（如「攀岩帮你对抗」
 * 与「习得性无助」），各自被识别成小标题，汇编时被补成两个连续序号。
 * 合并不能只看标点：需同时满足同样式、下一行无独立编号，且前一行像未闭合短语。
 */
function mergeHeadingLineContinuations(blocks) {
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const current = blocks[i];
    const next = blocks[i + 1];
    const canContinue = shouldMergeHeadingContinuation(current, next);
    if (process.env.DEBUG_HEADING_MERGE && current?.text?.startsWith('01')) console.log('[MERGE]', { current: current.text, level: current.level, numType: current.numType, next: next?.text, nextType: next?.type, canContinue, currentStyle: current.style, nextStyle: next?.style });
    if (canContinue) {
      const continuation = next.text.trim();
      const text = joinHeadingFragments(current.text, continuation);
      const subText = joinHeadingFragments(current.subText || '', continuation);
      const needSpaceRun = text.length > (current.text || '').length + continuation.length;
      result.push({
        ...current,
        text,
        subText,
        runs: [...(current.runs || []), ...(needSpaceRun ? [{ text: ' ' }] : []), ...(next.runs || [])],
        pureNumber: false,
      });
      i++;
      continue;
    }
    result.push(current);
  }
  return result;
}

function mergeAdjacentSubheadings(blocks) {
  const result = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === 'subheading' && b.level === 2) {
      // 向后合并所有直接相邻的 subheading
      // text：拼接原始整句（含序号），用于展示/去重判断
      // subText：拼接各片段「已剥离序号」的文字，避免第一段自带的数字序号（如 "04"）
      //          随整句拼接一起混入合并后的标题正文
      let text = b.text || '';
      let subText = (b.subText != null ? b.subText : b.text) || '';
      const runs = [...(b.runs || [])];
      let j = i + 1;
      while (j < blocks.length && blocks[j].type === 'subheading' && blocks[j].level === 2) {
        const nb = blocks[j];
        if (!shouldMergeHeadingContinuation({ ...b, text, subText }, nb)) break;
        const combined = joinHeadingFragments(text, nb.text || '');
        if (combined.length > text.length + (nb.text || '').length) runs.push({ text: ' ' });
        runs.push(...(nb.runs || []));
        text = combined;
        subText = joinHeadingFragments(subText, (nb.subText != null ? nb.subText : nb.text) || '');
        j++;
      }
      if (j > i + 1) {
        const merged = { ...b, text, subText, runs, pureNumber: false };
        if (b.numType == null) merged.num = '';
        result.push(merged);
        i = j;
        continue;
      }
    }
    result.push(b);
    i++;
  }
  return result;
}

/** 拼接两段被拆开的小标题：中文语境直接续接，英文等需要词间距时再补空格。 */
function joinHeadingFragments(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (/[，、,：:；;。！？"'"'）】》…—]$/.test(a)) return a + b;
  if (/[\x00-\x7F]$/.test(a) && /^[A-Za-z0-9]/.test(b)) return a + ' ' + b;
  return a + b;
}

module.exports = { parseArticle, containsCopyright };
