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
fatal() { echo -e "${RED}[REPO][ERROR]${NC} $*" >&2; exit 1; }

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
# pool 命名必须为 包名_版本_架构.deb（下划线），否则 apt 索引工具无法解析
for deb in "$DEB_DIR"/*.deb; do
  [ -f "$deb" ] || continue
  base=$(basename "$deb")            # docker-manager-1.28.6-amd64.deb
  stem=${base%.deb}                  # docker-manager-1.28.6-amd64
  pkgarch=${stem##*-}                # amd64 | arm64
  noarch=${stem%-*}                  # docker-manager-1.28.6
  ver=${noarch#docker-manager-}      # 1.28.6
  [ "$pkgarch" = "$ver" ] && fatal "无法从文件名解析架构: $base（期望 docker-manager-<版本>-<架构>.deb）"
  cp "$deb" "$APT_DIR/pool/main/docker-manager_${ver}_${pkgarch}.deb"
  info "  已添加 docker-manager_${ver}_${pkgarch}.deb"
done

# 生成 Packages 索引（apt-ftparchive 不挑文件名，runner 自带）
for arch in amd64 arm64; do
  BinDir="$APT_DIR/dists/stable/main/binary-$arch"
  mkdir -p "$BinDir"
  cd "$APT_DIR"
  apt-ftparchive packages pool/main/ > "dists/stable/main/binary-$arch/Packages" \
    || fatal "apt-ftparchive ($arch) 执行失败"
  [ -s "dists/stable/main/binary-$arch/Packages" ] || fatal "Packages ($arch) 为空——pool 中无 deb"
  gzip -9c "dists/stable/main/binary-$arch/Packages" > "dists/stable/main/binary-$arch/Packages.gz"
  info "  Packages ($arch) 已生成（$(grep -c '^Package:' "dists/stable/main/binary-$arch/Packages") 个包）"
  cd - >/dev/null
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
# 添加仓库源（Pages 托管为未签名源，使用 trusted=yes）
echo "deb [trusted=yes] https://13861419.github.io/dockerDesktop/apt stable main" \
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

# 检查是否有 .rpm 文件
rpm_count=$(find "$RPM_DIR" -maxdepth 1 -name '*.rpm' -type f 2>/dev/null | wc -l)
if [ "$rpm_count" -gt 0 ]; then
  # 复制 .rpm 文件
  for rpm in "$RPM_DIR"/*.rpm; do
    [ -f "$rpm" ] || continue
    cp "$rpm" "$YUM_DIR/"
    info "  已添加: $(basename "$rpm")"
  done

  # 生成 repodata（createrepo_c 为必需工具，workflow 中已安装）
  if command -v createrepo_c &>/dev/null; then
    createrepo_c "$YUM_DIR"
    info "  repodata 已生成（createrepo_c）"
  elif command -v createrepo &>/dev/null; then
    createrepo "$YUM_DIR"
    info "  repodata 已生成（createrepo）"
  else
    fatal "未找到 createrepo_c / createrepo，无法生成 YUM 元数据（publish-repo 需安装 createrepo_c）"
  fi
else
  info "  无 RPM 文件，跳过 YUM 仓库生成"
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
