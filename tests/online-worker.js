'use strict';

const { fetchArticle } = require('../src/fetcher');
const { parseArticle } = require('../src/parser');
const { buildAssembleDocx } = require('../src/docxBuilder');
const { readDocx } = require('./support');

process.once('message', async ({ url }) => {
  let stage = 'fetch';
  try {
    const html = await fetchArticle(url);
    stage = 'parse';
    const data = parseArticle(html);
    const headings = data.blocks.filter((b) => b.type === 'subheading' && b.level === 2);
    const summary = {
      account: data.account,
      title: data.title,
      author: data.author,
      headings: headings.map((b) => b.pureNumber ? b.text : b.subText || b.text),
      pureNumbers: headings.map((b) => b.pureNumber === true),
      copyrights: data.blocks.filter((b) => b.type === 'copyright').map((b) => b.text),
    };
    stage = 'docx';
    data.category = '汇编';
    const { paragraphs } = readDocx(await buildAssembleDocx([data]));
    summary.wordHeadings = paragraphs.filter((p) => p.style === 'Heading2').map((p) => p.text);
    summary.redCopyrights = paragraphs.filter((p) => p.runs.some((r) => r.color === 'FF0000' && r.bold)).map((p) => p.text);
    process.send({ ok: true, summary }, () => process.disconnect());
  } catch (error) {
    process.send({ ok: false, stage, message: error.message }, () => process.disconnect());
  }
});
