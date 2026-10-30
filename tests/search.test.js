'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchResults, normalizeForMatch } = require('../src/wechatSearch');
const { parseTitleList, buildRetryInput } = require('../server');

test('search/标题列表解析：公众号分组、文章名称前缀、类别提取', () => {
  const text = [
    '公众号：人物',
    '亲爱的招弟（轻纪实）',
    '',
    '马诺 代价（轻纪实）',
    '公众号：谷雨实验室',
    '文章名称：如果结婚有方法论（轻纪实）',
  ].join('\n');
  assert.deepEqual(parseTitleList(text), [
    { account: '人物', title: '亲爱的招弟', category: '轻纪实' },
    { account: '人物', title: '马诺 代价', category: '轻纪实' },
    { account: '谷雨实验室', title: '如果结婚有方法论', category: '轻纪实' },
  ]);
});

test('search/标题列表解析：无类别标注与无公众号的行', () => {
  const items = parseTitleList('随便一个标题\n另一个标题（轻访谈）');
  assert.deepEqual(items, [
    { account: '', title: '随便一个标题', category: '' },
    { account: '', title: '另一个标题', category: '轻访谈' },
  ]);
});

test('search/标题列表解析：括号内不是类别时不误提取', () => {
  const items = parseTitleList('在富士康熬社保的女工（未完待续）');
  assert.equal(items[0].title, '在富士康熬社保的女工（未完待续）');
  assert.equal(items[0].category, '');
});

test('search/待重跑清单：只含失败项、按公众号分组、格式可直接回贴', () => {
  const outcomes = [
    { ok: true, account: '人物', title: '亲爱的招弟', category: '轻纪实' },
    { ok: false, account: '人物', title: '婚房里的强奸案', category: '轻纪实', message: '未找到' },
    { ok: false, account: '人物', title: '县城贵妇，如何守住彩礼钱？', category: '轻纪实', message: '未找到' },
    { ok: false, account: '谷雨实验室', title: '阁楼上的物理天才', category: '轻访谈', message: '未找到' },
  ];
  const retry = buildRetryInput(outcomes);
  assert.equal(retry, [
    '公众号：人物',
    '婚房里的强奸案（轻纪实）',
    '县城贵妇，如何守住彩礼钱？（轻纪实）',
    '公众号：谷雨实验室',
    '阁楼上的物理天才（轻访谈）',
  ].join('\n'));
  // 回贴后解析出的条目与失败项一一对应
  const reparsed = parseTitleList(retry);
  assert.deepEqual(reparsed.map((item) => item.title), [
    '婚房里的强奸案',
    '县城贵妇，如何守住彩礼钱？',
    '阁楼上的物理天才',
  ]);
  assert.deepEqual(reparsed.map((item) => item.account), ['人物', '人物', '谷雨实验室']);
});

test('search/待重跑清单：全部成功时为空', () => {
  assert.equal(buildRetryInput([{ ok: true, account: '人物', title: '亲爱的招弟', category: '轻纪实' }]), '');
});

test('search/结果解析：标题去高亮、公众号、转链', () => {
  const html = [
    '<li id="sogou_vr_1_box_0"><div class="txt-box">',
    '<h3><a href="/link?url=abc&amp;type=2" uigs="article_title_0"><em><!--red_beg-->亲爱的招弟<!--red_end--></em></a></h3>',
    '<div class="s-p"><span class="all-time-y2">人物</span><span class="s2">时间</span></div>',
    '</div></li>',
  ].join('');
  const results = parseSearchResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '亲爱的招弟');
  assert.equal(results[0].account, '人物');
  assert.equal(results[0].link, '/link?url=abc&type=2');
});

test('search/归一化：引号形式与中英文标点全部抹平', () => {
  assert.equal(normalizeForMatch('县城妈妈，“逃离”县城'), '县城妈妈逃离县城');
  assert.equal(normalizeForMatch('县城妈妈,「逃离」县城'), '县城妈妈逃离县城');
  assert.equal(normalizeForMatch('为什么结婚？" 1000万'), '为什么结婚1000万');
  assert.equal(normalizeForMatch('Hello World'), 'helloworld');
});
