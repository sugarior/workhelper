// 悬浮小组件的页面逻辑（需求 F-17 + F-15c）。
//
// 两个形态共用一个页面，由外壳决定何时切：
//   idle  —— 一条细栏：当前焦点任务 + 今日未结束 + 收件箱未处理
//   input —— 「记一笔」输入态：顶部显示"记到：…"、类型可选、Enter 提交
//
// **为什么不让页面自己判断该用哪个形态**：只有外壳知道"热键被按了"
// 以及"用户点了别处"（窗口失焦）。页面只负责按指令切换。

import { api } from '/api.js';

const taskLabel = document.getElementById('task');
const countToday = document.getElementById('count-today');
const countInbox = document.getElementById('count-inbox');
const collapseButton = document.getElementById('collapse');
const targetLabel = document.getElementById('target');
const kindSelect = document.getElementById('kind');
const noteInput = document.getElementById('note');
const saveButton = document.getElementById('save');
const errorBox = document.getElementById('error');

/** 当前是否有焦点任务。没有就不能记一笔 —— 目标由焦点决定（F-15c）。 */
let hasFocus = false;
/** 已提交/已收起，避免 Enter 与按钮连点造成重复写入 */
let busy = false;

/**
 * 面板不透明度（需求 F-17"可调透明度"）。
 *
 * 由外壳通过 URL 参数传入 —— 窗口级透明度 Tauri 2 不支持，
 * 而且那会把文字一起变淡；调背景的 alpha 才能"面板更透、字仍然清楚"。
 */
const opacityParam = Number(new URLSearchParams(location.search).get('opacity'));
if (Number.isFinite(opacityParam) && opacityParam > 0) {
  document.documentElement.style.setProperty('--widget-alpha', String(opacityParam));
}

// ---------- 数据刷新 ----------

function setCount(node, value) {
  node.textContent = String(value);
  node.classList.toggle('zero', value === 0);
}

async function refresh() {
  try {
    const [focus, today] = await Promise.all([api.focus(), api.todayView()]);
    hasFocus = focus !== null;
    document.body.classList.toggle('has-focus', hasFocus);
    taskLabel.textContent = hasFocus ? focus.title : '没有聚焦的任务';
    // F-17 指定的两条数字：今日未结束 + 收件箱未处理
    setCount(countToday, today.counts.open);
    setCount(countInbox, today.inboxCount);
    targetLabel.textContent = hasFocus ? `记到：${focus.title}` : '';
  } catch {
    // 内核还没起来（应用刚启动）时会走到这里。**不显示错误** ——
    // 那不是用户的错，也没有他能做的事；显示"加载失败"只会让人以为坏了。
    taskLabel.textContent = '正在连接…';
  }
}

// ---------- 形态切换 ----------

function showError(message, ok = false) {
  errorBox.textContent = message;
  errorBox.classList.toggle('ok', ok);
}

/** 切成输入态：清空上次的内容、聚焦输入框。 */
export function enterInputMode() {
  busy = false;
  noteInput.value = '';
  showError('');
  document.body.classList.add('mode-input');
  // 聚焦必须在移除 display:none 之后 —— 不可见元素无法获得焦点
  noteInput.focus();
  if (!hasFocus) {
    showError('还没有聚焦的任务 —— 打开主界面，对一条任务点「聚焦」');
  }
}

/** 切回 idle。`keepCounts` 让提交成功后不必等一次网络往返就能显示新数字。 */
export function exitInputMode() {
  document.body.classList.remove('mode-input');
  noteInput.value = '';
  showError('');
}

// ---------- 提交 ----------

async function submit() {
  if (busy) return;
  const body = noteInput.value.trim();
  if (body.length === 0) return;
  if (!hasFocus) {
    showError('还没有聚焦的任务 —— 打开主界面，对一条任务点「聚焦」');
    return;
  }

  busy = true;
  saveButton.disabled = true;
  try {
    await api.noteOnFocus({ kind: kindSelect.value, body });
    showError('已记入当前任务', true);
    // 立刻收起，不等刷新 —— 记一笔要求"到记完 ≤ 3 秒"，
    // 而数字晚一拍更新没人会注意，多等一次往返却会让人以为没反应。
    exitInputMode();
    void refresh();
    void reportResult(true);
  } catch (error) {
    // 契约 3：失败时就地显示原因，**不收窗**（否则内容丢了用户还得重打）
    showError(`记录失败：${error.message}`);
  } finally {
    busy = false;
    saveButton.disabled = false;
  }
}

// ---------- 与外壳通信 ----------
//
// 用「命令调用 + 轮询」而不是事件：页面侧唯一被实测证明可靠的 Tauri 能力是
// `invoke`（见 shell/src-tauri/src/main.rs 的 request_note_input 说明）。

const internals = globalThis.__TAURI_INTERNALS__;

/** 告诉外壳：热键被接住了没有（接不住的唯一原因是没焦点任务）。 */
async function reportResult(accepted) {
  if (!internals || typeof internals.invoke !== 'function') return;
  try {
    await internals.invoke('report_note_result', { accepted });
  } catch {
    // 静默：这只是外壳侧的日志
  }
}

let poller = null;

function startPolling() {
  if (!internals || typeof internals.invoke !== 'function' || poller !== null) return;
  poller = setInterval(() => {
    void (async () => {
      try {
        if (await internals.invoke('take_note_request')) {
          await refresh();
          enterInputMode();
          void reportResult(hasFocus);
        }
      } catch {
        // 取不到就跳过这一轮
      }
    })();
  }, 150);
}

/**
 * 失焦即收起。
 *
 * **只在输入态需要**：idle 时组件本来就不该抢焦点，失焦是常态。
 * 而且失焦收起**不提交** —— 用户点了别处说明改主意了，替他保存是自作主张。
 */
window.addEventListener('blur', () => {
  if (document.body.classList.contains('mode-input')) exitInputMode();
});

// ---------- 交互 ----------

noteInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void submit();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    // Esc 收起且不提交，并把焦点还给刚才那个程序（外壳负责把窗口藏回去）
    exitInputMode();
    void (async () => {
      if (internals?.invoke) await internals.invoke('collapse_widget').catch(() => {});
    })();
  }
});

saveButton.addEventListener('click', () => void submit());

collapseButton.addEventListener('click', () => {
  void (async () => {
    if (internals?.invoke) await internals.invoke('collapse_widget').catch(() => {});
  })();
});

/**
 * 拖动结束后把位置报给外壳保存。
 *
 * **为什么在这里报而不是在移动过程中**：移动过程每秒几十次，
 * 每次都写配置文件既无意义又伤盘。松手时一次就够。
 * 位置本身由外壳通过 `data-tauri-drag-region` 处理，页面只管"拖完了"这个时点。
 */
document.addEventListener('mouseup', () => {
  void (async () => {
    if (!internals?.invoke) return;
    try {
      await internals.invoke('save_widget_position');
    } catch {
      // 存不住最多是下次回到默认位置，不值得打扰用户
    }
  })();
});

void refresh();
startPolling();
