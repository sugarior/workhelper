// 路径解析的统一来源。
//
// 默认数据目录必须基于**脚本自身位置**推导，而不是当前工作目录。
// 否则从桌面快捷方式、双击启动或别的目录调用时，会认不出已有的数据库，
// 表现成"我的数据不见了"——而实际上只是找错了库。

import { join, resolve } from 'node:path';

/** 本文件位于 <root>/src/core/paths.ts，因此项目根是上溯三级 */
export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

/** 默认数据目录：<项目根>/data */
export function defaultDataDir(): string {
  return join(PROJECT_ROOT, 'data');
}

/**
 * 把用户给的路径规整成绝对路径。
 * 相对路径的解释基准是**项目根**（不是 cwd），这样任何启动方式都得到同一个库。
 */
export function resolveFromRoot(maybeRelative: string): string {
  return resolve(PROJECT_ROOT, maybeRelative);
}
