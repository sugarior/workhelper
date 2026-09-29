// 日界（默认凌晨 4 点切日）与日键换算。
//
// 需求 F-15：凌晨 1 点的记录算前一天，避免加班到深夜被切成两天。
// 日键是"这条记录属于哪一天"的派生投影；occurred_at 始终存真实时刻，
// 两者不要求一致 —— 这正是"补录到昨天"能成立的前提。

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface ZonedParts {
  year: number;
  month: number;
  date: number;
  hour: number;
}

function zonedParts(instant: Date, tzOffsetMinutes?: number): ZonedParts {
  if (tzOffsetMinutes === undefined) {
    return {
      year: instant.getFullYear(),
      month: instant.getMonth(),
      date: instant.getDate(),
      hour: instant.getHours(),
    };
  }
  const shifted = new Date(instant.getTime() + tzOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function formatDayKey(year: number, month: number, date: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month + 1)}-${pad(date)}`;
}

/** 在本地日历上平移天数（用 12:00 为锚点，避免夏令时导致的跨日偏移） */
function shiftDays(parts: { year: number; month: number; date: number }, days: number): Date {
  const anchor = new Date(parts.year, parts.month, parts.date, 12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + days);
  return anchor;
}

/**
 * 计算某时刻归属的日键。
 * boundaryHour=4 时：00:00–03:59 归前一天，04:00 起归当天。
 * boundaryHour=0 时退化为自然日。
 */
export function dayKeyOf(instant: Date, boundaryHour = 4, tzOffsetMinutes?: number): string {
  if (!Number.isInteger(boundaryHour) || boundaryHour < 0 || boundaryHour > 23) {
    throw new RangeError(`日界小时必须是 0–23 的整数，收到：${boundaryHour}`);
  }
  const parts = zonedParts(instant, tzOffsetMinutes);
  if (parts.hour < boundaryHour) {
    const previous = shiftDays(parts, -1);
    return formatDayKey(previous.getFullYear(), previous.getMonth(), previous.getDate());
  }
  return formatDayKey(parts.year, parts.month, parts.date);
}

/** 当前时刻的日键 */
export function todayKey(boundaryHour = 4, now: Date = new Date()): string {
  return dayKeyOf(now, boundaryHour);
}

export function isValidDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

interface CivilDate {
  year: number;
  month: number;
  date: number;
}

/** 解析日键为本地日历三元组；格式或日期非法时抛错 */
export function parseDayKey(dayKey: string): CivilDate {
  const matched = DAY_KEY_PATTERN.exec(dayKey);
  if (matched === null) {
    throw new RangeError(`日键格式必须是 YYYY-MM-DD，收到：${dayKey}`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const date = Number(matched[3]);
  const probe = new Date(year, month - 1, date, 12, 0, 0, 0);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== date) {
    throw new RangeError(`日键不是真实存在的日期：${dayKey}`);
  }
  return { year, month, date };
}

/** 日键平移天数，返回新的日键 */
export function addDaysToKey(dayKey: string, days: number): string {
  const civil = parseDayKey(dayKey);
  const shifted = new Date(civil.year, civil.month - 1, civil.date, 12, 0, 0, 0);
  shifted.setDate(shifted.getDate() + days);
  return formatDayKey(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

/** 两个日键相差的天数（to - from） */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const from = parseDayKey(fromKey);
  const to = parseDayKey(toKey);
  const fromMs = new Date(from.year, from.month - 1, from.date, 12, 0, 0, 0).getTime();
  const toMs = new Date(to.year, to.month - 1, to.date, 12, 0, 0, 0).getTime();
  return Math.round((toMs - fromMs) / DAY_MS);
}

/** 该日键的一周起始（周一），用于周报与周回顾 */
export function weekStartKey(dayKey: string): string {
  const civil = parseDayKey(dayKey);
  const probe = new Date(civil.year, civil.month - 1, civil.date, 12, 0, 0, 0);
  const weekday = (probe.getDay() + 6) % 7; // 周一 = 0
  return addDaysToKey(dayKey, -weekday);
}

/**
 * 某个日键覆盖的真实时间区间：左闭右开。
 * dayKey 2026-09-29 且 boundaryHour=4 时，对应 [2026-09-29 04:00, 2026-09-30 04:00)。
 */
export function dayRange(dayKey: string, boundaryHour = 4, tzOffsetMinutes?: number): { start: Date; end: Date } {
  const civil = parseDayKey(dayKey);
  const localMidnight = new Date(civil.year, civil.month - 1, civil.date, 0, 0, 0, 0).getTime();
  const startMs = localMidnight + boundaryHour * 60 * 60 * 1000;
  if (tzOffsetMinutes === undefined) {
    return { start: new Date(startMs), end: new Date(startMs + DAY_MS) };
  }
  // 指定时区时先按该时区的墙钟时间构造，再折算回真实时刻
  const utcMidnight = Date.UTC(civil.year, civil.month - 1, civil.date, 0, 0, 0, 0);
  const zoneStart = utcMidnight + boundaryHour * 60 * 60 * 1000 - tzOffsetMinutes * 60_000;
  return { start: new Date(zoneStart), end: new Date(zoneStart + DAY_MS) };
}
