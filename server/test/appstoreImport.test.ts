/**
 * 应用商店第三方格式导入单元测试（1.93.0）
 * 覆盖：CasaOS JSON（单条/数组/compose）、1Panel 模板转换、通用 compose、非法输入
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseImportPayload, convert1PanelTemplate } from '../src/appstore/import';

test('convert1PanelTemplate: {{ .Values.x }} 转为 ${X}，default 转为 ${X:-y}', () => {
  const r = convert1PanelTemplate('image: nginx:{{ .Values.version | default "latest" }}\nports:\n  - "{{ .Values.panelPort }}:80"');
  assert.ok(r.converted.includes('${VERSION:-latest}'));
  assert.ok(r.converted.includes('${PANELPORT}'));
  assert.deepStrictEqual(r.params.sort(), ['panelPort', 'version']);
});

test('CasaOS 单容器清单 → 自定义应用字段映射', () => {
  const json = {
    title: 'AdGuard Home',
    tagline: 'DNS server',
    description: 'Network-wide ads blocking',
    category: ['Network'],
    container: {
      image: 'adguard/adguardhome:v0.107',
      port_mapping: [
        { container_port: 3000, host_port: 3000, protocol: 'tcp' },
        { container_port: 53, host_port: 53, protocol: 'udp' },
      ],
      volumes: [{ container_path: '/opt/adguardhome/conf', host_path: '/data/adguard' }],
      environments: [{ key: 'TZ', value: 'Asia/Shanghai' }],
    },
  };
  const r = parseImportPayload(JSON.stringify(json));
  assert.strictEqual(r.format, 'casaos');
  assert.strictEqual(r.apps.length, 1);
  const app = r.apps[0];
  assert.strictEqual(app.name, 'AdGuard Home');
  assert.strictEqual(app.image, 'adguard/adguardhome:v0.107');
  assert.strictEqual(app.category, 'Network');
  assert.deepStrictEqual(app.ports, [
    { container: 3000, host: 3000 },
    { container: 53, host: 53 },
  ]);
  assert.deepStrictEqual(app.env, [{ key: 'TZ', value: 'Asia/Shanghai' }]);
  assert.deepStrictEqual(app.volumes, [{ container: '/opt/adguardhome/conf', host: '/data/adguard' }]);
  assert.ok(app.tags.includes('casaos'));
  assert.strictEqual(app.compose, null);
});

test('CasaOS compose 文本 → Compose 套件定义', () => {
  const json = {
    title: 'Stack',
    container: { image: '' },
    compose: 'services:\n  web:\n    image: nginx:1.25\n    ports:\n      - "8080:80"\n  db:\n    image: mariadb:11\n',
  };
  const r = parseImportPayload(JSON.stringify(json));
  assert.strictEqual(r.format, 'casaos');
  assert.strictEqual(r.apps.length, 1);
  const c = r.apps[0].compose;
  assert.ok(c, 'compose 定义应存在');
  assert.deepStrictEqual(c!.services.sort(), ['db', 'web']);
  assert.ok(c!.compose.includes('nginx:1.25'));
  assert.deepStrictEqual(c!.ports, [{ container: 80, host: 8080 }]);
  assert.strictEqual(c!.defaultVersion, '1.25');
});

test('CasaOS 数组批量导入', () => {
  const arr = [
    { title: 'A', container: { image: 'a:1' } },
    { title: 'B', container: { image: 'b:2' } },
  ];
  const r = parseImportPayload(JSON.stringify(arr));
  assert.strictEqual(r.apps.length, 2);
  assert.strictEqual(r.format, 'casaos');
});

test('1Panel data.yml + compose 模板 → 参数转环境变量', () => {
  const dataYml = 'name: WordPress\ncategory: Blog\ndescription: Blog tool';
  const composeYml = [
    'services:',
    '  wordpress:',
    '    image: "wordpress:{{ .Values.wordpress_version | default \\"latest\\" }}"',
    '    ports:',
    '      - "{{ .Values.panelPort }}:80"',
    '    environment:',
    '      - WORDPRESS_DB_HOST={{ .Values.dbHost | default "db" }}',
  ].join('\n');
  const r = parseImportPayload('', dataYml, composeYml);
  assert.strictEqual(r.format, '1panel');
  assert.strictEqual(r.apps.length, 1);
  const app = r.apps[0];
  assert.strictEqual(app.name, 'WordPress');
  assert.strictEqual(app.category, 'Blog');
  assert.ok(app.compose!.compose.includes('${PANELPORT}:80'));
  assert.ok(app.compose!.compose.includes('${WORDPRESS_VERSION:-latest}'));
  const keys = app.compose!.env.map((e) => e.key.toUpperCase());
  assert.ok(keys.includes('PANELPORT'));
  assert.ok(keys.includes('DBHOST'));
  assert.strictEqual(app.tags.includes('1panel'), true);
});

test('通用 docker-compose.yml → Compose 套件应用', () => {
  const yml = 'services:\n  app:\n    image: registry.local/myapp:2.0\n    environment:\n      - FOO=bar\n    volumes:\n      - ./data:/var/www';
  const r = parseImportPayload(yml);
  assert.strictEqual(r.format, 'compose');
  assert.strictEqual(r.apps.length, 1);
  assert.strictEqual(r.apps[0].name, 'app');
  assert.deepStrictEqual(r.apps[0].compose!.env, [{ key: 'FOO', value: 'bar' }]);
  assert.deepStrictEqual(r.apps[0].compose!.volumes, [{ container: '/var/www', host: './data' }]);
  assert.strictEqual(r.apps[0].compose!.defaultVersion, '2.0');
});

test('非法输入返回失败原因', () => {
  const r = parseImportPayload('这不是任何格式的文本');
  assert.strictEqual(r.apps.length, 0);
  assert.ok(r.failures[0].reason.length > 0);
  const empty = parseImportPayload('');
  assert.strictEqual(empty.apps.length, 0);
  assert.ok(empty.failures.length > 0);
});
