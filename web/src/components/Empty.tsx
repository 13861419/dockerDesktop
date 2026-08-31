/**
 * 空状态 / 错误态 / 搜索无结果 通用组件
 */
import React from 'react';
import { useLang } from '../i18n';
import './Empty.less';

type EmptyKind = 'empty' | 'error' | 'search';

interface EmptyProps {
  /** 展示类型：空数据 / 加载或执行失败 / 搜索无结果 */
  kind?: EmptyKind;
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

/** 各类图标（按 kind 切换） */
const ICONS: Record<EmptyKind, React.ReactNode> = {
  empty: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  error: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.2v.01" />
    </svg>
  ),
  search: (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
};

/**
 * 空状态 / 错误态 / 搜索无结果 占位
 * @param param0 属性
 */
export default function Empty({
  kind = 'empty',
  title = '暂无数据',
  description,
  action,
}: EmptyProps) {
  const { t } = useLang();
  return (
    <div className={`empty empty--${kind}`}>
      <div className="empty__icon" aria-hidden="true">
        {ICONS[kind]}
      </div>
      <div className="empty__title">{t(title)}</div>
      {description && <div className="empty__desc">{description}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
