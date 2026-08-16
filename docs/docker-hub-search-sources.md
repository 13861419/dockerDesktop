# 可搜索 Docker Hub 镜像源清单

> 本文档记录在受限/国内网络下，**能实际用于 Docker Hub 在线搜索**的镜像源，以及实测结论与配置方法。
>
> 截止：2026-08 实测于当前开发网络。社区公益源随时可能限流 / 变更 / 下架，请以文档「可靠性」一节为准，并保留多源与本地兜底。

## 背景

面板的「镜像中心」(Hub) 在线搜索依赖 Docker Hub 的 `search` 接口。国内绝大多数「镜像加速源」**只代理镜像拉取（`docker pull`），并不实现 `search` 接口**，因此搜索往往返回 `401 / 404 / 400 / 429 / 502`——这属于「源不支持搜索」，不是面板 Bug。

`server/src/hubConfig.ts::searchHubRepos()` 会按候选顺序并发请求、取第一个返回合法 `results` 数组的源：

1. 用户在「搜索源」配置的自定义源（最高优先）
2. 用户启用的镜像源
3. 官方 `hub.docker.com`
4. 内置搜索代理源

只要自定义搜索源可达且返回合法结构，搜索即走通成功路径。

## ✅ 当前实测可用的搜索源

以下两个源在当前网络下均返回 **200 + `application/json`**，`results` 为合法数组，且字段与后端 `toHubResult()` 完全对齐（`repo_name` / `short_description` / `star_count` / `pull_count` / `is_official`）。

| 搜索源 | 状态 | 说明 |
|--------|------|------|
| `https://docker-0.unsee.tech` | ✅ 可用 | 独立域名直连，推荐首选 |
| `https://docker.tbap.top` | ✅ 可用 | 由教育镜像 `docker.tbedu.top` 308 重定向而来 |

两者均实现 Docker Hub **web 搜索协议**：

```
GET {base}/v2/search/repositories/?query=<keyword>
→ { "count": 291237, "next": "...", "previous": "", "results": [ ... ] }
```

> 注意：部分源实现的传统 `/v2/search?term=` 协议可能超时或不返回数组，以上两源请使用 `/v2/search/repositories/?query=` 路径（后端两种协议都会尝试）。

## ⚙️ 配置方法

### 面板内配置（推荐）

打开 **镜像中心 → 镜像源 → 搜索源**，填入：

```
https://docker-0.unsee.tech
```

保存后即可在线搜索（备用可填 `https://docker.tbap.top`）。

### 通过 API 配置（脚本/自动化）

```bash
# 登录获取 token
TOKEN=$(curl -s -X POST http://localhost:9528/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin888"}' | jq -r .token)

# 配置自定义搜索源
curl -s -X POST http://localhost:9528/api/hub/search-source \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"host":"https://docker-0.unsee.tech"}'
```

> 该配置写入 SQLite `setting` 表（key `searchSource`），属运行时数据、不进入 Git。

## 🧪 验证

```bash
# 直接验证搜索接口返回合法结构
curl -s "https://docker-0.unsee.tech/v2/search/repositories/?query=nginx"

# 跑面板回归脚本（走真实搜索成功路径，需已配置上述搜索源）
npm run regression:hub
```

## 🔁 本地兜底（不依赖外网）

项目自带本地 mock Docker Hub 搜索服务，适合开发/自动化回归在无外网时使用：

```bash
npm run mock:hub-search        # 启动在 http://127.0.0.1:9530
# 再通过 API 或面板把搜索源配置为 http://127.0.0.1:9530
```

零第三方依赖（Node 内置 http），仅监听回环地址。

## ❌ 实测不可用的源（当前网络，如实记录）

仅作参考，避免重复踩坑：

| 源 | 结果 | 原因 |
|----|------|------|
| `docker.m.daocloud.io` | 401 | 仅拉取代理，不支持搜索 |
| `docker.1ms.run` / `docker.jiaxin.site` / `proxy.vvvv.ee` | 404 / 400 | 仅拉取代理 |
| `docker.hpcloud.cloud` / `dockerproxy.link` | 200 但 HTML | 非搜索 JSON 结构 |
| `docker.xuanyuan.me` | 429 | 免费端限流，需注册专属域名 |
| `docker.1panel.live` / `hub.xdark.top` / `xdark.top` / `dockerproxy.net` / `docker.ckyl.me` | 超时 | 不可达 |
| `dockerhub.jobcher.com` / `mirror.baidubce.com` / `hub-mirror.c.163.com` 等 | DNS 失败 | — |
| `hub.docker.com` 直连 | 超时 | 国内网络受限 |

## ⚠️ 可靠性建议

- 以上可搜索源为**社区公益服务**，可能随流量/合规要求限流、变更或下线。
- 建议**优先用稳定源 + 保持本地 mock 兜底**，不要只依赖单一公网源。
- 面板回归脚本（`regression:hub`）本身就接受「成功」与「优雅降级（搜索失败）」两种结果，因此任意一个源可用/不可用都不会误判。

## 相关代码
- 后端搜索解析：`server/src/hubConfig.ts`（`searchHubRepos` / `toHubResult` / `getSearchSource` / `setSearchSource`）
- 前端：`web/src/pages/hub.tsx`
- 本地 mock：`scripts/mock-hub-search.js`
- 回归脚本：`scripts/regression-hub.js`
