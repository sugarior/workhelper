// 推进服务：进展记录、状态联动、今日视图。
//
// 核心规则（docs/design.md §6.3）：
//  - 追加"卡点"进展会把任务联动为 blocked，并把正文写成阻塞原因
//  - 完成任务时只有显式要求才级联子任务，不静默替用户决定
//  - 今日视图的四个分组允许重叠（一条任务可以既逾期又阻塞），用标记区分而不是藏起来

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  applyStatus, countPendingInbox, createProgress, deleteProgress, getSubtask, getTask,
  indexEntity, latestBlockerForTask, listProgressForTarget, listProgressForTaskTree,
  listSubtasks, listTasks, listTasksByStatuses, removeEntity, setPlannedFor,
  OPEN_TASK_STATUSES,
} from '../repo/index.ts';import { getDayBoundaryHour } from '../repo/settingsRepo.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { dayRange, todayKey } from '../day/dayKey.ts';
import {
  assertBlockerReason, assertCanTransition, assertNonEmptyText, completionStamp,
} from '../domain/rules.ts';
import { InvalidTransitionError } from '../domain/errors.ts';
import type { ProgressEntry, ProgressKind, ProgressTarget, Task } from '../domain/types.ts';

export interface TodayView {
  dayKey: string;
  /** 已过期且未结束 */
  overdue: Task[];
  /** 今天到期且未结束 */
  dueToday: Task[];
  /** 手工标记为今天 */
  planned: Task[];
  /** 当前卡住的任务 */
  blocked: Task[];
  /** 收件箱待处理数量 */
  inboxCount: number;
  counts: { open: number; doneToday: number };
}

export interface TrackingService {
  addProgress(input: {
    target: ProgressTarget;
    kind: ProgressKind;
    body: string;
    /** 补录用：不传则取当前时刻与该时刻的日键 */
    occurredAt?: string;
    dayKey?: string;
  }): { entry: ProgressEntry; task?: Task };
  timeline(target: ProgressTarget, options?: { limit?: number }): ProgressEntry[];
  taskTimeline(taskId: string, options?: { limit?: number }): ProgressEntry[];
  deleteProgress(id: string): void;

  todayView(dayKey?: string): TodayView;
  addToToday(taskId: string, dayKey?: string): Task;
  removeFromToday(taskId: string): Task;
  /** 快速把任务推进到"进行中" */
  startTask(taskId: string): Task;
  blockTask(taskId: string, reason: string): Task;
  unblockTask(taskId: string): Task;
  completeTask(taskId: string, options?: { cascadeSubtasks?: boolean }): Task;
  /** 某个任务最近一次卡点的原因，解除阻塞时展示 */
  latestBlocker(taskId: string): ProgressEntry | undefined;
}

