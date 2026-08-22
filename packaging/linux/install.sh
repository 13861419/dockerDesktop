#!/usr/bin/env bash
# Docker Manager 安装脚本
# 支持 Ubuntu 24.04 / CentOS 7,8,9 / RHEL 系
set -euo pipefail

# ============================================================
#  颜色
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

# ============================================================
#  常量
# ============================================================
APP_NAME="DockerManager"
INSTALL_DIR="/opt/docker-manager"
DATA_DIR="/var/lib/docker-manager"
SERVICE_NAME="docker-manager"
SERVICE_USER="dockerman"
NODE_MAJOR=22
API_PORT=9528
WEB_PORT=9526
DEFAULT_USER="admin"
DEFAULT_PASS="admin888"

# ============================================================
#  环境检测
# ============================================================
detect_distro() {
  if [ ! -f /etc/os-release ]; then
    fatal "无法检测操作系统：缺少 /etc/os-release"
  fi
  . /etc/os-release
  DISTRO_ID="${ID,,}"          # 转小写
  DISTRO_VERSION="${VERSION_ID%%.*}"  # 取主版本号
  DISTRO_LIKE="${ID_LIKE:-$ID}"

  info "检测到系统: $PRETTY_NAME"
  case "$DISTRO_ID" in
    ubuntu|debian) PKG_TYPE="deb" ;;
    centos|rhel|rocky|almalinux|ol) PKG_TYPE="rpm" ;;
    fedora) PKG_TYPE="rpm" ;;
    *) fatal "暂不支持的发行版: $DISTRO_ID" ;;
  esac
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fatal "请以 root 用户运行此脚本（sudo ./install.sh）"
  fi
}

# ============================================================
#  安装 Node.js 22
# ============================================================
install_node() {
  if command -v node &>/dev/null; then
    local node_ver
    node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_ver" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      info "Node.js 已安装: $(node -v)，版本满足要求"
      return 0
    fi
    warn "已安装 Node.js $(node -v)，但需要 >= v${NODE_MAJOR}，将覆盖安装"
  fi

  info "安装 Node.js ${NODE_MAJOR}.x ..."
  case "$DISTRO_ID" in
    ubuntu)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      apt-get install -y nodejs
      ;;
    debian)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      apt-get install -y nodejs
      ;;
    centos|rhel|rocky|almalinux)
      if [ "$DISTRO_VERSION" -le 7 ] 2>/dev/null; then
        # CentOS 7：nodesource 不再支持，走 nvm
        info "CentOS 7 通过 nvm 安装 Node.js ${NODE_MAJOR} ..."
        export NVM_DIR="/usr/local/nvm"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
        # shellcheck source=/dev/null
        . "$NVM_DIR/nvm.sh"
        nvm install "$NODE_MAJOR"
        nvm alias default "$NODE_MAJOR"
        # 让 systemd 服务也能找到 nvm 安装的 node
        local NVM_BIN
        NVM_BIN="$(nvm which "$NODE_MAJOR")"
        local NVM_DIR_FOR_LINK
        NVM_DIR_FOR_LINK="$(dirname "$NVM_BIN")"
        ln -sf "$NVM_BIN" /usr/local/bin/node
        info "Node.js $(node -v) 已通过 nvm 安装"
      else
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
        yum install -y nodejs || dnf install -y nodejs
      fi
      ;;
    fedora)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      dnf install -y nodejs
      ;;
  esac

  if ! command -v node &>/dev/null; then
    fatal "Node.js 安装失败"
  fi
  info "Node.js 安装完成: $(node -v)"
}

# ============================================================
#  安装 Docker + Docker Compose
# ============================================================
install_docker() {
  if command -v docker &>/dev/null; then
    info "Docker 已安装: $(docker --version)"
  else
    info "安装 Docker ..."
    case "$DISTRO_ID" in
      ubuntu|debian)
        apt-get update
        apt-get install -y ca-certificates curl gnupg
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" \
          | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
          https://download.docker.com/linux/${DISTRO_ID} ${VERSION_CODENAME} stable" \
          > /etc/apt/sources.list.d/docker.list
        apt-get update
        apt-get install -y docker-ce docker-ce-cli containerd.io
        ;;
      centos|rhel|rocky|almalinux|fedora)
        yum install -y yum-utils || dnf install -y yum-utils
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo \
          || dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        yum install -y docker-ce docker-ce-cli containerd.io \
          || dnf install -y docker-ce docker-ce-cli containerd.io
        ;;
    esac
    systemctl enable --now docker
    info "Docker 安装完成"
  fi

  # 安装 Docker Compose（v2 插件）
  if docker compose version &>/dev/null; then
    info "Docker Compose 已安装: $(docker compose version --short)"
  else
    info "安装 Docker Compose 插件 ..."
    local COMPOSE_VERSION
    COMPOSE_VERSION=$(curl -fsSL "https://api.github.com/repos/docker/compose/releases/latest" \
      | grep '"tag_name"' | cut -d'"' -f4)
    local ARCH
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  ARCH="x86_64" ;;
      aarch64) ARCH="aarch64" ;;
      armv7l)  ARCH="armv7" ;;
    esac
    local COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}"
    curl -fsSL "$COMPOSE_URL" -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    info "Docker Compose 安装完成: $(docker compose version --short)"
  fi
}

