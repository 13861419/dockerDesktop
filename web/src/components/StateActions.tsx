/**
 * 容器状态下拉操作菜单（1Panel 风格）
 *
 * 状态徽标即触发按钮：点击展开生命周期操作菜单（启动 / 停止 / 重启 /
 * 强制停止 / 暂停 / 恢复），不适用于当前状态的操作置灰禁用。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import './StateActions.less';

export type ContainerAction = 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause';

interface StateActionsProps {
  /** Docker 容器状态（running / paused / exited ...） */
  state: string;
  /** 点击某个可用操作时回调 */
  onAction: (action: ContainerAction) => void;
}

/** 状态 → 触发按钮文案与配色（与 1Panel 一致：绿色「已启动」胶囊） */
const STATE_PILL: Record<string, { label: string; className: string }> = {
  running: { label: '已启动', className: 'state-pill--running' },
  paused: { label: '已暂停', className: 'state-pill--paused' },
  exited: { label: '已停止', className: 'state-pill--stopped' },
  created: { label: '已创建', className: 'state-pill--stopped' },
  dead: { label: '已失效', className: 'state-pill--dead' },
  restarting: { label: '重启中', className: 'state-pill--restarting' },
};

/** 按当前状态计算各操作是否可用 */
function availableActions(state: string): Record<ContainerAction, boolean> {
  const running = state === 'running';
  const paused = state === 'paused';
  const stopped = state === 'exited' || state === 'created' || state === 'dead';
  return {
    start: stopped,
    stop: running || paused,
    restart: running || paused,
    kill: running || paused,
    pause: running,
    unpause: paused,
  };
}

export default function StateActions({ state, onAction }: StateActionsProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pill = STATE_PILL[state] || { label: state || '未知', className: 'state-pill--stopped' };
  const avail = availableActions(state);

  const ACTIONS: Array<{ key: ContainerAction; label: string }> = [
    { key: 'start', label: t('启动') },
    { key: 'stop', label: t('停止') },
    { key: 'restart', label: t('重启') },
    { key: 'kill', label: t('强制停止') },
    { key: 'pause', label: t('暂停') },
    { key: 'unpause', label: t('恢复') },
  ];

  // 点击组件外部或按 Esc 关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="state-actions" ref={ref}>
      <button
        type="button"
        className={`state-pill ${pill.className}${open ? ' is-open' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('生命周期操作')}
      >
        <span className="state-pill__dot" />
        {t(pill.label)}
        <span className="state-pill__caret" />
      </button>
      {open && (
        <div className="state-actions__menu">
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`state-actions__item${!avail[a.key] ? ' state-actions__item--disabled' : ''}`}
              disabled={!avail[a.key]}
              onClick={() => {
                setOpen(false);
                if (avail[a.key]) onAction(a.key);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
