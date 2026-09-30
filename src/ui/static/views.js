// 四个页签的渲染逻辑：收件箱 / 今日 / 项目 / 日志。
//
// 这里只做「取数 → 渲染 → 收集输入 → 调接口 → 重绘」，
// 任何业务判断（能否流转、是否阻塞、汇总口径）都在内核里。

import { api } from '/api.js';
import {
  el, mount, clear, shortId, todayDayKey, timeOf, dateTimeOf, flash, withBusy,
  STATUS_MARK, PROGRESS_LABEL,
} from '/dom.js';

// 由 app.js 注入的上层重绘函数，避免 views ←→ app 循环 import
let onDataChanged = () => {};
export function setRefreshHook(fn) {
  onDataChanged = fn;
}

async function reload() {
  await onDataChanged();
}

// ============================================================
// 收件箱（F-04）
// ============================================================

/**
 * 「更多 ▾」下拉菜单。
 *
 * 为什么把低频动作收进来（用户确认的界面方案 ②）：主路径必须零思考，
 * 而 `转项目` / `删除` / `撤销` 都是一天用不到几次的动作。
 * 把它们与主按钮并列会让"转任务"不再一眼可辨。
 *
 * 每个菜单项**必须带一行说明**（F-04 的交互要求）：这几个动作语义相近
 * （丢弃 / 删除 / 转项目），只靠名字容易点错。
 *
 * @param entries [{ label, hint, danger?, run }]
 */
function moreMenu(entries) {
  const panel = el('div', { class: 'menu-panel' }, entries.map((entry) => el('button', {
    class: `menu-item ${entry.danger === true ? 'danger' : ''}`,
    onclick: (event) => {
      close();
      void entry.run(event.target);
    },
  }, [
    el('span', { class: 'menu-label' }, entry.label),
    el('span', { class: 'menu-hint' }, entry.hint),
  ])));

  const wrapper = el('div', { class: 'menu' }, [
    el('button', {
      class: 'menu-trigger',
      title: '更多处理方式',
      onclick: (event) => {
        event.stopPropagation();
        wrapper.classList.toggle('open');
      },
    }, '更多 ▾'),
    panel,
  ]);

  function close() {
    wrapper.classList.remove('open');
  }

  // 点别处收起：菜单是绝对定位浮层，不收起会挡住在下面的条目
  document.addEventListener('click', close);
  return wrapper;
}

/** 转项目前的确认：说明"这一条会变成什么"，避免与"转任务"混淆 */
function confirmAsProject(title) {
  return window.confirm(
    `把「${title}」变成一个新项目？\n\n` +
    '· 项目名就用这行文字\n' +
    '· 不会自动生成任务 —— 之后在「项目」页里逐步拆解\n' +
    '· 选错了可以点「更多 ▾ → 撤销上一次分类」还原',
  );
}

