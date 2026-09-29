// 全文检索仓储测试。
// 核心是中文：SQLite 的 unicode61 分词器无法索引中文（实测整串与子串均查不到），
// 这里验证 bigram 折叠方案确实让中文子串检索可用（docs/design.md §6.5）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import {
  indexEntity, removeEntity, search, countIndexed, rebuildIndex, docRowId,
} from '../src/core/repo/searchRepo.ts';

function seed(database: Parameters<typeof indexEntity>[0]): void {
  indexEntity(database, { entityType: 'task', entityId: 't1', title: '接口文档给张三', body: '本周完成' });
  indexEntity(database, { entityType: 'task', entityId: 't2', title: 'data platform migration', body: 'Q3 goal' });
  indexEntity(database, { entityType: 'task', entityId: 't3', title: '整理Q3数据平台迁移方案', body: '含评估' });
  indexEntity(database, { entityType: 'archive', entityId: 'a1', title: '会议纪要：与法务确认合同条款', body: '' });
  indexEntity(database, { entityType: 'inbox', entityId: 'i1', title: '', body: '看不见的问题排查' });
}

test('中文整串与子串都能命中', () => {
  useDb((database) => {
    seed(database);
    assert.deepEqual(search(database, '接口文档').map((hit) => hit.entityId), ['t1'], '中文整串');
    assert.deepEqual(search(database, '文档').map((hit) => hit.entityId), ['t1'], '中文子串');
    assert.deepEqual(search(database, '给张').map((hit) => hit.entityId), ['t1'], '中文中间片段');
    assert.deepEqual(search(database, '张三').map((hit) => hit.entityId), ['t1'], '中文人名');
    assert.deepEqual(search(database, '数据平台').map((hit) => hit.entityId), ['t3'], '跨词子串');
  });
});

test('英文检索大小写不敏感，支持多词', () => {
  useDb((database) => {
    seed(database);
    assert.deepEqual(search(database, 'data').map((hit) => hit.entityId), ['t2']);
    assert.deepEqual(search(database, 'DATA').map((hit) => hit.entityId), ['t2']);
    assert.deepEqual(search(database, 'platform migration').map((hit) => hit.entityId), ['t2']);
  });
});

test('中英混合与字母数字混合', () => {
  useDb((database) => {
    seed(database);
    assert.ok(search(database, 'Q3').some((hit) => hit.entityId === 't2'));
    assert.ok(search(database, 'Q3').some((hit) => hit.entityId === 't3'));
    assert.deepEqual(search(database, '迁移').map((hit) => hit.entityId), ['t3']);
  });
});

test('单字中文查询退化为 LIKE 仍能命中', () => {
  useDb((database) => {
    seed(database);
    const hits = search(database, '法');
    assert.deepEqual(hits.map((hit) => hit.entityId), ['a1'], '单字无法走 bigram，必须能靠退路命中');
  });
});

test('body 也参与检索，不只是标题', () => {
  useDb((database) => {
    seed(database);
    assert.deepEqual(search(database, '评估').map((hit) => hit.entityId), ['t3'], '命中 body');
    assert.deepEqual(search(database, '看不见').map((hit) => hit.entityId), ['i1'], '标题为空的条目靠 body 命中');
  });
});

test('空查询与纯空白返回空结果，不报错', () => {
  useDb((database) => {
    seed(database);
    assert.deepEqual(search(database, ''), []);
    assert.deepEqual(search(database, '   '), []);
  });
});

test('可按实体类型过滤', () => {
  useDb((database) => {
    seed(database);
    const all = search(database, '确认');
    assert.deepEqual(all.map((hit) => hit.entityType), ['archive']);

    assert.equal(search(database, '确认', { types: ['task'] }).length, 0);
    assert.equal(search(database, '确认', { types: ['archive'] }).length, 1);
  });
});

test('结果按实体优先级排序：任务优先于资料与收件箱', () => {
  useDb((database) => {
    indexEntity(database, { entityType: 'inbox', entityId: 'i9', title: '合同条款待确认', body: '' });
    indexEntity(database, { entityType: 'archive', entityId: 'a9', title: '合同条款纪要', body: '' });
    indexEntity(database, { entityType: 'task', entityId: 't9', title: '合同条款确认', body: '' });

    const types = search(database, '合同条款').map((hit) => hit.entityType);
    assert.deepEqual(types, ['task', 'archive', 'inbox']);
  });
});

test('重复索引同一条目是更新而不是新增', () => {
  useDb((database) => {
    indexEntity(database, { entityType: 'task', entityId: 't1', title: '旧标题' });
    indexEntity(database, { entityType: 'task', entityId: 't1', title: '新标题' });

    assert.equal(countIndexed(database), 1, '不应产生重复条目');
    assert.equal(search(database, '旧标题').length, 0, '旧内容应已被替换');
    assert.deepEqual(search(database, '新标题').map((hit) => hit.entityId), ['t1']);
  });
});

test('删除索引后不再命中', () => {
  useDb((database) => {
    seed(database);
    assert.equal(search(database, '接口文档').length, 1);
    removeEntity(database, 'task', 't1');
    assert.equal(search(database, '接口文档').length, 0);
    assert.equal(countIndexed(database), 4);
  });
});

test('rowid 由实体身份稳定推导', () => {
  useDb((database) => {
    const first = docRowId('task', 'abc');
    assert.equal(docRowId('task', 'abc'), first, '同身份必须得到同 rowid');
    assert.notEqual(docRowId('task', 'abc'), docRowId('archive', 'abc'), '不同类型应区分');
    assert.notEqual(docRowId('task', 'abc'), docRowId('task', 'abd'));
    assert.ok(first >= 0, 'FTS5 不接受负 rowid');
    assert.ok(Number.isInteger(first));
  });
});

test('重建索引可从零恢复', () => {
  useDb((database) => {
    seed(database);
    const before = countIndexed(database);
    assert.equal(before, 5);

    const rebuilt = rebuildIndex(database, () => [
      { entityType: 'task', entityId: 'x1', title: '重来的任务' },
      { entityType: 'task', entityId: 'x2', title: '另一个任务' },
    ]);
    assert.equal(rebuilt, 2);
    assert.equal(countIndexed(database), 2, '旧索引应被清空');
    assert.equal(search(database, '接口文档').length, 0);
    assert.deepEqual(search(database, '重来的任务').map((hit) => hit.entityId), ['x1']);
  });
});

test('大量数据下中文检索仍然可用', () => {
  useDb((database) => {
    for (let i = 0; i < 500; i += 1) {
      indexEntity(database, {
        entityType: 'task',
        entityId: `bulk${i}`,
        title: `任务${i} 关于数据平台迁移的第${i}项工作`,
      });
    }
    const hits = search(database, '数据平台', { limit: 5 });
    assert.equal(hits.length, 5, '应能命中并受 limit 限制');
    assert.equal(search(database, '不存在的词').length, 0);
  });
});
