#!/usr/bin/env bash
# ============================================================
#  Docker Manager - 构建 .rpm 包
#  在 Docker 容器内执行，确保与 CentOS 7 兼容
#  用法: bash build-rpm.sh [x86_64|aarch64]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARCH="${1:-x86_64}"
DISTRO="centos7"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
IMAGE_NAME="dm-build-rpm-${ARCH}"
CONTAINER_NAME="dm-build-rpm-${ARCH}-$$"
OUTPUT_DIR="$ROOT_DIR/dist-release"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[BUILD-RPM]${NC} $*"; }
error() { echo -e "${RED}[BUILD-RPM]${NC} $*" >&2; }

# 1. 构建 Docker 镜像
info "构建 Docker 镜像 (CentOS 7, ${ARCH}) ..."
docker buildx build \
  --platform "linux/${ARCH}" \
  --load \
  -f "$SCRIPT_DIR/Dockerfile.centos7" \
  -t "$IMAGE_NAME" \
  "$ROOT_DIR"

# 2. 在容器内执行打包
info "在容器内生成 .rpm 包 ..."
docker run --rm --name "$CONTAINER_NAME" \
  --platform "linux/${ARCH}" \
  -v "$OUTPUT_DIR:/output" \
  "$IMAGE_NAME" \
  bash -c "
    set -euo pipefail

    PKG_NAME='docker-manager'
    PKG_VERSION='${VERSION}'
    PKG_ARCH='${ARCH}'

    # rpm 目录结构
    RPM_DIR=\"/tmp/rpmbuild\"
    mkdir -p \"\$RPM_DIR/SOURCES\"
    mkdir -p \"\$RPM_DIR/SPECS\"
    mkdir -p \"\$RPM_DIR/BUILD\"
    mkdir -p \"\$RPM_DIR/RPMS\"
    mkdir -p \"\$RPM_DIR/SRPMS\"

    # 创建安装目录结构（用于 %files）
    STAGE_DIR=\"/tmp/staging\"
    mkdir -p \"\$STAGE_DIR/opt/docker-manager\"
    mkdir -p \"\$STAGE_DIR/var/lib/docker-manager\"
    mkdir -p \"\$STAGE_DIR/etc/systemd/system\"
    mkdir -p \"\$STAGE_DIR/usr/local/bin\"

    # 复制构建产物
    cp -a /build/server     \"\$STAGE_DIR/opt/docker-manager/\"
    cp -a /build/web/dist   \"\$STAGE_DIR/opt/docker-manager/static\"
    cp /build/packaging/linux/install.sh \"\$STAGE_DIR/opt/docker-manager/\" 2>/dev/null || true
    chmod +x \"\$STAGE_DIR/opt/docker-manager/install.sh\" 2>/dev/null || true

    # 创建环境配置文件
    cat > \"\$STAGE_DIR/opt/docker-manager/server/.env\" <<'ENVEOF'
PORT=9528
HOST=0.0.0.0
WEB_DIR=/opt/docker-manager/static
DATA_DIR=/var/lib/docker-manager
ENVEOF

    # 创建 systemd unit（兼容 systemd 219 / CentOS 7）
    cat > \"\$STAGE_DIR/etc/systemd/system/docker-manager.service\" <<'UNITEOF'
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

    # 复制安装脚本
    cp /build/packaging/linux/install.sh \"\$STAGE_DIR/usr/local/bin/docker-manager-install\" 2>/dev/null || true
    chmod 755 \"\$STAGE_DIR/usr/local/bin/docker-manager-install\" 2>/dev/null || true

    # 创建 spec 文件
    cat > \"\$RPM_DIR/SPECS/\${PKG_NAME}.spec\" <<SPECEOF
Name:           \${PKG_NAME}
Version:        \${PKG_VERSION}
Release:        1%{?dist}
Summary:        Docker Manager - Container Management Panel
License:        MIT
URL:            https://github.com/13861419/dockerDesktop
Source0:        \${PKG_NAME}-\${PKG_VERSION}.tar.gz

BuildArch:      \${PKG_ARCH}
Requires:       docker-ce
Requires:       nodejs >= 22

%description
A web-based Docker management interface similar to 1Panel.
Supports container, image, volume, network, compose, and host file management.

%prep
# 使用预构建的文件（已在容器内构建好）
cp -a /tmp/staging/* %{_builddir}/

%install
cp -a /tmp/staging/* %{buildroot}/

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
    cd /tmp/staging
    tar czf \"\$RPM_DIR/SOURCES/\${PKG_NAME}-\${PKG_VERSION}.tar.gz\" .

    # 构建 RPM
    rpmbuild -bb \"\$RPM_DIR/SPECS/\${PKG_NAME}.spec\" \
      --define \"_topdir \$RPM_DIR\" \
      --buildarch \"\${PKG_ARCH}\"

    # 复制到输出目录
    RPM_FILE=\$(find \"\$RPM_DIR/RPMS\" -name \"\${PKG_NAME}-\${PKG_VERSION}*.rpm\" | head -1)
    if [ -n \"\$RPM_FILE\" ]; then
      cp \"\$RPM_FILE\" /output/
      echo \"已生成: /output/\$(basename \"\$RPM_FILE\")\"
    else
      echo \"错误: RPM 构建失败\" >&2
      exit 1
    fi
  "

info ".rpm 构建完成"