export async function renderInbox(root) {
  const [items, projects] = await Promise.all([api.listPending({ limit: 200 }), api.listProjects()]);

  if (items.length === 0) {
    mount(root, [
      el('h2', {}, '收件箱'),
      el('div', { class: 'empty' }, '收件箱是空的。按 Ctrl+K 搜索，或点右上角「＋ 快记」记一句。'),
    ]);
    return;
  }

  const selected = new Set();
  const projectPicker = el('select', {}, [
    el('option', { value: '' }, '不归属项目'),
    ...projects.map((project) => el('option', { value: project.id }, project.title)),
  ]);

  const countLabel = el('span', { class: 'count' }, `共 ${items.length} 条待处理`);

  /** 批量分类：单选与多选共用同一条路径 */
  async function classifySelected(target, button) {
    const ids = selected.size > 0 ? [...selected] : [];
    if (ids.length === 0) {
      flash('请先勾选要处理的条目', 'error');
      return;
    }
    await withBusy(button, async () => {
      // api.classify / classifyMany 收的是**位置参数**：
      // classify(id, target) 与 classifyMany(ids, target)。
      // 传 { id, target } 这种对象会让第一个参数变成整个对象，
      // 服务端随即报 "Unknown named parameter 'id'" —— 本项目已因此踩坑两次。
      if (ids.length === 1) await api.classify(ids[0], target);
      else await api.classifyMany(ids, target);
      flash(`已处理 ${ids.length} 条`);
      await reload();
    });
  }

  /** 批量转项目：多选时逐条确认太累，用一次确认说明会影响几条 */
  async function classifyAsProject(button) {
    const ids = selected.size > 0 ? [...selected] : [];
    if (ids.length === 0) {
      flash('请先勾选要处理的条目', 'error');
      return;
    }
    const what = ids.length === 1
      ? `把「${items.find((item) => item.id === ids[0])?.body ?? ''}」变成一个新项目？`
      : `把勾选的 ${ids.length} 条各变成一个项目？`;
    if (!window.confirm(
      `${what}\n\n` +
      '· 每条的原文就是项目名\n' +
      '· 不会自动生成任务 —— 之后在「项目」页里逐步拆解\n' +
      '· 选错了可以点「更多 ▾ → 撤销上一次分类」还原',
    )) return;

    await withBusy(button, async () => {
      if (ids.length === 1) await api.classify(ids[0], { kind: 'project' });
      else await api.classifyMany(ids, { kind: 'project' });
      flash(`已建 ${ids.length} 个项目`);
      await reload();
    });
  }

  async function deleteSelected(button) {
    const ids = selected.size > 0 ? [...selected] : [];
    if (ids.length === 0) {
      flash('请先勾选要处理的条目', 'error');
      return;
    }
    if (!window.confirm(`删除勾选的 ${ids.length} 条？\n\n进回收站，可恢复。`)) return;
    await withBusy(button, async () => {
      for (const id of ids) await api.deleteItem(id);
      flash(`已删除 ${ids.length} 条`);
      await reload();
    });
  }

  const taskTarget = () => {
    const projectId = projectPicker.value === '' ? null : projectPicker.value;
    return projectId === null ? { kind: 'task' } : { kind: 'task', projectId };
  };

  const toolbar = el('div', { class: 'toolbar' }, [
    projectPicker,
    el('button', { onclick: (event) => void classifySelected(taskTarget(), event.target) }, '转任务'),
    el('button', {
      onclick: (event) => void classifySelected({ kind: 'archive', archiveKind: 'note' }, event.target),
    }, '存为资料'),
    el('button', {
      class: 'danger',
      onclick: (event) => void classifySelected({ kind: 'discard' }, event.target),
    }, '丢弃'),
    moreMenu([
      {
        label: '转项目',
        hint: '这一条本身就是一件事，之后在项目页里拆解',
        run: (button) => classifyAsProject(button),
      },
      {
        label: '删除',
        hint: '我根本不该记它 —— 进回收站，可恢复',
        danger: true,
        run: (button) => deleteSelected(button),
      },
      {
        label: '撤销上一次分类',
        hint: '把上一次转出的东西还原回收件箱',
        run: (button) => withBusy(button, async () => {
          const done = await api.undoLastClassification();
          flash(done ? '已撤销上一次分类' : '没有可撤销的操作', done ? 'ok' : 'error');
          await reload();
        }),
      },
    ]),
  ]);

  const rows = items.map((item) => {
    const checkbox = el('input', {
      type: 'checkbox',
      onchange: (event) => {
        if (event.target.checked) selected.add(item.id);
        else selected.delete(item.id);
      },
    });

    const meta = [];
    if (item.parsedDue !== null) meta.push(el('span', { class: 'tag due' }, `截止 ${item.parsedDue}`));
    if (item.rawInput !== null) meta.push(el('span', { class: 'item-raw' }, `原文：${item.rawInput}`));
    meta.push(el('span', {}, shortId(item.id)));

    return el('li', {}, [
      checkbox,
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title' }, item.body),
        el('div', { class: 'item-meta' }, meta),
      ]),
      el('div', { class: 'row-actions' }, [
        el('button', {
          onclick: (event) => void withBusy(event.target, async () => {
            await api.classify(item.id, taskTarget());
            flash('已转成任务');
            await reload();
          }),
        }, '转任务'),
        el('button', {
          onclick: (event) => void withBusy(event.target, async () => {
            await api.classify(item.id, { kind: 'archive', archiveKind: 'note' });
            flash('已存为资料');
            await reload();
          }),
        }, '资料'),
        el('button', {
          class: 'danger',
          onclick: (event) => void withBusy(event.target, async () => {
            await api.classify(item.id, { kind: 'discard' });
            await reload();
          }),
        }, '丢弃'),
        moreMenu([
          {
            label: '转项目',
            hint: '这一条本身就是一件事',
            run: (button) => withBusy(button, async () => {
              if (!confirmAsProject(item.body)) return;
              await api.classify(item.id, { kind: 'project' });
              flash('已建项目，去「项目」页拆解');
              await reload();
            }),
          },
          {
            label: '删除',
            hint: '我根本不该记它 —— 进回收站',
            danger: true,
            run: (button) => withBusy(button, async () => {
              if (!window.confirm(`删除「${item.body}」？\n\n进回收站，可恢复。`)) return;
              await api.deleteItem(item.id);
              flash('已删除');
              await reload();
            }),
          },
        ]),
      ]),
    ]);
  });

  mount(root, [
    el('h2', {}, ['收件箱 ', countLabel]),
    toolbar,
    el('ul', { class: 'list' }, rows),
  ]);
}

