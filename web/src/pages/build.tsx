/**
 * Dockerfile 镜像构建页面
 *
 * 提供从宿主机构建上下文目录构建镜像的表单与实时日志展示。
 * 调用后端 POST /api/build/image，阻塞式返回完整构建日志。
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input } from '../components/Form';
import './build.less';

/** 构建参数行 */
interface BuildArg {
  key: string;
  value: string;
}

/** 构建接口响应 */
interface BuildResponse {
  success: boolean;
  name: string;
  logs: string[];
  error?: string;
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
   * 开始构建
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
      const resp = await post<BuildResponse>('/api/build/image', {
        name: name.trim(),
        context: context.trim(),
        dockerfile: dockerfile.trim() || 'Dockerfile',
        noCache,
        args: validArgs,
      });
      const list = resp?.logs || [];
      setLogs(list);
      if (resp?.success) {
        setStatus('success');
        showToast(`镜像构建成功：${resp.name}`);
      } else {
        setStatus('error');
        showToast(resp?.error || '镜像构建失败', 'error');
      }
    } catch (e: any) {
      setStatus('error');
      setLogs((prev) => [...prev, `[错误] ${e?.message || '构建失败'}`]);
      showToast(e?.message || '构建请求失败', 'error');
    }
  }, [canManage, name, context, dockerfile, noCache, args, showToast]);

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
              placeholder="如 D:\\docker\\myapp 或 C:\\work\\app"
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
          <pre className={`build-logs__pre ${logs.length === 0 ? 'build-logs__pre--empty' : ''}`}>
            {logs.length === 0 ? '暂无日志，点击「开始构建」以启动。' : logs.join('\n')}
          </pre>
        </div>
      </Card>
    </div>
  );
}
