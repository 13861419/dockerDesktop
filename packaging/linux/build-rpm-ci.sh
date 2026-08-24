#!/usr/bin/env bash
# ============================================================
#  Docker Manager - 构建 .rpm 包（CI 直接构建，无 Docker）
#  用法: bash build-rpm-ci.sh
#  前置: 已在根目录完成 npm install + web build + tsc
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
OUTPUT_DIR="$ROOT_DIR/dist-release"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[BUILD-RPM]${NC} $*"; }

for ARCH_LABEL in x86_64 aarch64; do
  info "构建 .rpm 包 (${ARCH_LABEL}) ..."
  PKG_NAME="docker-manager"

  # rpm 目录结构
  RPM_DIR="/tmp/rpmbuild-${ARCH_LABEL}"
  rm -rf "$RPM_DIR"
  mkdir -p "$RPM_DIR/SOURCES"
  mkdir -p "$RPM_DIR/SPECS"
  mkdir -p "$RPM_DIR/BUILD"
  mkdir -p "$RPM_DIR/RPMS"
  mkdir -p "$RPM_DIR/SRPMS"

  # staging 目录
  STAGE_DIR="/tmp/staging-${ARCH_LABEL}"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR/opt/docker-manager"
  mkdir -p "$STAGE_DIR/opt/docker-manager/server"
  mkdir -p "$STAGE_DIR/opt/docker-manager/static"
  mkdir -p "$STAGE_DIR/var/lib/docker-manager"
  mkdir -p "$STAGE_DIR/etc/systemd/system"
  mkdir -p "$STAGE_DIR/usr/local/bin"

  # 复制后端编译产物
  cp -a "$ROOT_DIR/server/dist" "$STAGE_DIR/opt/docker-manager/server/"
  cp "$ROOT_DIR/server/package.json" "$STAGE_DIR/opt/docker-manager/server/"

  # 安装后端生产依赖
  cd "$STAGE_DIR/opt/docker-manager/server"
  npm install --omit=dev --ignore-scripts 2>/dev/null
  cd "$ROOT_DIR"

  # 复制前端静态资源
  cp -a "$ROOT_DIR/web/dist/"* "$STAGE_DIR/opt/docker-manager/static/"

  # 复制安装脚本
  cp "$ROOT_DIR/packaging/linux/install.sh" "$STAGE_DIR/opt/docker-manager/" 2>/dev/null || true
  chmod +x "$STAGE_DIR/opt/docker-manager/install.sh" 2>/dev/null || true

  # 环境配置
  cat > "$STAGE_DIR/opt/docker-manager/server/.env" <<'EOF'
PORT=9528
HOST=0.0.0.0
WEB_DIR=/opt/docker-manager/static
DATA_DIR=/var/lib/docker-manager
EOF

  # systemd unit（兼容 systemd 219 / CentOS 7）
  cat > "$STAGE_DIR/etc/systemd/system/docker-manager.service" <<'EOF'
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

  # 复制安装脚本
  cp "$ROOT_DIR/packaging/linux/install.sh" "$STAGE_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true
  chmod 755 "$STAGE_DIR/usr/local/bin/docker-manager-install" 2>/dev/null || true

  # 创建 spec 文件
  cat > "$RPM_DIR/SPECS/${PKG_NAME}.spec" <<SPECEOF
Name:           ${PKG_NAME}
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        Docker Manager - Container Management Panel
License:        MIT
URL:            https://github.com/13861419/dockerDesktop

BuildArch:      ${ARCH_LABEL}
Requires:       docker-ce
Requires:       nodejs >= 22

%description
A web-based Docker management interface similar to 1Panel.
Supports container, image, volume, network, compose, and host file management.

%prep
cp -a /tmp/staging-${ARCH_LABEL}/* %{_builddir}/

%install
cp -a /tmp/staging-${ARCH_LABEL}/* %{buildroot}/

%pre
getent group docker >/dev/null || groupadd docker
getent passwd dockerman >/dev/null || \\
  useradd -r -s /sbin/nologin -d /opt/docker-manager dockerman
usermod -aG docker dockerman || true

%post
systemctl daemon-reload
systemctl enable docker-manager || true
systemctl restart docker-manager || true

%preun
if [ \$1 -eq 0 ]; then
  systemctl stop docker-manager || true
  systemctl disable docker-manager || true
fi

%postun
if [ \$1 -eq 0 ]; then
  systemctl daemon-reload || true
fi

%files
%defattr(-,root,root,-)
%dir /opt/docker-manager
/opt/docker-manager/*
%dir %attr(755,dockerman,docker) /var/lib/docker-manager
/etc/systemd/system/docker-manager.service
/usr/local/bin/docker-manager-install
SPECEOF

  # 生成 tar.gz 源码包
  cd "$STAGE_DIR"
  tar czf "$RPM_DIR/SOURCES/${PKG_NAME}-${VERSION}.tar.gz" .
  cd "$ROOT_DIR"

  # 构建 RPM
  rpmbuild -bb "$RPM_DIR/SPECS/${PKG_NAME}.spec" \
    --define "_topdir $RPM_DIR" \
    --buildarch "${ARCH_LABEL}"

  # 复制到输出目录
  mkdir -p "$OUTPUT_DIR"
  RPM_FILE=$(find "$RPM_DIR/RPMS" -name "${PKG_NAME}-${VERSION}*.rpm" | head -1)
  if [ -n "$RPM_FILE" ]; then
    cp "$RPM_FILE" "$OUTPUT_DIR/"
    info "已生成: $OUTPUT_DIR/$(basename "$RPM_FILE")"
  else
    echo "错误: RPM 构建失败" >&2
    exit 1
  fi

  # 清理
  rm -rf "$RPM_DIR" "$STAGE_DIR"
done

info ".rpm 构建完成"
