/**
 * PWA 安装辅助（1.87.0）
 *
 * 捕获 beforeinstallprompt 延迟展示「安装到桌面」；
 * iOS 无该事件，走「分享 → 添加到主屏幕」引导文案。
 */
type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

/** 初始化事件监听（main.tsx 挂载时调用一次） */
export function initPwaInstall(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** 是否可触发原生安装弹窗 */
export function canInstall(): boolean {
  return !!deferred;
}

/** 触发原生安装弹窗 */
export async function promptInstall(): Promise<InstallOutcome> {
  if (!deferred) return 'unavailable';
  deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null;
  notify();
  return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
}

/** 是否已以应用（standalone）模式运行 */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS Safari（无 beforeinstallprompt，需手动「添加到主屏幕」） */
export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** 订阅安装可用性变化（返回取消函数） */
export function onPwaInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
