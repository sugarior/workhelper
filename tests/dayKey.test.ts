// 日界测试：覆盖 docs/design.md §5 的边界表。
// 这些用例是"凌晨记录算哪一天"的唯一契约，改动日界逻辑必须让它们全绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKeyOf, todayKey, isValidDayKey, parseDayKey,
  addDaysToKey, daysBetweenKeys, weekStartKey, dayRange,
} from '../src/core/day/dayKey.ts';

/** 用本地墙钟时间构造时刻，避免 UTC 偏移干扰断言 */
function at(year: number, month: number, date: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, date, hour, minute, 0, 0);
}

test('日界为 4 点时，凌晨记录归前一天', () => {
  const cases: [Date, string, string][] = [
    [at(2026, 9, 29, 23, 59), '2026-09-29', '深夜仍是当天'],
    [at(2026, 9, 30, 0, 0), '2026-09-29', '零点归前一天'],
    [at(2026, 9, 30, 3, 59), '2026-09-29', '3:59 归前一天'],
    [at(2026, 9, 30, 4, 0), '2026-09-30', '4:00 起归当天'],
    [at(2026, 9, 30, 12, 0), '2026-09-30', '白天归当天'],
  ];
  for (const [instant, expected, label] of cases) {
    assert.equal(dayKeyOf(instant, 4), expected, label);
  }
});

test('日界为 0 时退化为自然日', () => {
  assert.equal(dayKeyOf(at(2026, 9, 30, 0, 0), 0), '2026-09-30');
  assert.equal(dayKeyOf(at(2026, 9, 30, 3, 59), 0), '2026-09-30');
});

test('跨年与跨月的凌晨记录归属正确', () => {
  assert.equal(dayKeyOf(at(2026, 1, 1, 2, 0), 4), '2025-12-31', '元旦凌晨归上一年');
  assert.equal(dayKeyOf(at(2026, 3, 1, 2, 0), 4), '2026-02-28', '3 月 1 日凌晨归 2 月末（非闰年）');
  assert.equal(dayKeyOf(at(2024, 3, 1, 2, 0), 4), '2024-02-29', '闰年 3 月 1 日凌晨归 2 月 29 日');
  assert.equal(dayKeyOf(at(2026, 12, 31, 23, 0), 4), '2026-12-31');
  assert.equal(dayKeyOf(at(2027, 1, 1, 1, 0), 4), '2026-12-31');
});

test('非法日界小时被拒绝', () => {
  assert.throws(() => dayKeyOf(at(2026, 9, 30, 12), 24), RangeError);
  assert.throws(() => dayKeyOf(at(2026, 9, 30, 12), -1), RangeError);
  assert.throws(() => dayKeyOf(at(2026, 9, 30, 12), 4.5), RangeError);
});

test('指定时区偏移时按该时区计算', () => {
  // 2026-09-30T00:30:00Z 在东八区（+480 分钟）是 08:30，超过 4 点日界，归 9-30
  const instant = new Date(Date.UTC(2026, 8, 30, 0, 30));
  assert.equal(dayKeyOf(instant, 4, 480), '2026-09-30');
  // 同一时刻在 UTC-5（-300 分钟）是 19:30 前一天，归 9-29
  assert.equal(dayKeyOf(instant, 4, -300), '2026-09-29');
});

test('todayKey 使用注入的时刻而非系统时间', () => {
  assert.equal(todayKey(4, at(2026, 9, 30, 3, 0)), '2026-09-29');
  assert.equal(todayKey(4, at(2026, 9, 30, 5, 0)), '2026-09-30');
});

test('日键格式校验', () => {
  assert.equal(isValidDayKey('2026-09-30'), true);
  assert.equal(isValidDayKey('2026-9-30'), false, '不接受单位数月份');
  assert.equal(isValidDayKey('20260930'), false);
  assert.equal(isValidDayKey(20260930), false);
  assert.equal(isValidDayKey(null), false);
});

test('解析日键时拒绝不存在的日期', () => {
  assert.deepEqual(parseDayKey('2026-09-30'), { year: 2026, month: 9, date: 30 });
  assert.throws(() => parseDayKey('2026-02-30'), RangeError, '2 月 30 日不存在');
  assert.throws(() => parseDayKey('2026-13-01'), RangeError);
  assert.throws(() => parseDayKey('2026-00-10'), RangeError);
  assert.throws(() => parseDayKey('26-09-30'), RangeError);
});

test('日键平移跨年跨月正确', () => {
  assert.equal(addDaysToKey('2026-09-30', 1), '2026-10-01');
  assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToKey('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysToKey('2024-02-28', 1), '2024-02-29', '闰年');
  assert.equal(addDaysToKey('2026-02-28', 1), '2026-03-01', '非闰年');
  assert.equal(addDaysToKey('2026-09-30', 0), '2026-09-30');
});

test('日键差值计算', () => {
  assert.equal(daysBetweenKeys('2026-09-29', '2026-09-30'), 1);
  assert.equal(daysBetweenKeys('2026-09-30', '2026-09-29'), -1);
  assert.equal(daysBetweenKeys('2026-09-30', '2026-09-30'), 0);
  assert.equal(daysBetweenKeys('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetweenKeys('2025-12-31', '2026-01-01'), 1);
});

test('周起始为周一', () => {
  assert.equal(weekStartKey('2026-09-30'), '2026-09-28', '周三 → 周一');
  assert.equal(weekStartKey('2026-09-28'), '2026-09-28', '周一 → 自身');
  assert.equal(weekStartKey('2026-10-04'), '2026-09-28', '周日 → 本周一');
});

test('日键对应的时间区间为左闭右开', () => {
  const { start, end } = dayRange('2026-09-29', 4);
  assert.equal(start.getHours(), 4);
  assert.equal(start.getDate(), 29);
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  // 区间边界上的时刻归属
  assert.equal(dayKeyOf(start, 4), '2026-09-29', '起点属于本日');
  assert.equal(dayKeyOf(new Date(end.getTime() - 1), 4), '2026-09-29', '终点前 1ms 属于本日');
  assert.equal(dayKeyOf(end, 4), '2026-09-30', '终点属于下一日');
});
