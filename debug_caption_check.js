'use strict';
const { fetchArticle } = require('./src/fetcher');
const { parseArticle } = require('./src/parser');
const cheerio = require('cheerio');

(async () => {
  const url = 'https://mp.weixin.qq.com/s/ZlG2XRlk9nYpjhgtcn5PBA';
  const html = await fetchArticle(url);
  const data = parseArticle(html);
  console.log(`account="${data.account}" title="${data.title}"`);
  console.log('==== 目标文本的解析块及邻近结构 ====');
  data.blocks.forEach((b, i) => {
    if ((b.text || '').includes('Lotte母亲制作的创意花卉')) {
      for (let j = Math.max(0, i - 2); j <= Math.min(data.blocks.length - 1, i + 2); j++) {
        const x = data.blocks[j];
        console.log(`[${j}] ${x.type} text="${x.text || ''}" w=${x.width || ''} ratio=${x.ratio || ''}`);
      }
    }
  });

  const $ = cheerio.load(html);
  console.log('\n==== 原始 HTML ====');
  $('#js_content p, #js_content section, #js_content div, #js_content span').each((i, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.includes('Lotte母亲制作的创意花卉') && t.length < 150) {
      console.log(`tag=${el.tagName} children=${$(el).children().length} text="${t}"`);
      console.log(`style="${$(el).attr('style') || ''}"`);
      console.log(`html=${$.html(el).slice(0, 1000)}`);
    }
  });
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
