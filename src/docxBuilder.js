'use strict';

/**
 * Word 文档生成模块
 * 按参考文档排版规则生成 .docx
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  AlignmentType,
  SectionType,
  HeadingLevel,
} = require('docx');
const { containsCopyright, classifyCaptions } = require('./articleRules');

// 字号（half-points，除以 2 = 磅值）
const SZ = {
  h1: 48, // 24pt 主标题
  h2: 40, // 20pt 章节标题
  body: 24, // 12pt 正文
  author: 22, // 11pt 作者
  caption: 20, // 10pt 图注
  ref: 18, // 9pt 参考文献
};

const COLOR = {
  title: '0F4761', // 深蓝绿
  caption: '8A8989', // 灰色图注
  ref: '888888', // 参考文献灰
  deleted: 'FF0000', // 删除标注红
  warn: 'FF0000', // 版权提醒红
};

const FONT_TITLE = '等线';
const FONT_BODY = '宋体';
const FONT_REF = 'Helvetica Neue';

// Word 内置「引用」样式（Quote），用于汇编图注
const QUOTE_STYLE = {
  id: 'Quote',
  name: 'Quote',
  basedOn: 'Normal',
  next: 'Normal',
  quickFormat: true,
  run: { italics: true },
};

// 图片统一宽度（像素，约 14.7cm，与参考文档一致）
const IMAGE_WIDTH_PX = 555;

function emptyPara() {
  return new Paragraph({ children: [] });
}

function pxToHalfPoints(px) {
  return Math.max(2, Math.round(Number(px) * 1.5));
}

/**
 * 清理跨 run 的边界空格。
 * cleanSpacesText 只看单个 run 内部的上下文——「德国学者」+「 Tobias」这种
 * 空格落在 run 开头时拿不到前一 run 的中文上下文，会漏删（截图 bad case 即此）。
 * 规则与块级清理一致：中文↔中文、中文↔英文/数字之间不留空格；英文词间空格保留。
 */
function cleanCrossRunSpaces(runs) {
  const isCN = (ch) => new RegExp(`[${CN_CHAR}]`).test(ch);
  const isAN = (ch) => /[A-Za-z0-9]/.test(ch);
  for (let i = 0; i < runs.length - 1; i++) {
    const tail = runs[i].text || '';
    const head = runs[i + 1].text || '';
    if (!tail || !head) continue;
    const tailSpaces = tail.match(/[ \u3000\u00a0\t]+$/);
    const headSpaces = head.match(/^[ \u3000\u00a0\t]+/);
    if (!tailSpaces && !headSpaces) continue;
    const last = tailSpaces ? tail.slice(0, tail.length - tailSpaces[0].length).slice(-1) : tail.slice(-1);
    const first = headSpaces ? head.slice(headSpaces[0].length).slice(0, 1) : head.slice(0, 1);
    if (!last || !first) continue; // 一侧全为空格，无法判断上下文，保守保留
    // 与块级规则一致：只有「英文/数字 ↔ 英文/数字」之间的空格保留（英文词间），
    // 其余（中文标点 + 空格 + 英文引号等）一律删除
    const remove = !(isAN(last) && isAN(first));
    if (remove) {
      runs[i] = { ...runs[i], text: tailSpaces ? tail.slice(0, tail.length - tailSpaces[0].length) : tail };
      runs[i + 1] = { ...runs[i + 1], text: headSpaces ? head.slice(headSpaces[0].length) : head };
    }
  }
}

/**
 * 生成图注段落，样式与各板块既有图注保持一致：
 * 汇编用 Quote 样式（10pt 灰斜体）、轻纪实 9pt 灰、轻心理 12pt 黑。
 */
function captionParagraph(text, category) {
  if (category === '汇编') {
    return new Paragraph({
      style: 'Quote',
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text, font: FONT_BODY, size: SZ.caption, color: COLOR.caption, italics: true })],
    });
  }
  if (category === '轻纪实') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text, font: FONT_BODY, size: SZ.ref, color: COLOR.caption })],
    });
  }
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text, font: FONT_BODY, size: SZ.body, color: '000000' })],
  });
}

