# 部署到 GitHub 详细流程

本文件面向「把这个微信公众号转 Word 工具发布到 GitHub，并让外部同事能用/能看」的完整步骤。
即使你完全不懂 Git，照着做也能完成。

---

## 0. 本仓库当前状态（已为你准备好）

仓库目录：`/Users/veraliu/CodeBuddy/20261029205918/wechat-to-word-demo/`

已经做完的事：
- ✅ `git init` 并完成首次提交（commit）
- ✅ 已排除 `node_modules/` 与缓存，体积约 19MB（主要是 `public/assets` 里的中文地图/背景图）
- ✅ 含 `README.md`（使用说明）、`render.yaml`（一键部署到 Render）、`docs/`（流程图 PDF + 原网页 PDF）
- ✅ 代码、配置、测试、CI 工作流齐全

**你只需要做两件事**：① 在 GitHub 网页建一个空仓库；② 把本地仓库推上去。
后面第 4 节给的就是这两条命令。

---

## 1. 准备工作

需要：
1. 一个 GitHub 账号（https://github.com ，免费注册）
2. 本机已安装 Git（本机已有 `/usr/bin/git`）
3. 选择一种「身份认证」方式（二选一，推荐 SSH）：
   - **方式 A：SSH Key**（一次配置，永久免密）
   - **方式 B：Personal Access Token（PAT）**（HTTPS 方式，每次 push 用 token 当密码）

---

## 2. 在 GitHub 网页创建仓库

1. 登录 GitHub → 右上角 **＋** → **New repository**
2. 填写：
   - Repository name：`wechat-to-word`（或你喜欢的名字）
   - Description（可选）：微信公众号文章 → Word 自动化工具
   - 选择 **Public**（外部同事要能访问源码）或 **Private**（仅受邀同事）
   - ⚠️ **不要**勾选 "Add a README file" / "Add .gitignore" / "Choose a license" —— 因为本地仓库已经有这些文件，勾了反而会产生冲突
3. 点击 **Create repository**
4. 创建后页面会显示一个仓库地址，形如：
   - HTTPS：`https://github.com/<你的用户名>/wechat-to-word.git`
   - SSH：`git@github.com:<你的用户名>/wechat-to-word.git`
   复制其中一个备用（SSH 推荐）。

---

## 3. 配置 Git 身份认证

### 方式 A：SSH Key（推荐，一劳永逸）

```bash
# 1) 若还没有 SSH key，生成一个（一路回车即可，邮箱换成你的）
ssh-keygen -t ed25519 -C "you@example.com"

# 2) 打印公钥，全选复制
cat ~/.ssh/id_ed25519.pub
```

然后：
- GitHub → 右上角头像 → **Settings** → 左侧 **SSH and GPG keys** → **New SSH key**
- Title 随便填（如 `my-mac`），Key 粘贴刚才复制的内容 → **Add SSH key**

验证连通：
```bash
ssh -T git@github.com
# 看到 "Hi <用户名>! You've successfully authenticated..." 即成功
```

> 本机当前**没有** SSH key，所以需要先执行上面的 `ssh-keygen`。

### 方式 B：HTTPS + Personal Access Token（PAT）

1. GitHub → 右上角头像 → **Settings** → 左侧 **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
2. Note 填 `wechat-to-word-deploy`，Expiration 按需（如 90 天）
3. 勾选 **repo**（完整仓库控制权）这一项即可
4. 点击 **Generate token**，**立即复制**那串 `ghp_xxx`（只显示一次）
5. 之后 push 时，用户名填 GitHub 账号，密码/密码处**粘贴这个 token**（不是登录密码）

> 想更省事可装 `gh` CLI：`brew install gh` 然后 `gh auth login` 按提示登录，之后 push 免手动填 token。

---

## 4. 推送到 GitHub（核心两步）

打开终端，执行（把 `<...>` 换成你的实际值）：

```bash
cd /Users/veraliu/CodeBuddy/20261029205918/wechat-to-word-demo

# 用 SSH 地址（推荐）：
git remote add origin git@github.com:<你的用户名>/wechat-to-word.git

# 或者用 HTTPS 地址（配合 PAT）：
# git remote add origin https://github.com/<你的用户名>/wechat-to-word.git

git branch -M main
git push -u origin main
```

