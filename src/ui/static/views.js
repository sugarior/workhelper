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
      // 只有一条时走单条接口，便于将来区分两种返回形状
      if (ids.length === 1) await api.classify({ id: ids[0], target });
      else await api.classifyMany({ ids, target });
      flash(`已处理 ${ids.length} 条`);
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
    el('span', { class: 'spacer' }),
    el('button', {
      title: '撤销上一次分类',
      onclick: (event) => void withBusy(event.target, async () => {
        const done = await api.undoLastClassification();
        flash(done ? '已撤销上一次分类' : '没有可撤销的操作', done ? 'ok' : 'error');
        await reload();
      }),
    }, '撤销'),
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
            await api.classify({ id: item.id, target: taskTarget() });
            flash('已转成任务');
            await reload();
          }),
        }, '转任务'),
        el('button', {
          onclick: (event) => void withBusy(event.target, async () => {
            await api.classify({ id: item.id, target: { kind: 'archive', archiveKind: 'note' } });
            flash('已存为资料');
            await reload();
          }),
        }, '资料'),
        el('button', {
          class: 'danger',
          onclick: (event) => void withBusy(event.target, async () => {
            await api.classify({ id: item.id, target: { kind: 'discard' } });
            await reload();
          }),
        }, '丢弃'),
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
// 今日（F-08 / F-09）
// ============================================================

export async function renderToday(root) {
  const view = await api.todayView();
  const dayKey = view.dayKey;

  /** 一行任务：状态、标题、标签、操作、可展开的进展输入 */
  function taskRow(task, extraTag) {
    const tags = [];
    if (task.dueDate !== null) {
      tags.push(el('span', { class: `tag ${task.dueDate < dayKey && task.status !== 'done' ? 'overdue' : ''}` },
        `${task.dueDate < dayKey ? '逾期' : '截止'} ${task.dueDate}`));
    }
    if (task.priority === 'high') tags.push(el('span', { class: 'tag high' }, '高优先'));
    if (task.status === 'blocked' && task.blockedReason !== null) {
      tags.push(el('span', { class: 'tag blocked' }, `卡在：${task.blockedReason}`));
    }
    if (extraTag !== undefined) tags.push(el('span', { class: 'tag' }, extraTag));

    const progressBox = el('div');
    const noteInput = el('input', { type: 'text', placeholder: '追加一句进展…（Enter 提交）' });
    const noteKind = el('select', {}, [
      el('option', { value: 'progress' }, '进展'),
      el('option', { value: 'blocker' }, '卡点'),
      el('option', { value: 'decision' }, '决定'),
      el('option', { value: 'waiting' }, '等待'),
    ]);

    const submitNote = async () => {
      const body = noteInput.value.trim();
      if (body.length === 0) return;
      await api.addProgress({
        target: { kind: 'task', id: task.id },
        kind: noteKind.value,
        body,
      });
      flash('已记录');
      await reload();
    };
    noteInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void withBusy(noteInput, submitNote);
      }
    });

    function toggleProgress() {
      if (progressBox.childElementCount > 0) {
        clear(progressBox);
        return;
      }
      mount(progressBox, el('div', { class: 'toolbar' }, [noteKind, noteInput]));
      noteInput.focus();
    }

    const actions = [
      el('button', { onclick: () => void toggleProgress() }, '记一笔'),
    ];
    if (task.status === 'todo') {
      actions.push(el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          await api.startTask(task.id);
          await reload();
        }),
      }, '开始'));
    }
    if (task.status === 'doing') {
      actions.push(el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          const reason = window.prompt('卡在哪里？');
          if (reason === null || reason.trim().length === 0) return;
          await api.blockTask(task.id, reason.trim());
          await reload();
        }),
      }, '卡住'));
    }
    if (task.status === 'blocked') {
      actions.push(el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          await api.unblockTask(task.id);
          await reload();
        }),
      }, '解除'));
    }
    if (task.plannedFor !== dayKey) {
      actions.push(el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          await api.addToToday(task.id);
          await reload();
        }),
      }, '排入今日'));
    } else {
      actions.push(el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          await api.removeFromToday(task.id);
          await reload();
        }),
      }, '移出今日'));
    }
    actions.push(el('button', {
      class: 'primary',
      onclick: (event) => void withBusy(event.target, async () => {
        await api.finishTask(task.id);
        flash('已完成');
        await reload();
      }),
    }, '完成'));

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

  mount(root, [
    el('h2', {}, [`今日 · ${dayKey}`]),
    stats,
    blocks.length > 0 ? blocks : el('div', { class: 'empty' }, '今天没有待办事项。'),
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
