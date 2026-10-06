// 悬浮小组件的页面逻辑（需求 F-17 + F-15c）。
//
// 两个形态共用一个页面，由外壳决定何时切：
//   idle  —— 一条细栏：当前焦点任务 + 今日未结束 + 收件箱未处理
//   input —— 「记一笔」输入态：顶部显示"记到：…"、类型可选、Enter 提交
//
// **为什么不让页面自己判断该用哪个形态**：只有外壳知道"热键被按了"
// 以及"用户点了别处"（窗口失焦）。页面只负责按指令切换。

import { api } from '/api.js';
import { el, mount } from '/dom.js';
import { inShell, invokeShell } from '/ipc.js';

const taskLabel = document.getElementById('task');
const countToday = document.getElementById('count-today');
const countInbox = document.getElementById('count-inbox');
const expandButton = document.getElementById('expand');
const noteInput = document.getElementById('note');
const saveButton = document.getElementById('save');
const errorBox = document.getElementById('error');
const pickList = document.getElementById('pickList');

const kindSelect = document.getElementById('kind');

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
    // 目标**不在** placeholder 里重复 —— 小条上的任务名就在上面，
    // 而 placeholder 是留给"要写什么"的提示。
    // （曾经把目标写进 placeholder，是因为那时输入态会把小条文字收起来；
    //   现在小条保持不动，再写一遍就是同一信息出现两次。）
    noteInput.placeholder = hasFocus ? '记一笔…' : '先选一个聚焦的任务';
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

// ---------- 选焦点（没有焦点任务时按热键走到这里）----------

/** 候选列表；上下键靠它移动 */
let candidates = [];
let candidateIndex = 0;

/**
 * 进入"选一个焦点"模式。
 *
 * **两个入口都走这里**（用户要求）：
 *   · 按热键时**还没有**焦点任务 —— 把缺的那一步补上
 *   · **点击小条上的任务名** —— 随时换一件（原来只能在无焦点时才能换）
 *
 * **先显示再填内容**（用户反馈"很卡"）：
 * 原来是 `await loadCandidates()` 之后才把面板显示出来 —— 打开前要等一次
 * 网络往返，而点击/按键本来就要求即时反馈。现在立刻显示"读取中…"，
 * 列表到了再替换。
 *
 * 候选数据来自 `focusCandidates()` —— **与主界面聚焦条的下拉同一份**
 * （同一个服务方法、同一个口径：排入今日 + 截止日已到 + 当前焦点例外）。
 * 需求 F-15c 要求"同一个动作的两个位置，不是两套功能"，因此不另写一套筛选。
 */
function enterPickMode() {
  candidates = [];
  candidateIndex = 0;
  // 立刻切形态：这一帧就可见，不等网络
  document.body.classList.add('mode-pick');
  mount(pickList, [el('li', { class: 'pick-item pick-loading' }, '读取中…')]);
  showError('');

  void (async () => {
    const list = await loadCandidates();
    // 期间用户可能已经关掉了面板（点了别处 / 按了 Esc）
    if (!document.body.classList.contains('mode-pick')) return;
    if (list.length === 0) {
      exitPickMode();
      showError('没有可聚焦的任务 —— 先去主界面建一条，或把它排入今日');
      return;
    }
    candidates = list;
    // 默认落在当前焦点那一条上，而不是第一条 ——
    // 用户点开多半是想换，从"我现在这条"开始移动比从列表头开始更顺手。
    const current = list.findIndex((item) => item.isFocused);
    candidateIndex = current >= 0 ? current : 0;
    renderCandidates();
    document.querySelector('.pick-item.active')?.scrollIntoView({ block: 'nearest' });
  })();
}

function exitPickMode() {
  document.body.classList.remove('mode-pick');
  candidates = [];
  candidateIndex = 0;
}

function renderCandidates() {
  mount(pickList, candidates.map((item, index) => el('li', {
    class: `pick-item${index === candidateIndex ? ' active' : ''}`,
    // 鼠标也能选：点一下即选中，不用先移上去再按 Enter
    onclick: () => void confirmPick(index),
  }, [
    el('span', { class: 'pick-title' }, item.title),
    el('span', { class: 'pick-hint' }, [
      item.status === 'todo' ? '选中即开始' : '进行中',
      item.projectTitle === null ? '' : ` · ${item.projectTitle}`,
    ].join('')),
  ])));
}

async function loadCandidates() {
  try {
    return await api.focusCandidates();
  } catch {
    return [];
  }
}

/**
 * 选定候选：先设焦点，**然后直接进入输入态**（用户确认的交互）。
 *
 * 用户按热键的本意是"记一笔"，选任务只是补上缺的那一步 ——
 * 因此不该让人再按一次热键才能开始写。
 */