- 用 SSH：直接推送成功（第 3 节已配好 key）
- 用 HTTPS：会弹窗/提示输入账号密码，密码处粘贴 **PAT**

看到类似 `main -> main` 的提示即推送成功。刷新 GitHub 仓库页面即可看到所有文件。

---

## 5. 推送后验证

- ✅ 文件齐全：`README.md`、`server.js`、`src/`、`public/`、`config/`、`render.yaml`、`docs/`、`使用说明.md`、`.github/`
- ✅ 自动 CI：仓库 **Actions** 标签页会自动跑回归测试（`.github/workflows/regression.yml`），等几分钟看是否全绿
- ✅ 文档预览：GitHub 会自动渲染 `README.md`；`docs/` 里的两份 PDF 可直接在线查看/下载

---

## 6. 让外部同事使用（三种路径）

### 路径 A：同事自部署（最稳，推荐给"要使用"的同事）

同事拿到仓库后本地运行，无需你提供服务器：
```bash
git clone https://github.com/<你的用户名>/wechat-to-word.git
cd wechat-to-word
npm install      # 首次，需联网
npm start        # 或 Mac 双击 启动工具.command
```
浏览器打开 `http://localhost:3000`。
（也可直接下载本仓库的 `wechat-to-word-demo.zip` 解压即用。）

### 路径 B：部署成在线服务（外部同事浏览器即用，推荐给"要看 demo"的人）

真实后端需要能跑 Node 的托管平台。本仓库已带 `render.yaml`，可一键部署到 [Render](https://render.com)（免费）：
1. 注册 Render → **New** → **Blueprint**
2. 关联你的 GitHub 仓库 `wechat-to-word`
3. 自动读取 `render.yaml`，创建免费 Web 服务（`npm install` + `npm start`）
4. 部署完得到公网地址，如 `https://wechat-to-word.onrender.com`，发给同事即可在线使用

> ⚠️ 微信文章抓取依赖能访问 `mp.weixin.qq.com`。**把 Render 节点选在亚太/新加坡/法兰克福**比美区更稳；若美区抓取失败，就是网络问题，不是代码问题。

### 路径 C：GitHub Pages（仅"可观看"，不能真实转换）

GitHub Pages 只能托管静态文件，跑不了 Node 后端，因此**只能展示界面与说明，不能真正生成 Word**。若只需给同事"看一眼长什么样"，可把 `public/` 作为静态页发布；真实转换请用路径 B。

---

## 7. 常见问题（FAQ）

**Q1：push 提示 `Permission denied (publickey)`？**
→ 没配 SSH key 或 key 没加到 GitHub。回到第 3 节方式 A。或改用 HTTPS + PAT（方式 B）。

**Q2：push 提示 `failed to push some refs` / 非快进？**
→ 多半是你在 GitHub 建仓库时勾选了初始化 README/.gitignore，造成远端有本地没有的提交。
解决：删掉重建成空仓库（第 2 节提醒过不要勾选）；或 `git pull origin main --allow-unrelated-histories` 后再 push。

**Q3：抓取微信文章失败 / 限流？**
→ 并发度已按"不被微信限流"设为默认值（图片 6 / 文章 3）。海外服务器网络也可能导致失败，优先用路径 A 或选亚太节点（路径 B）。

**Q4：3000 端口被占用？**
→ 换端口：`PORT=8080 npm start`，访问 `http://localhost:8080`。

**Q5：仓库 19MB 会不会太大推不上去？**
→ GitHub 单文件上限 100MB，本仓库远小于此，正常。

---

## 8. 想让我（AI）直接代推？

如果嫌上面麻烦，给我一个 **GitHub Personal Access Token**（勾了 `repo` 权限，见第 3 节方式 B），
我就可以直接帮你：创建说明、设置远程、执行 `git push`，把仓库完整推到你的 GitHub 账号下。
（token 属于敏感信息，仅本次会话使用，用后建议立即在 GitHub 撤销。）
