'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArticle } = require('../src/parser');
const { buildAssembleDocx } = require('../src/docxBuilder');
const { articleHtml, headings, heading, bodyParagraph, image, readDocx } = require('./support');

// 这些断言表达待修复的要求；不使用 skip/todo，也不把当前错误输出固化为预期。
// npm test 会包含本文件，存在未修复风险时必须返回非零状态。

test('R1/字号：em/rem 应基于父节点和根节点正确换算', () => {
  const emBody = '<section style="font-size:20px">' + heading('一、清晨', '1em') + bodyParagraph + heading('二、夜晚', '1em') + bodyParagraph + '</section>';
  const emData = parseArticle(articleHtml(emBody));
  assert.deepEqual(headings(emData).map((b) => b.text), ['一、清晨', '二、夜晚']);
  assert.ok(headings(emData).every((b) => Math.abs(b.fontSize - 20) < 0.01));
  const remHtml = articleHtml(heading('一、清晨', '1rem') + bodyParagraph + heading('二、夜晚', '1rem') + bodyParagraph).replace('<html>', '<html style="font-size:18px">');
  const remData = parseArticle(remHtml);
  assert.deepEqual(headings(remData).map((b) => b.text), ['一、清晨', '二、夜晚']);
  assert.ok(headings(remData).every((b) => Math.abs(b.fontSize - 18) < 0.01));
});

test('R2/样式：同字号的左对齐强调句不能混入居中的章节体系', () => {
  const data = parseArticle(articleHtml(heading('晨间') + bodyParagraph + heading('午后') + bodyParagraph + '<p style="text-align:left"><strong style="font-size:16px">普通强调短语</strong></p>' + bodyParagraph));
  assert.deepEqual(headings(data).map((b) => b.text), ['晨间', '午后']);
});

test('R3/首标题：没有重复出现的导语样式不能污染后续两个真实标题', () => {
  const data = parseArticle(articleHtml(heading('导语强调', '15px') + bodyParagraph + heading('01晨间', '24px') + bodyParagraph + heading('02午后', '24px') + bodyParagraph));
  assert.deepEqual(headings(data).map((b) => b.text), ['01晨间', '02午后']);
});

test('R3/1Rd：连续中文章节中未加粗的一必须与二至五一起保留', () => {
  const body = '<p style="text-align:center">一</p>' + bodyParagraph + ['二', '三', '四', '五'].map((text) => `<p style="text-align:center"><strong class="ql-size-12">${text}</strong></p>${bodyParagraph}`).join('');
  assert.deepEqual(headings(parseArticle(articleHtml(body))).map((b) => b.text), ['一', '二', '三', '四', '五']);
});

test('R4/相邻合并：纯中文序号不能吞掉下一段短正文', () => {
  const data = parseArticle(articleHtml(heading('一') + '<p>清晨下雨了。</p>' + heading('二') + '<p>傍晚天晴了。</p>'));
  assert.deepEqual(headings(data).map((b) => b.text), ['一', '二']);
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '清晨下雨了。'));
});

test('R5/图注：图片后第一人称叙述不应仅因短于三十字成为图注', () => {
  const data = parseArticle(articleHtml(image('photo') + '<p>我第二天决定提前回家。</p>'));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '我第二天决定提前回家。'));
});

test('R5/清理：普通正文的“下滑”不是图片操作提示', () => {
  const text = '销量下滑了三个月，但如今已经恢复。';
  const data = parseArticle(articleHtml(`<p>${text}</p>`));
  assert.ok(data.blocks.some((b) => b.text === text));
});

test('R6/结束符：正文内提及 END 字符串必须保留完整正文', () => {
  const text = '文中提到-END-只是一个字符串。';
  const data = parseArticle(articleHtml(`<p>${text}</p>` + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === text));
  assert.equal(data.blocks.filter((b) => b.type === 'paragraph').length, 2);
});

test('R6+R8/尾部版权：不能把同一容器中的所有推广随版权一起保留', () => {
  const data = parseArticle(articleHtml(bodyParagraph + heading('——完——') + '<section><p>这段推广不应保留。</p><p>题图来源：视觉中国</p></section>'));
  assert.deepEqual(data.blocks.filter((b) => b.type === 'copyright').map((b) => b.text), ['题图来源：视觉中国']);
  assert.ok(!data.blocks.some((b) => (b.text || '').includes('这段推广不应保留')));
});

test('R7/图片：src 加 width/height 的普通图片不能因缺少 data 属性消失', () => {
  const data = parseArticle(articleHtml('<p><img src="https://example.invalid/photo.png" width="1000" height="750"></p>' + bodyParagraph));
  assert.equal(data.blocks.filter((b) => b.type === 'image').length, 1);
});

test('R8/版权：署名删除不能优先于版权风险保留', () => {
  const data = parseArticle(articleHtml('<p>图｜视觉中国</p>' + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'copyright' && b.text === '图｜视觉中国'));
});

test('R8/版权：加粗风险文字不能被标题路径绕过', () => {
  const data = parseArticle(articleHtml(heading('题图来源：视觉中国') + bodyParagraph + heading('图片来源：东方IC') + bodyParagraph));
  assert.deepEqual(data.blocks.filter((b) => b.type === 'copyright').map((b) => b.text), ['题图来源：视觉中国', '图片来源：东方IC']);
  assert.equal(headings(data).length, 0);
});

test('R2/原文格式：细分标题按正文输出时仍需保留原来的加粗', async () => {
  const body = heading('01准备', '28px') + bodyParagraph + heading('02行动', '28px') + bodyParagraph + heading('1. 记录天气', '17px') + bodyParagraph + heading('2. 查看地图', '17px') + bodyParagraph;
  const data = parseArticle(articleHtml(body));
  data.category = '汇编';
  const paragraph = readDocx(await buildAssembleDocx([data])).paragraphs.find((p) => p.text === '1. 记录天气');
  assert.ok(paragraph);
  assert.ok(!paragraph.style.startsWith('Heading'));
  assert.ok(paragraph.runs.some((r) => r.text === '1. 记录天气' && r.bold), '原文加粗不能随降级丢失');
});
