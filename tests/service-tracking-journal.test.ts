// 推进与日志服务测试。
//
// 重点：卡点进展的状态联动、今日视图四个分组的口径、
// 以及日志汇总必须覆盖"补录"与"顺延"两种真实情况。
//
// 注意：本文件所有用例把日界设为 0 点（自然日），todayOf() 即日历当天。
// 默认日界是凌晨 4 点，下午跑测试时两者会差一天——这是本文件曾踩过的坑，
// 因此测试内一律不硬编码日期。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { useDbWithCalendarDay } from './helpers/db.ts';
import { createPlanningService } from '../src/core/service/planningService.ts';
import { createTrackingService } from '../src/core/service/trackingService.ts';
import { createJournalService } from '../src/core/service/journalService.ts';
import { getTask } from '../src/core/repo/taskRepo.ts';
import { listSubtasks } from '../src/core/repo/subtaskRepo.ts';
import { getDayBoundaryHour } from '../src/core/repo/settingsRepo.ts';
import { todayKey, addDaysToKey } from '../src/core/day/dayKey.ts';
import { InvalidTransitionError, ValidationError } from '../src/core/domain/errors.ts';

const useDb = useDbWithCalendarDay;

/** 日历上的今天（日界已设为 0 点） */
function todayOf(database: DatabaseSync): string {
  return todayKey(getDayBoundaryHour(database), new Date());
}

test('进展：可挂在任意层级，并出现在对应时间线', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const project = planning.createProject({ title: '项目' });
    const task = planning.createTask({ title: '任务', projectId: project.id });
    const subtask = planning.createSubtask({ taskId: task.id, title: '步骤' });

    tracking.addProgress({ target: { kind: 'project', id: project.id }, kind: 'decision', body: '立项' });
    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '推进一句' });
    tracking.addProgress({ target: { kind: 'subtask', id: subtask.id }, kind: 'progress', body: '步骤进展' });

    assert.equal(tracking.timeline({ kind: 'project', id: project.id }).length, 1);
    assert.equal(tracking.timeline({ kind: 'task', id: task.id }).length, 1);
    assert.equal(tracking.taskTimeline(task.id).length, 2, '任务时间线含子任务上的记录');
  });
});

test('进展：卡点自动把任务联动为阻塞，并写入阻塞原因', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'doing');

    const { entry, task: updated } = tracking.addProgress({
      target: { kind: 'task', id: task.id },
      kind: 'blocker',
      body: '卡在等法务确认',
    });

    assert.equal(entry.kind, 'blocker');
    assert.equal(updated?.status, 'blocked');
    assert.equal(updated?.blockedReason, '卡在等法务确认');
    assert.equal(getTask(database, task.id)?.status, 'blocked');
  });
});

test('进展：非卡点类型不改任务状态', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });

    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '随手记一句' });
    assert.equal(getTask(database, task.id)?.status, 'todo', '普通进展不应改变状态');
  });
});

test('进展：补录可指定归属日与真实时刻，两者允许不一致', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    const today = todayOf(database);

    const { entry } = tracking.addProgress({
      target: { kind: 'task', id: task.id },
      kind: 'progress',
      body: '昨天做的，今天补录',
      dayKey: today,
      occurredAt: '2020-01-01T10:00:00.000Z',
    });

    assert.equal(entry.dayKey, today, '归属日是补录指定的');
    assert.equal(entry.occurredAt, '2020-01-01T10:00:00.000Z', '真实时刻保持原样');
  });
});

test('进展：目标不存在时拒绝写入，避免孤儿记录', () => {
  useDb((database) => {
    const tracking = createTrackingService(database);
    assert.throws(
      () => tracking.addProgress({ target: { kind: 'task', id: 'nope' }, kind: 'progress', body: 'x' }),
      InvalidTransitionError,
    );
    assert.throws(
      () => tracking.addProgress({ target: { kind: 'subtask', id: 'nope' }, kind: 'progress', body: 'x' }),
      InvalidTransitionError,
    );
    assert.throws(
      () => tracking.addProgress({ target: { kind: 'project', id: 'nope' }, kind: 'progress', body: 'x' }),
      InvalidTransitionError,
    );
  });
});

