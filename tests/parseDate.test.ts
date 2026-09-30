// 日期解析测试。
// 重点是**反例**：宁可漏解析（原样存标题），也绝不能把普通文本误判成日期。
// 基准日：2026-09-30（周三），2026 年不是闰年。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, stripParsedDate, parseChineseNumber } from '../src/core/day/parseDate.ts';

const TODAY = '2026-09-30';
const parse = (text: string) => parseDate(text, { today: TODAY });

test('中文数字转换支持 1–99', () => {
  assert.equal(parseChineseNumber('三'), 3);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('十五'), 15);
  assert.equal(parseChineseNumber('二十'), 20);
  assert.equal(parseChineseNumber('二十三'), 23);
  assert.equal(parseChineseNumber('三十一'), 31);
  assert.equal(parseChineseNumber('99'), 99);
  assert.equal(parseChineseNumber(''), null);
  assert.equal(parseChineseNumber('百'), null);
});

test('完整年月日', () => {
  const hit = parse('2026年10月8日交报告');
  assert.equal(hit?.dayKey, '2026-10-08');
  assert.equal(hit?.rule, 'explicit-ymd');
  assert.equal(hit?.matched, '2026年10月8日');
});

test('月日（无年份）按就近未来解释', () => {
  assert.equal(parse('10月8日提交')?.dayKey, '2026-10-08', '今年还没到 → 今年');
  assert.equal(parse('10月8号提交')?.dayKey, '2026-10-08');
  assert.equal(parse('9月1日交')?.dayKey, '2027-09-01', '今年已过 → 明年');
  assert.equal(parse('9月30日的会')?.dayKey, '2026-09-30', '就是今天 → 今天');
});

test('下个月 N 号', () => {
  assert.equal(parse('下个月3号交材料')?.dayKey, '2026-10-03');
  assert.equal(parse('下月15号')?.dayKey, '2026-10-15');
  assert.equal(parse('下个月三号')?.dayKey, '2026-10-03', '支持中文数字');
});

test('下周 / 本周 + 星期', () => {
  // 语义约定（曾在此踩坑，勿改）：
  //   "下周X" = 下一个自然周的星期 X，不是"最近一次出现的星期 X"。
  //   基准日 2026-09-30 是周三，其所在自然周为 9-28(一) ~ 10-04(日)。
  //   因此"下周一"是 10-05 所在的下一周 → 10-05 是本周一，下周一为 10-12。
  assert.equal(parse('下周三交接口文档')?.dayKey, '2026-10-07', '下一周的周三');
  assert.equal(parse('下周三')?.rule, 'next-week-weekday');
  assert.equal(parse('下周一')?.dayKey, '2026-10-12', '下一周的周一（本周一 10-05 已过）');
  assert.equal(parse('下周一')?.rule, 'next-week-weekday');
  assert.equal(parse('本周五复盘')?.dayKey, '2026-10-02', '本周内的周五');
  assert.equal(parse('本周五')?.rule, 'this-week-weekday');
  assert.equal(parse('下周日')?.dayKey, '2026-10-11', '周日是自然周的最后一天');
  assert.equal(parse('下星期一')?.dayKey, '2026-10-12');
  assert.equal(parse('这个礼拜四')?.dayKey, '2026-10-01');
  assert.equal(parse('本周三')?.dayKey, '2026-09-30', '本周三就是今天');
  assert.equal(parse('下周四')?.dayKey, '2026-10-08');
  // 语义：只向前看。已过去的星期几按"下一次"解释（周三说本周二 → 下周二）。
  // 因为解析结果是任务截止时间，"昨天"作为截止时间没有意义。
  assert.equal(parse('本周二')?.dayKey, '2026-10-06', '本周二已过 → 向前取最近一次，即下周二');
  assert.equal(parse('本周一')?.dayKey, '2026-10-05', '周一仍在前方（本周内）');
});

test('下周 X 在 X 当天指下一个 X', () => {
  // 2026-10-07 是周三
  assert.equal(parseDate('下周三', { today: '2026-10-07' })?.dayKey, '2026-10-14', '当天说下周即整周后');
  assert.equal(parseDate('本周三', { today: '2026-10-07' })?.dayKey, '2026-10-07', '本周三就是当天');
  // 2026-10-06 是周二
  assert.equal(parseDate('下周三', { today: '2026-10-06' })?.dayKey, '2026-10-14', '下一周的周三');
  assert.equal(parseDate('本周三', { today: '2026-10-06' })?.dayKey, '2026-10-07', '本周三是明天');
});

test('N 天后 / N 天前（含中文数字）', () => {
  assert.equal(parse('3天后给他')?.dayKey, '2026-10-03');
  assert.equal(parse('五天后交')?.dayKey, '2026-10-05');
  assert.equal(parse('2天前就该做的')?.dayKey, '2026-09-28');
  assert.equal(parse('十天前')?.dayKey, '2026-09-20');
});

