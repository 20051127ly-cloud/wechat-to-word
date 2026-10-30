#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Word 正文「参考文献引用标」清理工具

删除正文中的参考文献引用标（如 [1]、[2,3]、[1-3]、[1,3-5]），
但参考文献列表里的编号（如 "[1] 张三. 论人工智能..."）原样保留。

可删除的引用标形式：
  - 单个：  [1]、[12]
  - 离散：  [1,2]、[1, 2]、[1,2,3]
  - 区间：  [1-3]、[1–3]、[1—3]、[1~3]、[1－3]、[1～3]
  - 混合：  [1,3-5]、[1-3,5,7-9]
  - 空格：  [ 1 ]、[1 , 2]、[1 - 3]

严格保留（绝不删除）：
  - 「参考文献」标题及其之后列表区内的所有 [编号]（含 [1]、1.、1、 等样式）
  - 方括号内含字母/中文/其他符号的内容：公式、化学式 [NaCl]、文字说明 [注1]、[见图3]
  - 代码数组 [1, 2, 3]：出现在等宽字体（代码字体）片段中的方括号
  - 表格内容、页眉页脚（python-docx 默认不遍历）
  - 正文其余文字、标点、格式

识别原则（宁可漏删，不可误删）：
  - 引用标必须「完整落在单个 run 内」才删除；跨 run 拆分的方括号一律保留
  - 方括号内只允许数字、逗号、空格、连字符（- – — ― ~ ～ － −）

用法：
  python3 remove_citations.py 文件.docx                  # 原地处理（自动备份 .bak）
  python3 remove_citations.py 文件.docx -o 输出.docx      # 输出到指定文件（不覆盖原文件）
  python3 remove_citations.py 目录                         # 处理目录下所有 .docx（原地 + 备份）
  python3 remove_citations.py 文件.docx --dry-run          # 只预览将删除的内容，不保存
  python3 remove_citations.py 文件.docx --verbose          # 打印每个被删引用标及其上下文
  python3 remove_citations.py 文件.docx --no-backup        # 不备份