// ============================================================
// 全部未结束（F-09 / 需求 §6.6 可见性约束）
// ============================================================

/**
 * 这一页的存在理由：捕获时不允许要求分类或排期（契约 2），
 * 因此"无截止日期、无项目"是合法状态。没有这一页，这类任务就永久沉底。
 * 渲染上刻意分组且组内不重复，让"总共有多少事悬着"一眼可见。
 */
export async function renderAll(root) {
  const view = await api.openTasksView();
  const dayKey = view.dayKey;

  const GROUPS = [
    ['overdue', '逾期', 'overdue'],
    ['dueToday', '今天到期', ''],
    ['doing', '进行中', ''],
    ['blocked', '卡住', 'blocked'],
    ['scheduled', '已排期（未来）', ''],
    ['unscheduled', '没有排期', 'warn'],
  ];

  /** 复用今日页那一行的交互（记一笔 / 排入今日 / 状态推进 / 完成） */
  function taskRow(task, extraTag) {
    return buildTaskRow(task, dayKey, extraTag, reload);
  }

  const rendered = GROUPS
    .map(([key, label, className]) => ({ key, label, className, tasks: view[key] ?? [] }))
    .filter((group) => group.tasks.length > 0);

  const header = el('div', { class: 'summary-grid' }, [
    el('div', { class: 'summary-stat' }, [el('b', {}, String(view.total)), el('span', {}, '未结束总数')]),
    el('div', { class: 'summary-stat' }, [el('b', {}, String(view.overdueCount)), el('span', {}, '已逾期')]),
    el('div', { class: 'summary-stat' }, [
      el('b', {}, String(view.unscheduled?.length ?? 0)),
      el('span', {}, '没有排期'),
    ]),
  ]);

  if (view.total === 0) {
    mount(root, [
      el('h2', {}, '全部未结束'),
      header,
      el('div', { class: 'empty' }, '没有未结束的任务。'),
    ]);
    return;
  }

  mount(root, [
    el('h2', {}, ['全部未结束 ', el('span', { class: 'count' }, `${view.total} 条`)]),
    header,
    rendered.map((group) => el('div', {}, [
      el('h2', { class: `section-title ${group.className}` }, [
        group.label, el('span', { class: 'count' }, `${group.tasks.length} 条`),
      ]),
      el('ul', { class: 'list' }, group.tasks.map((task) => taskRow(task))),
    ])),
  ]);
}

// ============================================================
// 今日（F-08 / F-10）
// ============================================================

/**
 * 任务行的统一构造：今日页与「全部」页共用，避免两处交互逐渐分叉。
 * 返回一个 li 元素；任何状态推进都会触发 onChanged 重绘。
 */
