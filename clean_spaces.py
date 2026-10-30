#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汇编板块 Word 空格清理工具

针对「汇编」板块抓取生成的 .docx 做空格规范化处理。

清理规则（按优先级执行）：
  1. 全文删除零宽字符：零宽空格 U+200B、BOM U+FEFF
  2. 删除「两个中文相关字符之间」的空格（半角/全角/NBSP/Tab 等所有空格类字符）
     「中文相关字符」= 汉字 + 中文标点 + 全角符号
  3. 删除「数字与汉字之间」的空格（双向）
  4. 删除「中文与英文之间」的空格（双向），如 "使用 Python 开发" → "使用Python开发"
  5. 删除「数字与连字符之间」的空格（双向），如 "12 - 15岁" → "12-15岁"
  6. 删除「数字与百分号之间」的空格，如 "47 %" → "47%"
  7. 连续多个半角空格 → 合并成一个
  8. 删除行尾多余空格

严格保留（绝不改动）：
  - 英文单词之间的空格、英文与数字/单位之间的空格
  - 「参考文献」标题及其后所有内容（含参考文献样式内容）
  - 表格内容、页眉页脚（python-docx 默认不遍历）
  - 空行、段落结构、字体、字号、加粗、斜体等格式

用法：
  python3 clean_spaces.py 文件.docx                 # 原地处理（自动备份 .bak）
  python3 clean_spaces.py 文件.docx -o 输出.docx    # 输出到指定文件（不覆盖原文件）
  python3 clean_spaces.py 目录                       # 处理目录下所有 .docx（原地 + 备份）
  python3 clean_spaces.py 文件.docx --no-backup      # 不备份
