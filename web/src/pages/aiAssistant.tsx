import { useCallback, useEffect, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input, TextArea } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put } from '../api/client';
import { isAdmin } from '../api/auth';
import type { AiSettings, AiCapability, AiChatResponse, AiTestResponse } from '../types';
import './aiAssistant.less';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

/** 简单 Markdown 代码块渲染（避免引入重库） */
function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/```(?:json|yaml|bash|shell|sh)?\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // 代码块片段
      return (
        <pre className="ai-assistant__code" key={i}>
          <code>{part.replace(/\n$/, '')}</code>
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

export default function AiAssistantPage() {
  const { showToast } = useToast();
  const admin = isAdmin();

  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [configForm, setConfigForm] = useState({ baseUrl: '', model: '', apiKey: '', systemPrompt: '', timeoutMs: 60 });
  const [testing, setTesting] = useState(false);

  const [capabilities, setCapabilities] = useState<AiCapability[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [logsTarget, setLogsTarget] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const fetchSettings = useCallback(async () => {
    const data = await get<AiSettings>('/api/ai/settings');
    setSettings(data);
    setConfigForm((f) => ({
      ...f,
      baseUrl: data.baseUrl,
      model: data.model,
      systemPrompt: data.systemPrompt,
      timeoutMs: data.timeoutMs ? Math.round(data.timeoutMs / 1000) : 60,
    }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await fetchSettings();
        const caps = await get<{ available: boolean; capabilities: AiCapability[] }>('/api/ai/capabilities');
        setCapabilities(caps.capabilities || []);
      } catch (e: any) {
        showToast(e?.message || '加载 AI 设置失败', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchSettings, showToast]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (text: string, tool?: string, target?: string) => {
      if (!text.trim() || sending) return;
      setMessages((m) => [...m, { role: 'user', content: text }]);
      setInput('');
      setSending(true);
      try {
        const res = await post<AiChatResponse>('/api/ai/chat', {
          messages: [{ role: 'user', content: text }],
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

  const saveConfig = useCallback(async () => {
    try {
      await put('/api/ai/settings', {
        enabled: settings?.enabled,
        baseUrl: configForm.baseUrl,
        model: configForm.model,
        apiKey: configForm.apiKey,
        systemPrompt: configForm.systemPrompt,
        timeoutMs: configForm.timeoutMs * 1000,
      });
      showToast('配置已保存', 'success');
      setConfigForm((f) => ({ ...f, apiKey: '' }));
      await fetchSettings();
      setShowConfig(false);
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    }
  }, [configForm, fetchSettings, showToast]);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      const res = await post<AiTestResponse>('/api/ai/test', {
        baseUrl: configForm.baseUrl || settings?.baseUrl,
        model: configForm.model || settings?.model,
        apiKey: configForm.apiKey || undefined,
      });
      showToast(res.message || (res.ok ? '连接成功' : '连接失败'), res.ok ? 'success' : 'error');
    } catch (e: any) {
      showToast(e?.message || '测试失败', 'error');
    } finally {
      setTesting(false);
    }
  }, [configForm, settings, showToast]);

  if (loading) {
    return (
      <div className="ai-assistant">
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const available = !!settings?.available;

  return (
    <div className="ai-assistant">
      <Card
        title="AI 助手"
        extra={
          <div className="ai-assistant__toolbar">
            <span className={`ai-assistant__badge ${available ? 'is-on' : 'is-off'}`}>
              {available ? '已启用' : '未配置'}
            </span>
            {!available && admin && (
              <Button size="sm" variant="primary" onClick={() => setShowConfig(true)}>
                配置
              </Button>
            )}
          </div>
        }
      >
        {!available ? (
          <Empty
            title="AI 助手尚未配置"
            description="在设置中填入 OpenAI 兼容端点（baseUrl / 模型 / API Key）后即可使用。"
            action={
              admin ? (
                <Button variant="primary" onClick={() => setShowConfig(true)}>
                  立即配置
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
                      <Input
                        className="ai-assistant__cap-input"
                        placeholder="容器名/ID"
                        value={logsTarget}
                        onChange={(e: any) => setLogsTarget(e.target.value)}
                      />
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
              <div className="ai-assistant__list" ref={listRef}>
                {messages.length === 0 ? (
                  <Empty title="开始对话" description="输入问题，或点击右侧快捷能力。" />
                ) : (
                  messages.map((m, i) => (
                    <div
                      key={i}
                      className={`ai-assistant__msg ${m.role === 'user' ? 'is-user' : 'is-assistant'} ${m.error ? 'is-error' : ''}`}
                    >
                      {m.role === 'assistant' ? renderMarkdown(m.content) : <div className="ai-assistant__text">{m.content}</div>}
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
          <Card
            className="ai-assistant__config"
            title="AI 助手配置"
            extra={<Button size="sm" onClick={() => setShowConfig(false)}>关闭</Button>}
          >
            <Field label="启用" hint="关闭后不发起任何 AI 请求">
              <input
                type="checkbox"
                checked={!!settings?.enabled}
                onChange={(e: any) => setSettings((s) => (s ? { ...s, enabled: e.target.checked } : s))}
              />
            </Field>
            <Field label="Base URL" hint="OpenAI 兼容端点，如 https://api.openai.com/v1">
              <Input
                value={configForm.baseUrl}
                onChange={(e: any) => setConfigForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </Field>
            <Field label="模型" hint="如 gpt-4o-mini / deepseek-chat">
              <Input value={configForm.model} onChange={(e: any) => setConfigForm((f) => ({ ...f, model: e.target.value }))} />
            </Field>
            <Field label="API Key" hint={settings?.hasApiKey ? '已配置（留空表示不修改）' : '必填'}>
              <Input
                type="password"
                placeholder={settings?.hasApiKey ? '••••••••（已配置）' : 'sk-...'}
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
              <Button variant="primary" onClick={saveConfig}>
                保存
              </Button>
              <Button variant="secondary" loading={testing} onClick={runTest}>
                测试连接
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