# ============================================================
#  创建系统用户
# ============================================================
create_user() {
  if id "$SERVICE_USER" &>/dev/null; then
    info "用户 $SERVICE_USER 已存在"
  else
    info "创建系统用户 $SERVICE_USER ..."
    useradd -r -s /sbin/nologin -d "$INSTALL_DIR" "$SERVICE_USER"
  fi
  info "将 $SERVICE_USER 加入 docker 组 ..."
  usermod -aG docker "$SERVICE_USER" || true
}

# ============================================================
#  安装应用文件
# ============================================================
install_app() {
  local SRC_DIR
  SRC_DIR="$(cd "$(dirname "$0")/../../dist-release/DockerManager" && pwd)"

  if [ ! -d "$SRC_DIR/server" ]; then
    fatal "未找到构建产物 $SRC_DIR/server，请先运行打包脚本"
  fi

  info "安装应用到 $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  mkdir -p "$DATA_DIR"

  # 复制文件
  cp -a "$SRC_DIR/server" "$INSTALL_DIR/"
  cp -a "$SRC_DIR/static" "$INSTALL_DIR/"
  # 复制安装脚本自身
  cp "$(realpath "$0")" "$INSTALL_DIR/install.sh" 2>/dev/null || true

  # 创建默认配置文件
  if [ ! -f "$INSTALL_DIR/server/.env" ]; then
    cat > "$INSTALL_DIR/server/.env" <<EOF
# Docker Manager 配置
PORT=${API_PORT}
HOST=0.0.0.0
WEB_DIR=${INSTALL_DIR}/static
DATA_DIR=${DATA_DIR}
EOF
  fi

  chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
  chmod 755 "$INSTALL_DIR"
}

# ============================================================
#  注册 systemd 服务
# ============================================================
install_systemd() {
  info "注册 systemd 服务 ..."
  cat > /etc/systemd/system/${SERVICE_NAME}.service <<'UNIT'
[Unit]
Description=Docker Manager - Container Management Panel
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=%SERVICE_USER_PLACEHOLDER%
Group=docker
WorkingDirectory=%INSTALL_DIR_PLACEHOLDER%/server
EnvironmentFile=%INSTALL_DIR_PLACEHOLDER%/server/.env
ExecStart=/usr/bin/node %INSTALL_DIR_PLACEHOLDER%/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docker-manager

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=%INSTALL_DIR_PLACEHOLDER%/server %DATA_DIR_PLACEHOLDER%
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

  # 替换占位符
  sed -i "s|%SERVICE_USER_PLACEHOLDER%|${SERVICE_USER}|g"   /etc/systemd/system/${SERVICE_NAME}.service
  sed -i "s|%INSTALL_DIR_PLACEHOLDER%|${INSTALL_DIR}|g"     /etc/systemd/system/${SERVICE_NAME}.service
  sed -i "s|%DATA_DIR_PLACEHOLDER%|${DATA_DIR}|g"           /etc/systemd/system/${SERVICE_NAME}.service

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  info "服务已启动"
}

# ============================================================
#  防火墙放行
# ============================================================
configure_firewall() {
  info "配置防火墙放行端口 $API_PORT, $WEB_PORT ..."
  if command -v firewall-cmd &>/dev/null; then
    firewall-cmd --permanent --add-port=${API_PORT}/tcp 2>/dev/null || true
    firewall-cmd --permanent --add-port=${WEB_PORT}/tcp 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
  elif command -v ufw &>/dev/null; then
    ufw allow ${API_PORT}/tcp 2>/dev/null || true
    ufw allow ${WEB_PORT}/tcp 2>/dev/null || true
  else
    warn "未检测到防火墙管理工具，请手动放行端口 $API_PORT/$WEB_PORT"
  fi
}

# ============================================================
#  输出安装信息
# ============================================================
print_summary() {
  local IP
  IP=$(hostname -I 2>/dev/null | awk '{print $1}') || IP="<服务器IP>"

  echo ""
  echo -e "${CYAN}============================================${NC}"
  echo -e "${GREEN}  Docker Manager 安装完成！${NC}"
  echo -e "${CYAN}============================================${NC}"
  echo ""
  echo -e "  访问地址:  ${GREEN}http://${IP}:${WEB_PORT}${NC}"
  echo -e "  默认账号:  ${YELLOW}${DEFAULT_USER} / ${DEFAULT_PASS}${NC}"
  echo ""
  echo -e "  安装目录:  ${INSTALL_DIR}"
  echo -e "  数据目录:  ${DATA_DIR}"
  echo -e "  服务管理:  systemctl {start|stop|restart|status} ${SERVICE_NAME}"
  echo -e "  查看日志:  journalctl -u ${SERVICE_NAME} -f"
  echo ""
  echo -e "${YELLOW}  提示：首次登录后请立即修改默认密码！${NC}"
  echo -e "${CYAN}============================================${NC}"
}

# ============================================================
#  主流程
# ============================================================
main() {
  echo ""
  echo -e "${CYAN}============================================${NC}"
  echo -e "${GREEN}  Docker Manager 安装程序${NC}"
  echo -e "${CYAN}============================================${NC}"
  echo ""

  need_root
  detect_distro
  install_docker
  install_node
  create_user
  install_app
  install_systemd
  configure_firewall
  print_summary
}

main "$@"
