// 焦点（当前任务）与「记一笔」的测试（需求 §5.2.1 / F-15b / F-15c）。
//
// 焦点是"我现在正在推进这一件"，因此它的关键性质是**唯一**与**不贬值**：
//   · 全库最多一条（数据库层部分唯一索引保证）
//   · 只能落在 doing 上（服务层校验；todo 会先自动转 doing）
//   · 离开 doing 就掉（完成 / 卡住 / 放弃）
//   · 每日日界惰性清空（不用后台定时器）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, useDbWithCalendarDay, dayKeyNow } from './helpers/db.ts';
import { createPlanningService } from '../src/core/service/planningService.ts';
import { createTrackingService } from '../src/core/service/trackingService.ts';
import { createTask, findFocusedTask, getTask, listTasks } from '../src/core/repo/taskRepo.ts';
import { setDayBoundaryHour } from '../src/core/repo/settingsRepo.ts';
import { addDaysToKey } from '../src/core/day/dayKey.ts';
import { InvalidTransitionError } from '../src/core/domain/errors.ts';

test('焦点：聚焦 todo 任务会自动转进行中，且焦点落在它上面', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '写迁移方案' });
    assert.equal(task.status, 'todo');

    const focused = tracking.focusTask(task.id);
    // 焦点只能落在 doing 上，因此聚焦 todo 时顺带把它变成进行中 —— 一步完成
    assert.equal(focused.status, 'doing', '聚焦应自动先转进行中');
    assert.ok(focused.focusedAt !== null);
    assert.equal(tracking.focus()?.id, task.id);
  });
});

test('焦点：全库唯一 —— 聚焦第二条会顶掉第一条', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const a = planning.createTask({ title: '甲' });
    const b = planning.createTask({ title: '乙' });

    tracking.focusTask(a.id);
    tracking.focusTask(b.id);

    assert.equal(tracking.focus()?.id, b.id, '焦点应换到乙');
    // 甲仍在进行中，只是脱离了焦点 —— 这就是"暂时搁置"，不需要"暂停"状态
    assert.equal(getTask(database, a.id)?.status, 'doing');
    assert.equal(getTask(database, a.id)?.focusedAt, null, '旧焦点必须被清掉');
    assert.equal(listTasks(database).filter((t) => t.focusedAt !== null).length, 1);
  });
});

test('焦点：数据库层强制唯一（部分唯一索引不允许两行有焦点）', () => {
  useDb((database) => {
    const a = createTask(database, { title: '甲' });
    const b = createTask(database, { title: '乙' });

    database.prepare('UPDATE tasks SET focused_at = ? WHERE id = ?').run('2026-09-30T00:00:00.000Z', a.id);
    // 绕过仓储层直接写第二行，必须被索引拒绝 —— 这是"服务层自觉"之外的兜底
    assert.throws(
      () => database.prepare('UPDATE tasks SET focused_at = ? WHERE id = ?').run('2026-09-30T00:00:00.000Z', b.id),
      /UNIQUE constraint failed/,
    );
  });
});

test('焦点：任务完成时自动清除（静默）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);

    tracking.completeTask(task.id);
    assert.equal(tracking.focus(), null, '完成后焦点应消失');
    assert.equal(getTask(database, task.id)?.focusedAt, null);
    // 静默：不抛错、不产生额外记录
    assert.equal(tracking.taskTimeline(task.id).length, 0);
  });
});

test('焦点：任务转卡住时自动清除，且卡点记录仍然留下', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);

    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'blocker', body: '等 DBA 给窗口' });
    assert.equal(getTask(database, task.id)?.status, 'blocked');
    assert.equal(tracking.focus(), null, '卡住后焦点应消失（焦点只在 doing 上）');
    assert.equal(tracking.taskTimeline(task.id).length, 1, '卡点记录不能被清焦点一起带走');
  });
});

test('焦点：任务被放弃（取消）时自动清除', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);

    planning.setTaskStatus(task.id, 'cancelled');
    assert.equal(tracking.focus(), null);
  });
});

