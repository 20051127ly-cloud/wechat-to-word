'use strict';

/**
 * 最小可用的 xlsx（OOXML）生成模块。
 *
 * 不引入第三方表格库：xlsx 本质是一个 zip 包 + 若干 XML 部件，
 * 项目已依赖 adm-zip，直接手写即可，避免为「导出一张表」增加安装体积。
 */

const AdmZip = require('adm-zip');

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/** 0-based 列号 → Excel 列名（0→A、25→Z、26→AA） */
function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(value, ref, styleIndex) {
  const style = styleIndex ? ` s="${styleIndex}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  // inlineStr 规范要求文本包在 <is> 里：<c t="inlineStr"><is><t>…</t></is></c>，
  // 缺少 <is> 时 Excel 会静默丢弃文本（数字列正常、文字列全空）。
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** 按内容估算列宽：中文按 2 个字符宽算，避免打开后挤成一团 */
function estimateWidths(rows, columnCount) {
  const widths = [];
  for (let col = 0; col < columnCount; col++) {
    let max = 0;
    for (const row of rows) {
      let width = 0;
      for (const ch of String(row[col] == null ? '' : row[col])) {
        width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
      }
      if (width > max) max = width;
    }
    widths.push(Math.min(60, Math.max(8, max + 2)));
  }
  return widths;
}

function sheetXml(rows) {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => cellXml(value, `${columnName(colIndex)}${rowIndex + 1}`, rowIndex === 0 ? 1 : 0))
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cols = `<cols>${estimateWidths(rows, columnCount)
    .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
    .join('')}</cols>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="__SHEET_NAME__" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

/**
 * 生成 xlsx 文件
 * @param {string} sheetName 工作表名
 * @param {Array<Array<string|number>>} rows 二维数据，首行为表头（自动加粗）
 * @returns {Buffer}
 */
function buildXlsx(sheetName, rows) {
  const data = Array.isArray(rows) ? rows : [];
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES_XML, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(ROOT_RELS_XML, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(WORKBOOK_XML.replace('__SHEET_NAME__', escapeXml(sheetName || 'Sheet1')), 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(WORKBOOK_RELS_XML, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(STYLES_XML, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml(data), 'utf8'));
  return zip.toBuffer();
}

module.exports = { buildXlsx, columnName, escapeXml };
