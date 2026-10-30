'use strict';

const contexts = new WeakMap();
const clean = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\u2028\u2029]/g, ' ');

function declarations(style) {
  const result = {};
  for (const part of (style || '').split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim().replace(/\s*!important\s*$/i, '');
  }
  return result;
}

function colorHex(value) {
  if (!value) return null;
  const t = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/i.test(t)) return t.slice(1).toUpperCase();
  if (/^#[\da-f]{3}$/i.test(t)) return t.slice(1).split('').map((c) => c + c).join('').toUpperCase();
  const names = { black: '000000', white: 'FFFFFF', red: 'FF0000', gray: '808080', grey: '808080' };
  if (names[t]) return names[t];
  const rgb = t.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
  return rgb ? rgb.slice(1).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

function resolveFontSize(value, parentSize, rootSize) {
  const m = (value || '').match(/^(\d*\.?\d+)\s*(px|pt|em|rem|%)$/i);
  if (!m) return null;
  const number = Number(m[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  switch (m[2].toLowerCase()) {
    case 'px': return number;
    case 'pt': return number * 4 / 3;
    case 'em': return number * (parentSize || 16);
    case 'rem': return number * (rootSize || 16);
    case '%': return number * (parentSize || 16) / 100;
    default: return null;
  }
}

function getContext($) {
  if (!contexts.has($)) contexts.set($, { styles: new WeakMap(), formats: new WeakMap() });
  return contexts.get($);
}

function nodeStyle($, node) {
  if (node && node.cheerio) node = node[0];
  if (!node || node.type === 'root') return { fontSize: null, bold: false, italic: false, color: null, alignment: 'left' };
  if (node.type === 'text') return nodeStyle($, node.parent);
  const ctx = getContext($);
  if (ctx.styles.has(node)) return ctx.styles.get(node);
  const parent = nodeStyle($, node.parent);
  const own = declarations($(node).attr('style'));
  const tag = (node.tagName || '').toLowerCase();
  const root = $('html')[0];
  const rootSize = node === root ? 16 : nodeStyle($, root).fontSize || 16;
  const classSize = (($(node).attr('class') || '').match(/(?:^|\s)ql-size-(\d+(?:\.\d+)?)(?=\s|$)/i) || [])[1];
  const explicitSize = resolveFontSize(own['font-size'], parent.fontSize, rootSize);
  const inherits = own['font-size'] === 'inherit' || own['font-size'] === 'unset';
  const unknownSize = own['font-size'] && explicitSize == null && !inherits;
  const fontSize = unknownSize ? null : explicitSize || (classSize ? Number(classSize) * 4 / 3 : parent.fontSize);
  const weight = own['font-weight'];
  const bold = weight ? /^(bold|bolder|[6-9]00)$/i.test(weight) : ['strong', 'b'].includes(tag) || /^h[1-6]$/.test(tag) || parent.bold;
  const italic = own['font-style'] ? /^(italic|oblique)$/i.test(own['font-style']) : ['em', 'i'].includes(tag) || parent.italic;
  const style = {
    fontSize, bold, italic,
    color: colorHex(own.color) || parent.color,
    alignment: own['text-align'] && !/^(inherit|unset)$/.test(own['text-align']) ? own['text-align'] : parent.alignment,
    font: own['font-family'] ? own['font-family'].split(',')[0].replace(/["']/g, '').trim() : parent.font,
    underline: own['text-decoration'] ? /underline/.test(own['text-decoration']) : tag === 'u' || parent.underline,
    strike: own['text-decoration'] ? /line-through/.test(own['text-decoration']) : ['s', 'del'].includes(tag) || parent.strike,
    unknownSize: !!unknownSize,
  };
  ctx.styles.set(node, style);
  return style;
}

function extractTextFormat($, element) {
  const node = element && element.cheerio ? element[0] : element;
  const ctx = getContext($);
  if (node && ctx.formats.has(node)) return ctx.formats.get(node);
  const runs = [];
  const visit = (child) => {
    if (child.type === 'text') {
      const text = clean(child.data);
      if (text) runs.push({ ...nodeStyle($, child.parent), text });
      return;
    }
    if (child.tagName === 'br') { runs.push({ text: '\n' }); return; }
    if (/^(img|script|style|video|audio)$/i.test(child.tagName || '')) return;
    for (const sub of child.children || []) visit(sub);
  };
  if (node) visit(node);
  while (runs.length && !runs[0].text.trim()) runs.shift();
  while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
  }
  const visible = runs.filter((r) => r.text.trim());
  const sizes = visible.map((r) => r.fontSize).filter((n) => n != null);
  const weights = new Map();
  let total = 0;
  let boldChars = 0;
  for (const run of visible) {
    const length = run.text.replace(/\s/g, '').length;
    total += length;
    if (run.bold) boldChars += length;
    const key = run.color || '';
    weights.set(key, (weights.get(key) || 0) + length);
  }
  const dominantColor = [...weights].sort((a, b) => b[1] - a[1])[0];
  const result = {
    runs,
    style: {
      ...nodeStyle($, node),
      fontSize: sizes.length ? Math.max(...sizes) : null,
      minFontSize: sizes.length ? Math.min(...sizes) : null,
      color: dominantColor && dominantColor[0] || null,
      boldRatio: total ? boldChars / total : 0,
    },
  };
  if (node) ctx.formats.set(node, result);
  return result;
}

function sameHeadingStyle(a, b) {
  if (!a || !b) return true;
  if (a.fontSize != null && b.fontSize != null && Math.abs(a.fontSize - b.fontSize) > 1) return false;
  if (a.alignment && b.alignment && a.alignment !== b.alignment) return false;
  if (a.color && b.color && a.color !== b.color) return false;
  if (a.boldRatio != null && b.boldRatio != null && Math.abs(a.boldRatio - b.boldRatio) > 0.2) return false;
  return true;
}

module.exports = { nodeStyle, extractTextFormat, sameHeadingStyle, resolveFontSize };