/**
 * 将 parser 保留的文字片段映射到 Word Run。
 * 字体/字号/颜色统一取排版规格（fallback），不沿用网页原样式——
 * 否则 14px 灰色导语会渲染成 10.5pt 灰字，看起来仍像图注。
 * 仅保留真正的强调语义：加粗 / 斜体 / 下划线 / 删除线。
 */
function formattedRuns(block, fallback) {
  const runs = Array.isArray(block.runs) && block.runs.length ? block.runs : [{ text: block.text }];
  return runs.filter((run) => run.text).map((run) => new TextRun({
    text: run.text,
    font: fallback.font,
    size: fallback.size,
    bold: run.bold != null ? run.bold : fallback.bold,
    italics: run.italic != null ? run.italic : fallback.italics,
    underline: run.underline ? {} : undefined,
    strike: run.strike || undefined,
    color: fallback.color,
  }));
}

// ==================== 空格清理（汇编专用） ====================
// 与 clean_spaces.py 中的 clean_text 规则保持一致

// 零宽字符（规则 1）
const ZERO_WIDTH_CHARS = ['\u200b', '\ufeff'];
// 空格类字符（半角/全角/NBSP/Tab 及各 Unicode 空格）
const SPACE_CLASS = ' \u3000\u00a0\t\u2000-\u200a\u202f\u205f';
// 汉字（基本区）
const CJK = '\u4e00-\u9fff';
// 中文标点 + 全角符号
const CN_PUNCT =
  '\u3000-\u303f\uff00-\uffef\u2014\u2015\u2026\u2018\u2019\u201c\u201d\u00b7';
// 「中文相关字符」= 汉字 + 中文标点 + 全角符号
const CN_CHAR = CJK + CN_PUNCT;
// 数字（半角 + 全角）
const DIGIT = '0-9０-９';
// 拉丁字母（英文）
const LATIN = 'A-Za-z';
// 连字符（用于「数字与连字符之间」的空格清理）：- – — ~ ～
const DASH = '\\-\\u2013\\u2014\\u007e\\uff5e';
// 百分号（半角 + 全角）：用于「数字与百分号之间」的空格清理
const PERCENT = '%\uff05';

/**
 * 对单段文本按优先级执行 8 条空格清理规则：
 * 1. 删除零宽字符（U+200B / BOM U+FEFF）
 * 2. 删除两个「中文相关字符」之间的空格（所有空格类）
 * 3. 删除数字与汉字之间的空格（双向）
 * 4. 删除中文与英文之间的空格（双向）
 * 5. 删除数字与连字符（- – — ~ ～）之间的空格（双向）
 * 6. 删除数字与百分号（% ％）之间的空格
 * 7. 连续多个半角空格 → 合并成一个
 * 8. 删除行尾多余空格
 */
