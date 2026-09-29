// 子任务与进展记录仓储测试。
// 重点：进展记录"恰好挂一个父对象"的约束，以及时间线/今日查询的口径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import {
  createSubtask, getSubtask, listSubtasks, updateSubtask, setSubtaskStatus,
  deleteSubtask, reorderSubtask, countSubtasks, completeAll,
} from '../src/core/repo/subtaskRepo.ts';
import {
  createProgress, getProgress, listProgressForTarget, listProgressForTaskTree,
  listProgressByDay, listProgressBetween, listOpenBlockers, latestBlockerForTask,
  countProgressForTarget, deleteProgress,
} from '../src/core/repo/progressRepo.ts';
import { createProject } from '../src/core/repo/projectRepo.ts';
import { createTask, applyStatus } from '../src/core/repo/taskRepo.ts';
import { translateConstraintError } from '../src/core/db/connection.ts';
import { ConstraintError } from '../src/core/domain/errors.ts';

const NOW = '2026-09-30T02:00:00.000Z';

test('子任务：创建、更新、按任务隔离', () => {
  useDb((database) => {
    const taskA = createTask(database, { title: '任务A' });
    const taskB = createTask(database, { title: '任务B' });
    const sub = createSubtask(database, { taskId: taskA.id, title: '步骤一' });
    createSubtask(database, { taskId: taskB.id, title: '别的步骤' });

    assert.equal(sub.status, 'todo');
    assert.deepEqual(listSubtasks(database, taskA.id).map((item) => item.title), ['步骤一']);
    assert.equal(updateSubtask(database, sub.id, { title: '步骤一改' }).title, '步骤一改');
  });
});

test('子任务：完成时间戳口径与任务一致', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const sub = createSubtask(database, { taskId: task.id, title: '步骤' });

    const done = setSubtaskStatus(database, sub.id, 'done', NOW);
    assert.equal(done.status, 'done');
    assert.equal(done.completedAt, NOW);

    const again = setSubtaskStatus(database, sub.id, 'done', '2026-10-01T00:00:00.000Z');
    assert.equal(again.completedAt, NOW, '重复标记完成应保留首次水印');

    const reopened = setSubtaskStatus(database, sub.id, 'todo', NOW);
    assert.equal(reopened.completedAt, null, '回到未完成应清除水印');
  });
});

test('子任务：排序与完成数统计', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const first = createSubtask(database, { taskId: task.id, title: 'A' });
    const second = createSubtask(database, { taskId: task.id, title: 'B' });
    assert.deepEqual(countSubtasks(database, task.id), { total: 2, done: 0 });

    reorderSubtask(database, second.id, first.id);
    assert.deepEqual(listSubtasks(database, task.id).map((item) => item.title), ['B', 'A']);

    const completed = completeAll(database, task.id, NOW);
    assert.equal(completed, 2);
    assert.deepEqual(countSubtasks(database, task.id), { total: 2, done: 2 });
    assert.equal(completeAll(database, task.id, NOW), 0, '已完成的不应重复计数');
  });
});

test('子任务：删除任务时级联删除子任务', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const sub = createSubtask(database, { taskId: task.id, title: '步骤' });
    deleteSubtask(database, sub.id);
    assert.equal(getSubtask(database, sub.id), undefined);
    assert.equal(listSubtasks(database, task.id).length, 0);
  });
});

test('进展：可挂在三个层级，且各自可查', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const task = createTask(database, { title: '任务', projectId: project.id });
    const sub = createSubtask(database, { taskId: task.id, title: '步骤' });

    createProgress(database, { target: { kind: 'project', id: project.id }, kind: 'decision', body: '立项决定', dayKey: '2026-09-30' });
    createProgress(database, { target: { kind: 'task', id: task.id }, kind: 'progress', body: '任务推进', dayKey: '2026-09-30' });
    createProgress(database, { target: { kind: 'subtask', id: sub.id }, kind: 'progress', body: '步骤完成', dayKey: '2026-09-30' });

    assert.equal(countProgressForTarget(database, { kind: 'project', id: project.id }), 1);
    assert.equal(countProgressForTarget(database, { kind: 'task', id: task.id }), 1);
    assert.equal(countProgressForTarget(database, { kind: 'subtask', id: sub.id }), 1);
  });
});

