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
    console.log(`\n========== 第${u + 1}篇：所有 w<150 的图（装饰图高发区） ==========`);

    $content.find('img').each((i, el) => {
      const $el = $(el);
      const w = parseInt($el.attr('data-w') || '0', 10);
      if (w >= 150) return;
      // 找最近 p 容器
      const $p = $el.closest('p, section');
      if (!$p.length) return;
      const pHtml = $p.html() || '';
      // 去掉图片后剩下的文本（含 inline 标签）
      const $clone = $p.clone();
      $clone.find('img').remove();
      const pText = $clone.text().trim();
      // 图片是否在文本 inline 中（p 里同时有文本和图片）
      const isInlineWithText = pText.length > 0;
      // 图片是否独占段落
      const isAlone = !isInlineWithText;
      // 看 style 实际显示宽度
      const styleW = ($el.attr('style') || '').match(/width\s*:\s*(\d+)/i);
      const styleH = ($el.attr('style') || '').match(/height\s*:\s*(\d+)/i);
      const dispW = styleW ? parseInt(styleW[1], 10) : 0;
      const dispH = styleH ? parseInt(styleH[1], 10) : 0;
      console.log(`[w=${w} disp=${dispW}x${dispH}]  ${isInlineWithText ? 'INLINE(图文混排)' : '独立成行'}`);
      console.log(`  段落内文: ${pText.slice(0, 80)}`);
    });
  }
})();
