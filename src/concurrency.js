'use strict';

/**
 * 并发控制工具
 * 用于图片下载、批量/汇编抓取等「IO 密集但必须保序」的场景。
 */

/**
 * 以固定并发度执行任务，结果数组与原数组同序。
 * 即使个别任务抛错，也会等待全部任务结束后再抛出首个错误，避免残留任务泄漏。
 * @param {Array} items 输入数组
 * @param {number} limit 最大并发数（小于 1 时按 1 处理）
 * @param {(item: any, index: number) => Promise<any>} worker 任务函数
 * @returns {Promise<Array>} 与输入同序的结果数组
 */
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const size = Number(limit);
  const concurrency = Math.max(1, Math.min(Number.isFinite(size) && size > 0 ? Math.floor(size) : 1, list.length || 1));
  let cursor = 0;
  let failure = null;

  async function run() {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  }

  const runners = [];
  for (let i = 0; i < concurrency; i++) runners.push(run());
  await Promise.all(runners);
  if (failure) throw failure;
  return results;
}

module.exports = { mapWithConcurrency };
