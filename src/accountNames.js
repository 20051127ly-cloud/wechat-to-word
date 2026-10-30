'use strict';

/**
 * 公众号名规范映射：把抓取到的公众号名换成对外输出的统一名称。
 * 例：KnowYourself → KnowYourself知我心理
 *
 * 映射表在 config/account-names.json，格式：{ "原名": "规范名" }。
 * 匹配时归一化（忽略大小写、空格与标点），因此「knowyourself」「Know Yourself」也能命中。
 */

const fs = require('fs');
const path = require('path');
const { normalizeForMatch } = require('./wechatSearch');

const ALIAS_FILE = path.join(__dirname, '..', 'config', 'account-names.json');

function loadAccountAliases() {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
    for (const [key, value] of Object.entries(data || {})) {
      if (!key || typeof value !== 'string') continue;
      map.set(normalizeForMatch(key), value);
    }
  } catch {
    // 未配置文件时按原名输出
  }
  return map;
}

/**
 * 取公众号的展示名（命中映射则用规范名，否则原样返回）
 * @param {string} name 原始公众号名
 * @returns {string}
 */
function canonicalAccountName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return loadAccountAliases().get(normalizeForMatch(raw)) || raw;
}

module.exports = { canonicalAccountName, loadAccountAliases };