async function confirmPick(index) {
  const item = candidates[index];
  if (item === undefined) return;
  exitPickMode();
  try {
    await api.focusTask(item.id);
  } catch (error) {
    showError(`聚焦失败：${error.message}`);
    return;
  }
  await refresh();
  // **让主界面也知道焦点变了**（用户实测报告："选完焦点在主页面不同步"）：
  // 主界面顶部的聚焦条显示的是同一个焦点，不同步就会两处不一致。
  void invokeShell('notify_main_refresh');
  enterInputMode();
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

/**
 * 外壳指令码。**必须与 `shell/src-tauri/src/main.rs` 的 `WidgetCommand::code()`
 * 保持一致** —— 两边各有一份数字，改一处就要改另一处（注释已互相指明）。
 *
 * 用数字而不是字符串：轮询每 150ms 一次，数字编码最省事、也不可能拼错。
 */
const CMD = { ENTER_INPUT: 1, REFRESH: 2, PICK_FOCUS: 3 };

/** 告诉外壳：热键被接住了没有（接不住的唯一原因是没焦点任务）。 */
async function reportResult(accepted) {
  await invokeShell('report_note_result', { accepted });
}

let poller = null;

/**
 * 轮询外壳指令。
 *
 * **为什么是轮询而不是事件**：`invoke` 是这条链路上唯一被实测证明可靠的 Tauri 能力
 * （见 ipc.js 的说明）。每 150ms 一次本地命令调用，代价可以忽略。
 */
function startPolling() {
  if (!inShell() || poller !== null) return;
  poller = setInterval(() => {
    void (async () => {
      const code = await invokeShell('take_widget_command');
      if (typeof code !== 'number' || code === 0) return;

      if (code === CMD.REFRESH) {
        // 只重画数据，不动形态 —— 焦点在别处变了，组件跟上
        await refresh();
        return;
      }

      if (code === CMD.PICK_FOCUS) {
        await refresh();
        enterPickMode();
        return;
      }

      // CMD.ENTER_INPUT：用户想记一笔（热键或「展开」按钮）。
      // **有没有焦点任务决定了它的两种结果**，而这个判断只有页面能做：
      //   有焦点 → 直接进输入态（热键的本意就是"记一句"）
      //   没焦点 → 弹出选焦点（否则用户按了键却做不了任何事）
      //
      // 想在**有**焦点时换一件，点小条上的任务名（见下面的 pickButton 绑定）。
      await refresh();
      if (hasFocus) {
        enterInputMode();
        void reportResult(true);
      } else {
        void reportResult(false);
        enterPickMode();
      }
    })();
  }, 150);
}

/**
 * 失焦即收起（输入态与选焦点态都适用）。
 *
 * **为什么会走到这里**：悬浮窗是**很小的一块**（360×260），用户点"别处"
 * 绝大多数时候是点在**窗口之外**（桌面或别的程序）—— 那种点击在页面里
 * 没有事件，只有窗口失焦能感知到。因此这条是"点别处收起"的主要通路。
 *
 * 两个形态都不提交：用户点了别处说明改主意了，替他保存是自作主张。
 */
window.addEventListener('blur', () => {
  if (document.body.classList.contains('mode-pick')) {
    exitPickMode();
    return;
  }
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
    void invokeShell('collapse_widget');
  }
});

/**
 * 选焦点模式的键盘导航（用户要求：上下键选择、Enter 确认）。
 *
 * 挂在 document 上而不是列表元素上：列表项是动态重建的，
 * 而焦点可能在 body 上（选焦点时没有输入框可聚焦）。
 */
document.addEventListener('keydown', (event) => {
  if (!document.body.classList.contains('mode-pick')) return;
  if (candidates.length === 0) {
    // 列表还没到（"读取中…"）：只允许 Esc 关掉，别让方向键空转
    if (event.key === 'Escape') {
      event.preventDefault();
      exitPickMode();
      void invokeShell('collapse_widget');
    }
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    // 循环：从最后一项按 ↓ 回到第一项，省得长列表里来回撞墙
    const step = event.key === 'ArrowDown' ? 1 : -1;
    candidateIndex = (candidateIndex + step + candidates.length) % candidates.length;
    renderCandidates();
    // 让高亮项滚进可视区 —— 超过 5 项时否则选了也看不见
    document.querySelector('.pick-item.active')?.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    void confirmPick(candidateIndex);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    exitPickMode();
    void invokeShell('collapse_widget');
  }
});

/**
 * 点击面板**之外**的页面区域也收起选焦点栏（用户要求）。
 *
 * 为什么还需要这一条（`window.blur` 已经覆盖了窗口外）：窗口内、面板之外
 * 还有一条小横栏与下面的透明区域 —— 点那里时窗口**不失焦**，
 * `blur` 不会触发，而用户的感受就是"点了别处却没收起"。
 *
 * 用 `mousedown` 而不是 `click`：与浮层类交互的惯例一致，
 * 而且按下时就该有反馈，不必等抬手。
 */
document.addEventListener('mousedown', (event) => {
  if (!document.body.classList.contains('mode-pick')) return;
  if (document.getElementById('pick')?.contains(event.target)) return;
  exitPickMode();
});

saveButton.addEventListener('click', () => void submit());

// 展开按钮：把小条变成输入态。
// 与热键走**同一个函数**，因此不存在"鼠标点了与键盘按了行为不一致"的可能。
expandButton.addEventListener('click', () => enterInputMode());

/**
 * 点任务名 → 打开选焦点栏（用户要求）。
 *
 * **为什么这个入口是必要的**：热键在**有**焦点时直接进输入态（那是它的本意），
 * 于是"想换一件"就没有入口了 —— 原来只能先去主界面取消聚焦，绕一大圈。
 * 任务名本身就是那个"我在做哪件"的显示，点它去改是**最自然的指向**。
 *
 * 它在拖动区里（`data-tauri-drag-region="deep"`），但按钮/可点元素默认
 * 阻止拖动，因此点它不会变成拖窗口 —— 两者不冲突。
 */
taskLabel.addEventListener('click', () => void enterPickMode());
// 用光标形状说明它可点：不然没人会去试
taskLabel.style.cursor = 'pointer';
taskLabel.title = '点击切换聚焦任务';

// 说明：**拖动与位置保存不在这里**。
// 拖动由 Tauri 的 `data-tauri-drag-region="deep"` 交给操作系统处理，
// 位置由外壳监听窗口移动事件后写进配置 —— 页面侧无法知道
// "系统级拖动什么时候结束"，在那里猜时机会把位置存成半路的值。
void refresh();
startPolling();