function cleanSpacesText(text) {
  if (!text) return text;

  // 规则 1：删除零宽字符
  for (const ch of ZERO_WIDTH_CHARS) {
    text = text.split(ch).join('');
  }

  // 规则 2：用正向预查实现重叠匹配，避免连续空格「隔一个删一个」
  text = text.replace(new RegExp(`([${CN_CHAR}])[${SPACE_CLASS}]+(?=[${CN_CHAR}])`, 'gu'), '$1');

  // 规则 3：数字与汉字之间（双向）
  text = text.replace(new RegExp(`([${DIGIT}])[${SPACE_CLASS}]+(?=[${CJK}])`, 'gu'), '$1');
  text = text.replace(new RegExp(`([${CJK}])[${SPACE_CLASS}]+(?=[${DIGIT}])`, 'gu'), '$1');

  // 规则 4：中文与英文之间（双向），如 "使用 Python 开发" -> "使用Python开发"
  text = text.replace(new RegExp(`([${CJK}])[${SPACE_CLASS}]+(?=[${LATIN}])`, 'gu'), '$1');
  text = text.replace(new RegExp(`([${LATIN}])[${SPACE_CLASS}]+(?=[${CJK}])`, 'gu'), '$1');
  // 规则 4b：中文相关字符后的空格——后随字符是英文引号 / 符号时规则 2 的
  // lookahead 覆盖不到（如「， "熊羽诺"」），这里统一删除；
  // 拉丁/数字与「中文标点/引号」之间的空格同理（如「of Youth （IOY）」）。
  text = text.replace(new RegExp(`([${CN_CHAR}])[${SPACE_CLASS}]+(?=[^${SPACE_CLASS}])`, 'gu'), '$1');
  text = text.replace(new RegExp(`([A-Za-z0-9])[${SPACE_CLASS}]+(?=[${CN_CHAR}])`, 'gu'), '$1');

  // 规则 5：数字与连字符之间（双向），如 "12 - 15岁" -> "12-15岁"
  text = text.replace(new RegExp(`([${DIGIT}])[${SPACE_CLASS}]+(?=[${DASH}])`, 'gu'), '$1');
  text = text.replace(new RegExp(`([${DASH}])[${SPACE_CLASS}]+(?=[${DIGIT}])`, 'gu'), '$1');

  // 规则 6：数字与百分号之间，如 "47 %" -> "47%"
  text = text.replace(new RegExp(`([${DIGIT}])[${SPACE_CLASS}]+(?=[${PERCENT}])`, 'gu'), '$1');

  // 规则 7：删除中文标点前的空格（删除引用标后常遗留，如 "47% ，"）。
  text = text.replace(new RegExp(`[${SPACE_CLASS}]+(?=[，。！？；：])`, 'gu'), '');

  // 规则 8：连续多个半角空格合并
  text = text.replace(/ {2,}/g, ' ');

  // 规则 9：行尾多余空格（多行模式）
  text = text.replace(new RegExp(`[${SPACE_CLASS}]+$`, 'gmu'), '');

  return text;
}

// ==================== 引用标删除（汇编专用） ====================
// 与 remove_citations.py 中的引用标正则保持一致

// 数字（半角 + 全角）
const CIT_DIGIT = '0-9０-９';
// 连字符（区间分隔符）变体：- – — ― ~ ～ － −
const CIT_DASH = '\\-\\u2013\\u2014\\u2015\\u007e\\uff5e\\uff0d\\u2212';
// 一个条目：单个数字，或「数字 - 数字」区间（连字符前后可含空格）
const CIT_RANGE = `[${CIT_DIGIT}]+\\s*(?:[${CIT_DASH}]\\s*[${CIT_DIGIT}]+)?`;
const CIT_ITEM = `\\s*${CIT_RANGE}`;
// 完整引用标：[ 项, 项, 项 ]
const CIT_RE = new RegExp(`\\[${CIT_ITEM}(?:,${CIT_ITEM})*\\]`, 'g');

/**
 * 删除正文文本中的参考文献引用标（如 [1]、[2,3]、[1-3]、[1,3-5]）。
 * 只删「方括号内仅含数字/逗号/空格/连字符」的引用标；
 * 含字母/中文等其他字符的方括号（化学式 [NaCl]、文字说明 [注1] 等）原样保留。
 */
function removeCitationMarks(text) {
  if (!text) return text;
  return text.replace(CIT_RE, '');
}

/**
 * 规范化重写二级标题（汇编专用）
 * 格式1｜纯序号：num（如 1、二）
 * 格式2｜阿拉伯数字序号 + 英文句点 + 文本：1.婚姻
 * 格式3｜中文数字序号 + 顿号 + 文本：一、婚姻
 * 前导零已在解析阶段去除（01 -> 1）
 */
function rewriteSubheading(block) {
  const num = block.num || '';
  const text = (block.subText || '').trim();
  if (block.pureNumber) {
    return num; // 格式1：纯序号
  }
  if (block.numType === 'arabic') {
    return `${num}.${text}`; // 格式2
  }
  return `${num}、${text}`; // 格式3
}

