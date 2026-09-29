// 收件箱与资料归档仓储测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import {
  createInboxItem, getInboxItem, listPendingInbox, countPendingInbox,
  markConverted, archiveInboxItem, deleteInboxItem,
} from '../src/core/repo/inboxRepo.ts';
import {
  createArchive, getArchive, listArchives, updateArchive, deleteArchive, listArchivesCreatedBetween,
} from '../src/core/repo/archiveRepo.ts';
import { createProject } from '../src/core/repo/projectRepo.ts';
import { createTask } from '../src/core/repo/taskRepo.ts';
import { NotFoundError } from '../src/core/domain/errors.ts';

test('收件箱：快记只需一句文本，默认进待处理', () => {
  useDb((database) => {
    const item = createInboxItem(database, { body: '接口文档 下周三 给张三', parsedDue: '2026-10-07' });
    assert.equal(item.status, 'pending');
    assert.equal(item.parsedDue, '2026-10-07');
    assert.equal(item.kindHint, null);
    assert.equal(item.convertedTo, null);
    assert.equal(countPendingInbox(database), 1);
  });
});

test('收件箱：类型提示可选，取值受约束', () => {
  useDb((database) => {
    const todo = createInboxItem(database, { body: '要做的事', kindHint: 'todo' });
    const note = createInboxItem(database, { body: '一条信息', kindHint: 'note' });
    assert.equal(todo.kindHint, 'todo');
    assert.equal(note.kindHint, 'note');
    assert.throws(
      () => createInboxItem(database, { body: '非法', kindHint: 'nonsense' as never }),
      /CHECK constraint failed/i,
    );
  });
});

test('收件箱：待处理列表按创建时间倒序，不含已处理', () => {
  useDb((database) => {
    const first = createInboxItem(database, { body: '第一条' });
    const second = createInboxItem(database, { body: '第二条' });
    createInboxItem(database, { body: '第三条' });

    // 同一毫秒内连续写入时 created_at 相同，因此顺序由 rowid 兜底：
    // 后写入的 rowid 更大，排更前。列表顺序必须稳定可预期。
    assert.deepEqual(listPendingInbox(database).map((item) => item.body), ['第三条', '第二条', '第一条']);
    // 重复查询必须得到同一顺序（稳定性）
    assert.deepEqual(listPendingInbox(database).map((item) => item.body), ['第三条', '第二条', '第一条']);

    archiveInboxItem(database, second.id);
    assert.deepEqual(listPendingInbox(database).map((item) => item.body), ['第三条', '第一条']);
    assert.equal(countPendingInbox(database), 2);
    assert.equal(getInboxItem(database, first.id)?.status, 'pending');
  });
});

test('收件箱：分类后记录去向，可回溯这条碎片变成了什么', () => {
  useDb((database) => {
    const item = createInboxItem(database, { body: '交接口文档' });
    const task = createTask(database, { title: '交接口文档', sourceInboxId: item.id });

    const converted = markConverted(database, item.id, `task:${task.id}`);
    assert.equal(converted.status, 'converted');
    assert.equal(converted.convertedTo, `task:${task.id}`);
    assert.equal(countPendingInbox(database), 0);

    const created = database
      .prepare('SELECT source_inbox_id FROM tasks WHERE id = ?')
      .get(task.id) as { source_inbox_id: string } | undefined;
    assert.equal(created?.source_inbox_id, item.id, '任务应保留来源，形成双向回溯');
  });
});

test('收件箱：丢弃与软删除是两回事', () => {
  useDb((database) => {
    const discarded = createInboxItem(database, { body: '垃圾信息' });
    archiveInboxItem(database, discarded.id);
    assert.equal(getInboxItem(database, discarded.id)?.status, 'archived', '丢弃后仍可查到，只是不再待处理');

    const mistaken = createInboxItem(database, { body: '误录' });
    deleteInboxItem(database, mistaken.id);
    assert.equal(getInboxItem(database, mistaken.id), undefined, '软删除后不可见');
  });
});

test('收件箱：操作不存在的条目报 NotFoundError', () => {
  useDb((database) => {
    assert.throws(() => markConverted(database, 'nope', 'task:x'), NotFoundError);
    assert.throws(() => archiveInboxItem(database, 'nope'), NotFoundError);
    assert.throws(() => deleteInboxItem(database, 'nope'), NotFoundError);
  });
});

test('收件箱：批量清空后计数归零', () => {
  useDb((database) => {
    const ids = ['一', '二', '三', '四', '五'].map((body) => createInboxItem(database, { body }).id);
    assert.equal(countPendingInbox(database), 5);
    for (const id of ids) archiveInboxItem(database, id);
    assert.equal(countPendingInbox(database), 0);
    assert.equal(listPendingInbox(database).length, 0);
  });
});

test('资料：创建并关联到项目/任务，也可游离', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const task = createTask(database, { title: '任务' });

    const meeting = createArchive(database, {
      kind: 'meeting',
      title: '与法务确认合同条款',
      body: '结论：需要补充附件三',
      taskId: task.id,
      dayKey: '2026-09-30',
    });
    assert.equal(meeting.kind, 'meeting');
    assert.equal(meeting.taskId, task.id);

    const link = createArchive(database, { kind: 'link', title: '参考资料', url: 'https://example.com/x' });
    assert.equal(link.url, 'https://example.com/x');
    assert.equal(link.taskId, null);

    assert.equal(listArchives(database, { taskId: task.id }).length, 1);
    assert.equal(listArchives(database, { dayKey: '2026-09-30' }).length, 1);
    assert.equal(listArchives(database).length, 2);
    assert.equal(updateArchive(database, link.id, { projectId: project.id }).projectId, project.id);
  });
});

test('资料：按时间区间查询用于每日汇总', () => {
  useDb((database) => {
    createArchive(database, { kind: 'note', title: '今天记的' });
    const found = listArchivesCreatedBetween(database, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    assert.deepEqual(found.map((item) => item.title), ['今天记的']);
    assert.equal(listArchivesCreatedBetween(database, '2100-01-01T00:00:00.000Z', '2101-01-01T00:00:00.000Z').length, 0);
  });
});

test('资料：删除后不可见', () => {
  useDb((database) => {
    const item = createArchive(database, { kind: 'note', body: '随手记' });
    deleteArchive(database, item.id);
    assert.equal(getArchive(database, item.id), undefined);
    assert.equal(listArchives(database).length, 0);
  });
});
