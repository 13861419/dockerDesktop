/**
 * 单个镜像详情页
 *
 * 通过路由参数 name 获取指定镜像的详细信息（dockerode inspect 结构），
 * 以 Card + 键值网格形式展示镜像的元数据。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Card from '../components/Card';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { PageLoading } from '../components/Loading';
import Empty from '../components/Empty';
import { useToast } from '../components/Toast';
import { get, del, post } from '../api/client';
import { getToken, isAdmin, canOperate } from '../api/auth';
import './imageDetail.less';

/** Docker 镜像 inspect 结果的结构 */
interface ImageInspect {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Labels: Record<string, string> | null;
  Size: number;
  Created: string;
  Architecture: string;
  Os: string;
  Driver: string;
  Config?: Record<string, any> | null;
  RootFS?: { Type?: string; Layers?: string[] } | null;
}

/** Docker 镜像构建历史条目（docker history 返回结构） */
interface HistoryItem {
  Id: string;
  Created: number;
  CreatedBy: string;
  Size: number;
  Comment: string;
  Tags: string[] | null;
}

/** 层空间分析响应（/api/images/:name/layers 返回） */
interface LayerAnalysis {
  totalSize: number;
  layerCount: number;
  layers: Array<{
    id: string;
    index: number;
    createdBy: string;
    size: number;
    missing: boolean;
    ratio: number;
    cumulativeRatio: number;
  }>;
  topLayers: Array<{
    id: string;
    index: number;
    createdBy: string;
    size: number;
    missing: boolean;
    ratio: number;
    cumulativeRatio: number;
  }>;
  dominant: { createdBy: string; ratio: number; size: number } | null;
  suggestions: string[];
}

/** Trivy 镜像扫描结果（/api/images/:name/scan 返回） */
interface ImageScan {
  available: boolean;
  scannedAt?: string;
  summary?: { critical: number; high: number; medium: number; low: number; unknown: number };
  vulnerabilities?: Array<{
    id: string;
    severity: string;
    pkgName?: string;
    installedVersion?: string;
    fixedVersion?: string;
    title?: string;
    description?: string;
    refs?: string[];
  }>;
  notAvailableReason?: string;
}

/** 使用该镜像的容器列表条目（/api/containers 返回结构） */
interface ContainerBrief {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Created: number;
}

/**
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 将创建时间格式化为本地时间字符串。
 * dockerode 的 Created 字段通常为 ISO 字符串；个别版本可能为 epoch 秒，此处做兼容判断。
 * @param created 创建时间（ISO 字符串或 epoch 秒）
 */