"""

import os
import re
import sys
import shutil
import argparse

try:
    from docx import Document
    from docx.oxml.ns import qn
except ImportError:
    sys.exit("缺少 python-docx，请先执行：python3 -m pip install --user python-docx")


# ==================== 引用标匹配 ====================

# 数字：半角 + 全角
DIGIT = '0-9\uFF10-\uFF19'

# 连字符（区间分隔符）变体：- – — ― ~ ～ － −
DASH = r'\-\u2013\u2014\u2015\u007e\uff5e\uff0d\u2212'

# 一个条目：单个数字，或「数字 - 数字」区间（连字符前后可含空格）
NUM = rf'[{DIGIT}]+'
RANGE = rf'{NUM}\s*(?:[{DASH}]\s*{NUM})?'
ITEM = rf'\s*{RANGE}'

# 完整引用标：[ 项, 项, 项 ]
REF_CITE_RE = re.compile(rf'\[{ITEM}(?:,{ITEM})*\]')


# ==================== 参考文献区域识别 ====================

# 「参考文献」标题（含中英文变体，冒号可省略）
REF_TITLE_RE = re.compile(r'^(References?|参考文献|参考资料|参考来源|引用文献)\s*[：:]?')


def is_ref_title(text):
    """判断段落文本是否为「参考文献」标题。"""
    return bool(REF_TITLE_RE.match(text.strip()))


def is_article_title(paragraph):
    """
    判断段落是否为「文章主标题」，用于定位参考文献区的结束边界。
    汇编文档中，每篇参考文献之后紧跟下一篇的主标题（24pt 加粗）。
    """
    for run in paragraph.runs:
        if run.font.bold:
            size = run.font.size
            if size is not None and size.pt >= 24:
                return True
    return False


# ==================== 代码字体（等宽）识别 ====================

# 常见等宽/代码字体关键字。代码数组 [1, 2, 3] 通常出现在这类字体中，予以保护。
MONO_FONT_KEYWORDS = (
    'courier',
    'consolas',
    'monaco',
    'menlo',
    'mono',
    'console',
    'fira code',
    'jetbrains',
    'inconsolata',
    'source code',
    'dejavu',
)


def _run_font_names(run):
    """收集 run 的西文字体名与东亚字体名（小写）。"""
    names = []
    if run.font.name:
        names.append(run.font.name.lower())
    rPr = run._element.rPr
    if rPr is not None and rPr.rFonts is not None:
        ea = rPr.rFonts.get(qn('w:eastAsia'))
        if ea:
            names.append(ea.lower())
    return names


def is_mono_run(run):
    """判断 run 是否使用等宽/代码字体。"""
    for name in _run_font_names(run):
        for kw in MONO_FONT_KEYWORDS:
            if kw in name:
                return True
    return False


# ==================== 段落内引用标删除 ====================

def remove_citations_in_paragraph(para):
    """
    删除单段正文中的引用标，返回被删除的引用标文本列表（供 verbose 使用）。

    只在「完整落在单个非等宽 run 内」时删除；跨 run 或等宽字体的方括号保留。
    """
    runs = para.runs
    if not runs:
        return []

    # 建立每个 run 在段落拼接文本中的 [start, end) 区间，并标记是否等宽
    spans = []          # (run, start, end, is_mono)
    full = []           # 各 run 文本
    offset = 0
    for run in runs:
        t = run.text
        spans.append((run, offset, offset + len(t), is_mono_run(run)))
        full.append(t)
        offset += len(t)

    full_text = ''.join(full)
    if '[' not in full_text:
        return []

    # 收集每个 run 内需要删除的区间（相对该 run 文本的偏移）
    deletions = {}      # id(run) -> [(start_in_run, end_in_run), ...]
    removed_matches = []

    for m in REF_CITE_RE.finditer(full_text):
        s, e = m.span()
        for run, rs, re_, mono in spans:
            # 完整落在该 run 内，且该 run 非等宽 → 删除；否则保留
            if rs <= s and e <= re_:
                if not mono:
                    key = id(run)
                    deletions.setdefault(key, []).append((s - rs, e - rs))
                    removed_matches.append(m.group(0))
                break  # 无论是否删除，本匹配只归属一个 run

    # 逐个 run 应用删除
    for run, rs, re_, mono in spans:
        key = id(run)
        if key not in deletions:
            continue
        t = run.text
        parts = []
        last = 0
        for ds, de in sorted(deletions[key]):
            parts.append(t[last:ds])
            last = de
        parts.append(t[last:])
        run.text = ''.join(parts)

    return removed_matches


# ==================== 文档处理 ====================

def clean_document(doc, verbose=False):
    """
    遍历正文段落，跳过参考文献区，删除其余段落中的引用标。
    返回 (删除总数, 详情列表)。详情列表元素为 (段落序号, 段首上下文, 被删引用标列表)。
    """
    in_reference = False
    total = 0
    details = []

    for idx, para in enumerate(doc.paragraphs):
        text = para.text.strip()

        # 进入参考文献区：标题及其后所有内容原样保留
        if not in_reference and is_ref_title(text):
            in_reference = True
            continue

        if in_reference:
            # 参考文献区结束：遇到下一篇主标题
            if is_article_title(para):
                in_reference = False
            else:
                continue  # 参考文献列表编号原样保留

        # 正常正文段落：删除引用标
        removed = remove_citations_in_paragraph(para)
        if removed:
            total += len(removed)
            if verbose:
                details.append((idx, text, removed))

    return total, details


# ==================== 文件 / 目录处理 ====================

def process_file(src, dst=None, backup=True, dry_run=False, verbose=False):
    doc = Document(src)
    total, details = clean_document(doc, verbose=verbose)

    if verbose:
        _print_details(details)

    if dry_run:
        print(f'[预览] {os.path.basename(src)}：将删除 {total} 处引用标（未保存）')
        return None, total

    if dst is None:
        if backup:
            shutil.copy2(src, src + '.bak')
        doc.save(src)
        out = src
    else:
        doc.save(dst)
        out = dst

    return out, total


def _print_details(details):
    for idx, text, removed in details:
        ctx = text if len(text) <= 60 else text[:60] + '…'
        print(f'  第 {idx + 1} 段：删除 {len(removed)} 处 {removed}')
        print(f'    上下文：{ctx}')


def iter_docx(directory):
    """返回目录下所有 .docx 文件（跳过 Word 临时文件 ~$*）。"""
    for name in sorted(os.listdir(directory)):
        if name.lower().endswith('.docx') and not name.startswith('~$'):
            yield os.path.join(directory, name)


# ==================== CLI ====================

def main():
    parser = argparse.ArgumentParser(
        description='Word 正文参考文献引用标清理工具（见文件顶部详细规则）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('input', help='.docx 文件或目录路径')
    parser.add_argument('-o', '--output', help='输出文件路径（仅对单个文件有效）')
    parser.add_argument('--dry-run', action='store_true', help='只预览将删除的内容，不保存')
    parser.add_argument('--verbose', action='store_true', help='打印每个被删引用标及其上下文')
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
        out, total = process_file(
            args.input, args.output,
            backup=not args.no_backup,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        if not args.dry_run:
            print(f'已处理：{os.path.basename(args.input)} -> {os.path.basename(out)}'
                  f'（删除 {total} 处引用标）')
        return

    # 目录
    if os.path.isdir(args.input):
        if args.output:
            sys.exit('错误：处理目录时请勿使用 -o（目录内文件原地处理）')
        files = list(iter_docx(args.input))
        if not files:
            sys.exit(f'目录中未找到 .docx 文件：{args.input}')
        for path in files:
            out, total = process_file(
                path, backup=not args.no_backup,
                dry_run=args.dry_run, verbose=args.verbose,
            )
            if not args.dry_run:
                print(f'已处理：{os.path.basename(path)}（删除 {total} 处引用标）')
        print(f'\n共处理 {len(files)} 个文件。')
        return

    sys.exit(f'错误：无法识别的路径类型：{args.input}')


if __name__ == '__main__':
    main()
