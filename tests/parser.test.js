'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArticle, containsCopyright } = require('../src/parser');
const { cleanSpacesText, removeCitationMarks } = require('../src/docxBuilder');
const { fixtures, articleHtml, headings, heading, bodyParagraph, image, assertExpected } = require('./support');

for (const fixture of fixtures) {
  test(`固定样本/${fixture.id}: ${fixture.description}`, () => {
    assertExpected(parseArticle(articleHtml(fixture.body, fixture)), fixture.expected, fixture.id);
  });
}

for (const prefix of ['正午', '正午故事', '正午书架', '正午视觉', '正午访谈']) {
  for (const separator of [' | ', '｜']) {
    test(`栏目清理/${prefix}${separator}前后缀与账号边界`, () => {
      const title = `${prefix}${separator}示例文章${separator}${prefix}`;
      assert.equal(parseArticle(articleHtml(bodyParagraph, { title, account: '正午故事' })).title, '示例文章');
      assert.equal(parseArticle(articleHtml(bodyParagraph, { title, account: '其他公众号' })).title, title);
    });
  }
}

test('正文重复主标题与署名均不成为首个小标题基准', () => {
  const data = parseArticle(articleHtml(heading('示例文章', '15px') + heading('采写 | 林木', '15px') + heading('一、清晨') + bodyParagraph + heading('二、傍晚') + bodyParagraph, { title: '示例文章 | 正午', account: '正午故事' }));
  assert.equal(data.author, '林木');
  assert.deepEqual(headings(data).map((b) => b.text), ['一、清晨', '二、傍晚']);
  assert.ok(!data.blocks.some((b) => b.text === '示例文章'));
});

for (const unit of ['16px', '12pt']) {
  test(`字号/${unit}保留两个单字普通标题`, () => {
    const data = parseArticle(articleHtml(heading('春', unit) + bodyParagraph + heading('夏', unit) + bodyParagraph));
    assert.deepEqual(headings(data).map((b) => b.text), ['春', '夏']);
  });
}

test('仅一处加粗短句不构成小标题体系', () => {
  const data = parseArticle(articleHtml(heading('孤立强调') + bodyParagraph));
  assert.equal(headings(data).length, 0);
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '孤立强调'));
});

test('父元素大字号不能让内层小字通过标题筛选', () => {
  const small = (text) => `<p style="font-size:28px"><strong><span style="font-size:10px">${text}</span></strong></p>`;
  assert.equal(headings(parseArticle(articleHtml(small('小字甲') + bodyParagraph + small('小字乙') + bodyParagraph))).length, 0);
});

for (const text of ['1、25岁的焦虑', '2、一个床位', '1、2', '2、一']) {
  test(`顿号不是层级连接符/${text}`, () => {
    const data = parseArticle(articleHtml(heading(text) + bodyParagraph + heading('3、室友') + bodyParagraph));
    assert.deepEqual(headings(data).map((b) => b.text), [text, '3、室友']);
    assert.equal(headings(data, 3).length, 0);
  });
}

for (const text of ['1.1 细项', '01.1 细项', '1-1 细项']) {
  test(`明确多级编号/${text}不得成为标题2`, () => {
    const data = parseArticle(articleHtml(heading('01章节') + bodyParagraph + heading('02章节') + bodyParagraph + heading(text) + bodyParagraph));
    assert.ok(headings(data, 3).some((b) => b.text === text));
    assert.equal(headings(data).length, 2);
  });
}

test('无编号中文词首的一字不能被剥成序号', () => {
  const data = parseArticle(articleHtml(heading('一个清晨') + bodyParagraph + heading('另一段旅程') + bodyParagraph));
  assert.equal(headings(data)[0].numType, null);
  assert.equal(headings(data)[0].subText, '一个清晨');
});

test('相邻但各有编号的章节不能合并', () => {
  const data = parseArticle(articleHtml(heading('1、清晨') + heading('2、傍晚') + bodyParagraph));
  assert.deepEqual(headings(data).map((b) => b.text), ['1、清晨', '2、傍晚']);
});