function buildTaskRow(task, dayKey, extraTag, onChanged) {
  const tags = [];
  if (task.dueDate !== null) {
    const isOverdue = task.dueDate < dayKey && task.status !== 'done';
    tags.push(el('span', { class: `tag ${isOverdue ? 'overdue' : ''}` },
      `${isOverdue ? '逾期' : '截止'} ${task.dueDate}`));
  }
  if (task.priority === 'high') tags.push(el('span', { class: 'tag high' }, '高优先'));
  if (task.status === 'blocked' && task.blockedReason !== null) {
    tags.push(el('span', { class: 'tag blocked' }, `卡在：${task.blockedReason}`));
  }
  if (task.status === 'doing') tags.push(el('span', { class: 'tag due' }, '进行中'));
  if (extraTag !== undefined) tags.push(el('span', { class: 'tag' }, extraTag));

  const progressBox = el('div');
  const noteInput = el('input', { type: 'text', placeholder: '追加一句进展…（Enter 提交）' });
  const noteKind = el('select', {}, [
    el('option', { value: 'progress' }, '进展'),
    el('option', { value: 'blocker' }, '卡点'),
    el('option', { value: 'decision' }, '决定'),
    el('option', { value: 'waiting' }, '等待'),
  ]);

  noteInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void withBusy(noteInput, async () => {
      const body = noteInput.value.trim();
      if (body.length === 0) return;
      await api.addProgress({ target: { kind: 'task', id: task.id }, kind: noteKind.value, body });
      flash('已记录');
      await onChanged();
    });
  });

  function toggleProgress() {
    if (progressBox.childElementCount > 0) {
      clear(progressBox);
      return;
    }
    mount(progressBox, el('div', { class: 'toolbar' }, [noteKind, noteInput]));
    noteInput.focus();
  }

  const push = (label, action, className) => el('button', {
    class: className,
    onclick: (event) => void withBusy(event.target, action),
  }, label);

  const actions = [push('记一笔', async () => toggleProgress())];

  if (task.status === 'todo') {
    actions.push(push('开始', async () => {
      await api.startTask(task.id);
      await onChanged();
    }));
  }
  if (task.status === 'doing') {
    actions.push(push('卡住', async () => {
      const reason = window.prompt('卡在哪里？');
      if (reason === null || reason.trim().length === 0) return;
      await api.blockTask(task.id, reason.trim());
      await onChanged();
    }));
  }
  if (task.status === 'blocked') {
    actions.push(push('解除', async () => {
      await api.unblockTask(task.id);
      await onChanged();
    }));
  }

  if (task.plannedFor !== dayKey) {
    actions.push(push('排入今日', async () => {
      await api.addToToday(task.id);
      flash('已排入今日');
      await onChanged();
    }));
  } else {
    actions.push(push('移出今日', async () => {
      await api.removeFromToday(task.id);
      await onChanged();
    }));
  }

  actions.push(push('完成', async () => {
    await api.finishTask(task.id);
    flash('已完成');
    await onChanged();
  }, 'primary'));

  return el('li', {}, [
    el('span', {}, STATUS_MARK[task.status] ?? '·'),
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title' }, task.title),
      tags.length > 0 ? el('div', { class: 'item-meta' }, tags) : null,
      progressBox,
    ]),
    el('div', { class: 'row-actions' }, actions),
  ]);
}

