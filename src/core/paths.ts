// 路径解析的统一来源。
//
// 默认数据目录必须基于**脚本自身位置**推导，而不是当前工作目录。
// 否则从桌面快捷方式、双击启动或别的目录调用时，会认不出已有的数据库，
// 表现成"我的数据不见了"——而实际上只是找错了库。
//
// 打包后（见 plan-next-steps §4.1）本文件位于 <安装目录>\resources\src\core\paths.ts，
// 因此 PROJECT_ROOT 是 <安装目录>\resources —— **不能**再拿它当数据目录：
// 装到 Program Files 后那里不可写。此时数据目录由外壳显式传入（`--data`）。

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 本文件位于 <root>/src/core/paths.ts，因此上溯两级 */
export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

/** 默认数据目录：<项目根>/data。仅用于**开发态**；打包后由外壳传入 `--data` */
export function defaultDataDir(): string {
  return join(PROJECT_ROOT, 'data');
}

/**
 * 打包默认数据目录：`%APPDATA%\WorkHelper`（Windows）。
 *
 * **为什么不能放在程序目录旁**：安装到 `Program Files` 后那里不可写，
 * 而数据目录要能建库、写 WAL、放备份。
 *
 * 跨平台：非 Windows 用 `$XDG_DATA_HOME`（未设则 `~/.local/share`）。
 * 本项目当前只面向 Windows，但写清楚以免以后误以为它只在 Windows 有效。
 */
export function platformDataDir(): string {
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData.length > 0) return join(appData, 'WorkHelper');
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) return join(xdg, 'workhelper');
  return join(homedir(), '.local', 'share', 'workhelper');
}

/**
 * 把用户给的路径规整成绝对路径。
 *
 * 相对路径的解释基准是**项目根**（不是 cwd），这样任何启动方式都得到同一个库。
 * 注意打包后"项目根"是 `<安装目录>\resources`，因此相对路径在打包态意义不大 ——
 * 外壳传的是绝对路径。
 */
export function resolveFromRoot(maybeRelative: string): string {
  return resolve(PROJECT_ROOT, maybeRelative);
}