test('进展：空内容被拒绝', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    assert.throws(
      () => tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '   ' }),
      ValidationError,
    );
  });
});

test('今日视图：逾期、今日到期、手工加入、阻塞四组口径', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    const overdue = planning.createTask({ title: '逾期的', dueDate: '2020-01-01' });
    planning.createTask({ title: '今天到期的', dueDate: today });
    planning.createTask({ title: '以后的', dueDate: '2099-12-31' });
    const planned = planning.createTask({ title: '手工加入今天的' });
    const blocked = planning.createTask({ title: '卡住的' });
    planning.setTaskStatus(blocked.id, 'doing');
    planning.setTaskStatus(blocked.id, 'blocked', { blockedReason: '等回复' });

    tracking.addToToday(planned.id, today);
    const view = tracking.todayView(today);

    assert.deepEqual(view.overdue.map((item) => item.title), ['逾期的']);
    assert.deepEqual(view.dueToday.map((item) => item.title), ['今天到期的']);
    assert.deepEqual(view.planned.map((item) => item.title), ['手工加入今天的']);
    assert.deepEqual(view.blocked.map((item) => item.title), ['卡住的']);
    assert.equal(view.counts.open, 5, '五个任务都还没结束');
    assert.equal(overdue.priority, 'normal');
  });
});

test('今日视图：已完成的任务不再出现在待办分组里', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);
    const task = planning.createTask({ title: '今天做完的', dueDate: today });

    tracking.completeTask(task.id);
    const view = tracking.todayView(today);
    assert.equal(view.dueToday.length, 0);
    assert.equal(view.counts.doneToday, 1, '当天完成数应计入');
  });
});

test('今日视图：手工加入今日可撤销', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);
    const task = planning.createTask({ title: '任务' });

    tracking.addToToday(task.id, today);
    assert.equal(getTask(database, task.id)?.plannedFor, today);

    tracking.removeFromToday(task.id);
    assert.equal(getTask(database, task.id)?.plannedFor, null);
    assert.equal(tracking.todayView(today).planned.length, 0);
  });
});

test('推进：开始、阻塞、解除、完成的状态流转', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });

    assert.equal(tracking.startTask(task.id).status, 'doing');
    const blocked = tracking.blockTask(task.id, '等接口联调');
    assert.equal(blocked.status, 'blocked');
    assert.equal(tracking.latestBlocker(task.id)?.body, '等接口联调', '阻塞原因应留下卡点记录');
    assert.equal(tracking.unblockTask(task.id).status, 'doing');

    const done = tracking.completeTask(task.id);
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt !== null);
  });
});

test('推进：阻塞必须给原因，空白不算', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    assert.throws(() => tracking.blockTask(task.id, '   '), ValidationError);
  });
});

test('推进：完成任务时可按要求级联子任务', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    planning.createSubtask({ taskId: task.id, title: '步骤一' });
    planning.createSubtask({ taskId: task.id, title: '步骤二' });

    tracking.completeTask(task.id, { cascadeSubtasks: true });
    assert.equal(listSubtasks(database, task.id).every((item) => item.status === 'done'), true);
  });
});

test('推进：终态任务不再接受任何推进', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.completeTask(task.id);

    // 完成的任务底下不该再长出新记录，否则日志的完成数会对不上
    assert.throws(
      () => tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '完成后的补充' }),
      InvalidTransitionError,
    );
    assert.throws(() => tracking.blockTask(task.id, '又卡住了'), InvalidTransitionError);
    assert.throws(() => tracking.addToToday(task.id), InvalidTransitionError);
    assert.throws(() => tracking.startTask(task.id), InvalidTransitionError);

    // 只读查询不受影响
    assert.equal(tracking.taskTimeline(task.id).length, 0);
  });
});

test('推进：取消的任务同样拒绝推进，但仍可读', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'cancelled');

    assert.throws(
      () => tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: 'x' }),
      InvalidTransitionError,
    );
    assert.equal(getTask(database, task.id)?.status, 'cancelled');
  });
});

