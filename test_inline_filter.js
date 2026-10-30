'use strict';

const { fetchArticle } = require('./src/fetcher');
const { parseArticle } = require('./src/parser');
const cheerio = require('cheerio');

(async () => {
  // === 基线测试：三篇原图数量应保持 12 / 12 / 9 张 ===
  const urls = [
    'https://mp.weixin.qq.com/s/IRyKAxMD3FrB8cE-Bff1WA',
    'https://mp.weixin.qq.com/s/PmtsbwtCqsz2ITi7F3Ve1w',
    'https://mp.weixin.qq.com/s/5iuoDq86RP0frhByRZtrxw',
  ];
  for (let i = 0; i < urls.length; i++) {
    const html = await fetchArticle(urls[i]);
    const data = parseArticle(html);
    const imgs = data.blocks.filter((b) => b.type === 'image');
    console.log(`第${i + 1}篇：${imgs.length} 张正文图（独立成行，未受 inline 过滤影响）`);
  }

  // === Inline 过滤测试：构造 HTML，看 inline 图是否被过滤 ===
  console.log('\n=== Inline 装饰图过滤单元测试 ===');
  const mockHtml = `
    <html><head></head><body>
      <div id="js_content">
        <!-- A: 独立成行的正文配图（应保留） -->
        <p><img data-src="https://example.com/standalone.jpg" data-w="335" data-ratio="0.75"></p>
        <!-- B: inline 装饰图 + 文字（应过滤） -->
        <p>我怕耗费她更多的气力，请她多多保重自己。🏸<span>（来源：腾讯新闻）</span></p>
        <!-- C: inline 大图 + 文字（也应过滤，因为 inline 共存即装饰，不管尺寸） -->
        <p>用户测试：<img data-src="https://example.com/inline-big.jpg" data-w="800" data-ratio="0.75">后面还有文字。</p>
      </div>
    </body></html>
  `;
  const $ = cheerio.load(mockHtml);
  // 给 inline 图补 src / class 模拟真实结构
  $('p').each((i, el) => {
    $(el).find('img').each((_, img) => {
      const $img = $(img);
      if (!$img.attr('class')) $img.attr('class', 'rich_pages wxw-img');
      const src = $img.attr('data-src') || '';
      if (src && !$img.attr('src')) $img.attr('src', src);
    });
  });
  const data = parseArticle($.html());
  const imgs = data.blocks.filter((b) => b.type === 'image').map((b) => b.src);
  console.log('过滤后 image 块 SRC：');
  imgs.forEach((s) => console.log('  ' + s));
  // 期望：只有 standalone.jpg 出现在 image 块；inline 图（src 含 inline-icon / inline-big）都被过滤
  const expected = 'https://example.com/standalone.jpg';
  const gotInline = imgs.filter((s) => s.includes('inline-icon') || s.includes('inline-big'));
  console.log(`\n期望保留: ${expected}`);
  console.log(`期望过滤: inline-icon / inline-big`);
  console.log(`✅ 独立配图保留: ${imgs.includes(expected)}`);
  console.log(`✅ inline 装饰图过滤: ${gotInline.length === 0}（错误保留: ${gotInline.join(', ') || '无'}）`);
})();