for (const marker of ['-END-', '—END—', '【END】', '——完——', '— END —', '· end ·', '—  —完—  —']) {
  test(`结束符/${marker}优先于加粗标题，删除后续图片`, () => {
    const data = parseArticle(articleHtml(bodyParagraph + heading(marker, '18px') + '<p>不应保留的尾文。</p>' + image('tail') + '<p>题图来源：视觉中国</p>'));
    assert.equal(data.blocks.filter((b) => b.type === 'image').length, 0);
    assert.equal(headings(data).length, 0);
    assert.ok(!data.blocks.some((b) => b.text === marker || b.text === '不应保留的尾文。'));
    assert.deepEqual(data.blocks.filter((b) => b.type === 'copyright').map((b) => b.text), ['题图来源：视觉中国']);
  });
}

test('正午故事结束符后的第一条文字保留，其他账号不套用例外', () => {
  for (const account of ['正午故事', '其他公众号']) {
    const data = parseArticle(articleHtml(bodyParagraph + heading('—— 完 ——') + '<p></p><p>第一条附注。</p><p>第二条附注。</p><p>题图来源：东方IC</p>', { account }));
    assert.equal(data.blocks.some((b) => b.text === '第一条附注。'), account === '正午故事');
    assert.ok(!data.blocks.some((b) => b.text === '第二条附注。'));
    assert.ok(data.blocks.some((b) => b.type === 'copyright' && b.text === '题图来源：东方IC'));
  }
});

for (const keyword of ['视觉中国', '东方IC', '东方 ic', '人民视觉', 'IC photo', 'ic PHOTO']) {
  test(`版权关键词/${keyword}不依赖图源措辞或长度`, () => {
    const text = `无特定前缀的说明${'长文本'.repeat(25)}${keyword}`;
    assert.ok(containsCopyright(text));
    const data = parseArticle(articleHtml(bodyParagraph + `<p>${text}</p>`));
    assert.ok(data.blocks.some((b) => b.type === 'copyright' && b.text === text));
  });
}

test('图片尺寸、链接与尾部推广过滤不受顶部星标修复影响', () => {
  const data = parseArticle(articleHtml('<p>点击上方星标</p>' + bodyParagraph + image('keep') + '<p><img data-src="https://example.invalid/tiny.png" data-w="20" data-ratio="1"></p><p><img data-src="https://example.invalid/line.png" data-w="1000" data-ratio="0.1"></p><p><a href="https://example.invalid"><img data-src="https://example.invalid/link.png" data-w="1000" data-ratio="0.75"></a></p><p>点击阅读原文</p>' + image('tail')));
  assert.deepEqual(data.blocks.filter((b) => b.type === 'image').map((b) => b.src), ['https://example.invalid/keep.png']);
});

test('同一个短句只有紧邻图片才按图注识别', () => {
  const data = parseArticle(articleHtml('<p>林间小屋。</p>' + image('house') + '<p>林间小屋。</p>'));
  assert.equal(data.blocks.filter((b) => b.type === 'paragraph' && b.text === '林间小屋。').length, 1);
  assert.equal(data.blocks.filter((b) => b.type === 'caption' && b.text === '林间小屋。').length, 1);
});

for (const hint of ['\u2b05\ufe0f左右滑动查看更多\u27a1\ufe0f', '左滑查看更多', '可向下滑动查看', '下滑查看', '请向右滑动浏览更多图片']) {
  test(`滑动提示/${hint}删除提示但保留图注`, () => {
    const data = parseArticle(articleHtml(image('hint') + `<p>图源：示例，${hint}</p><p>${hint}</p>`));
    assert.deepEqual(data.blocks.filter((b) => b.type === 'caption').map((b) => b.text), ['图源：示例']);
    assert.ok(!data.blocks.some((b) => (b.text || '').includes(hint)));
  });
}

for (const [input, expected] of [
  ['47 %', '47%'], ['47\u00a0%', '47%'], ['９９ ％', '９９％'],
  ['please use 47 % here', 'please use 47% here'], ['12 - 15 岁', '12-15岁'],
  ['使用 Python 开发', '使用Python开发'], ['hello world 12 kg', 'hello world 12 kg'],
]) {
  test(`空格清理/${JSON.stringify(input)}`, () => assert.equal(cleanSpacesText(input), expected));
}

test('编号标题与同样式续行标题合并为一行', () => {
  const body = '<p><strong style="font-size:28px">01 标题上半句：</strong></p><h3><strong style="font-size:28px">标题下半句</strong></h3><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p><p><strong style="font-size:28px">02 第二个标题</strong></p><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p>';
  const data = parseArticle(articleHtml(body));
  assert.deepEqual(headings(data).map((b) => b.text), ['01 标题上半句：标题下半句', '02 第二个标题']);
  assert.equal(headings(data)[0].subText, '标题上半句：标题下半句');
});

