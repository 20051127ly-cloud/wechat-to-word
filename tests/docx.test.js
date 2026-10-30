'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Jimp = require('jimp');
const { buildDocx, buildAssembleDocx } = require('../src/docxBuilder');
const { parseArticle } = require('../src/parser');
const { parseFixture, articleHtml, heading, bodyParagraph, readDocx } = require('./support');

function dataWithBlocks(blocks, overrides = {}) {
  return { title: '测试 标题', account: '测试公众号', author: '', editor: '', category: '汇编', references: [], blocks, ...overrides };
}

function assertRedBold(paragraph) {
  assert.ok(paragraph, '缺少版权段落');
  assert.ok(paragraph.runs.filter((r) => r.text).every((r) => r.color === 'FF0000' && r.bold), '版权文字必须全部红色加粗');
}

test('DOCX/单篇下章节序号图渲染为「1.」「2.」章节标题', async () => {
  const sepImg = '<p><img data-src="https://example.invalid/sep1.png" data-w="1080" data-ratio="0.1"></p>';
  const data = parseArticle(articleHtml(sepImg + bodyParagraph + sepImg + bodyParagraph));
  data.category = '轻纪实';
  const texts = readDocx(await buildDocx(data)).paragraphs.map((p) => p.text);
  assert.ok(texts.includes('1.'), '单篇输出缺少章节序号 1.');
  assert.ok(texts.includes('2.'), '单篇输出缺少章节序号 2.');
});

test('DOCX/轻纪实文末图源声明按图注样式渲染（灰色小字，非正文黑）', async () => {
  const note = '头图、封面图及配图来自文中人物。';
  const data = parseArticle(articleHtml(bodyParagraph + `<p>${note}</p>`));
  data.category = '轻纪实';
  const { paragraphs } = readDocx(await buildDocx(data));
  const p = paragraphs.find((item) => item.text === note);
  assert.ok(p, '缺少图源声明段落');
  assert.ok(p.runs.length > 0, '图源声明不能为空');
  assert.ok(p.runs.every((r) => r.color === '8A8989'), '图源声明应为图注灰色，不能是正文样式');
});

test('DOCX/解析到导出：只有三个标题2，不输出标题3、不改细分编号', async () => {
  const data = parseFixture('nested-size-sequence');
  data.category = '汇编';
  const { paragraphs } = readDocx(await buildAssembleDocx([data]));
  assert.equal(paragraphs.filter((p) => p.style === 'Heading1').length, 1);
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.准备', '2.观察', '3.行动']);
  assert.ok(!paragraphs.some((p) => /^Heading[3-9]$/.test(p.style)));
  for (const text of ['1. 记录天气', '2. 查看地图', '3. 准备行李', '4. 按时出发']) {
    const paragraph = paragraphs.find((p) => p.text === text);
    assert.ok(paragraph, `缺少细分标题原文：${text}`);
    assert.ok(!paragraph.style.startsWith('Heading'));
  }
});

for (const category of ['轻心理', '轻纪实']) {
  test(`DOCX/单篇（${category}）小标题进入标题 2 大纲层级且保持既有排版`, async () => {
    const data = parseArticle(articleHtml(heading('一、晨间') + bodyParagraph + heading('二、午后') + bodyParagraph));
    data.category = category;
    const { paragraphs } = readDocx(await buildDocx(data));
    // 主标题是标题 1
    assert.equal(paragraphs[0].style, 'Heading1');
    const h2 = paragraphs.filter((p) => p.style === 'Heading2');
    assert.deepEqual(h2.map((p) => p.text), ['一、晨间', '二、午后'], '小标题必须出现在大纲层级里');
    for (const p of h2) {
      const run = p.runs[0];
      assert.equal(run.size, '40', '小标题字号保持 20pt（half-points 40）');
      assert.equal(run.color, '0F4761', '小标题颜色保持既有排版');
      assert.equal(run.font, '等线', '小标题字体保持既有排版');
      assert.ok(run.bold, '小标题保持加粗');
    }
  });
}

