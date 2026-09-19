#!/bin/bash
# ============================================================
#  Docker Manager - 特权更新辅助脚本（1.82.0）
#  由 deb/rpm 安装到 /opt/docker-manager/sbin/apply-update.sh，
#  经 docker-manager-update.service（root 一次性单元）执行。
#  面板（dockerman）经 polkit 授权仅能 start 该单元，从而在
#  无免密 sudo、NoNewPrivileges 沙箱下完成包安装与服务重启。
# ============================================================
set -u

RESULT="${RESULT_FILE:-/var/lib/docker-manager/update-result.txt}"
JOB=/var/lib/docker-manager/update-staging/update-job.env

say() { echo "[$1] $(date '+%F %T') $2" >> "$RESULT"; }
say START "特权更新辅助已启动（root=$(id -u)）"

if [ -f "$JOB" ]; then
  # shellcheck disable=SC1090
  . "$JOB"
fi
if [ -z "${PKG_PATH:-}" ] || [ ! -f "$PKG_PATH" ]; then
  say FAIL "更新包不存在或任务文件缺失: ${PKG_PATH:-<empty>}"
  exit 1
fi

# 清理历史中断的包管理状态（1.75.5 语义延续）
dpkg --configure -a >/dev/null 2>&1 || true
INSTALL_LOG=$(mktemp)
if dpkg -i "$PKG_PATH" >/dev/null 2>&1 || rpm -Uvh --replacepkgs "$PKG_PATH" >"$INSTALL_LOG" 2>&1; then
  :
else
  # 安装失败：旧包仍完整——立刻拉回旧版服务（1.75.3 语义延续）
  systemctl reset-failed docker-manager 2>/dev/null || true
  systemctl start docker-manager 2>/dev/null || true
  say FAIL "安装包安装失败（已恢复旧版服务）: $(tail -c 400 "$INSTALL_LOG" | tr '\n' ' ')"
  exit 1
fi

# 稳妥启动：显式 enable + start 带重试（1.75.3 语义延续）
systemctl daemon-reload 2>/dev/null || true
STARTED=0
for attempt in 1 2 3; do
  if systemctl start docker-manager 2>/dev/null; then STARTED=1; break; fi
  sleep 3
  systemctl reset-failed docker-manager 2>/dev/null || true
done

# 健康检查：60 秒轮询；未就绪则强制重启一轮再给 30 秒
OK=0
for i in $(seq 1 30); do
  if systemctl is-active --quiet docker-manager && curl -fsS -m 5 "http://127.0.0.1:${PORT:-9528}/api/health" >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 2
done
if [ "$OK" != "1" ]; then
  systemctl reset-failed docker-manager 2>/dev/null || true
  systemctl restart docker-manager 2>/dev/null || true
  for i in $(seq 1 15); do
    if systemctl is-active --quiet docker-manager && curl -fsS -m 5 "http://127.0.0.1:${PORT:-9528}/api/health" >/dev/null 2>&1; then
      OK=1; break
    fi
    sleep 2
  done
fi

if [ "$OK" = "1" ]; then
  say SUCCESS "升级成功"
else
  say FAIL "升级后服务未就绪（已重试启动）。请手动执行: sudo systemctl restart docker-manager；最近日志: $(journalctl -u docker-manager -n 30 --no-pager 2>/dev/null | tail -c 600 | tr '\n' ' ')"
  exit 1
fi
