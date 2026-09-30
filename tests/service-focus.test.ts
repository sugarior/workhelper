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

test('焦点候选：只列今日排期（排入今日 / 截止日≤今天），避免列表过长', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = dayKeyNow(database);

    // 今日到期 → 列
    const dueToday = planning.createTask({ title: '今天到期', dueDate: today });
    // 逾期未完成 → 列（与「今日」视图口径一致）
    const overdue = planning.createTask({ title: '已逾期', dueDate: addDaysToKey(today, -3) });
    // 手工排入今日 → 列
    const planned = planning.createTask({ title: '排入今日' });
    tracking.addToToday(planned.id, today);
    // 未来到期 → 不列
    planning.createTask({ title: '下周到期', dueDate: addDaysToKey(today, 7) });
    // 无日期无排期 → 不列
    planning.createTask({ title: '没有排期' });

    const titles = tracking.focusCandidates().map((c) => c.title);
    assert.deepEqual(titles.sort(), ['今天到期', '已逾期', '排入今日'].sort());
    assert.equal(titles.includes('下周到期'), false, '未来到期的任务不该出现，否则列表会长到没法用');
    assert.equal(titles.includes('没有排期'), false);
    void dueToday;
    void overdue;
  });
});

test('焦点候选：当前焦点即使不在今日排期里也保留（否则无法从它切走）', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = dayKeyNow(database);

    // 一条没有排期也没有截止日的任务被聚焦
    const focused = planning.createTask({ title: '没排期的焦点' });
    tracking.focusTask(focused.id);
    planning.createTask({ title: '今天到期的', dueDate: today });

    const titles = tracking.focusCandidates().map((c) => c.title);
    assert.ok(titles.includes('没排期的焦点'), '当前焦点必须始终可见，否则用户卡在它上面出不来');
    assert.equal(titles[0], '没排期的焦点', '焦点排最前');
    assert.ok(titles.includes('今天到期的'));
  });
});

test('焦点候选：当前焦点排在最前（打开切换器先看到"我现在这条"）', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = dayKeyNow(database);

    planning.createTask({ title: '甲', dueDate: today });
    const other = planning.createTask({ title: '乙', dueDate: today });
    planning.setTaskStatus(other.id, 'doing'); // 先进进行中，但焦点在丙
    const target = planning.createTask({ title: '丙', dueDate: today });
    tracking.focusTask(target.id);

    const list = tracking.focusCandidates();
    assert.equal(list[0]?.title, '丙', '焦点必须排第一');
    assert.equal(list[0]?.isFocused, true);
    assert.equal(list[1]?.title, '乙', '其余按 进行中 → 待办 排');
  });
});

test('焦点候选：列出进行中与待办，卡住/完成的不列', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const project = planning.createProject({ title: '某项目' });
    const today = dayKeyNow(database);

    const doing = planning.createTask({ title: '在做的', projectId: project.id, dueDate: today });
    const todo = planning.createTask({ title: '还没开始的', dueDate: today });
    const blocked = planning.createTask({ title: '卡住的', dueDate: today });
    const done = planning.createTask({ title: '完成的', dueDate: today });
    planning.setTaskStatus(doing.id, 'doing');
    planning.setTaskStatus(blocked.id, 'doing');
    planning.setTaskStatus(blocked.id, 'blocked', { blockedReason: '等回复' });
    tracking.completeTask(done.id);

    const list = tracking.focusCandidates();
    assert.deepEqual(list.map((c) => c.title), ['在做的', '还没开始的'], '进行中排在待办前，且只列这两类');
    // todo 也列出来是有意的：聚焦它会自动开始，若只列 doing 用户会"没得选"
    assert.deepEqual(list.map((c) => c.status), ['doing', 'todo']);
    assert.equal(list[0]?.projectTitle, '某项目', '带上项目名便于区分同名任务');
    assert.equal(list.every((c) => c.isFocused === false), true);
  });
});

test('焦点候选：标出哪一条是当前焦点', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = dayKeyNow(database);
    const a = planning.createTask({ title: '甲', dueDate: today });
    planning.createTask({ title: '乙', dueDate: today });
    tracking.focusTask(a.id);

    const list = tracking.focusCandidates();
    assert.equal(list.find((c) => c.title === '甲')?.isFocused, true);
    assert.equal(list.find((c) => c.title === '乙')?.isFocused, false);
  });
});

test('焦点候选：跨日后不再标出旧焦点（与 focus() 口径一致）', () => {
  useDbWithCalendarDay((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = dayKeyNow(database);
    // 给个今日截止日，保证它本来就在候选列表里，这样测的是"焦点标记"而不是"是否被筛掉"
    const task = planning.createTask({ title: '昨天聚焦的', dueDate: today });
    tracking.focusTask(task.id);
    assert.equal(tracking.focusCandidates().find((c) => c.id === task.id)?.isFocused, true);

    database.prepare('UPDATE tasks SET focused_day_key = ? WHERE id = ?')
      .run(addDaysToKey(today, -1), task.id);

    assert.equal(tracking.focus(), null, 'focus() 应视为无焦点');
    const list = tracking.focusCandidates();
    assert.equal(list.find((c) => c.id === task.id)?.isFocused, false, '候选列表口径必须一致');
  });
});

test('中止：不填原因也能中止，记录与历史进展保留', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '不做了的事' });
    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '做了一半' });

    const aborted = tracking.abortTask(task.id);
    assert.equal(aborted.status, 'cancelled');
    // 关键：中止不是删除，历史进展必须还在
    assert.equal(tracking.taskTimeline(task.id).length, 1);
    assert.equal(getTask(database, task.id)?.deletedAt, null, '中止不是删除');
  });
});

test('中止：填了原因会留一条进展记录（可选项）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });

    tracking.abortTask(task.id, '需求取消了');
    const timeline = tracking.taskTimeline(task.id);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.body, '需求取消了');
    assert.equal(timeline[0]?.kind, 'decision');
  });
});

test('中止：原因只填空白等于没填，不产生空记录', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });

    tracking.abortTask(task.id, '   ');
    assert.equal(tracking.taskTimeline(task.id).length, 0);
    assert.equal(getTask(database, task.id)?.status, 'cancelled');
  });
});

test('中止：已完成的任务不能再中止（状态机把关）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.completeTask(task.id);

    assert.throws(() => tracking.abortTask(task.id), InvalidTransitionError);
  });
});

test('中止：中止后不能再写进展（终态守卫）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.abortTask(task.id);
    assert.equal(getTask(database, task.id)?.status, 'cancelled');

    assert.throws(
      () => tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '还想记' }),
      /cancelled 状态，不能再写入推进记录/,
    );
  });
});

test('中止：中止会顺带清掉焦点（焦点只在进行中上）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.focusTask(task.id);
    assert.equal(tracking.focus()?.id, task.id);

    tracking.abortTask(task.id, '不做了');
    assert.equal(tracking.focus(), null, '中止后焦点必须消失');
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
