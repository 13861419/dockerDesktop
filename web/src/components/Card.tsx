/**
 * 通用卡片容器组件
 */
import React from 'react';
import './Card.less';

interface CardProps {
  title?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * 通用卡片容器
 * @param param0 卡片属性
 */
export default function Card({ title, extra, children, className }: CardProps) {
  return (
    <div className={`card ${className || ''}`}>
      {(title || extra) && (
        <div className="card__header">
          {title && <div className="card__title">{title}</div>}
          {extra && <div className="card__extra">{extra}</div>}
        </div>
      )}
      <div className="card__body">{children}</div>
    </div>
  );
}