test('编号标题无标点但语义未闭合时合并续行', () => {
  const body = '<p><strong style="font-size:28px">01 攀岩帮你对抗</strong></p><h3><strong style="font-size:28px">习得性无助</strong></h3><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p><p><strong style="font-size:28px">02 建立掌控感</strong></p><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p>';
  const data = parseArticle(articleHtml(body));
  assert.deepEqual(headings(data).map((b) => b.text), ['01 攀岩帮你对抗习得性无助', '02 建立掌控感']);
  assert.equal(headings(data)[0].subText, '攀岩帮你对抗习得性无助');
});

test('无编号标题的同样式续行也合并为一行', () => {
  const body = '<p style="text-align:center"><strong style="font-size:20px">攀岩帮你对抗</strong></p><p style="text-align:center"><strong style="font-size:20px">习得性无助</strong></p><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p><p style="text-align:center"><strong style="font-size:20px">建立掌控感</strong></p><p>这是一段超过二十个字符的普通正文，用来隔开章节，既不是图注，也不是章节标题或署名。</p>';
  const data = parseArticle(articleHtml(body));
  assert.deepEqual(headings(data).map((b) => b.text), ['攀岩帮你对抗习得性无助', '建立掌控感']);
});

test('无标点章节标题后紧跟细分标题时不合并', () => {
  const body = '<p style="text-align:center"><span style="font-size:12pt;font-weight:700">二、故事</span></p><p><span style="font-size:12pt;font-weight:700">恋爱</span></p><p>这是一段足够长的普通正文，用于隔开章节并保留上下文，不应被视为任何标题或其他元数据。</p><p style="text-align:center"><span style="font-size:12pt;font-weight:700">三、生活的结构</span></p><p><span style="font-size:12pt;font-weight:700">未来</span></p><p>这是一段足够长的普通正文，用于隔开章节并保留上下文，不应被视为任何标题或其他元数据。</p>';
  const data = parseArticle(articleHtml(body));
  assert.deepEqual(headings(data).map((b) => b.text), ['二、故事', '三、生活的结构']);
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '恋爱'));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '未来'));
});

test('图标前缀参考文献进入独立 references 集合', () => {
  const data = parseArticle(articleHtml('<p>正文内容。</p><section><strong>📄 参考文献</strong></section><p>[1] Example Reference.</p><p>[2] Another Reference.</p>'));
  assert.deepEqual(data.references, ['[1] Example Reference.', '[2] Another Reference.']);
  assert.ok(!data.blocks.some((b) => /参考文献/.test(b.text || '')));
});

test('谷雨实验室尾段不会因来源图标重复，腾讯新闻尾注会删除', () => {
  const last = '如果有一天，我很疲倦了，我仍然愿意回到舞台继续表演。';
  const body = `<section><span>${last}</span><span><img data-src="https://mmbiz.qpic.cn/mmbiz_png/YulpgP4g2QLtwd7aY4PhcYIYapVuObiaCxHmiaxl55EchrPoBSlVLsTwnxsJJIok1nRIibXHSmu8ibKC8plzSUOkIg/640" data-w="804" data-ratio="0.9975"></span><span>（来源：腾讯新闻）</span></section><section>◦ 除剧照外，其他图片由作者提供。</section>`;
  const data = parseArticle(articleHtml(body, { account: '谷雨实验室' }));
  assert.equal(data.blocks.filter((b) => b.text === last).length, 1);
  assert.ok(!data.blocks.some((b) => (b.text || '').includes('来源：腾讯新闻')));
  assert.ok(!data.blocks.some((b) => b.type === 'image'));
  assert.ok(data.blocks.some((b) => b.text === '除剧照外，其他图片由作者提供。'));
});

test('引用标清理不误删化学式与文字注释', () => {
  assert.equal(removeCitationMarks('正文[1][2,3][1-3] [NaCl] [注1]'), '正文 [NaCl] [注1]');
});

// —— 以下为「主动放弃千亿家产的继承者们」（R5EazIPJkDmDKQX5lNT7XA）暴露的问题 ——