test('推进：挂项目的进展记录不受任务终态影响', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const project = planning.createProject({ title: '项目' });
    const task = planning.createTask({ title: '任务', projectId: project.id });
    tracking.completeTask(task.id);

    // 项目级记录与具体任务无关，应当仍然可写
    const { entry } = tracking.addProgress({
      target: { kind: 'project', id: project.id },
      kind: 'decision',
      body: '本阶段结论',
    });
    assert.equal(entry.projectId, project.id);
  });
});

test('推进：已完成任务不能重复完成', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const task = planning.createTask({ title: '任务' });
    tracking.completeTask(task.id);
    assert.throws(() => tracking.completeTask(task.id), InvalidTransitionError, '二次完成应被拒绝');
  });
});

test('可见性契约：任何未结束任务都必须出现在「全部」视图里', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    // 覆盖所有"曾经会沉底"的形态，外加正常形态
    const noDueNoProject = planning.createTask({ title: '无截止日期无项目' });
    const futureDue = planning.createTask({ title: '未来截止', dueDate: '2099-12-31' });
    const pastDue = planning.createTask({ title: '已逾期', dueDate: '2020-01-01' });
    const dueTodayTask = planning.createTask({ title: '今天到期', dueDate: today });
    const project = planning.createProject({ title: '某项目' });
    const inProject = planning.createTask({ title: '项目内无截止', projectId: project.id });
    const doing = planning.createTask({ title: '进行中' });
    const blocked = planning.createTask({ title: '卡住的' });
    planning.setTaskStatus(doing.id, 'doing');
    planning.setTaskStatus(blocked.id, 'doing');
    planning.setTaskStatus(blocked.id, 'blocked', { blockedReason: '等回复' });
    const finished = planning.createTask({ title: '已完成的' });
    tracking.completeTask(finished.id);

    const view = tracking.openTasksView(today);
    const shown = new Set([
      ...view.overdue, ...view.dueToday, ...view.doing, ...view.blocked, ...view.scheduled, ...view.unscheduled,
    ].map((task) => task.id));

    // 这是我犯过的错：界面顶上说"未结束 3"，下面一条都不显示
    for (const task of [noDueNoProject, futureDue, pastDue, dueTodayTask, inProject, doing, blocked]) {
      assert.ok(shown.has(task.id), `「${task.title}」必须出现在全部视图中`);
    }
    assert.equal(shown.has(finished.id), false, '已完成的不应出现在未结束视图');
    assert.equal(view.total, 7, `未结束总数应为 7，实际 ${view.total}`);
    assert.equal(shown.size, view.total, '分组之间不得重叠，也不得遗漏');
  });
});

test('可见性契约：计数与列出的条数一致（页面不得自相矛盾）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    planning.createTask({ title: '无日期无项目' });
    planning.createTask({ title: '未来截止', dueDate: '2099-12-31' });
    planning.createTask({ title: '今天到期', dueDate: today });

    const view = tracking.openTasksView(today);
    const listed = view.overdue.length + view.dueToday.length + view.doing.length
      + view.blocked.length + view.scheduled.length + view.unscheduled.length;
    assert.equal(listed, view.total, '列出的条数必须等于计数');

    // 今日视图只收录有日期或已排期的，剩下的必须被「全部」兜住
    const todayView = tracking.todayView(today);
    const todayIds = new Set([
      ...todayView.overdue, ...todayView.dueToday, ...todayView.planned, ...todayView.blocked,
    ].map((task) => task.id));
    assert.equal(view.total - todayIds.size, 2, '无日期与未来截止这两条不在今日视图（这正是问题来源）');
  });
});

test('可见性契约：分组优先级 —— 正在做的不算逾期，卡住的优先于时间维度', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    const doingLate = planning.createTask({ title: '逾期但在做', dueDate: '2020-01-01' });
    planning.setTaskStatus(doingLate.id, 'doing');

    const blockedLate = planning.createTask({ title: '逾期且卡住', dueDate: '2020-01-01' });
    planning.setTaskStatus(blockedLate.id, 'doing');
    planning.setTaskStatus(blockedLate.id, 'blocked', { blockedReason: '外部依赖' });

    planning.createTask({ title: '真的逾期', dueDate: '2020-01-01' });

    const view = tracking.openTasksView(today);
    assert.deepEqual(view.doing.map((task) => task.title), ['逾期但在做']);
    assert.deepEqual(view.blocked.map((task) => task.title), ['逾期且卡住']);
    assert.deepEqual(view.overdue.map((task) => task.title), ['真的逾期']);
    assert.equal(view.overdueCount, 1, '只有真正未开始且逾期的才算逾期');
  });
});

