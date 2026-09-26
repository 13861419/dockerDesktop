/**
 * 跨引擎迁移容器弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：选择目标引擎与迁移选项，调用 transfer 接口迁移容器，
 * 成功后在弹窗内展示迁移结果（目标容器 / 镜像传输 / 启动状态）。
 * 引擎候选列表由调用方传入（打开时会刷新），组件内部仅维护表单与提交逻辑。
 */
import { useEffect, useState } from 'react';
import { post } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Field, Input, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';
import type { ContainerTransferResult, EngineListItem } from '../types';

/** 迁移源容器信息（源容器 = 容器所在引擎） */
export interface MigrateTarget {
  id: string;
  name: string;
  image: string;
}

interface MigrateContainerModalProps {
  target: MigrateTarget | null;
  /** 引擎列表（含当前引擎与其它引擎），由调用方在打开时刷新 */
  engines: EngineListItem[];
  onClose: () => void;
  /** 迁移成功后通知调用方刷新容器列表 */
  onDone: () => void;
}

export default function MigrateContainerModal({ target, engines, onClose, onDone }: MigrateContainerModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  // 迁移弹窗中选中的目标引擎 id
  const [migrateTargetId, setMigrateTargetId] = useState('');
  // 目标容器名（留空自动沿用原名）
  const [migrateName, setMigrateName] = useState('');
  // 「迁移后启动」开关（默认开启）
  const [migrateStart, setMigrateStart] = useState(true);
  // 迁移提交是否进行中
  const [migrating, setMigrating] = useState(false);
  // 迁移完成后的结果展示（成功时包含 name / imageTransferred / note 等）
  const [migrateResult, setMigrateResult] = useState<ContainerTransferResult | null>(null);

  const currentEngine = engines.find((e) => e.isCurrent);
  /** 其它引擎（除当前引擎外的所有引擎，可作为迁移目标候选） */
  const otherEngines = engines.filter((e) => e.id !== currentEngine?.id);
  /** 是否存在至少一个可迁移的目标引擎 */
  const hasMigrateTarget = otherEngines.length >= 1;

  // 打开（或切换目标）时重置选项并默认选中第一个非当前引擎
  useEffect(() => {
    if (!target) return;
    setMigrateName('');
    setMigrateStart(true);
    setMigrateResult(null);
    setMigrating(false);
    setMigrateTargetId(otherEngines[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  /**
   * 提交跨引擎迁移请求（POST /api/transfer/container）。
   * 校验目标引擎合法后发起，成功展示结果并提示可到目标引擎查看，失败 toast 展示 error。
   */
  async function confirmMigrate() {
    if (!target) return;
    if (!canOperate()) {
      showToast(t('仅管理员或运维人员可迁移容器'), 'error');
      onClose();
      return;
    }
    if (!currentEngine?.id) {
      showToast(t('无法识别当前引擎'), 'error');
      return;
    }
    if (!migrateTargetId) {
      showToast(t('请选择目标引擎'), 'error');
      return;
    }
    if (migrateTargetId === currentEngine.id) {
      showToast(t('源引擎与目标引擎不能相同'), 'error');
      return;
    }
    setMigrating(true);
    try {
      const res = await post<ContainerTransferResult>('/api/transfer/container', {
        containerId: target.id,
        sourceEngineId: currentEngine.id,
        targetEngineId: migrateTargetId,
        newName: migrateName.trim() || undefined,
        start: migrateStart,
      });
      if (!res?.ok) {
        throw new Error(res?.error || t('容器迁移失败'));
      }
      // 成功：toast 提示并展示结果
      setMigrateResult(res);
      const startedText = res.started ? t('并已启动') : res.started === false ? t('（未启动）') : '';
      showToast(t('容器已迁移至目标引擎{{startedText}}', { startedText }));
      onDone();
    } catch (e: any) {
      showToast(e?.message || t('容器迁移失败'), 'error');
    } finally {
      setMigrating(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={t('跨引擎迁移容器')}
      onClose={() => !migrating && onClose()}
      width={520}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={migrating}>
            {t('关闭')}
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={migrating}
            onClick={confirmMigrate}
            disabled={!hasMigrateTarget}
          >
            {t('迁移')}
          </Button>
        </div>
      }
    >
      {target && (
        <>
          {/* 源信息（只读展示） */}
          <div className="migrate-modal__source">
            <div className="migrate-modal__source-row">
              <span className="migrate-modal__source-label">{t('容器名')}</span>
              <span className="migrate-modal__source-value" title={target.name}>
                {target.name}
              </span>
            </div>
            <div className="migrate-modal__source-row">
              <span className="migrate-modal__source-label">{t('镜像')}</span>
              <span className="migrate-modal__source-value" title={target.image}>
                {target.image || '-'}
              </span>
            </div>
            <div className="migrate-modal__source-row">
              <span className="migrate-modal__source-label">{t('源引擎')}</span>
              <span className="migrate-modal__source-value">
                {currentEngine?.name || t('（无法识别当前引擎）')}
              </span>
            </div>
          </div>

          <Field label={t('目标引擎')} required hint={t('将容器迁移到此引擎；需为当前引擎以外的其它引擎')}>
            <Select
              value={migrateTargetId}
              onChange={(e) => setMigrateTargetId(e.target.value)}
              disabled={migrating}
            >
              <option value="" disabled>
                {hasMigrateTarget ? t('请选择目标引擎') : t('无其它可用引擎')}
              </option>
              {otherEngines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('目标容器名')} hint={t('可选，留空时自动沿用原容器名')}>
            <Input
              placeholder={t('留空沿用原名')}
              value={migrateName}
              onChange={(e) => setMigrateName(e.target.value)}
              disabled={migrating}
            />
          </Field>

          <Field label={t('迁移后启动')}>
            <label className="create-modal__tty">
              <input
                type="checkbox"
                checked={migrateStart}
                onChange={(e) => setMigrateStart(e.target.checked)}
                disabled={migrating}
              />
              {t('迁移完成后自动启动目标容器')}
            </label>
          </Field>

          {/* 迁移结果展示 */}
          {migrateResult && (
            <div className="migrate-modal__result">
              <div className="migrate-modal__result-title">{t('迁移成功')}</div>
              <div className="migrate-modal__result-row">
                {t('目标容器：')}{migrateResult.name || target.name}
                {migrateResult.id ? `（${migrateResult.id.slice(0, 12)}）` : ''}
              </div>
              <div className="migrate-modal__result-row">
                {t('镜像是否已传输：')}
                {migrateResult.imageTransferred ? t('是') : t('否')}
              </div>
              {migrateResult.started === true && (
                <div className="migrate-modal__result-row">{t('启动状态：已启动')}</div>
              )}
              {migrateResult.started === false && (
                <div className="migrate-modal__result-row">{t('启动状态：未启动')}</div>
              )}
              {migrateResult.startError && (
                <div className="migrate-modal__result-note">{t('启动错误：{{msg}}', { msg: migrateResult.startError })}</div>
              )}
              {migrateResult.warning && (
                <div className="migrate-modal__result-note">{t('警告：{{msg}}', { msg: migrateResult.warning })}</div>
              )}
              {migrateResult.note && (
                <div className="migrate-modal__result-note">{t('备注：{{msg}}', { msg: migrateResult.note })}</div>
              )}
              <div className="migrate-modal__result-tip">
                {t('可在目标引擎的容器列表中查看该容器。')}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