"""

import os
import re
import sys
import shutil
import argparse

try:
    from docx import Document
except ImportError:
    sys.exit("缺少 python-docx，请先执行：python3 -m pip install --user python-docx")


# ==================== 字符分类 ====================

# 零宽字符（规则 1）
ZERO_WIDTH_CHARS = '\u200b\ufeff'

# 空格类字符（规则 2/3/5 中「所有空格类字符」）
# 半角空格、全角空格、NBSP、Tab，以及各 Unicode 空格
SPACE_CLASS = ' \u3000\u00a0\t\u2000-\u200a\u202f\u205f'

# 汉字（基本区）
CJK = '\u4e00-\u9fff'

# 中文标点 + 全角符号
CN_PUNCT = (
    '\u3000-\u303f'          # CJK 标点与符号（、。〈〉《》「」等）
    '\uff00-\uffef'          # 全角形式（全角标点/字母/数字）
    '\u2014\u2015'           # 破折号 ——
    '\u2026'                 # 省略号 …
    '\u2018\u2019'           # 弯单引号 ‘’
    '\u201c\u201d'           # 弯双引号 “”
    '\u00b7'                 # 间隔号 ·
)

# 「中文相关字符」= 汉字 + 中文标点 + 全角符号
CN_CHAR = CJK + CN_PUNCT

# 数字（半角 + 全角）
DIGIT = '0-9０-９'

# 拉丁字母（英文）
LATIN = 'A-Za-z'

# 连字符（用于「数字与连字符之间」的空格清理）：- – — ~ ～
DASH = '-\u2013\u2014\u007e\uff5e'

# 百分号（半角 + 全角）：用于「数字与百分号之间」的空格清理
PERCENT = '%\uff05'


# ==================== 核心清理函数 ====================

def clean_text(text):
    """对单段文本按优先级执行 8 条清理规则，返回清理后的文本。"""
    if not text:
        return text

    # 规则 1：删除零宽字符
    for ch in ZERO_WIDTH_CHARS:
        text = text.replace(ch, '')

    # 规则 2：删除两个「中文相关字符」之间的空格（所有空格类）
    # 用正向预查（lookahead）实现重叠匹配，避免连续空格「隔一个删一个」
    text = re.sub(f'([{CN_CHAR}])[{SPACE_CLASS}]+(?=[{CN_CHAR}])', r'\1', text)

    # 规则 3：删除「数字与汉字之间」的空格（双向）
    text = re.sub(f'([{DIGIT}])[{SPACE_CLASS}]+(?=[{CJK}])', r'\1', text)
    text = re.sub(f'([{CJK}])[{SPACE_CLASS}]+(?=[{DIGIT}])', r'\1', text)

    # 规则 4：删除「中文与英文之间」的空格（双向），如 "使用 Python 开发" -> "使用Python开发"
    text = re.sub(f'([{CJK}])[{SPACE_CLASS}]+(?=[{LATIN}])', r'\1', text)
    text = re.sub(f'([{LATIN}])[{SPACE_CLASS}]+(?=[{CJK}])', r'\1', text)

    # 规则 5：删除「数字与连字符之间」的空格（双向），如 "12 - 15岁" -> "12-15岁"
    text = re.sub(f'([{DIGIT}])[{SPACE_CLASS}]+(?=[{DASH}])', r'\1', text)
    text = re.sub(f'([{DASH}])[{SPACE_CLASS}]+(?=[{DIGIT}])', r'\1', text)

    # 规则 6：删除「数字与百分号之间」的空格，如 "47 %" -> "47%"
    text = re.sub(f'([{DIGIT}])[{SPACE_CLASS}]+(?=[{PERCENT}])', r'\1', text)

    # 规则 7：删除中文标点前的空格（删除引用标后常遗留，如 "47% ，"）
    text = re.sub(f'[{SPACE_CLASS}]+(?=[，。！？；：])', '', text)

    # 规则 8：连续多个半角空格 → 合并成一个
    text = re.sub(' {2,}', ' ', text)

    # 规则 9：删除行尾多余空格（所有空格类）
    text = re.sub(f'[{SPACE_CLASS}]+$', '', text, flags=re.M)

    return text


# ==================== 参考文献区域识别 ====================

# 「参考文献」标题（含中英文变体）
REF_TITLE_RE = re.compile(r'^(References?|参考文献|参考资料|参考来源|引用文献)\s*[：:]?')


def is_ref_title(text):
    """判断段落文本是否为「参考文献」标题。"""
    return bool(REF_TITLE_RE.match(text.strip()))


def is_article_title(paragraph):
    """
    判断段落是否为「文章主标题」，用于定位参考文献区的结束边界。
    汇编文档中，每篇参考文献之后紧跟着下一篇的主标题（24pt 加粗）。
    """
    for run in paragraph.runs:
        if run.font.bold:
            size = run.font.size
            if size is not None and size.pt >= 24:
                return True
    return False


# ==================== 文档处理 ====================

def clean_document(doc):
    """
    遍历正文段落，跳过参考文献区，对其余段落逐 run 清理空格。
    只修改 run.text，不改任何格式属性；不遍历表格/页眉页脚。
    返回被修改的 run 数量。
    """
    in_reference = False
    changed = 0

    for para in doc.paragraphs:
        text = para.text

        # 进入参考文献区：标题及其后所有内容原样保留
        if not in_reference and is_ref_title(text):
            in_reference = True
            continue

        if in_reference:
            # 参考文献区结束：遇到下一篇主标题
            if is_article_title(para):
                in_reference = False
            else:
                continue  # 参考文献样式内容原样保留

        # 正常正文段落：逐 run 清理（保留格式）
        for run in para.runs:
            old = run.text
            new = clean_text(old)
            if new != old:
                run.text = new
                changed += 1

    return changed


# ==================== 文件 / 目录处理 ====================

def process_file(src, dst=None, backup=True):
    doc = Document(src)
    changed = clean_document(doc)

    if dst is None:
        if backup:
            shutil.copy2(src, src + '.bak')
        doc.save(src)
        out = src
    else:
        doc.save(dst)
        out = dst

    return out, changed


def iter_docx(directory):
    """返回目录下所有 .docx 文件（跳过 Word 临时文件 ~$*）。"""
    for name in sorted(os.listdir(directory)):
        if name.lower().endswith('.docx') and not name.startswith('~$'):
            yield os.path.join(directory, name)


# ==================== CLI ====================

def main():
    parser = argparse.ArgumentParser(
        description='汇编板块 Word 空格清理工具（见文件顶部详细规则）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('input', help='.docx 文件或目录路径')
    parser.add_argument('-o', '--output', help='输出文件路径（仅对单个文件有效）')
    parser.add_argument('--no-backup', action='store_true', help='原地处理时不备份原文件')
    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f'错误：路径不存在：{args.input}')

    # 单个文件
    if os.path.isfile(args.input):
        if not args.input.lower().endswith('.docx'):
            sys.exit('错误：仅支持 .docx 文件')
        if args.output and os.path.isdir(args.output):
            sys.exit('错误：-o 应为输出文件路径（不是目录）')
        out, changed = process_file(args.input, args.output, backup=not args.no_backup)
        print(f'已处理：{os.path.basename(args.input)} -> {os.path.basename(out)}'
              f'（修改 {changed} 处）')
        return

    # 目录
    if os.path.isdir(args.input):
        if args.output:
            sys.exit('错误：处理目录时请勿使用 -o（目录内文件原地处理）')
        files = list(iter_docx(args.input))
        if not files:
            sys.exit(f'目录中未找到 .docx 文件：{args.input}')
        for path in files:
            out, changed = process_file(path, backup=not args.no_backup)
            print(f'已处理：{os.path.basename(path)}（修改 {changed} 处）')
        print(f'\n共处理 {len(files)} 个文件。')
        return

    sys.exit(f'错误：无法识别的路径类型：{args.input}')


if __name__ == '__main__':
    main()