export async function renderToday(root) {
  const view = await api.todayView();
  const dayKey = view.dayKey;

  const taskRow = (task, extraTag) => buildTaskRow(task, dayKey, extraTag, reload);

  function section(title, tasks, className, extraTag) {
    if (tasks.length === 0) return null;
    return el('div', {}, [
      el('h2', { class: `section-title ${className ?? ''}` }, [
        title, el('span', { class: 'count' }, `${tasks.length} 条`),
      ]),
      el('ul', { class: 'list' }, tasks.map((task) => taskRow(task, extraTag))),
    ]);
  }

  const blocks = [
    section('逾期', view.overdue, 'overdue'),
    section('今天到期', view.dueToday),
    section('已排入今日', view.planned, '', '今日'),
    section('阻塞中', view.blocked, 'blocked'),
  ].filter((node) => node !== null);

  const stats = el('div', { class: 'summary-grid' }, [
    el('div', { class: 'summary-stat' }, [el('b', {}, String(view.counts.open)), el('span', {}, '未结束')]),
    el('div', { class: 'summary-stat' }, [el('b', {}, String(view.counts.doneToday)), el('span', {}, '今天完成')]),
    el('div', { class: 'summary-stat' }, [el('b', {}, String(view.inboxCount)), el('span', {}, '收件箱待处理')]),
  ]);

  // 契约 V2：这一页不能自相矛盾。若上面说还有未结束的任务，
  // 而下面四组加起来没覆盖完，必须显式告诉我去哪里看剩下的。
  const shown = new Set([
    ...view.overdue, ...view.dueToday, ...view.planned, ...view.blocked,
  ].map((task) => task.id));
  const hidden = view.counts.open - shown.size;

  mount(root, [
    el('h2', {}, [`今日 · ${dayKey}`]),
    stats,
    hidden > 0
      ? el('div', { class: 'summary-block' }, [
        el('h3', {}, '还有未结束的任务不在这里'),
        el('div', {}, [
          `另有 ${hidden} 条未结束任务既不到期也没排进今天。`,
        ]),
        el('div', { class: 'toolbar' }, [
          el('button', {
            onclick: async () => {
              // 通过点页签切换，保持与手动点击同一条路径
              const tab = document.querySelector('#tabs button[data-tab="all"]');
              if (tab !== null) tab.click();
            },
          }, `去「全部」看这 ${hidden} 条`),
          el('span', { class: 'item-raw' }, '它们没有消失，只是还没排期。'),
        ]),
      ])
      : null,
    blocks.length > 0 ? blocks : el('div', { class: 'empty' }, '今天没有到期或已排期的任务。'),
  ]);
}

// ============================================================
// 项目（F-06 / F-07）
// ============================================================

/** 当前展开的项目；null 表示显示项目列表 */
let openProjectId = null;

export async function renderProjects(root) {
  if (openProjectId !== null) {
    await renderProjectTree(root, openProjectId);
    return;
  }

  const projects = await api.listProjects();
  const titleInput = el('input', { type: 'text', placeholder: '新项目名称' });
  const goalInput = el('input', { type: 'text', placeholder: '目标（可留空）' });

  const createRow = el('div', { class: 'toolbar' }, [
    titleInput,
    goalInput,
    el('button', {
      class: 'primary',
      onclick: (event) => void withBusy(event.target, async () => {
        const title = titleInput.value.trim();
        if (title.length === 0) {
          flash('请填写项目名称', 'error');
          return;
        }
        await api.createProject({ title, goal: goalInput.value.trim() || null });
        flash('项目已创建');
        await reload();
      }),
    }, '新建项目'),
  ]);

  if (projects.length === 0) {
    mount(root, [
      el('h2', {}, '项目'),
      createRow,
      el('div', { class: 'empty' }, '还没有项目。项目用来聚合"一件事"下面的多个任务。'),
    ]);
    return;
  }

  // 每个项目附一条进度，避免"看不出推进了多少"
  const trees = await Promise.all(projects.map((project) => api.projectTree(project.id)));

  mount(root, [
    el('h2', {}, ['项目 ', el('span', { class: 'count' }, `${projects.length} 个`)]),
    createRow,
    el('div', {}, trees.map((tree) => {
      const { total, done } = tree.counts;
      const percent = total === 0 ? 0 : Math.round((done / total) * 100);
      return el('div', { class: 'project-card' }, [
        el('div', { class: 'project-head' }, [
          el('span', { class: 'title' }, tree.project.title),
          el('span', { class: 'tag' }, `${done}/${total} 任务`),
          total > 0 ? el('span', { class: 'tag' }, `${percent}%`) : null,
          tree.project.goal !== null ? el('span', { class: 'item-raw' }, tree.project.goal) : null,
          el('span', { class: 'spacer', style: 'flex:1' }),
          el('button', {
            onclick: () => {
              openProjectId = tree.project.id;
              void reload();
            },
          }, '打开'),
          el('button', {
            class: 'danger',
            onclick: (event) => void withBusy(event.target, async () => {
              const confirmed = window.confirm(
                `删除项目「${tree.project.title}」？\n其下 ${total} 个任务会保留，但不再归属该项目。`,
              );
              if (!confirmed) return;
              await api.deleteProject(tree.project.id);
              flash('项目已删除');
              await reload();
            }),
          }, '删除'),
        ]),
      ]);
    })),
  ]);
}

