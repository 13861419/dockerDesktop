#!/usr/bin/env bash
# ============================================================
#  Docker Manager - 构建 .deb 包（CI 直接构建，无 Docker）
#  用法: bash build-deb-ci.sh
#  前置: 已在根目录完成 npm install + web build + tsc
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
OUTPUT_DIR="$ROOT_DIR/dist-release"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[BUILD-DEB]${NC} $*"; }

for ARCH in amd64 arm64; do
  info "构建 .deb 包 (${ARCH}) ..."
  PKG_NAME="docker-manager"
  DEB_DIR="/tmp/${PKG_NAME}-${VERSION}-${ARCH}"

  # 清理
  rm -rf "$DEB_DIR"
  mkdir -p "$DEB_DIR/DEBIAN"
  mkdir -p "$DEB_DIR/opt/docker-manager"
  mkdir -p "$DEB_DIR/opt/docker-manager/server"
  mkdir -p "$DEB_DIR/opt/docker-manager/static"
  mkdir -p "$DEB_DIR/var/lib/docker-manager"
  mkdir -p "$DEB_DIR/etc/systemd/system"
  mkdir -p "$DEB_DIR/usr/local/bin"

  # 复制后端编译产物
  cp -a "$ROOT_DIR/server/dist" "$DEB_DIR/opt/docker-manager/server/"
  cp "$ROOT_DIR/server/package.json" "$DEB_DIR/opt/docker-manager/server/"

  # 安装后端生产依赖
  cd "$DEB_DIR/opt/docker-manager/server"
  npm install --omit=dev --ignore-scripts 2>/dev/null
  cd "$ROOT_DIR"

  # 复制前端静态资源
  cp -a "$ROOT_DIR/web/dist/"* "$DEB_DIR/opt/docker-manager/static/"

  # 复制安装脚本
  cp "$ROOT_DIR/packaging/linux/install.sh" "$DEB_DIR/opt/docker-manager/" 2>/dev/null || true
  chmod +x "$DEB_DIR/opt/docker-manager/install.sh" 2>/dev/null || true

  # 环境配置
  cat > "$DEB_DIR/opt/docker-manager/server/.env" <<'EOF'
PORT=9528
HOST=0.0.0.0
WEB_DIR=/opt/docker-manager/static
DATA_DIR=/var/lib/docker-manager
EOF

  # systemd unit
  cat > "$DEB_DIR/etc/systemd/system/docker-manager.service" <<'EOF'
[Unit]
Description=Docker Manager - Container Management Panel
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=dockerman
Group=docker
WorkingDirectory=/opt/docker-manager/server
EnvironmentFile=/opt/docker-manager/server/.env
ExecStart=/usr/bin/node /opt/docker-manager/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docker-manager
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/docker-manager/server /var/lib/docker-manager
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # DEBIAN/control
  cat > "$DEB_DIR/DEBIAN/control" <<CTRL
Package: ${PKG_NAME}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Docker Manager Team
Description: Docker Manager - Container Management Panel
 A web-based Docker management interface similar to 1Panel.
 Supports container, image, volume, network, compose, and host file management.
 Depends: docker-ce, nodejs (>= 22) | nodejs-22, adduser
Section: admin
Priority: optional
CTRL

  # 计算安装大小
  INSTALLED_SIZE=$(du -sk "$DEB_DIR" | cut -f1)
  echo "Installed-Size: ${INSTALLED_SIZE}" >> "$DEB_DIR/DEBIAN/control"

  # postinst
  cat > "$DEB_DIR/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e
if ! id dockerman &>/dev/null; then
  useradd -r -s /sbin/nologin -d /opt/docker-manager dockerman || true
fi
usermod -aG docker dockerman || true
chown -R dockerman:docker /opt/docker-manager
chown -R dockerman:docker /var/lib/docker-manager
systemctl daemon-reload
systemctl enable docker-manager || true
systemctl restart docker-manager || true
POSTINST
  chmod 755 "$DEB_DIR/DEBIAN/postinst"

  # prerm
  cat > "$DEB_DIR/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
systemctl stop docker-manager || true
systemctl disable docker-manager || true
PRERM
  chmod 755 "$DEB_DIR/DEBIAN/prerm"

  # postrm
  cat > "$DEB_DIR/DEBIAN/postrm" <<'POSTRM'
#!/bin/bash
set -e
if [ "$1" = "remove" ]; then
  systemctl daemon-reload || true
fi
POSTRM
  chmod 755 "$DEB_DIR/DEBIAN/postrm"

  # 复制安装脚本到 /usr/local/bin
  cp "$ROOT_DIR/packaging/linux/install.sh" "$DEB_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true
  chmod 755 "$DEB_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true

  # 生成 deb
  mkdir -p "$OUTPUT_DIR"
  DEB_FILE="${OUTPUT_DIR}/${PKG_NAME}-${VERSION}-${ARCH}.deb"
  fakeroot dpkg-deb --root-owner-group --build "$DEB_DIR" "$DEB_FILE"
  info "已生成: $DEB_FILE"

  # 清理
  rm -rf "$DEB_DIR"
done

info ".deb 构建完成"
