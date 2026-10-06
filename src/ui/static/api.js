// 界面与内核之间唯一的通路：调用服务门面的 HTTP 包装。
//
// 关于参数形状（本项目反复踩坑的地方，务必读完）：
// 内核服务方法的签名不统一——有的收一个选项对象，有的收位置参数，
// 例如 backup(reason) 收字符串、quickCapture(options) 收对象。
// 接口协议只定义两种形状：**数组 = 按位置展开，对象 = 作为第一个参数**。
//
// 因此 call() 里做一次**规范化**：params 既不是数组也不是 null/undefined 时，
// 自动包成单元素数组。这样传裸值（如 projectId 字符串）与传 [projectId] 等价，
// 杜绝"单参数方法误传裸值"这一类错误——它曾导致：
//   · 备份文件名变成 wh-...-[object Object].db
//   · 点击「转任务」报 "Unknown named parameter 'id'"
//   · 点击项目、"开始"、"解除"、"重开"等报 "params 必须是对象或数组"
//
// 注意：**对象入参必须显式写出**（如 quickCapture(options)），
// 因为对象在协议里表示"第一个参数就是这个对象"，规范化不会碰它。

/**
 * API 的基地址。
 *
 * **为什么需要它**：打包后界面由 Tauri 的应用协议提供，而 API 仍是 Node 的
 * `http://127.0.0.1:<port>` —— 两者**不同源**，相对路径 `/api/...` 会打到应用协议上，
 * 所有数据请求 404。表现为"界面能打开但一片空白"。
 *
 * **端口只在内核里定义一次（`server.ts` 的 `DEFAULT_PORT`），这里不写死第二份** ——
 * 否则改端口时必然只改一处（第一类错误：同一规则写在两处，必然背离）。
 * 前端改为**运行时发现**：
 *   1. 同源就是 API（浏览器里直接开 `http://127.0.0.1:7317`，界面与 API 同源）
 *   2. 否则问内核要一次地址（`GET /api-base`），拿到就缓存
 *
 * 探路用的候选地址只在第 2 步用一次，且仅在"界面与 API 不同源"时才会走到 ——
 * 那是打包后的场景，而端口已确认固定不变（见 plan §4.1.2）。
 */
let apiBasePromise = null;

async function resolveApiBase() {
  const sameOrigin = location.origin;
  // 同源探测：开发时（浏览器直接开 7317）走这条，一次就成
  try {
    const probe = await fetch(`${sameOrigin}/api-base`, { cache: 'no-store' });
    if (probe.ok) {
      const data = await probe.json();
      if (typeof data?.base === 'string' && data.base.length > 0) return data.base;
    }
  } catch {
    // 同源不是 API（打包后就是这种情况），继续往候选地址试
  }

  for (const candidate of ['http://127.0.0.1:7317']) {
    try {
      const probe = await fetch(`${candidate}/api-base`, { cache: 'no-store' });
      if (!probe.ok) continue;
      const data = await probe.json();
      if (typeof data?.base === 'string' && data.base.length > 0) return data.base;
    } catch {
      // 换下一个候选
    }
  }

  // 都失败就退回同源：让后续请求给出真实错误，而不是在这里抛一个看不懂的异常
  return sameOrigin;
}

function apiBase() {
  apiBasePromise ??= resolveApiBase();
  return apiBasePromise;
}