async function renderProjectTree(root, projectId) {
  const tree = await api.projectTree(projectId);
  const { total, done } = tree.counts;

  const taskTitleInput = el('input', { type: 'text', placeholder: '新任务标题' });
  const addTaskRow = el('div', { class: 'toolbar' }, [
    taskTitleInput,
    el('button', {
      class: 'primary',
      onclick: (event) => void withBusy(event.target, async () => {
        const title = taskTitleInput.value.trim();
        if (title.length === 0) return;
        await api.createTask({ title, projectId });
        flash('任务已添加');
        await reload();
      }),
    }, '添加任务'),
  ]);

  const nodes = await Promise.all(tree.tasks.map(async (node) => {
    const task = node.task;
    const tags = [];
    if (task.dueDate !== null) tags.push(el('span', { class: 'tag' }, `截止 ${task.dueDate}`));
    if (task.priority === 'high') tags.push(el('span', { class: 'tag high' }, '高优先'));
    if (task.status === 'blocked' && task.blockedReason !== null) {
      tags.push(el('span', { class: 'tag blocked' }, `卡在：${task.blockedReason}`));
    }
    if (node.counts.total > 0) tags.push(el('span', { class: 'tag' }, `${node.counts.done}/${node.counts.total} 子任务`));

    // 子任务列表
    const subtaskInput = el('input', { type: 'text', placeholder: '新子任务' });
    const subtasks = el('ul', { class: 'subtask-list' }, [
      ...node.subtasks.map((subtask) => el('li', { class: subtask.status === 'done' ? 'done' : '' }, [
        el('input', {
          type: 'checkbox',
          checked: subtask.status === 'done',
          onchange: (event) => void withBusy(null, async () => {
            await api.setSubtaskStatus(subtask.id, event.target.checked ? 'done' : 'todo');
            await reload();
          }),
        }),
        el('span', {}, subtask.title),
      ])),
      el('li', {}, [
        subtaskInput,
        el('button', {
          onclick: (event) => void withBusy(event.target, async () => {
            const title = subtaskInput.value.trim();
            if (title.length === 0) return;
            await api.createSubtask({ taskId: task.id, title });
            await reload();
          }),
        }, '＋'),
      ]),
    ]);

    // 进展时间线（按需加载，避免一次拉全部）
    const timelineBox = el('div');
    async function toggleTimeline() {
      if (timelineBox.childElementCount > 0) {
        clear(timelineBox);
        return;
      }
      const entries = await api.taskTimeline(task.id);
      if (entries.length === 0) {
        mount(timelineBox, el('div', { class: 'item-raw' }, '还没有记录'));
        return;
      }
      mount(timelineBox, el('ul', { class: 'progress-list' }, entries.map((entry) => el('li', {}, [
        el('span', { class: 'when' }, dateTimeOf(entry.occurredAt)),
        el('span', { class: 'tag' }, PROGRESS_LABEL[entry.kind]),
        el('span', {}, entry.body),
      ]))));
    }

    return el('div', { class: 'task-node' }, [
      el('div', { class: 'toolbar', style: 'margin:0' }, [
        el('span', {}, STATUS_MARK[task.status] ?? '·'),
        el('strong', {}, task.title),
        ...tags,
        el('span', { class: 'spacer' }),
        el('button', { onclick: () => void toggleTimeline() }, `进展 ${node.progressCount}`),
        task.status === 'done'
          ? el('button', { onclick: (event) => void withBusy(event.target, async () => {
            await api.reopenTask(task.id);
            await reload();
          }) }, '重开')
          : el('button', { class: 'primary', onclick: (event) => void withBusy(event.target, async () => {
            await api.completeTask(task.id);
            await reload();
          }) }, '完成'),
      ]),
      subtasks,
      timelineBox,
    ]);
  }));

  mount(root, [
    el('div', { class: 'toolbar' }, [
      el('button', {
        onclick: () => {
          openProjectId = null;
          void reload();
        },
      }, '← 返回项目列表'),
    ]),
    el('h2', {}, [tree.project.title, ' ', el('span', { class: 'count' }, `${done}/${total} 任务`)]),
    tree.project.goal !== null ? el('div', { class: 'item-raw' }, `目标：${tree.project.goal}`) : null,
    addTaskRow,
    nodes.length > 0 ? el('div', {}, nodes) : el('div', { class: 'empty' }, '这个项目还没有任务。'),
  ]);
}

