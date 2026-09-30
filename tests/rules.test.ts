// 领域规则测试：任务状态机与字段一致性校验。
// 状态机是"数据可信"的基础，非法流转必须在服务层被挡住，而不是靠界面不显示按钮。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition, assertCanTransition, allowedTransitions, statusAfterComplete,
  statusAfterBlocker, assertBlockerReason, completionStamp,
  assertDayKey, isValidDayKey, assertBoundaryHour, assertEstimateMinutes,
  assertSortOrder, assertNonEmptyText,
} from '../src/core/domain/rules.ts';
import { InvalidTransitionError, ValidationError } from '../src/core/domain/errors.ts';
import type { TaskStatus } from '../src/core/domain/types.ts';

test('允许的状态流转', () => {
  const allowed: [TaskStatus, TaskStatus][] = [
    ['todo', 'doing'],
    ['todo', 'blocked'],
    ['todo', 'done'],
    ['todo', 'cancelled'],
    ['doing', 'todo'],
    ['doing', 'blocked'],
    ['doing', 'done'],
    ['doing', 'cancelled'],
    ['blocked', 'doing'],
    ['blocked', 'todo'],
    ['blocked', 'cancelled'],
    ['done', 'doing'],
    ['done', 'todo'],
    ['cancelled', 'todo'],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransition(from, to), true, `应允许 ${from} → ${to}`);
  }
});

test('不允许的状态流转', () => {
  const denied: [TaskStatus, TaskStatus][] = [
    ['blocked', 'done'],
    ['cancelled', 'doing'],
    ['cancelled', 'done'],
    ['done', 'cancelled'],
    ['done', 'blocked'],
  ];
  for (const [from, to] of denied) {
    assert.equal(canTransition(from, to), false, `应拒绝 ${from} → ${to}`);
  }
});

test('自身流转视为无变化并允许', () => {
  for (const status of ['todo', 'doing', 'blocked', 'done', 'cancelled'] as TaskStatus[]) {
    assert.equal(canTransition(status, status), true, `${status} → ${status} 应为 no-op`);
  }
});

test('非法流转抛出领域错误并说明可选路径', () => {
  assert.throws(
    () => assertCanTransition('blocked', 'done'),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.match(error.message, /blocked/);
      assert.match(error.message, /doing/, '错误信息应列出允许的目标状态');
      return true;
    },
  );
});

test('允许的流转列表随状态变化', () => {
  assert.deepEqual(allowedTransitions('todo'), ['doing', 'blocked', 'done', 'cancelled']);
  assert.deepEqual(allowedTransitions('blocked'), ['doing', 'todo', 'cancelled']);
  assert.deepEqual(allowedTransitions('done'), ['doing', 'todo']);
});

test('完成任务：已取消的任务不能直接完成', () => {
  assert.equal(statusAfterComplete('todo'), 'done');
  assert.equal(statusAfterComplete('doing'), 'done');
  assert.equal(statusAfterComplete('blocked'), 'done', '阻塞任务可解除阻塞后完成，状态机另行约束');
  assert.throws(() => statusAfterComplete('cancelled'), InvalidTransitionError);
});

test('加卡点：todo 与 doing 都能转为阻塞，终态不接受卡点', () => {
  // todo → blocked 必须允许：现实中"还没开始就被卡住"很常见（等外部依赖）。
  // 若禁止，用户只能先假装"进行中"再卡住，状态就失真了。
  assert.equal(statusAfterBlocker('todo'), 'blocked');
  assert.equal(canTransition('todo', 'blocked'), true, '状态机必须与 statusAfterBlocker 一致');
  assert.equal(statusAfterBlocker('doing'), 'blocked');
  assert.equal(statusAfterBlocker('blocked'), 'blocked');
  assert.throws(() => statusAfterBlocker('done'), InvalidTransitionError);
  assert.throws(() => statusAfterBlocker('cancelled'), InvalidTransitionError);
});

test('阻塞必须有原因', () => {
  assert.doesNotThrow(() => assertBlockerReason('等法务确认'));
  assert.throws(() => assertBlockerReason(null), ValidationError);
  assert.throws(() => assertBlockerReason(undefined), ValidationError);
  assert.throws(() => assertBlockerReason('   '), ValidationError, '纯空白不算原因');
});

test('完成时间戳只在状态切换时变动', () => {
  const now = '2026-09-30T10:00:00.000Z';
  const earlier = '2026-09-29T10:00:00.000Z';

  assert.equal(completionStamp('done', null, now), now, '首次完成写入水印');
  assert.equal(completionStamp('done', earlier, now), earlier, '重复标记完成保留原水印');
  assert.equal(completionStamp('doing', earlier, now), null, '离开完成态清除水印');
  assert.equal(completionStamp('todo', null, now), null);
  assert.equal(completionStamp('blocked', earlier, now), null);
});

test('日键校验', () => {
  assert.doesNotThrow(() => assertDayKey('2026-09-30'));
  assert.throws(() => assertDayKey('2026/09/30'), ValidationError);
  assert.throws(() => assertDayKey('2026-9-30'), ValidationError);
  assert.equal(isValidDayKey('2026-09-30'), true);
  assert.equal(isValidDayKey('2026-09-30 '), false);
});

test('日界小时校验', () => {
  assert.doesNotThrow(() => assertBoundaryHour(0));
  assert.doesNotThrow(() => assertBoundaryHour(4));
  assert.doesNotThrow(() => assertBoundaryHour(23));
  assert.throws(() => assertBoundaryHour(24), ValidationError);
  assert.throws(() => assertBoundaryHour(-1), ValidationError);
  assert.throws(() => assertBoundaryHour(3.5), ValidationError);
});

test('预估时长校验：正整数或留空', () => {
  assert.doesNotThrow(() => assertEstimateMinutes(null));
  assert.doesNotThrow(() => assertEstimateMinutes(30));
  assert.throws(() => assertEstimateMinutes(0), ValidationError);
  assert.throws(() => assertEstimateMinutes(-5), ValidationError);
  assert.throws(() => assertEstimateMinutes(2.5), ValidationError);
});

test('排序值校验：非负有限数', () => {
  assert.doesNotThrow(() => assertSortOrder(0));
  assert.doesNotThrow(() => assertSortOrder(1.5));
  assert.throws(() => assertSortOrder(-1), ValidationError);
  assert.throws(() => assertSortOrder(Number.NaN), ValidationError);
  assert.throws(() => assertSortOrder(Number.POSITIVE_INFINITY), ValidationError);
});

test('必填文本校验并返回去空白结果', () => {
  assert.equal(assertNonEmptyText('  交报告  ', '标题'), '交报告');
  assert.throws(() => assertNonEmptyText('', '标题'), ValidationError);
  assert.throws(() => assertNonEmptyText('   ', '标题'), ValidationError);
});
