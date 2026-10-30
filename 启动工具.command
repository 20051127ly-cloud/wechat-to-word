#!/bin/bash
# 微信公众号文章 → Word 自动化工具 一键启动脚本
# 双击即可启动服务并自动打开浏览器

cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo "  微信公众号文章 → Word 自动化工具"
echo "=============================================="
echo ""

# 1. 查找 Node.js（依次探测常见安装位置）
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="node"
else
  for candidate in \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node" \
    "$HOME/.nvm/current/bin/node" \
    "$HOME/.workbuddy/binaries/node/versions/20.18.0/bin/node"; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
  # 兜底：在 .workbuddy 下自动定位任意已安装版本
  if [ -z "$NODE" ]; then
    NODE=$(find "$HOME/.workbuddy/binaries/node/versions" -maxdepth 3 -name node -type f 2>/dev/null | sort | tail -1)
  fi
fi

if [ -z "$NODE" ]; then
  echo "❌ 未检测到 Node.js，请先安装："
  echo "   打开 https://nodejs.org 下载并安装 LTS 版本"
  echo ""
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

echo "✅ 已找到 Node.js：$($NODE --version)"
echo ""

# 2. 检查依赖是否已安装
if [ ! -d "node_modules" ]; then
  echo "⏳ 首次运行，正在安装依赖（可能需要 1-2 分钟）..."
  if command -v npm >/dev/null 2>&1; then
    npm install
  else
    echo "❌ 未检测到 npm，请重新安装 Node.js"
    read -n 1 -s -r -p "按任意键退出..."
    exit 1
  fi
  echo ""
fi

# 3. 获取局域网 IP（供同事访问）
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "本机")

# 4. 启动服务（前台运行，保持窗口打开）
echo "🚀 正在启动服务..."
echo "   本机访问：  http://localhost:3000"
if [ "$IP" != "本机" ]; then
  echo "   局域网访问：http://$IP:3000"
fi
echo ""
echo "（关闭本窗口即停止服务）"
echo ""

# 5. 自动打开浏览器
(sleep 2 && open "http://localhost:3000") &

# 6. 启动服务
PORT=3000 "$NODE" server.js
