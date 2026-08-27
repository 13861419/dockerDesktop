import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge, updateKnowledge, deleteKnowledge, getKnowledge, listKnowledge, getKnowledgeStats, searchKnowledge, autoInitKnowledge } from '../src/aiKnowledge';

// 每个测试前清空知识库
beforeEach(() => {
  const { getDb } = require('../src/storage');
  getDb().exec('DELETE FROM ai_knowledge');
});

describe('aiKnowledge CRUD', () => {
  it('createKnowledge: 创建条目并返回完整字段', async () => {
    const entry = await createKnowledge('测试标题', 'docker', '测试内容', ['tag1']);
    assert.ok(entry.id > 0);
    assert.equal(entry.title, '测试标题');
    assert.equal(entry.category, 'docker');
    assert.equal(entry.content, '测试内容');
    assert.deepEqual(entry.tags, ['tag1']);
    assert.ok(entry.createdAt > 0);
    assert.ok(entry.updatedAt > 0);
  });

  it('createKnowledge: 无效分类回退到 general', async () => {
    const entry = await createKnowledge('标题', 'invalid_cat', '内容');
    assert.equal(entry.category, 'general');
  });

  it('getKnowledge: 按 ID 获取', async () => {
    const created = await createKnowledge('查找测试', 'general', '内容');
    const found = getKnowledge(created.id);
    assert.ok(found);
    assert.equal(found!.title, '查找测试');
  });

  it('getKnowledge: 不存在的 ID 返回 null', () => {
    assert.equal(getKnowledge(99999), null);
  });

  it('updateKnowledge: 更新字段', async () => {
    const created = await createKnowledge('原始标题', 'general', '原始内容');
    const updated = await updateKnowledge(created.id, { title: '新标题', content: '新内容' });
    assert.ok(updated);
    assert.equal(updated!.title, '新标题');
    assert.equal(updated!.content, '新内容');
  });

  it('updateKnowledge: 不存在返回 null', async () => {
    const result = await updateKnowledge(99999, { title: '不存在' });
    assert.equal(result, null);
  });

  it('deleteKnowledge: 删除存在的条目', async () => {
    const created = await createKnowledge('删除测试', 'general', '内容');
    assert.equal(deleteKnowledge(created.id), true);
    assert.equal(getKnowledge(created.id), null);
  });

  it('deleteKnowledge: 不存在返回 false', () => {
    assert.equal(deleteKnowledge(99999), false);
  });

  it('listKnowledge: 返回列表和总数', async () => {
    await createKnowledge('条目1', 'docker', '内容1');
    await createKnowledge('条目2', 'compose', '内容2');
    await createKnowledge('条目3', 'docker', '内容3');
    const result = listKnowledge();
    assert.equal(result.total, 3);
    assert.equal(result.items.length, 3);
  });

  it('listKnowledge: 分类过滤', async () => {
    await createKnowledge('条目1', 'docker', '内容1');
    await createKnowledge('条目2', 'compose', '内容2');
    const result = listKnowledge({ category: 'docker' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].category, 'docker');
  });

  it('listKnowledge: 关键词搜索', async () => {
    await createKnowledge('Nginx 配置', 'general', '如何配置 nginx 反向代理');
    await createKnowledge('Docker 网络', 'network', 'bridge 网络配置');
    const result = listKnowledge({ keyword: 'nginx' });
    assert.equal(result.total, 1);
    assert.ok(result.items[0].title.includes('Nginx'));
  });

  it('listKnowledge: 分页', async () => {
    for (let i = 0; i < 5; i++) await createKnowledge(`条目${i}`, 'general', `内容${i}`);
    const p1 = listKnowledge({ limit: 2, offset: 0 });
    const p2 = listKnowledge({ limit: 2, offset: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p2.items.length, 2);
    assert.equal(p1.total, 5);
  });

  it('getKnowledgeStats: 分类统计', async () => {
    await createKnowledge('a', 'docker', 'c1');
    await createKnowledge('b', 'docker', 'c2');
    await createKnowledge('c', 'compose', 'c3');
    const stats = getKnowledgeStats();
    assert.ok(stats.length >= 2);
    const docker = stats.find((s) => s.category === 'docker');
    assert.ok(docker);
    assert.equal(docker!.count, 2);
  });

  it('createKnowledge: owner 和 shared 字段', async () => {
    const mine = await createKnowledge('我的知识', 'general', '仅我自己', [], 'alice', false);
    const shared = await createKnowledge('共享知识', 'general', '共享给他人', [], 'alice', true);
    assert.equal(mine.owner, 'alice');
    assert.equal(mine.shared, false);
    assert.equal(shared.owner, 'alice');
    assert.equal(shared.shared, true);
  });

  it('listKnowledge: owner 过滤和 sharedOnly 过滤', async () => {
    await createKnowledge('alice 的', 'general', 'c', [], 'alice', false);
    await createKnowledge('alice 共享', 'general', 'c', [], 'alice', true);
    await createKnowledge('bob 的', 'general', 'c', [], 'bob', false);
    const aliceOnly = listKnowledge({ owner: 'alice' });
    assert.equal(aliceOnly.total, 2);
    const sharedOnly = listKnowledge({ sharedOnly: true });
    assert.equal(sharedOnly.total, 1);
    assert.equal(sharedOnly.items[0].owner, 'alice');
  });

  it('updateKnowledge: 更新 shared 字段', async () => {
    const e = await createKnowledge('标题', 'general', '内容', [], 'alice', false);
    const updated = await updateKnowledge(e.id, { shared: true });
    assert.equal(updated!.shared, true);
  });

  it('searchKnowledge: owner 偏好 - 不加 owner 时检索全部', async () => {
    await createKnowledge('Docker 网络排障', 'network', '检查 bridge 网络和 DNS 配置');
    await createKnowledge('Compose 文件', 'compose', 'version 与 services 配置');
    const results = await searchKnowledge('网络排障', 5);
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.title.includes('网络排障')));
  });

  it('searchKnowledge: owner 过滤 - 只搜自己的 + 他人共享的', async () => {
    await createKnowledge('alice 私有', 'general', 'docker bridge 配置', [], 'alice', false);
    await createKnowledge('bob 共享', 'general', 'docker bridge 配置', [], 'bob', true);
    await createKnowledge('charlie 私有', 'general', 'docker bridge 配置', [], 'charlie', false);
    const results = await searchKnowledge('bridge 配置', 5, 'alice');
    // alice 应能看到自己的 + bob 共享的，但不能看到 charlie 的私有
    assert.ok(results.some((r) => r.title === 'alice 私有'));
    assert.ok(results.some((r) => r.title === 'bob 共享'));
    assert.ok(!results.some((r) => r.title === 'charlie 私有'));
  });

  it('autoInitKnowledge: 空库时初始化预置知识', async () => {
    const { getDb } = require('../src/storage');
    getDb().exec('DELETE FROM ai_knowledge');
    const count = await autoInitKnowledge('admin');
    assert.ok(count > 0);
    // 预置知识标记为共享，所有用户可见
    const sharedOnly = listKnowledge({ sharedOnly: true });
    assert.equal(sharedOnly.total, count);
    // 再次调用应返回 0（库非空）
    const again = await autoInitKnowledge('admin');
    assert.equal(again, 0);
  });
});