test('进展：任务时间线包含挂在其子任务上的记录', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const sub = createSubtask(database, { taskId: task.id, title: '步骤' });
    const other = createTask(database, { title: '别的任务' });

    createProgress(database, { target: { kind: 'task', id: task.id }, kind: 'progress', body: '直接挂任务', dayKey: '2026-09-30', occurredAt: '2026-09-30T01:00:00.000Z' });
    createProgress(database, { target: { kind: 'subtask', id: sub.id }, kind: 'progress', body: '挂在子任务', dayKey: '2026-09-30', occurredAt: '2026-09-30T02:00:00.000Z' });
    createProgress(database, { target: { kind: 'task', id: other.id }, kind: 'progress', body: '别的任务', dayKey: '2026-09-30' });

    const timeline = listProgressForTaskTree(database, task.id).map((entry) => entry.body);
    assert.deepEqual(timeline, ['挂在子任务', '直接挂任务'], '最新的在前，且含子任务记录');
  });
});

test('进展：按日键与按时间区间两种查询口径', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    // 补录：真实时刻在前一天，但归属今天
    createProgress(database, {
      target: { kind: 'task', id: task.id },
      kind: 'progress',
      body: '补录昨天的进展',
      dayKey: '2026-09-30',
      occurredAt: '2026-09-29T10:00:00.000Z',
    });

    const byDay = listProgressByDay(database, '2026-09-30');
    assert.equal(byDay.length, 1, '按日键应能找到补录记录');

    const byTime = listProgressBetween(database, '2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    assert.equal(byTime.length, 0, '按真实时刻不在该区间');

    const byTimeYesterday = listProgressBetween(database, '2026-09-29T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    assert.equal(byTimeYesterday.length, 1);
  });
});

test('进展：卡点与未解除卡点查询', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    createProgress(database, { target: { kind: 'task', id: task.id }, kind: 'blocker', body: '等法务确认', dayKey: '2026-09-30' });

    assert.equal(listOpenBlockers(database).length, 0, '任务还没标记为阻塞时不算未解除卡点');

    applyStatus(database, task.id, 'blocked', { blockedReason: '等法务确认' });
    const open = listOpenBlockers(database);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.body, '等法务确认');

    assert.equal(latestBlockerForTask(database, task.id)?.body, '等法务确认');

    applyStatus(database, task.id, 'doing', { blockedReason: null });
    assert.equal(listOpenBlockers(database).length, 0, '解除阻塞后不再是未解除卡点');
  });
});

test('进展：删除父对象会级联删除其进展记录', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const entry = createProgress(database, {
      target: { kind: 'task', id: task.id },
      kind: 'progress',
      body: '推进',
      dayKey: '2026-09-30',
    });

    // 软删除任务不影响进展记录（软删除不触发级联）
    applyStatus(database, task.id, 'done', { completedAt: NOW });
    assert.equal(getProgress(database, entry.id)?.body, '推进');

    // 物理删除任务才级联
    database.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    assert.equal(getProgress(database, entry.id), undefined);
  });
});

test('进展：删除了不存在的记录报错', () => {
  useDb((database) => {
    assert.throws(() => deleteProgress(database, 'nope'));
  });
});

test('进展：数据库约束拒绝挂多个父对象', () => {
  useDb((database) => {
    const project = createProject(database, { title: '项目' });
    const task = createTask(database, { title: '任务' });
    // 绕过仓储直接插入，验证 CHECK 约束确实在数据库层生效
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO progress_entries (id, project_id, task_id, kind, body, day_key, occurred_at, created_at, updated_at)
             VALUES (?, ?, ?, 'progress', 'x', '2026-09-30', ?, ?, ?)`,
          )
          .run('bad', project.id, task.id, NOW, NOW, NOW),
      /CHECK constraint failed/i,
    );
  });
});

test('进展：约束错误被翻译成领域错误', () => {
  useDb((database) => {
    let caught: unknown;
    try {
      // 三列外键全空，触发 CHECK 约束
      database
        .prepare(
          `INSERT INTO progress_entries (id, kind, body, day_key, occurred_at, created_at, updated_at)
           VALUES (?, 'progress', 'x', '2026-09-30', ?, ?, ?)`,
        )
        .run('bad', NOW, NOW, NOW);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== undefined, '该插入本应失败');
    assert.throws(
      () => translateConstraintError(caught, '写入进展记录失败'),
      (error: unknown) => {
        assert.ok(error instanceof ConstraintError);
        assert.equal(error.code, 'CONSTRAINT');
        assert.match(error.message, /写入进展记录失败/);
        return true;
      },
    );
  });
});

test('非约束类错误原样抛出，不被误翻译', () => {
  useDb(() => {
    const plain = new Error('普通错误');
    assert.throws(() => translateConstraintError(plain, '不该翻译'), /普通错误/);
  });
});
