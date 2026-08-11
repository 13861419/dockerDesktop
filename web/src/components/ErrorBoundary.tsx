/**
 * 全局错误边界
 *
 * 捕获子树渲染期间的异常，展示友好兜底页而非白屏，
 * 并提供「重新加载」「返回首页」的操作，避免崩溃后无法恢复。
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : '未知渲染错误' };
  }

  componentDidCatch(error: unknown) {
    // 可在此上报错误，当前仅打印便于排查
    console.error('[ErrorBoundary]', error);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="error-boundary">
        <div className="error-boundary__card">
          <div className="error-boundary__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </div>
          <h2 className="error-boundary__title">页面出现异常</h2>
          <p className="error-boundary__desc">界面渲染时发生了错误，你可以重新加载页面或返回总览。</p>
          <p className="error-boundary__msg">{this.state.message}</p>
          <div className="error-boundary__actions">
            <button className="error-boundary__btn" onClick={this.handleReload}>
              刷新页面
            </button>
            <button className="error-boundary__btn error-boundary__btn--ghost" onClick={this.handleHome}>
              返回总览
            </button>
          </div>
        </div>
      </div>
    );
  }
}
