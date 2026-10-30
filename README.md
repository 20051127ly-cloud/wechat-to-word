# 公众号文章 → Word 自动化工具

抓取微信公众号文章，自动排版生成排版规范的 Word 文档（`.docx`），支持单篇、批量、以及"只有标题没有链接"的搜索汇编。

> 详细使用说明见 [`使用说明.md`](使用说明.md)；搭建流程与出版工作流示意图见 [`docs/公众号文章转Word工具_搭建流程图.pdf`](docs/公众号文章转Word工具_搭建流程图.pdf)；原工具界面快照见 [`docs/wechat-to-word工具网页.pdf`](docs/wechat-to-word工具网页.pdf)。
> **部署到 GitHub 的详细分步流程见 [`DEPLOY.md`](DEPLOY.md)**（含 SSH/PAT 认证、推送命令、让外部同事使用的三种方式）。

## 功能一览

- **双入口并列**：🧠 轻心理 / 📰 轻纪实 / 🗂️ 汇编（同一页面，无需跳转）
- **单篇抓取**：粘贴链接 → 自动提取标题/作者/正文/图片/参考文献
- **批量抓取**：一次粘贴多个链接 → 批量导出并打包 zip，附 Excel + 纯文本清单（原名、新文件名、作者、来源、链接、失败原因）
- **搜索汇编**：只有"公众号：xxx + 标题列表"时，自动在微信文章库搜索定位每篇链接并汇编成一个 Word；zip 内附搜索定位结果 Excel
- **一键续跑**：仅重跑失败的篇目，已定位的走本地链接库，不重复搜索
- **噪声清理**：删除顶部二维码、底部推广、留言互动区，并以红色标注
- **版权提醒**：命中"视觉中国 / 东方IC / 人民视觉 / IC photo"图源红色标注
- **规范排版**：主标题 24pt、章节 20pt、正文 12pt 宋体；图片宽 14.7cm；参考文献 9pt 灰；文件名 `文章标题（类别）.docx`

## 目录结构

```
├── server.js              # Express 后端（抓取 + 生成 Word + 4 个 API）
├── src/                   # 业务模块（fetcher/parser/docxBuilder/qrDetector/...）
├── public/                # 前端页面 index.html 与静态资源
├── config/                # 链接库 / 搜索源样例 / 公众号名映射
├── tests/                 # 测试（npm test）
├── .github/workflows/     # 回归 CI
├── 启动工具.command         # macOS 一键启动脚本
└── package.json
```

## 一、本地运行（最常用）

### 方式 A：双击启动（macOS 推荐）

双击 `启动工具.command`，脚本会自动：检测 Node → 首次 `npm install` → 取局域网 IP → 打开浏览器 → `node server.js`。

> 若提示"无法打开"，终端执行一次：`chmod +x 启动工具.command`

### 方式 B：命令行（全平台）

```bash
cd wechat-to-word-demo
npm install      # 首次
npm start        # 等价于 node server.js
```

然后浏览器访问 **http://localhost:3000**

### 并发调优（可选）

```bash
IMAGE_CONCURRENCY=8 ARTICLE_CONCURRENCY=4 npm start
```

默认 6 / 3，已按"不被微信限流"取值，一般无需改动。

## 二、给外部同事用的三种部署方式

### 方案 1 · 局域网共享（零成本，需同 WiFi）

保持服务运行（窗口不关），同事浏览器访问 `http://你的局域网IP:3000`。
查看本机 IP：`ipconfig getifaddr en0`（macOS）。

### 方案 2 · 自部署分发包（同事本机双击即用）

把本仓库打包成 zip 发给同事，对方解压后双击 `启动工具.command`（macOS）或 `npm install && npm start`（Windows/Linux）即可，**无需你提供服务器**。

```bash
# 在本机打包（已附带脚本会排除 .git）
zip -r wechat-to-word-demo.zip wechat-to-word-demo -x '*/.git/*'
```

### 方案 3 · 部署到 GitHub + 在线 Node 托管（同事浏览器即用，推荐对外演示）

适合希望"外部同事直接打开一个网址就能用"的场景。本仓库已包含一键部署配置 `render.yaml`，可一键部署到 [Render](https://render.com)（免费 Node 托管，运行真实后端）。

1. **推送到 GitHub**（本仓库已 `git init` 并提交，只需加远程并推送）：

   ```bash
   # 在 GitHub 网页新建空仓库，例如 wechat-to-word，然后：
   git remote add origin https://github.com/<你的用户名>/wechat-to-word.git
   git branch -M main
   git push -u origin main
   ```

2. **部署到 Render**：
   - 登录 Render → New → Blueprint → 关联该 GitHub 仓库
   - 自动读取 `render.yaml`，免费 Web 服务 `npm install` + `npm start`
   - 部署完成后得到公网 URL，发给外部同事即可在线使用

> ⚠️ 注意：微信文章抓取依赖能访问 `mp.weixin.qq.com`。**部署在大陆/香港节点最稳**；海外节点（如 Render 美区）可能因网络原因访问失败，此时建议用方案 1/2 或选亚太节点。

### 方案 4 · GitHub Pages（仅作文档/界面预览，不能真实转换）

GitHub Pages 只能托管静态文件，无法运行 Node 后端，因此**只能展示界面与说明，不能真正生成 Word**。若只需"可观看"的 demo，可将 `public/` 作为静态页发布；真实转换仍请用方案 3 的在线 Node 服务。

## 环境要求

- Node.js ≥ 18（推荐 20）
- 首次运行需联网安装依赖（约 200 个包）

## 质量保障

```bash
npm test          # 10 个测试文件（parser/docx/fetcher/.../risk）
npm run test:risks
npm run test:online
```

CI：`.github/workflows/regression.yml`，push/PR 触发，ubuntu + Node 20 + `npm ci` → `npm run test:report`。
