/**
 * ACME http-01 挑战应答服务
 *
 * 在 80 端口（可用 ACME_HTTP_PORT 覆盖）挂一个仅服务
 * /.well-known/acme-challenge/<token> 的极简 HTTP 服务：
 * Let's Encrypt 校验域名所有权时经由 http://<域名>/.well-known/acme-challenge/<token>
 * 访问到本机 —— 因此 80 端口需指向面板所在主机且未被其他服务占用。
 */
import http from 'http';

/** 挑战注册表：token → keyAuthorization */
const challenges = new Map<string, string>();

let server: http.Server | null = null;
let listenPort = 0;
let lastError = '';

/** ACME HTTP-01 服务端口 */
export const ACME_HTTP_PORT = Number(process.env.ACME_HTTP_PORT) || 80;

/** 注册一个待应答挑战 */
export function putChallenge(token: string, keyAuthorization: string): void {
  challenges.set(token, keyAuthorization);
}

/** 取走（并移除）一个挑战 */
export function popChallenge(token: string): string | undefined {
  const ka = challenges.get(token);
  challenges.delete(token);
  return ka;
}

/**
 * 启动挑战服务（幂等；占用失败不抛异常，状态经 challengeServerStatus 查询）
 */
export async function startChallengeServer(): Promise<{ ok: boolean; port: number; error: string }> {
  if (server) return { ok: true, port: listenPort, error: '' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.pathname.split('/').pop() || '';
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
      const ka = popChallenge(token);
      if (ka) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(ka);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    srv.once('error', (err: NodeJS.ErrnoException) => {
      server = null;
      lastError = err.code === 'EADDRINUSE' ? `端口 ${ACME_HTTP_PORT} 已被占用` : String(err.message);
      resolve({ ok: false, port: ACME_HTTP_PORT, error: lastError });
    });
    srv.listen(ACME_HTTP_PORT, '0.0.0.0', () => {
      server = srv;
      listenPort = ACME_HTTP_PORT;
      resolve({ ok: true, port: ACME_HTTP_PORT, error: '' });
    });
  });
}

/** 挑战服务状态（用于前端提示） */
export function challengeServerStatus(): { listening: boolean; port: number; error: string } {
  return { listening: !!server, port: listenPort || ACME_HTTP_PORT, error: lastError };
}

/** 停止挑战服务（测试 / 关停用） */
export function stopChallengeServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
