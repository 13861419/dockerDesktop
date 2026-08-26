import { useCallback, useEffect, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input, TextArea, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put, del, postStream } from '../api/client';
import { isAdmin } from '../api/auth';
import type { AiSettings, AiCapability, AiProfile, AiPreset, ContainerListItem, AiUsageResponse, AiChatSessionLite, AiChatSession, AiPromptTemplate, AiAction, AiActionsResponse } from '../types';
import './aiAssistant.less';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

/** 千分位格式化 */
function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

/** 简单 Markdown 代码块渲染（避免引入重库） */
function renderMarkdown(text: string, showToast?: (msg: string, type?: any) => void): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/```(?:json|yaml|bash|shell|sh)?\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/\n$/, '');
      return (
        <pre className="ai-assistant__code" key={i}>
          <button
            className="ai-assistant__code-copy"
            title="复制代码"
            onClick={() => {
              navigator.clipboard.writeText(code);
              showToast?.('已复制', 'success');
            }}
          >
            复制
          </button>
          <code>{code}</code>
        </pre>
      );
    }
    if (!part) return null;
    return (
      <div key={i}>
        {part.split('\n').map((line, j) => (
          <p className="ai-assistant__p" key={j}>
            {line}
          </p>
        ))}
      </div>
    );
  });
}

const ACTION_LABELS: Record<string, string> = {
  restart_container: '重启容器',
  stop_container: '停止容器',
  start_container: '启动容器',
  remove_container: '删除容器',
  remove_image: '删除镜像',
  system_prune: '系统清理',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  executed: '已执行',
  failed: '执行失败',
};

/** Profile 表单初始值 */
const EMPTY_FORM = {
  name: '',
  kind: 'cloud' as 'local' | 'cloud',
  provider: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  systemPrompt: '',
  timeoutMs: 60,
};

export default function AiAssistantPage() {
  const { showToast } = useToast();
  const admin = isAdmin();

  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [currentModelId, setCurrentModelId] = useState<number | null>(null);

  const [showConfig, setShowConfig] = useState(false);
  const [activeTab, setActiveTab] = useState<'preset' | 'mine'>('preset');
  const [editing, setEditing] = useState<AiProfile | null>(null);
  const [configForm, setConfigForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [capabilities, setCapabilities] = useState<AiCapability[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const messagesRef = useRef<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [logsTarget, setLogsTarget] = useState('');
  const [containers, setContainers] = useState<ContainerListItem[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // 对话历史（会话持久化）
  const [sessions, setSessions] = useState<AiChatSessionLite[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const [showActions, setShowActions] = useState(false);
  const [pendingActions, setPendingActions] = useState<AiAction[]>([]);
  const [allActions, setAllActions] = useState<AiAction[]>([]);
  const [actionView, setActionView] = useState<'pending' | 'all'>('pending');
  const [loadingActions, setLoadingActions] = useState(false);

  const [templates, setTemplates] = useState<AiPromptTemplate[]>([]);
  const [templateCategories, setTemplateCategories] = useState<string[]>([]);
  const [templateCategory, setTemplateCategory] = useState('');

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      const u = await get<AiUsageResponse>('/api/ai/usage');
      setUsage(u);
    } catch (e: any) {
      showToast(e?.message || '加载用量统计失败', 'error');
    } finally {
      setLoadingUsage(false);
    }
  }, [showToast]);

  const openUsage = useCallback(() => {
    setShowUsage(true);
    loadUsage();
  }, [loadUsage]);

  const loadActions = useCallback(async (view: 'pending' | 'all' = actionView) => {
    setLoadingActions(true);
    try {
      const q = view === 'all' ? '?status=all' : '';
      const r = await get<AiActionsResponse>(`/api/ai/actions${q}`);
      setPendingActions(r.actions.filter((a) => a.status === 'pending'));
      setAllActions(r.actions);
    } catch (e: any) {
      showToast(e?.message || '加载操作列表失败', 'error');
    } finally {
      setLoadingActions(false);
    }
  }, [actionView, showToast]);

  const openActions = useCallback(() => {
    setShowActions(true);
    loadActions();
  }, [loadActions]);

  const handleApproveAction = useCallback(async (id: number) => {
    try {
      await post(`/api/ai/actions/${id}/approve`, {});
      showToast('已批准');
      await loadActions();
    } catch (e: any) {
      showToast(e?.message || '操作失败', 'error');
    }
  }, [loadActions, showToast]);

  const handleRejectAction = useCallback(async (id: number) => {
    try {
      await post(`/api/ai/actions/${id}/reject`, {});
      showToast('已拒绝');
      await loadActions();
    } catch (e: any) {
      showToast(e?.message || '操作失败', 'error');
    }
  }, [loadActions, showToast]);

  const handleClearUsage = useCallback(async () => {
    try {
      await del('/api/ai/usage');
      showToast('已清空用量统计');
      await loadUsage();
    } catch (e: any) {
      showToast(e?.message || '清空失败', 'error');
    }
  }, [loadUsage, showToast]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await get<{ sessions: AiChatSessionLite[] }>('/api/ai/sessions');
      setSessions(r.sessions || []);
    } catch {
      // 静默：历史加载失败不阻断页面
    } finally {
      setSessionsLoaded(true);
    }
  }, []);

  const switchToNewSession = useCallback(() => {
    setCurrentSessionId(null);
    setMessages([]);
    messagesRef.current = [];
  }, []);

  const openSession = useCallback(
    async (id: number) => {
      try {
        const s = await get<AiChatSession>(`/api/ai/sessions/${id}`);
        setCurrentSessionId(s.id);
        setMessages(s.messages || []);
        messagesRef.current = s.messages || [];
      } catch (e: any) {
        showToast(e?.message || '加载会话失败', 'error');
      }
    },
    [showToast],
  );

  const newSession = useCallback(async () => {
    try {
      const created = await post<AiChatSession>('/api/ai/sessions');
      setCurrentSessionId(created.id);
      setMessages([]);
      messagesRef.current = [];
      setSessions((list) => [
        { id: created.id, title: created.title, messageCount: 0, tool: created.tool, target: created.target, createdAt: created.createdAt, updatedAt: created.updatedAt },
        ...list,
      ]);
    } catch (e: any) {
      showToast(e?.message || '新建会话失败', 'error');
    }
  }, [showToast]);

  const saveSession = useCallback(
    async (id: number, msgs: ChatMsg[]) => {
      try {
        await put(`/api/ai/sessions/${id}`, { messages: msgs });
        setSessions((list) =>
          list.map((s) => (s.id === id ? { ...s, messageCount: msgs.length, updatedAt: Date.now() } : s)),
        );
      } catch {
        // 静默：保存失败不打扰用户
      }
    },
    [],
  );

  const deleteCurrentSession = useCallback(async () => {
    if (currentSessionId == null) {
      switchToNewSession();
      return;
    }
    try {
      await del(`/api/ai/sessions/${currentSessionId}`);
      setCurrentSessionId(null);
      setMessages([]);
      messagesRef.current = [];
      setSessions((list) => list.filter((s) => s.id !== currentSessionId));
      showToast('会话已删除');
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    }
  }, [currentSessionId, showToast, switchToNewSession]);

  const loadAll = useCallback(async () => {
    try {
      const [s, p, pr, c] = await Promise.all([
        get<AiSettings>('/api/ai/settings'),
        get<{ profiles: AiProfile[] }>('/api/ai/profiles'),
        get<{ presets: AiPreset[] }>('/api/ai/presets'),
        get<ContainerListItem[]>('/api/containers').catch(() => []),
      ]);
      setSettings(s);
      setProfiles(p.profiles || []);
      setPresets(pr.presets || []);
      setContainers(Array.isArray(c) ? c : []);
      setCurrentModelId(s.defaultProfile?.id ?? null);
      const caps = await get<{ available: boolean; capabilities: AiCapability[] }>('/api/ai/capabilities');
      setCapabilities(caps.capabilities || []);
      const [tplRes, catRes] = await Promise.all([
        get<{ templates: AiPromptTemplate[] }>('/api/ai/templates'),
        get<{ categories: string[] }>('/api/ai/templates/categories'),
      ]);
      setTemplates(tplRes.templates || []);
      setTemplateCategories(catRes.categories || []);
    } catch (e: any) {
      showToast(e?.message || '加载数据失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadAll();
    refreshSessions();
  }, [loadAll, refreshSessions]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  // 同步 ref，供 send 同步读取历史
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback(
    async (text: string, tool?: string, target?: string) => {
      if (!text.trim() || sending) return;
      // 同步构建历史（基于 ref，不等 setState）
      const prev = messagesRef.current;
      const history = [...prev, { role: 'user' as const, content: text }]
        .slice(-40)
        .map((m) => ({ role: m.role, content: m.error ? '(请求失败)' : m.content }));

      // 确保存在会话（首次发送时自动创建）
      let sessionId = currentSessionId;
      if (sessionId == null) {
        try {
          const created = await post<AiChatSession>('/api/ai/sessions');
          sessionId = created.id;
          setCurrentSessionId(created.id);
          setSessions((list) => [
            { id: created.id, title: created.title, messageCount: 0, tool: created.tool, target: created.target, createdAt: created.createdAt, updatedAt: created.updatedAt },
            ...list,
          ]);
        } catch {
          sessionId = null;
        }
      }

      setMessages((m) => [
        ...m,
        { role: 'user', content: text },
        { role: 'assistant', content: '' },
      ]);
      setInput('');
      setSending(true);
      const replaceLastAssistant = (content: string, error = false) => {
        setMessages((m) => {
          const copy = [...m];
          if (copy.length && copy[copy.length - 1].role === 'assistant') {
            copy[copy.length - 1] = { ...copy[copy.length - 1], content, error };
          }
          return copy;
        });
      };
      let fullText = '';
      let hadError = false;
      try {
        await postStream(
          '/api/ai/chat/stream',
          { messages: history, tool, target },
          {
            onData: (data) => {
              if (!data || typeof data !== 'object' || data.type !== 'chunk') return;
              if (typeof data.text === 'string') {
                fullText += data.text;
                replaceLastAssistant(fullText);
              }
            },
          },
        );
        if (!fullText) replaceLastAssistant('(空回复)');
      } catch (e: any) {
        hadError = true;
        showToast(e?.message || 'AI 请求失败', 'error');
        replaceLastAssistant(e?.message || '请求失败', true);
      } finally {
        setSending(false);
      }

      // 持久化到当前会话
      if (sessionId != null) {
        const finalMsgs: ChatMsg[] = [
          ...prev,
          { role: 'user', content: text },
          { role: 'assistant', content: fullText || '(空回复)', error: hadError || undefined },
        ];
        await saveSession(sessionId, finalMsgs);
        // 用首条用户消息自动生成标题
        if (prev.length === 0) {
          const title = text.slice(0, 30);
          try {
            await put(`/api/ai/sessions/${sessionId}`, { title });
            setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, title } : s)));
          } catch {
            // 忽略标题更新失败
          }
        }
      }
    },
    [sending, showToast, currentSessionId, saveSession],
  );

  const onCapability = useCallback(
    (cap: AiCapability) => {
      const extra = cap.tool === 'logs' ? logsTarget : '';
      send(cap.prompt + (extra ? `\n容器：${extra}` : ''), cap.tool, cap.tool === 'logs' ? extra : undefined);
    },
    [send, logsTarget],
  );

  const handleSwitchDefault = useCallback(
    async (id: number) => {
      try {
        const res = await put<AiProfile>(`/api/ai/profiles/${id}/default`);
        setCurrentModelId(res.id);
        setProfiles((list) => list.map((p) => ({ ...p, isDefault: p.id === id })));
        showToast('已切换默认模型');
      } catch (e: any) {
        showToast(e?.message || '切换失败', 'error');
      }
    },
    [showToast],
  );

  const onPresetClick = useCallback((preset: AiPreset) => {
    setEditing(null);
    setConfigForm({
      name: preset.name,
      kind: preset.kind,
      provider: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.models[0] || '',
      apiKey: '',
      systemPrompt: '',
      timeoutMs: 60,
    });
    setActiveTab('mine');
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (!configForm.name.trim() || !configForm.baseUrl.trim()) {
      showToast('名称和端点不能为空', 'error');
      return;
    }
    if (configForm.kind === 'cloud' && !configForm.apiKey.trim() && !editing?.hasKey) {
      showToast('云端模型需要填写 API Key', 'error');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, any> = {
        name: configForm.name.trim(),
        kind: configForm.kind,
        provider: configForm.provider.trim() || configForm.name.trim(),
        baseUrl: configForm.baseUrl.trim(),
        model: configForm.model.trim(),
        systemPrompt: configForm.systemPrompt,
        timeoutMs: configForm.timeoutMs * 1000,
      };
      if (configForm.apiKey.trim()) body.apiKey = configForm.apiKey.trim();
      if (editing) {
        await put(`/api/ai/profiles/${editing.id}`, body);
        showToast('配置已更新');
      } else {
        await post('/api/ai/profiles', body);
        showToast('配置已创建');
      }
      setConfigForm(EMPTY_FORM);
      setEditing(null);
      await loadAll();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [configForm, editing, showToast, loadAll]);

  const handleEdit = useCallback((p: AiProfile) => {
    setEditing(p);
    setConfigForm({
      name: p.name,
      kind: p.kind,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: '',
      systemPrompt: p.systemPrompt,
      timeoutMs: Math.round(p.timeoutMs / 1000),
    });
    setActiveTab('mine');
  }, []);

  const handleDelete = useCallback(
    async (p: AiProfile) => {
      if (profiles.length <= 1) {
        showToast('至少保留一条配置', 'error');
        return;
      }
      try {
        await del(`/api/ai/profiles/${p.id}`);
        showToast('已删除');
        await loadAll();
      } catch (e: any) {
        showToast(e?.message || '删除失败', 'error');
      }
    },
    [profiles.length, showToast, loadAll],
  );

  const handleSetDefault = useCallback(
    async (p: AiProfile) => {
      try {
        await put(`/api/ai/profiles/${p.id}/default`);
        setCurrentModelId(p.id);
        setProfiles((list) => list.map((item) => ({ ...item, isDefault: item.id === p.id })));
        showToast('已设为默认');
      } catch (e: any) {
        showToast(e?.message || '操作失败', 'error');
      }
    },
    [showToast],
  );

  const handleTestProfile = useCallback(
    async (p: AiProfile) => {
      setTesting(true);
      try {
        const res = await post<{ ok: boolean; message: string }>(`/api/ai/profiles/${p.id}/test`);
        showToast(res.message || (res.ok ? '连接成功' : '连接失败'), res.ok ? 'success' : 'error');
      } catch (e: any) {
        showToast(e?.message || '测试失败', 'error');
      } finally {
        setTesting(false);
      }
    },
    [showToast],
  );

  const openConfigNew = useCallback(() => {
    setEditing(null);
    setConfigForm(EMPTY_FORM);
    setActiveTab('preset');
    setShowConfig(true);
  }, []);

  if (loading) {
    return (
      <div className="ai-assistant">
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const available = !!settings?.available;

  const localPresets = presets.filter((p) => p.kind === 'local');
  const cloudPresets = presets.filter((p) => p.kind === 'cloud');

  return (
    <div className="ai-assistant">
      <Card
        title="AI 模型配置中心"
        extra={
          <div className="ai-assistant__toolbar">
            <span className={`ai-assistant__badge ${available ? 'is-on' : 'is-off'}`}>
              {available ? '已启用' : '未配置'}
            </span>
            <Button size="sm" variant="ghost" onClick={openUsage}>
              用量统计
            </Button>
            <Button size="sm" variant="ghost" onClick={openActions}>
              待审批
            </Button>
            {admin && (
              <Button size="sm" variant="primary" onClick={openConfigNew}>
                配置模型
              </Button>
            )}
          </div>
        }
      >
        <div className="ai-assistant__topbar">
          <Field label="当前模型">
            <Select
              value={currentModelId ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v) handleSwitchDefault(v);
              }}
            >
              <option value="" disabled>
                {profiles.length === 0 ? '无可用配置' : '请选择'}
              </option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.provider} / {p.model})
                </option>
              ))}
            </Select>
          </Field>
          {profiles.length === 0 && admin && (
            <Button size="sm" variant="primary" onClick={openConfigNew}>
              立即配置
            </Button>
          )}
        </div>

        {!available && profiles.length === 0 ? (
          <Empty
            title="AI 助手尚未配置"
            description="添加一个模型配置后即可使用 AI 助手。"
            action={
              admin ? (
                <Button variant="primary" onClick={openConfigNew}>
                  添加配置
                </Button>
              ) : (
                <></>
              )
            }
          />
        ) : (
          <div className="ai-assistant__body">
            <div className="ai-assistant__side">
              <div className="ai-assistant__side-title">快捷能力</div>
              {capabilities.map((cap) => (
                <div className="ai-assistant__cap" key={cap.id}>
                  <div className="ai-assistant__cap-label">
                    {cap.label}
                    {cap.tool === 'logs' && (
                      <Select
                        className="ai-assistant__cap-input"
                        value={logsTarget}
                        onChange={(e: any) => setLogsTarget(e.target.value)}
                      >
                        <option value="">选择容器…</option>
                        {containers
                          .filter((c) => c.State === 'running')
                          .map((c) => {
                            const name = (c.Names[0] || '').replace(/^\//, '');
                            const shortId = c.Id.slice(0, 12);
                            return (
                              <option key={c.Id} value={name || shortId}>
                                {name || shortId}
                              </option>
                            );
                          })}
                      </Select>
                    )}
                  </div>
                  <div className="ai-assistant__cap-desc">{cap.description}</div>
                  <Button size="sm" onClick={() => onCapability(cap)}>
                    使用
                  </Button>
                </div>
              ))}
            </div>

            <div className="ai-assistant__main">
              <div className="ai-assistant__list-header">
                <Select
                  className="ai-assistant__session-select"
                  value={currentSessionId ?? ''}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v) openSession(v);
                    else switchToNewSession();
                  }}
                >
                  <option value="" >
                    新建对话
                  </option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </Select>
                <div className="ai-assistant__list-header-actions">
                  <Button size="sm" onClick={newSession}>
                    新建
                  </Button>
                  <Button size="sm" variant="ghost" onClick={deleteCurrentSession}>
                    删除
                  </Button>
                </div>
              </div>
              <div className="ai-assistant__list" ref={listRef}>
                {messages.length === 0 ? (
                  <Empty title="开始对话" description="输入问题，或点击右侧快捷能力。" />
                ) : (
                  messages.map((m, i) => (
                    <div
                      key={i}
                      className={`ai-assistant__msg ${m.role === 'user' ? 'is-user' : 'is-assistant'} ${m.error ? 'is-error' : ''}`}
                    >
                      {m.role === 'assistant' ? (
                        <>
                          {renderMarkdown(m.content, showToast)}
                          <button
                            className="ai-assistant__copy"
                            title="复制"
                            onClick={() => {
                              navigator.clipboard.writeText(m.content);
                              showToast('已复制', 'success');
                            }}
                          >
                            复制
                          </button>
                        </>
                      ) : (
                        <div className="ai-assistant__text">{m.content}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="ai-assistant__composer">
                <TextArea
                  className="ai-assistant__input"
                  value={input}
                  placeholder="输入你的 Docker 运维问题…"
                  onChange={(e: any) => setInput(e.target.value)}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                />
                <Button variant="primary" loading={sending} disabled={!input.trim()} onClick={() => send(input)}>
                  发送
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {showConfig && admin && (
        <div className="ai-assistant__config-overlay" onClick={() => setShowConfig(false)}>
          <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          <Card
            className="ai-assistant__config"
            title="模型配置"
            extra={
              <Button size="sm" onClick={() => setShowConfig(false)}>
                关闭
              </Button>
            }
          >
            <div className="ai-assistant__tabs">
              <button
                type="button"
                className={`ai-assistant__tab ${activeTab === 'preset' ? 'is-active' : ''}`}
                onClick={() => { setActiveTab('preset'); setEditing(null); setConfigForm(EMPTY_FORM); }}
              >
                预设
              </button>
              <button
                type="button"
                className={`ai-assistant__tab ${activeTab === 'mine' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('mine')}
              >
                我的配置
              </button>
            </div>

            {activeTab === 'preset' && (
              <div className="ai-assistant__preset-panel">
                {localPresets.length > 0 && (
                  <div className="ai-assistant__preset-group">
                    <div className="ai-assistant__preset-group-title">本地</div>
                    <div className="ai-assistant__preset-grid">
                      {localPresets.map((p) => (
                        <div className="ai-assistant__preset-card" key={p.id} onClick={() => onPresetClick(p)}>
                          <div className="ai-assistant__preset-name">{p.name}</div>
                          <div className="ai-assistant__preset-meta">{p.baseUrl}</div>
                          <div className="ai-assistant__preset-models">
                            {p.models.slice(0, 3).join(', ')}
                            {p.models.length > 3 ? '…' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {cloudPresets.length > 0 && (
                  <div className="ai-assistant__preset-group">
                    <div className="ai-assistant__preset-group-title">云端</div>
                    <div className="ai-assistant__preset-grid">
                      {cloudPresets.map((p) => (
                        <div className="ai-assistant__preset-card" key={p.id} onClick={() => onPresetClick(p)}>
                          <div className="ai-assistant__preset-name">{p.name}</div>
                          <div className="ai-assistant__preset-meta">{p.baseUrl}</div>
                          <div className="ai-assistant__preset-models">
                            {p.models.slice(0, 3).join(', ')}
                            {p.models.length > 3 ? '…' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {presets.length === 0 && (
                  <Empty title="暂无预设" description="暂无可选的预设模型。" />
                )}
              </div>
            )}

            {activeTab === 'mine' && (
              <div className="ai-assistant__mine-panel">
                {editing ? (
                  <div className="ai-assistant__edit-form">
                    <div className="ai-assistant__edit-head">
                      <span className="ai-assistant__edit-title">{editing ? '编辑配置' : '新建配置'}</span>
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setConfigForm(EMPTY_FORM); }}>
                        返回列表
                      </Button>
                    </div>
                    <Field label="名称" required>
                      <Input
                        value={configForm.name}
                        placeholder="如：GPT-4o"
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    </Field>
                    <Field label="类型">
                      <Select
                        value={configForm.kind}
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, kind: e.target.value as 'local' | 'cloud' }))}
                      >
                        <option value="local">本地</option>
                        <option value="cloud">云端</option>
                      </Select>
                    </Field>
                    <Field label="Provider">
                      <Input
                        value={configForm.provider}
                        placeholder="如：openai / ollama"
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, provider: e.target.value }))}
                      />
                    </Field>
                    <Field label="Base URL" required hint="OpenAI 兼容端点，如 https://api.openai.com/v1">
                      <Input
                        value={configForm.baseUrl}
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, baseUrl: e.target.value }))}
                      />
                    </Field>
                    <Field label="模型" required>
                      <Input
                        value={configForm.model}
                        placeholder="如 gpt-4o-mini / deepseek-chat"
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, model: e.target.value }))}
                      />
                    </Field>
                    <Field
                      label="API Key"
                      hint={editing?.hasKey ? '已配置（留空表示不修改）' : configForm.kind === 'local' ? '本地模型可不填' : '必填'}
                    >
                      <Input
                        type="password"
                        placeholder={editing?.hasKey ? '••••••••（已配置）' : 'sk-...'}
                        value={configForm.apiKey}
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, apiKey: e.target.value }))}
                      />
                    </Field>
                    <Field label="超时（秒）">
                      <Input
                        type="number"
                        value={configForm.timeoutMs}
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, timeoutMs: Number(e.target.value) || 60 }))}
                      />
                    </Field>
                    <Field label="系统提示词" hint="可选，覆盖默认提示词">
                      <TextArea
                        value={configForm.systemPrompt}
                        onChange={(e: any) => setConfigForm((f) => ({ ...f, systemPrompt: e.target.value }))}
                      />
                    </Field>
                    <div className="ai-assistant__config-actions">
                      <Button variant="primary" loading={saving} onClick={handleSaveProfile}>
                        保存
                      </Button>
                    </div>
                  </div>
                ) : profiles.length === 0 ? (
                  <Empty
                    title="暂无配置"
                    description="从预设中选择一个模型快速添加，或手动新建。"
                    action={
                      <Button variant="primary" size="sm" onClick={() => setActiveTab('preset')}>
                        从预设添加
                      </Button>
                    }
                  />
                ) : (
                  <div className="ai-assistant__profiles-table-wrap">
                    <table className="ai-assistant__profiles-table">
                      <thead>
                        <tr>
                          <th>名称</th>
                          <th>类型</th>
                          <th>Provider</th>
                          <th>模型</th>
                          <th>默认</th>
                          <th>Key</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.map((p) => (
                          <tr key={p.id}>
                            <td className="ai-assistant__td-name">{p.name}</td>
                            <td>
                              <span className={`ai-assistant__kind-badge ai-assistant__kind-badge--${p.kind}`}>
                                {p.kind === 'local' ? '本地' : '云端'}
                              </span>
                            </td>
                            <td>{p.provider}</td>
                            <td>{p.model}</td>
                            <td>{p.isDefault ? '是' : '否'}</td>
                            <td>
                              <span className={`ai-assistant__key-badge ${p.hasKey ? 'is-on' : 'is-off'}`}>
                                {p.hasKey ? '已配置' : '无'}
                              </span>
                            </td>
                            <td>
                              <div className="ai-assistant__row-actions">
                                <Button size="sm" variant="ghost" onClick={() => handleEdit(p)}>
                                  编辑
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDelete(p)}
                                  disabled={profiles.length <= 1}
                                >
                                  删除
                                </Button>
                                {!p.isDefault && (
                                  <Button size="sm" variant="ghost" onClick={() => handleSetDefault(p)}>
                                    设默认
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={testing}
                                  onClick={() => handleTestProfile(p)}
                                >
                                  测试
                                </Button>
                              </div>
                            </td>
                          </tr>
              ))}
              <div className="ai-assistant__side-title" style={{ marginTop: 16 }}>Prompt 模板</div>
              {templateCategories.length > 0 && (
                <Select
                  className="ai-assistant__cap-input"
                  value={templateCategory}
                  onChange={(e: any) => setTemplateCategory(e.target.value)}
                >
                  <option value="">全部分类</option>
                  {templateCategories.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </Select>
              )}
              {templates
                .filter((t) => !templateCategory || t.category === templateCategory)
                .map((t) => (
                  <div className="ai-assistant__cap" key={t.id}>
                    <div className="ai-assistant__cap-label">
                      {t.name}
                      {t.isSystem && <span className="ai-assistant__cap-tag">预置</span>}
                    </div>
                    <div className="ai-assistant__cap-desc">{t.category} · {t.prompt.slice(0, 40)}…</div>
                    <Button size="sm" onClick={() => { setInput(t.prompt); }}>
                      使用
                    </Button>
                  </div>
                ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            </Card>
          </div>
        </div>
      )}

      {showUsage && (
        <div className="ai-assistant__config-overlay" onClick={() => setShowUsage(false)}>
          <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <Card
              className="ai-assistant__usage"
              title="AI 用量统计"
              extra={
                <div className="ai-assistant__usage-actions">
                  {admin && (
                    <Button size="sm" variant="ghost" onClick={handleClearUsage}>
                      清空统计
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setShowUsage(false)}>
                    关闭
                  </Button>
                </div>
              }
            >
              {loadingUsage && !usage ? (
                <SkeletonRows rows={4} />
              ) : (
                <>
                  {usage && usage.summary && (
                    <div className="ai-assistant__usage-cards">
                      <div className="ai-assistant__usage-card">
                        <div className="ai-assistant__usage-card-value">
                          {formatCount(usage.summary.total)}
                        </div>
                        <div className="ai-assistant__usage-card-label">总 Token 数</div>
                      </div>
                      <div className="ai-assistant__usage-card">
                        <div className="ai-assistant__usage-card-value">
                          {formatCount(usage.summary.totalPrompt)}
                        </div>
                        <div className="ai-assistant__usage-card-label">输入 Token</div>
                      </div>
                      <div className="ai-assistant__usage-card">
                        <div className="ai-assistant__usage-card-value">
                          {formatCount(usage.summary.totalCompletion)}
                        </div>
                        <div className="ai-assistant__usage-card-label">输出 Token</div>
                      </div>
                      <div className="ai-assistant__usage-card">
                        <div className="ai-assistant__usage-card-value">
                          {usage.summary.totalCalls}
                        </div>
                        <div className="ai-assistant__usage-card-label">
                          调用次数（成功 {usage.summary.successCalls} / 失败 {usage.summary.failedCalls}）
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="ai-assistant__usage-section-title">按模型分布</div>
                  {usage && usage.byModel && usage.byModel.length > 0 ? (
                    <div className="ai-assistant__usage-table-wrap">
                      <table className="ai-assistant__usage-table">
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>Provider</th>
                            <th>调用次数</th>
                            <th>输入 Token</th>
                            <th>输出 Token</th>
                            <th>总 Token</th>
                            <th>成功率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {usage.byModel.map((m) => {
                            const rate = m.calls > 0 ? Math.round((m.successCalls / m.calls) * 100) : 100;
                            return (
                              <tr key={m.model}>
                                <td>{m.model}</td>
                                <td>{m.provider || '-'}</td>
                                <td>{m.calls}</td>
                                <td>{formatCount(m.promptTokens)}</td>
                                <td>{formatCount(m.completionTokens)}</td>
                                <td>{formatCount(m.totalTokens)}</td>
                                <td>{rate}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty title="暂无用量数据" description="使用一次 AI 对话后，这里会展示统计。" />
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      )}

      {showActions && (
        <div className="ai-assistant__config-overlay" onClick={() => setShowActions(false)}>
          <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <Card
              className="ai-assistant__usage"
              title="AI 操作审批"
              extra={
                <div className="ai-assistant__usage-actions">
                  <span className="ai-assistant__cap-tag" style={{ cursor: 'pointer', color: actionView === 'pending' ? 'var(--color-primary)' : undefined }} onClick={() => { setActionView('pending'); loadActions('pending'); }}>待审批</span>
                  <span className="ai-assistant__cap-tag" style={{ cursor: 'pointer', color: actionView === 'all' ? 'var(--color-primary)' : undefined }} onClick={() => { setActionView('all'); loadActions('all'); }}>全部</span>
                  <Button size="sm" onClick={() => setShowActions(false)}>✕</Button>
                </div>
              }
            >
              {loadingActions ? (
                <div style={{ textAlign: 'center', padding: 16 }}><span style={{ opacity: 0.6 }}>加载中...</span></div>
              ) : (actionView === 'pending' ? pendingActions : allActions).length > 0 ? (
                <div className="ai-assistant__usage-body">
                  <table className="ai-assistant__usage-table">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>参数</th>
                        <th>状态</th>
                        <th>时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(actionView === 'pending' ? pendingActions : allActions).map((a) => (
                        <tr key={a.id}>
                          <td>{ACTION_LABELS[a.actionType] || a.actionType}</td>
                          <td style={{ fontSize: 12, opacity: 0.7, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(a.params)}</td>
                          <td>
                            <span className={`ai-assistant__cap-tag is-${a.status === 'pending' ? 'local' : a.status === 'approved' || a.status === 'executed' ? 'cloud' : 'off'}`}>
                              {STATUS_LABELS[a.status] || a.status}
                            </span>
                          </td>
                          <td style={{ fontSize: 12, opacity: 0.6 }}>{new Date(a.createdAt).toLocaleString('zh-CN')}</td>
                          <td>
                            {a.status === 'pending' && (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <Button size="sm" variant="primary" onClick={() => handleApproveAction(a.id)}>批准</Button>
                                <Button size="sm" variant="danger" onClick={() => handleRejectAction(a.id)}>拒绝</Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="暂无操作" description="AI 建议的运维操作会出现在这里。" />
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
