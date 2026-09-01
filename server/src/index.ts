/**
 * 服务启动入口
 *
 * 读取配置并启动 HTTP 服务，同时打印可访问地址。
 */
import app from './app';
import { startMonitor } from './docker/monitor';
import { startContainerMetrics } from './docker/containerMetrics';
import { setupTerminalServer } from './docker/terminal';
import { setupEventWsServer } from './docker/eventWs';
import { setupHostTerminalServer } from './docker/hostTerminalWs';
import { startEventMonitor } from './docker/events';
import { startScheduler, stopScheduler } from './scheduler';
import { startAlerting, stopAlerting } from './alerting';
import { startSelfHeal, stopSelfHeal } from './selfheal';
import { startMetricsHistory } from './metricsHistory';
import { startApprovalReminder } from './approvals';
import { initStorage, closeDb } from './storage';
import { ensureInitialUser } from './users';
import { ensureBuiltinRoles } from './rbac';

const PORT = Number(process.env.PORT) || 9528;
const HOST = process.env.HOST || '0.0.0.0';

// 初始化 SQLite 存储层（建表 + 旧 JSON 数据自动迁移），需早于任何业务请求执行
initStorage();
// 确保默认管理员存在（users 表为空时按 ADMIN_USER / ADMIN_PASS 创建），
// 避免全新环境首次部署因登录接口不触发初始化而无法登录
ensureInitialUser();
// 确保内置角色存在（admin/operator/user/auditor，幂等）
ensureBuiltinRoles();

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

  // 启动容器资源指标采集器（异步，依赖 Docker 客户端就绪，略晚于主机监控）
  setTimeout(() => {
    try {
      startContainerMetrics();
    } catch (err) {
      console.error('容器指标采集器启动失败:', err);
    }
  }, 700);

  // 启动指标小时级聚合器（1.2.0 长周期历史留存，30/90 天曲线数据源）
  setTimeout(() => {
    try {
      startMetricsHistory();
    } catch (err) {
      console.error('指标聚合器启动失败:', err);
    }
  }, 750);

  // 启动审批超时提醒（1.3.0：过期清理 + 超时前催办）
  setTimeout(() => {
    try {
      startApprovalReminder();
    } catch (err) {
      console.error('审批提醒启动失败:', err);
    }
  }, 780);

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

  // 启动容器自愈巡检（异步，与告警同节奏，稍晚启动）
  setTimeout(() => {
    try {
      startSelfHeal();
    } catch (err) {
      console.error('容器自愈服务启动失败:', err);
    }
  }, 1600);
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

// 挂载宿主机会话式终端 WebSocket
try {
  setupHostTerminalServer(server);
} catch (err) {
  console.error('宿主机终端 WebSocket 挂载失败:', err);
}

// 进程退出时安全关闭数据库连接（兜底落盘 WAL）并停止调度器
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      stopScheduler();
      stopAlerting();
      stopSelfHeal();
      closeDb();
      process.exit(0);
    });
  }
process.on('exit', () => closeDb());
