/**
 * 标签体系单元测试：聚合函数 accumulate 的累加与去重逻辑
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, LabelAggregate } from '../src/routes/labels';

describe('labels accumulate', () => {
  it('空标签对象不产生任何聚合项', () => {
    const map = new Map<string, LabelAggregate>();
    accumulate(undefined, 'container', map);
    accumulate(null, 'container', map);
    accumulate({}, 'container', map);
    assert.equal(map.size, 0);
  });

  it('同一标签跨资源类型累加计数', () => {
    const map = new Map<string, LabelAggregate>();
    accumulate({ env: 'prod' }, 'container', map);
    accumulate({ env: 'prod' }, 'container', map);
    accumulate({ env: 'prod' }, 'volume', map);
    accumulate({ env: 'prod' }, 'image', map);
    const item = map.get('env=prod');
    assert.ok(item);
    assert.equal(item!.count, 4);
    assert.equal(item!.kinds.container, 2);
    assert.equal(item!.kinds.volume, 1);
    assert.equal(item!.kinds.image, 1);
  });

  it('不同 value 生成不同聚合项', () => {
    const map = new Map<string, LabelAggregate>();
    accumulate({ tier: 'web' }, 'container', map);
    accumulate({ tier: 'db' }, 'container', map);
    assert.equal(map.size, 2);
    assert.equal(map.get('tier=web')!.count, 1);
    assert.equal(map.get('tier=db')!.count, 1);
  });

  it('value 为 null 时归一化为空字符串', () => {
    const map = new Map<string, LabelAggregate>();
    accumulate({ keep: null as unknown as string }, 'container', map);
    const item = map.get('keep=');
    assert.ok(item);
    assert.equal(item!.value, '');
  });
});
