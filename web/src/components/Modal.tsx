/**
 * 通用模态框组件
 *
 * 支持：点击遮罩 / Esc / 关闭按钮关闭；打开时锁定背景滚动；
 * 初始聚焦移入弹窗并在关闭后归还焦点；通过 aria-labelledby 关联标题。
 */
import React, { useEffect, useRef, useState } from 'react';
import './Modal.less';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  /** 全屏模式（1.51.0）：受控用法，由调用方配合 onToggleFullscreen 管理状态 */
  fullscreen?: boolean;
  /** 传入时由调用方控制全屏切换；未传入时组件自管全屏状态（所有弹窗默认可放大） */
  onToggleFullscreen?: () => void;
  /** 是否显示「放大 / 还原」按钮（默认显示） */
  fullscreenable?: boolean;
}

/**
 * 模态框：点击遮罩或关闭按钮可关闭
 * @param param0 属性
 */
export default function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 560,
  fullscreen: fullscreenProp = false,
  onToggleFullscreen,
  fullscreenable = true,
}: ModalProps) {
  const [innerFull, setInnerFull] = useState(false);
  // 受控（调用方传 onToggleFullscreen）或非受控（组件自管）双模式
  const fullscreen = onToggleFullscreen ? fullscreenProp : innerFull;
  const toggleFullscreen = onToggleFullscreen ?? (() => setInnerFull((v) => !v));
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // 用 ref 持有最新 onClose，避免内联函数导致 effect 频繁重跑
  const onCloseRef = useRef(onClose);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 非受控全屏在弹窗关闭时还原，避免下次打开仍是放大态
  useEffect(() => {
    if (!open) setInnerFull(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // 记录触发元素并锁定背景滚动
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 将初始焦点移入弹窗（modal 容器 tabIndex=-1 可聚焦）
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // 关闭后归还焦点到触发元素
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal${fullscreen ? ' modal--fullscreen' : ''}`}
        style={fullscreen ? undefined : { width: Math.min(width, window.innerWidth - 32) }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
      >
        <div className="modal__header">
          <div className="modal__title" id={titleId.current}>
            {title}
          </div>
          <div className="modal__header-actions">
            {fullscreenable && (
              <button
                className="modal__close"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? '还原' : '放大'}
                title={fullscreen ? '还原' : '放大'}
              >
                {fullscreen ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 3H3v6M15 21h6v-6M3 15v6h6M21 9V3h-6" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 9h6V3M21 15h-6v6M15 3h6v6M9 21H3v-6" />
                  </svg>
                )}
              </button>
            )}
            <button className="modal__close" onClick={onClose} aria-label="关闭">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
