// 界面与内核之间唯一的通路：调用服务门面的 HTTP 包装。
//
// 关于参数形状：内核服务方法的签名不统一（有的收一个选项对象，有的收位置参数），
// 例如 quickCapture(options) 收对象，而 tracking.todayView(dayKey) 收字符串。
// 约定由本文件负责适配：**数组 = 按位置展开，非数组 = 作为第一个参数**。
// 因此每个包装函数都必须写清自己传的是哪种形状——这是刻意显式的，
// 让服务端去猜参数形状只会制造难以定位的 "[object Object]" 类故障。

/** 调用一个服务方法。失败时抛出带有后端可读消息的错误。 */
export async function call(service, method, params) {
  const response = await fetch(`/api/${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: params ?? [] }),
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
  countPending: () => call('capture', 'countPending', []),
  /** classify(id, target) —— 位置参数 */
  classify: (id, target) => call('capture', 'classify', [id, target]),
  /** classifyMany(ids, target) —— 位置参数 */
  classifyMany: (ids, target) => call('capture', 'classifyMany', [ids, target]),
  undoLastClassification: () => call('capture', 'undoLastClassification', []),

  // ---------- 规划 ----------
  listProjects: (options = {}) => call('planning', 'listProjects', options),
  projectTree: (projectId) => call('planning', 'projectTree', projectId),
  createProject: (options) => call('planning', 'createProject', options),
  deleteProject: (id) => call('planning', 'deleteProject', id),
  listTasks: (filter = {}) => call('planning', 'listTasks', filter),
  createTask: (options) => call('planning', 'createTask', options),
  completeTask: (id) => call('planning', 'completeTask', [id, {}]),
  reopenTask: (id) => call('planning', 'reopenTask', id),
  createSubtask: (options) => call('planning', 'createSubtask', options),
  setSubtaskStatus: (id, status) => call('planning', 'setSubtaskStatus', [id, status]),
  reorder: (kind, movedId, beforeId) => call('planning', 'reorder', [kind, movedId, beforeId]),

  // ---------- 推进 ----------
  todayView: (dayKey) => call('tracking', 'todayView', dayKey === undefined ? [] : [dayKey]),
  addProgress: (options) => call('tracking', 'addProgress', options),
  taskTimeline: (taskId) => call('tracking', 'taskTimeline', [taskId, { limit: 50 }]),
  startTask: (taskId) => call('tracking', 'startTask', taskId),
  blockTask: (taskId, reason) => call('tracking', 'blockTask', [taskId, reason]),
  unblockTask: (taskId) => call('tracking', 'unblockTask', taskId),
  finishTask: (taskId) => call('tracking', 'completeTask', [taskId, {}]),
  addToToday: (taskId) => call('tracking', 'addToToday', taskId),
  removeFromToday: (taskId) => call('tracking', 'removeFromToday', taskId),

  // ---------- 日志 ----------
  summarize: (dayKey) => call('journal', 'summarize', dayKey),
  saveLog: (dayKey, body) => call('journal', 'save', [dayKey, body]),

  // ---------- 检索与系统 ----------
  search: (query) => call('search', 'search', [query, { limit: 40 }]),

  /**
   * system.settings 是一个**对象**（含 dayBoundaryHour/get/set/list），不是方法。
   * 这里把它的方法逐个包出来，避免界面去猜服务端的对象形状。
   */
  settingsList: () => call('system', 'settings', []).then((settings) => settings.list()),
  dayBoundaryHour: () => call('system', 'settings', []).then((settings) => settings.dayBoundaryHour()),
  backup: (reason = 'manual') => call('system', 'backup', [reason]),
  integrityCheck: () => call('system', 'integrityCheck', []),
};
