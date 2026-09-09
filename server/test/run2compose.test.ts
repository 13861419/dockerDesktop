/**
 * docker run → Compose 转换 单元测试（node:test，零第三方依赖）
 * 覆盖：词法（引号/转义）、端口/卷/环境变量、命名卷归集、网络、资源限制、
 *       健康检查、cap/device、--rm 告警、未知选项、命令透传、非 run 命令报错
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseRunCommand, tokenizeCommand, parseMount } from '../src/run2compose';

test('tokenize：引号包裹含空格值，转义双引号', () => {
  const tokens = tokenizeCommand('docker run -e MSG="hello world" -e Q=\\"quoted\\" nginx');
  assert.deepStrictEqual(tokens, ['docker', 'run', '-e', 'MSG=hello world', '-e', 'Q="quoted"', 'nginx']);
});

test('基础转换：镜像/名称/端口/环境变量/重启策略', () => {
  const r = parseRunCommand('docker run -d --name web -p 8080:80 -p 5353:53/udp -e FOO=bar --restart always nginx:1.27');
  assert.strictEqual(r.service.name, 'web');
  assert.strictEqual(r.service.image, 'nginx:1.27');
  assert.deepStrictEqual(r.service.ports, ['8080:80', '5353:53/udp']);
  assert.deepStrictEqual(r.service.environment, ['FOO=bar']);
  assert.strictEqual(r.service.restart, 'always');
  assert.ok(r.yaml.includes('image: nginx:1.27'));
  assert.ok(r.yaml.includes('- 8080:80'));
});

test('bind 卷与命名卷归集', () => {
  const r = parseRunCommand('docker run -v /host/data:/data -v mydata:/db -v /cache nginx');
  assert.deepStrictEqual(r.service.volumes, ['/host/data:/data', 'mydata:/db', '/cache']);
  assert.deepStrictEqual(r.volumes, ['mydata']);
  assert.ok(r.yaml.includes('volumes:'));
  assert.ok(r.yaml.includes('  mydata:'));
});

test('--mount 语法解析', () => {
  const named = parseMount('type=volume,source=pgdata,target=/var/lib/postgresql/data', new Set());
  assert.strictEqual(named.spec, 'pgdata:/var/lib/postgresql/data');
  const bind = parseMount('type=bind,source=/opt/app,target=/app,readonly', new Set());
  assert.strictEqual(bind.spec, '/opt/app:/app:ro');
});

test('镜像后的命令参数映射为 command', () => {
  const r = parseRunCommand('docker run redis redis-server --appendonly yes');
  assert.deepStrictEqual(r.service.command, ['redis-server', '--appendonly', 'yes']);
  assert.ok(r.yaml.includes('command:'));
});

test('entrypoint / user / workdir / privileged', () => {
  const r = parseRunCommand('docker run --entrypoint /bin/sh -u 1000 -w /app --privileged alpine');
  assert.deepStrictEqual(r.service.entrypoint, ['/bin/sh']);
  assert.strictEqual(r.service.user, '1000');
  assert.strictEqual(r.service.working_dir, '/app');
  assert.strictEqual(r.service.privileged, true);
  assert.ok(r.yaml.includes('privileged: true'));
});

test('cap_add / cap_drop / devices 渲染', () => {
  const r = parseRunCommand('docker run --cap-add NET_ADMIN --cap-drop ALL --device /dev/dri:/dev/dri alpine');
  assert.deepStrictEqual(r.service.cap_add, ['NET_ADMIN']);
  assert.deepStrictEqual(r.service.cap_drop, ['ALL']);
  assert.deepStrictEqual(r.service.devices, ['/dev/dri:/dev/dri']);
  assert.ok(r.yaml.includes('cap_add:'));
  assert.ok(r.yaml.includes('devices:'));
});

test('资源限制 --cpus / --memory 映射到 deploy', () => {
  const r = parseRunCommand('docker run --cpus 1.5 -m 512m nginx');
  assert.deepStrictEqual(r.service.deployResources, { cpus: '1.5', memory: '512m' });
  assert.ok(r.yaml.includes('limits:'));
});

test('健康检查 --health-* 映射', () => {
  const r = parseRunCommand('docker run --health-cmd "curl -f http://localhost" --health-interval 30s --health-retries 3 nginx');
  assert.deepStrictEqual(r.service.healthcheck?.test, ['CMD-SHELL', 'curl -f http://localhost']);
  assert.strictEqual(r.service.healthcheck?.interval, 30);
  assert.strictEqual(r.service.healthcheck?.retries, 3);
  assert.ok(r.yaml.includes('healthcheck:'));
});

test('自定义网络归集 + host 网络告警', () => {
  const r = parseRunCommand('docker run --network backend --network frontend nginx');
  assert.deepStrictEqual(r.service.networks, ['backend', 'frontend']);
  assert.deepStrictEqual(r.networks, ['backend', 'frontend']);
  const h = parseRunCommand('docker run --network host nginx');
  assert.ok(h.warnings.some((w) => w.includes('host')));
});

test('--rm / 未知选项 / --env-file 产生告警', () => {
  const r = parseRunCommand('docker run --rm --env-file .env --frobnicate nginx');
  assert.ok(r.warnings.some((w) => w.includes('--rm')));
  assert.ok(r.warnings.some((w) => w.includes('--env-file')));
  assert.ok(r.warnings.some((w) => w.includes('--frobnicate')));
});

test('--name 缺省时取镜像名并清洗', () => {
  const r = parseRunCommand('docker run library/redis:7');
  assert.strictEqual(r.service.name, 'redis');
  const r2 = parseRunCommand('docker run 7service/app');
  assert.strictEqual(r2.service.name, 'app');
});

test('docker 前缀可省略；非 run 命令抛错', () => {
  const r = parseRunCommand('run -d nginx');
  assert.strictEqual(r.service.image, 'nginx');
  assert.throws(() => parseRunCommand('docker ps'), /docker run/);
});

test('--name=foo 等号内联取值', () => {
  const r = parseRunCommand('docker run --name=web -e A=1 nginx');
  assert.strictEqual(r.service.name, 'web');
});
