// 推进服务：进展记录、状态联动、今日视图。
//
// 核心规则（docs/design.md §6.3）：
//  - 追加"卡点"进展会把任务联动为 blocked，并把正文写成阻塞原因
//  - 完成任务时只有显式要求才级联子任务，不静默替用户决定
//  - 今日视图的四个分组允许重叠（一条任务可以既逾期又阻塞），用标记区分而不是藏起来

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  applyStatus, clearFocus, countPendingInbox, createProgress, deleteProgress, findFocusedTask,
  getProject, getSubtask, getTask, indexEntity, latestBlockerForTask, listCompletedBetween,
  listProgressForTarget, listProgressForTaskTree, listSubtasks, listTasks, listTasksByStatuses,
  removeEntity, setFocus, setPlannedFor, OPEN_TASK_STATUSES,
} from '../repo/index.ts';
import { getDayBoundaryHour } from '../repo/settingsRepo.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { addDaysToKey, dayRange, todayKey } from '../day/dayKey.ts';
import {
  assertBlockerReason, assertCanTransition, assertNonEmptyText, completionStamp,
} from '../domain/rules.ts';
import { InvalidTransitionError, ValidationError } from '../domain/errors.ts';
import type { CompletedEntry } from '../repo/completedRepo.ts';
import type { ProgressEntry, ProgressKind, ProgressTarget, Task, TaskStatus } from '../domain/types.ts';

/** 日键形状校验：completedView 的自定义范围用它挡住脏输入 */
const DAY_KEY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * 全部未结束任务的聚合（F-09）。
 *
 * 存在的理由：捕获时不允许要求分类或排期（需求 §6.2 契约 2），因此
 * "无截止日期、无项目"是合法且常见的状态。若没有这个视图，这类任务会永久沉底——
 * "随手记"就变成了"随手丢"。见需求 §6.6 可见性约束。
 *
 * 分组之间**互不重叠**：每条未结束任务恰好出现在一组里，
 * 避免同一件事在页面上出现两次而让人误以为有两件。
 */
export interface OpenTasksView {
  dayKey: string;
  /** 已过期且未开始 */
  overdue: Task[];
  /** 今天到期且未开始 */
  dueToday: Task[];
  /** 已排期到未来、且未开始 */
  scheduled: Task[];
  /** 没有截止日期、也没排入今日、且未开始 */
  unscheduled: Task[];
  /** 正在推进 */
  doing: Task[];
  /** 卡住的（阻塞优先于任何时间维度） */
  blocked: Task[];
  total: number;
  overdueCount: number;
}

/** 分组顺序固定，界面按此顺序渲染 */
export const OPEN_TASK_GROUPS = ['overdue', 'dueToday', 'doing', 'blocked', 'scheduled', 'unscheduled'] as const;
export type OpenTaskGroup = (typeof OPEN_TASK_GROUPS)[number];

export const OPEN_TASK_GROUP_LABELS: Readonly<Record<OpenTaskGroup, string>> = {
  overdue: '逾期',
  dueToday: '今天到期',
  doing: '进行中',
  blocked: '卡住',
  scheduled: '已排期（未来）',
  unscheduled: '没有排期',
};

/** 已完成总览的时间范围（F-09b） */
export const COMPLETED_PRESETS = ['last7', 'all', 'custom'] as const;
export type CompletedPreset = (typeof COMPLETED_PRESETS)[number];

export interface CompletedRange {
  preset: CompletedPreset;
  /** preset = 'custom' 时必填，均为日键 */
  fromDayKey?: string;
  toDayKey?: string;
}

/**
 * 已完成总览（F-09b）。
 *
 * 存在的理由：需求 P4 把"复盘是编的"列为核心痛点、G3 承诺"写日报是导出而不是回忆"，
 * 但此前只有单天汇总（F-20），写周报仍要逐天翻日志。
 */
export interface CompletedView {
  range: { fromDayKey: string | null; toDayKey: string; preset: CompletedPreset };
  /** 按完成日倒序分组；界面直接用日期作小标题 */
  groups: { dayKey: string; entries: CompletedEntry[] }[];
  total: { tasks: number; subtasks: number; all: number };
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
  /** 全部未结束任务，按可操作性分组（F-09）。任何未结束任务都必须出现在这里 */
  openTasksView(dayKey?: string): OpenTasksView;
  /** 已完成总览（F-09b）。按完成日倒序分组，含任务与子任务 */
  completedView(range: CompletedRange): CompletedView;
  /** 当前焦点任务（F-15b）。跨日后惰性清空；无焦点返回 null */
  focus(): Task | null;
  /** 聚焦：`todo` 会先转 `doing`；自动顶掉旧焦点。返回新的焦点任务 */
  focusTask(taskId: string): Task;
  /** 取消聚焦 */
  unfocus(): void;
  /**
   * 可以聚焦的任务（F-15b 的切换器用）。
   *
   * 包含 `doing` 与 `todo`：`todo` 也列出来是有意的 ——
   * 对 `todo` 聚焦会自动先转 `doing`（聚焦与开始本来就是同一个动作），
   * 若只列 `doing`，用户想切到一条尚未开始的任务时会发现"没得选"。
   * 界面据此把 `todo` 标成"选中即开始"。
   */
  focusCandidates(): { id: string; title: string; status: TaskStatus; projectTitle: string | null; isFocused: boolean }[];
  /**
   * 「记一笔」：给当前焦点任务追加一条进展（F-15c）。
   * 没有焦点时抛错 —— 让"记到哪"永远有明确答案，而不是猜一个目标。
   */
  noteOnFocus(input: { kind: ProgressKind; body: string }): { entry: ProgressEntry; task: Task };

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
    // 焦点清理已下沉到仓储层的 applyStatus（那里覆盖所有改状态的路径），
    // 这里不再重复，避免两处规则再次分叉。
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

