// 极简 DOM 工具。不引入框架——界面规模不足以抵消框架带来的构建与调试成本。

/**
 * 递归摊平 children，并丢掉 null/undefined/false。
 *
 * 为什么必须递归：调用处很自然会写成"数组里套数组"
 * （例如 `mount(root, [标题, 统计, 区块数组])`），
 * 若只判断最外层，内层数组会走到 `String(child)` 分支，
 * 页面上就出现 `[object HTMLDivElement]` —— 本项目真实发生过。
 */
function flattenNodes(input, out = []) {
  if (input === null || input === undefined || input === false) return out;
  if (Array.isArray(input)) {
    for (const item of input) flattenNodes(item, out);
    return out;
  }
  out.push(input);
  return out;
}

function appendAll(node, children) {
  for (const child of flattenNodes(Array.isArray(children) ? children : [children])) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 创建元素：el('div', {class:'x'}, '文本' | [子元素] | [[嵌套子元素]]) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'onclick' || key === 'oninput' || key === 'onchange' || key === 'onkeydown') {
      node.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'checked' || key === 'disabled' || key === 'selected') {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendAll(node, children);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node, children) {
  clear(node);
  appendAll(node, children);
}

export function shortId(id) {
  return (id ?? '').slice(0, 8);
}

/** 本地日期 → YYYY-MM-DD（不能用 toISOString，那是 UTC，会差一天） */
export function toDayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayDayKey() {
  return toDayKey(new Date());
}

/** ISO 时间戳 → 本地 HH:MM */
export function timeOf(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeOf(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 在页面右上角闪一条提示（成功类反馈，不做阻塞式弹窗） */
export function flash(message, kind = 'ok') {
  const node = el('div', { class: 'saved-toast' }, message);
  if (kind === 'error') node.style.background = 'var(--danger)';
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 1400);
}

/** 把异步操作包成"先禁用按钮、失败则提示"的形式，避免重复点击 */
export async function withBusy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    flash(error.message ?? String(error), 'error');
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

export const STATUS_MARK = { todo: '☐', doing: '◐', blocked: '⛔', done: '☑', cancelled: '⊘' };
export const PROGRESS_LABEL = { progress: '进展', blocker: '卡点', decision: '决定', waiting: '等待' };
