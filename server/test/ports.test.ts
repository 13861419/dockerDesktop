/**
 * 端口占用提取逻辑单元测试
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { extractEntries } from '../src/routes/ports';

const engine = { id: 'e1', name: 'local', endpoint: '', is_current: 1 };

test('extractEntries：仅提取有宿主端口映射的条目', () => {
  const entries = extractEntries(
    {
      Id: 'abcdef123456',
      Names: ['/web'],
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 8443, Type: 'tcp' },
        { IP: '', PrivatePort: 9000, Type: 'tcp' }, // 无宿主映射，应忽略
      ],
    },
    engine,
  );

  // 同一映射的 IPv4/IPv6 双栈条目去重为一条（避免误判端口冲突）
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].hostPort, 8080);
  assert.strictEqual(entries[0].containerPort, 80);
  assert.strictEqual(entries[0].containerName, 'web');
  assert.strictEqual(entries[0].containerId, 'abcdef123456');
  assert.strictEqual(entries[0].protocol, 'tcp');
  assert.strictEqual(entries[1].hostPort, 8443);
});

test('extractEntries：容器无名时回退到短 ID，udp 协议保留', () => {
  const entries = extractEntries(
    {
      Id: 'xyz789',
      Names: [],
      Ports: [{ IP: '0.0.0.0', PrivatePort: 53, PublicPort: 1053, Type: 'udp' }],
    },
    engine,
  );

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].containerName, 'xyz789');
  assert.strictEqual(entries[0].protocol, 'udp');
});

test('extractEntries：无端口输出时返回空数组', () => {
  assert.deepStrictEqual(extractEntries({ Id: 'a', Names: ['/x'], Ports: [] }, engine), []);
  assert.deepStrictEqual(extractEntries({ Id: 'a', Names: ['/x'] }, engine), []);
});
