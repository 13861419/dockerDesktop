/**
 * Express 应用入口
 *
 * 组装中间件与所有 API 路由，统一 /api 前缀。
 * 生产模式下托管前端构建后的静态文件，实现单进程部署。
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';

import containersRouter from './routes/containers';
import imagesRouter from './routes/images';
import volumesRouter from './routes/volumes';
import hubRouter from './routes/hub';
import networksRouter from './routes/networks';
import composeRouter from './routes/compose';
import appstoreRouter from './routes/appstore';
import systemRouter from './routes/system';
import overviewRouter from './routes/overview';
import monitorRouter from './routes/monitor';
import operationLogsRouter from './routes/operationLogs';
import tasksRouter from './routes/tasks';
import filesRouter from './routes/files';
import databasesRouter from './routes/databases';
import eventsRouter from './routes/events';
import healthCheckRouter from './routes/healthCheck';
import buildRouter from './routes/build';
import hostFilesRouter from './routes/hostFiles';
import hostTerminalRouter from './routes/hostTerminal';
import enginesRouter from './routes/engines';
import cloudRouter from './routes/cloud';
import sitesRouter from './routes/sites';
import backupsRouter from './routes/backups';
import firewallRouter from './routes/firewall';
import templatesRouter from './routes/templates';
import swarmRouter from './routes/swarm';
import composeTemplatesRouter from './routes/composeTemplates';
import volumeFilesRouter from './routes/volumeFiles';
import aggregateRouter from './routes/aggregate';
import orchestrateRouter from './routes/orchestrate';
import searchRouter from './routes/search';
import configTransferRouter from './routes/configTransfer';
import notificationsRouter from './routes/notifications';
import transferRouter from './routes/transfer';
import authRouter from './routes/auth';
import { requireAuth } from './auth';

const app = express();

// 允许跨域访问（前后端分离开发时）
app.use(cors());

// JSON 请求体解析
app.use(express.json({ limit: '10mb' }));

// 请求日志（开发环境使用）
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 登录鉴权路由（/login 匿名访问，/logout /me 内部校验会话）
app.use('/api/auth', authRouter);

// 挂载各业务路由（均需登录鉴权）
app.use('/api/overview', requireAuth, overviewRouter);
app.use('/api/system', requireAuth, systemRouter);
app.use('/api/system', requireAuth, configTransferRouter);
app.use('/api/monitor', requireAuth, monitorRouter);
app.use('/api/health-check', requireAuth, healthCheckRouter);
app.use('/api/containers', requireAuth, containersRouter);
app.use('/api/images', requireAuth, imagesRouter);
app.use('/api/volumes', requireAuth, volumesRouter);
app.use('/api/hub', requireAuth, hubRouter);
app.use('/api/networks', requireAuth, networksRouter);
app.use('/api/compose', requireAuth, composeRouter);
app.use('/api/appstore', requireAuth, appstoreRouter);
app.use('/api/operation-logs', requireAuth, operationLogsRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/databases', requireAuth, databasesRouter);
app.use('/api/events', requireAuth, eventsRouter);
app.use('/api/build', requireAuth, buildRouter);
app.use('/api/hostfiles', requireAuth, hostFilesRouter);
app.use('/api/hostterminal', requireAuth, hostTerminalRouter);
app.use('/api/engines', requireAuth, enginesRouter);
app.use('/api/cloud', requireAuth, cloudRouter);
app.use('/api/sites', requireAuth, sitesRouter);
app.use('/api/backups', requireAuth, backupsRouter);
app.use('/api/firewall', requireAuth, firewallRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/templates', requireAuth, templatesRouter);
app.use('/api/swarm', requireAuth, swarmRouter);
app.use('/api/transfer', requireAuth, transferRouter);
app.use('/api/volume-files', requireAuth, volumeFilesRouter);
app.use('/api/aggregate', requireAuth, aggregateRouter);
app.use('/api/orchestrate', requireAuth, orchestrateRouter);
app.use('/api/search', requireAuth, searchRouter);


// 生产模式：托管前端静态文件（单进程部署）
if (process.env.NODE_ENV === 'production') {
  // 静态目录优先级：环境变量 STATIC_DIR > 相对 web/dist（开发构建产物）> 打包目录/static
  const candidates = [
    process.env.STATIC_DIR,
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../../static'),
    path.resolve(process.cwd(), 'static'),
  ].filter(Boolean) as string[];

  const staticDir = candidates.find((dir) => fs.existsSync(dir));

  if (staticDir) {
    app.use(express.static(staticDir));
    // SPA 回退：非 /api 请求统一返回 index.html
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
}

// 404 兜底（API 路径）
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
  } else {
    res.status(404).send('页面不存在');
  }
});

// 全局错误处理
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('未捕获错误:', err);
  res.status(err?.statusCode || 500).json({
    error: err?.message || '服务器内部错误',
  });
});

export default app;
