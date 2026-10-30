'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapWithConcurrency } = require('../src/concurrency');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrency/结果与输入同序', async () => {
  const items = [80, 10, 50, 20, 5];
  const results = await mapWithConcurrency(items, 4, async (n) => {
    await sleep(n);
    return n;
  });
  assert.deepEqual(results, items);
});

test('concurrency/并发度不超过设定上限', async () => {
  let running = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
  });
  assert.equal(peak, 3);
});

test('concurrency/总耗时受并发压缩而非逐个累加', async () => {
  const started = Date.now();
  await mapWithConcurrency(Array.from({ length: 8 }, () => 1), 8, () => sleep(60));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8 * 60 * 0.6, `并发执行耗时应明显短于串行，实际 ${elapsed}ms`);
});

test('concurrency/单个任务失败也会跑完全部任务并抛出首个错误', async () => {
  const seen = [];
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      seen.push(n);
      await sleep(5);
      if (n === 2) throw new Error('任务 2 失败');
      if (n === 3) throw new Error('任务 3 失败');
      return n;
    }),
    (error) => error.message === '任务 2 失败',
  );
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4], '失败不应中断其余任务');
});

test('concurrency/空数组与并发度异常输入', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (n) => n), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (n) => n * 2), [2, 4]);
  assert.deepEqual(await mapWithConcurrency([1, 2], NaN, async (n) => n * 2), [2, 4]);
});
