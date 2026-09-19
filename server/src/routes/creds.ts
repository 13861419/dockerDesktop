/**
 * 部署凭据库（1.85.0）API 路由
 *
 * 集中管理 Git / Registry 凭据，供部署应用下拉引用：
 *  - git：{ type: 'token' | 'ssh', token?, privateKey?, passphrase? }（与部署应用内联 cred 同格式）
 *  - registry：{ user, pass }
 * 明文一律 encryptSecret 加密落库，列表仅回显名称与类型，不回显密文。
 */
import { Router, Request, Response } from 'express';
import { getDb, encryptSecret } from '../storage';
import { requireAdmin, requireAuth } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

const CRED_TYPES = ['git', 'registry'] as const;
type CredType = (typeof CRED_TYPES)[number];

interface DeployCredRow {
  id: number;
  name: string;
  type: string;
  secret: string;
  created_at: number;
  updated_at: number;
}

/** 校验凭据体：git 需 token/privateKey 至少其一；registry 需 user+pass；返回标准化对象或 null */
export function normalizeCredSecret(type: string, raw: any): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (type === 'git') {
    const out: Record<string, string> = {};
    const token = String(raw.token ?? '').trim();
    const privateKey = String(raw.privateKey ?? '').trim();
    if (!token && !privateKey) return null;
    out.type = raw.type === 'ssh' ? 'ssh' : 'token';
    if (token) out.token = token;
    if (privateKey) out.privateKey = privateKey;
    const passphrase = String(raw.passphrase ?? '').trim();
    if (passphrase) out.passphrase = passphrase;
    return out;
  }
  if (type === 'registry') {
    const user = String(raw.user ?? '').trim();
    const pass = String(raw.pass ?? '');
    if (!user || !pass) return null;
    return { user, pass };
  }
  return null;
}

/** GET / — 凭据列表（不含密文） */
router.get('/', requireAuth, (req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT id, name, type, created_at, updated_at FROM deploy_creds ORDER BY id ASC').all();
  res.json({ items: rows });
});

/** POST / — 新建凭据 */
router.post('/', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const type = String(req.body?.type || '').trim();
  if (!name) return res.status(400).json({ error: '缺少凭据名称' });
  if (!CRED_TYPES.includes(type as CredType)) return res.status(400).json({ error: '凭据类型必须是 git 或 registry' });
  const secret = normalizeCredSecret(type, req.body?.secret);
  if (!secret) {
    return res.status(400).json({ error: type === 'git' ? 'Git 凭据需要 token 或 privateKey' : 'Registry 凭据需要 user 与 pass' });
  }
  const now = Date.now();
  try {
    getDb()
      .prepare('INSERT INTO deploy_creds (name, type, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, type, encryptSecret(JSON.stringify(secret)), now, now);
  } catch (e: any) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
  logOperation(res.locals.username, '新建部署凭据', 'compose', name, `类型: ${type}`, true);
  res.json({ ok: true });
});

/** PUT /:id — 更新凭据（secret 缺省保持原值） */
router.put('/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT * FROM deploy_creds WHERE id = ?').get(Number(req.params.id)) as DeployCredRow | undefined;
  if (!row) return res.status(404).json({ error: '凭据不存在' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
  if (!name) return res.status(400).json({ error: '凭据名称不能为空' });
  let secret = row.secret;
  if (req.body?.secret !== undefined) {
    const parsed = normalizeCredSecret(row.type, req.body.secret);
    if (!parsed) {
      return res.status(400).json({ error: row.type === 'git' ? 'Git 凭据需要 token 或 privateKey' : 'Registry 凭据需要 user 与 pass' });
    }
    secret = JSON.stringify(parsed);
  }
  getDb().prepare('UPDATE deploy_creds SET name = ?, secret = ?, updated_at = ? WHERE id = ?').run(name, secret, Date.now(), row.id);
  logOperation(res.locals.username, '更新部署凭据', 'compose', name, '', true);
  res.json({ ok: true });
});

/** DELETE /:id — 删除凭据（被部署应用引用时拒绝） */
router.delete('/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT name FROM deploy_creds WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: '凭据不存在' });
  const inUse = getDb()
    .prepare('SELECT COUNT(*) AS n FROM deploy_apps WHERE git_cred_id = ? OR registry_cred_id = ?')
    .get(id) as any;
  if (inUse.n > 0) {
    return res.status(409).json({ error: `该凭据正被 ${inUse.n} 个部署应用引用，请先解除引用` });
  }
  getDb().prepare('DELETE FROM deploy_creds WHERE id = ?').run(id);
  logOperation(res.locals.username, '删除部署凭据', 'compose', row.name, '', true);
  res.json({ ok: true });
});

export default router;
