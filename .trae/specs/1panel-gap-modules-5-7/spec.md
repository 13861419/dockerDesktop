# 1Panel 功能补齐（模块 5-7）Spec

## Why
本项目为 Windows 平台 Docker 管理面板，需对标 1Panel 补齐缺失能力。模块 1-4（事件流、
Dockerfile 构建、宿主机文件管理、宿主机终端）已在先前 agent 阶段实现并推送。本 spec 覆盖
剩余三个高价值模块：多 Docker 引擎切换、云端备份、站点/SSL/反向代理，使面板能力更贴近 1Panel。

## What Changes
- 新增「多 Docker 引擎切换」：支持配置多个 Docker 引擎端点，可全局切换当前引擎，
  所有 docker 相关请求（容器/镜像/卷/网络/Compose/监控/事件/终端等）走当前引擎。
- 新增「云端备份」：为备份/导出提供 S3 / OSS / WebDAV 三种云端存储目标，零第三方依赖，
  基于 Node 内置 https 手写上传。
- 新增「站点 / SSL / 反向代理」：通过内置反向代理容器实现站点域名代理与简易 SSL 证书管理。
- 新增对应侧边栏菜单、前端页面、后端路由及配置持久化（沿用现有 SQLite 零依赖存储）。

## Impact
- Affected specs: 面板功能面（与 1Panel 差异补齐计划的第 5-7 项）
- Affected code:
  - `server/src/docker/client.ts`（多引擎：从自动探测改为按当前引擎分发，**核心改造**）
  - 新增 `server/src/routes/engines.ts` / `server/src/routes/cloud.ts`（备份目标）/
    `server/src/routes/sites.ts`（站点/反代/证书）
  - `server/src/storage.ts`（新增引擎、备份目标、站点相关表）
  - `server/src/app.ts`（挂载新路由）
  - `web/src/App.tsx`、`web/src/components/Layout.tsx`（新增菜单与路由）
  - 新增前端页面 `web/src/pages/engines.tsx`、`cloudBackup.tsx`、`sites.tsx`（及 .less）

## ADDED Requirements

### Requirement: 多 Docker 引擎切换
系统 SHALL 支持配置多个 Docker 引擎端点（名称、端点协议/地址/端口、可选超时），可持久化保存，
并支持将某一引擎设为「当前引擎」。所有依赖 docker 客户端的接口/采集/事件/终端 SHALL 使用当前引擎。
系统 SHALL 在切换引擎后清理/重置依赖旧引擎的内存缓存（如事件采集器）。

#### Scenario: 新增并切换引擎
- **WHEN** 用户在引擎管理页新增一个引擎并点击「设为当前」
- **THEN** 该引擎被持久化为当前引擎，后续容器/镜像等请求指向新引擎，页面提示成功

#### Scenario: 删除当前引擎
- **WHEN** 用户删除正在使用的当前引擎
- **THEN** 系统阻止删除并提示先切换，或自动回退到默认引擎（本地）

### Requirement: 云端备份目标（S3 / OSS / WebDAV）
系统 SHALL 支持配置云端存储目标，类型包括 S3、阿里 OSS、WebDAV，保存端点/桶/路径/凭据等配置。
系统 SHALL 提供「测试连接」与「上传文件」能力，上传基于 Node 内置 https，不引入第三方依赖。
凭据明文仅存储于本地 SQLite；本需求不新增任何 http 第三方库。

#### Scenario: 添加 WebDAV 目标并测试连接
- **WHEN** 用户配置 WebDAV 目标并点击「测试连接」
- **THEN** 系统向后端发起连通性请求并返回成功/失败

#### Scenario: 上传备份文件到云端
- **WHEN** 用户选择一个本地文件与目标后点击上传
- **THEN** 系统将其上传到指定云端路径并返回结果

### Requirement: 站点 / SSL / 反向代理
系统 SHALL 提供站点列表，可通过内置反向代理容器（nginx）实现：站点域名 → 上游地址/端口 的
反向代理，以及 HTTP 站点创建/删除/启停。SSL 证书管理 SHALL 支持查看状态与简单的证书替换
（不包含自动 ACME 签发，避免引入额外依赖），并将证书路径挂载到反代容器。

#### Scenario: 创建一个反向代理站点
- **WHEN** 用户填写域名、上游地址与端口并提交创建站点
- **THEN** 系统创建/更新反向代理容器并展示站点为「运行中」

#### Scenario: 删除站点
- **WHEN** 用户删除一个不再需要的站点
- **THEN** 系统移除对应反代配置并更新容器

## MODIFIED Requirements
（无既有需求被修改；均为新增能力。）

## REMOVED Requirements
（无）
