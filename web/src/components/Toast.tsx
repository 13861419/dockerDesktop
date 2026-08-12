/**
 * 轻量 Toast 全局通知
 *
 * 通过 ToastProvider 提供 context，页面任意位置调用 showToast 即可弹出提示。
 * 支持 success / error / info 三种类型；错误提示停留时间更长，每条带手动关闭按钮。
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import './Toast.less';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastCtx {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastCtx>({ showToast: () => {} });

/** 各类型的停留时长（ms）：错误提示更久，便于阅读 */
const DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  error: 4500,
};

/** 获取全局 Toast 方法 */
export const useToast = () => useContext(ToastContext);

/** Toast 提供者，包裹应用根节点 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  /** 移除指定 id 的 toast */
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success') => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => dismiss(id), DURATION[type]);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container" role="region" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`}>
            <span className="toast__icon" aria-hidden="true" />
            <span className="toast__msg" title={t.message}>
              {t.message}
            </span>
            <button
              className="toast__close"
              aria-label="关闭"
              onClick={() => dismiss(t.id)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