test('参考文献：「1、」后不空格的中文编号仍逐条拆分', () => {
  const items = [
    '《民营企业代际传承高峰期，可能引发的经济社会风险及对策建议》，研究简报335期',
    '《85岁创始人套现13亿离场，儿女双双放弃接班》，第一财经，2026年7月21日',
    '《李书福辞任董事会主席，吉利汽车管理层大调整》，第一财经，2026年8月17日',
  ];
  const body = '<p>参考资料：</p>' + items.map((item, i) => `<p>${i + 1}、${item}</p>`).join('');
  const data = parseArticle(articleHtml(bodyParagraph + body));
  assert.deepEqual(data.references, items.map((item, i) => `${i + 1}、${item}`));
});

test('参考文献：小数开头的正文不被误切成新条目', () => {
  const body = '<p>参考资料：</p><p>3.14是圆周率的近似值，这里只是举例说明。</p>';
  const data = parseArticle(articleHtml(bodyParagraph + body));
  assert.deepEqual(data.references, ['3.14是圆周率的近似值，这里只是举例说明。']);
});

test('署名行：运营 / 主编 / 监制 等前缀同样按作者信息区删除', () => {
  const data = parseArticle(articleHtml(bodyParagraph + '<p>文 | 许峥</p><p>编辑 | Yang</p><p>运营 | 歪歪</p>' + bodyParagraph));
  const kept = data.blocks.filter((b) => b.type !== 'deleted').map((b) => b.text || '');
  assert.ok(!kept.some((text) => /运营\s*[|｜]/.test(text)), '运营署名行应被删除');
  assert.equal(data.blocks.filter((b) => b.type === 'deleted' && b.label === '作者信息区').length, 3);
});

test('署名行：正文里「运营」「设计」作动词时不误删', () => {
  const text = '他运营着一家设计公司，设计流程全部自己搭建。';
  const data = parseArticle(articleHtml(`<p>${text}</p>` + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === text));
});

test('留言互动区：互动标题后的提问句一并删除', () => {
  const question = '你如何看待这些继承人们的故事？';
  const data = parseArticle(articleHtml(bodyParagraph + '<p>每人互动</p>' + `<p>${question}</p>`));
  assert.ok(!data.blocks.some((b) => b.type === 'paragraph' && b.text === question));
  assert.ok(data.blocks.some((b) => b.type === 'deleted' && b.text === question));
});

test('留言互动区：提问句之后的长正文仍保留', () => {
  const data = parseArticle(articleHtml(bodyParagraph + '<p>每人互动</p><p>你怎么看？</p>' + bodyParagraph));
  assert.equal(data.blocks.filter((b) => b.type === 'paragraph').length, 2);
});

test('文末原创声明：「文章为XX原创」按推广删除', () => {
  const data = parseArticle(articleHtml(bodyParagraph + '<p>文章为每日人物原创</p>'));
  assert.ok(!data.blocks.some((b) => b.type === 'paragraph' && b.text === '文章为每日人物原创'));
});

test('文末原创声明：正文中的「原创」不误删', () => {
  const text = '这款原创设计获得了当年的年度奖项。';
  const data = parseArticle(articleHtml(`<p>${text}</p>` + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === text));
});

test('图注：图片后居中的完整长句仍是正文而非图注', () => {
  const lead = '对于大多数人来说，人生当中很难有比继承一家价值上千亿的公司更确定的机会。';
  const data = parseArticle(articleHtml(
    image('cover') + `<p style="text-align:center;font-size:14px">${lead}</p>` + bodyParagraph,
  ));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === lead), '导语不能因小字号+居中变成图注');
  assert.ok(!data.blocks.some((b) => b.type === 'caption' && b.text === lead));
});

// —— 以下为谷雨实验室两篇（or51ZcZJrg9s0G_N5JhXCg 等）暴露的问题 ——

test('标题：账号简称后缀通用清理（谷雨实验室 →「| 谷雨」）', () => {
  const data = parseArticle(articleHtml(bodyParagraph, { account: '谷雨实验室', title: '如果结婚有方法论，生活会更容易吗？ | 谷雨' }));
  assert.equal(data.title, '如果结婚有方法论，生活会更容易吗？');
});

test('标题：账号简称前缀同样清理', () => {
  const data = parseArticle(articleHtml(bodyParagraph, { account: '谷雨实验室', title: '谷雨 | 一篇关于结婚方法论的文章' }));
  assert.equal(data.title, '一篇关于结婚方法论的文章');
});