test('相对日表达', () => {
  assert.equal(parse('明天打电话')?.dayKey, '2026-10-01');
  assert.equal(parse('今天要交')?.dayKey, '2026-09-30');
  assert.equal(parse('后天开会')?.dayKey, '2026-10-02');
  assert.equal(parse('大后天交')?.dayKey, '2026-10-03');
  assert.equal(parse('昨天忘了记')?.dayKey, '2026-09-29');
  assert.equal(parse('前天的事')?.dayKey, '2026-09-28');
});

test('具体日期优先于相对日', () => {
  const hit = parse('明天再看10月8日那份报告');
  assert.equal(hit?.dayKey, '2026-10-08');
  assert.equal(hit?.rule, 'month-day');
});

test('跨年与跨月边界', () => {
  assert.equal(parseDate('明天', { today: '2026-12-31' })?.dayKey, '2027-01-01');
  assert.equal(parseDate('下个月3号', { today: '2026-12-20' })?.dayKey, '2027-01-03');
  assert.equal(parseDate('明天', { today: '2026-02-28' })?.dayKey, '2026-03-01');
});

test('裸星期指下一个到来的该星期', () => {
  // 基准日 2026-09-30 是周三
  assert.equal(parse('周三要交接口文档')?.dayKey, '2026-10-07', '今天就是周三 → 指下一个周三');
  assert.equal(parse('周三')?.rule, 'bare-weekday');
  assert.equal(parse('周五复盘')?.dayKey, '2026-10-02', '本周内还没到的周五 → 本周五');
  assert.equal(parse('周一交')?.dayKey, '2026-10-05');
  assert.equal(parse('星期日休息')?.dayKey, '2026-10-04', '本周内最近的周日');
  assert.equal(parse('礼拜二')?.dayKey, '2026-10-06');
  assert.equal(parse('星期1')?.dayKey, '2026-10-05', '支持阿拉伯数字');
});

test('裸星期与带前缀写法的语义区分', () => {
  // 刻意区分：
  //   裸"周五"  = 下一个到来的周五（本周内）
  //   "下周五"  = 下一个自然周的周五
  assert.equal(parse('周五')?.dayKey, '2026-10-02', '裸周五 = 本周五');
  assert.equal(parse('下周五')?.dayKey, '2026-10-09', '下周五 = 下一周');
  assert.equal(parse('本周五')?.dayKey, '2026-10-02', '本周五与裸周五同义');
  assert.equal(parse('周三')?.dayKey, '2026-10-07', '本周三已过，两种写法恰好重合');
  assert.equal(parse('下周三')?.rule, 'next-week-weekday');
  assert.equal(parse('周三')?.rule, 'bare-weekday');
});

test('具体日期优先于裸星期', () => {
  const hit = parse('周三之前完成10月20日的报告');
  assert.equal(hit?.dayKey, '2026-10-20');
  assert.equal(hit?.rule, 'month-day');
});

test('反例：不含完整日期表达式的文本必须解析失败', () => {
  const negatives = [
    '看不见的问题排查',
    '整理Q3数据平台迁移方案',
    '接口文档给张三',
    'review PR 1008',
    '讨论一下 3 个方案',
    '把这件事做完',
    '一月份的计划还没写',
    '周报要写',
    '周末计划',
    '周边调研',
    '天后是谁',
    '百万天后的设想',
    '2026年13月40日不存在',
    '',
    '   ',
  ];
  for (const text of negatives) {
    assert.equal(parse(text), null, `不应解析出日期：${text}`);
  }
});

test('显式给出不存在的日期时不做猜测', () => {
  assert.equal(parse('2026年2月30日交'), null, '2 月 30 日不存在，且不应回退到别处');
  assert.equal(parse('下个月32号'), null);
  assert.equal(parse('13月1日'), null);
});

test('日键非法时立即报错', () => {
  assert.throws(() => parseDate('明天', { today: '2026-13-01' }), RangeError);
});

test('剥离日期片段得到干净标题', () => {
  assert.equal(stripParsedDate('接口文档 下周三 给张三', parse('接口文档 下周三 给张三')), '接口文档 给张三');
  assert.equal(stripParsedDate('10月8日交报告', parse('10月8日交报告')), '交报告');
  assert.equal(stripParsedDate(' 纯文本 ', null), '纯文本');
  assert.equal(stripParsedDate('明天', parse('明天')), '');
});

test('中文之间不残留空格，中文与英文之间保留', () => {
  // 曾经的真实缺陷：剥离后拼了个空格，得到"写一份 要交的接口文档"
  assert.equal(
    stripParsedDate('写一份下周三要交的接口文档', parse('写一份下周三要交的接口文档')),
    '写一份要交的接口文档',
  );
  assert.equal(stripParsedDate('周三提交方案', parse('周三提交方案')), '提交方案');
  assert.equal(stripParsedDate('完成report周三', parse('完成report周三')), '完成report', '中英相邻不加空格');
  assert.equal(stripParsedDate('review周三pr', parse('review周三pr')), 'review pr', '英文被日期隔开时保留一个空格');
  assert.equal(stripParsedDate('给张三 下周三 那份', parse('给张三 下周三 那份')), '给张三 那份', '原文自带的空格保留');
});
