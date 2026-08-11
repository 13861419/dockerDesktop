/**
 * 骨架屏 / 加载状态组件
 */
import './Loading.less';

/**
 * 页面级加载态
 */
export function PageLoading() {
  return (
    <div className="loading-page">
      <div className="loading-spinner" />
      <span>加载中...</span>
    </div>
  );
}

/**
 * 列表骨架屏
 * @param param0 rows 骨架行数
 */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton__row">
          <div className="skeleton__block" style={{ width: `${30 + (i % 4) * 12}%` }} />
          <div className="skeleton__block" style={{ width: '15%' }} />
          <div className="skeleton__block" style={{ width: '20%' }} />
        </div>
      ))}
    </div>
  );
}
