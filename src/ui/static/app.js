// 主界面外壳：标签路由、收件箱计数、全局搜索。
// 各页签的渲染在 views.js 里，本文件只负责"现在显示哪一页"。

import { api } from '/api.js';
import { el, mount, shortId, flash } from '/dom.js';
import { inShell, invokeShell } from '/ipc.js';
import {
  renderInbox, renderAll, renderToday, renderProjects, renderLog, renderTrash, renderMaterials,
  renderFocusBar, focusNoteInput, setRefreshHook,
  // 搜索结果定位（F-15）：路由与"渲染后高亮"都在 views.js 里 ——
  // 它才知道 allMode 之类的模块状态，也知道每个实体由谁画出来。
  canLocate, prepareLocate, applyPendingHighlight,
} from '/views.js';

const viewBox = document.getElementById('view');
const tabsBox = document.getElementById('tabs');
const inboxBadge = document.getElementById('badge-inbox');
const openBadge = document.getElementById('badge-open');
const focusBar = document.getElementById('focus-bar');
const searchInput = document.getElementById('search');
const trashCount = document.getElementById('trash-count');
const trashButton = document.getElementById('open-trash');

const RENDERERS = {
  inbox: renderInbox,
  all: renderAll,
  today: renderToday,
  materials: renderMaterials,
  projects: renderProjects,
  log: renderLog,
  // 回收站不是页签而是右上角入口（需求 F-21b：低频、偏系统，不占主导航）。
  // 但它仍然是一条"当前显示哪一页"的路由，所以放在同一张表里。
  trash: renderTrash,
};

/** 当前页签；页面刷新后丢失是可以接受的，不值得为它引入持久化 */
let currentTab = 'inbox';

/** 供各视图在数据变化后请求重绘（避免视图之间互相 import） */
async function refresh(tab = currentTab) {
  await render(tab);
}
setRefreshHook(refresh);

/**
 * 两个计数徽标：收件箱积压 与 全部未结束任务。
 *
 * 后者是需求 §6.6 契约 V3 的落点 —— 未结束的任务数必须常驻可见，
 * 否则"零门槛捕获"会变成"零门槛丢事"而我不知道。
 */
async function refreshBadges() {
  try {
    const pending = await api.countPending();
    inboxBadge.textContent = String(pending);
    inboxBadge.classList.toggle('zero', pending === 0);
  } catch {
    inboxBadge.classList.add('zero');
  }

  try {
    const view = await api.openTasksView();
    openBadge.textContent = String(view.total);
    openBadge.classList.toggle('zero', view.total === 0);
    // 有逾期时用红色提醒：这不是催促，是事实
    openBadge.classList.toggle('alert', view.overdueCount > 0);
  } catch {
    openBadge.classList.add('zero');
  }

  // 回收站入口带数量：里面攒着东西却不显示，等于又造了一个"看不见的黑洞"
  try {
    const overview = await api.trashOverview();
    const total = overview.counts.deleted + overview.counts.ignored;
    trashCount.textContent = String(total);
    trashCount.classList.toggle('zero', total === 0);
  } catch {
    trashCount.classList.add('zero');
  }
}

async function render(tab) {
  currentTab = tab;
  for (const button of tabsBox.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }

  // 切页签时把搜索框让出来，避免上一次的搜索结果压住新页面
  mount(viewBox, el('div', { class: 'empty' }, '加载中…'));

  try {
    await RENDERERS[tab](viewBox);
  } catch (error) {
    mount(viewBox, el('div', { class: 'empty' }, `加载失败：${error.message}`));
  }
  void refreshBadges();
  // 焦点条要跟着刷新：任务可能在这里被聚焦/完成/卡住，焦点也就变了。
  //
  // **必须 await**：它内部会 mount 出新的输入框，并把模块级的
  // `focusBarInput` 指向新元素。不等待的话，调用方在它返回前就去聚焦
  // —— 那时拿到的是**刚被替换掉的旧元素**，对它调 `focus()` 不报错但完全无效。
  // 这正是"按了记一笔热键、光标却没进输入框"的原因。
  await renderFocusBar(focusBar, refresh);
}

tabsBox.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button !== null) void render(button.dataset.tab);
});

