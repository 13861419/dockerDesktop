/**
 * Compose 新建项目弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：内含模板下拉、文件上传、
 * YAML 校验回显与"从 docker run 导入"子弹窗。条件渲染。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input, Select } from './Form';
import YamlEditor from './YamlEditor';
import { useToast } from './Toast';
import { useCanManage } from '../hooks/useCanManage';
import { translateNow as t } from '../i18n';
import type { ComposeTemplate } from '../types';
import { COMPOSE_TEMPLATES, findTemplateByValue } from './composeTemplates';

interface ComposeCreateModalProps {
  /** 用户保存的模板列表（来自页面级缓存，供"从模板新建"下拉） */
  userTemplates: ComposeTemplate[];
  onClose: () => void;
  /** 创建成功后通知调用方刷新列表 */
  onCreated: () => void;
}

/** 从后端校验错误信息中解析出错行号（返回 null 表示无法定位） */
function parseYamlLine(msg: string): number | null {
  const m = msg.match(/(?:line|第)\s*(\d+)/i) || msg.match(/:\s*(\d+)\n?/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export default function ComposeCreateModal({
  userTemplates,
  onClose,
  onCreated,
}: ComposeCreateModalProps) {
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [createName, setCreateName] = useState('');
  const [createContent, setCreateContent] = useState('');
  // YAML 校验错误（保存被拒绝时回显到编辑器）
  const [createYamlErr, setCreateYamlErr] = useState<{ message: string; line: number | null }>({ message: '', line: null });
  // 上传的 compose 文件名（用于界面展示）
  const [createFileName, setCreateFileName] = useState('');
  // 新建弹窗当前选择的模板 id（'' 表示空白）
  const [createTemplate, setCreateTemplate] = useState('');
  const [creating, setCreating] = useState(false);

  // docker run 导入子弹窗状态
  const [runImportOpen, setRunImportOpen] = useState(false);
  const [runImportCmd, setRunImportCmd] = useState('');
  const [runImportYaml, setRunImportYaml] = useState('');
  const [runImportWarnings, setRunImportWarnings] = useState<string[]>([]);
  const [runImportErr, setRunImportErr] = useState('');
  const [runImportLoading, setRunImportLoading] = useState(false);

  /** 新建 Compose 项目 */
  async function handleCreate() {
    if (!canManage) {
      showToast(t('仅管理员可新建 Compose 项目'), 'error');
      onClose();
      return;
    }
    const name = createName.trim();
    if (!name) {
      showToast(t('请输入项目名称'), 'error');
      return;
    }
    if (!createContent.trim()) {
      showToast(t('请输入 docker-compose.yml 内容'), 'error');
      return;
    }
    setCreating(true);
    try {
      await post('/api/compose', { name, content: createContent });
      showToast(t('项目创建成功'));
      onClose();
      onCreated();
    } catch (e: any) {
      const msg = e?.message || t('项目创建失败');
      const line = parseYamlLine(msg);
      setCreateYamlErr({ message: msg, line });
      showToast(line !== null ? t('Compose YAML 语法有误，请修正后保存') : msg, 'error');
    } finally {
      setCreating(false);
    }
  }

  /**
   * 读取用户选择的 compose 文件，将内容填入新建弹窗的文本框，并记录文件名
   * @param file 选择的文件
   */
  function handleUploadFile(file: File | undefined | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setCreateContent(text);
      setCreateFileName(file.name);
    };
    reader.onerror = () => {
      showToast(t('读取文件失败'), 'error');
    };
    reader.readAsText(file);
  }

  /**
   * 选择内置或用户模板：将所选模板的 content 填充到新建弹窗的文本框，并记录模板 value
   * 用户模板 value 以 'tpl:' 前缀标识（见 findTemplateByValue）
   * @param value 模板 value（'' 表示空白，不改变内容）
   */
  function handleTemplateChange(value: string) {
    setCreateTemplate(value);
    if (!value) return;
    const tpl = findTemplateByValue(value, userTemplates);
    if (tpl) {
      // 选择模板后清除当前内容并填入模板内容
      setCreateContent(tpl.content);
      setCreateFileName('');
    }
  }

  /** docker run 命令转换为 Compose（调后端解析，不落盘） */
  async function handleRunConvert() {
    setRunImportLoading(true);
    setRunImportErr('');
    setRunImportYaml('');
    setRunImportWarnings([]);
    try {
      const res = await post<{ yaml: string; warnings: string[] }>('/api/compose/run2compose', { command: runImportCmd });
      setRunImportYaml(res.yaml);
      setRunImportWarnings(res.warnings || []);
    } catch (e: any) {
      setRunImportErr(e?.message || t('转换失败'));
    } finally {
      setRunImportLoading(false);
    }
  }

  /** 将转换结果填入新建弹窗的编辑器 */
  function handleRunInsert() {
    setCreateContent(runImportYaml);
    setRunImportOpen(false);
    setRunImportCmd('');
    setRunImportYaml('');
    setRunImportWarnings([]);
    setRunImportErr('');
  }

  return (
    <>
      <Modal
        open
        title={t('新建 Compose 项目')}
        onClose={onClose}
        width={640}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                setCreateFileName('');
              }}
              disabled={creating}
            >
              {t('取消')}
            </Button>
            <Button onClick={handleCreate} loading={creating} disabled={!canManage}>
              {t('创建')}
            </Button>
          </>
        }
      >
        <Field label={t('项目名称')} required>
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={t('例如：myapp')}
            autoFocus
          />
        </Field>
        <Field label="docker-compose.yml" required hint={t('可选内置模板，或选择文件上传、直接粘贴完整内容')}>
          <div className="compose-tpl">
            <Select
              value={createTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="compose-tpl__select"
            >
              <option value="">{t('空白')}</option>
              {COMPOSE_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
              {userTemplates.length > 0 && (
                <optgroup label={t('我的模板')}>
                  {userTemplates.map((tpl) => (
                    <option key={tpl.id} value={'tpl:' + tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            {createTemplate && (
              <div className="compose-tpl__preview">
                {findTemplateByValue(createTemplate, userTemplates)?.description}
              </div>
            )}
          </div>
          <input
            type="file"
            accept=".yml,.yaml"
            onChange={(e) => handleUploadFile(e.target.files?.[0])}
            className="compose-upload"
          />
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setRunImportOpen(true)}>
              {t('从 docker run 导入')}
            </Button>
          </div>
          {createFileName && (
            <div className="compose-upload__name" title={createFileName}>
              {t('已选择文件：')}{createFileName}
            </div>
          )}
          <YamlEditor
            value={createContent}
            onChange={(v) => {
              setCreateContent(v);
              if (createYamlErr.message) setCreateYamlErr({ message: '', line: null });
            }}
            placeholder={'version: "3"\nservices:\n  web:\n    image: nginx:latest'}
            rows={10}
            errorLine={createYamlErr.line}
            errorMessage={createYamlErr.message || undefined}
          />
        </Field>
      </Modal>

      {/* docker run → Compose 导入弹窗 */}
      <Modal
        open={runImportOpen}
        title={t('从 docker run 导入')}
        onClose={() => setRunImportOpen(false)}
        width={640}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunImportOpen(false)}>
              {t('取消')}
            </Button>
            <Button onClick={handleRunConvert} loading={runImportLoading} disabled={!runImportCmd.trim()}>
              {t('转换为 Compose')}
            </Button>
            {runImportYaml && (
              <Button variant="primary" onClick={handleRunInsert}>
                {t('填入编辑器')}
              </Button>
            )}
          </>
        }
      >
        <Field label="docker run 命令" required hint={t('粘贴完整的 docker run 命令，自动映射端口 / 卷 / 环境变量 / 重启策略等常用选项')}>
          <textarea
            className="input"
            style={{ minHeight: 88, fontFamily: 'monospace' }}
            value={runImportCmd}
            onChange={(e) => setRunImportCmd(e.target.value)}
            placeholder={'docker run -d --name web -p 8080:80 -v /data:/data -e FOO=bar --restart always nginx:latest'}
          />
        </Field>
        {runImportErr && <div style={{ color: 'var(--danger, #e5484d)', marginTop: 8 }}>{runImportErr}</div>}
        {runImportWarnings.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {runImportWarnings.map((w, i) => (
              <div key={i} style={{ color: 'var(--warning, #f5a623)', fontSize: 12 }}>
                {t('提示：')}{w}
              </div>
            ))}
          </div>
        )}
        {runImportYaml && (
          <Field label="Compose 预览">
            <YamlEditor value={runImportYaml} onChange={() => {}} readOnly rows={10} />
          </Field>
        )}
      </Modal>
    </>
  );
}