// ============================================================
// 日志（F-16 / F-17）
// ============================================================

export async function renderLog(root) {
  const dayKey = todayDayKey();
  const dateInput = el('input', { type: 'date', value: dayKey });

  const bodyBox = el('div');

  async function loadDay(key) {
    mount(bodyBox, el('div', { class: 'empty' }, '加载中…'));
    const summary = await api.summarize(key);
    const { counts } = summary;

    const textarea = el('textarea', { class: 'log-body', placeholder: '今天做了什么、卡在哪、明天计划…' });
    textarea.value = summary.log?.body ?? '';

    const saveRow = el('div', { class: 'toolbar' }, [
      el('button', {
        class: 'primary',
        onclick: (event) => void withBusy(event.target, async () => {
          await api.saveLog(key, textarea.value);
          flash('日志已保存');
        }),
      }, '保存正文'),
      el('span', { class: 'item-raw' }, '自动汇总部分不落库——任务状态一变，它会跟着变，历史日志不会变成错的。'),
    ]);

    const block = (title, nodes) => (nodes.length === 0 ? null : el('div', { class: 'summary-block' }, [
      el('h3', {}, title),
      el('ul', {}, nodes),
    ]));

    mount(bodyBox, [
      el('div', { class: 'summary-grid' }, [
        el('div', { class: 'summary-stat' }, [el('b', {}, String(counts.completed)), el('span', {}, '完成')]),
        el('div', { class: 'summary-stat' }, [el('b', {}, String(counts.created)), el('span', {}, '新增')]),
        el('div', { class: 'summary-stat' }, [el('b', {}, String(counts.blockers)), el('span', {}, '卡点')]),
        el('div', { class: 'summary-stat' }, [el('b', {}, String(counts.carriedOver)), el('span', {}, '顺延')]),
      ]),
      block('完成的任务', summary.completedTasks.map((task) => el('li', {}, `☑ ${task.title}`))),
      block('完成的子任务', summary.completedSubtasks.map((item) => el('li', {}, `☑ ${item.taskTitle} › ${item.subtask.title}`))),
      block('顺延（到期未完成）', summary.carriedOver.map((task) => el('li', {}, `${task.title}（截止 ${task.dueDate}）`))),
      block('卡点', summary.blockers.map((entry) => el('li', {}, entry.body))),
      block('进展时间线', summary.timeline.map((entry) => el('li', {}, `${timeOf(entry.occurredAt)} [${PROGRESS_LABEL[entry.kind]}] ${entry.body}`))),
      el('h2', {}, '我的正文'),
      textarea,
      saveRow,
    ]);
  }

  dateInput.addEventListener('change', () => void loadDay(dateInput.value));

  mount(root, [
    el('div', { class: 'toolbar' }, [
      el('span', {}, '日期'),
      dateInput,
      el('button', { onclick: () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        dateInput.value = key;
        void loadDay(key);
      } }, '昨天'),
    ]),
    bodyBox,
  ]);

  await loadDay(dayKey);
}
