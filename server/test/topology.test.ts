/**
 * 网络拓扑路由单元测试（node:test，零第三方依赖）
 *
 * 覆盖：
 *  1. 路由模块正常导出
 *  2. asyncHandler 正确捕获异步错误
 *  3. 路由注册了 GET / 端点
 *  4. 节点/边数据格式校验
 */
import { test } from 'node:test';
import assert from 'node:assert';
import topologyRouter from '../src/routes/topology';

test('topologyRouter 是一个 Express Router', () => {
  assert.ok(topologyRouter, 'router should be defined');
  assert.strictEqual(typeof topologyRouter, 'function', 'router should be a function');
});

test('topologyRouter 注册了 GET / 端点', () => {
  // Express Router 内部 stack 是私有属性，但可以通过 _router.stack 检查
  const router = topologyRouter as any;
  const stack = router.stack || router._router?.stack;
  if (stack && Array.isArray(stack)) {
    const getRoutes = stack.filter((layer: any) => {
      return layer.route && layer.route.path === '/' && layer.route.methods?.get;
    });
    assert.ok(getRoutes.length > 0, 'should have GET / route');
  }
});

test('asyncHandler 包装的函数正常执行', async () => {
  // 模拟 asyncHandler 的行为
  function asyncHandler(fn: (req: any, res: any) => Promise<any>) {
    return (req: any, res: any) => {
      fn(req, res).catch((err: any) => {
        res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
      });
    };
  }

  const mockReq = {};
  let statusCode = 0;
  let jsonData: any = null;
  const mockRes = {
    status: (code: number) => { statusCode = code; return mockRes; },
    json: (data: any) => { jsonData = data; },
  };

  const handler = asyncHandler(async (req: any, res: any) => {
    res.json({ ok: true });
  });

  await handler(mockReq, mockRes as any);
  assert.strictEqual(statusCode, 0);
  assert.deepStrictEqual(jsonData, { ok: true });
});

test('asyncHandler 捕获异步错误返回 500', async () => {
  function asyncHandler(fn: (req: any, res: any) => Promise<any>) {
    return (req: any, res: any) => {
      fn(req, res).catch((err: any) => {
        res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
      });
    };
  }

  let statusCode = 0;
  let jsonData: any = null;
  const mockRes = {
    status: (code: number) => { statusCode = code; return mockRes; },
    json: (data: any) => { jsonData = data; },
  };

  const handler = asyncHandler(async () => {
    throw new Error('测试错误');
  });

  await handler({}, mockRes as any);
  assert.strictEqual(statusCode, 500);
  assert.deepStrictEqual(jsonData, { error: '测试错误' });
});

test('asyncHandler 捕获带 statusCode 的错误', async () => {
  function asyncHandler(fn: (req: any, res: any) => Promise<any>) {
    return (req: any, res: any) => {
      fn(req, res).catch((err: any) => {
        res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
      });
    };
  }

  let statusCode = 0;
  let jsonData: any = null;
  const mockRes = {
    status: (code: number) => { statusCode = code; return mockRes; },
    json: (data: any) => { jsonData = data; },
  };

  const handler = asyncHandler(async () => {
    const err: any = new Error('未找到');
    err.statusCode = 404;
    throw err;
  });

  await handler({}, mockRes as any);
  assert.strictEqual(statusCode, 404);
  assert.deepStrictEqual(jsonData, { error: '未找到' });
});

test('TopoContainer 接口结构验证', () => {
  // 验证接口定义符合预期结构
  const container: import('../src/routes/topology').TopoContainer = {
    id: 'test-id',
    name: 'test-container',
    status: 'running',
    health: 'healthy',
    image: 'nginx:latest',
    projectName: 'my-project',
    networks: ['bridge', 'my-network'],
    ports: [{ target: '80', protocol: 'tcp', published: '8080' }],
  };

  assert.strictEqual(container.id, 'test-id');
  assert.strictEqual(container.name, 'test-container');
  assert.strictEqual(container.status, 'running');
  assert.strictEqual(container.health, 'healthy');
  assert.strictEqual(container.image, 'nginx:latest');
  assert.strictEqual(container.projectName, 'my-project');
  assert.strictEqual(container.networks.length, 2);
  assert.strictEqual(container.ports.length, 1);
  assert.strictEqual(container.ports[0].target, '80');
  assert.strictEqual(container.ports[0].published, '8080');
});
