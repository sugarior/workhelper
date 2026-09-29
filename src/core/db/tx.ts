// 事务包装。BEGIN IMMEDIATE 让写冲突在事务开始时就暴露，而不是提交时才失败。
// 不支持嵌套：本项目的服务层方法要么自己开事务，要么在调用方事务内保持事务无关，
// 因此嵌套一律按编码错误直接拒绝，避免出现"以为回滚了其实没有"的隐患。

import type { DatabaseSync } from 'node:sqlite';

let txDepth = 0;

export function inTransaction(): boolean {
  return txDepth > 0;
}

export function withTx<T>(database: DatabaseSync, fn: () => T): T {
  if (txDepth > 0) {
    throw new Error('检测到嵌套事务：请把 withTx 提升到最外层调用');
  }
  txDepth = 1;
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // 回滚本身失败时不掩盖原始异常
    }
    throw error;
  } finally {
    txDepth = 0;
  }
}
