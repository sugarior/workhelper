// 页面与桌面外壳之间的唯一通路。
//
// **为什么单独一个模块**：`__TAURI_INTERNALS__` 的存在性判断原本散落在
// app.js 与 widget.js 两处，而 views.js 也需要调外壳（切焦点后通知悬浮组件重画）
// —— 它**不能** import app.js，那会形成循环依赖（app.js 已经 import 了 views.js）。
// 把这条通路抽出来，三个文件都用同一份实现。
//
// **为什么一律走 `invoke` 命令**：它是在这条链路上唯一被实测证明可靠的 Tauri 能力。
// 事件插件在 `__TAURI_INTERNALS__` 上的调用形态没有验证过，而本项目已经因为
// "没验证就下手"在快记窗上耗过很久（见 shell/src-tauri/src/main.rs 的说明）。

/** 是否运行在桌面外壳里。浏览器里开发时为 false。 */
export function inShell() {
  const internals = globalThis.__TAURI_INTERNALS__;
  return Boolean(internals) && typeof internals.invoke === 'function';
}

/**
 * 调一个外壳命令。失败时返回 `undefined`，不抛。
 *
 * **为什么不抛**：这些调用都是"锦上添花"（通知重画、打开窗口）。
 * 浏览器里开发时它们本来就不可用，而为此打断用户操作是不划算的。
 * 需要知道成败的调用方自己判断返回值即可（例如 `takeWidgetCommand` 返回 0 表示无指令）。
 */
export async function invokeShell(command, args) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return undefined;
  try {
    return await internals.invoke(command, args);
  } catch {
    return undefined;
  }
}

/**
 * 请外壳让悬浮组件重画。
 *
 * 主界面在任何会改变"焦点 / 今日 / 收件箱计数"的操作后调它 ——
 * 否则悬浮组件会一直显示旧任务（它只在加载时刷新一次）。
 */
export function notifyWidget() {
  void invokeShell('notify_widget_refresh');
}