test('可见性契约：手工排入今日的任务计入「今天到期」组', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    const task = planning.createTask({ title: '没有截止日但排入今日' });
    tracking.addToToday(task.id, today);

    const view = tracking.openTasksView(today);
    assert.deepEqual(view.dueToday.map((item) => item.title), ['没有截止日但排入今日']);
    assert.equal(view.unscheduled.length, 0, '排入今日后不应再算"没有排期"');
  });
});

test('可见性契约：完成后立即从未结束视图消失，重开后回来', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const today = todayOf(database);

    const task = planning.createTask({ title: '任务' });
    assert.equal(tracking.openTasksView(today).total, 1);

    tracking.completeTask(task.id);
    assert.equal(tracking.openTasksView(today).total, 0);

    // reopenTask 归 planning 服务（它是结构操作），不在 tracking 上
    planning.reopenTask(task.id);
    assert.equal(tracking.openTasksView(today).total, 1, '重开后应回来');
  });
});

test('加卡点：无需先"开始"，todo 任务直接卡住也留下记录', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);

    // 现实中"还没开始就被卡住"很常见（等外部依赖、等对方回复）。
    // 曾经状态机禁止 todo → blocked，导致这里直接报错**且进展记录一并回滚**：
    // 用户既卡不住也留不下记录，只能先假装"进行中"——状态因此失真。
    const task = planning.createTask({ title: '等对方给账号' });
    assert.equal(task.status, 'todo');

    const result = tracking.addProgress({
      target: { kind: 'task', id: task.id },
      kind: 'blocker',
      body: '等对方开通权限',
    });

    assert.ok(result.task !== undefined, '应联动返回任务');
    assert.equal(result.task.status, 'blocked');
    assert.equal(result.task.blockedReason, '等对方开通权限');
    // 关键：进展记录必须真的落库，而不是随状态报错一起回滚
    const timeline = tracking.taskTimeline(task.id);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.body, '等对方开通权限');
  });
});

test('加卡点：解除后能退回"尚未开始"，不假装进行中', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);

    const task = planning.createTask({ title: '任务' });
    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'blocker', body: '卡住原因' });
    assert.equal(getTask(database, task.id)?.status, 'blocked');

    const unblocked = tracking.unblockTask(task.id);
    assert.equal(unblocked.status, 'doing', '解除阻塞回到 doing 是既有行为');

    // 也可以显式退回"待办"，表示其实还没开始
    const back = planning.setTaskStatus(task.id, 'todo');
    assert.equal(back.status, 'todo');
    assert.equal(getTask(database, task.id)?.blockedReason, null, '退回待办应清掉阻塞原因');
  });
});

test('日志：汇总覆盖完成、新增、卡点、顺延与时间线', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const journal = createJournalService(database);
    const today = todayOf(database);

    const done = planning.createTask({ title: '今天完成的' });
    tracking.completeTask(done.id);
    planning.createTask({ title: '早就该做完的', dueDate: '2020-01-01' });

    const sub = planning.createSubtask({ taskId: done.id, title: '完成的步骤' });
    planning.setSubtaskStatus(sub.id, 'done');

    const blocked = planning.createTask({ title: '卡住的' });
    planning.setTaskStatus(blocked.id, 'doing');
    tracking.addProgress({ target: { kind: 'task', id: blocked.id }, kind: 'blocker', body: '等法务' });

    const summary = journal.summarize(today);
    assert.equal(summary.dayKey, today);
    assert.ok(summary.completedTasks.some((task) => task.title === '今天完成的'));
    assert.ok(summary.completedSubtasks.some((item) => item.subtask.title === '完成的步骤'));
    assert.ok(summary.completedSubtasks.every((item) => item.taskTitle.length > 0), '子任务要带上所属任务标题');
    assert.ok(summary.carriedOver.some((task) => task.title === '早就该做完的'), '逾期未完成应算顺延项');
    assert.ok(summary.blockers.some((entry) => entry.body === '等法务'));
    assert.ok(summary.timeline.length >= 1);
    assert.equal(summary.counts.blockers, 1);
    assert.ok(summary.counts.carriedOver >= 1);
    assert.ok(summary.counts.completed >= 2, '完成数含任务与子任务');
  });
});