export function createTrackingService(database: DatabaseSync): TrackingService {
  const boundaryHour = (): number => getDayBoundaryHour(database);

  function keyOf(instant: Date): string {
    return todayKey(boundaryHour(), instant);
  }

  /** 统一的状态推进入口（与 planning 服务共用同一套规则） */
  function applyTaskStatus(id: string, next: Task['status'], options: { blockedReason?: string } = {}): Task {
    const current = getTask(database, id);
    if (current === undefined) throw new InvalidTransitionError(`任务不存在：${id}`);
    // 同名流转一律拒绝：终态必须显式重开（reopenTask），
    // 否则"重复完成任务"会静默成功并刷新完成时间，掩盖真实情况。
    if (current.status === next) {
      throw new InvalidTransitionError(`任务已经是 ${next} 状态，无需重复操作`);
    }
    assertCanTransition(current.status, next);

    const at = nowIso();
    let blockedReason: string | null = null;
    if (next === 'blocked') {
      const reason = options.blockedReason ?? current.blockedReason;
      assertBlockerReason(reason);
      blockedReason = reason;
    }

    const task = applyStatus(database, id, next, {
      completedAt: completionStamp(next, current.completedAt, at),
      blockedReason,
    });
    indexEntity(database, { entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
    return task;
  }

  /** 校验进展目标存在，避免留下指向空对象的记录 */
  function assertTargetExists(target: ProgressTarget): void {
    if (target.kind === 'task' && getTask(database, target.id) === undefined) {
      throw new InvalidTransitionError(`任务不存在：${target.id}`);
    }
    if (target.kind === 'subtask' && getSubtask(database, target.id) === undefined) {
      throw new InvalidTransitionError(`子任务不存在：${target.id}`);
    }
    if (target.kind === 'project') {
      const row = database.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(target.id);
      if (row === undefined) throw new InvalidTransitionError(`项目不存在：${target.id}`);
    }
  }

  /**
   * 已完成/已取消的任务是终态，不再接受任何推进。
   * 不拦的话会出现"完成的任务底下还在长新记录"这种自相矛盾的数据，
   * 而每日日志的完成数也会因此对不上。
   */
  function assertTaskNotTerminal(taskId: string): void {
    const task = getTask(database, taskId);
    if (task === undefined) throw new InvalidTransitionError(`任务不存在：${taskId}`);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new InvalidTransitionError(
        `任务已是 ${task.status} 状态，不能再写入推进记录；如需继续请先用 reopen 恢复`,
      );
    }
  }

  return {
    addProgress(input) {
      const body = assertNonEmptyText(input.body, '进展内容');
      assertTargetExists(input.target);
      // 只有挂在任务上的记录需要拦终态；直接挂项目的记录没有对应任务
      if (input.target.kind === 'task') assertTaskNotTerminal(input.target.id);

      return withTx(database, () => {
        const at = input.occurredAt ?? nowIso();
        const dayKey = input.dayKey ?? dayKeyFromIso(at, boundaryHour());
        const entry = createProgress(database, {
          target: input.target,
          kind: input.kind,
          body,
          dayKey,
          occurredAt: at,
        });

        indexEntity(database, {
          entityType: 'progress',
          entityId: entry.id,
          title: '',
          body,
        });

        // 状态联动：只有卡点会改任务状态
        let task: Task | undefined;
        if (input.kind === 'blocker' && input.target.kind === 'task') {
          const current = getTask(database, input.target.id);
          if (current !== undefined && current.status !== 'blocked') {
            task = applyTaskStatus(input.target.id, 'blocked', { blockedReason: body });
          }
        }
        return task === undefined ? { entry } : { entry, task };
      });
    },

    timeline(target, options = {}) {
      return listProgressForTarget(database, target, options.limit ?? 100);
    },

    taskTimeline(taskId, options = {}) {
      return listProgressForTaskTree(database, taskId, options.limit ?? 200);
    },

    deleteProgress(id) {
      withTx(database, () => {
        deleteProgress(database, id);
        removeEntity(database, 'progress', id);
      });
    },

    todayView(dayKey) {
      const key = dayKey ?? keyOf(new Date());
      const open = listTasksByStatuses(database, OPEN_TASK_STATUSES);

      const overdue = open.filter((task) => task.dueDate !== null && task.dueDate < key);
      const dueToday = open.filter((task) => task.dueDate === key);
      const planned = open.filter((task) => task.plannedFor === key);
      const blocked = listTasks(database, { status: 'blocked' });

      const { start, end } = dayRange(key, boundaryHour());
      const doneToday = listTasks(database, { status: 'done' }).filter(
        (task) => task.completedAt !== null && task.completedAt >= start.toISOString() && task.completedAt < end.toISOString(),
      );

      return {
        dayKey: key,
        overdue,
        dueToday,
        planned,
        blocked,
        inboxCount: countPendingInbox(database),
        counts: { open: open.length, doneToday: doneToday.length },
      };
    },

    addToToday(taskId, dayKey) {
      const key = dayKey ?? keyOf(new Date());
      return withTx(database, () => {
        assertTaskNotTerminal(taskId);
        return setPlannedFor(database, taskId, key);
      });
    },

    removeFromToday(taskId) {
      return withTx(database, () => setPlannedFor(database, taskId, null));
    },

    /** 开始推进。终态任务必须先显式 reopen，不允许用 doing 悄悄绕过。 */
    startTask(taskId) {
      return withTx(database, () => {
        assertTaskNotTerminal(taskId);
        return applyTaskStatus(taskId, 'doing');
      });
    },

    blockTask(taskId, reason) {
      const text = assertNonEmptyText(reason, '阻塞原因');
      return withTx(database, () => {
        assertTaskNotTerminal(taskId);
        const task = applyTaskStatus(taskId, 'blocked', { blockedReason: text });
        // 阻塞原因同时留一条卡点记录，形成可回溯的时间线
        const at = nowIso();
        const entry = createProgress(database, {
          target: { kind: 'task', id: taskId },
          kind: 'blocker',
          body: text,
          dayKey: dayKeyFromIso(at, boundaryHour()),
          occurredAt: at,
        });
        indexEntity(database, { entityType: 'progress', entityId: entry.id, title: '', body: text });
        return task;
      });
    },

    /** 解除阻塞。只有确为 blocked 的任务才谈得上"解除"。 */
    unblockTask(taskId) {
      return withTx(database, () => {
        assertTaskNotTerminal(taskId);
        const current = getTask(database, taskId);
        if (current !== undefined && current.status !== 'blocked') {
          throw new InvalidTransitionError(`任务当前不是 blocked 状态（实际为 ${current.status}），无需解除`);
        }
        return applyTaskStatus(taskId, 'doing');
      });
    },

    completeTask(taskId, options = {}) {
      return withTx(database, () => {
        const at = nowIso();
        // 与 planning 服务共用同一套校验：重复完成会被状态机拒绝
        const task = applyTaskStatus(taskId, 'done');
        if (options.cascadeSubtasks === true) {
          const pending = listSubtasks(database, taskId).filter((item) => item.status !== 'done');
          for (const item of pending) {
            database
              .prepare(`UPDATE subtasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`)
              .run(item.completedAt ?? at, at, item.id);
          }
        }
        indexEntity(database, { entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
        return task;
      });
    },

    latestBlocker(taskId) {
      return latestBlockerForTask(database, taskId);
    },
  };
}