function formatCreated(created: string | number): string {
  if (!created) return '-';
  let ms: number;
  if (typeof created === 'number') {
    // 数值：若为秒则乘以 1000 转换为毫秒
    ms = created < 1e12 ? created * 1000 : created;
  } else {
    const n = Number(created);
    if (!isNaN(n) && String(created).trim() !== '') {
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      ms = new Date(created).getTime();
    }
  }
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 截断长字符串，超出部分显示省略号
 * @param str 原始字符串
 * @param len 保留长度
 */
function truncate(str: string, len: number): string {
  if (!str) return str;
  return str.length > len ? str.slice(0, len) + '…' : str;
}

/**
 * 层大小热力图颜色映射：按占比平方根插值，从蓝色（小）过渡到红色（大）。
 * 使用平方根映射弱化极端占比差异，让中小层也能看出相对大小。
 * @param ratio 该层占总空间的比例（0-1）
 */
function heatColor(ratio: number): string {
  const t = Math.sqrt(Math.max(0, Math.min(1, ratio)));
  const r = Math.round(59 + t * 196);
  const g = Math.round(130 - t * 82);
  const b = Math.round(246 - t * 202);
  return `rgb(${r},${g},${b})`;
}

/**
 * 从 refs 中取首个安全的 http/https 链接（防 javascript: 等协议注入）
 * @param refs 漏洞参考链接数组
 * @returns 首个安全的 http/https 链接；无安全链接时返回 undefined
 */
const safeRef = (refs?: string[]) => (refs || []).find((r) => /^https?:\/\//i.test(r));

/**
 * 触发镜像导出下载（docker save）
 * 鉴权依赖 Authorization 请求头，故通过 fetch 获取二进制 blob 后创建临时 <a> 触发下载。
 * @param name 待导出的镜像名
 */
async function downloadImage(name: string): Promise<void> {
  const res = await fetch('/api/images/' + encodeURIComponent(name) + '/save', {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `镜像导出失败 (${res.status})`;
    try {
      const data = JSON.parse(text);
      message = data?.error || message;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  // 优先从响应头解析文件名，否则使用接口返回的默认名称
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match?.[1] || 'image.tar';
  // 创建临时链接触发下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 镜像详情页组件
 */
export default function ImageDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const canDelete = isAdmin();
  const canOperateNow = canOperate();
  const [image, setImage] = useState<ImageInspect | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [containers, setContainers] = useState<ContainerBrief[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState<Set<number>>(new Set());
  // 层空间分析数据
  const [layerAnalysis, setLayerAnalysis] = useState<LayerAnalysis | null>(null);
  const [layerLoading, setLayerLoading] = useState(false);
  // 漏洞扫描（Trivy）结果
  const [scanResult, setScanResult] = useState<ImageScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  // 导出是否进行中
  const [exporting, setExporting] = useState(false);
  // 待删除的单个标签（用于二次确认弹窗）
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  // 删除标签是否进行中
  const [deletingTag, setDeletingTag] = useState(false);

  /** 拉取指定镜像的详情 */
  const fetchImage = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      const data = await get<ImageInspect>('/api/images/' + encodeURIComponent(name));
      setImage(data || null);
    } catch (e: any) {
      showToast(e?.message || '拉取镜像详情失败', 'error');
      setImage(null);
    } finally {
      setLoading(false);
    }
  }, [name, showToast]);

  /** 拉取指定镜像的构建历史 */
  const fetchHistory = useCallback(async () => {
    if (!name) return;
    setHistoryLoading(true);
    try {
      const data = await get<HistoryItem[]>('/api/images/' + encodeURIComponent(name) + '/history');
      setHistory(data || []);
    } catch (e: any) {
      showToast(e?.message || '拉取镜像构建历史失败', 'error');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [name, showToast]);

  /** 执行镜像漏洞扫描（Trivy） */
  const handleScan = useCallback(async () => {
    if (!name) return;
    setScanLoading(true);
    try {
      const r = await post<ImageScan>('/api/images/' + encodeURIComponent(name) + '/scan');
      setScanResult(r);
    } catch (e: any) {
      showToast(e?.message || '漏洞扫描失败', 'error');
      setScanResult(null);
    } finally {
      setScanLoading(false);
    }
  }, [name, showToast]);

  /** 拉取该镜像的层空间分析 */
  const fetchLayers = useCallback(async () => {
    if (!name) return;
    setLayerLoading(true);
    try {
      const data = await get<LayerAnalysis>('/api/images/' + encodeURIComponent(name) + '/layers');
      setLayerAnalysis(data || null);
    } catch (e: any) {
      showToast(e?.message || '拉取镜像层分析失败', 'error');
      setLayerAnalysis(null);
    } finally {
      setLayerLoading(false);
    }
  }, [name, showToast]);

  /** 拉取使用该镜像的容器列表（基于现有 /api/containers 在前端过滤） */
  const fetchContainers = useCallback(async () => {
    try {
      const data = await get<ContainerBrief[]>('/api/containers', { all: true });
      setContainers(data || []);
    } catch (e: any) {
      showToast(e?.message || '拉取容器列表失败', 'error');
      setContainers([]);
    }
  }, [showToast]);

  useEffect(() => {
    fetchImage();
    fetchHistory();
    fetchLayers();
    fetchContainers();
  }, [fetchImage, fetchHistory, fetchLayers, fetchContainers]);

  /** 镜像展示名称：优先取 RepoTags，否则取名称 */
  const displayName = image?.RepoTags?.[0] || name || '<none>';

  /** 展开或收起某条历史命令 */
  const toggleHistory = (idx: number) => {
    setHistoryExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  /** 使用该镜像的容器（按 Image 标签或 ImageID 匹配） */
  const relatedContainers = image
    ? containers.filter(
        (c) => c.Image === image.RepoTags?.[0] || c.ImageID === image.Id,
      )
    : [];

  /** 镜像 RootFS 层总数与总大小（虚拟大小使用 VirtualSize 或无实际值时以 Size 近似） */
  const layerCount = image?.RootFS?.Layers?.length ?? 0;
  const virtualSize = image?.RootFS?.Layers?.length
    ? (image as any).VirtualSize ?? image.Size
    : -1;

  /**
   * 导出当前镜像（下载 tar 文件）
   */
  const handleExport = useCallback(async () => {
    const target = image?.RepoTags?.[0] || name;
    if (!target) return;
    setExporting(true);
    try {
      await downloadImage(target);
      showToast('镜像导出已开始');
    } catch (e: any) {
      showToast(e?.message || '镜像导出失败', 'error');
    } finally {
      setExporting(false);
    }
  }, [image, name, showToast]);

  /**
   * 删除指定单个标签（仅删除该 repo:tag 引用，多个标签共用同一镜像层时不影响其他标签）
   * 删除成功或失败后均重新拉取详情以同步标签状态
   */
  const handleDeleteTag = useCallback(async () => {
    if (!deleteTag) return;
    if (!canDelete) {
      showToast('仅管理员可删除镜像标签', 'error');
      setDeleteTag(null);
      return;
    }
    setDeletingTag(true);
    try {
      await del('/api/images/' + encodeURIComponent(deleteTag) + '?force=true');
      showToast(`标签 ${deleteTag} 删除成功`);
      setDeleteTag(null);
      await fetchImage();
    } catch (e: any) {
      showToast(e?.message || `标签 ${deleteTag} 删除失败`, 'error');
    } finally {
      setDeletingTag(false);
    }
  }, [canDelete, deleteTag, showToast, fetchImage]);

  return (
    <div className="page detail-page">
      <Button variant="ghost" size="sm" className="back-btn" onClick={() => navigate(-1)}>
        ← 返回
      </Button>

      {loading ? (
        <PageLoading />
      ) : !image ? (
        <Empty title="未找到镜像" description="该镜像可能已被删除或名称不正确" />
      ) : (
        <>
        <Card
          title={displayName}
          extra={
            <Button variant="secondary" size="sm" loading={exporting} onClick={handleExport}>
              导出
            </Button>
          }
        >
          <div className="desc-grid">
            <div className="desc-item">
              <div className="desc-label">镜像 ID</div>
              <div className="desc-value mono" title={image.Id}>
                {image.Id}
              </div>
            </div>

            <div className="desc-item">
              <div className="desc-label">仓库标签</div>
              <div className="desc-value">
                {image.RepoTags && image.RepoTags.length ? (
                  <ul className="tag-list">
                    {image.RepoTags.map((tag) => (
                      <li key={tag} className="tag-chip" title={tag}>
                        <span className="tag-chip__name">{tag}</span>
                        <button
                          type="button"
                          className="tag-chip__del"
                          title="删除此标签"
                          aria-label={`删除标签 ${tag}`}
                          onClick={() => setDeleteTag(tag)}
                          disabled={!canDelete}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  '<none>'
                )}
              </div>
            </div>

            <div className="desc-item">
              <div className="desc-label">驱动 / 架构 / 系统</div>
              <div className="desc-value">
                {image.Driver || '-'} / {image.Architecture || '-'} / {image.Os || '-'}
              </div>
            </div>

            <div className="desc-item">
              <div className="desc-label">大小</div>
              <div className="desc-value">{formatSize(image.Size)}</div>
            </div>

            <div className="desc-item">
              <div className="desc-label">存储层（RootFS）</div>
              <div className="desc-value">
                {layerCount > 0 ? (
                  <>
                    {layerCount} 层
                    {virtualSize > 0 && (
                      <span className="hint">，总大小约 {formatSize(virtualSize)}</span>
                    )}
                  </>
                ) : (
                  '-'
                )}
              </div>
            </div>

            <div className="desc-item">
              <div className="desc-label">构建时间</div>
              <div className="desc-value">{formatCreated(image.Created)}</div>
            </div>

            {image.RepoDigests && image.RepoDigests.length > 0 && (
              <div className="desc-item">
                <div className="desc-label">仓库摘要</div>
                <div className="desc-value" title={image.RepoDigests.join('\n')}>
                  {image.RepoDigests.map((d) => (
                    <div key={d} className="line">
                      {d}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="desc-item desc-item--full">
              <div className="desc-label">暴露端口</div>
              <div className="desc-value">
                {image.Config?.ExposedPorts &&
                Object.keys(image.Config.ExposedPorts).length ? (
                  <div className="line-list">
                    {Object.keys(image.Config.ExposedPorts).map((port) => (
                      <span key={port} className="tag-chip">
                        {port}
                      </span>
                    ))}
                  </div>
                ) : (
                  '-'
                )}
              </div>
            </div>

            <div className="desc-item desc-item--full">
              <div className="desc-label">环境变量（只读）</div>
              <div className="desc-value">
                {image.Config?.Env && image.Config.Env.length ? (
                  <div className="env-list">
                    {(image.Config.Env as string[]).map((env) => (
                      <div key={env} className="line" title={env}>
                        {env}
                      </div>
                    ))}
                  </div>
                ) : (
                  '-'
                )}
              </div>
            </div>

            <div className="desc-item desc-item--full">
              <div className="desc-label">标签（Labels）</div>
              <div className="desc-value">
                {image.Labels && Object.keys(image.Labels).length ? (
                  <table className="labels-table">
                    <tbody>
                      {Object.entries(image.Labels).map(([k, v]) => (
                        <tr key={k}>
                          <td className="labels-key">{k}</td>
                          <td className="labels-val">{truncate(v || '', 120)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  '-'
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* 使用该镜像的容器 */}
        <Card title="使用该镜像的容器">
          {relatedContainers.length === 0 ? (
            <div className="desc-value">暂无容器使用该镜像</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {relatedContainers.map((c) => {
                  const cname = (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id.slice(0, 12);
                  return (
                    <tr key={c.Id}>
                      <td>{cname}</td>
                      <td>{c.State}</td>
                      <td>{formatCreated(c.Created * 1000)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* 层空间分析 */}
        <Card title="层空间分析（Layer）">
          {layerLoading ? (
            <div className="desc-value">加载中…</div>
          ) : !layerAnalysis || layerAnalysis.layerCount === 0 ? (
            <div className="desc-value">暂无可用层的空间数据。</div>
          ) : (
            <>
              <div className="desc-row">
                <div className="desc-label">有效层数</div>
                <div className="desc-value">{layerAnalysis.layerCount} 层</div>
              </div>
              <div className="desc-row">
                <div className="desc-label">层占用合计</div>
                <div className="desc-value">{formatSize(layerAnalysis.totalSize)}</div>
              </div>

              <h4 className="section-sub">层大小热力图</h4>
              <div className="layer-heatmap">
                {layerAnalysis.layers.map((l) => (
                  <div
                    key={l.index}
                    className="layer-heatmap__cell"
                    style={{ background: heatColor(l.ratio) }}
                    title={`第 ${l.index + 1} 层 · ${formatSize(l.size)} · ${(l.ratio * 100).toFixed(1)}%\n${l.createdBy}`}
                  />
                ))}
              </div>
              <div className="layer-heatmap__legend">
                <span>小</span>
                <div className="layer-heatmap__legend-bar" />
                <span>大</span>
                <span className="layer-heatmap__legend-note">每格一层，悬停查看明细</span>
              </div>

              <h4 className="section-sub">占用最大的层</h4>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '10%' }}>占比</th>
                    <th style={{ width: '18%' }}>大小</th>
                    <th>命令</th>
                  </tr>
                </thead>
                <tbody>
                  {layerAnalysis.topLayers.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <div className="layer-ratio">
                          <div
                            className="layer-ratio__bar"
                            style={{ width: `${Math.min(100, l.ratio * 100)}%` }}
                          />
                          <span className="layer-ratio__label">{(l.ratio * 100).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td>{formatSize(l.size)}</td>
                      <td className="history-cmd" title={l.createdBy}>
                        {truncate(l.createdBy || '-', 160)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {layerAnalysis.suggestions.length > 0 && (
                <>
                  <h4 className="section-sub">瘦身建议</h4>
                  <ul className="suggest-list">
                    {layerAnalysis.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Card>

        {/* 漏洞扫描（Trivy） */}
        <Card title="漏洞扫描（Trivy）">
          {scanLoading ? (
            <div className="desc-value">扫描中…（首次可能较慢）</div>
          ) : !scanResult ? (
            <div className="desc-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="desc-value">
                {canOperateNow
                  ? '点击扫描以检测镜像中的已知漏洞（依赖本机 Trivy）。'
                  : '无扫描权限。'}
              </div>
              {canOperateNow && (
                <Button variant="primary" size="sm" onClick={handleScan} disabled={scanLoading}>
                  立即扫描
                </Button>
              )}
            </div>
          ) : !scanResult.available ? (
            <div className="desc-value" style={{ color: 'var(--warn, #d97706)' }}>
              <strong>未检测到 Trivy</strong>：{scanResult.notAvailableReason}
            </div>
          ) : (
            <>
              <div className="desc-row" style={{ justifyContent: 'space-between' }}>
                <span className="desc-label">扫描时间</span>
                <span className="desc-value">{scanResult.scannedAt ? new Date(scanResult.scannedAt).toLocaleString() : '-'}</span>
              </div>
              {/* 等级分布 */}
              <div className="scan-sev-summary">
                {[
                  { k: 'critical', label: '严重', color: '#e11d48' },
                  { k: 'high', label: '高危', color: '#f97316' },
                  { k: 'medium', label: '中危', color: '#eab308' },
                  { k: 'low', label: '低危', color: '#3b82f6' },
                  { k: 'unknown', label: '未知', color: '#6b7280' },
                ].map((s) => (
                  <span key={s.k} className="scan-sev-chip" style={{ color: s.color, borderColor: s.color }}>
                    {s.label} {scanResult.summary?.[s.k as keyof typeof scanResult.summary] ?? 0}
                  </span>
                ))}
              </div>
              {/* 漏洞明细 */}
              {scanResult.vulnerabilities && scanResult.vulnerabilities.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '16%' }}>CVE</th>
                      <th style={{ width: '10%' }}>等级</th>
                      <th style={{ width: '20%' }}>依赖包</th>
                      <th style={{ width: '22%' }}>版本</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanResult.vulnerabilities.map((v, i) => (
                      <tr key={i}>
                        <td>
                          {(() => {
                            const safeUrl = safeRef(v.refs);
                            return safeUrl ? (
                              <a href={safeUrl} target="_blank" rel="noreferrer" className="scan-cve">{v.id}</a>
                            ) : (
                              <span className="scan-cve">{v.id}</span>
                            );
                          })()}
                        </td>
                        <td><span className={`scan-sev-badge scan-sev-${v.severity.toLowerCase()}`}>{v.severity}</span></td>
                        <td>{v.pkgName || '-'}</td>
                        <td>
                          {v.installedVersion || '-'}
                          {v.fixedVersion ? ` → ${v.fixedVersion}` : '（未修复）'}
                        </td>
                        <td className="scan-desc" title={v.description}>{v.title || v.description || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="desc-value">未发现已知漏洞（或 Trivy 未检出）。</div>
              )}
            </>
          )}
        </Card>

        {/* 构建历史 */}
        <Card title="构建历史（History）">
          {historyLoading ? (
            <div className="desc-value">加载中…</div>
          ) : history.length === 0 ? (
            <div className="desc-value">暂无历史</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>层 ID</th>
                  <th>大小</th>
                  <th>命令</th>
                  <th>标签</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, idx) => {
                  const expanded = historyExpanded.has(idx);
                  const idShort = h.Id && h.Id !== '<missing>' ? h.Id.slice(0, 12) : '-';
                  return (
                    <tr key={idx}>
                      <td className="mono">{idShort}</td>
                      <td>{formatSize(h.Size)}</td>
                      <td
                        className="history-cmd clickable"
                        onClick={() => toggleHistory(idx)}
                        title={expanded ? '' : '点击展开'}
                      >
                        {expanded ? h.CreatedBy : truncate(h.CreatedBy || '-', 160)}
                      </td>
                      <td>
                        {h.Tags && h.Tags.length ? (
                          <div className="line-list">
                            {h.Tags.map((t) => (
                              <span key={t} className="tag-chip">
                                {t}
                              </span>
                            ))}
                          </div>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* 删除单个标签确认框 */}
        <ConfirmDialog
          open={!!deleteTag}
          title="删除标签"
          message={
            deleteTag
              ? (image?.RepoTags?.length ?? 0) <= 1
                ? `确定要删除镜像标签 "${deleteTag}" 吗？这是最后一个正常标签，删除后将不再显示该镜像条目。此操作不可恢复。`
                : `确定要删除镜像标签 "${deleteTag}" 吗？仅移除该标签引用，不影响其他标签指向的镜像层。此操作不可恢复。`
              : ''
          }
          confirmText="删除"
          danger
          loading={deletingTag}
          onConfirm={handleDeleteTag}
          onCancel={() => setDeleteTag(null)}
        />
        </>
      )}
    </div>
  );
}
