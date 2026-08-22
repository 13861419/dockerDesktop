# Docker Manager · Linux 化架构改造设计文档

> 目标：将现有 **Windows 专属**的 Docker 管理面板改造为可同时运行在 **Ubuntu** 与 **CentOS** 上的版本，
> 在不破坏 Windows 现有功能的前提下，通过**平台抽象层**隔离差异，实现"一套代码、多平台运行"。
>
> 本文档为架构设计与逐文件改造指引，供开发实施参考。

---

## 1. 背景与目标

### 1.1 现状

系统当前深度绑定 Windows 平台，核心运行路径如下：

| 领域 | 现状（Windows） | 文件 |
| --- | --- | --- |
| Docker 连接 | named pipe `npipe:////./pipe/...` | `server/src/docker/client.ts` |
| 平台判断 | `os.platform() === 'win32'` | 同上 |
| 防火墙 | `netsh advfirewall` | `server/src/routes/firewall.ts` |
| 宿主机终端 | `powershell.exe` / `cmd.exe` | `server/src/docker/hostTerminalWs.ts` |
| 宿主机监控 | `wmic` 分区 / Windows 物理内存 | `server/src/docker/monitor.ts` |
| 备份打包 | `tar` + `shell:'cmd.exe'` | `server/src/backup/manager.ts` |
| 数据库备份 | `shell:'cmd.exe'` | `server/src/dbBackup.ts`、`routes/databases.ts` |
| 漏洞扫描 | `winget` 安装提示 | `server/src/trivyCli.ts` |
| Compose | Docker Desktop 自带 docker CLI | `server/src/routes/compose.ts` |
| 打包/服务/托盘 | NSIS + NSSM + C# 托盘 | `packaging/` |

### 1.2 目标

1. **Ubuntu 24（24.04 LTS）与 CentOS 7 及以上**（覆盖主流内核、包管理与 systemd 差异）。
2. 保持 Windows 版本功能不回归。
3. 通过**平台抽象层**收敛差异，避免业务层堆叠 `if (platform)`。
4. 提供 Linux 安装脚本 + systemd 服务化，先跑通、再正式打 deb/rpm。

---

## 2. 总体架构：平台抽象层

新建 `server/src/platform/` 目录，对外提供统一接口，业务层只依赖接口：

```
server/src/platform/
├── detect.ts          # isWindows / isLinux / getDistro() / getShell()
├── dockerClient.ts    # 端点探测顺序、socket/npipe/tcp 归一化
├── hostTerminal.ts    # 返回当前平台默认 shell（win→cmd/pwsh, linux→/bin/bash）
├── firewall.ts        # 适配器：netsh | firewalld | ufw | iptables
├── diskMonitor.ts     # 分区统计（win→wmic, linux→df -k / /proc/partitions）
└── exec.ts            # shell 选择 + 引号转义（cmd.exe vs /bin/bash）
```

**原则**：`platform/detect.ts` 是唯一直接调用 `os.platform()` 的地方；其余业务模块改为注入平台对象。

---

## 3. 逐文件改造清单

### 3.1 Docker 引擎连接 — `server/src/docker/client.ts`

- **现有**：`DEFAULT_ENDPOINTS` 固定为 `npipe://` 优先、`unix:///var/run/docker.sock` 在后。
- **改造**：按平台排序探测顺序
  - Windows：`npipe:////./pipe/dockerDesktopLinuxEngine` → `npipe:////./pipe/docker_engine` → `unix://`（保留现状）
  - Linux：`unix:///var/run/docker.sock` → `DOCKER_HOST` / `tcp://`（unix socket 优先）
- **新增** `isLinux()`（`os.platform() !== 'win32'` 即可），`getDistro()` 读 `/etc/os-release`。
- **注意（关键坑）**：Linux 下 `/var/run/docker.sock` 属 `docker` 组，面板进程需在 `docker` 组内才能连接（见 §6.2）。

### 3.2 宿主机终端 — `server/src/docker/hostTerminalWs.ts`

- **现有**：`spawn('powershell.exe' / 'cmd.exe')`，`windowsHide`，`DEFAULT_CWD` 用 `USERPROFILE`。
- **改造**：
  - shell 选择改为经 `platform/hostTerminal.ts` 返回：Windows→`[powershell, cmd]`；Linux→`[/bin/bash, /bin/sh]`。
  - `DEFAULT_CWD`：Linux 用 `process.env.HOME || '/root'`。
  - 去掉 Linux 下 `windowsHide`（该选项仅 Windows 有效）。
  - **注意**：本项目未引入 node-pty，Linux 下同样只能做"持久会话式"而非真 PTY——文档与 UI 提示保持一致（vim/top 类不完美）。

### 3.3 防火墙 — `server/src/routes/firewall.ts`

