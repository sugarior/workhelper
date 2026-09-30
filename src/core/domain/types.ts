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

/**
 * 资料入口的类型。刻意只有三种（需求 §4.2 D1）：
 * 网址不单列"网络资料" —— 飞书文档、Overleaf 这类网址**本身就是工作区**，
 * 按"是否本地"分类没有意义，有用的是"怎么打开"。
 */
export const MATERIAL_ENTRY_KINDS = ['dir', 'file', 'url'] as const;
export type MaterialEntryKind = (typeof MATERIAL_ENTRY_KINDS)[number];

/** 资料可挂靠的对象类型（需求 §4.1 M1：必须至少挂一个） */
export const MATERIAL_LINK_TYPES = ['task', 'project'] as const;
export type MaterialLinkType = (typeof MATERIAL_LINK_TYPES)[number];

/** 资料里的一个可打开入口 */
export interface MaterialEntry {
  id: string;
  archiveId: string;
  kind: MaterialEntryKind;
  /** 绝对路径或 URL，原样保存（不规范化、不校验可达性） */
  target: string;
  /** 该入口自己的注释（需求 §4.2 D4） */
  note: string | null;
  /** 排序值，用于"按常用程度排序" */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 资料与任务/项目的挂靠关系 */
export interface MaterialLink {
  archiveId: string;
  targetType: MaterialLinkType;
  targetId: string;
  createdAt: string;
}

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
  /**
   * 焦点：不为 null 表示"我现在正在推进这一件"（需求 §5.2.1）。
   * **全库最多一条**，由迁移 005 的部分唯一索引在数据库层保证；
   * 且**只允许落在 `doing` 的任务上**（服务层校验）。
   */
  focusedAt: string | null;
  /** 聚焦当时的日键，用于"每日日界自动清空"的惰性判断 */
  focusedDayKey: string | null;
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
  /**
   * @deprecated 历史字段。迁移 004 起，资料的内容由**入口**（MaterialEntry）承载。
   * 仅保留用于承载迁移前留下的散文正文，新代码不读写。
   */
  body: string | null;
  /** @deprecated 同上：历史 URL 已在迁移 003 转为 url 入口 */
  url: string | null;
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
