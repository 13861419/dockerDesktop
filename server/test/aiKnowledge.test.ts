import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge, updateKnowledge, deleteKnowledge, getKnowledge, listKnowledge, getKnowledgeStats } from '../src/aiKnowledge';

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
});
