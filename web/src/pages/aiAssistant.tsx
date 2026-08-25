import { useCallback, useEffect, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input, TextArea, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import type { AiSettings, AiCapability, AiChatResponse, AiProfile, AiPreset, ContainerListItem } from '../types';
import './aiAssistant.less';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
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
    } catch (e: any) {
      showToast(e?.message || '加载数据失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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
      setMessages((m) => [...m, { role: 'user', content: text }]);
      setInput('');
      setSending(true);
      try {
        const res = await post<AiChatResponse>('/api/ai/chat', {
          messages: history,
          tool,
          target,
        });
        setMessages((m) => [...m, { role: 'assistant', content: res.reply || '(空回复)' }]);
      } catch (e: any) {
        showToast(e?.message || 'AI 请求失败', 'error');
        setMessages((m) => [...m, { role: 'assistant', content: e?.message || '请求失败', error: true }]);
      } finally {
        setSending(false);
      }
    },
    [sending, showToast],
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
                <span className="ai-assistant__list-title">对话</span>
                {messages.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => { setMessages([]); messagesRef.current = []; }}>
                    清除历史
                  </Button>
                )}
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
    </div>
  );
}