test('DOCX/头图片名挂到首张实际嵌入图片后，并按本板块图注样式排版', async () => {
  const png = await new Jimp(20, 20, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const blocks = [
    // 第一张没有 buffer（动图/被过滤的装饰图），图注不能挂到它后面
    { type: 'image', src: 'https://example.invalid/skip.png' },
    { type: 'image', src: 'https://example.invalid/real.png', buffer: png, ext: 'png', ratio: 1 },
    { type: 'paragraph', text: '这是一段足够长的普通正文，用来确认图注位置是否紧贴首张图片。' },
  ];
  for (const [category, expectedSize, expectedColor] of [['轻心理', '24', '000000'], ['轻纪实', '18', '8A8989']]) {
    const data = dataWithBlocks(blocks.map((b) => ({ ...b })), { category, headImageCredit: '《我，到点下班》' });
    const { paragraphs } = readDocx(await buildDocx(data));
    const index = paragraphs.findIndex((p) => p.text === '《我，到点下班》');
    assert.ok(index > 0, `${category}：缺少头图图注`);
    assert.equal(paragraphs[index].alignment, 'center', `${category}：图注应居中`);
    const run = paragraphs[index].runs[0];
    assert.equal(run.size, expectedSize, `${category}：图注字号应符合本板块图注`);
    assert.equal(run.color, expectedColor, `${category}：图注颜色应符合本板块图注`);
    // 只输出一次
    assert.equal(paragraphs.filter((p) => p.text === '《我，到点下班》').length, 1);
  }
});

test('DOCX/无头图标注时不凭空生成图注', async () => {
  const png = await new Jimp(20, 20, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const blocks = [{ type: 'image', src: 'https://example.invalid/real.png', buffer: png, ext: 'png', ratio: 1 }];
  const { paragraphs } = readDocx(await buildDocx(dataWithBlocks(blocks, { category: '轻心理' })));
  assert.ok(!paragraphs.some((p) => /^图源：/.test(p.text)));
});

test('DOCX/章节序号图与紧随的文字标题合并为一个二级标题', async () => {
  const sep = () => ({ type: 'chapterSeparator', src: 'https://example.invalid/sep.png' });
  const headingOf = (text) => ({ type: 'subheading', level: 2, text, subText: text });
  const body = { type: 'paragraph', text: '这是一段足够长的普通正文，用来隔开章节并保留上下文结构。' };
  const blocks = [sep(), headingOf('教育实验和真人秀'), body, sep(), headingOf('母亲'), body];
  const { paragraphs } = readDocx(await buildDocx(dataWithBlocks(blocks, { category: '轻纪实' })));
  const h2 = paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text);
  assert.deepEqual(h2, ['1. 教育实验和真人秀', '2. 母亲'], '序号与文字标题不能拆成两条');
  // 被合并的文字标题不再单独出现
  assert.ok(!paragraphs.some((p) => p.text === '教育实验和真人秀'));
});

test('DOCX/章节序号图后无文字标题时保持纯序号', async () => {
  const blocks = [
    { type: 'chapterSeparator', src: 'https://example.invalid/sep.png' },
    { type: 'paragraph', text: '这是一段足够长的普通正文，用来隔开章节并保留上下文结构。' },
    { type: 'chapterSeparator', src: 'https://example.invalid/sep.png' },
    { type: 'paragraph', text: '这是另一段足够长的普通正文，用来确认序号独立输出正确。' },
  ];
  const { paragraphs } = readDocx(await buildDocx(dataWithBlocks(blocks, { category: '轻纪实' })));
  const h2 = paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text);
  assert.deepEqual(h2, ['1.', '2.']);
});

