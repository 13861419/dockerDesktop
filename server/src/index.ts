/**
 * 服务启动入口
 *
 * 读取配置并启动 HTTP 服务，同时打印可访问地址。
 */
import app from './app';
import { startMonitor } from './docker/monitor';
import { setupTerminalServer } from './docker/terminal';
import { setupEventWsServer } from './docker/eventWs';
import { startEventMonitor } from './docker/events';
import { startScheduler, stopScheduler } from './scheduler';
import { startAlerting, stopAlerting } from './alerting';
import { initStorage, closeDb } from './storage';
import { ensureInitialUser } from './users';

const PORT = Number(process.env.PORT) || 9528;
const HOST = process.env.HOST || '0.0.0.0';

// 初始化 SQLite 存储层（建表 + 旧 JSON 数据自动迁移），需早于任何业务请求执行
initStorage();
// 确保默认管理员存在（users 表为空时按 ADMIN_USER / ADMIN_PASS 创建），
// 避免全新环境首次部署因登录接口不触发初始化而无法登录
ensureInitialUser();

// 启动 HTTP 服务，并挂载容器 WebSocket 终端
const server = app.listen(PORT, HOST, () => {
  console.log('==========================================');
  console.log('  Docker 管理面板后端已启动');
  console.log(`  本地访问: http://localhost:${PORT}/api/health`);
  console.log('==========================================');

  // 启动实时监控采集器（异步，不影响服务启动）
  setTimeout(() => {
    try {
      startMonitor();
    } catch (err) {
      console.error('监控采集器启动失败:', err);
    }
  }, 500);

  // 启动 Docker 事件采集器（异步，不影响服务启动）
  setTimeout(() => {
    try {
      startEventMonitor();
    } catch (err) {
      console.error('事件采集器启动失败:', err);
    }
  }, 600);

  // 启动计划任务调度器（异步，不影响服务启动）
  setTimeout(() => {
    try {
      startScheduler();
    } catch (err) {
      console.error('计划任务调度器启动失败:', err);
    }
  }, 800);

  // 启动资源告警服务（异步，依赖监控采集器就绪，稍晚启动）
  setTimeout(() => {
    try {
      startAlerting();
    } catch (err) {
      console.error('告警服务启动失败:', err);
    }
  }, 1500);
});

// 挂载容器 WebSocket 终端
try {
  setupTerminalServer(server);
} catch (err) {
  console.error('终端 WebSocket 挂载失败:', err);
}

// 挂载 Docker 事件实时 WebSocket
try {
  setupEventWsServer(server);
} catch (err) {
  console.error('事件流 WebSocket 挂载失败:', err);
}

// 进程退出时安全关闭数据库连接（兜底落盘 WAL）并停止调度器
for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
  process.on(sig, () => {
    stopScheduler();
    stopAlerting();
    closeDb();
    process.exit(0);
  });
}
process.on('exit', () => closeDb());
