/**
 * SSL 证书自动续期调度（每日一次 + 启动后首检）
 *
 * 独立于 index.ts 的轻封装：方便单测与手动触发。
 */
import { renewDueCertificates } from './issue';

let timer: ReturnType<typeof setInterval> | null = null;

/** 每日巡检间隔 */
const RENEW_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * 启动续期调度：5 秒后首检（避开启动高峰），此后每日一次。
 */
export function startCertRenewal(): void {
  if (timer) return;
  setTimeout(() => {
    renewDueCertificates().catch(() => {
      // 网络异常静默，次日重试
    });
  }, 5000);
  timer = setInterval(() => {
    renewDueCertificates().catch(() => {
      // 同上
    });
  }, RENEW_INTERVAL_MS);
}

/** 停止调度（测试用） */
export function stopCertRenewal(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
