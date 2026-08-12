# 备份与恢复中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Docker Desktop 管理面板增加统一的备份与恢复中心，覆盖面板数据、卷、Compose 配置和站点配置的本地备份、下载、删除与恢复。

**Architecture:** 后端新增独立的备份模块，负责生成备份元数据、写入文件、枚举历史、执行恢复，并通过现有 SQLite 和 Docker 能力读取资源状态。前端新增单独页面承载备份列表、创建、下载、删除和恢复确认，侧边栏和路由按现有页面模式接入。第一阶段优先保证本地可用、操作可验证、恢复有二次确认，云端同步仅作为后续增强点。

**Tech Stack:** Node.js, Express, SQLite (`node:sqlite`), Dockerode, React, React Router, TypeScript, Vite.

## Global Constraints

- Operating system: Windows.
- Codebase language: TypeScript for server and web.
- Project layout: backend sources in `server/src`, frontend sources in `web/src`.
- Frontend components follow default-export single-file patterns used in the repo.
- Existing project rule: whenever a development round is complete and verified, the code must be pushed to the remote GitHub repository.
- Existing project rule: do not store secrets, passwords, tokens, or credentials in the repository.
- Existing project rule: run backend and frontend type checks before completion.
- Existing project rule: do not create documentation files unless explicitly required by the user or the implementation plan requires them.
- Existing project rule: keep changes aligned with existing route, layout, and storage patterns already in the project.
- Existing project rule: add function-level comments when generating code.

---

### Task 1: Define backup storage and metadata model

**Files:**
- Modify: `server/src/storage.ts`
- Create: `server/src/backup/types.ts`
- Create: `server/src/backup/manifest.ts`

**Interfaces:**
- Consumes: existing `getDb()` and current SQLite initialization pattern from `server/src/storage.ts`.
- Produces: a typed backup manifest shape used by route handlers and the frontend, including backup id, kind, name, source, createdAt, filePath, size, and status.

- [ ] **Step 1: Write the failing type usage in the new backup types file**

```ts
export type BackupKind = 'database' | 'volume' | 'compose' | 'site';

export interface BackupManifest {
  id: string;
  kind: BackupKind;
  name: string;
  source: string;
  filePath: string;
  size: number;
  status: 'ready' | 'restoring' | 'failed';
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Extend the SQLite schema for backup records and verify the app still boots**

Run: `npm run dev:server`
Expected: server starts without schema errors, and the new backup table is created on startup.

- [ ] **Step 3: Add the minimal storage helpers for listing and writing backup records**

```ts
export function listBackups() {
  return getDb().prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as BackupManifest[];
}
```

- [ ] **Step 4: Run the server type check for the new schema and types**

Run: `npx tsc --noEmit`
Expected: pass with no new TypeScript errors.

---

### Task 2: Implement backup manager service

**Files:**
- Create: `server/src/backup/manager.ts`
- Modify: `server/src/storage.ts` if backup directories or helper paths need to be persisted in the same startup flow.

**Interfaces:**
- Consumes: backup manifest types from `server/src/backup/types.ts`, Docker client helpers from `server/src/docker/client.ts`, and the SQLite helper layer.
- Produces: `createBackup`, `deleteBackupFile`, `restoreBackup`, `readBackupManifest`, and `listBackupFiles` functions for route handlers.

- [ ] **Step 1: Write a minimal failing unit-style usage in the service module**

```ts
const manifest = await createBackup({ kind: 'database', name: 'panel-db' });
console.log(manifest.kind);
```

- [ ] **Step 2: Implement backup file creation for the panel database and configuration snapshots**

```ts
export async function createBackup(input: { kind: BackupKind; name: string; source: string }) {
  // write manifest + payload files under data/backups/<kind>/
}
```

- [ ] **Step 3: Add deletion and restore helpers with path validation and type checks**

```ts
export async function restoreBackup(id: string) {
  // load manifest, validate type, run restore flow, update status
}
```

- [ ] **Step 4: Run the backend type check against the new service module**

Run: `npx tsc --noEmit`
Expected: pass.

---

### Task 3: Add backup REST routes

**Files:**
- Create: `server/src/routes/backups.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/operationLog.ts` if backup operations need a dedicated log entry helper, otherwise reuse the existing logger.

**Interfaces:**
- Consumes: `createBackup`, `restoreBackup`, `listBackupFiles`, `deleteBackupFile`, and `readBackupManifest` from the backup manager.
- Produces: `GET /api/backups`, `POST /api/backups`, `GET /api/backups/:id/download`, `POST /api/backups/:id/restore`, `DELETE /api/backups/:id`.

- [ ] **Step 1: Write the failing route wiring in `app.ts`**

```ts
import backupsRouter from './routes/backups';
app.use('/api/backups', requireAuth, backupsRouter);
```

- [ ] **Step 2: Implement the list/create/download/restore/delete endpoints**

```ts
router.get('/', asyncHandler(async (_req, res) => {
  res.json({ backups: await listBackups() });
}));
```

- [ ] **Step 3: Add destructive-action confirmations and status handling in the route layer**

```ts
router.post('/:id/restore', asyncHandler(async (req, res) => {
  const result = await restoreBackup(req.params.id);
  res.json(result);
}));
```

- [ ] **Step 4: Run the server type check and inspect the route registration**

Run: `npx tsc --noEmit`
Expected: pass, and the server should expose the new `/api/backups` endpoints.

---

### Task 4: Add the backups page and navigation entry

**Files:**
- Create: `web/src/pages/backups.tsx`
- Create: `web/src/pages/backups.less`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Layout.tsx`

