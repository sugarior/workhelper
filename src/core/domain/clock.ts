// 时间与 ID 的唯一来源。
// 所有时间戳都以 UTC ISO 8601 字符串存库（字典序即时间序），
// 日键是它的派生投影，由调用方按日界算出。集中在此便于测试注入。

import { dayKeyOf } from '../day/dayKey.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

/** 由 ISO 时间戳生成日键（按日界切分） */
export function dayKeyFromIso(iso: string, boundaryHour: number): string {
  return dayKeyOf(new Date(iso), boundaryHour);
}

export function newId(): string {
  return crypto.randomUUID();
}
