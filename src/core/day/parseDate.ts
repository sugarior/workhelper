// 自然语言日期解析（F-02 的轻量形态）。
//
// 设计取向：只在**能构成完整日期表达式**时才返回结果。
// 宁可漏解析（原样存标题），绝不错解析 —— 错误的截止日期比没有截止日期更糟。
// 因此不实现月份名（"十月"）与裸数字（"10/8" 之外的 "1008"），
// 也不从任意文本里抽取数字当日期。
//
// 命中后由界面显示浅色截止标签，Enter 仍可直接保存，解析绝不阻断捕获。

import { addDaysToKey, parseDayKey } from './dayKey.ts';

export type DatePrecision = 'day';

export interface ParsedDate {
  /** 归属日键 YYYY-MM-DD */
  dayKey: string;
  /** 命中的原文片段，界面按它做高亮 */
  matched: string;
  /** 解析依据，便于测试与排查 */
  rule: string;
  precision: DatePrecision;
}

export interface ParseDateOptions {
  /** 相对表达（明天、下周三）的基准日键 */
  today: string;
  /** 用于生成友好文案（"今天/明天"） */
  boundaryHour?: number;
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const WEEKDAY_DIGITS: Readonly<Record<string, number>> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

const RELATIVE_DAYS: Readonly<Record<string, number>> = {
  今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨日: -1, 前天: -2,
};

/** 中文数字转整数，支持 1–99（如 三 → 3、十五 → 15、二十 → 20、二十三 → 23） */
export function parseChineseNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (text.length === 0) return null;

  const tenIndex = text.indexOf('十');
  if (tenIndex === -1) {
    let value = 0;
    for (const char of text) {
      const digit = CN_DIGITS[char];
      if (digit === undefined) return null;
      value = value * 10 + digit;
    }
    return value;
  }

  const head = text.slice(0, tenIndex);
  const tail = text.slice(tenIndex + 1);
  const tens = head.length === 0 ? 1 : (CN_DIGITS[head] ?? null);
  if (tens === null) return null;
  const ones = tail.length === 0 ? 0 : (CN_DIGITS[tail] ?? null);
  if (ones === null) return null;
  return tens * 10 + ones;
}

