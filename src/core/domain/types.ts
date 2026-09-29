// 领域类型与运行时枚举。
// 用 `as const` 数组同时承载编译期联合类型与运行时取值集合，
// 这样 CHECK 约束、校验逻辑、类型定义三者不会各写一份而漂移。
// 注意：不使用 TS enum —— 类型剥离不支持它。

/** 打开后可查的实体类型（用于回收站、搜索、通用查询） */
export const ENTITY_TYPES = ['project', 'task', 'subtask', 'progress', 'inbox', 'archive', 'log'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUBTASK_STATUSES = ['todo', 'done'] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export const PROGRESS_KINDS = ['progress', 'blocker', 'decision', 'waiting'] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

export const INBOX_STATUSES = ['pending', 'converted', 'archived'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const INBOX_KIND_HINTS = ['todo', 'note'] as const;
export type InboxKindHint = (typeof INBOX_KIND_HINTS)[number];

export const ARCHIVE_KINDS = ['note', 'meeting', 'link', 'file'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/** 进展记录挂载目标的层级 */
export const TARGET_KINDS = ['project', 'task', 'subtask'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * 把运行时取值集合包成类型守卫。
 * 用途：读取 SQLite 行、解析 JSON、接收外部输入时，
 * 把 `string` 收窄成具体枚举，而不是到处写 as。
 */
export function enumGuard<T extends string>(allowed: readonly T[], label: string) {
  const set: ReadonlySet<string> = new Set<string>(allowed);
  return (value: unknown): value is T => {
    if (typeof value !== 'string' || !set.has(value)) {
      throw new Error(`${label} 取值非法: ${String(value)}（允许 ${allowed.join(' | ')}）`);
    }
    return true;
  };
}

export interface Project {
  id: string;
  title: string;
  goal: string | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  blockedReason: string | null;
  plannedFor: string | null;
  completedAt: string | null;
  sortOrder: number;
  sourceInboxId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  status: SubtaskStatus;
  dueDate: string | null;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ProgressEntry {
  id: string;
  projectId: string | null;
  taskId: string | null;
  subtaskId: string | null;
  kind: ProgressKind;
  body: string;
  dayKey: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface InboxItem {
  id: string;
  body: string;
  kindHint: InboxKindHint | null;
  status: InboxStatus;
  parsedDue: string | null;
  rawInput: string | null;
  convertedTo: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DailyLog {
  id: string;
  dayKey: string;
  body: string | null;
  mood: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ArchiveItem {
  id: string;
  kind: ArchiveKind;
  title: string | null;
  body: string | null;
  url: string | null;
  projectId: string | null;
  taskId: string | null;
  dayKey: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 进展记录的目标引用（三选一，与数据库 CHECK 约束对应） */
export interface ProgressTarget {
  kind: TargetKind;
  id: string;
}
