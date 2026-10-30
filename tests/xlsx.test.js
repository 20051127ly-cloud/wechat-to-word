'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { buildXlsx, columnName, escapeXml } = require('../src/xlsx');

const ROWS = [
  ['序号', '状态', '文章原名', '抓取后文件名', '作者', '来源', '链接', '失败原因'],
  [1, '成功', '为什么「好学生」长大后反而更容易受伤', '为什么「好学生」（轻心理）.docx', '许峥', '每日人物', 'https://mp.weixin.qq.com/s/abc', ''],
  [2, '失败', '', '', '', '', 'https://mp.weixin.qq.com/s/def', '抓取被微信拦截'],
];

function unzip(buffer) {
  const zip = new AdmZip(buffer);
  const get = (name) => {
    const entry = zip.getEntry(name);
    assert.ok(entry, `缺少部件：${name}`);
    return entry.getData().toString('utf8');
  };
  return { zip, get };
}

function parseSheet(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('worksheet sheetData row').toArray().map((row) => {
    const cells = [];
    $(row).find('c').each((i, c) => {
      const $c = $(c);
      cells.push({
        ref: $c.attr('r'),
        type: $c.attr('t') || 'n',
        style: $c.attr('s') || '0',
        text: $c.find('t').text(),
        value: $c.find('v').text(),
      });
    });
    return cells;
  });
}

test('xlsx/列名换算', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
});

test('xlsx/XML 转义', () => {
  assert.equal(escapeXml('a<b>&"c\''), 'a&lt;b&gt;&amp;&quot;c&apos;');
  assert.equal(escapeXml(undefined), '');
});

test('xlsx/包含 OOXML 必需部件', () => {
  const { get } = unzip(buildXlsx('抓取结果', ROWS));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(get(part).length > 0, `${part} 不能为空`);
  }
  // 工作表名写入 workbook
  assert.ok(get('xl/workbook.xml').includes('抓取结果'));
});

test('xlsx/所有 XML 部件可被解析', () => {
  const { get } = unzip(buildXlsx('抓取结果', ROWS));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    const xml = get(part);
    assert.ok(xml.startsWith('<?xml'), `${part} 缺少 XML 声明`);
    assert.doesNotThrow(() => cheerio.load(xml, { xmlMode: true }), `${part} 不是合法 XML`);
  }
});

test('xlsx/样式表满足 Excel 最低要求（表头加粗）', () => {
  const { get } = unzip(buildXlsx('抓取结果', ROWS));
  const $ = cheerio.load(get('xl/styles.xml'), { xmlMode: true });
  assert.ok($('fills fill').length >= 2, 'Excel 要求至少两个 fill');
  assert.ok($('fonts font').length >= 2, '需要常规字体与加粗字体');
  assert.equal($('cellXfs xf').length, 2);
  // 第二个 cellXf 引用加粗字体（fontId=1）。cheerio 会改写属性名大小写，故直接查原文
  const xml = get('xl/styles.xml');
  assert.match(xml, /fontId="1"[^>]*applyFont="1"/, '表头样式必须指向加粗字体');
});

test('xlsx/单元格内容与位置正确，表头加粗、数字不用字符串', () => {
  const { get } = unzip(buildXlsx('抓取结果', ROWS));
  const rows = parseSheet(get('xl/worksheets/sheet1.xml'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0].text, '序号');
  assert.equal(rows[0][0].style, '1', '表头应加粗');
  assert.equal(rows[1][0].style, '0', '数据行不加粗');
  assert.equal(rows[1][0].type, 'n', '序号是数字');
  assert.equal(rows[1][0].value, '1');
  assert.equal(rows[1][2].text, '为什么「好学生」长大后反而更容易受伤');
  assert.equal(rows[1][2].ref, 'C2', '单元格引用必须行列对应');
  assert.equal(rows[2][7].text, '抓取被微信拦截');
});

test('xlsx/文本单元格必须是规范的 inlineStr 结构（<is> 包裹 <t>）', () => {
  // 缺少 <is> 时 Excel 会静默丢弃文本：数字列正常、文字列全空
  const { get } = unzip(buildXlsx('抓取结果', ROWS));
  const sheet = get('xl/worksheets/sheet1.xml');
  const inlineCells = sheet.match(/<c [^>]*t="inlineStr"[^>]*>[\s\S]*?<\/c>/g) || [];
  assert.ok(inlineCells.length > 0, '应有 inlineStr 单元格');
  for (const cell of inlineCells) {
    assert.match(cell, /<is><t/, '每个 inlineStr 单元格都必须有 <is> 包裹');
    assert.match(cell, /<\/t><\/is><\/c>$/, '文本必须闭合在 <is> 内');
  }
  // 不允许出现没有 <is> 的裸 <t>
  assert.ok(!/<c [^>]*t="inlineStr"[^>]*><t/.test(sheet), '不允许 <c t="inlineStr"><t> 的残缺结构');
});

test('xlsx/特殊字符不破坏文件（& < > 引号、emoji）', () => {
  const tricky = [['标题'], ['a & b <c> "d" \'e\' 🌟'], ['<script>alert(1)</script>']];
  const { get } = unzip(buildXlsx('抓取结果', tricky));
  const rows = parseSheet(get('xl/worksheets/sheet1.xml'));
  assert.equal(rows[1][0].text, 'a & b <c> "d" \'e\' 🌟');
  assert.equal(rows[2][0].text, '<script>alert(1)</script>');
});

test('xlsx/空数据也能生成可打开的合法文件', () => {
  const buffer = buildXlsx('抓取结果', []);
  const { get } = unzip(buffer);
  const rows = parseSheet(get('xl/worksheets/sheet1.xml'));
  assert.equal(rows.length, 0);
});