test('焦点：卡住的任务不能聚焦（保证焦点不贬值）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'doing');
    planning.setTaskStatus(task.id, 'blocked', { blockedReason: '等回复' });

    assert.throws(() => tracking.focusTask(task.id), /只有「进行中」的任务才能聚焦/);
    assert.equal(tracking.focus(), null);
  });
});

test('焦点：已完成的任务不能聚焦', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.completeTask(task.id);

    assert.throws(() => tracking.focusTask(task.id), InvalidTransitionError);
  });
});

test('焦点：取消聚焦后任务仍在进行中', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);
    assert.equal(tracking.focus()?.id, task.id);

    tracking.unfocus();
    assert.equal(tracking.focus(), null);
    assert.equal(getTask(database, task.id)?.status, 'doing', '取消焦点不应改变状态');
  });
});

test('焦点：无焦点时取消是幂等的，不报错', () => {
  useDb((database) => {
    const tracking = createTrackingService(database);
    assert.equal(tracking.focus(), null);
    assert.doesNotThrow(() => tracking.unfocus());
    assert.equal(tracking.focus(), null);
  });
});

test('焦点：跨日后惰性清空（不用后台定时器）', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);
    assert.equal(tracking.focus()?.id, task.id);

    // 模拟"昨天聚焦的"：把 focused_day_key 改成前一天
    const yesterday = addDaysToKey(dayKeyNow(database), -1);
    database.prepare('UPDATE tasks SET focused_day_key = ? WHERE id = ?').run(yesterday, task.id);

    assert.equal(tracking.focus(), null, '跨日后应视为无焦点');
    // 顺手清掉，而不是每次读取都判断 —— 下一次读取应直接命中"无焦点"
    assert.equal(findFocusedTask(database), undefined, '惰性清空应落库');
    assert.equal(getTask(database, task.id)?.status, 'doing', '清焦点不改变任务状态');
  });
});

test('记一笔：写到当前焦点任务上', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const focused = planning.createTask({ title: '正在做的' });
    const other = planning.createTask({ title: '没在做的' });
    tracking.focusTask(focused.id);

    const result = tracking.noteOnFocus({ kind: 'progress', body: '已完成初稿' });
    assert.equal(result.task.id, focused.id);
    assert.equal(tracking.taskTimeline(focused.id).length, 1);
    assert.equal(tracking.taskTimeline(other.id).length, 0, '绝不能写到别的任务上');
    assert.equal(tracking.taskTimeline(focused.id)[0]?.body, '已完成初稿');
  });
});

test('记一笔：没有焦点时明确报错，而不是猜一个目标', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '某任务' });

    assert.throws(
      () => tracking.noteOnFocus({ kind: 'progress', body: '随手写' }),
      /当前没有正在做的任务/,
    );
    // 关键：不能因为没焦点就随便挑一条任务写进去
    assert.equal(tracking.taskTimeline(task.id).length, 0, '任何任务都不该收到这条记录');
  });
});

test('记一笔：跨日后没有焦点，同样报错而不是写到旧焦点上', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '昨天在做' });
    tracking.focusTask(task.id);

    database.prepare('UPDATE tasks SET focused_day_key = ? WHERE id = ?')
      .run(addDaysToKey(dayKeyNow(database), -1), task.id);

    assert.throws(() => tracking.noteOnFocus({ kind: 'progress', body: 'x' }), /当前没有正在做的任务/);
    assert.equal(tracking.taskTimeline(task.id).length, 0);
  });
});

test('记一笔：记"卡点"会联动状态并顺带清掉焦点（与任务行内记一笔同一套规则）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);

    const result = tracking.noteOnFocus({ kind: 'blocker', body: '等对方回复' });
    assert.equal(result.task.status, 'blocked');
    assert.equal(result.task.blockedReason, '等对方回复');
    assert.equal(tracking.focus(), null, '卡住后焦点自动掉');
  });
});

test('焦点：日界为 0 点时，跨日判断跟着走', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    setDayBoundaryHour(database, 0);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);
    assert.equal(tracking.focus()?.id, task.id, '当天聚焦应可见');

    database.prepare('UPDATE tasks SET focused_day_key = ? WHERE id = ?')
      .run(addDaysToKey(dayKeyNow(database), -1), task.id);
    assert.equal(tracking.focus(), null);
  });
});