- **现有**：`IS_WINDOWS` 判断 + `netsh`；非 Windows 直接 400。
- **改造**：抽出 `runFirewall(args)`，由 `platform/firewall.ts` 按平台分发：
  - Windows：`netsh advfirewall firewall ...`（保留现有 RULE_PREFIX、权限探测逻辑）
  - CentOS/Ubuntu + firewalld：`firewall-cmd --permanent --add-port=PORT/PROTO` + `--reload`
  - Ubuntu + ufw：若启用，`ufw allow PORT/PROTO`
  - 兜底 iptables：`iptables -A INPUT -p PROTO --dport PORT -j ACCEPT`
- **探测顺序**：`firewall-cmd --state` 成功 → firewalld；`ufw status` 存在 → ufw；否则尝试 iptables；都不可用则返回 `supported:false`（前端降级隐藏）。
- 现有 `supported/writable` 语义保留，`check` 接口按适配器返回。

### 3.4 宿主机监控 — `server/src/docker/monitor.ts`

- **磁盘分区** `getDiskPartitions()`（第 249 行）：现在 `wmic logicaldisk where DriveType=3`。
  - 改造为按平台分支：Windows 走 wmic；Linux 解析 `df -kP` 输出（mount / total / used）或 `/proc/partitions`。
  - 统一输出 `{ mount, total, free, used, percent }`，与现有 `DiskPartition` 结构一致。
- **内存**（第 432 行）：当前用 `os.totalmem()/freemem()` —— 该 API **本身跨平台**（Linux 读 /proc/meminfo），**无需改动**，仅验证数值口径。
- **GPU**：`nvidia-smi` 跨平台，无需改动。

### 3.5 命令执行层 — `server/src/backup/manager.ts`、`server/src/dbBackup.ts`、`server/src/routes/databases.ts`

- **问题**：大量 `execAsync(cmd, { shell: 'cmd.exe', ... })`。
- **改造**：新增 `platform/exec.ts` 提供 `shellForHost()`（Windows→`cmd.exe`，Linux→`/bin/bash`），并把所有 `shell:'cmd.exe'` 替换为按平台取值。
- 同时需**参数化引号规则**：Windows 命令用双引号包裹路径，Linux 用单引号 + 正确转义。现有逻辑集中在少量 helper（如 `csh()`），改造成 `quoteFor(shell, str)`。
- 涉及文件：
  - `server/src/backup/manager.ts` `packDirToTar`（第 ~136 行）
  - `server/src/dbBackup.ts`（第 ~184 行宿主型 dump）
  - `server/src/routes/databases.ts`（第 ~1169 行）

### 3.6 漏洞扫描 — `server/src/trivyCli.ts`

- 第 76 行安装提示：按平台分支。Windows→`winget`；Linux→`apt install trivy` / `dnf install trivy` / 官方二进制。
- 二进制查找：Windows 用 `where trivy`，Linux 用 `which trivy`（或统一用 `PATH` 探测）。

### 3.7 Compose — `server/src/routes/compose.ts`

- 依赖 `docker compose` CLI。Windows 由 Docker Desktop 自带。
- Linux 需确保系统装有 compose 插件：
  - Ubuntu：`apt install docker-compose-v2`（或 docker 官方源）
  - CentOS：`yum/dnf install docker-compose-plugin`（docker-ce 源）
- 安装脚本中预装（见 §6），路由逻辑本身调用 `docker compose` 命令不变。

### 3.8 平台判断收敛 — `server/src/docker/client.ts` 的 `isWindows()`

- 保留 `isWindows()`，新增 `isLinux()` / `getDistro()` 于 `platform/detect.ts`，业务侧改用平台对象，避免散落 `process.platform`。

---

## 4. 测试层面改造

现有 `server/test/*.test.ts` 多为平台无关 API 测试，但以下需适配：

| 测试 | 现状 | 改造 |
| --- | --- | --- |
| `api-firewall.test.ts` | 断言非 Windows 返回 400 | Linux 下改为断言适配器返回（firewalld/ufw/iptables）；无权限环境返回 `supported:false` |
| `api-hostTerminal.test.ts` | 断言 `cwd` 含 `C:\Windows` | 按平台参数化：Linux 断言 `cwd` 为 `/` 或 `$HOME`、shell 为 bash |
| `api-monitor.test.ts` | 依赖 wmic | Linux 下改用 `df -k` 数据，断言分区结构一致 |

- **新增** `test/platform-detect.test.ts`：验证 `isLinux/getDistro/getShell` 在目标平台返回正确值。
- `server/package.json` 的 `test`/`test:api` 脚本用了 `set TS_NODE_PROJECT=...`（**cmd 语法**），Linux/POSIX shell 需改为 `export` 或去掉（可用 `cross-env` 或 `tsx`/`node --env-file` 消除平台差异）——**这是一个必须处理的构建/测试脚本问题**。
- 引擎要求 `node >= 22`：需在安装脚本中确认目标系统 Node 版本达标。

