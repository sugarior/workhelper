// 快记窗：整个产品的成败所系的一屏。
//
// 需求 §6 的五条交互契约在这里逐条落地：
//  1. 不抢焦点        —— 打开即聚焦输入框；保存后立刻把窗口还给原来的程序（见 closeWindow）
//  2. 默认值必须正确  —— 默认落在收件箱，不选类型、不设时间也能存
//  3. 不存在保存失败  —— 失败时窗口不关闭，只在下方显示一行红字，不做弹窗
//  4. 解析只是建议    —— 识别到日期才显示浅色标签；识别不到则一个元素都不显示
//  5. 不阻断          —— Enter 保存、Shift+Enter 换行、Esc 取消、Tab 在类型间移动

import { api } from '/api.js';
import { el, mount } from '/dom.js';

const textarea = document.getElementById('text');
const hintBox = document.getElementById('hint');
const errorBox = document.getElementById('error');
const saveButton = document.getElementById('save');
const chipsBox = document.getElementById('chips');

let kindHint = 'todo';
let parseTimer = null;
/** 已保存就进入收尾流程，避免 Enter 与按钮双击造成重复写入 */
let finished = false;

// ---------- 解析提示 ----------

function renderHint(result) {
  // 契约 4：没有可提示的内容时，DOM 里不留任何元素
  if (result.parsed === null && result.title === '') {
    mount(hintBox, []);
    return;
  }

  const nodes = [];
  if (result.parsed !== null) {
    nodes.push(el('span', { class: 'tag due' }, `截止 ${result.parsed.dayKey}`));
    nodes.push(el('span', { class: 'title-preview' }, `　标题将存为「${result.title}」`));
  }
  mount(hintBox, nodes);
}

async function refreshHint() {
  const text = textarea.value;
  if (text.trim().length === 0) {
    mount(hintBox, []);
    return;
  }
  try {
    const result = await api.quickCapture({ text, kindHint, dryRun: true });
    if (finished) return;
    renderHint(result);
  } catch {
    // 预览失败静默处理：预览是辅助信息，不能因为它出错就打扰用户
    mount(hintBox, []);
  }
}

// 边打字边解析有网络往返，节流到 180ms，肉眼看不出延迟也不会打满请求
textarea.addEventListener('input', () => {
  if (parseTimer !== null) clearTimeout(parseTimer);
  parseTimer = setTimeout(() => void refreshHint(), 180);
});

// ---------- 类型芯片（键盘可达，且不夺走输入框焦点）----------

function selectKind(kind) {
  kindHint = kind;
  for (const chip of chipsBox.querySelectorAll('.chip')) {
    const selected = chip.dataset.kind === kind;
    chip.classList.toggle('selected', selected);
    chip.setAttribute('aria-checked', String(selected));
  }
}

chipsBox.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (chip !== null) selectKind(chip.dataset.kind);
});

// Tab 在三个区域间循环：输入框 → 芯片组 → 保存按钮
chipsBox.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  selectKind(kindHint === 'todo' ? 'note' : 'todo');
});

// ---------- 保存与关闭 ----------

function showError(message) {
  errorBox.textContent = message;
}

/** 保存成功后收起窗口。浏览器里能关就关；关不掉则退化成一次性提示。 */
function closeWindow() {
  document.body.classList.add('closing');
  setTimeout(() => {
    // 只有由脚本打开的窗口才允许被脚本关闭，因此必须处理失败路径
    window.close();

    // 关不掉时把窗口收成一个提示，用户自己关掉即可
    setTimeout(() => {
      document.body.classList.remove('closing');
      textarea.value = '';
      mount(hintBox, []);
      errorBox.textContent = '已保存（浏览器不允许脚本关闭本窗口，关掉即可）';
      errorBox.style.color = 'var(--ok)';
    }, 220);
  }, 300);
}

async function save() {
  if (finished) return;
  const text = textarea.value;
  errorBox.textContent = '';

  saveButton.disabled = true;
  try {
    await api.quickCapture({ text, kindHint });
  } catch (error) {
    // 契约 3：失败时窗口不关闭，就地显示原因
    saveButton.disabled = false;
    showError(`保存失败：${error.message}`);
    return;
  }

  finished = true;
  closeWindow();
}

saveButton.addEventListener('click', () => void save());

textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void save();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
  }
});

// 契约 1：打开即聚焦，不需要先点一下
textarea.focus();
textarea.setSelectionRange(textarea.value.length, textarea.value.length);
