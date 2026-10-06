// 主界面外壳：标签路由、收件箱计数、全局搜索。
// 各页签的渲染在 views.js 里，本文件只负责"现在显示哪一页"。

import { api } from '/api.js';
import { el, mount, shortId, flash } from '/dom.js';
import {
  renderInbox, renderAll, renderToday, renderProjects, renderLog, renderTrash, renderMaterials,
  renderFocusBar, focusNoteInput, setRefreshHook,
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
  window.open('/capture', 'wh-capture', 'width=680,height=330,menubar=no,toolbar=no');
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
      el('ul', { class: 'list' }, hits.map((hit) => el('li', {}, [
        el('span', { class: 'tag' }, hit.entityLabel),
        el('div', { class: 'item-body' }, [
          el('div', { class: 'item-title' }, hit.displayTitle || hit.body || '（无标题）'),
          el('div', { class: 'item-meta' }, [
            el('span', {}, shortId(hit.entityId)),
            hit.alive ? null : el('span', { class: 'tag blocked' }, '索引残留'),
          ]),
        ]),
      ]))),
    ]);
  } catch (error) {
    mount(viewBox, el('div', { class: 'empty' }, `搜索失败：${error.message}`));
  }
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
 * 桌面壳里的全局热键（F-15c）通过**标记 + 轮询**通知本页面。
 *
 * **与上面那段键盘监听的分工**：
 *   · 页面有焦点时 —— 页面自己的监听就够，不需要外壳参与
 *   · 页面没焦点时 —— 只有外壳的全局热键能收到，它把窗口带到前面并置一个标记
 * 两条路最后都调用同一个 `focusNoteFromShortcut()`，
 * **不是两套功能**（需求 F-15c 的原话："同一个动作的两个位置"）。
 *
 * **为什么是轮询而不是事件**：页面侧唯一被实测证明可靠的 Tauri 能力是 `invoke`
 * （命令调用）；事件插件在 `__TAURI_INTERNALS__` 上的调用形态没有验证过，
 * 而本项目已经因为"没验证就下手"在快记窗上耗过很久。这里只走 `invoke` 一条路。
 *
 * **轮询只在窗口有焦点时进行** —— 没焦点时按热键，外壳会把窗口带到前面，
 * 随之触发 focus 事件开始轮询。因此空转极少（每 200ms 一次本地命令调用）。
 */
let notePoller = null;

function startNotePolling() {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function' || notePoller !== null) return;
  notePoller = setInterval(() => {
    void (async () => {
      try {
        // 外壳取值即清零，因此一次按键只会被取走一次
        if (await internals.invoke('take_note_request')) await acceptNoteRequest();
      } catch {
        // 取不到就跳过这一轮：这不是用户可见的功能，不该因为一次失败就弹错
      }
    })();
  }, 200);
}

function stopNotePolling() {
  if (notePoller === null) return;
  clearInterval(notePoller);
  notePoller = null;
}

/**
 * 热键生效：把焦点放进「记一笔」输入框。
 *
 * **必须先刷新再聚焦**：`window` 的 focus 事件会触发整页重绘，
 * 而重绘会把焦点条的输入框换成新元素 —— 这时旧的引用已经不在文档里，
 * 聚焦它等于没聚焦（用户看到"按了热键但光标不在输入框"）。
 */
async function acceptNoteRequest() {
  stopNotePolling();
  await refresh();
  const ok = focusNoteFromShortcut();
  const internals = globalThis.__TAURI_INTERNALS__;
  // 回话让外壳知道结果。失败不影响用户 —— 提示已经由 focusNoteFromShortcut 显示。
  try {
    await internals.invoke('report_note_result', { accepted: ok });
  } catch {
    // 静默：这只是外壳侧的日志
  }
}

// 页面重新获得焦点时刷新，这样从快记窗回来就能看到新记录。
// 顺带开始轮询「记一笔」热键标记 —— 外壳正是把窗口带到前面来通知我们的。
window.addEventListener('focus', () => {
  void refresh();
  startNotePolling();
});
window.addEventListener('blur', stopNotePolling);

// 窗口一开始就是聚焦的，因此启动时也要轮询（只靠 focus 事件会漏掉首次）
startNotePolling();

void render('inbox');
