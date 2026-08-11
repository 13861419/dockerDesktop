/**
 * 轻量折线图组件（SVG / 无第三方依赖）
 *
 * 用于首页监控曲线展示，支持平滑曲线、渐变面积、两种可选数据序列。
 * 风格：indigo 灵动渐变 + 清爽网格，贴合整体设计基调。
 */
import React, { useMemo } from 'react';
import './LineChart.less';

interface Series {
  name: string;
  color: string;
  data: number[];
}

interface LineChartProps {
  series: Series[];
  labels?: string[]; // 与数据点对应的标签（X 轴，可选）
  height?: number;
  unit?: string;
  max?: number; // 可选：Y 轴固定最大值（如百分比）
  locale?: string;
}

/** 双三次平滑插值：生成 SVG 路径 d */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/**
 * 折线图组件
 * @param param0 组件属性
 */
export default function LineChart({ series, labels, height = 180, unit = '%', max, locale = 'zh-CN' }: LineChartProps) {
  const W = 600;
  const H = height;
  const PAD = { top: 12, right: 12, bottom: 30, left: 34 };

  const { paths, chartW, chartH } = useMemo(() => {
    // 合并所有序列点数，取最大
    const maxLen = Math.max(...series.map((s) => s.data.length), 1);
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    // Y 轴范围
    let dataMax = max ?? 0;
    if (max == null) {
      for (const s of series) {
        for (const v of s.data) if (v > dataMax) dataMax = v;
      }
      // 给顶部留 10% 余量
      dataMax = dataMax * 1.1 || 1;
    }

    const toX = (i: number) => PAD.left + (maxLen === 1 ? chartW / 2 : (i / (maxLen - 1)) * chartW);
    const toY = (v: number) => PAD.top + chartH - (v / dataMax) * chartH;

    const out = series.map((s) => {
      const pts: Array<[number, number]> = s.data.map((v, i) => [toX(i), toY(Math.max(0, v))]);
      const line = smoothPath(pts);
      const area =
        pts.length > 1
          ? `${line} L ${pts[pts.length - 1][0].toFixed(2)} ${H - PAD.bottom} L ${pts[0][0].toFixed(2)} ${H - PAD.bottom} Z`
          : '';
      return { color: s.color, line, area, data: s.data };
    });

    return { paths: out, dataMax, chartW, chartH };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, max, height]);

  const maxVal = paths ? (max ?? 100) : 100;
  // 网格线（横向 4 条）
  const gridLines = [0, 1, 2, 3, 4].map((i) => {
    const y = PAD.top + chartH - (i / 4) * chartH;
    return { y, val: (i / 4) * maxVal };
  });

  // 计算 X 轴时间刻度：取首、1/4、中、3/4、尾几个标签，避免拥挤
  const xTicks = useMemo(() => {
    if (!labels || labels.length === 0) return [];
    const maxLen = Math.max(...series.map((s) => s.data.length), 1);
    const toX = (i: number) => PAD.left + (maxLen === 1 ? chartW / 2 : (i / (maxLen - 1)) * chartW);
    const pick = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round((labels.length - 1) * r));
    const seen = new Set<number>();
    return pick
      .filter((i) => !seen.has(i) && seen.add(i))
      .map((i) => ({ i, x: toX(i), label: labels[i] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, series]);

  return (
    <div className="linechart">
      <svg viewBox={`0 0 ${W} ${H}`} className="linechart__svg" role="img" aria-label="监控曲线">
        <defs>
          {series.map((s, idx) => (
            <linearGradient key={s.name} id={`grad-${idx}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>

        {/* 网格 */}
        {gridLines.map((g) => (
          <g key={g.y}>
            <line x1={PAD.left} y1={g.y} x2={W - PAD.right} y2={g.y} className="linechart__grid" />
            <text x={PAD.left - 6} y={g.y + 3} className="linechart__axis" textAnchor="end">
              {Math.round(g.val)}
            </text>
          </g>
        ))}

        {/* X 轴时间刻度 */}
        {xTicks.map((t) => (
          <text key={t.i} x={t.x} y={H - 8} className="linechart__axis" textAnchor="middle">
            {t.label}
          </text>
        ))}

        {/* 面积 + 折线 */}
        {paths && paths.length > 0
          ? paths.map((p, idx) => (
              <g key={idx}>
                {p.area && <path d={p.area} fill={`url(#grad-${idx})`} />}
                <path d={p.line} fill="none" stroke={p.color} strokeWidth="2" strokeLinecap="round" />
              </g>
            ))
          : null}
      </svg>

      {/* 图例 */}
      <div className="linechart__legend">
        {series.map((s) => (
          <span key={s.name} className="linechart__legend-item">
            <span className="linechart__legend-dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