test('日志：汇总不落库，正文只存手写部分', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const journal = createJournalService(database);
    const today = todayOf(database);

    const task = planning.createTask({ title: '完成的任务' });
    tracking.completeTask(task.id);

    const before = journal.summarize(today);
    assert.equal(before.completedTasks.length, 1);
    assert.equal(before.log, null, '未写正文时不应有日志记录');

    const saved = journal.save(today, '今天主要做了迁移方案');
    assert.equal(saved.body, '今天主要做了迁移方案');

    const after = journal.summarize(today);
    assert.equal(after.log?.body, '今天主要做了迁移方案');
    assert.equal(after.completedTasks.length, 1, '汇总仍是运行时投影，不受正文影响');
  });
});

test('日志：汇总随任务状态实时变化（证明没有落库固化）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const journal = createJournalService(database);
    const today = todayOf(database);

    const task = planning.createTask({ title: '任务' });
    journal.save(today, '我先写了正文');

    assert.equal(journal.summarize(today).completedTasks.length, 0);
    tracking.completeTask(task.id);
    assert.equal(journal.summarize(today).completedTasks.length, 1, '刚完成的任务应立刻出现在今天的汇总里');
  });
});

test('日志：一天一条，重复保存是更新；删除后可重写', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const today = todayOf(database);

    const first = journal.save(today, '初稿');
    const second = journal.save(today, '改后');
    assert.equal(second.id, first.id);
    assert.equal(journal.list().length, 1);

    journal.delete(today);
    assert.equal(journal.get(today), null);
    const rewritten = journal.save(today, '重新写');
    assert.equal(rewritten.body, '重新写');
  });
});

test('日志：可补录历史日期并按区间列出', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const today = todayOf(database);
    // 相对今天取日期，避免与真实系统日期相撞
    const yesterday = addDaysToKey(today, -1);
    const dayBefore = addDaysToKey(today, -2);

    journal.save(dayBefore, '前天');
    journal.save(yesterday, '昨天');
    journal.save(today, '今天');

    const all = journal.list();
    assert.equal(all.length, 3, '三条历史日志都应存在');
    assert.equal(all[0]?.dayKey, today, '最新的在最前');
    assert.equal(all[2]?.dayKey, dayBefore);

    const ranged = journal.list({ from: yesterday, to: today }).map((log) => log.dayKey);
    assert.deepEqual(ranged, [today, yesterday]);
  });
});

test('日志：补录的进展记录归入指定日期而不是当前日期', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const tracking = createTrackingService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const today = todayOf(database);
    const past = addDaysToKey(today, -3);

    // 补录：归属日是三天前，但真实时刻是现在。
    // 汇总必须按归属日取，否则补录的内容会消失在自己的日志之外。
    const { entry } = tracking.addProgress({
      target: { kind: 'task', id: task.id },
      kind: 'progress',
      body: '三天前做的，今天补录',
      dayKey: past,
    });
    assert.equal(entry.dayKey, past, '归属日由调用方指定，可以是补录的历史日期');
    assert.notEqual(entry.occurredAt.slice(0, 10), past, '真实时刻与归属日本就不同');

    const pastSummary = journal.summarize(past);
    assert.ok(
      pastSummary.timeline.some((item) => item.body === '三天前做的，今天补录'),
      '补录内容必须出现在它归属的那一天',
    );

    const todaySummary = journal.summarize(today);
    assert.equal(
      todaySummary.timeline.some((item) => item.body.includes('补录')),
      false,
      '不应出现在今天的汇总里',
    );
  });
});

test('日志：卡点计数按归属日算，与补录无关', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const tracking = createTrackingService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'doing');
    const past = addDaysToKey(todayOf(database), -1);

    tracking.addProgress({
      target: { kind: 'task', id: task.id },
      kind: 'blocker',
      body: '昨天卡在等接口',
      dayKey: past,
    });

    assert.equal(journal.summarize(past).counts.blockers, 1, '卡点应计入归属日');
  });
});