---

## 5. Ubuntu vs CentOS 差异适配表

> **版本支持范围**：**Ubuntu 24（24.04 LTS）** 与 **CentOS 7 及以上**（7 / 8 / 9 / Stream）。
> CentOS 7 为老系统，Docker/Compose/Node 需特殊处理（见下表）。

| 项 | Ubuntu 24（24.04） | CentOS 7+ | 处理方式 |
| --- | --- | --- | --- |
| 系统内核 | 6.8+（较新） | 3.10（7）/ 4.18（8）/ 5.x-6.x（9/Stream） | 无内核耦合，无需特殊处理 |
| 包管理 | `apt` / `.deb` | `yum`(7)/`dnf`(8,9) · `.rpm` | 安装脚本按发行版分派；后续分别打 deb/rpm |
| systemd 版本 | ✅ 249+（新） | ✅ 219（**CentOS 7，较老**） | systemd unit 用**通用且兼容 219** 的写法，避免新版专属语法 |
| GCC/glibc | 新 | 7 为 glibc 2.17（老） | 若引入原生模块需对 CentOS 7 单独构建；**当前项目零原生依赖，无此问题** |
| 防火墙默认 | `ufw`（也常见 firewalld） | `firewalld` | 适配器自动探测 firewalld→ufw→iptables |
| Docker 安装 | `apt install docker.io` 或官方 `docker-ce` | **CentOS 7 官方源已停更**，用 `docker-ce` 旧版镜像源或 `docker-ee`；8/9 用 docker-ce | 安装脚本按发行版+版本分支引导 |
| Compose 插件包 | `docker-compose-v2` | 7 用独立 `docker-compose`（v1，需 sed/官方源安装）；8/9 用 `docker-compose-plugin` | 按发行版安装；**Compose v2 插件名在 CentOS 7 采用独立二进制方式** |
| Node 安装 | apt 源旧→**nodesource（Ubuntu 24 对应 nodejs 22.x）** / nvm | 7 系统仓库存 node 仅 6/8（**严重不足**）→ 必须用 **nvm 或源码编译**；8/9 用 nodesource/dnf | 安装脚本统一走 nvm 或 nodesource，**避免系统仓库** |
| 全等功能需 node | 22+ | 同左（用 nvm 装 22） | 文档标注"推荐 nvm 安装 Node 22 LTS" |

> **CentOS 7 重点关注**：Node 装机版本普遍过低、Docker 官方仓库已停止对 7 的更新、systemd 为旧版 219。
> 上述三点的解决均由 `install.sh` / 文档显式覆盖，避免"装完跑不起来"。

---

## 6. 打包、服务与安装设计

### 6.1 systemd 服务（替代 NSSM + 托盘）

新增 `packaging/linux/docker-manager.service`：

