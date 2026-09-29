// 领域错误。错误码用于程序分支判断，消息用于人看（界面直接展示）。
// 不用 TS enum：类型剥离不支持。

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 目标记录不存在（或已被软删除） */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** 状态流转或数据不满足领域规则 */
export class InvalidTransitionError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSITION', message);
  }
}

/** 入参格式非法（日期字符串、ID 形状等） */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

/** 唯一性冲突（例如同一天已存在日志） */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

/** 数据库结构版本与代码期望不符 */
export class MigrationError extends DomainError {
  constructor(message: string) {
    super('MIGRATION', message);
  }
}

/** 判断任意异常是否属于本项目的领域错误 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
