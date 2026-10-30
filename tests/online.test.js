'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { join } = require('node:path');
const cases = require('./fixtures/online.json');

function runArticle(url) {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'online-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let settled = false;
    let errors = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('[环境失败] 抓取或解析超过 90 秒，已终止测试子进程')), 90000);
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => { if (!settled) finish(new Error(`[执行失败] 子进程退出 ${code}: ${errors}`)); });
    child.once('message', (message) => {
      if (!message.ok) {
        const label = message.stage === 'fetch' ? '环境失败：网络或微信拦截' : `执行失败：${message.stage}`;
        finish(new Error(`[${label}] ${message.message}`));
      } else finish(null, message.summary);
    });
    child.send({ url });
  });
}

const selectedId = process.env.ARTICLE_ID;
const selected = selectedId ? cases.filter((item) => item.id === selectedId) : cases;
if (!selected.length) throw new Error(`未知 ARTICLE_ID：${selectedId}`);

for (const item of selected) {
  test(`在线/${item.id} ${item.url}`, { timeout: 100000 }, async () => {
    const actual = await runArticle(item.url);
    assert.equal(actual.account, item.account, '[内容变化] 公众号身份');
    assert.equal(actual.title, item.title, '[规则或原文变化] 主标题');
    if (item.author !== undefined) assert.equal(actual.author, item.author, '[规则或原文变化] 作者');
    if (item.headings) {
      assert.deepEqual(actual.headings, item.headings, '[规则或原文变化] 小标题文本及顺序');
      assert.ok(actual.pureNumbers.every((pure) => pure === item.pureNumbers), '[规则或原文变化] 序号类型');
      const expectedWord = item.pureNumbers ? item.headings : item.headings.map((text, index) => `${index + 1}.${text}`);
      assert.deepEqual(actual.wordHeadings, expectedWord, '[Word 输出错误] 标题2');
    }
    if (item.copyright) {
      assert.ok(actual.copyrights.includes(item.copyright), '[规则错误] 版权声明丢失');
      assert.ok(actual.redCopyrights.includes(item.copyright), '[Word 输出错误] 版权未标红加粗');
    }
  });
}
