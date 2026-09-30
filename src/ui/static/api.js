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

/** 调用一个服务方法。失败时抛出带有后端可读消息的错误。 */
export async function call(service, method, params) {
  const normalized =
    params === null || params === undefined ? []
      : Array.isArray(params) ? params
        : [params];

  const response = await fetch(`/api/${service}/${method}`, {
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
  deleteItem: (id) => call('capture', 'deleteItem', id),

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
  /** 修改任务字段（截止日/优先级/预估/标题）。界面此前完全没有修改入口 */
  updateTask: (id, patch) => call('planning', 'updateTask', [id, patch]),
  /** 解析手工输入的截止日期；看不懂返回 null，绝不静默存错 */
  parseDueInput: (raw) => call('system', 'parseDueInput', raw),

  // ---------- 推进 ----------
  todayView: (dayKey) => call('tracking', 'todayView', dayKey === undefined ? [] : [dayKey]),
  openTasksView: (dayKey) => call('tracking', 'openTasksView', dayKey === undefined ? [] : [dayKey]),
  addProgress: (options) => call('tracking', 'addProgress', options),
  taskTimeline: (taskId) => call('tracking', 'taskTimeline', [taskId, { limit: 50 }]),
  startTask: (taskId) => call('tracking', 'startTask', taskId),
  blockTask: (taskId, reason) => call('tracking', 'blockTask', [taskId, reason]),
  unblockTask: (taskId) => call('tracking', 'unblockTask', taskId),
  finishTask: (taskId) => call('tracking', 'completeTask', [taskId, {}]),
  addToToday: (taskId) => call('tracking', 'addToToday', taskId),
  removeFromToday: (taskId) => call('tracking', 'removeFromToday', taskId),
  completedView: (range) => call('tracking', 'completedView', [range]),

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
