// 领域规则：任务状态机与字段一致性校验（纯函数，不碰数据库）。
// 这些规则必须在服务层生效，不能只靠界面约束。
// 与 docs/design.md §6.3「状态联动规则」保持一致。

import { InvalidTransitionError, ValidationError } from './errors.ts';
import type { ProgressKind, TaskStatus } from './types.ts';

/**
 * 任务允许的状态流转。允许自转（无变化则视为 no-op）。
 * 设计意图：
 *  - blocked 的进入与退出都必须经过 doing，避免"直接完成一个卡住的任务"这种失真记录。
 *  - done / cancelled 是终态，需要显式解除才能回到流程（保留 cancelled，不自动清理）。
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['doing', 'done', 'cancelled'],
  doing: ['todo', 'blocked', 'done', 'cancelled'],
  blocked: ['doing', 'todo', 'cancelled'],
  done: ['doing', 'todo'],
  cancelled: ['todo'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function assertCanTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    const allowed = [from, ...(TASK_TRANSITIONS[from] ?? [])].join(' | ');
    throw new InvalidTransitionError(`任务状态不能从 ${from} 变为 ${to}（从 ${from} 出发允许：${allowed}）`);
  }
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from] ?? [];
}

/** 完成任务：允许自 todo 或 doing 直接进入。 */
export function statusAfterComplete(current: TaskStatus): Exclude<TaskStatus, 'cancelled'> {
  if (current === 'cancelled') {
    throw new InvalidTransitionError('已取消的任务不能直接标记完成，请先恢复为待办');
  }
  return 'done';
}

/**
 * 加进展即阻塞：只有「卡点」类型的进展会联动状态，其余三种只记录不改状态。
 * 已完成或已取消的任务不接受卡点——否则会造出"完成的任务还卡着"的矛盾数据。
 */
export function statusAfterBlocker(current: TaskStatus): TaskStatus {
  if (current === 'done' || current === 'cancelled') {
    throw new InvalidTransitionError(`状态为 ${current} 的任务不能再记录卡点，请先恢复为进行中`);
  }
  return 'blocked';
}

/** 标记阻塞必须说明原因，否则进展记录没有信息量。 */
export function assertBlockerReason(reason: string | null | undefined): asserts reason is string {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ValidationError('标记为阻塞必须填写阻塞原因');
  }
}

/** 只有 blocker 类型的进展可以描述阻塞原因 */
export function isBlockerKind(kind: ProgressKind): boolean {
  return kind === 'blocker';
}

/**
 * 完成时间戳的唯一维护点。
 * 返回需要写入数据库的 completedAt：进入 done 时补水印，离开 done 时清除。
 * `nowIso` 由调用方注入，保证可测试与同一事务内时间一致。
 */
export function completionStamp(
  nextStatus: TaskStatus,
  currentCompletedAt: string | null,
  nowIso: string,
): string | null {
  if (nextStatus === 'done') return currentCompletedAt ?? nowIso;
  return null;
}

/** 日键格式：本地日期 YYYY-MM-DD */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertDayKey(dayKey: string): void {
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new ValidationError(`日键格式必须是 YYYY-MM-DD，收到：${dayKey}`);
  }
}

/** 仅校验格式，不校验日期是否真实存在（如 2 月 30 日）——由日期解析层负责 */
export function isValidDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

/** 日界小时：0 表示自然日切分 */
export function assertBoundaryHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ValidationError(`日界小时必须是 0–23 的整数，收到：${hour}`);
  }
}

/** 拖拽排序使用 REAL，必须有限且非负 */
export function assertSortOrder(order: number): void {
  if (!Number.isFinite(order) || order < 0) {
    throw new ValidationError(`排序值必须是非负有限数，收到：${order}`);
  }
}

/** 预估时长：正整数分钟，或 null（不填） */
export function assertEstimateMinutes(minutes: number | null): void {
  if (minutes === null) return;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new ValidationError(`预估时长必须是正整数分钟或留空，收到：${minutes}`);
  }
}

/** 标题类字段：去除首尾空白后不能为空 */
export function assertNonEmptyText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${label}不能为空`);
  }
  return trimmed;
}
