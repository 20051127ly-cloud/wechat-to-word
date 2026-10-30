'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { parseArticle } = require('../src/parser');

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures/regressions.json'), 'utf8'));

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function articleHtml(body, { title = '回归测试文章', account = '测试公众号' } = {}) {
  return `<!doctype html><html><body><h1 id="activity-name">${escapeHtml(title)}</h1><span id="js_name">${escapeHtml(account)}</span><div id="js_content">${body}</div></body></html>`;
}

function parseFixture(id) {
  const fixture = fixtures.find((item) => item.id === id);
  assert.ok(fixture, `不存在的样本 ID：${id}`);
  return parseArticle(articleHtml(fixture.body, fixture));
}

function headings(data, level = 2) {
  return data.blocks.filter((block) => block.type === 'subheading' && block.level === level);
}

function heading(text, size = '16px') {
  return `<p style="text-align:center"><strong style="font-size:${size}">${escapeHtml(text)}</strong></p>`;
}

const bodyParagraph = '<p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p>';

function image(name = 'photo', attributes = '') {
  return `<p><img data-src="https://example.invalid/${name}.png" data-w="1000" data-ratio="0.75" ${attributes}></p>`;
}

function assertExpected(data, expected, label) {
  if (expected.title !== undefined) assert.equal(data.title, expected.title, `${label}: 主标题`);
  if (expected.author !== undefined) assert.equal(data.author, expected.author, `${label}: 作者`);
  if (expected.headings) assert.deepEqual(headings(data).map((b) => b.text), expected.headings, `${label}: 标题文本及顺序`);
  if (expected.nested) assert.deepEqual(headings(data, 3).map((b) => b.text), expected.nested, `${label}: 细分标题`);
  if (expected.subTexts) assert.deepEqual(headings(data).map((b) => b.subText), expected.subTexts, `${label}: 去编号后标题`);
  if (expected.pureNumbers) assert.ok(headings(data).every((b) => b.pureNumber && b.numType === 'chinese'), `${label}: 纯中文序号`);
  if (expected.images !== undefined) assert.equal(data.blocks.filter((b) => b.type === 'image').length, expected.images, `${label}: 图片数量`);
  if (expected.captions) assert.deepEqual(data.blocks.filter((b) => b.type === 'caption').map((b) => b.text), expected.captions, `${label}: 图注`);
  if (expected.copyrights) assert.deepEqual(data.blocks.filter((b) => b.type === 'copyright').map((b) => b.text), expected.copyrights, `${label}: 版权声明`);
  for (const [key, type] of [['paragraphs', 'paragraph'], ['deleted', 'deleted']]) {
    for (const text of expected[key] || []) assert.ok(data.blocks.some((b) => b.type === type && b.text === text), `${label}: ${type} 应包含 ${text}`);
  }
  const allText = data.blocks.map((b) => b.text || '').concat(data.references).join('\n');
  for (const text of expected.absent || []) assert.ok(!allText.includes(text), `${label}: 不应包含 ${text}`);
}

function readDocx(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  assert.ok(entry, '必须生成 word/document.xml');
  const $ = cheerio.load(entry.getData().toString('utf8'), { xmlMode: true });
  const paragraphs = $('w\\:body w\\:p').toArray().map((element) => {
    const p = $(element);
    return {
      text: p.find('w\\:t').toArray().map((n) => $(n).text()).join(''),
      style: p.find('w\\:pStyle').attr('w:val') || '',
      alignment: p.find('w\\:jc').attr('w:val') || '',
      runs: p.find('w\\:r').toArray().map((r) => ({
        text: $(r).find('w\\:t').text(),
        color: $(r).find('w\\:color').attr('w:val'),
        size: $(r).find('w\\:sz').attr('w:val'),
        font: $(r).find('w\\:rFonts').attr('w:ascii'),
        bold: $(r).find('w\\:b').length > 0 && $(r).find('w\\:b').attr('w:val') !== 'false',
      })),
    };
  });
  return { zip, $, paragraphs };
}

module.exports = { fixtures, articleHtml, parseFixture, headings, heading, bodyParagraph, image, assertExpected, readDocx };
