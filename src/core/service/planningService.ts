// 规划服务：项目 → 任务 → 子任务三级结构，以及拖拽排序。
//
// 业务规则在这一层生效（状态机、阻塞原因、完成水印），不依赖界面约束。
// 所有多步写入走同一事务，避免出现"任务改了但子任务没改"的半成品状态。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  completeAll, countProgressForTarget, countSubtasks, createProject, createSubtask,
  createTask, deleteProject as deleteProjectRepo, deleteSubtask as deleteSubtaskRepo,
  deleteTask as deleteTaskRepo, detachTasks, getSubtask, getTask, indexEntity, listProjects,
  listSubtasks, listTasks, projectTaskCounts, removeEntity, reorderProject, reorderSubtask,
  reorderTask, countByProject, getProject, setSubtaskStatus as setSubtaskStatusRepo,
  updateProject, updateTask,
} from '../repo/index.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { getDayBoundaryHour } from '../repo/settingsRepo.ts';
import {
  assertBlockerReason, assertCanTransition, assertEstimateMinutes, assertNonEmptyText,
  completionStamp, statusAfterBlocker,
} from '../domain/rules.ts';
import { InvalidTransitionError } from '../domain/errors.ts';
import type {
  Priority, Project, ProjectStatus, Subtask, SubtaskStatus, Task, TaskStatus,
} from '../domain/types.ts';

/** 拖拽排序的实体种类 */
export type ReorderKind = 'project' | 'task' | 'subtask';

export interface ProjectTree {
  project: Project;
  counts: { total: number; done: number };
  progressCount: number;
  tasks: TaskNode[];
}

export interface TaskNode {
  task: Task;
  counts: { total: number; done: number };
  progressCount: number;
  subtasks: Subtask[];
}

export interface PlanningService {
  createProject(input: { title: string; goal?: string; priority?: Priority; dueDate?: string | null }): Project;
  updateProject(id: string, patch: Parameters<typeof updateProject>[2]): Project;
  /** 删除项目：其下任务保留但解除归属（不静默隐藏任务） */
  deleteProject(id: string): { detachedTasks: number };
  /**
   * 列出项目。
   *
   * **默认只列活动项目** —— 已归档的项目（`status='archived'`，表示"不做了"）
   * 不在默认结果里。要看它们请传 `includeArchived: true`。
   */
  listProjects(options?: { status?: ProjectStatus; includeArchived?: boolean }): Project[];
  /** 任务列表：按状态与项目过滤，未结束的排在前面 */
  listTasks(filter?: { status?: TaskStatus; projectId?: string | null }): Task[];
  projectTree(projectId: string): ProjectTree;

  createTask(input: {
    title: string;
    projectId?: string | null;
    detail?: string | null;
    priority?: Priority;
    dueDate?: string | null;
    dueAt?: string | null;
    estimateMinutes?: number | null;
  }): Task;
  updateTask(id: string, patch: Parameters<typeof updateTask>[2]): Task;
  setTaskStatus(id: string, status: TaskStatus, options?: { blockedReason?: string }): Task;
  completeTask(id: string, options?: { cascadeSubtasks?: boolean }): Task;
  reopenTask(id: string): Task;
  deleteTask(id: string): void;

  createSubtask(input: { taskId: string; title: string; dueDate?: string | null }): Subtask;
  setSubtaskStatus(id: string, status: SubtaskStatus): Subtask;
  deleteSubtask(id: string): void;

  /** 拖拽：把 movedId 插到 beforeId 之前（beforeId 为 null 表示移到末尾） */
  reorder(kind: ReorderKind, movedId: string, beforeId: string | null): number;
}