test('DOCX/单篇同样清理中文标点后的空格，并保留英文词间空格', async () => {
  const text = '一位15岁的小姑娘分享她的梦想。她是 International Organization of Youth（IOY）的青年大使， 鼓励别的女孩不要放弃学习和梦想。';
  const data = parseArticle(articleHtml(`<p>${text}</p>` + bodyParagraph));
  data.category = '轻纪实';
  const { paragraphs } = readDocx(await buildDocx(data));
  const p = paragraphs.find((item) => item.text.includes('青年大使'));
  assert.ok(p, '缺少目标段落');
  assert.ok(p.text.includes('大使，鼓励别的女孩'), `中文逗号后的空格应删除，实际：${p.text}`);
  assert.ok(p.text.includes('International Organization of Youth'), '英文词间空格应保留一个');
  assert.ok(!/[，。；]\s/.test(p.text), '不应残留中文标点+空格');
});

test('DOCX/跨 run 边界的空格同样清理，英文词间空格不受影响', async () => {
  const blocks = [{
    type: 'paragraph',
    text: '第二年10月，德国学者 Tobias Dornheim带领团队， "熊羽诺"是主角。',
    runs: [
      { text: '第二年' },
      { text: '10' },
      { text: '月，德国学者' },
      { text: ' Tobias Dornheim' }, // 空格在 run 开头，前一无上下文
      { text: '带领团队，' },
      { text: ' "熊羽诺"是主角。' }, // 中文标点 + 空格 + 中文引号
    ],
  }];
  const data = dataWithBlocks(blocks, { category: '轻纪实' });
  const { paragraphs } = readDocx(await buildDocx(data));
  const p = paragraphs.find((item) => item.text.includes('Dornheim'));
  assert.ok(p, '缺少目标段落');
  assert.ok(!p.text.includes('学者 '), `中文与英文间的跨 run 空格应删除，实际：${JSON.stringify(p.runs.map((r) => r.text))}`);
  assert.ok(p.text.includes('带领团队，"熊羽诺"'), `中文标点后的跨 run 空格应删除，实际：${p.text}`);
  assert.ok(p.text.includes('Tobias Dornheim'), '英文词间空格保留');
});

