/**
 * Docker Compose 项目管理页
 *
 * 展示主机上的 Compose 项目列表，支持新建项目、启动 / 停止 / 重启服务、
 * 查看配置与删除项目等操作。
 */
import { useNavigate } from 'react-router-dom';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ComposeLogModal from '../components/ComposeLogModal';
import ComposeStructureModal from '../components/ComposeStructureModal';
import ComposeHistoryModal from '../components/ComposeHistoryModal';
import ComposeEnvModal from '../components/ComposeEnvModal';
import ComposeConfigModal from '../components/ComposeConfigModal';
import StopDownModal from '../components/StopDownModal';
import DeleteProjectModal from '../components/DeleteProjectModal';
import BatchDeleteModal from '../components/BatchDeleteModal';
import ComposeCreateModal from '../components/ComposeCreateModal';
import ComposeEditModal from '../components/ComposeEditModal';
import ComposeStatsModal from '../components/ComposeStatsModal';
import Empty from '../components/Empty';
import { Field, Input, Select } from '../components/Form';
import YamlEditor from '../components/YamlEditor';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import StateActions from '../components/StateActions';
import MoreMenu, { MoreMenuItem } from '../components/MoreMenu';
import LogViewer, { LOG_MAX_RENDER_LINES } from '../components/LogViewer';
import LogLevelFilter, { countLogLevels, filterLogContent, LogLevelFilterValue } from '../components/LogLevelFilter';
import { useLogStream } from '../hooks/useLogStream';
import { useCanManage } from '../hooks/useCanManage';
import { ComposeProject, ComposeService, ComposeTemplate, ComposeStructure } from '../types';
import { translateNow as t } from '../i18n';
import './compose.less';



/**
 * Compose 项目管理页组件
 */