/**
 * 去掉小标题开头的数字序号前缀（汇编下统一重新编号时使用）
 * 支持：
 *   多级阿拉伯：1.01 xxx / 1.1.1 xxx / 01.1 xxx
 *   单级阿拉伯：1. xxx / 1) xxx / (1) xxx / 1、 xxx
 *   中文序号：   一、xxx / 第一、xxx
 *   圆圈数字：   ① xxx
 * 只在 subheading 上调用，不影响普通正文（避免误删"1.1 万亿元"这类带数量单位的正文）
 */
function stripLeadingNumbering(text) {
  let t = (text || '').trim();
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^\d+(?:\.\d+)+\s+/, '')             // 1.01 + 空格
      .replace(/^\d+[.\-－、]\s+/, '')               // 1. / 1- / 1、
      .replace(/^\d+[)）]\s*/, '')                   // 1) / 1）
      .replace(/^[（(]\d+[)）]\s*/, '')               // (1) / （1）
      .replace(/^\d+、\s*/, '')                       // 1、 + 空格
      .replace(/^[一二三四五六七八九十]+、\s*/, '')     // 一、
      .replace(/^第[一二三四五六七八九十百千万]+、\s*/, '')
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '');
  } while (t !== prev);
  return t.trim();
}

// 中文序号（用于纯数字小标题按顺序输出「一/二/三…」）
const CN_SEQ = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

/**
 * 纯数字序号小标题在汇编下按出现顺序输出纯序号：
 * numType 为 chinese 时输出中文数字（一/二/三…），否则输出阿拉伯数字（1/2/3…）。
 */
function toSequenceLabel(count, numType) {
  if (numType === 'chinese') return CN_SEQ[count] || String(count);
  return String(count);
}

/**
 * 合并连续的「删除类」块为一条红色预警。
 * 删除类 = deleted 噪声块 +（汇编下）文末相关推荐链接块。
 * 只要中间没有正文（paragraph/heading/caption/image 等），连续多个删除类块就合并成一条。
 */
function mergeConsecutiveDeletedBlocks(blocks, { treatRecommendAsDeleted = false } = {}) {
  const out = [];
  let i = 0;
  const isDeleted = (b) =>
    b.type === 'deleted' || (treatRecommendAsDeleted && b.type === 'recommendLink');

  while (i < blocks.length) {
    if (isDeleted(blocks[i])) {
      const labels = [];
      const texts = [];
      while (i < blocks.length && isDeleted(blocks[i])) {
        const b = blocks[i];
        const label = b.type === 'recommendLink' ? '相关推荐链接' : b.label;
        if (label && !labels.includes(label)) labels.push(label);
        if (b.type === 'recommendLink' && b.text) texts.push(b.text);
        i++;
      }
      out.push({
        type: 'deleted',
        label: labels.join('、'),
        text: texts.join(' | '),
        merged: true,
      });
    } else {
      out.push(blocks[i]);
      i++;
    }
  }
  return out;
}

/**
 * 构建文档
 * @param {{title:string, author:string, editor:string, account:string, category:string, blocks:Array, references:Array}} data
 * @returns {Promise<Buffer>}
 */
