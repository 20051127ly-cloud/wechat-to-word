'use strict';

const { fetchArticle } = require('./src/fetcher');
const cheerio = require('cheerio');

const urls = [
  'https://mp.weixin.qq.com/s/IRyKAxMD3FrB8cE-Bff1WA',
  'https://mp.weixin.qq.com/s/PmtsbwtCqsz2ITi7F3Ve1w',
  'https://mp.weixin.qq.com/s/5iuoDq86RP0frhByRZtrxw',
];

(async () => {
  for (let u = 0; u < urls.length; u++) {
    const html = await fetchArticle(urls[u]);
    const $ = cheerio.load(html);
    const $content = $('#js_content');
    console.log(`\n========== 第${u + 1}篇：所有 w<300 的图 + 上下文 ==========`);

    $content.find('img').each((i, el) => {
      const $el = $(el);
      const w = parseInt($el.attr('data-w') || '0', 10);
      if (w >= 300) return;
      const $p = $el.closest('p, section');
      if (!$p.length) return;
      const $clone = $p.clone();
      $clone.find('img').remove();
      const pText = $clone.text().trim();
      const styleW = ($el.attr('style') || '').match(/width\s*:\s*(\d+)/i);
      const dispW = styleW ? parseInt(styleW[1], 10) : 0;
      const isInlineWithText = pText.length > 0;
      console.log(`[w=${w} disp=${dispW}px]  ${isInlineWithText ? 'INLINE(图文混排)' : '独立成行'}`);
      console.log(`  段落内文: ${pText.slice(0, 100)}`);
    });
  }
})();
