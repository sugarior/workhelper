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
 * 外壳命令的超时。
 *
 * **必须有**：`invoke` 在正常情况下毫秒级返回，但如果**永不 settle**
 * （外壳主线程卡住、WebView 与外壳之间的通道出问题），调用方的 `await`
 * 就永远挂着 —— 而 `invokeShell` 的调用方遍布界面（40 多处），
 * 其中一处挂住就会让整个页面永久卡在"加载中"。
 *
 * 用户实测报过这个现象：**设置页一直显示"加载中"**。设置页恰好是
 * "必须等外壳回话才能画"的页面，因此它是这个问题最明显的受害者。
 *
 * 取 5 秒：本地命令调用正常情况下远低于此（毫秒级），因此这个上限
 * 只会在真出问题时触发；而 5 秒也短到用户能接受"等一下然后看到一句说明"。
 */
const INVOKE_TIMEOUT_MS = 5000;

/**
 * 调一个外壳命令。失败或超时都返回 `undefined`，不抛。
 *
 * **为什么不抛**：这些调用多数是"锦上添花"（通知重画、打开窗口）。
 * 浏览器里开发时它们本来就不可用，而为此打断用户操作是不划算的。
 * 需要知道成败的调用方自己判断返回值即可（例如 `takeWidgetCommand` 返回 0 表示无指令）。
 *
 * **超时后不取消底层调用**：`invoke` 没有取消接口。这里只是不再等它 ——
 * 结果是"调用方可以继续"，而不是"调用被撤销"。对上述用途足够了。
 */
export async function invokeShell(command, args) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return undefined;
  try {
    return await Promise.race([
      internals.invoke(command, args),
      new Promise((resolve) => setTimeout(() => resolve(undefined), INVOKE_TIMEOUT_MS)),
    ]);
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