document.getElementById('quick-capture').addEventListener('click', () => {
  // **必须走外壳命令，不能用 `window.open`** ——
  // 后者在浏览器里能用，在 Tauri 的 WebView 里被拦截（Tauri 默认不允许网页开新窗口），
  // 表现成"点了没反应"。这正是"同一件事两条路、其中一条不通"的典型形态。
  //
  // 外壳里那个命令与全局热键调的是**同一个函数**，
  // 因此按钮与热键是同一个动作的两个位置，不是两套实现。
  // 浏览器里开发时 `invokeShell` 静默失败，此时退回 window.open 保持可用。
  if (inShell()) {
    void invokeShell('open_capture_window_command');
  } else {
    window.open('/capture', 'wh-capture', 'width=680,height=330,menubar=no,toolbar=no');
  }
});

// 回收站入口（需求 F-21b）：右上角，与页签同一行但不占页签位。
// 再点一次回到来之前那一页 —— 它是"去看一眼"，不是"换一个工作区"。
let tabBeforeTrash = 'inbox';
trashButton.addEventListener('click', () => {
  if (currentTab === 'trash') void render(tabBeforeTrash);
  else {
    tabBeforeTrash = currentTab;
    void render('trash');
  }
});

// ---------- 全局搜索 ----------

let searchTimer = null;

async function runSearch() {
  const query = searchInput.value.trim();
  if (query.length === 0) {
    await render(currentTab);
    return;
  }

  try {
    const hits = await api.search(query);
    if (hits.length === 0) {
      mount(viewBox, el('div', { class: 'empty' }, `没有找到与「${query}」相关的内容`));
      return;
    }
    mount(viewBox, [
      el('h2', {}, ['搜索结果 ', el('span', { class: 'count' }, `共 ${hits.length} 条`)]),
      el('ul', { class: 'list' }, hits.map((hit) => buildSearchRow(hit))),
    ]);
  } catch (error) {
    mount(viewBox, el('div', { class: 'empty' }, `搜索失败：${error.message}`));
  }
}

/**
 * 一条搜索结果。
 *
 * **可定位的做成按钮，不可定位的保持纯文本** —— 这是本函数最重要的决定。
 *
 * 搜索结果里有 7 类实体，而本轮只支持其中 3 类（收件箱/资料/任务）。
 * 若把全部结果都做成可点击的，点另外 4 类就会**毫无反应** ——
 * 那正是需求 F-05 明确要避免的形态（"按了没反应"是最难排查的）。
 * 因此这里按能力区分：能跳的给按钮样式与悬停提示，不能跳的明说一句。
 */
function buildSearchRow(hit) {
  const locatable = canLocate(hit.entityType);
  const body = el('div', { class: 'item-body' }, [
    el('div', { class: 'item-title' }, hit.displayTitle || hit.body || '（无标题）'),
    el('div', { class: 'item-meta' }, [
      el('span', {}, shortId(hit.entityId)),
      hit.alive ? null : el('span', { class: 'tag blocked' }, '索引残留'),
      locatable
        ? el('span', { class: 'search-go' }, '点击定位 →')
        : el('span', { class: 'search-no-go' }, `「${hit.entityLabel}」暂不支持定位`),
    ]),
  ]);

  if (!locatable) {
    return el('li', {}, [el('span', { class: 'tag' }, hit.entityLabel), body]);
  }

  return el('li', {}, [
    el('span', { class: 'tag' }, hit.entityLabel),
    el('button', {
      class: 'search-hit',
      title: `跳到「${hit.entityLabel}」并高亮这一条`,
      onclick: () => void locateSearchHit(hit),
    }, body),
  ]);
}

/**
 * 跳到某条搜索结果所在的位置并高亮它。
 *
 * 这一步要**先问 views.js 该去哪个页签**（它知道 `allMode` 之类的模块状态），
 * 因此顺序是：问路由 → 切页签并渲染 → 由 views.js 在渲染后定位高亮。
 */
async function locateSearchHit(hit) {
  const plan = await prepareLocate(hit.entityType, hit.entityId);
  if (plan === null) {
    flash(`「${hit.entityLabel}」暂不支持定位`, 'error');
    return;
  }

  // 让搜索框让出位置：否则下一次刷新会又跳回搜索结果
  searchInput.value = '';

  await render(plan.tab);
  if (plan.modeNote !== null) flash(plan.modeNote);

  // **必须在 render 之后**：目标行是这次渲染刚建出来的，之前不存在
  applyPendingHighlight();
}

searchInput.addEventListener('input', () => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 220);
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    searchInput.value = '';
    void render(currentTab);
  }
});