test('标题：尾段不是账号前缀时不误删', () => {
  const title = '通信 | 谷雨时节话养生';
  const data = parseArticle(articleHtml(bodyParagraph, { account: '谷雨实验室', title }));
  assert.equal(data.title, title);
});

const CHAPTER_SEP_IMG = '<p><img data-src="https://example.invalid/sep1.png" data-w="1080" data-ratio="0.1"></p>';

test('章节序号：全宽扁条序号图成组出现时识别为章节分隔', () => {
  const data = parseArticle(articleHtml(CHAPTER_SEP_IMG + bodyParagraph + CHAPTER_SEP_IMG + bodyParagraph));
  assert.equal(data.blocks.filter((b) => b.type === 'chapterSeparator').length, 2);
  // 序号图不作为普通图片保留
  assert.equal(data.blocks.filter((b) => b.type === 'image').length, 0);
});

test('章节序号：孤张全宽扁图不成组，仍按小图过滤', () => {
  const data = parseArticle(articleHtml(CHAPTER_SEP_IMG + bodyParagraph));
  assert.equal(data.blocks.filter((b) => b.type === 'chapterSeparator').length, 0);
});

function wideBar(height) {
  // 1080 宽、指定高度的横条，模拟公众号分隔条/序号条
  return `<p><img data-src="https://example.invalid/bar${height}.png" data-w="1080" data-ratio="${(height / 1080).toFixed(4)}"></p>`;
}

test('章节序号：多组不同尺寸的全宽扁条是装饰图，不伪造章节序号', () => {
  // 装饰分隔条尺寸各异（125 / 113 两组），不应凭空生成「1. 2. 3.」
  const body = [125, 125, 125, 113, 113, 113]
    .map((h) => wideBar(h) + bodyParagraph).join('');
  const data = parseArticle(articleHtml(body));
  assert.equal(data.blocks.filter((b) => b.type === 'chapterSeparator').length, 0);
});

test('章节序号：整篇仅一组同尺寸扁条时才作为章节序号', () => {
  const body = [108, 108, 108].map((h) => wideBar(h) + bodyParagraph).join('');
  const data = parseArticle(articleHtml(body));
  assert.equal(data.blocks.filter((b) => b.type === 'chapterSeparator').length, 3);
});

test('头图片名：文末「头图/封面 《片名》」提取为 headImageCredit', () => {
  const data = parseArticle(articleHtml(
    image('cover') + bodyParagraph + bodyParagraph + '<p>头图/封面 《我，到点下班》</p>',
  ));
  assert.equal(data.headImageCredit, '《我，到点下班》');
  assert.ok(data.blocks.some((b) => b.type === 'caption' && b.text === '头图/封面 《我，到点下班》'));
});

test('头图片名：「封面及首图 《我的姐姐》」「封面 《对不起，宝贝》」同样提取', () => {
  assert.equal(
    parseArticle(articleHtml(image('cover') + bodyParagraph + bodyParagraph + '<p>封面及首图 《我的姐姐》</p>')).headImageCredit,
    '《我的姐姐》',
  );
  assert.equal(
    parseArticle(articleHtml(image('cover') + bodyParagraph + bodyParagraph + '<p>封面 《对不起，宝贝》</p>')).headImageCredit,
    '《对不起，宝贝》',
  );
});

test('头图片名：正文中前部的同类句式不提取', () => {
  const data = parseArticle(articleHtml('<p>封面 《早年的作品》</p>' + bodyParagraph + bodyParagraph + bodyParagraph + bodyParagraph));
  assert.equal(data.headImageCredit, '');
});

test('留言互动区：正文叙述句提及「评论区」不误删', () => {
  const text = '在她的社交网络评论区，至今仍有同县、同镇的女孩出现，询问改名的细节。';
  const data = parseArticle(articleHtml(bodyParagraph + `<p>${text}</p>` + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === text), '正文不能被留言互动区规则误删');
});