export function createPlanningService(database: DatabaseSync): PlanningService {
  const boundaryHour = (): number => getDayBoundaryHour(database);

  /** 统一入口：改任务状态并维护 blocked_reason 与 completed_at */
  function applyTaskStatus(
    id: string,
    next: TaskStatus,
    options: { blockedReason?: string; nowIsoString?: string } = {},
  ): Task {
    const current = getTask(database, id);
    if (current === undefined) throw new InvalidTransitionError(`任务不存在：${id}`);
    // 同名流转一律拒绝：终态必须显式重开，
    // 否则"重复完成任务"会静默成功并刷新完成时间，掩盖真实情况。
    if (current.status === next) {
      throw new InvalidTransitionError(`任务已经是 ${next} 状态，无需重复操作`);
    }
    assertCanTransition(current.status, next);

    const at = options.nowIsoString ?? nowIso();
    let blockedReason: string | null = null;
    if (next === 'blocked') {
      const reason = options.blockedReason ?? current.blockedReason;
      assertBlockerReason(reason);
      blockedReason = reason;
    } else if (current.blockedReason !== null && next !== 'blocked') {
      // 解除阻塞时清掉原因，避免残留误导
      blockedReason = null;
    }

    const task = updateTask(database, id, {
      status: next,
      blockedReason,
      completedAt: completionStamp(next, current.completedAt, at),
    });
    indexEntity(database, { entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
    return task;
  }

  return {
    createProject(input) {
      const title = assertNonEmptyText(input.title, '项目名称');
      const project = withTx(database, () =>
        createProject(database, { title, goal: input.goal ?? null, priority: input.priority, dueDate: input.dueDate ?? null }),
      );
      indexEntity(database, { entityType: 'project', entityId: project.id, title: project.title, body: project.goal ?? '' });
      return project;
    },

    updateProject(id, patch) {
      if (patch.title !== undefined) patch.title = assertNonEmptyText(patch.title, '项目名称');
      const project = withTx(database, () => updateProject(database, id, patch));
      indexEntity(database, { entityType: 'project', entityId: project.id, title: project.title, body: project.goal ?? '' });
      return project;
    },

    deleteProject(id) {
      return withTx(database, () => {
        const detachedTasks = countByProject(database, id);
        detachTasks(database, id);
        deleteProjectRepo(database, id);
        removeEntity(database, 'project', id);
        return { detachedTasks };
      });
    },

    listProjects(options = {}) {
      /**
       * **默认只列活动项目**（除非显式给了 status 或 includeArchived）。
       *
       * 这是领域默认值，不是展示偏好：项目有了"归档"这个终止状态之后
       * （与任务的「中止」对称），"列出项目"的默认含义就应该是"还在做的那些"。
       *
       * 放在服务层而不是各调用方：目标选择器、资料页、项目页都调这一个方法，
       * 靠每个调用方自觉过滤必然会漏一处（本项目已栽过多次）。
       */
      if (options.includeArchived === true) return listProjects(database, {});
      return listProjects(database, { status: options.status ?? 'active' });
    },

    listTasks(filter = {}) {
      return listTasks(database, filter);
    },

    projectTree(projectId) {
      const project = getProject(database, projectId);
      if (project === undefined) throw new InvalidTransitionError(`项目不存在：${projectId}`);
      const tasks = listTasks(database, { projectId });
      return {
        project,
        counts: projectTaskCounts(database, projectId),
        progressCount: countProgressForTarget(database, { kind: 'project', id: projectId }),
        tasks: tasks.map((task) => ({
          task,
          counts: countSubtasks(database, task.id),
          progressCount: countProgressForTarget(database, { kind: 'task', id: task.id }),
          subtasks: listSubtasks(database, task.id),
        })),
      };
    },

    createTask(input) {
      const title = assertNonEmptyText(input.title, '任务标题');
      assertEstimateMinutes(input.estimateMinutes ?? null);
      const task = withTx(database, () =>
        createTask(database, {
          title,
          projectId: input.projectId ?? null,
          detail: input.detail ?? null,
          priority: input.priority,
          dueDate: input.dueDate ?? null,
          dueAt: input.dueAt ?? null,
          estimateMinutes: input.estimateMinutes ?? null,
        }),
      );
      indexEntity(database, { entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
      return task;
    },

    updateTask(id, patch) {
      if (patch.title !== undefined) patch.title = assertNonEmptyText(patch.title, '任务标题');
      if (patch.estimateMinutes !== undefined) assertEstimateMinutes(patch.estimateMinutes ?? null);
      // 直接改状态也走状态机，避免绕过规则
      if (patch.status !== undefined) {
        const current = getTask(database, id);
        if (current === undefined) throw new InvalidTransitionError(`任务不存在：${id}`);
        if (current.status === patch.status) {
          throw new InvalidTransitionError(`任务已经是 ${patch.status} 状态，无需重复操作`);
        }
        assertCanTransition(current.status, patch.status);
        patch.completedAt = completionStamp(patch.status, current.completedAt, nowIso());
        if (patch.status === 'blocked' && patch.blockedReason === undefined) {
          patch.blockedReason = current.blockedReason;
        }
      }
      const task = withTx(database, () => updateTask(database, id, patch));
      indexEntity(database, { entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
      return task;
    },

    setTaskStatus(id, status, options = {}) {
      return withTx(database, () => applyTaskStatus(id, status, options));
    },

    completeTask(id, options = {}) {
      return withTx(database, () => {
        const at = nowIso();
        const task = applyTaskStatus(id, 'done', { nowIsoString: at });
        if (options.cascadeSubtasks === true) {
          completeAll(database, id, at);
        }
        return task;
      });
    },

    reopenTask(id) {
      return withTx(database, () => applyTaskStatus(id, 'doing'));
    },

    deleteTask(id) {
      withTx(database, () => {
        deleteTaskRepo(database, id);
        removeEntity(database, 'task', id);
      });
    },

    createSubtask(input) {
      const title = assertNonEmptyText(input.title, '子任务标题');
      const subtask = withTx(database, () =>
        createSubtask(database, { taskId: input.taskId, title, dueDate: input.dueDate ?? null }),
      );
      indexEntity(database, { entityType: 'subtask', entityId: subtask.id, title: subtask.title });
      return subtask;
    },

    setSubtaskStatus(id, status) {
      return withTx(database, () => {
        const current = getSubtask(database, id);
        if (current === undefined) throw new InvalidTransitionError(`子任务不存在：${id}`);
        if (current.status === status) {
          throw new InvalidTransitionError(`子任务已经是 ${status} 状态，无需重复操作`);
        }
        const result = setSubtaskStatusRepo(database, id, status, nowIso());
        indexEntity(database, { entityType: 'subtask', entityId: result.id, title: result.title });
        return result;
      });
    },

    deleteSubtask(id) {
      withTx(database, () => {
        deleteSubtaskRepo(database, id);
        removeEntity(database, 'subtask', id);
      });
    },

    reorder(kind, movedId, beforeId) {
      return withTx(database, () => {
        if (kind === 'project') return reorderProject(database, movedId, beforeId);
        if (kind === 'task') return reorderTask(database, movedId, beforeId);
        return reorderSubtask(database, movedId, beforeId);
      });
    },
  };
}

/** 供 tracking 服务复用：把卡点进展联动到任务状态 */
export function statusForBlocker(current: TaskStatus): TaskStatus {
  return statusAfterBlocker(current);
}

/** 当前日键（各服务共用同一口径） */
export function currentDayKey(database: DatabaseSync): string {
  return dayKeyFromIso(nowIso(), getDayBoundaryHour(database));
}