function formatDayKey(year: number, month: number, date: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(date)}`;
}

/** 构造并校验公历日期；不存在的日期（如 2 月 30 日）返回 null */
function makeDayKey(year: number, month: number, date: number): string | null {
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const probe = new Date(year, month - 1, date, 12, 0, 0, 0);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== date) return null;
  return formatDayKey(year, month, date);
}

/** 无年份的月日：若今年该日期还没到就用今年，否则用明年 */
function resolveMonthDay(month: number, date: number, today: string): string | null {
  const base = parseDayKey(today);
  const thisYear = makeDayKey(base.year, month, date);
  if (thisYear === null) return null;
  return thisYear >= today ? thisYear : makeDayKey(base.year + 1, month, date);
}

/**
 * 从 today 起**向前**数，到最近一次 target 星期的天数差（0–6，0 表示今天）。
 *
 * 语义决策：只向前看，不返回已过去的日期。因为解析结果用于任务截止时间，
 * 而"昨天"作为截止时间没有意义。因此周三说「本周二」得到的是下周二。
 * 命名里的 Forward 就是为了让这条语义在调用处可见，避免被误读成"本周内的星期 X"。
 */
function forwardWeekdayOffset(target: number, today: string): number {
  const base = parseDayKey(today);
  const probe = new Date(base.year, base.month - 1, base.date, 12, 0, 0, 0);
  return (target - probe.getDay() + 7) % 7;
}

/**
 * 解析输入文本中的第一个完整日期表达式。
 * 未命中返回 null（调用方原样保存文本）。
 */
export function parseDate(input: string, options: ParseDateOptions): ParsedDate | null {
  const { today } = options;
  parseDayKey(today); // 基准日键非法时立即失败，避免静默算错

  // 1) 完整年月日：2026年10月8日
  {
    const matched = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(input);
    if (matched !== null) {
      const year = Number(matched[1]);
      const month = Number(matched[2]);
      const date = Number(matched[3]);
      const existing = year >= 1900 && year <= 2200 ? makeDayKey(year, month, date) : null;
      if (existing === null) return null; // 显式给出的日期不存在，视为无法解析，不做猜测
      return { dayKey: existing, matched: matched[0], rule: 'explicit-ymd', precision: 'day' };
    }
  }

  // 2) 下个月 N 号（先于裸月日匹配，避免被当成"月日"）
  {
    const matched = /下\s*个?\s*月\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[日号]/.exec(input);
    if (matched?.[1] !== undefined) {
      const date = parseChineseNumber(matched[1]);
      const base = parseDayKey(today);
      const month = base.month === 12 ? 1 : base.month + 1;
      const year = base.month === 12 ? base.year + 1 : base.year;
      const existing = date === null ? null : makeDayKey(year, month, date);
      if (existing === null) return null;
      return { dayKey: existing, matched: matched[0], rule: 'next-month-day', precision: 'day' };
    }
  }

  // 3) 月日（无年份）：10月8日 / 10月8号
  {
    const matched = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(input);
    if (matched !== null) {
      const existing = resolveMonthDay(Number(matched[1]), Number(matched[2]), today);
      if (existing === null) return null;
      return { dayKey: existing, matched: matched[0], rule: 'month-day', precision: 'day' };
    }
  }

  // 4) 下周/本周 + 星期：下周三 / 下星期日 / 本周五
  {
    const matched = /(下|本|这)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([1-7日天一二三四五六])/.exec(input);
    if (matched?.[1] !== undefined && matched[2] !== undefined) {
      const target = WEEKDAY_DIGITS[matched[2]];
      if (target === undefined) return null;
      const isNext = matched[1] === '下';
      // 本周内到该星期的天数差（0 = 今天，只向前看）
      const withinWeek = forwardWeekdayOffset(target, today);
      // "下周X" = 下一个自然周的该星期，因此整周后再加差值。
      // 注意：不能解释为"最近一次出现的 X"——周三说"下周一"，最近的周一是 5 天后的
      // 本周一（仍在同一自然周），而"下周一"指的是下一周的周一，即 12 天后。
      const offset = isNext ? withinWeek + 7 : withinWeek;
      return {
        dayKey: addDaysToKey(today, offset),
        matched: matched[0],
        rule: isNext ? 'next-week-weekday' : 'this-week-weekday',
        precision: 'day',
      };
    }
  }

  // 5) N 天后 / N 天前（支持中文数字）
  {
    const matched = /(\d+|[一二三四五六七八九十]+)\s*天\s*(后|以后|之后)/.exec(input);
    if (matched?.[1] !== undefined && matched[2] !== undefined) {
      const days = parseChineseNumber(matched[1]);
      if (days === null) return null;
      return { dayKey: addDaysToKey(today, days), matched: matched[0], rule: 'days-later', precision: 'day' };
    }
  }
  {
    const matched = /(\d+|[一二三四五六七八九十]+)\s*天\s*(前|以前|之前)/.exec(input);
    if (matched?.[1] !== undefined && matched[2] !== undefined) {
      const days = parseChineseNumber(matched[1]);
      if (days === null) return null;
      return { dayKey: addDaysToKey(today, -days), matched: matched[0], rule: 'days-before', precision: 'day' };
    }
  }

  // 6) 今天 / 明天 / 后天 / 昨天 …
  //    放在最后：若文本同时含"明天"与具体日期，具体日期优先级更高
  {
    const matched = /今天|今日|明天|明日|大后天|后天|昨天|昨日|前天/.exec(input);
    if (matched !== null) {
      const offset = RELATIVE_DAYS[matched[0]];
      if (offset === undefined) return null;
      return { dayKey: addDaysToKey(today, offset), matched: matched[0], rule: 'relative-day', precision: 'day' };
    }
  }

  return null;
}

/** 从标题中剥离已解析的日期片段，得到干净的标题 */
export function stripParsedDate(text: string, parsed: ParsedDate | null): string {
  if (parsed === null) return text.trim();
  const index = text.indexOf(parsed.matched);
  if (index === -1) return text.trim();
  const cleaned = `${text.slice(0, index)} ${text.slice(index + parsed.matched.length)}`;
  return cleaned.replace(/\s+/g, ' ').trim();
}