// ---------- 快捷键 ----------
//
// 注：这三个都是**浏览器内**快捷键，只在页面有焦点时有效。
// 真正的全局热键要等 M1 的 Tauri 外壳（浏览器无法做到不抢焦点）。
document.addEventListener('keydown', (event) => {
  // Ctrl+K 聚焦搜索
  if (event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  // Ctrl+Alt+Space：速记板 —— "冒出个新想法"，新建收件箱条目
  if (event.ctrlKey && event.altKey && event.code === 'Space') {
    event.preventDefault();
    window.open('/capture', 'wh-capture', 'width=680,height=330,menubar=no,toolbar=no');
    return;
  }
  // Ctrl+Shift+Space：记一笔 —— "刚才做的这件事有进展"，记到当前焦点任务（F-15c）
  // 与速记板刻意分开：混在一起会把新想法误记到当前任务上。
  if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
    event.preventDefault();
    focusNoteFromShortcut();
  }
});

/**
 * 让「记一笔」输入框就位；没有焦点任务时说清原因。
 *
 * **为什么"没有焦点任务"必须显式说出来**：那一刻用户的意图是"记一笔"，
 * 而系统做不了。如果什么都不显示，用户只会觉得"按了没反应" ——
 * 需求 F-05 明确要避免这种形态（热键静默失效是最难排查的）。
 */
function focusNoteFromShortcut() {
  const ok = focusNoteInput();
  if (!ok) {
    flash('还没有聚焦的任务 —— 先去「全部」里对一条任务点「聚焦」', 'error');
  }
  return ok;
}

/**
 * 托盘要求主窗口切到某一页（F-16 的「今日」「收件箱」「设置」）。
 *
 * **与 `take_main_refresh` 共用同一个轮询循环**（见 `startShellPolling`）：
 * 两者都是"外壳有话要对主窗口说"，分成两个 200ms 定时器没有意义，
 * 而且两处各自维护启停状态只会增加出错面。
 */
async function acceptPendingTab() {
  const tab = await invokeShell('take_pending_tab');
  if (typeof tab !== 'string' || tab === '') return;
  // 未知页签说明外壳与页面对不上（例如设置页还没做）。
  // **不静默忽略**：否则表现成"从托盘点设置没反应"（F-05 要避免的形态）。
  if (RENDERERS[tab] === undefined) {
    flash(`还没有「${tab}」这一页 —— 该功能尚未实现`, 'error');
    return;
  }
  await render(tab);
}

// 页面重新获得焦点时刷新，这样从快记窗回来就能看到新记录。
// **不再顺带启停轮询**：外壳的话什么时候都可能来（从托盘点菜单时窗口正是隐藏的），
// 因此轮询常驻（见下方 startShellPolling）。
window.addEventListener('focus', () => void refresh());

/**
 * 轮询外壳对主窗口说的话。
 *
 * **两件事共用一个循环**：数据变了该重画、托盘要求切页签。
 * 它们都是"外壳有话要说"，拆成两个 200ms 定时器没有意义，
 * 而且两处各自维护启停状态只增加出错面。
 *
 * **为什么需要"该重画了"**：悬浮组件里也能改焦点（点小条上的任务名切换）——
 * 那之后主界面顶部的聚焦条仍显示旧任务，两处就不一致了。
 * 依赖 `window.focus` 刷新解决不了：窗口可能**本来就是**聚焦的，
 * 那种情况下 focus 事件不会再触发。
 *
 * **为什么轮询常驻、不再随窗口焦点启停**（原来的做法）：
 * 从托盘点「今日」时主窗口**正是隐藏的**，若轮询只在有焦点时跑，
 * 那条指令就会一直躺在那里没人取 —— 表现成"点了托盘菜单没反应"。
 * 代价是每 200ms 两次本地命令调用，可以忽略。
 */
let shellPoller = null;

function startShellPolling() {
  if (!inShell() || shellPoller !== null) return;
  shellPoller = setInterval(() => {
    void (async () => {
      // 顺序有讲究：先处理"切页签"（那是用户明确的动作），
      // 再处理"重画"（后台数据变化）。反过来会先重画一次当前页、再切走，白画一次。
      await acceptPendingTab();
      if (await invokeShell('take_main_refresh')) await refresh();
    })();
  }, 200);
}

startShellPolling();

void render('inbox');
