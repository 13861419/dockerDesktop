# Tasks

- [ ] Task 1: 多 Docker 引擎——后端存储与 client 分发核心改造
  - [ ] 1.1 在 storage 中新增 engines 表（名称、端点、协议、端口、is_current、created_at）及读写/初始化
  - [ ] 1.2 改造 `docker/client.ts`：从"自动探测单引擎/DOCKER_HOST"改为"读取当前引擎配置并发起连接"；保留 DEFAULT 引擎回退
  - [ ] 1.3 引擎变更后重置依赖旧引擎的内存缓存（事件采集器等）并重启监听
  - [ ] 1.4 验证：server tsc --noEmit 通过；默认无配置时回退到本地默认引擎，容器列表可用

- [ ] Task 2: 多 Docker 引擎——CRUD 与切换 API + 前端页面
  - [ ] 2.1 新增 `routes/engines.ts`：GET 列表 / POST 新增 / PUT 更新 / DELETE 删除 / POST 切换当前
  - [ ] 2.2 删除与切换的边界处理：禁止删除当前引擎或自动回退
  - [ ] 2.3 挂载路由到 app.ts
  - [ ] 2.4 前端 `pages/engines.tsx` + `.less`：引擎列表、新增/编辑弹窗、设为当前、删除
  - [ ] 2.5 Layout 菜单「引擎」+ App.tsx 路由 `/engines`
  - [ ] 2.6 验证：前后端 tsc 通过；切换引擎后容器/镜像请求指向新引擎

- [ ] Task 3: 云端备份——后端存储与 S3/OSS/WebDAV 上传（零依赖）
  - [ ] 3.1 storage 新增 cloud_targets 表（类型/名称/端点/桶/路径/凭据字段）
  - [ ] 3.2 新增 `routes/cloud.ts`：CRUD 目标、`POST /test` 连通性测试、`POST /upload` 上传（基于 node https 手写 S3/OSS/WebDAV PUT，不新增依赖）
  - [ ] 3.3 挂载路由到 app.ts
  - [ ] 3.4 验证：server tsc 通过；WebDAV PUT 请求按规范构造

- [ ] Task 4: 云端备份——前端页面
  - [ ] 4.1 前端 `pages/cloudBackup.tsx` + `.less`：目标列表、新增/编辑弹窗（类型/端点/桶/路径/凭据）、测试连接、选择本地文件上传
  - [ ] 4.2 Layout 菜单「云端备份」+ App.tsx 路由 `/cloudbackup`
  - [ ] 4.3 验证：前端 tsc 通过；上传表单调用 /api/cloud/upload 并展示结果

- [ ] Task 5: 站点 / SSL / 反向代理——后端
  - [ ] 5.1 storage 新增 sites 表（域名、上游 host/port、证书路径、enabled、已用端口）
  - [ ] 5.2 新增 `routes/sites.ts`：站点 CRUD、基于内置 nginx 反代容器生成配置并 reload、启停；SSL 支持查看状态与替换证书文件（含目录挂载）
  - [ ] 5.3 挂载路由到 app.ts
  - [ ] 5.4 验证：server tsc 通过；创建站点后反代容器重启加载新配置

- [ ] Task 6: 站点 / SSL / 反向代理——前端页面
  - [ ] 6.1 前端 `pages/sites.tsx` + `.less`：站点列表（域名/上游/状态）、新增/编辑弹窗、启停、删除、SSL 证书状态与替换
  - [ ] 6.2 Layout 菜单「站点/反代」+ App.tsx 路由 `/sites`
  - [ ] 6.3 验证：前端 tsc 通过；站点 CRUD 与启停可用

- [ ] Task 7: 全量验证与文档
  - [ ] 7.1 运行 server + web 全量 tsc，修复所有类型错误
  - [ ] 7.2 按项目推送规则提交并推送到 `git@github.com:13861419/dockerDesktop.git`（main）
  - [ ] 7.3 更新 README / docs 功能清单（新增引擎、云端备份、站点/SSL）

# Task Dependencies
- Task 2 依赖 Task 1（引擎核心改造先行）
- Task 4 依赖 Task 3
- Task 6 依赖 Task 5
- Task 3 / Task 5 与 Task 1 相互独立，可并行
- Task 7 依赖 Task 2、Task 4、Task 6