export default function ComposePage() {
  const { showToast } = useToast();
  const { hasPerm } = useCanManage();
  const canManage = hasPerm('compose.write');
  const canDelete = hasPerm('compose.write');
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');

  // 各项目的服务运行状态（name → compose ps 结果）
  const [statusMap, setStatusMap] = useState<Record<string, ComposeService[]>>({});

  // 日志弹窗：仅持有目标项目/服务，快照拉取与 SSE 跟随流逻辑在 ComposeLogModal 内部（1.92.0 拆分）
  const [logTarget, setLogTarget] = useState<{ name: string; service: string } | null>(null);

  // 新建项目弹窗：模板/文件上传/YAML 校验/run 导入在 ComposeCreateModal 内部
  const [createOpen, setCreateOpen] = useState(false);

  // 编辑项目弹窗：目标项目，文件拉取/历史版本/保存模板在 ComposeEditModal 内部
  const [editTarget, setEditTarget] = useState<ComposeProject | null>(null);
  // 环境变量（.env）编辑（1.54.0）：目标项目名，读取与保存在 ComposeEnvModal 内部
  const [envTarget, setEnvTarget] = useState<string | null>(null);

  // 用户保存的 Compose 模板（来自 /api/compose-templates，用于"从模板新建"下拉）
  const [userTemplates, setUserTemplates] = useState<ComposeTemplate[]>([]);

// 项目资源看板：目标项目名，资源聚合/滚动更新/漂移检测/镜像分发在 ComposeStatsModal 内部
const [statsTarget, setStatsTarget] = useState<string | null>(null);

  // 停止（down）确认弹窗状态：仅记录目标项目，执行逻辑在 StopDownModal 内部
  const [stopTarget, setStopTarget] = useState<ComposeProject | null>(null);


  // 查看配置弹窗：目标项目名，配置拉取在 ComposeConfigModal 内部
  const [configTarget, setConfigTarget] = useState<string | null>(null);

  // 结构视图弹窗：仅持有目标项目，数据拉取与服务操作在 ComposeStructureModal 内部（1.92.0 拆分）
  const [structureTarget, setStructureTarget] = useState<string | null>(null);
  const [serviceOpKey, setServiceOpKey] = useState<string | null>(null);

  // 操作中的项目与删除确认状态（删除时额外记录是否删除数据卷）
  const [opName, setOpName] = useState<string | null>(null);
  const navigate = useNavigate();
  const [deleteTarget, setDeleteTarget] = useState<ComposeProject | null>(null);
  // 多选批量删除（1.89.0）
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const selectedExternal = projects.filter((p) => selectedNames.includes(p.name) && p.source === 'external');

  /**
   * 执行 Compose 操作（启动 / 停止 / 重启）
   * @param project 项目
   * @param action 动作标识
   * @param successMsg 成功提示
   * @param body 可选请求体
   */
  const runAction = useCallback(
    async (project: ComposeProject, action: string, successMsg: string, body?: object) => {
      if (!canManage) {
        showToast(t('仅管理员可操作 Compose 项目'), 'error');
        return;
      }
      const name = project.name;
      setOpName(name);
      try {
        await post(projectUrl(name) + '/' + action, body);
        showToast(successMsg);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || successMsg.replace(t('成功'), t('失败')), 'error');
      } finally {
        setOpName(null);
      }
    },
    [canManage, showToast]
  );

  /** 解析并设置项目操作中的名称（项目名可能含特殊字符，需编码） */
  const projectUrl = (name: string): string => '/api/compose/' + encodeURIComponent(name);

  /** 打开项目资源看板（1.34.0）：数据拉取与服务操作在 ComposeStatsModal 内部 */
  const openStats = (pname: string) => setStatsTarget(pname);








  /**
   * 批量拉取全部项目的服务运行状态（1.89.1）
   * 单次 /status 接口按容器标签聚合，替代逐项目 docker compose ps（每项目一次子进程）
   */
  const loadStatus = useCallback(async () => {
    try {
      const data = await get<Record<string, ComposeService[]>>('/api/compose/status');
      setStatusMap(data && typeof data === 'object' ? data : {});
    } catch {
      // 拉取失败时不显示具体状态
      setStatusMap({});
    }
  }, []);

  /**
   * 拉取 Compose 项目列表
   */
  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<ComposeProject[]>('/api/compose');
      setProjects(data || []);
      setLoadError('');
      // 批量拉取各项目的服务运行状态
      await loadStatus();
    } catch (e: any) {
      setLoadError(e?.message || t('拉取项目列表失败'));
      showToast(e?.message || t('拉取项目列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, loadStatus]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects, refreshKey]);



  /** 拉取用户保存的 Compose 模板列表，用于"从模板新建"下拉 */
  const fetchUserTemplates = useCallback(async () => {
    try {
      const data = await get<ComposeTemplate[]>('/api/compose-templates');
      setUserTemplates(data || []);
    } catch {
      // 拉取失败时保留空列表，不影响新建流程
      setUserTemplates([]);
    }
  }, []);







  /** 查看项目配置文件（配置拉取在 ComposeConfigModal 内部） */
  const handleViewConfig = (project: ComposeProject) => setConfigTarget(project.name);

  /** 打开结构视图弹窗（数据拉取与服务操作在 ComposeStructureModal 内部） */
  function openStructure(project: ComposeProject) {
    setStructureTarget(project.name);
  }

  /**
   * 对单个 compose 服务执行 start / stop / restart 操作
   * @param service 服务名
   * @param action 动作标识
    * @param successMsg 成功提示
    */

  /** 全选 / 单行选择（多选删除，选择集为当前过滤后的列表） */
  const allChecked = projects.length > 0 && projects.every((p) => selectedNames.includes(p.name));
  const toggleSelectAll = (checked: boolean) =>
    setSelectedNames(checked ? projects.map((p) => p.name) : []);
  const toggleSelect = (name: string) =>
    setSelectedNames((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));


  /** 打开编辑弹窗：文件拉取/历史版本/保存模板在 ComposeEditModal 内部 */
  const openEdit = (project: ComposeProject) => {
    if (!canManage) {
      showToast(t('仅管理员可编辑 Compose 项目'), 'error');
      return;
    }
    setEditTarget(project);
  };





  /** 打开环境变量（.env）编辑弹窗（1.54.0）：读取与保存在 ComposeEnvModal 内部 */
  const openEnv = (project: ComposeProject) => setEnvTarget(project.name);



  /** 打开日志弹窗（快照拉取与跟随流逻辑在 ComposeLogModal 内部） */
  function openLog(name: string, service?: string) {
    setLogTarget({ name, service: service || '' });
  }

  return (
    <div className="page">
      <Card
        title={t('Compose 项目')}
        extra={
          <div className="toolbar">
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
            <Button
              variant="primary"
              disabled={!canManage}
              onClick={() => {
                setCreateOpen(true);
                // 打开新建弹窗时拉取用户模板列表，供"从模板新建"下拉使用
                fetchUserTemplates();
              }}
            >
              {t('新建项目')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('拉取项目列表失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={fetchProjects}>
                {t('重试')}
              </Button>
            }
          />
        ) : projects.length === 0 ? (
          <Empty
            title={t('暂无 Compose 项目')}
            description={t('点击右上角「新建项目」创建')}
            action={
              <Button
                size="sm"
                variant="primary"
                disabled={!canManage}
                onClick={() => {
                  setCreateOpen(true);
                  fetchUserTemplates();
                }}
              >
                {t('新建编排')}
              </Button>
            }
          />
        ) : (
          <>
            {selectedNames.length > 0 && (
              <div className="compose__batch">
                <span className="compose__batch-count">{t('已选 {{n}} 项', { n: selectedNames.length })}</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!canDelete}
                  onClick={() => {
                    setBatchDeleteOpen(true);
                  }}
                >
                  {t('批量删除')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedNames([])}>
                  {t('清除选择')}
                </Button>
              </div>
            )}
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-select">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                      aria-label={t('全选')}
                    />
                  </th>
                  <th>{t('项目名')}</th>
                <th>{t('状态')}</th>
                <th>{t('Compose 文件')}</th>
                <th>{t('路径')}</th>
                <th className="col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((proj) => (
                <tr key={proj.name} className={selectedNames.includes(proj.name) ? 'row--selected' : ''}>
                  <td className="col-select">
                    <input
                      type="checkbox"
                      checked={selectedNames.includes(proj.name)}
                      onChange={() => toggleSelect(proj.name)}
                      aria-label={t('选择 {{name}}', { name: proj.name })}
                    />
                  </td>
                  <td className="col-name">
                    <div className="name-main" title={proj.source === 'external' ? proj.path : proj.name}>
                      {proj.name}
                    </div>
                    {proj.source === 'external' ? (
                      <div className="name-sub badge badge--muted" title={proj.path}>
                        {t('外部')}
                        {typeof proj.running === 'number' ? ` · ${proj.running}/${proj.total ?? '-'}` : ''}
                        {proj.fileAccessible === false ? ` · ${t('文件受限')}` : ''}
                      </div>
                    ) : proj.hasCompose ? (
                      <div className="name-sub badge badge--running">{t('已配置')}</div>
                    ) : (
                      <div className="name-sub badge badge--muted">{t('未配置')}</div>
                    )}
                  </td>
                  <td className="status-cell">
                        {statusMap[proj.name] && statusMap[proj.name].length > 0 ? (
                          <div className="status-list">
                            {statusMap[proj.name].map((svc) => (
                              <span
                                key={svc.ID || svc.Name || svc.Service}
                                className={`status-item badge ${
                                  /running|up/i.test(svc.State || '')
                                    ? 'badge--running'
                                    : 'badge--muted'
                                }`}
                                title={`${svc.Name || svc.Service || ''} - ${svc.State || svc.Status || ''}`}
                                style={svc.ID ? { cursor: 'pointer' } : undefined}
                                onClick={() => {
                                  if (svc.ID) navigate(`/containerDetail/${svc.ID}`);
                                }}
                              >
                                {svc.Name || svc.Service || '-'}
                              </span>
                            ))}
                          </div>
                        ) : (
                      <span className="badge badge--muted">-</span>
                    )}
                  </td>
                  <td className="col-mono" title={proj.composeFiles && proj.composeFiles.length > 1 ? proj.composeFiles.join('\n') : proj.composeFile || '-'}>
                    {proj.composeFile || '-'}
                    {proj.composeFiles && proj.composeFiles.length > 1 ? ` +${proj.composeFiles.length - 1}` : ''}
                  </td>
                  <td className="col-mono" title={proj.path}>
                    {proj.path}
                  </td>
                  <td className="col-actions">
                    <div className="row-actions">
                      {/* 生命周期操作：状态下拉（启动/停止/重启），与容器页一致（1.52.0） */}
                      <StateActions
                        state={
                          (Array.isArray(statusMap[proj.name]) &&
                            (statusMap[proj.name] as ComposeService[]).some((svc) => /running|up/i.test(svc.State || '')))
                            ? 'running'
                            : 'exited'
                        }
                        onAction={(action) => {
                          if (action === 'up') runAction(proj, 'up', t('项目启动成功'));
                          else if (action === 'down') {
                            setStopTarget(proj);
                          } else if (action === 'restart') runAction(proj, 'restart', t('项目重启成功'));
                        }}
                        customActions={[
                          { key: 'up', label: t('启动'), disabled: !canManage || opName === proj.name },
                          { key: 'down', label: t('停止') },
                          { key: 'restart', label: t('重启'), disabled: !canManage || opName === proj.name },
                        ]}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openLog(proj.name)}
                      >
                        {t('日志')}
                      </Button>
                      {/* 次要操作按语义分组收入"更多"菜单（1.67.0） */}
                      <MoreMenu
                        disabled={!canManage}
                        items={[
                          { label: t('查看'), group: true, onClick: () => {} },
                          { label: t('编辑'), onClick: () => openEdit(proj) },
                          { label: t('配置'), title: t('compose 规范化配置'), onClick: () => handleViewConfig(proj) },
                          { label: t('结构'), onClick: () => openStructure(proj) },
                          { label: t('看板'), onClick: () => void openStats(proj.name) },
                          { label: t('配置文件'), group: true, onClick: () => {} },
                          { label: t('环境变量'), onClick: () => openEnv(proj) },
                          { label: t('目录'), title: proj.path, onClick: () => navigate(`/files?path=${encodeURIComponent(proj.path)}`) },
                          { label: t('镜像操作'), group: true, onClick: () => {} },
                          {
                            label: t('拉取镜像'),
                            disabled: !canManage || opName === proj.name,
                            onClick: () => runAction(proj, 'pull', t('镜像拉取成功')),
                          },
                          {
                            label: t('构建镜像'),
                            disabled: !canManage,
                            onClick: () => runAction(proj, 'build', t('镜像构建成功')),
                          },
                          { label: t('删除'), danger: true, disabled: !canDelete, onClick: () => setDeleteTarget(proj) },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </Card>

      {/* 新建项目弹窗：模板/文件上传/YAML 校验/run 导入在 ComposeCreateModal 内部（1.92.0 拆分） */}
      {createOpen && (
        <ComposeCreateModal
          userTemplates={userTemplates}
          onClose={() => setCreateOpen(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}


      {/* 编辑项目弹窗：文件拉取/历史版本/保存模板在 ComposeEditModal 内部（1.92.0 拆分） */}
      {editTarget && (
        <ComposeEditModal
          name={editTarget.name}
          files={editTarget.composeFiles || []}
          onClose={() => setEditTarget(null)}
          onSaved={() => setRefreshKey((k) => k + 1)}
          onTemplatesChanged={() => void fetchUserTemplates()}
        />
      )}


      {/* 环境变量（.env）编辑弹窗（1.54.0）：读取与保存在 ComposeEnvModal 内部（1.92.0 拆分） */}
      {envTarget && <ComposeEnvModal name={envTarget} onClose={() => setEnvTarget(null)} />}


      {/* 查看配置弹窗：配置拉取在 ComposeConfigModal 内部（1.92.0 拆分） */}
      {configTarget && <ComposeConfigModal name={configTarget} onClose={() => setConfigTarget(null)} />}

      {/* 结构视图弹窗 */}
      {structureTarget && (
        <ComposeStructureModal
          name={structureTarget}
          onClose={() => setStructureTarget(null)}
          onViewLog={(n, svc) => setLogTarget({ name: n, service: svc })}
          onRefresh={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {logTarget && (
        <ComposeLogModal name={logTarget.name} service={logTarget.service} onClose={() => setLogTarget(null)} />
      )}




      {/* 停止（down）确认弹窗：停止执行在 StopDownModal 内部（1.92.0 拆分） */}
      {stopTarget && (
        <StopDownModal
          name={stopTarget.name}
          onClose={() => setStopTarget(null)}
          onDone={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {/* 删除项目确认框：删除执行在 DeleteProjectModal 内部（1.92.0 拆分） */}
      {deleteTarget && (
        <DeleteProjectModal
          name={deleteTarget.name}
          canDelete={canDelete}
          onClose={() => setDeleteTarget(null)}
          onDone={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {/* 批量删除确认框（1.89.0）：删除执行在 BatchDeleteModal 内部（1.92.0 拆分） */}
      {batchDeleteOpen && (
        <BatchDeleteModal
          names={selectedNames}
          externals={selectedExternal.map((p) => p.name)}
          canDelete={canDelete}
          onClose={() => setBatchDeleteOpen(false)}
          onDone={() => {
            setSelectedNames([]);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* 项目资源看板（1.34.0）：资源聚合/滚动更新/漂移检测/镜像分发在 ComposeStatsModal 内部（1.92.0 拆分） */}
      {statsTarget && <ComposeStatsModal name={statsTarget} onClose={() => setStatsTarget(null)} />}


    </div>
  );
}