```ini
[Unit]
Description=Docker Manager Admin Panel
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dockerman
Group=docker              # 关键：加入 docker 组以访问 /var/run/docker.sock
WorkingDirectory=/opt/docker-manager
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/docker-manager/server/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> **托盘（TrayApp.exe）在 Linux 无对应物**：Linux 由 systemd 托管服务无需托盘，`packaging/tray` 与 NSSM 仅在 Windows 打包时使用。`packaging/build-release.js` 第 47 行 `process.platform !== 'win32'` 需扩展为按平台组装（Windows 含 nssm/tray/install.bat；Linux 含 systemd unit + install.sh）。

### 6.2 安装脚本 `packaging/linux/install.sh`

流程（含 **Ubuntu 24 / CentOS 7+ 版本检测分派**）：
1. 检测发行版与版本（解析 `/etc/os-release` 的 `ID` / `VERSION_ID`）：
   - `ubuntu` → 分支 A（24.04 目标）
   - `centos`（7 / 8 / 9 / Stream）→ 分支 B，并区分 **CentOS 7** 单独处理
2. **Node 安装**（关键）：
   - Ubuntu 24：用 nodesource（nodejs 22.x LTS）或 nvm。
   - CentOS 8/9：nodesource / dnf。
   - **CentOS 7**：系统仓库 node 仅 6/8，**必须走 nvm 或源代码编译 Node 22**；否则面板无法运行。
3. 安装 Docker + compose：
   - Ubuntu 24：`apt install docker.io` 或官方 `docker-ce` 源；compose 装 `docker-compose-v2`。
   - CentOS 7：官方 docker 仓库已停更 → 使用旧版 docker-ce 镜像源 **或** `docker-io` 备选方案；compose 用独立 `docker-compose`（v1 二进制）。
   - CentOS 8/9：docker-ce + `docker-compose-plugin`。
4. 创建系统用户 `dockerman`，**加入 `docker` 组**（关键权限，访问 `/var/run/docker.sock`）。
5. 解压 `dist-release` → `/opt/docker-manager`，数据目录指向 `/var/lib/docker-manager` 或 `/opt/docker-manager/data`（保留 SQLite 迁移逻辑现成）。
6. 注册 systemd 服务（unit 文件兼容 CentOS 7 的 systemd 219 写法）+ `systemctl enable --now`。
7. 输出访问地址与默认账号。

### 6.3 数据目录

- 现有单文件 SQLite `data/docker-manager.db` **跨平台无缝迁移**，文档写入迁移指南（复制元 data 目录即可）。
- Linux 数据目录建议 `/var/lib/docker-manager`（或安装目录下 `data/`）。

---

## 7. RBI 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M1 跑起来** | platform 抽象（detect/dockerClient/shell）+ systemd + install.sh | 在 **Ubuntu 24（24.04）** 上部署后，登录并完成容器/镜像/卷 CRUD |
| **M2 全功能** | 监控、备份、数据库 dump、Trivy 平台化 | 双平台核心 API 测试通过 |
| **M3 防火墙** | firewalld/ufw/iptables 适配器 | Ubuntu(CentOS) 上开/关端口规则生效 |
| **M4 正式发布** | deb/rpm 打包 + CI（GitHub Actions 双系统构建）+ 文档 | 一键安装到全新 Ubuntu/CentOS 可运行 |

---

## 8. 风险与对策（PM 视角）

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| **docker.sock 权限** | 面板连不上引擎（最易踩坑） | systemd unit + install.sh 显式加入 `docker` 组，文档特别标注 |
| **防火墙改规则需 root / sudo** | 与 Windows 管理员同理 | 安装脚本明确所有权，检测非 root 时给出 sudo 提示 |
| **命令执行层差异** | `cmd.exe` vs `/bin/bash`、引号转义 | 收敛到 `platform/exec.ts`，集中测试 |
| **功能降级** | Windows-only（托盘、netsh）在 Linux 界面 | 前端隐藏/降级不可用按钮；`supported` 语义已具备 |
| **Node ≥ 22 / Compose 插件缺失** | Ubuntu 24 与 CentOS 8/9 源较新，但系统包未必达标 | 安装脚本统一走 nodesource / nvm，按发行版装 compose 插件 |
| **CentOS 7 专项**（Node 过旧 / 官方 Docker 仓库停更 / systemd 219 旧语法 / glibc 2.17） | 若不分支专项处理，CentOS 7 装后跑不起来 | `install.sh` 对 CentOS 7 单独走 nvm 装 Node 22、用旧 docker-ce 镜像源 + 独立 docker-compose(v1)、systemd unit 用兼容 219 写法 |
| **测试脚本 cmd 语法** | `set` 在 POSIX 不识别 | 重构 test 脚本使其跨平台 |

---

## 9. 附：涉及文件一览

| 文件 | 改动类型 |
| --- | --- |
| `server/src/platform/detect.ts` | 新增 |
| `server/src/platform/dockerClient.ts` | 新增 |
| `server/src/platform/hostTerminal.ts` | 新增 |
| `server/src/platform/firewall.ts` | 新增 |
| `server/src/platform/diskMonitor.ts` | 新增 |
| `server/src/platform/exec.ts` | 新增 |
| `server/src/docker/client.ts` | 改：端点探测顺序 + isLinux |
| `server/src/docker/hostTerminalWs.ts` | 改：shell 平台化 |
| `server/src/routes/firewall.ts` | 改：改用防火墙适配器 |
| `server/src/docker/monitor.ts` | 改：磁盘分区平台化 |
| `server/src/backup/manager.ts` | 改：shell/引号平台化 |
| `server/src/dbBackup.ts` | 改：shell 平台化 |
| `server/src/routes/databases.ts` | 改：shell 平台化 |
| `server/src/trivyCli.ts` | 改：安装/查找平台化 |
| `web/src/pages/firewall.tsx` | 改：按 `supported` 降级隐藏 |
| `server/package.json` | 改：test 脚本跨平台 |
| `packaging/build-release.js` | 改：按平台组装发布物 |
| `packaging/linux/docker-manager.service` | 新增 |
| `packaging/linux/install.sh` | 新增 |
| `server/test/api-firewall.test.ts` 等 | 改：平台断言参数化 |
| `server/test/platform-detect.test.ts` | 新增 |

---

*本文档基于当前代码（Windows 版）梳理，改造以"保留 Windows 能力、平台抽象收敛"为原则。*