test('文末图书推广：「系列图书」「点击图片购买」行删除', () => {
  const data = parseArticle(articleHtml(
    bodyParagraph +
    '<p style="text-align:center"><strong style="color:red">《人物》「时间的力量」系列图书</strong></p>' +
    '<p style="text-align:center"><strong style="color:red">点击图片购买↓↓↓</strong></p>' +
    bodyParagraph,
  ));
  for (const text of ['《人物》「时间的力量」系列图书', '点击图片购买↓↓↓']) {
    assert.ok(data.blocks.some((b) => b.type === 'deleted' && (b.text || '').includes(text.slice(0, 8))), `「${text}」应删除`);
    assert.ok(!data.blocks.some((b) => b.type === 'subheading' && b.text === text), `「${text}」不能成为标题`);
  }
});

test('文末图书推广：正文提及「一系列图书」不误删', () => {
  const text = '他后来出版了一系列图书，记录这段经历。';
  const data = parseArticle(articleHtml(bodyParagraph + `<p>${text}</p>` + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === text));
});

test('星标引导伴句：「精彩故事永不错过」删除，正文「不想错过」不受影响', () => {
  const data = parseArticle(articleHtml(
    bodyParagraph +
    '<p>星标关注《人物》微信公号</p>' +
    '<p>精彩故事永不错过</p>' +
    bodyParagraph,
  ));
  assert.ok(data.blocks.some((b) => b.type === 'deleted' && b.text === '精彩故事永不错过'));
  const text = '这样的机会我不想错过。';
  const data2 = parseArticle(articleHtml(`<p>${text}</p>` + bodyParagraph));
  assert.ok(data2.blocks.some((b) => b.type === 'paragraph' && b.text === text));
});

test('留言互动区：段首/段尾的短引导语仍删除', () => {
  const data = parseArticle(articleHtml(bodyParagraph + '<p>评论区聊聊你的看法</p>' + bodyParagraph));
  assert.ok(data.blocks.some((b) => b.type === 'deleted' && b.text === '评论区聊聊你的看法'));
  assert.ok(!data.blocks.some((b) => b.type === 'paragraph' && b.text === '评论区聊聊你的看法'));
});

// —— 以下为「熊羽诺」一篇（MzU2MDEwMTIwMg）暴露的问题 ——

test('图注：图片后 30+ 字的灰色小字说明（多逗号、无句号）是图注', () => {
  const caption = '2025年5月6日，瑞士，熊羽诺与Dornheim教授交流学术问题';
  const html = articleHtml(
    image('photo') + `<p style="color:#888888;font-size:12px">${caption}</p>` + bodyParagraph,
  );
  const data = parseArticle(html);
  assert.ok(data.blocks.some((b) => b.type === 'caption' && b.text === caption), '小字图片说明应为图注');
});

test('图注：以「头图/封面图/配图」开头的文末图源声明是图注', () => {
  const note = '头图、封面图及配图来自文中人物。';
  const data = parseArticle(articleHtml(bodyParagraph + `<p>${note}</p>`));
  assert.ok(data.blocks.some((b) => b.type === 'caption' && b.text === note));
});

test('图注：「除…外由作者提供」这类豁免说明仍按正文保留', () => {
  const note = '除剧照外，其他图片由作者提供。';
  const data = parseArticle(articleHtml(bodyParagraph + `<p>${note}</p>`));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === note));
});

test('署名行：段末 <br> 不腰斩内联署名（「文 | 雪鸮<br>」是一行）', () => {
  const html = articleHtml(
    image('cover') +
    '<p style="text-align:right"><strong style="font-size:13px">文</strong><span style="font-size:13px"> | 雪鸮<br></span></p>' +
    '<p>编辑 | 张月</p>' + bodyParagraph,
  );
  const data = parseArticle(html);
  const deleted = data.blocks.filter((b) => b.type === 'deleted' && b.label === '作者信息区').map((b) => b.text);
  assert.ok(deleted.includes('文 | 雪鸮'), `署名应整行删除，实际：${JSON.stringify(deleted)}`);
  assert.ok(!data.blocks.some((b) => b.type !== 'deleted' && b.text === '文'), '被拆散的「文」不能残留');
  assert.ok(!data.blocks.some((b) => b.type !== 'deleted' && /雪鸮/.test(b.text || '')));
});

test('图注：单字段落（拆散的署名残片）不判为图注', () => {
  const data = parseArticle(articleHtml(image('cover') + '<p style="color:#888888;font-size:12px">文</p>' + bodyParagraph));
  assert.ok(!data.blocks.some((b) => b.type === 'caption' && b.text === '文'));
  assert.ok(data.blocks.some((b) => b.type === 'paragraph' && b.text === '文'));
});