test('DOCX/汇编同样具备目录层级与头图片名图注', async () => {
  const png = await new Jimp(20, 20, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  const blocks = [
    { type: 'image', src: 'https://example.invalid/cover.png', buffer: png, ext: 'png', ratio: 1 },
    { type: 'subheading', level: 2, text: '一、晨间', subText: '晨间' },
    { type: 'paragraph', text: '这是一段足够长的普通正文，用来隔开两个章节并保留上下文。' },
    { type: 'subheading', level: 2, text: '二、午后', subText: '午后' },
    { type: 'paragraph', text: '这是另一段足够长的普通正文，用来确认章节结构完整输出。' },
    { type: 'caption', text: '图源网络' },
  ];
  const data = dataWithBlocks(blocks.map((b) => ({ ...b })), { category: '汇编', headImageCredit: '《我，到点下班》' });
  const { paragraphs } = readDocx(await buildAssembleDocx([data]));

  // 目录层级：主标题 = 标题1，小标题 = 标题2（汇编统一重编号）
  assert.equal(paragraphs[0].style, 'Heading1');
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.晨间', '2.午后']);

  // 头图片名：挂在第一张实际嵌入的图片后，且不额外加「图源：」前缀
  const creditIndex = paragraphs.findIndex((p) => p.text === '《我，到点下班》');
  assert.ok(creditIndex > 0, '汇编缺少头图片名图注');
  assert.equal(paragraphs.filter((p) => /^图源：/.test(p.text)).length, 0, '不应凭空添加「图源：」前缀');

  // 图注样式：汇编沿用 Quote 样式（10pt 灰斜体）
  const credit = paragraphs[creditIndex];
  assert.equal(credit.style, 'Quote', '汇编图注应使用 Quote 样式');
  assert.equal(credit.runs[0].size, '20');
  assert.equal(credit.runs[0].color, '8A8989');
  const caption = paragraphs.find((p) => p.text === '图源网络');
  assert.equal(caption.style, 'Quote', '汇编正文图注也应使用 Quote 样式');
});

test('DOCX/单篇模式的细分标题也不进入标题大纲', async () => {
  const data = parseFixture('nested-size-sequence');
  data.category = '轻心理';
  const { paragraphs } = readDocx(await buildDocx(data));
  assert.ok(paragraphs.some((p) => p.text === '1. 记录天气' && !p.style.startsWith('Heading')));
  assert.ok(!paragraphs.some((p) => /^Heading[3-9]$/.test(p.style)));
});

test('DOCX/纯中文序号保留汉字，带文字的标题沿用当前统一重编号规则', async () => {
  const pure = parseFixture('single-chinese-number');
  pure.category = '汇编';
  assert.deepEqual(readDocx(await buildAssembleDocx([pure])).paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['一', '二', '三']);
  const titled = parseFixture('pt-parent-child');
  titled.category = '汇编';
  assert.deepEqual(readDocx(await buildAssembleDocx([titled])).paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.日程', '2.故事']);
});

test('DOCX/合并标题后不存在 4.04 双重编号', async () => {
  const data = parseFixture('split-heading-number');
  data.category = '汇编';
  const texts = readDocx(await buildAssembleDocx([data])).paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text);
  assert.deepEqual(texts, ['1.准备', '2.观察', '3.记录', '4.先观察，再行动']);
});

test('DOCX/作者信息不输出到文档，原署名也不在正文重复', async () => {
  const data = parseFixture('byline-before-calibration');
  data.category = '汇编';
  const { paragraphs } = readDocx(await buildAssembleDocx([data]));
  assert.equal(paragraphs[0].style, 'Heading1');
  // 需求：文档中不出现任何作者/编辑署名信息
  assert.ok(!paragraphs.some((p) => p.text.includes('作者：')));
  assert.ok(!paragraphs.some((p) => p.text.includes('编辑：')));
  assert.ok(!paragraphs.some((p) => p.text.includes('采写 | 明亮')));
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.晨间散步', '2.午后阅读']);
});

test('DOCX/图注实际采用 Quote 样式，图片有关系引用且嵌入 ZIP', async () => {
  const data = parseFixture('caption-period');
  data.category = '汇编';
  const images = data.blocks.filter((b) => b.type === 'image');
  for (const [index, block] of images.entries()) {
    const bitmap = new Jimp(8 + index, 8, 0xffffffff);
    block.buffer = await bitmap.getBufferAsync(Jimp.MIME_PNG);
    block.ext = 'png';
  }
  const { zip, $, paragraphs } = readDocx(await buildAssembleDocx([data]));
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Quote').map((p) => p.text), ['吉林白山。', '吉林珲春。', '黑龙江虎林。', '拍摄：示例作者。', '绥芬河。']);
  assert.equal($('w\\:drawing').length, 5);
  const cheerio = require('cheerio');
  const relationships = cheerio.load(zip.readAsText('word/_rels/document.xml.rels'), { xmlMode: true });
  for (const element of $('a\\:blip').toArray()) {
    const id = $(element).attr('r:embed');
    const relationship = relationships('Relationship').toArray().find((r) => relationships(r).attr('Id') === id);
    assert.ok(relationship, `缺少图片引用 ${id}`);
    assert.ok(zip.getEntry(`word/${relationships(relationship).attr('Target')}`), '图片文件必须真实存在于 ZIP 中');
  }
  const styles = cheerio.load(zip.readAsText('word/styles.xml'), { xmlMode: true });
  const quote = styles('w\\:style').filter((_, node) => styles(node).attr('w:styleId') === 'Quote');
  assert.equal(quote.find('w\\:basedOn').attr('w:val'), 'Normal');
  assert.equal(quote.find('w\\:i').length, 1);
});

test('DOCX/保留旧版图片后片名与较长短说明识别', async () => {
  const texts = ['《森林日记》', '*《森林日记》中的小屋', '上野千鹤子与李小江', '今年暑期的阿那亚北岸，小朋友们在户外喷泉中玩水纳凉'];
  const blocks = texts.flatMap((text) => [{ type: 'image' }, { type: 'paragraph', text }]);
  const { paragraphs } = readDocx(await buildAssembleDocx([dataWithBlocks(blocks)]));
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Quote').map((p) => p.text), ['图源：《森林日记》', ...texts.slice(1)]);
});

for (const category of ['汇编', '轻心理', '轻纪实']) {
  test(`DOCX/版权声明在${category}均保留并红色加粗`, async () => {
    const data = parseFixture('copyright-after-end');
    data.category = category;
    const buffer = category === '汇编' ? await buildAssembleDocx([data]) : await buildDocx(data);
    const { paragraphs } = readDocx(buffer);
    assertRedBold(paragraphs.find((p) => p.text === '题图来源：视觉中国'));
    assert.ok(paragraphs.some((p) => p.text === '第一条附注。'));
    assert.ok(!paragraphs.some((p) => p.text.includes('第二条附注必须删除') || p.text.includes('完—')));
  });
}

test('DOCX/清理正文空格和引用标，但标题和参考文献的空格保留', async () => {
  const data = parseArticle(articleHtml(heading('01 春 天') + bodyParagraph + heading('02 夏 天') + bodyParagraph + '<p>提升 47 % [1]，使用 Python 开发。</p>'));
  Object.assign(data, { category: '汇编', title: '春 天', references: ['[1] Author A. 47 % study.'] });
  const { paragraphs } = readDocx(await buildAssembleDocx([data]));
  assert.equal(paragraphs[0].text, '春 天');
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.春 天', '2.夏 天']);
  // 必须来自 parseArticle 的带 runs 正文，不能用手工无-runs block 伪造通过。
  assert.ok(paragraphs.some((p) => p.text === '提升47%，使用Python开发。'));
  assert.ok(paragraphs.some((p) => p.text === '[1] Author A. 47 % study.'));
});

test('DOCX/单篇参考文献从新页开始', async () => {
  const data = parseArticle(articleHtml('<p>正文内容。</p><section><strong>📄 参考文献</strong></section><p>[1] Example Reference.</p>'));
  const { $ } = readDocx(await buildDocx(data));
  const referenceTitle = $('w\\:p').filter((_, node) => $(node).find('w\\:t').text() === '参考文献：');
  assert.equal(referenceTitle.length, 1);
  assert.equal(referenceTitle.find('w\\:pageBreakBefore').length, 1);
});

test('DOCX/谷雨尾段只输出一次且不含腾讯新闻来源尾注', async () => {
  const last = '如果有一天，我很疲倦了，我仍然愿意回到舞台继续表演。';
  const body = `<section><span>${last}</span><span><img data-src="https://mmbiz.qpic.cn/mmbiz_png/YulpgP4g2QLtwd7aY4PhcYIYapVuObiaCxHmiaxl55EchrPoBSlVLsTwnxsJJIok1nRIibXHSmu8ibKC8plzSUOkIg/640" data-w="804" data-ratio="0.9975"></span><span>（来源：腾讯新闻）</span></section>`;
  const data = parseArticle(articleHtml(body, { account: '谷雨实验室' }));
  data.category = '汇编';
  const texts = readDocx(await buildAssembleDocx([data])).paragraphs.map((p) => p.text);
  assert.equal(texts.filter((text) => text === last).length, 1);
  assert.ok(!texts.some((text) => text.includes('来源：腾讯新闻')));
});

test('DOCX/多篇汇编的章节编号每篇重新开始', async () => {
  const articles = [0, 1].map(() => ({ ...parseFixture('heading-number-text'), category: '汇编' }));
  const { paragraphs } = readDocx(await buildAssembleDocx(articles));
  assert.equal(paragraphs.filter((p) => p.style === 'Heading1').length, 2);
  assert.deepEqual(paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text), ['1.25岁的焦虑', '2.一个床位', '3.室友', '1.25岁的焦虑', '2.一个床位', '3.室友']);
});
