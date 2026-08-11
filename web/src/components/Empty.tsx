/**
 * 空状态组件
 */
import React from 'react';
import './Empty.less';

interface EmptyProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

/**
 * 空状态占位
 * @param param0 属性
 */
export default function Empty({ title = '暂无数据', description, action }: EmptyProps) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </div>
      <div className="empty__title">{title}</div>
      {description && <div className="empty__desc">{description}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