  /**
   * 追加进展的公共实现。「记一笔」与「任务行内记一笔」共用它，
   * 避免两套逻辑分叉（尤其是"卡点联动状态"这条规则）。
   * 调用方负责事务边界。
   */
  function addProgressCore(input: {
    target: ProgressTarget;
    kind: ProgressKind;
    body: string;
    occurredAt?: string;
    dayKey?: string;
  }): { entry: ProgressEntry; task?: Task } {
    const body = assertNonEmptyText(input.body, '进展内容');
    assertTargetExists(input.target);
    // 只有挂在任务上的记录需要拦终态；直接挂项目的记录没有对应任务
    if (input.target.kind === 'task') assertTaskNotTerminal(input.target.id);

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
  }

  return {
    addProgress(input) {
      return withTx(database, () => addProgressCore(input));
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

    /**
     * 全部未结束任务（F-09）。分组互不重叠，判定优先级：
     *   阻塞 → 进行中 → 逾期 → 今天到期 → 未来排期 → 没有排期
     * 即"卡住的"和"正在做的"优先于时间维度：一条逾期但正在做的任务，
     * 应该出现在"进行中"而不是"逾期"里——它已经在处理了。
     */
    openTasksView(dayKey) {
      const key = dayKey ?? keyOf(new Date());
      const open = listTasksByStatuses(database, OPEN_TASK_STATUSES);

      const blocked: Task[] = [];
      const doing: Task[] = [];
      const overdue: Task[] = [];
      const dueToday: Task[] = [];
      const scheduled: Task[] = [];
      const unscheduled: Task[] = [];

      for (const task of open) {
        if (task.status === 'blocked') {
          blocked.push(task);
          continue;
        }
        if (task.status === 'doing') {
          doing.push(task);
          continue;
        }
        // 到这里只剩 todo：按时间维度归类，且每一条恰好落一组
        if (task.dueDate === null || task.dueDate === key) {
          // 今天到期（或没有截止日但被手工排入今日）算今天该做的
          if (task.dueDate === key || task.plannedFor === key) dueToday.push(task);
          else unscheduled.push(task);
          continue;
        }
        if (task.dueDate < key) {
          overdue.push(task);
          continue;
        }
        scheduled.push(task);
      }

      const byDue = (a: Task, b: Task): number => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
      overdue.sort(byDue);
      dueToday.sort(byDue);
      scheduled.sort(byDue);

      return {
        dayKey: key,
        overdue,
        dueToday,
        scheduled,
        unscheduled,
        doing,
        blocked,
        total: open.length,
        overdueCount: overdue.length,
      };
    },

    /**
     * 已完成总览（F-09b）。
     *
     * 时间换算要点：完成时刻是**真实时刻**，所以区间必须按日界换算成本地日区间，
     * 不能直接把日键当字符串比较（否则凌晨 2 点完成的任务会被算进前一天）。
     * 上界取"今天日区间的结束"，这样今天的完成也算在内。
     */
    completedView(range) {
      const today = keyOf(new Date());
      const boundary = boundaryHour();

      let fromDayKey: string | null;
      if (range.preset === 'all') fromDayKey = null;
      else if (range.preset === 'last7') fromDayKey = addDaysToKey(today, -6);
      else fromDayKey = range.fromDayKey ?? today;
      if (fromDayKey !== null && !DAY_KEY_SHAPE.test(fromDayKey)) {
        throw new ValidationError(`起始日期格式应为 YYYY-MM-DD，收到：${fromDayKey}`);
      }

      const toDayKey = range.preset === 'custom' ? (range.toDayKey ?? today) : today;
      if (!DAY_KEY_SHAPE.test(toDayKey)) {
        throw new ValidationError(`结束日期格式应为 YYYY-MM-DD，收到：${toDayKey}`);
      }
      if (fromDayKey !== null && fromDayKey > toDayKey) {
        throw new ValidationError(`起始日期不能晚于结束日期：${fromDayKey} > ${toDayKey}`);
      }

      const startIso = fromDayKey === null ? '0000-01-01T00:00:00.000Z' : dayRange(fromDayKey, boundary).start.toISOString();
      const endIso = dayRange(toDayKey, boundary).end.toISOString();

      const entries = listCompletedBetween(database, startIso, endIso);

      // 按完成日（本地日界下的日键）分组，日期倒序
      const grouped = new Map<string, CompletedEntry[]>();
      for (const entry of entries) {
        const dayKey = dayKeyFromIso(entry.completedAt, boundary);
        const list = grouped.get(dayKey);
        if (list === undefined) grouped.set(dayKey, [entry]);
        else list.push(entry);
      }

      const groups = [...grouped.entries()]
        .map(([dayKey, list]) => ({ dayKey, entries: list }))
        .sort((a, b) => b.dayKey.localeCompare(a.dayKey));

      return {
        range: { fromDayKey, toDayKey, preset: range.preset },
        groups,
        total: {
          tasks: entries.filter((entry) => entry.kind === 'task').length,
          subtasks: entries.filter((entry) => entry.kind === 'subtask').length,
          all: entries.length,
        },
      };
    },

    /**
     * 当前焦点任务（需求 §5.2.1）。
     *
     * **每日日界自动清空**用惰性判断实现，而不是后台定时器：
     * 聚焦时记下当时的日键，读取时与今天的日键比较，不同就视为无焦点并顺手清掉。
     * 这样不需要定时任务，也天然处理"服务跨夜没运行""机器关机一整晚"等情况。
     */
    focus() {
      const focused = findFocusedTask(database);
      if (focused === undefined) return null;
      if (focused.focusedDayKey !== keyOf(new Date())) {
        clearFocus(database);
        return null;
      }
      return focused;
    },

    /**
     * 聚焦（F-15b）。
     *
     * 两条硬规则：
     *  1. 焦点**只能落在 `doing`** 上（用户明确要求）—— 这让焦点不贬值，
     *     它始终意味着"这件事真的在推进"，而不是"我看过它"。
     *     因此对 `todo` 任务聚焦时**自动先转 doing**：聚焦与开始本来就是同一个动作。
     *  2. 切到新焦点时旧焦点自动顶掉（仓储层保证全库唯一）。
     */
    focusTask(taskId) {
      return withTx(database, () => {
        const task = getTask(database, taskId);
        if (task === undefined) throw new InvalidTransitionError(`任务不存在：${taskId}`);
        assertTaskNotTerminal(taskId);

        // 先补齐状态，再设焦点，顺序不能反：
        // 若先设焦点再转状态，中间态会违反"焦点只在 doing 上"的约束。
        const ready = task.status === 'todo' ? applyTaskStatus(taskId, 'doing') : task;
        if (ready.status !== 'doing') {
          throw new InvalidTransitionError(
            `只有「进行中」的任务才能聚焦，当前是 ${ready.status}。请先解除阻塞或重开任务。`,
          );
        }
        return setFocus(database, taskId, keyOf(new Date()));
      });
    },

    unfocus() {
      withTx(database, () => {
        clearFocus(database);
      });
    },

    focusCandidates() {
      // 复用 openTasksView 的口径：能聚焦的就是"未结束"里的进行中与待办。
      // 卡住的不列（焦点不能落在 blocked 上），已排期/没有排期只要状态是 todo 就算。
      const focused = findFocusedTask(database);
      const today = keyOf(new Date());
      const focusId = focused !== undefined && focused.focusedDayKey === today ? focused.id : null;

      const tasks = listTasksByStatuses(database, ['doing', 'todo']);
      return tasks
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          projectTitle: task.projectId === null ? null : getProject(database, task.projectId)?.title ?? null,
          isFocused: task.id === focusId,
        }))
        // 排序：当前焦点 → 进行中 → 待办。
        // 焦点排最前是为了打开切换器时视线先落到"我现在这条"；
        // 进行中排在待办前，因为已经在做的事更可能是你要切回去的那件。
        .sort((a, b) => {
          if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
          if (a.status !== b.status) return a.status === 'doing' ? -1 : 1;
          return 0;
        });
    },

    /**
     * 记一笔（F-15c）：给当前焦点任务追加进展。
     *
     * 没有焦点时**明确报错**，而不是随便挑一条任务写进去 ——
     * "记到哪"必须永远有确切答案（需求 §5.2.1）。
     */
    noteOnFocus(input) {
      return withTx(database, () => {
        const focused = findFocusedTask(database);
        if (focused === undefined || focused.focusedDayKey !== keyOf(new Date())) {
          if (focused !== undefined) clearFocus(database);
          throw new InvalidTransitionError('当前没有正在做的任务，先去「全部」里对一条任务点聚焦');
        }
        // 与任务行内记一笔共用同一个实现，规则不会分叉
        const result = addProgressCore({
          target: { kind: 'task', id: focused.id },
          kind: input.kind,
          body: input.body,
        });
        // 只有"卡点"才会联动返回新任务；其余类型返回记录前的任务本身
        return { entry: result.entry, task: result.task ?? focused };
      });
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
