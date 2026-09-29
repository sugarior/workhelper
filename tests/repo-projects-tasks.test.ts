// 项目与任务仓储测试：CRUD、软删除、排序、过滤、统计、自检查询。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import {
  createProject, getProject, listProjects, updateProject, deleteProject,
  reorderProject, projectTaskCounts, detachTasks,
} from '../src/core/repo/projectRepo.ts';
import {
  createTask, getTask, listTasks, listTasksByStatuses, updateTask, deleteTask,
  reorderTask, OPEN_TASK_STATUSES, findBlockedWithoutReason, findDoneWithoutTimestamp,
  listTasksCompletedBetween, listTasksCreatedBetween, setPlannedFor, applyStatus, countByProject,
} from '../src/core/repo/taskRepo.ts';
import { NotFoundError } from '../src/core/domain/errors.ts';

test('项目：创建并读回，默认值正确', () => {
  useDb((database) => {
    const project = createProject(database, { title: 'Q3 数据平台迁移', goal: '完成迁移' });
    assert.equal(project.title, 'Q3 数据平台迁移');
    assert.equal(project.status, 'active');
    assert.equal(project.priority, 'normal');
    assert.equal(project.goal, '完成迁移');
    assert.equal(project.deletedAt, null);
    assert.equal(getProject(database, project.id)?.id, project.id);
  });
});

test('项目：更新只改传入字段', () => {
  useDb((database) => {
    const project = createProject(database, { title: '原名', goal: '原目标' });
    const updated = updateProject(database, project.id, { title: '新名' });
    assert.equal(updated.title, '新名');
    assert.equal(updated.goal, '原目标', '未传的字段不应被清空');
  });
});

test('项目：软删除后查不到，且可被回收站恢复', async () => {
  const { listTrash, restore } = await import('../src/core/repo/trashRepo.ts');
  useDb((database) => {
    const project = createProject(database, { title: '待删除' });
    deleteProject(database, project.id);
    assert.equal(getProject(database, project.id), undefined);
    assert.equal(listProjects(database).length, 0);

    const trashed = listTrash(database);
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0]?.entityType, 'project');
    assert.equal(trashed[0]?.title, '待删除');

    restore(database, 'project', project.id);
    assert.equal(getProject(database, project.id)?.id, project.id);
  });
});

test('项目：删除不存在的记录报 NotFoundError', () => {
  useDb((database) => {
    assert.throws(() => deleteProject(database, 'nope'), NotFoundError);
  });
});

test('项目：拖拽排序把目标插到参照项之前', () => {
  useDb((database) => {
    const first = createProject(database, { title: 'A' });
    const second = createProject(database, { title: 'B' });
    const third = createProject(database, { title: 'C' });
    assert.deepEqual(listProjects(database).map((item) => item.title), ['A', 'B', 'C']);

    // 把 A 拖到 C 之前 → B, A, C
    reorderProject(database, first.id, third.id);
    assert.deepEqual(listProjects(database).map((item) => item.title), ['B', 'A', 'C']);

    // 把 A 拖到末尾 → B, C, A
    reorderProject(database, first.id, null);
    assert.deepEqual(listProjects(database).map((item) => item.title), ['B', 'C', 'A']);

    // 把 A 拖到最前 → A, B, C
    reorderProject(database, first.id, second.id);
    assert.deepEqual(listProjects(database).map((item) => item.title), ['A', 'B', 'C']);
  });
});

test('项目：任务统计与解绑', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const taskA = createTask(database, { title: '任务A', projectId: project.id });
    createTask(database, { title: '任务B', projectId: project.id });
    applyStatus(database, taskA.id, 'done', { completedAt: '2026-09-30T00:00:00.000Z' });

    assert.deepEqual(projectTaskCounts(database, project.id), { total: 2, done: 1 });
    assert.equal(countByProject(database, project.id), 2);

    const detached = detachTasks(database, project.id);
    assert.equal(detached, 2);
    assert.deepEqual(projectTaskCounts(database, project.id), { total: 0, done: 0 });
    assert.equal(getTask(database, taskA.id)?.projectId, null, '任务本身应保留');
  });
});

test('任务：创建并读回全部字段', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const task = createTask(database, {
      title: '交接口文档',
      projectId: project.id,
      detail: '含鉴权说明',
      priority: 'high',
      dueDate: '2026-10-07',
      estimateMinutes: 90,
    });
    assert.equal(task.status, 'todo');
    assert.equal(task.priority, 'high');
    assert.equal(task.dueDate, '2026-10-07');
    assert.equal(task.estimateMinutes, 90);
    assert.equal(task.blockedReason, null);
    assert.equal(task.completedAt, null);
    assert.equal(task.projectId, project.id);
  });
});