/** 调用一个服务方法。失败时抛出带有后端可读消息的错误。 */
export async function call(service, method, params) {
  const normalized =
    params === null || params === undefined ? []
      : Array.isArray(params) ? params
        : [params];

  const base = await apiBase();
  const response = await fetch(`${base}/api/${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: normalized }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`接口 ${service}.${method} 返回了非 JSON 内容（HTTP ${response.status}）`);
  }

  if (payload.ok !== true) {
    throw new Error(payload.message ?? `接口 ${service}.${method} 调用失败`);
  }
  return payload.data;
}

export const api = {
  // ---------- 捕获 ----------
  quickCapture: (options) => call('capture', 'quickCapture', options),
  listPending: (options = { limit: 200 }) => call('capture', 'listPending', options),
  countPending: () => call('capture', 'countPending'),
  classify: (id, target) => call('capture', 'classify', [id, target]),
  classifyMany: (ids, target) => call('capture', 'classifyMany', [ids, target]),
  undoLastClassification: () => call('capture', 'undoLastClassification'),
  /** 忽略：收件箱唯一的"我不要这条"动作。待处理与已转出的都能用 */
  ignoreItem: (id) => call('capture', 'ignoreItem', id),

  // ---------- 规划 ----------
  listProjects: (options = {}) => call('planning', 'listProjects', options),
  projectTree: (projectId) => call('planning', 'projectTree', projectId),
  createProject: (options) => call('planning', 'createProject', options),
  /** 更新项目。项目的终止方式是 `{status:'archived'}`，与任务的「中止」对称 */
  updateProject: (id, patch) => call('planning', 'updateProject', [id, patch]),
  listTasks: (filter = {}) => call('planning', 'listTasks', filter),
  createTask: (options) => call('planning', 'createTask', options),
  completeTask: (id) => call('planning', 'completeTask', [id, {}]),
  reopenTask: (id) => call('planning', 'reopenTask', id),
  createSubtask: (options) => call('planning', 'createSubtask', options),
  setSubtaskStatus: (id, status) => call('planning', 'setSubtaskStatus', [id, status]),
  reorder: (kind, movedId, beforeId) => call('planning', 'reorder', [kind, movedId, beforeId]),
  /** 修改任务字段（截止日/优先级/预估/标题）。界面此前完全没有修改入口 */
  updateTask: (id, patch) => call('planning', 'updateTask', [id, patch]),
  /** 解析手工输入的截止日期；看不懂返回 null，绝不静默存错 */
  parseDueInput: (raw) => call('system', 'parseDueInput', raw),

  // ---------- 回收站（F-21b） ----------
  // 一次拿到「已删除」与「已忽略」两个筛选的列表与计数，省掉四次往返。
  trashOverview: () => call('system', 'trashOverview'),
  restoreIgnored: (id) => call('system', 'restoreIgnored', id),
  purgeIgnored: (id) => call('system', 'purgeIgnored', id),
  restoreTrash: (entityType, entityId) => call('system', 'restoreTrash', [entityType, entityId]),
  purgeTrash: (entityType, entityId) => call('system', 'purgeTrash', [entityType, entityId]),

  // ---------- 推进 ----------
  todayView: (dayKey) => call('tracking', 'todayView', dayKey === undefined ? [] : [dayKey]),
  openTasksView: (dayKey) => call('tracking', 'openTasksView', dayKey === undefined ? [] : [dayKey]),
  addProgress: (options) => call('tracking', 'addProgress', options),
  taskTimeline: (taskId) => call('tracking', 'taskTimeline', [taskId, { limit: 50 }]),
  startTask: (taskId) => call('tracking', 'startTask', taskId),
  blockTask: (taskId, reason) => call('tracking', 'blockTask', [taskId, reason]),
  unblockTask: (taskId) => call('tracking', 'unblockTask', taskId),
  finishTask: (taskId) => call('tracking', 'completeTask', [taskId, {}]),
  /** 中止任务（F-07 修订）：事情不做了，但保留记录与历史进展。原因可选 */
  abortTask: (taskId, reason) => call('tracking', 'abortTask', [taskId, reason === undefined || reason === '' ? null : reason]),
  addToToday: (taskId) => call('tracking', 'addToToday', taskId),
  removeFromToday: (taskId) => call('tracking', 'removeFromToday', taskId),
  completedView: (range) => call('tracking', 'completedView', [range]),
  /** 已中止总览：事情不做了的那些，按中止日分组 */
  abortedView: (range) => call('tracking', 'abortedView', [range]),

  // ---------- 资料（F-11~F-14） ----------
  /** 创建资料：入口与挂靠目标必须一次给全（规则 M1 —— 不留零挂靠的中间态） */
  createMaterial: (input) => call('material', 'create', input),
  getMaterial: (id) => call('material', 'get', id),
  listMaterials: (options) => call('material', 'list', [options ?? {}]),
  /** 某个任务/项目上挂着的资料（任务详情的折叠行用） */
  materialsForTarget: (type, id) => call('material', 'listForTarget', [type, id]),
  updateMaterial: (id, patch) => call('material', 'update', [id, patch]),
  linkMaterial: (id, targets) => call('material', 'link', [id, targets]),
  unlinkMaterial: (id, target) => call('material', 'unlink', [id, target]),
  removeMaterial: (id) => call('material', 'remove', id),
  materialEntryTargets: (id) => call('material', 'entryTargets', id),

  // ---------- 焦点（F-15b / F-15c） ----------
  focus: () => call('tracking', 'focus'),
  focusTask: (taskId) => call('tracking', 'focusTask', taskId),
  unfocus: () => call('tracking', 'unfocus'),
  focusCandidates: () => call('tracking', 'focusCandidates'),
  noteOnFocus: (input) => call('tracking', 'noteOnFocus', [input]),

  // ---------- 日志 ----------
  summarize: (dayKey) => call('journal', 'summarize', dayKey),
  saveLog: (dayKey, body) => call('journal', 'save', [dayKey, body]),

  // ---------- 检索 ----------
  search: (query) => call('search', 'search', [query, { limit: 40 }]),

  // ---------- 系统 ----------
  // 接口只能传值不能传函数，因此内核返回的是设置的数据快照，
  // 而不是一个带方法的 settings 对象（那样序列化后只剩空对象）。
  settingsList: () => call('system', 'getSettings').then((data) => data.entries),
  dayBoundaryHour: () => call('system', 'getSettings').then((data) => data.dayBoundaryHour),
  backup: (reason = 'manual') => call('system', 'backup', reason),
  integrityCheck: () => call('system', 'integrityCheck'),
};
