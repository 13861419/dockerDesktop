#!/usr/bin/env bash
# ============================================================
#  生成 APT / YUM 仓库元数据（用于 GitHub Pages 托管）
#  用法: bash generate-repo.sh <deb-dir> <rpm-dir> <output-dir>
# ============================================================
set -euo pipefail

DEB_DIR="${1:?需要 .deb 文件目录}"
RPM_DIR="${2:?需要 .rpm 文件目录}"
OUTPUT_DIR="${3:?需要输出目录}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[REPO]${NC} $*"; }

mkdir -p "$OUTPUT_DIR"

# ============================================================
#  APT 仓库 (Debian/Ubuntu)
# ============================================================
info "生成 APT 仓库元数据 ..."
APT_DIR="$OUTPUT_DIR/apt"
mkdir -p "$APT_DIR/pool/main"
mkdir -p "$APT_DIR/dists/stable/main/binary-amd64"
mkdir -p "$APT_DIR/dists/stable/main/binary-arm64"

# 复制 .deb 文件到 pool
for deb in "$DEB_DIR"/*.deb; do
  [ -f "$deb" ] || continue
  cp "$deb" "$APT_DIR/pool/main/"
  info "  已添加: $(basename "$deb")"
done

# 生成 Packages 文件（amd64 + arm64）
for arch in amd64 arm64; do
  BinDir="$APT_DIR/dists/stable/main/binary-$arch"
  if ls "$APT_DIR/pool/main/"*"$arch"* &>/dev/null 2>&1; then
    cd "$APT_DIR"
    dpkg-scanpackages --arch "$arch" pool/main/ > "dists/stable/main/binary-$arch/Packages" 2>/dev/null || \
      echo "# 无 $arch 包" > "dists/stable/main/binary-$arch/Packages"
    gzip -9c "dists/stable/main/binary-$arch/Packages" > "dists/stable/main/binary-$arch/Packages.gz"
    info "  Packages ($arch) 已生成"
    cd - >/dev/null
  else
    echo "# 无 $arch 包" > "$BinDir/Packages"
    gzip -9c "$BinDir/Packages" > "$BinDir/Packages.gz"
  fi
done

# 生成 Release 文件
cat > "$APT_DIR/dists/stable/Release" <<EOF
Origin: Docker Manager
Label: Docker Manager
Suite: stable
Codename: stable
Architectures: amd64 arm64
Components: main
Description: Docker Manager - Container Management Panel
Date: $(date -Ru)
SHA256:
EOF

# 计算 SHA256
for f in $(find "$APT_DIR/dists/stable" -type f ! -name "Release" ! -name "Release.gz"); do
  rel_path="${f#$APT_DIR/}"
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
  hash=$(sha256sum "$f" | cut -d' ' -f1)
  echo " ${hash} ${size} ${rel_path}" >> "$APT_DIR/dists/stable/Release"
done

# 生成 signed-by 目录提示
mkdir -p "$APT_DIR"
cat > "$APT_DIR/README.md" <<'README'
# Docker Manager APT 仓库

## 使用方法

```bash
# 导入 GPG 公钥（如已签名）
# curl -fsSL https://13861419.github.io/dockerDesktop/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/docker-manager.gpg

# 添加仓库源
echo "deb [signed-by=/usr/share/keyrings/docker-manager.gpg] https://13861419.github.io/dockerDesktop/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/docker-manager.list

# 安装
sudo apt update
sudo apt install docker-manager
```
README

info "APT 仓库元数据生成完成"

# ============================================================
#  YUM 仓库 (CentOS/RHEL)
# ============================================================
info "生成 YUM 仓库元数据 ..."
YUM_DIR="$OUTPUT_DIR/yum"
mkdir -p "$YUM_DIR/repodata"

# 复制 .rpm 文件
for rpm in "$RPM_DIR"/*.rpm; do
  [ -f "$rpm" ] || continue
  cp "$rpm" "$YUM_DIR/"
  info "  已添加: $(basename "$rpm")"
done

# 生成 repodata（如果 createrepo 可用）
if command -v createrepo &>/dev/null; then
  createrepo "$YUM_DIR"
  info "  repodata 已生成"
else
  # 手动创建 minimal repomd.xml
  RPM_FILE=$(ls "$YUM_DIR"/*.rpm 2>/dev/null | head -1)
  if [ -n "$RPM_FILE" ]; then
    cat > "$YUM_DIR/repodata/repomd.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo">
  <revision>$(date +%s)</revision>
  <data>
    <location href="repodata/primary.xml"/>
    <checksum type="sha256">placeholder</checksum>
    <timestamp>$(date +%s)</timestamp>
    <size>0</size>
    <open-checksum type="sha256">placeholder</open-checksum>
  </data>
</repomd>
XML
    info "  minimal repomd.xml 已生成（安装 createrepo 可生成完整元数据）"
  fi
fi

cat > "$YUM_DIR/README.md" <<'README'
# Docker Manager YUM 仓库

## 使用方法

```bash
# 添加仓库源
cat > /etc/yum.repos.d/docker-manager.repo <<EOF
[docker-manager]
name=Docker Manager
baseurl=https://13861419.github.io/dockerDesktop/yum
enabled=1
gpgcheck=0
EOF

# 安装
yum install docker-manager
# 或
dnf install docker-manager
```
README

info "YUM 仓库元数据生成完成"

# ============================================================
#  生成仓库首页
# ============================================================
cat > "$OUTPUT_DIR/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Docker Manager - Package Repository</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { border-bottom: 2px solid #3b82f6; padding-bottom: 10px; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
    pre { background: #1f2937; color: #e5e7eb; padding: 16px; border-radius: 8px; overflow-x: auto; }
    a { color: #3b82f6; }
    .badge { display: inline-block; background: #10b981; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Docker Manager 包仓库</h1>
  <p>由 GitHub Pages 自动托管，包含 APT (Debian/Ubuntu) 和 YUM (CentOS/RHEL) 仓库。</p>
  <h2>快速安装</h2>
  <h3>Ubuntu / Debian</h3>
  <pre>
# 添加仓库源
echo "deb https://13861419.github.io/dockerDesktop/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/docker-manager.list

sudo apt update && sudo apt install docker-manager</pre>
  <h3>CentOS / RHEL / Fedora</h3>
  <pre>
# 添加仓库源
cat > /etc/yum.repos.d/docker-manager.repo <<EOF
[docker-manager]
name=Docker Manager
baseurl=https://13861419.github.io/dockerDesktop/yum
enabled=1
gpgcheck=0
EOF

sudo yum install docker-manager</pre>
  <h2>其他安装方式</h2>
  <ul>
    <li><a href="https://github.com/13861419/dockerDesktop/releases/latest">GitHub Releases</a> — 直接下载 deb/rpm/exe</li>
    <li><a href="https://ghcr.io/13861419/docker-desktop">ghcr.io</a> — Docker 镜像 <span class="badge">推荐</span></li>
  </ul>
</body>
</html>
HTML

info "仓库首页已生成"
info "全部完成！输出目录: $OUTPUT_DIR"
