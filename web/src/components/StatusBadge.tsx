/**
 * 容器/通用运行状态标签组件
 *
 * 采用透明背景 + 文字颜色区分状态，贴合整体清爽风格。
 */
interface StatusBadgeProps {
  status: string;
}

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  running: { label: '运行中', className: 'status--running' },
  exited: { label: '已停止', className: 'status--stopped' },
  created: { label: '已创建', className: 'status--created' },
  paused: { label: '已暂停', className: 'status--paused' },
  restarting: { label: '重启中', className: 'status--restarting' },
  dead: { label: '已失效', className: 'status--dead' },
  removing: { label: '删除中', className: 'status--removing' },
};

/**
 * 状态标签
 * @param param0 属性
 */
export default function StatusBadge({ status }: StatusBadgeProps) {
  const s = STATUS_MAP[status] || { label: status || '未知', className: 'status--unknown' };
  return (
    <span className={`status-badge ${s.className}`}>
      <span className="status-badge__dot" />
      {s.label}
    </span>
  );
}
