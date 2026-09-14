#!/bin/sh
# DockerManager Edge Agent 一键安装（Linux + systemd）
# 用法：PANEL_URL=http://panel:9528 EDGE_TOKEN=<token> sh -c "$(curl -fsSL <PANEL_URL>/api/edge/agent.sh)"
set -e

if [ -z "$PANEL_URL" ] || [ -z "$EDGE_TOKEN" ]; then
  echo "[edge-agent] 缺少环境变量：PANEL_URL / EDGE_TOKEN" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[edge-agent] 未找到 node，请先安装 Node.js >= 22" >&2
  exit 1
fi

INSTALL_DIR=/opt/dm-edge-agent
mkdir -p "$INSTALL_DIR"

echo "[edge-agent] 下载 agent.js ..."
curl -fsSL "$PANEL_URL/api/edge/agent.js" -o "$INSTALL_DIR/agent.js"

if command -v systemctl >/dev/null 2>&1; then
  echo "[edge-agent] 写入 systemd 服务 ..."
  cat > /etc/systemd/system/dm-edge-agent.service <<EOF
[Unit]
Description=DockerManager Edge Agent
After=network-online.target docker.service

[Service]
Environment=PANEL_URL=$PANEL_URL
Environment=EDGE_TOKEN=$EDGE_TOKEN
ExecStart=$(command -v node) $INSTALL_DIR/agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now dm-edge-agent
  echo "[edge-agent] 已安装并启动：systemctl status dm-edge-agent"
else
  echo "[edge-agent] 未检测到 systemd，请手动运行："
  echo "  PANEL_URL=$PANEL_URL EDGE_TOKEN=$EDGE_TOKEN node $INSTALL_DIR/agent.js"
fi
