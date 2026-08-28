#!/bin/bash
# ============================================================
#  Docker Manager - .deb 打包内部脚本（由 build-deb-win.ps1 生成/调用）
#  内容与 build-deb.sh 中 docker run bash -c "..." 一致
#  ⚠ 与 packaging/linux/build-deb.sh 的容器内脚本保持同步
# ============================================================
set -euo pipefail

PKG_NAME='docker-manager'
PKG_VERSION='__VERSION__'
PKG_ARCH='__ARCH__'
DEB_DIR="/tmp/${PKG_NAME}-${PKG_VERSION}-${PKG_ARCH}"

# 创建 deb 包结构
mkdir -p "$DEB_DIR/DEBIAN"
mkdir -p "$DEB_DIR/opt/docker-manager"
mkdir -p "$DEB_DIR/var/lib/docker-manager"
mkdir -p "$DEB_DIR/etc/systemd/system"
mkdir -p "$DEB_DIR/usr/local/bin"

# 复制构建产物
cp -a /build/server     "$DEB_DIR/opt/docker-manager/"
cp -a /build/web/dist   "$DEB_DIR/opt/docker-manager/static"
cp /build/packaging/linux/install.sh "$DEB_DIR/opt/docker-manager/" 2>/dev/null || true
chmod +x "$DEB_DIR/opt/docker-manager/install.sh" 2>/dev/null || true

# 创建环境配置文件
cat > "$DEB_DIR/opt/docker-manager/server/.env" <<'ENVEOF'
PORT=9528
HOST=0.0.0.0
WEB_DIR=/opt/docker-manager/static
DATA_DIR=/var/lib/docker-manager
ENVEOF

# 创建 systemd unit
cat > "$DEB_DIR/etc/systemd/system/docker-manager.service" <<'UNITEOF'
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
UNITEOF

# 创建 postinst 脚本
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

# 创建 prerm 脚本
cat > "$DEB_DIR/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
systemctl stop docker-manager || true
systemctl disable docker-manager || true
PRERM
chmod 755 "$DEB_DIR/DEBIAN/prerm"

# 创建 postrm 脚本
cat > "$DEB_DIR/DEBIAN/postrm" <<'POSTRM'
#!/bin/bash
set -e
if [ "$1" = "remove" ]; then
  systemctl daemon-reload || true
fi
POSTRM
chmod 755 "$DEB_DIR/DEBIAN/postrm"

# DEBIAN/control
cat > "$DEB_DIR/DEBIAN/control" <<CTRL
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Architecture: ${PKG_ARCH}
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

# 复制安装脚本到 /usr/local/bin
cp /build/packaging/linux/install.sh "$DEB_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true
chmod 755 "$DEB_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true

# 生成 deb
DEB_FILE="/output/${PKG_NAME}-${PKG_VERSION}-${PKG_ARCH}.deb"
dpkg-deb --root-owner-group --build "$DEB_DIR" "$DEB_FILE"
echo "已生成: $DEB_FILE"
