/**
 * docker run → Compose 逆向 单元测试（node:test，零第三方依赖）
 * 覆盖：端口/卷/环境变量/网络/健康检查/资源限制/命名卷归集 / --rm 告警 / 命名去重
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { inferCompose, renderComposeYaml, type InferInput } from '../src/composeInfer';

function sampleNginx(): InferInput {
  return {
    id: 'abc1234567890',
    Name: '/nginx-test',
    Config: {
      Image: 'nginx:1.25',
      Cmd: ['nginx', '-g', 'daemon off;'],
      Env: ['PATH=/usr/local/sbin:/usr/local/bin', 'NGINX_VERSION=1.25', 'SECRET_PASS=abc123', 'HOSTNAME=x'],
      Labels: { 'com.docker.compose.project': 'legacy', 'com.example.team': 'ops', 'org.opencontainers.image.title': 'nginx' },
      WorkingDir: '/app',
      User: '101',
      Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost'], Interval: 30000000000, Timeout: 5000000000, Retries: 3 },
    },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }], '53/udp': [{ HostIp: '', HostPort: '5353' }] },
      Binds: [],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'default',
      Privileged: false,
      AutoRemove: false,
      Memory: 536870912,
    },
    Mounts: [
      { Type: 'volume', Source: 'myapp-data', Target: '/data', RW: true },
      { Type: 'bind', Source: '/host/conf', Target: '/etc/nginx/conf.d', RW: false },
    ],
  };
}

test('inferService 提取端口/卷/环境变量/标签/健康检查/资源', () => {
  const result = inferCompose([sampleNginx()]);
  const service = result.services[0];
  assert.ok(service);
  assert.strictEqual(service.name, 'nginx-test');
  assert.strictEqual(service.image, 'nginx:1.25');
  assert.deepStrictEqual(service.ports, ['8080:80', '5353:53/udp']);
  // 卷：命名卷归集后重映射为顶层卷名 + bind 卷
  assert.ok(service.volumes.some((v: string) => v.endsWith('/data')));
  assert.ok(service.volumes.some((v: string) => v.endsWith('/etc/nginx/conf.d:ro')));
  // 环境变量：过滤 PATH/HOSTNAME，保留 NGINX_VERSION 与 SECRET_PASS
  assert.ok(!service.environment.some((e: string) => e.startsWith('PATH=')));
  assert.ok(service.environment.some((e: string) => e.startsWith('NGINX_VERSION=')));
  // 标签：过滤 compose 与 oci title
  assert.ok(service.labels['com.example.team'] === 'ops');
  assert.ok(!service.labels['com.docker.compose.project']);
  assert.ok(!service.labels['org.opencontainers.image.title']);
  // 健康检查（Interval 30s / Timeout 5s）
  assert.ok(service.healthcheck && service.healthcheck.test[0] === 'CMD');
  assert.strictEqual(service.healthcheck.interval, 30);
  assert.strictEqual(service.healthcheck.timeout, 5);
  // 资源限制
  assert.ok(service.deployResources && service.deployResources.memory === '512m');
  assert.strictEqual(service.restart, 'unless-stopped');
  assert.deepStrictEqual(result.warnings, []);
});

test('renderComposeYaml 输出合法结构并能被解析', () => {
  const { yaml, volumes, networks, services } = inferCompose([sampleNginx()]);
  // 顶层命名卷应被归集
  assert.ok(volumes.length > 0);
  // yaml 应包含关键片段
  assert.ok(yaml.includes('services:'));
  assert.ok(yaml.includes('image: nginx:1.25'));
  assert.ok(yaml.includes('8080:80'));
  assert.ok(yaml.includes('restart: unless-stopped'));
  assert.ok(yaml.includes('volumes:'));
  assert.ok(services.length === 1);
});

test('--rm 容器输出告警而不报错', () => {
  const input = sampleNginx() as any;
  input.HostConfig.AutoRemove = true;
  const { warnings } = inferCompose([input]);
  assert.ok(warnings.some((w) => w.includes('--rm')));
});

test('缺少 image 的容器被跳过并告警', () => {
  const input = { id: 'xx', Name: '/noimg' } as InferInput;
  const { services, warnings } = inferCompose([input]);
  assert.strictEqual(services.length, 0);
  assert.ok(warnings.some((w) => w.includes('缺少 image')));
});

test('命名去重：同名容器追加后缀', () => {
  const a = sampleNginx();
  const b = { ...sampleNginx(), id: 'def', Name: '/nginx-test' };
  const { services } = inferCompose([a, b]);
  assert.strictEqual(services.length, 2);
  const names = services.map((s) => s.name);
  assert.ok(names[0] !== names[1]);
});

test('自定义网络归集到顶层 networks', () => {
  const input = sampleNginx() as any;
  input.HostConfig.NetworkMode = 'my-bridge';
  input.NetworkSettings = { Networks: { 'my-bridge': { NetworkID: 'x', Aliases: [] } } };
  const { networks, yaml } = inferCompose([input]);
  assert.ok(networks.includes('my-bridge'));
  assert.ok(yaml.includes('networks:'));
});
