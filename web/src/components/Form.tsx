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
  /** 校验错误信息：展示为红色提示并标记输入为无效 */
  error?: string;
  /** 可选：部分场景仅作为展示标签（如展示原值），可不传子元素 */
  children?: React.ReactNode;
  className?: string;
}

interface InputLikeProps {
  /** 错误态：加红色边框并标记 aria-invalid */
  error?: boolean;
}

/**
 * 表单字段容器（含标签、错误与提示）
 * @param param0 属性
 */
export function Field({ label, required, hint, error, children, className }: FieldProps) {
  return (
    <div className={`field ${className || ''}`}>
      <label className={`field__label ${error ? 'field__label--error' : ''}`}>
        {label}
        {required && <span className="field__required">*</span>}
      </label>
      {children}
      {error ? (
        <div className="field__error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div className="field__hint">{hint}</div>
      )}
    </div>
  );
}

/** 文本输入框 */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & InputLikeProps) {
  const { error, ...rest } = props;
  return (
    <input
      className={`input ${error ? 'input--error' : ''}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
}

/** 文本域 */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & InputLikeProps) {
  const { error, ...rest } = props;
  return (
    <textarea
      className={`input input--area ${error ? 'input--error' : ''}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
}

/** 下拉选择 */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & InputLikeProps) {
  const { error, ...rest } = props;
  return (
    <select
      className={`input ${error ? 'input--error' : ''}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  );
}