function buildArticleChildren(data, { refPageBreak = false, cleanBody = false } = {}) {
  const { title, author, editor, category, references } = data;
  // 文末「头图/封面 《片名》」提取出的片名，挂在开头第一张嵌入图片后
  const headImageCredit = data.headImageCredit || '';
  let headImageCreditUsed = false;
  const copiedBlocks = (data.blocks || []).map((b) => ({ ...b, runs: b.runs && b.runs.map((r) => ({ ...r })) }));
  const blocks = cleanBody ? classifyCaptions(copiedBlocks) : copiedBlocks;
  const children = [];

  // ===== 主标题（样式标记为「标题1」，便于大纲/导航；外观保持既有排版） =====
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          // 主标题中的空格属于原文排版的一部分，不参与汇编正文空格清理。
            text: title || '（无标题）',
          font: FONT_TITLE,
          size: SZ.h1,
          bold: true,
          color: COLOR.title,
        }),
      ],
    })
  );

  // ===== 作者 / 编辑不再输出 =====
  // 署名信息已在解析阶段按「作者信息区」删除；这里也不再单独渲染
  // 「作者：xx / 编辑：xx」行（需求方要求文档中不出现作者信息）。
  void author; void editor;

  // ===== 合并连续的删除类块（噪声删除 + 相关推荐链接）为一条红色预警 =====
  const effectiveBlocks = mergeConsecutiveDeletedBlocks(blocks, {
    treatRecommendAsDeleted: cleanBody,
  });

  // ===== 正文块 =====
  let headingCount = 0; // 汇编下无序号的小标题按出现顺序补「1./2./3.」序号（每篇文章从 1 起）

  // 正文小标题数量；「实锤有小标题」需要 ≥ 2，只有 1 处大概率是误识别（如作者名）。
  // 署名行已在解析阶段统一删除（作者信息区），这里无需再区分「作者栏」。
  // level 3（章节内细分标题）一律按正文处理，不计入小标题数量判断。
  const bodyHeadingCount = effectiveBlocks.filter(
    (b) => (b.type === 'heading' || b.type === 'subheading') && b.pureNumber !== true && b.level !== 3
  ).length;
  // 文字式小标题优先：≥2 处即实锤，文字要展现出来并转成规范标题 2（序号图只在「无文字小标题」时兜底）
  const hasTextHeadings = bodyHeadingCount >= 2;

  let sepHeadingCount = 0; // 汇编下无小标题时，序号分隔符图（§1/6 等）按顺序替换为「1/2/3…」标题 2
  for (let bi = 0; bi < effectiveBlocks.length; bi++) {
    const block = effectiveBlocks[bi];
    // 空格清理对单篇与汇编统一生效（谷雨等版式的「， 鼓励」类残留空格单篇同样需要删）；
    // 引用标删除仍仅限汇编（单篇保留原文引用注记）。
    // 主标题/小标题中的空格属于原文排版，豁免空格清理；参考文献独立存储，天然原样保留。
    if (typeof block.text === 'string') {
      if (cleanBody) block.text = removeCitationMarks(block.text);
      const isHeading = block.type === 'heading' || block.type === 'subheading';
      if (!isHeading) block.text = cleanSpacesText(block.text);
      // 解析器保留的 runs 同步清理，避免 Word 优先输出旧 run 文本而绕过清理规则。
      if (!isHeading && Array.isArray(block.runs)) {
        block.runs = block.runs.map((run) => ({
          ...run,
          text: cleanSpacesText(cleanBody ? removeCitationMarks(run.text || '') : (run.text || '')),
        }));
        if (block.runs.length > 1) cleanCrossRunSpaces(block.runs);
      }
      // 图注中的「图片说明 + 图源」需要可读间隔；通用空格清理会移除中文之间的半角空格，
      // 因此在清理之后，仅对图注末尾的来源字段补回一个空格。
      if (block.type === 'caption') {
        block.text = block.text.replace(
          /(\S)(?=(?:图源|图片来源|供图)\s*[^，。；;]{0,20}$)/,
          '$1 '
        );
      }
    }
    switch (block.type) {
      case 'chapterSeparator': {
        // 序号分隔图（原文的「1.」章节序号条 / § 1/6 小图）：
        // 单篇此前被直接跳过，导致原文的章节序号在 Word 里消失（谷雨实验室等版式）；
        // 汇编下有文字式小标题时序号由文字标题承担，避免双重编号，仍跳过。
        if (!cleanBody || !hasTextHeadings) {
          // 谷雨实验室版式：序号图后面紧跟文字标题（「3.」+「教育实验和真人秀」），
          // 两者要合并成一个二级标题，而不是拆成「3.」「教育实验和真人秀」两条。
          const next = effectiveBlocks[bi + 1];
          const nextHeading =
            next && next.type === 'subheading' && next.level !== 3 && next.pureNumber !== true ? next : null;
          sepHeadingCount++;
          let label = `${sepHeadingCount}.`;
          if (nextHeading) {
            const headingText = (
              cleanBody
                ? (nextHeading.subText && nextHeading.subText.trim()) || stripLeadingNumbering(nextHeading.text)
                : nextHeading.text
            ).trim();
            label = `${sepHeadingCount}. ${headingText}`;
            bi += 1; // 文字标题已并入，跳过
          }
          children.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              alignment: AlignmentType.CENTER,
              spacing: { before: 200, after: 120 },
              children: [
                new TextRun({
                  text: label,
                  font: FONT_TITLE,
                  size: SZ.h2,
                  bold: true,
                  color: COLOR.title,
                }),
              ],
            })
          );
        }
        break;
      }
      case 'subheading': {
        if (category === '汇编') {
          if (block.pureNumber === true) {
            // 纯数字序号小标题（"01"/"一" 等单独成行）：无文字小标题时按顺序输出纯序号
            // （1/2/3 或 一/二/三），不带 "1." 前缀、不带原序号；有文字小标题时丢弃（序号由文字式小标题承担）。
            if (cleanBody && !hasTextHeadings) {
              sepHeadingCount++;
              const label = toSequenceLabel(sepHeadingCount, block.numType);
              children.push(
                new Paragraph({
                  heading: HeadingLevel.HEADING_2,
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 200, after: 120 },
                  children: [
                    new TextRun({
                      text: label,
                      font: FONT_TITLE,
                      size: SZ.h2,
                      bold: true,
                      color: COLOR.title,
                    }),
                  ],
                })
              );
            }
          } else if (block.level === 3) {
            // 章节内细分标题：Word 标题层级只做到「标题2」，细分标题一律视为正文，
            // 保留原文文字（不重新编号、不套用标题样式）。
            children.push(
              new Paragraph({
                spacing: { after: 160, line: 276, lineRule: 'auto' },
                children: formattedRuns(block, { font: FONT_BODY, size: SZ.body, color: '000000' }),
              })
            );
          } else if (hasTextHeadings) {
            // 汇编下：一级小标题按出现顺序重新编号为 1./2./3.
            // 原文里的数字序号（如 "1.01"、"一、"）会被丢弃，避免与重新编号冲突
            headingCount++;
            // 优先用 parser 已剥离序号的 subText，否则用 stripLeadingNumbering 兜底清理
            const cleanedText = (block.subText && block.subText.trim())
              || stripLeadingNumbering(block.text);
            const text = `${headingCount}.${cleanedText.trim()}`;
            children.push(
              new Paragraph({
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 200, after: 120 },
                children: [
                  new TextRun({
                    text,
                    font: FONT_TITLE,
                    size: SZ.h2,
                    bold: true,
                    color: COLOR.title,
                  }),
                ],
              })
            );
          } else {
            // 未达 2 处的疑似小标题 → 降级为普通正文，不转标题、不补序号
            children.push(
              new Paragraph({
                spacing: { after: 160, line: 276, lineRule: 'auto' },
                children: formattedRuns(block, { font: FONT_BODY, size: SZ.body, color: '000000' }),
              })
            );
          }
        } else if (block.level === 3) {
          // 非汇编板块的章节内细分标题：同样视为正文，保留原文文字与格式
          children.push(
            new Paragraph({
              spacing: { after: 160, line: 276, lineRule: 'auto' },
              children: formattedRuns(block, { font: FONT_BODY, size: SZ.body, color: '000000' }),
            })
          );
        } else {
          // 非汇编板块（轻心理 / 轻纪实）：外观沿用既有排版（等线 20pt 加粗），
          // 同时挂「标题 2」大纲级别——此前只做了外观，Word 导航/目录里看不到小标题层级。
          // run 级属性优先于样式，故字体字号颜色不受内置样式影响。
          children.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 240, after: 160 },
              children: [
                new TextRun({
                  text: block.text,
                  font: FONT_TITLE,
                  size: SZ.h2,
                  bold: true,
                  color: COLOR.title,
                }),
              ],
            })
          );
        }
        break;
      }

      case 'copyright': {
        // 图源版权声明（视觉中国/东方IC/人民视觉等图库）：红色加粗提醒
        children.push(
          new Paragraph({
            spacing: { after: 160, line: 276, lineRule: 'auto' },
            children: [
              new TextRun({
                text: block.text,
                font: FONT_BODY,
                size: SZ.body,
                bold: true,
                color: COLOR.warn,
              }),
            ],
          })
        );
        break;
      }

      case 'paragraph':
        children.push(
          new Paragraph({
            spacing: { after: 160, line: 276, lineRule: 'auto' },
            children: formattedRuns(block, { font: FONT_BODY, size: SZ.body, color: '000000' }),
          })
        );
        break;

      case 'recommendLink': {
        // 文末「相关推荐」站内跳转链接：
        // 汇编板块（cleanBody）删除并红色预警；单篇板块保留原文
        if (cleanBody) {
          children.push(
            new Paragraph({
              spacing: { before: 80, after: 80 },
              children: [
                new TextRun({
                  text: `【此处已删除：相关推荐链接】${block.text}`,
                  font: FONT_BODY,
                  size: SZ.caption,
                  bold: true,
                  color: COLOR.deleted,
                }),
              ],
            })
          );
        } else {
          children.push(
            new Paragraph({
              spacing: { after: 160, line: 276, lineRule: 'auto' },
              children: [
                new TextRun({
                  text: block.text,
                  font: FONT_BODY,
                  size: SZ.body,
                  color: '000000',
                }),
              ],
            })
          );
        }
        break;
      }

      case 'caption': {
        // 图注：若含版权图库关键词（轻纪实 / 汇编），红色提醒
        const isCopyright = (category === '轻纪实' || category === '汇编') && containsCopyright(block.text);

        if (category === '汇编') {
          // 汇编图注：统一使用 Word 内置「引用」样式
          // 情况A（影视截图类）：图注仅为片名《xxx》→ 改写为「图源：《xxx》」
          // 情况B（其他）：保持原文表述不变
          // 情况C（版权声明类）：含版权图库关键词 → 文字红色加粗提醒
          let captionText = block.text;
          if (/^《[^》]+》$/.test(captionText.trim())) {
            captionText = '图源：' + captionText.trim();
          }
          const captionBlock = captionText === block.text ? block : { ...block, text: captionText, runs: [{ text: captionText }] };
          const quoteRuns = isCopyright
            ? [new TextRun({ text: captionText, color: COLOR.warn, bold: true })]
            : formattedRuns(captionBlock, { font: FONT_BODY, size: SZ.caption, color: COLOR.caption, italics: true });
          children.push(
            new Paragraph({
              style: 'Quote',
              alignment: AlignmentType.CENTER,
              spacing: { after: 80 },
              children: quoteRuns,
            })
          );
        } else {
          const captionRuns = [];
          if (category === '轻纪实') {
            // 轻纪实图注：▲ 橙色 + 文字灰色 9pt
            const m = block.text.match(/^([▲△]\s*)(.*)$/);
            if (m) {
              captionRuns.push(new TextRun({ text: m[1], font: FONT_BODY, size: SZ.ref, color: 'F7C93F' }));
              const restRun = {
                text: m[2],
                font: FONT_BODY,
                size: SZ.ref,
                color: isCopyright ? COLOR.warn : COLOR.caption,
              };
              if (isCopyright) restRun.bold = true;
              captionRuns.push(new TextRun(restRun));
            } else {
              const run = {
                text: block.text,
                font: FONT_BODY,
                size: SZ.ref,
                color: isCopyright ? COLOR.warn : COLOR.caption,
              };
              if (isCopyright) run.bold = true;
              captionRuns.push(new TextRun(run));
            }
          } else {
            // 轻心理图注：12pt 黑色
            captionRuns.push(
              new TextRun({
                text: block.text,
                font: FONT_BODY,
                size: SZ.body,
                color: '000000',
              })
            );
          }
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 80 },
              children: captionRuns,
            })
          );
        }
        if (isCopyright) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 120 },
              children: [
                new TextRun({
                  text: '【注意：图片来源于视觉中国/东方IC/人民视觉等图库，请注意版权标注】',
                  font: FONT_BODY,
                  size: SZ.caption,
                  bold: true,
                  color: COLOR.warn,
                }),
              ],
            })
          );
        }
        break;
      }

      case 'image': {
        if (block.buffer && block.buffer.length > 0) {
          const ratio = block.ratio || 0.75;
          const height = Math.max(10, Math.round(IMAGE_WIDTH_PX * ratio));
          try {
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 80, after: 80 },
                children: [
                  new ImageRun({
                    type: block.ext || 'jpeg',
                    data: block.buffer,
                    transformation: { width: IMAGE_WIDTH_PX, height },
                    altText: { title: '图片', description: '正文图片', name: 'image' },
                  }),
                ],
              })
            );
            // 文末「头图/封面 《片名》」的片名，挂到文档第一张实际嵌入的图片后作为图注。
            // （挂在实际嵌入的图上，避免动图/装饰图被过滤后图注孤立在开头）
            if (!headImageCreditUsed && headImageCredit) {
              headImageCreditUsed = true;
              children.push(captionParagraph(headImageCredit, category));
            }
          } catch (e) {
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '【图片加载失败】', color: '999999', size: SZ.caption }),
                ],
              })
            );
          }
        }
        break;
      }

      case 'deleted': {
        // 噪声删除标注（红色醒目）；合并块额外附上被删的相关推荐链接文字
        const deletedText =
          block.merged && block.text
            ? `【此处已删除：${block.label}】${block.text}`
            : `【此处已删除：${block.label}】`;
        children.push(
          new Paragraph({
            spacing: { before: 80, after: 80 },
            children: [
              new TextRun({
                text: deletedText,
                font: FONT_BODY,
                size: SZ.caption,
                bold: true,
                color: COLOR.deleted,
              }),
            ],
          })
        );
        break;
      }

      case 'video':
      case 'audio':
        // 音视频无法嵌入 Word（且多为公众号开头的朗读音频/引导视频），直接删除，不再输出占位提示
        break;
    }
  }

  // ===== 参考文献 =====
  if (references && references.length > 0) {
    children.push(
      new Paragraph({
        spacing: { before: 240, after: 120 },
        pageBreakBefore: refPageBreak,
        children: [
          new TextRun({ text: '参考文献：', font: FONT_REF, size: SZ.ref, color: COLOR.ref }),
        ],
      })
    );
    for (const ref of references) {
      children.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({ text: ref, font: FONT_REF, size: SZ.ref, color: COLOR.ref }),
          ],
        })
      );
    }
  }

  return children;
}

/**
 * 构建单篇文档
 */
async function buildDocx(data) {
  // 单篇与汇编一致：参考文献始终从新页开始。
  const children = buildArticleChildren(data, { refPageBreak: true, cleanBody: data.category === '汇编' });
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/**
 * 构建汇编文档：将多篇文章按顺序整合到一个 Word，每篇另起一页
 * @param {Array} articles 已解析的文章数据数组（含图片 buffer）
 */
async function buildAssembleDocx(articles) {
  const sections = articles.map((article, idx) => ({
    properties: {
      type: idx === 0 ? undefined : SectionType.NEXT_PAGE,
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: buildArticleChildren(article, { refPageBreak: true, cleanBody: true }),
  }));

  const doc = new Document({
    styles: {
      paragraphStyles: [QUOTE_STYLE],
    },
    sections,
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocx, buildAssembleDocx, cleanSpacesText, removeCitationMarks, cleanCrossRunSpaces };