test('任务：按项目、状态、今日、截止过滤', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const a = createTask(database, { title: 'A', projectId: project.id, dueDate: '2026-09-25' });
    createTask(database, { title: 'B', dueDate: '2026-09-30' });
    createTask(database, { title: 'C', dueDate: '2026-12-31' });

    assert.equal(listTasks(database, { projectId: project.id }).length, 1);
    assert.equal(listTasks(database, { projectId: null }).length, 2);
    assert.equal(listTasks(database, { dueOn: '2026-09-30' }).length, 1);
    assert.equal(listTasks(database, { dueOnOrBefore: '2026-09-30' }).length, 2);

    setPlannedFor(database, a.id, '2026-09-30');
    assert.equal(listTasks(database, { plannedFor: '2026-09-30' }).length, 1);

    applyStatus(database, a.id, 'done', { completedAt: '2026-09-30T01:00:00.000Z' });
    assert.equal(listTasks(database, { status: 'done' }).length, 1);
    assert.equal(listTasksByStatuses(database, OPEN_TASK_STATUSES).some((task) => task.title === 'A'), false);
  });
});

test('任务：完成时间戳由调用方注入，仓储不自行决定', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const stamped = applyStatus(database, task.id, 'done', { completedAt: '2026-09-30T01:00:00.000Z' });
    assert.equal(stamped.completedAt, '2026-09-30T01:00:00.000Z');
    assert.equal(stamped.status, 'done');

    const reopened = applyStatus(database, task.id, 'doing', { completedAt: null });
    assert.equal(reopened.completedAt, null, '离开完成态应清除水印');
  });
});

test('任务：时间区间查询用于每日汇总', () => {
  useDb((database) => {
    const done = createTask(database, { title: '今天完成' });
    const later = createTask(database, { title: '明天完成' });
    applyStatus(database, done.id, 'done', { completedAt: '2026-09-29T05:00:00.000Z' });
    applyStatus(database, later.id, 'done', { completedAt: '2026-09-30T05:00:00.000Z' });

    const completed = listTasksCompletedBetween(database, '2026-09-29T04:00:00.000Z', '2026-09-30T04:00:00.000Z');
    assert.deepEqual(completed.map((item) => item.title), ['今天完成']);

    const created = listTasksCreatedBetween(database, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    assert.equal(created.length, 2);
  });
});

test('任务：拖拽排序只在同一项目内进行', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const a = createTask(database, { title: 'A', projectId: project.id });
    const b = createTask(database, { title: 'B', projectId: project.id });
    const loose = createTask(database, { title: '游离' });
    assert.deepEqual(listTasks(database, { projectId: project.id }).map((task) => task.title), ['A', 'B']);

    // 把 B 拖到 A 之前
    reorderTask(database, b.id, a.id);
    assert.deepEqual(listTasks(database, { projectId: project.id }).map((task) => task.title), ['B', 'A']);

    // 无项目任务的排序不影响项目内任务
    assert.equal(getTask(database, loose.id)?.title, '游离');
    assert.deepEqual(listTasks(database, { projectId: null }).map((task) => task.title), ['游离']);
  });
});

test('任务：软删除后不再出现', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    deleteTask(database, task.id);
    assert.equal(getTask(database, task.id), undefined);
    assert.equal(listTasks(database).length, 0);
  });
});

test('任务：自检查询能找出状态与字段不一致的数据', () => {
  useDb((database) => {
    const blocked = createTask(database, { title: '卡住的' });
    applyStatus(database, blocked.id, 'blocked');
    const bad = findBlockedWithoutReason(database);
    assert.deepEqual(bad.map((task) => task.title), ['卡住的'], '阻塞但无原因应被查出');

    updateTask(database, blocked.id, { blockedReason: '等法务' });
    assert.equal(findBlockedWithoutReason(database).length, 0);

    const done = createTask(database, { title: '已完成但无时间' });
    applyStatus(database, done.id, 'done');
    assert.deepEqual(findDoneWithoutTimestamp(database).map((task) => task.title), ['已完成但无时间']);
  });
});

test('任务：项目被软删除后任务仍可访问', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const task = createTask(database, { title: '任务', projectId: project.id });
    deleteProject(database, project.id);
    assert.equal(getTask(database, task.id)?.title, '任务', '删项目不应连带隐藏任务');
  });
});
