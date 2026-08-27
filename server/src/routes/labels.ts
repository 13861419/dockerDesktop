/**
 * 标签体系 API 路由
 *
 * GET /api/labels —— 聚合当前引擎 容器/镜像/数据卷 的全部标签（key=value），
 * 统计每种标签被各类资源引用的次数，供前端构建跨页面标签过滤器。
 *
 * 说明：Docker 标签只能在资源创建时指定（容器/镜像不可运行时修改），
 * 因此本模块只做"读取 + 聚合"，不做标签的写入与编辑。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';

const router = Router();

/** 标签聚合项：key=value 及其引用计数 */
export interface LabelAggregate {
  key: string;
  value: string;
  /** 引用总数（容器+镜像+卷） */
  count: number;
  /** 各类资源引用数 */
  kinds: { container: number; image: number; volume: number };
}

/**
 * 从对象的 Labels 字段累加到聚合表
 * @param labels 标签对象（可能为 null/undefined）
 * @param kind 资源类型
 * @param map 聚合表（"key=value" -> LabelAggregate）
 */
export function accumulate(labels: Record<string, string> | undefined | null, kind: keyof LabelAggregate['kinds'], map: Map<string, LabelAggregate>): void {
  if (!labels || typeof labels !== 'object') return;
  for (const [key, value] of Object.entries(labels)) {
    if (!key) continue;
    const v = value == null ? '' : String(value);
    const pairKey = `${key}=${v}`;
    let item = map.get(pairKey);
    if (!item) {
      item = { key, value: v, count: 0, kinds: { container: 0, image: 0, volume: 0 } };
      map.set(pairKey, item);
    }
    item.count += 1;
    item.kinds[kind] += 1;
  }
}

/**
 * GET /api/labels
 * @query kind 可选过滤：container | image | volume（逗号分隔多个），缺省返回全部
 * @returns { items: LabelAggregate[] } 按 count 降序、key 字典序升序
 */
router.get(
  '/',
  async (req: Request, res: Response) => {
    const kindsParam = String(req.query.kind || '').toLowerCase();
    const want = new Set(
      kindsParam ? kindsParam.split(',').map((s) => s.trim()).filter(Boolean) : ['container', 'image', 'volume'],
    );

    const docker = await getDockerClient();
    const map = new Map<string, LabelAggregate>();

    await Promise.all([
      want.has('container')
        ? docker
            .listContainers({ all: true })
            .then((list: any[]) => list.forEach((c) => accumulate(c.Labels, 'container', map)))
            .catch(() => undefined)
        : Promise.resolve(),
      want.has('image')
        ? docker
            .listImages({ all: false })
            .then((list: any[]) => list.forEach((img) => accumulate(img.Labels, 'image', map)))
            .catch(() => undefined)
        : Promise.resolve(),
      want.has('volume')
        ? docker
            .listVolumes()
            .then((data: any) => (data?.Volumes || []).forEach((v: any) => accumulate(v.Labels, 'volume', map)))
            .catch(() => undefined)
        : Promise.resolve(),
    ]);

    const items = Array.from(map.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    res.json({ items });
  },
);

export default router;
