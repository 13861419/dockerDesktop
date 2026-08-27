/**
 * Dockerfile 镜像构建页面
 *
 * 提供从宿主机构建上下文目录构建镜像的表单与实时日志展示。
 * 调用后端 POST /api/build/image/stream（SSE），构建日志逐行实时推送。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, del, postStream } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { Field, Input } from '../components/Form';
import './build.less';

/** 构建参数行 */
interface BuildArg {
  key: string;
  value: string;
}

/** 构建历史记录项 */
interface BuildHistoryItem {
  id: number;
  name: string;
  context: string;
  dockerfile: string;
  success: number;
  log_preview: string;
  duration_ms: number;
  created_at: number;
}

/** 日志状态 */
type LogStatus = 'idle' | 'running' | 'success' | 'error';

/**
 * Dockerfile 镜像构建页面组件
 */
export default function BuildPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const canManage = isAdmin();

  // 镜像名称
  const [name, setName] = useState('');
  // 构建上下文目录
  const [context, setContext] = useState('');
  // Dockerfile 文件名
  const [dockerfile, setDockerfile] = useState('Dockerfile');
  // 是否忽略缓存
  const [noCache, setNoCache] = useState(false);
  // 构建参数
  const [args, setArgs] = useState<BuildArg[]>([]);
  // 构建日志
  const [logs, setLogs] = useState<string[]>([]);
  // 日志状态
  const [status, setStatus] = useState<LogStatus>('idle');
  // 构建历史列表
  const [history, setHistory] = useState<BuildHistoryItem[]>([]);
  // 是否正在加载历史
  const [historyLoading, setHistoryLoading] = useState(false);
  // 待清空历史的确认目标
  const [clearTarget, setClearTarget] = useState(false);
  // 日志区域引用（流式构建时自动滚动到底部）
  const logPreRef = useRef<HTMLPreElement>(null);

  // 构建进行中：日志追加时自动滚动到底部
  useEffect(() => {
    if (status === 'running' && logPreRef.current) {
      logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
    }
  }, [logs, status]);

  /**
   * 拉取构建历史列表（倒序）
   */
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const resp = await get<{ success: boolean; list: BuildHistoryItem[] }>('/api/build/history', { limit: 50 });
      setHistory(resp?.list || []);
    } catch {
      // 加载失败静默，避免干扰构建主流程
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /**
   * 页面挂载时加载历史
   */
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  /**
   * 从历史记录加载配置到表单
   * @param item 历史记录项
   */
  const loadConfigFromHistory = useCallback(
    (item: BuildHistoryItem) => {
      const ctx = item.context || '';
      setName(item.name || '');
      setContext(ctx);
      setDockerfile(item.dockerfile || 'Dockerfile');
      setNoCache(false);
      setArgs([]);
      setLogs([]);
      setStatus('idle');
      showToast(`已加载历史配置：${item.name}`);
    },
    [showToast],
  );

  /**
   * 查看历史记录的日志预览
   * @param item 历史记录项
   */
  const showHistoryLog = useCallback((item: BuildHistoryItem) => {
    const preview = item.log_preview || '（无日志预览）';
    setLogs(preview.split('\n'));
    setStatus(item.success === 1 ? 'success' : 'error');
    showToast(item.success === 1 ? '该次构建成功' : '该次构建失败', item.success === 1 ? undefined : 'error');
  }, [showToast]);

  /**
   * 清空全部构建历史
   */
  const confirmClearHistory = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可清空构建历史', 'error');
      return;
    }
    try {
      await del('/api/build/history');
      setHistory([]);
      setClearTarget(false);
      showToast('构建历史已清空');
    } catch (e: any) {
      showToast(e?.message || '清空失败', 'error');
    }
  }, [canManage, showToast]);

  /**
   * 格式化耗时
   * @param ms 毫秒
   */
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  };

  /**
   * 格式化时间
   * @param sec 秒级时间戳
   */
  const formatTime = (sec: number) => {
    if (!sec) return '-';
    const d = new Date(sec * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  /**
   * 添加一行空构建参数
   */
  const addArg = useCallback(() => {
    setArgs((prev) => [...prev, { key: '', value: '' }]);
  }, []);

  /**
   * 更新某一行构建参数
   * @param index 行号
   * @param field key / value
   * @param value 值
   */
  const updateArg = useCallback((index: number, field: 'key' | 'value', value: string) => {
    setArgs((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  }, []);

  /**
   * 删除某一行构建参数
   * @param index 行号
   */
  const removeArg = useCallback((index: number) => {
    setArgs((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * 开始构建（SSE 流式：日志逐行实时推送）
   */
  const handleBuild = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可构建镜像', 'error');
      return;
    }
    if (!name.trim()) {
      showToast('请填写镜像名称', 'error');
      return;
    }
    if (!context.trim()) {
      showToast('请填写构建上下文目录', 'error');
      return;
    }

    // 收集有效构建参数（跳过空 key）
    const validArgs: Record<string, string> = {};
    for (const a of args) {
      if (a.key.trim()) validArgs[a.key.trim()] = a.value;
    }

    setLogs([]);
    setStatus('running');
    try {
      await postStream(
        '/api/build/image/stream',
        {
          name: name.trim(),
          context: context.trim(),
          dockerfile: dockerfile.trim() || 'Dockerfile',
          noCache,
          args: validArgs,
        },
        {
          onData: (data: any) => {
            if (data?.type === 'log' && typeof data.text === 'string') {
              setLogs((prev) => [...prev.slice(-2000), data.text]);
            } else if (data?.type === 'done') {
              if (data.success) {
                setStatus('success');
                showToast(`镜像构建成功：${data.name}`);
              } else {
                setStatus('error');
                showToast(data.error || '镜像构建失败', 'error');
                if (data.error) {
                  setLogs((prev) => [...prev, `[错误] ${data.error}`]);
                }
              }
              loadHistory();
            }
          },
        },
      );
    } catch (e: any) {
      setStatus('error');
      setLogs((prev) => [...prev, `[错误] ${e?.message || '构建失败'}`]);
      showToast(e?.message || '构建请求失败', 'error');
      loadHistory();
    }
  }, [canManage, name, context, dockerfile, noCache, args, showToast, loadHistory]);

  /**
   * 重置表单
   */
  const handleReset = useCallback(() => {
    setLogs([]);
    setStatus('idle');
  }, []);

  const running = status === 'running';

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">构建镜像</h1>
        <p className="page__desc">通过宿主机的 Dockerfile 构建上下文目录创建镜像</p>
      </div>

      <Card>
        <div className="build-config">
          <Field label="镜像名称" required hint="例如：myapp:latest">
            <Input
              value={name}
              placeholder="myapp:latest"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field label="构建上下文目录" required hint="宿主机上包含 Dockerfile 的目录（绝对路径）">
            <Input
              value={context}
              placeholder="如 /home/user/myapp 或 D:\\docker\\myapp"
              onChange={(e) => setContext(e.target.value)}
            />
          </Field>

          <Field label="Dockerfile 文件名">
            <Input
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
            />
          </Field>

          <Field label="构建参数（Build Args）" hint="对应 Dockerfile 中的 ARG，可留空">
            <div className="build-config">
              {args.map((a, i) => (
                <div className="build-arg-row" key={i}>
                  <Input
                    className="build-arg-key"
                    placeholder="参数名，如 VERSION"
                    value={a.key}
                    onChange={(e) => updateArg(i, 'key', e.target.value)}
                  />
                  <Input
                    className="build-arg-value"
                    placeholder="值，如 1.0"
                    value={a.value}
                    onChange={(e) => updateArg(i, 'value', e.target.value)}
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeArg(i)}>删除</Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={addArg}>+ 添加参数</Button>
            </div>
          </Field>

          <label className="build-config__nocache" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={noCache}
              onChange={(e) => setNoCache(e.target.checked)}
            />
            <span>构建时忽略缓存（--no-cache）</span>
          </label>

          <div className="build-actions">
            <Button loading={running} disabled={running || !canManage} onClick={handleBuild}>
              {running ? '构建中...' : '开始构建'}
            </Button>
            <Button variant="ghost" onClick={handleReset} disabled={running}>清空日志</Button>
            {status === 'success' && (
              <Button variant="secondary" onClick={() => navigate('/images')}>前往镜像页</Button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div className="build-logs">
          <div className="build-logs__header">
            <span className="build-logs__title">构建日志</span>
            <span className={`build-logs__status ${running ? 'build-logs__status--running' : status === 'success' ? 'build-logs__status--success' : status === 'error' ? 'build-logs__status--error' : ''}`}>
              {status === 'running' ? '构建中...' : status === 'success' ? '构建成功' : status === 'error' ? '构建失败' : '等待构建'}
            </span>
          </div>
          <pre ref={logPreRef} className={`build-logs__pre ${logs.length === 0 ? 'build-logs__pre--empty' : ''}`}>
            {logs.length === 0 ? '暂无日志，点击「开始构建」以启动。' : logs.join('\n')}
          </pre>
        </div>
      </Card>

      <Card
        title="构建历史"
        extra={
          history.length > 0 && canManage ? (
            <Button variant="ghost" size="sm" onClick={() => setClearTarget(true)}>清空历史</Button>
          ) : undefined
        }
      >
        {historyLoading ? (
          <div className="build-history__empty">加载中...</div>
        ) : history.length === 0 ? (
          <div className="build-history__empty">暂无构建历史，完成一次镜像构建后将在此留档。</div>
        ) : (
          <table className="build-history__table">
            <thead>
              <tr>
                <th>时间</th>
                <th>镜像名称</th>
                <th>上下文目录</th>
                <th>结果</th>
                <th>耗时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatTime(h.created_at)}</td>
                  <td className="build-history__name">{h.name}</td>
                  <td className="build-history__ctx" title={h.context}>{h.context}</td>
                  <td>
                    <span className={h.success === 1 ? 'build-history__ok' : 'build-history__fail'}>
                      {h.success === 1 ? '成功' : '失败'}
                    </span>
                  </td>
                  <td>{formatDuration(h.duration_ms)}</td>
                  <td>
                    <div className="build-history__ops">
                      <Button variant="ghost" size="sm" onClick={() => loadConfigFromHistory(h)}>加载配置</Button>
                      <Button variant="ghost" size="sm" onClick={() => showHistoryLog(h)}>查看日志</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmDialog
        open={clearTarget}
        title="清空构建历史"
        message="确定清空全部镜像构建历史记录吗？此操作不可撤销。"
        confirmText="清空"
        danger
        onConfirm={confirmClearHistory}
        onCancel={() => setClearTarget(false)}
      />
    </div>
  );
}
