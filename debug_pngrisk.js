'use strict';
const { fetchArticle } = require('./src/fetcher');
const { parseArticle } = require('./src/parser');

async function scan(label, url) {
  const html = await fetchArticle(url);
  const data = parseArticle(html);
  const imgs = data.blocks.filter((b) => b.type === 'image');
  const pngV = data.blocks.filter((b) => b.type === 'image' && b.ratio > 1 && /_png\//i.test(b.src || ''));
  console.log(`【${label}】 保留图片总数=${imgs.length} 保留PNG竖向图=${pngV.length}`);
}

(async () => {
  await scan('AI故事计划 硅基（有箭头）', 'https://mp.weixin.qq.com/s/Y-S0-JQVJOtYc3AzAiJ6GA');
  await scan('人物 汇编链接（正文PNG竖向图）', 'https://mp.weixin.qq.com/s/daoIHXeYHkp-G9IY8PWQLg');
  await scan('真实故事计划 脚臭', 'https://mp.weixin.qq.com/s/ZYi2m29z4P_a8pvgij2wHQ');
  await scan('人物 AI短剧', 'https://mp.weixin.qq.com/s/CR_66kTCjps08lAfumRpQA');
})().catch((e) => { console.error(e.message); process.exit(1); });
