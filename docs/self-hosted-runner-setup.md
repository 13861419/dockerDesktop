# 自托管 Runner（Self-hosted Runner）安装配置指南

> 用途：让 GitHub Actions 的任务（如 AI 代码审查 `ai-review.yml`）在自己电脑上执行。
> 适用：团队任何一台新电脑接入 runner 时照此操作。最后更新：2026-10-28。

---

## 1. 为什么需要自托管 runner

AI 审查需要调用团队的中转站模型接口（`lbai.ihanchen.com`）。该接口**不对海外 IP 开放**，
而 GitHub 官方托管 runner（ubuntu-latest）全在海外机房，连接必然失败（HTTP 000 / curl_failed）。

方案：把该 job 派发到自己的电脑上执行（`runs-on: self-hosted`），自家机器能访问中转站，问题解决。

| 对比 | GitHub 托管 runner | 自托管 runner |
|---|---|---|
| 运行位置 | GitHub 海外机房 | 自己的电脑 |
| 访问国内中转站 | ❌ 被拒 | ✅ 正常 |
| 需要保持开机在线 | 否 | **是**（离线时任务排队等待） |
| 适用 job | CI 五项检查（unit/typecheck/docs/api/e2e） | AI 审查等需内网资源的 job |

---

## 2. 前提条件

| 条件 | 要求 | 检查方法 |
|---|---|---|
| Git | 已安装，PATH 可寻址 | `git --version` |
| Node | **≥ 18**（内置 fetch） | `node -v` |
| 网络 | 能访问 AI 接口基地址（AI_BASE_URL） | `curl -s http://lbai.ihanchen.com:21288/v1/models`，返回 401 即通 |
| 开机在线 | 电脑需常开联网才接单 | — |

---

## 3. Windows 安装步骤

### 3.1 下载并配置

1. 浏览器登录 GitHub → 进入仓库 → **Settings → 左侧 Actions → Runners → New self-hosted runner**
2. 选 **Windows / x64**，页面会给出对应的下载命令（**token 每次进入页面都不同**，以页面为准）：

   ```powershell
   # 示例（以页面实际显示为准）：
   mkdir C:\actions-runner; cd C:\actions-runner   # 目录不要建在仓库里
   # 从 GitHub 页面复制 Download 对应的两条命令执行
   ```

3. 配置（用页面复制的完整命令，或回车全用默认值）：

   ```powershell
   cd C:\actions-runner
   .\config.cmd --url https://github.com/13861419/dockerDesktop --token <页面上的token>
   ```

   > 交互式提问全部回车用默认值；最后一步 **"Would you like to run as a service?" 先填 `N`**，
   > 先用交互模式验证，成功后再装服务（见 3.3）。

### 3.2 启动（交互模式）

```powershell
.\run.cmd
```

看到 `Listening for Jobs` 即在线待命。**该窗口必须保持开启，关闭窗口 = runner 下线。**

验证：回 GitHub 仓库 **Settings → Actions → Runners**，列表出现 `Idle` 状态的 runner 即成功。

### 3.3 装成 Windows 服务（开机自动在线，验证通过后再做）

```powershell
# 先停掉 run.cmd（Ctrl+C），然后：
cd C:\actions-runner
.\config.cmd remove        # 移除交互模式配置
.\config.cmd               # 重新配置（token 从页面重新复制）
# 最后一问 "Would you like to run as a service?" 填 Y
# 服务名默认 actions.runner.<仓库>-<随机后缀>，装完自动启动
```

服务模式开机自启、无需开窗口。管理服务：`services.msc` 找到对应服务重启/停止。

---

## 4. Linux 安装（简述）

```bash
mkdir actions-runner && cd actions-runner
# 从 GitHub 页面复制 Linux x64 的下载命令
./config.sh --url https://github.com/13861419/dockerDesktop --token <token>
./run.sh                      # 交互模式
# 服务模式：config.sh 最后 SVC 问 Y，或 sudo ./svc.sh install && sudo ./svc.sh start
```

---

## 5. 仓库侧必配项（一次性）

路径：仓库 **Settings → Secrets and variables → Actions**

| 类型 | 名称 | 值 | 说明 |
|---|---|---|---|
| Secret | `AI_API_KEY` | 中转站 API Key（sk-开头） | 必填，缺失时 job 优雅跳过（绿色但无审查） |
| Variable | `AI_BASE_URL` | `http://lbai.ihanchen.com:21288/v1` | 接口基地址 |
| Variable | `AI_MODEL` | `Jfclaw-1.0` | 模型名 |

> 命令行方式：`gh secret set AI_API_KEY`、`gh variable set AI_BASE_URL --body "..."`。

---

## 6. 验证

1. 新开一个测试 PR（或对已有 PR 的检查点 Re-run）；
2. 本机 `run.cmd` 窗口开始滚动日志 = 已接单；
3. PR 里先出现「🤖 AI 审查进行中…」，约 1~3 分钟后被替换为正式审查结果（按 REVIEW.md 分级输出）。

---

## 7. 排障速查（踩过的坑）

| 现象 | 原因 | 处理 |
|---|---|---|
| job 一直排队（Queued） | runner 未在线 | 启动 `run.cmd` 或检查服务状态 |
| job 绿色但 PR 无审查评论 | `AI_API_KEY` 为空，脚本优雅跳过 | 按 §5 配置 Secret；看 Actions 日志有 notice |
| HTTP 000 / curl_failed | runner 在海外托管机器上跑（未用自托管） | 确认 workflow 为 `runs-on: self-hosted` |
| Re-run 跑的还是旧逻辑 | 旧 run 固定旧版 workflow 文件 | 把最新 main 合并进 PR 分支后再触发（**改 workflow 后必踩**） |
| 接口返回 200 但无审查内容 | 模型名不对或 max_tokens 不够 | 核对 `AI_MODEL` |
| Key 无效（401 Invalid token） | Secret 里的 Key 错误/过期 | 重新 `gh secret set AI_API_KEY` |

---

## 8. 安全注意事项

- workflow 已加防护：**外部 fork 的 PR 不会在本机执行**（`if: head.repo.fork != true`）；
- runner 只接本仓库任务，不要复用给其他仓库；
- 本机 runner 能访问中转站与本地文件，**不要在公共仓库随意放宽 job 触发条件**；
- API Key 只存 GitHub Secret，不写进代码和文档。

## 9. 维护

- **升级**：停服务 → 覆盖解压新版本 → 重启服务（runner 版本过期时 GitHub 页面会有提示）；
- **移除**：`.\config.cmd remove`（服务模式先 `svc` 卸载），再到 Runners 页面确认消失。