**Interfaces:**
- Consumes: `/api/backups` endpoints, existing `get/post/del` API helpers, `useToast`, `Modal`, `ConfirmDialog`, `Empty`, `Loading`, `Field`, and `Input` patterns already used elsewhere in the frontend.
- Produces: a page that lists backups, shows kind/status/size/date, and supports create/download/delete/restore workflows.

- [ ] **Step 1: Write the page skeleton and route import**

```tsx
const BackupsPage = lazy(() => import('./pages/backups'));
```

- [ ] **Step 2: Add the route and sidebar item using the existing route/layout style**

```tsx
<Route
  path="/backups"
  element={
    <PageSuspense>
      <BackupsPage />
    </PageSuspense>
  }
/>
```

- [ ] **Step 3: Implement the backup list, create, download, delete, and restore UI**

```tsx
export default function BackupsPage() {
  return <div />;
}
```

- [ ] **Step 4: Add the page styles and run the frontend type check**

Run: `npx tsc -b`
Expected: pass with no new UI type errors.

---

### Task 5: Verify the backup flows end to end

**Files:**
- Modify: any files needed from Tasks 1 to 4 if verification uncovers issues.

**Interfaces:**
- Consumes: the new API routes and UI page.
- Produces: verified local backup creation, download, deletion, and restore behavior.

- [ ] **Step 1: Start the backend and frontend in development mode**

Run: `npm run dev:server` and `npm run dev:web`
Expected: backend listens on `9528`, frontend listens on `9526`.

- [ ] **Step 2: Exercise the new backup API with at least one create and one list request**

Run: `Invoke-RestMethod http://localhost:9528/api/backups`
Expected: returns a JSON backup list.

- [ ] **Step 3: Verify the frontend page loads and the navigation entry is visible**

Open: `http://localhost:9526/backups`
Expected: backup page renders without runtime errors.

- [ ] **Step 4: Fix any issues, rerun type checks, and prepare the change for commit/push**

Run: `npx tsc --noEmit` in `server`, then `npx tsc -b` in `web`
Expected: both pass.

---

## Self-Review

- Spec coverage: this plan covers storage, backend service logic, REST routes, frontend page, route/layout wiring, and end-to-end verification for local backup and restore flows.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain in the plan content.
- Type consistency: the backup manifest uses one shared `BackupManifest` shape across route and page tasks; route names and endpoint paths are consistent throughout.
- Scope check: the plan stays focused on the first-stage backup and recovery center; cloud sync, schedules, and retention policies are intentionally deferred.
