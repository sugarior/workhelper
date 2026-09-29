// 回收站测试：查看、恢复、到期清理、彻底删除。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import {
  listTrash, countTrash, restore, purgeExpired, purgeOne,
  TRASH_RETENTION_DAYS, assertTrashRetentionDays,
} from '../src/core/repo/trashRepo.ts';
import { createProject, getProject, deleteProject } from '../src/core/repo/projectRepo.ts';
import { createTask, getTask, deleteTask } from '../src/core/repo/taskRepo.ts';
import { createInboxItem, deleteInboxItem, getInboxItem } from '../src/core/repo/inboxRepo.ts';
import { NotFoundError, ValidationError } from '../src/core/domain/errors.ts';

/** 把某张表的某行删除时间改成指定天数前，用于测试到期清理 */
function backdate(database: Parameters<typeof listTrash>[0], table: string, id: string, daysAgo: number): void {
  const stamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(stamp, id);
}

test('回收站：默认容量为 30 天', () => {
  assert.equal(TRASH_RETENTION_DAYS, 30);
  assert.doesNotThrow(() => assertTrashRetentionDays(1));
  assert.throws(() => assertTrashRetentionDays(0), ValidationError);
  assert.throws(() => assertTrashRetentionDays(-1), ValidationError);
});

test('回收站：列出已删除条目并带剩余天数', () => {
  useDb((database) => {
    const project = createProject(database, { title: '被删的项目' });
    const task = createTask(database, { title: '被删的任务' });
    deleteProject(database, project.id);
    deleteTask(database, task.id);

    const entries = listTrash(database);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.daysLeft === TRASH_RETENTION_DAYS));
    assert.equal(countTrash(database), 2);

    const projectEntry = entries.find((entry) => entry.entityType === 'project');
    assert.equal(projectEntry?.label, '项目');
    assert.equal(projectEntry?.title, '被删的项目');
  });
});

test('回收站：删除超过 30 天的条目剩余天数为负', () => {
  useDb((database) => {
    const project = createProject(database, { title: '很久以前删的' });
    deleteProject(database, project.id);
    backdate(database, 'projects', project.id, 40);

    const entry = listTrash(database)[0];
    assert.equal(entry?.daysLeft, TRASH_RETENTION_DAYS - 40);
    assert.ok((entry?.daysLeft ?? 0) < 0, '已过期应显示负数');
  });
});

test('回收站：恢复后重新可见', () => {
  useDb((database) => {
    const task = createTask(database, { title: '误删的任务' });
    deleteTask(database, task.id);
    assert.equal(getTask(database, task.id), undefined);

    restore(database, 'task', task.id);
    assert.equal(getTask(database, task.id)?.title, '误删的任务');
    assert.equal(countTrash(database), 0, '恢复后不应再出现在回收站');
  });
});

test('回收站：恢复不存在的记录报 NotFoundError', () => {
  useDb((database) => {
    assert.throws(() => restore(database, 'task', 'nope'), NotFoundError);
  });
});

test('回收站：恢复未删除的记录会被拒绝', () => {
  useDb((database) => {
    const task = createTask(database, { title: '还活着的任务' });
    assert.throws(() => restore(database, 'task', task.id), NotFoundError, '未删除的记录不在回收站里');
  });
});

test('回收站：到期清理只删过期的，保留未过期的', () => {
  useDb((database) => {
    const expired = createProject(database, { title: '过期' });
    const fresh = createProject(database, { title: '刚删' });
    deleteProject(database, expired.id);
    deleteProject(database, fresh.id);
    backdate(database, 'projects', expired.id, 31);

    const purged = purgeExpired(database);
    assert.equal(purged.project, 1, '只应清理过期的那一条');

    // 过期的那条被物理删除，无法恢复
    assert.throws(() => restore(database, 'project', expired.id), NotFoundError);
    // 未过期的仍可恢复
    restore(database, 'project', fresh.id);
    assert.equal(getProject(database, fresh.id)?.title, '刚删');
  });
});

test('回收站：清理覆盖多种实体', () => {
  useDb((database) => {
    const task = createTask(database, { title: '过期任务' });
    const inbox = createInboxItem(database, { body: '过期碎片' });
    deleteTask(database, task.id);
    deleteInboxItem(database, inbox.id);
    backdate(database, 'tasks', task.id, 60);
    backdate(database, 'inbox_items', inbox.id, 60);

    const purged = purgeExpired(database);
    assert.equal(purged.task, 1);
    assert.equal(purged.inbox, 1);
    assert.equal(countTrash(database), 0);
    assert.equal(getInboxItem(database, inbox.id), undefined);
  });
});

test('回收站：未删除的记录不会被清理', () => {
  useDb((database) => {
    const alive = createTask(database, { title: '活着的任务' });
    const purged = purgeExpired(database);
    assert.equal(purged.task, 0);
    assert.equal(getTask(database, alive.id)?.title, '活着的任务', '清理不能碰到未删除的记录');
  });
});

test('回收站：彻底删除单条', () => {
  useDb((database) => {
    const task = createTask(database, { title: '要彻底删的' });
    deleteTask(database, task.id);
    purgeOne(database, 'task', task.id);
    assert.equal(countTrash(database), 0);
    assert.throws(() => restore(database, 'task', task.id), NotFoundError);
  });
});

test('回收站：彻底删除未在回收站的记录会被拒绝', () => {
  useDb((database) => {
    const task = createTask(database, { title: '还在用' });
    assert.throws(() => purgeOne(database, 'task', task.id), NotFoundError, '必须先软删除才能彻底删除');
  });
});

test('回收站：物理删除任务会级联带走其子任务与进展', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const sub = database
      .prepare('INSERT INTO subtasks (id, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('sub-1', task.id, '子任务', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    assert.ok(sub.changes === 1);

    deleteTask(database, task.id);
    backdate(database, 'tasks', task.id, 60);
    purgeExpired(database);

    const left = database.prepare('SELECT COUNT(*) AS c FROM subtasks').get() as { c: number };
    assert.equal(Number(left.c), 0, '父对象物理删除后子任务应被级联清除');
  });
});
