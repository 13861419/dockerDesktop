# Docker Manager 数据迁移指南

本文档说明如何在不同环境之间迁移 Docker Manager 的面板数据（用户配置、镜像源、操作日志等）。

## 数据存储位置

| 平台 | 默认数据目录 | 数据库文件 |
|------|------------|-----------|
| Windows | `<安装目录>/data/` | `docker-manager.db` |
| Linux (deb/rpm) | `/var/lib/docker-manager/` | `docker-manager.db` |
| Linux (开发模式) | `<项目根>/data/` | `docker-manager.db` |

所有业务数据统一存储在单个 SQLite 文件 `docker-manager.db` 中，自包含、可整体复制备份。

## 方式一：复制数据库文件（最简单）

### 同平台迁移

1. 停止 Docker Manager 服务
2. 复制 `data/docker-manager.db`（及同目录下的 `-wal`、`-shm` 文件）到目标机器
3. 启动 Docker Manager 服务

```bash
# Linux 示例
sudo systemctl stop docker-manager
cp /var/lib/docker-manager/docker-manager.db /backup/
# ... 传输到目标机器 ...
sudo cp docker-manager.db /var/lib/docker-manager/
sudo chown dockerman:docker /var/lib/docker-manager/docker-manager.db
sudo systemctl start docker-manager
```

### 跨平台迁移（Windows ↔ Linux）

SQLite 数据库文件是**跨平台二进制兼容**的，可以直接在 Windows 和 Linux 之间复制：

1. 在源平台停止服务
2. 复制 `data/docker-manager.db` 文件
3. 传到目标平台的对应数据目录
4. 启动服务

> **注意**：跨平台迁移时，与平台相关的配置（如 Windows 防火墙规则、宿主机文件路径）可能不兼容。面板会自动检测平台并降级不支持的功能。

## 方式二：配置导入/导出（推荐跨平台迁移）

面板内置了 JSON 格式的配置导入/导出功能，适合跨平台迁移：

### 导出

1. 登录面板 → 系统设置 → 配置导入导出
2. 点击「导出配置」
3. 选择是否包含敏感字段（通知渠道密钥、云端备份口令等）
4. 下载 JSON 文件

### 导入

1. 在目标平台登录面板 → 系统设置 → 配置导入导出
2. 点击「导入配置」
3. 选择 JSON 文件或粘贴内容
4. 选择冲突策略：
   - **覆盖已存在**：导入数据覆盖目标平台的同名配置
   - **跳过已存在**：保留目标平台已有配置，仅导入新项
   - **出错即回滚**：任何冲突导致整个导入回滚
5. 确认导入

> **提示**：导入不包含敏感字段时（脱敏导出），需在导入后重新填写通知渠道密钥、云端备份口令等。

## 方式三：数据库备份/恢复（设置页）

面板设置页提供了数据库级别的备份与恢复：

1. **备份**：系统设置 → 数据备份与恢复 → 导出备份
   - 下载完整的 SQLite 数据库文件（`.db` 格式）

2. **恢复**：系统设置 → 数据备份与恢复 → 选择备份文件并恢复
   - 上传 `.db` 文件，覆盖当前全部数据
   - 恢复后需刷新页面

## Linux 特殊说明

### 数据目录

Linux 安装的默认数据目录为 `/var/lib/docker-manager/`，符合 FHS 标准：

```
/var/lib/docker-manager/
├── docker-manager.db         # 主数据库
├── docker-manager.db-wal     # WAL 日志（运行时）
├── docker-manager.db-shm     # 共享内存（运行时）
└── backups/                  # 备份文件目录
```

### 权限

数据目录的所有者为 `dockerman:docker`，确保面板服务有读写权限：

```bash
sudo chown -R dockerman:docker /var/lib/docker-manager
```

### 从 Windows 迁移到 Linux

1. 在 Windows 上停止服务并备份 `data/` 目录
2. 将 `docker-manager.db` 传到 Linux 服务器
3. 在 Linux 上安装 Docker Manager（使用 `install.sh`）
4. 将数据库文件复制到 `/var/lib/docker-manager/`
5. 修正权限：`sudo chown dockerman:docker /var/lib/docker-manager/docker-manager.db`
6. 启动服务：`sudo systemctl start docker-manager`

### 从 Linux 迁移到 Windows

1. 在 Linux 上停止服务并备份 `/var/lib/docker-manager/docker-manager.db`
2. 将数据库文件传到 Windows
3. 放入 Windows 安装目录的 `data/` 文件夹
4. 启动服务

## 注意事项

- **SQLite 版本兼容性**：本项目使用 Node.js 内置 `node:sqlite` 模块（Node ≥ 22），数据库文件格式与 SQLite 3.35+ 兼容。
- **WAL 文件**：迁移时确保 `-wal` 和 `-shm` 文件也一并复制，否则可能丢失最近的写入。
- **运行中不要复制**：务必先停止服务再复制数据库文件，否则可能损坏数据。
- **镜像/容器不随迁移**：数据库仅包含面板配置，不包含 Docker 镜像、容器、卷等实际数据。迁移后需重新配置镜像源、数据库实例等。
