/**
 * 表单字段组件
 *
 * 统一 Input / TextArea / Select 的表单样式与标签。
 */
import React from 'react';
import './Form.less';

interface FieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  /** 可选：部分场景仅作为展示标签（如展示原值），可不传子元素 */
  children?: React.ReactNode;
  className?: string;
}

/**
 * 表单字段容器（含标签与提示）
 * @param param0 属性
 */
export function Field({ label, required, hint, children, className }: FieldProps) {
  return (
    <div className={`field ${className || ''}`}>
      <label className="field__label">
        {label}
        {required && <span className="field__required">*</span>}
      </label>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

/** 文本输入框 */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

/** 文本域 */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input input--area" {...props} />;
}

/** 下拉选择 */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input" {...props} />;
}
