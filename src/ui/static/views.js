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
 * 当前打开的浮层（菜单/切换器）的收起函数。
 *
 * 每个浮层各自监听 document 点击来收起**自己**，但那只解决了"点别处收起"。
 * 同时打开两个时两个面板会叠在一起 —— 因此需要这个"同一时刻只允许一个"的开关。
 */
let closeOpenMenu = null;

/**
 * 把浮层挂在锚点元素上：固定定位 + 坐标计算，并保证同一时刻只有一个浮层打开。
 *
 * 为什么不能用 `position: absolute`：列表容器 `ul.list` 有 `overflow: hidden`
 * （用来裁圆角），absolute 浮层会被裁断 —— 这正是"菜单点不到"的成因。
 * 为什么要算坐标：靠近窗口底部时要**向上翻**，否则会被窗口切掉。
 *
 * @param anchor 触发按钮
 * @param panel  浮层面板
 * @param wrapper 带着 `.menu` 类的外层（open 状态加在它上面）
 * @param prefer 'right' 贴锚点右边（行内按钮用）；'left' 贴锚点左边（顶部条用）
 */
function makeFloating(anchor, panel, wrapper, prefer = 'right') {
  function place() {
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 280;
    const height = panel.offsetHeight || 200;
    const left = prefer === 'right'
      ? Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))
      : Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    const below = box.bottom + 4;
    const flipUp = below + height > window.innerHeight - 8 && box.top - height - 4 > 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${flipUp ? box.top - height - 4 : below}px`;
  }

  function close() {
    wrapper.classList.remove('open');
    if (closeOpenMenu === close) closeOpenMenu = null;
  }

  function toggle() {
    if (wrapper.classList.contains('open')) {
      close();
      return;
    }
    // 先关掉别的浮层：否则两个面板会重叠，点哪个都不确定落到谁身上
    if (closeOpenMenu !== null) closeOpenMenu();
    wrapper.classList.add('open');
    closeOpenMenu = close;
    place();
  }

  document.addEventListener('click', close);
  return { toggle, close, place };
}

/**
 * 「更多 ▾」下拉菜单。
 *
 * 为什么把低频动作收进来（用户确认的界面方案 ②）：主路径必须零思考，
 * 而 `转项目` / `撤销` 都是一天用不到几次的动作。
 * 把它们与主按钮并列会让"转任务"不再一眼可辨。
 *
 * 每个菜单项**必须带一行说明**（F-04 的交互要求）：这几个动作语义相近，
 * 只靠名字容易点错。
 *
 * @param entries [{ label, hint, danger?, run }]
 */
function moreMenu(entries) {
  const panel = el('div', { class: 'menu-panel' }, entries.map((entry) => el('button', {
    class: `menu-item ${entry.danger === true ? 'danger' : ''}`,
    onclick: (event) => {
      floating.close();
      void entry.run(event.target);
    },
  }, [
    el('span', { class: 'menu-label' }, entry.label),
    el('span', { class: 'menu-hint' }, entry.hint),
  ])));

  const trigger = el('button', {
    class: 'menu-trigger',
    title: '更多处理方式',
    onclick: (event) => {
      event.stopPropagation();
      floating.toggle();
    },
  }, '更多 ▾');

  const wrapper = el('div', { class: 'menu' }, [trigger, panel]);
  const floating = makeFloating(trigger, panel, wrapper, 'right');
  return wrapper;
}

/** 转项目前的确认：说明"这一条会变成什么"，避免与"转任务"混淆 */
function confirmAsProject(title) {
  return window.confirm(
    `把「${title}」变成一个新项目？\n\n` +
    '· 项目名就用这行文字\n' +
    '· 不会自动生成任务 —— 之后在「项目」页里逐步拆解\n' +
    '· 选错了可以点收件箱工具栏上的「撤销」还原',
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

  /**
   * 存为资料（需求 F-12）。
   *
   * **必须先选目标**（规则 M2）—— 绝不自动关联"当前正在做的任务"。
   * 因此这里先弹目标选择器，选好才提交；取消则什么都不做。
   *
   * 用 `classifyMany` 批量提交时，**同一个目标集合会挂到每一条资料上**：
   * 多选时逐条选目标太累，而"这几条都属于同一件事"正是多选的语义。
   */
  async function classifyAsMaterial(button) {
    const ids = selected.size > 0 ? [...selected] : [];
    if (ids.length === 0) {
      flash('请先勾选要处理的条目', 'error');
      return;
    }

    // 预览"这条会变成什么"：识别到几个可打开的入口、几行会成为文字入口。
    // 这段信息正是需求 §4.2 D4 要的"粘贴后能确认识别结果"。
    let entryCount = null;
    let textCount = 0;
    if (ids.length === 1) {
      const body = items.find((item) => item.id === ids[0])?.body ?? '';
      const preview = await api.quickCapture({ text: body, kindHint: 'note', dryRun: true });
      entryCount = preview.entries.length;
      textCount = preview.entries.filter((entry) => entry.kind === 'text').length;
    }

    const targets = await pickTargets(
      ids.length === 1 ? '这条资料挂靠到哪？' : `这 ${ids.length} 条资料都挂靠到哪？`,
      entryCount === null
        ? '资料必须挂靠到至少一个任务或项目 —— 不挂靠就会变成没人管的堆积'
        : `识别到 ${entryCount - textCount} 个可打开的入口${textCount === 0 ? '' : `，另有 ${textCount} 行会成为文字入口`}`,
    );
    if (targets === null) return; // 取消
    if (targets.length === 0) {
      flash('至少要选一个任务或项目', 'error');
      return;
    }

    await withBusy(button, async () => {
      if (ids.length === 1) await api.classify(ids[0], { kind: 'archive', links: targets });
      else await api.classifyMany(ids, { kind: 'archive', links: targets });
      flash(ids.length === 1 ? '已存为资料' : `已存 ${ids.length} 条资料`);
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
      '· 选错了可以点收件箱工具栏上的「撤销」还原',
    )) return;

    await withBusy(button, async () => {
      if (ids.length === 1) await api.classify(ids[0], { kind: 'project' });
      else await api.classifyMany(ids, { kind: 'project' });
      flash(`已建 ${ids.length} 个项目`);
      await reload();
    });
  }

  /**
   * 忽略勾选的条目 —— 收件箱唯一的"我不要这条"动作。
   *
   * 它取代了原先并列的「丢弃」与「删除」：两者的用户决策完全相同，
   * 差异只在实现（状态字段不同、是否自动过期）。**把实现差异泄漏成用户决策
   * 是设计失败** —— 每次整理都要多做一个没有实际意义的判断。
   */
  async function ignoreSelected(button) {
    const ids = selected.size > 0 ? [...selected] : [];
    if (ids.length === 0) {
      flash('请先勾选要处理的条目', 'error');
      return;
    }
    await withBusy(button, async () => {
      for (const id of ids) await api.ignoreItem(id);
      flash(`已忽略 ${ids.length} 条`);
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
      title: '存为资料 —— 会先问挂靠到哪个任务或项目',
      onclick: (event) => void classifyAsMaterial(event.target),
    }, '存为资料'),
    el('button', {
      class: 'danger',
      title: '我不要这条 —— 从收件箱移走，之后可在回收站放回',
      onclick: (event) => void ignoreSelected(event.target),
    }, '忽略'),
    // 「转项目」也放第一层：菜单里只剩它一项，多一次点击没有收益。
    // 与行内的处理保持一致 —— 同一组动作在两处不该有不同的层级。
    el('button', {
      title: '把勾选的条目各变成一个项目（或单选时那一条）',
      onclick: (event) => void classifyAsProject(event.target),
    }, '转项目'),
    el('button', {
      title: '撤销上一次转出或忽略',
      onclick: (event) => void withBusy(event.target, async () => {
        const done = await api.undoLastClassification();
        flash(done ? '已撤销上一次操作' : '没有可撤销的操作', done ? 'ok' : 'error');
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
            await api.classify(item.id, taskTarget());
            flash('已转成任务');
            await reload();
          }),
        }, '转任务'),
        el('button', {
          title: '存为资料 —— 会先问挂靠到哪个任务或项目',
          onclick: (event) => void withBusy(event.target, async () => {
            // 与工具栏的「存为资料」走同一条路径：先选目标，选好才提交（规则 M2）
            const targets = await pickTargets(
              '这条资料挂靠到哪？',
              '资料必须挂靠到至少一个任务或项目 —— 不挂靠就会变成没人管的堆积',
            );
            if (targets === null || targets.length === 0) return;
            await api.classify(item.id, { kind: 'archive', archiveKind: 'note', links: targets });
            flash('已存为资料');
            await reload();
          }),
        }, '资料'),
        el('button', {
          class: 'danger',
          title: '我不要这条 —— 从收件箱移走，之后可在回收站放回',
          onclick: (event) => void withBusy(event.target, async () => {
            await api.ignoreItem(item.id);
            flash('已忽略，可在回收站放回');
            await reload();
          }),
        }, '忽略'),
        // 直接放在第一层，不再收进「更多 ▾」：
        // 那个菜单里只剩这一项，多一次点击没有任何收益。
        // 原来的说明文字（"这一条本身就是一件事"）改由确认框承担，
        // 因此信息没有丢，只是从常驻提示变成"点下去才说明"。
        el('button', {
          title: '这一条本身就是一件事（不会自动生成任务）',
          onclick: (event) => void withBusy(event.target, async () => {
            if (!confirmAsProject(item.body)) return;
            await api.classify(item.id, { kind: 'project' });
            flash('已建项目，去「项目」页拆解');
            await reload();
          }),
        }, '转项目'),
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
// 全部：未结束 / 已完成（F-09 / F-09b）
// ============================================================

/**
 * 本页的两个模式共用一个页签（用户确认的方案）：
 * 它们回答的是同一个问题的两半 —— "还有什么没做" / "做完了什么"。
 * 模式与时间范围存在模块级变量里，切页签回来不会丢。
 */
let allMode = 'open';
let completedRange = { preset: 'last7' };

/**
 * 未结束侧的存在理由：捕获时不允许要求分类或排期（契约 2），
 * 因此"无截止日期、无项目"是合法状态。没有这一侧，这类任务就永久沉底。
 * 渲染上刻意分组且组内不重复，让"总共有多少事悬着"一眼可见。
 */
export async function renderAll(root) {
  const switcher = el('div', { class: 'toolbar' }, [
    el('button', {
      class: allMode === 'open' ? 'primary' : '',
      onclick: () => { allMode = 'open'; void reload(); },
    }, '全部未结束'),
    el('button', {
      class: allMode === 'done' ? 'primary' : '',
      onclick: () => { allMode = 'done'; void reload(); },
    }, '已完成'),
    // 第三种模式（用户要求）：中止是"事情不做了"，既不该混进"今天做了什么"，
    // 也不能没有地方查看 —— 否则"我中止过什么"又变成一个看不见的黑洞。
    el('button', {
      class: allMode === 'aborted' ? 'primary' : '',
      onclick: () => { allMode = 'aborted'; void reload(); },
    }, '已中止'),
  ]);

  if (allMode === 'done') {
    await renderCompleted(root, switcher);
    return;
  }
  if (allMode === 'aborted') {
    await renderAborted(root, switcher);
    return;
  }
  await renderOpen(root, switcher);
}

/**
 * 已中止侧：事情不做了的那些。
 *
 * 与「已完成」刻意分开 —— 完成是"做成了"，中止是"不做了"，
 * 混在一起会让"这周做完了什么"这个数字失真。
 */
async function renderAborted(root, switcher) {
  const rangeBar = buildRangeBar(reload);

  let view;
  try {
    view = await api.abortedView(completedRange);
  } catch (error) {
    mount(root, [
      el('h2', {}, '任务'),
      switcher,
      rangeBar,
      el('div', { class: 'empty' }, `查询失败：${error.message}`),
    ]);
    return;
  }

  const body = view.groups.length === 0
    ? el('div', { class: 'empty' }, '这个时间段内没有中止的任务。')
    : view.groups.map((group) => el('div', {}, [
      el('h2', { class: 'section-title' }, [
        group.dayKey, el('span', { class: 'count' }, `${group.entries.length} 条`),
      ]),
      el('ul', { class: 'list' }, group.entries.map((entry) => el('li', {}, [
        el('span', {}, '⊘'),
        el('div', { class: 'item-body' }, [
          el('div', { class: 'item-title' }, entry.title),
          el('div', { class: 'item-meta' }, [
            entry.projectTitle === null ? null : el('span', { class: 'tag' }, entry.projectTitle),
            el('span', { class: 'item-raw' }, entry.reason === null ? '未说明原因' : `原因：${entry.reason}`),
          ]),
        ]),
      ]))),
    ]));

  mount(root, [
    el('h2', {}, ['已中止 ', el('span', { class: 'count' }, `${view.total} 条`)]),
    switcher,
    rangeBar,
    body,
  ]);
}

/** 时间范围选择条（已完成侧与已中止侧共用，口径一致） */
function buildRangeBar(onChanged) {
  const custom = { from: el('input', { type: 'date' }), to: el('input', { type: 'date' }) };
  return el('div', { class: 'toolbar' }, [
    el('span', {}, '时间范围'),
    ...[
      ['last7', '最近 7 天'],
      ['all', '全部'],
      ['custom', '自定义'],
    ].map(([preset, label]) => el('button', {
      class: completedRange.preset === preset ? 'primary' : '',
      onclick: () => {
        completedRange = preset === 'custom'
          ? { preset, fromDayKey: custom.from.value || undefined, toDayKey: custom.to.value || undefined }
          : { preset };
        void onChanged();
      },
    }, label)),
    completedRange.preset === 'custom' ? custom.from : null,
    completedRange.preset === 'custom' ? el('span', {}, '至') : null,
    completedRange.preset === 'custom' ? custom.to : null,
    completedRange.preset === 'custom'
      ? el('button', {
        onclick: () => {
          completedRange = { preset: 'custom', fromDayKey: custom.from.value, toDayKey: custom.to.value };
          void onChanged();
        },
      }, '查询')
      : null,
  ]);
}

async function renderOpen(root, switcher) {
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
  const taskRow = (task) => buildTaskRow(task, dayKey, undefined, reload);

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
    mount(root, [el('h2', {}, '任务'), switcher, header, el('div', { class: 'empty' }, '没有未结束的任务。')]);
    return;
  }

  mount(root, [
    el('h2', {}, ['全部未结束 ', el('span', { class: 'count' }, `${view.total} 条`)]),
    switcher,
    header,
    rendered.map((group) => el('div', {}, [
      el('h2', { class: `section-title ${group.className}` }, [
        group.label, el('span', { class: 'count' }, `${group.tasks.length} 条`),
      ]),
      el('ul', { class: 'list' }, group.tasks.map((task) => taskRow(task))),
    ])),
  ]);
}

/**
 * 已完成侧（F-09b）。
 *
 * 存在的理由：需求 P4 把"复盘是编的"列为核心痛点、G3 承诺"写日报是导出而不是回忆"，
 * 但此前只有单天汇总，写周报仍要逐天翻日志。这一侧就是那句承诺的落地：
 * 选「最近 7 天」→ 一眼扫完 → 照着写。
 */
async function renderCompleted(root, switcher) {
  const rangeBar = buildRangeBar(reload);

  let view;
  try {
    view = await api.completedView(completedRange);
  } catch (error) {
    mount(root, [
      el('h2', {}, '任务'),
      switcher,
      rangeBar,
      el('div', { class: 'empty' }, `查询失败：${error.message}`),
    ]);
    return;
  }

  const totalLine = `${view.total.all} 条（任务 ${view.total.tasks} · 子任务 ${view.total.subtasks}）`;

  /** 一行完成项：任务名 + 归属（项目 › 任务）；子任务额外显示父任务 */
  function completedRow(entry) {
    const meta = [];
    if (entry.projectTitle !== null) meta.push(el('span', { class: 'tag' }, entry.projectTitle));
    if (entry.kind === 'subtask' && entry.taskTitle !== null) {
      meta.push(el('span', { class: 'item-raw' }, `属于：${entry.taskTitle}`));
    }
    return el('li', {}, [
      el('span', {}, '☑'),
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title' }, entry.title),
        meta.length > 0 ? el('div', { class: 'item-meta' }, meta) : null,
      ]),
      el('div', { class: 'row-actions' }, [
        el('span', { class: 'item-raw' }, entry.kind === 'subtask' ? '子任务' : '任务'),
      ]),
    ]);
  }

  const body = view.groups.length === 0
    ? el('div', { class: 'empty' }, '这个时间段内没有完成的任务。换个范围看看？')
    : view.groups.map((group) => el('div', {}, [
      el('h2', { class: 'section-title' }, [
        group.dayKey, el('span', { class: 'count' }, `${group.entries.length} 条`),
      ]),
      el('ul', { class: 'list' }, group.entries.map((entry) => completedRow(entry))),
    ]));

  mount(root, [
    el('h2', {}, ['已完成 ', el('span', { class: 'count' }, totalLine)]),
    switcher,
    rangeBar,
    body,
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
              el('option', { value: 'abort' }, '中止'),
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

  // 聚焦（F-15b）：只能落在 doing 上，所以 todo 会先自动转进行中；
  // 已经是当前焦点的任务显示"取消聚焦"。
  if (task.focusedAt !== null) {
    actions.push(push('取消聚焦', async () => {
      await api.unfocus();
      await onChanged();
    }));
  } else if (task.status !== 'done' && task.status !== 'cancelled') {
    actions.push(push('聚焦', async () => {
      await api.focusTask(task.id);
      flash('已聚焦，顶部可以直接记一笔');
      await onChanged();
    }));
  }

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

  // 中止（F-07 修订）：与「完成」并列的第二种终止方式 —— 事情不做了，
  // 但保留记录与历史进展。内核一直有 cancelled 状态，只是从未接到界面，
  // 于是任务一旦开始，除了点「完成」就只能「卡住」。
  actions.push(moreMenu([
    {
      label: '中止（不做了）',
      hint: '保留记录与历史进展，不是删除；原因可留空',
      run: (button) => withBusy(button, async () => {
        const answer = window.prompt('为什么不做？（可留空）', '');
        if (answer === null) return; // 取消
        await api.abortTask(task.id, answer.trim());
        flash('已中止（记录仍保留）');
        await onChanged();
      }),
    },
    {
      label: task.dueDate === null ? '设置截止日' : `改截止日（现 ${task.dueDate}）`,
      hint: '可写 2026/10/8、明天、下周三；留空或写 / 表示清除',
      run: (button) => withBusy(button, async () => {
        const answer = window.prompt('截止日期（留空或 / 表示清除）', task.dueDate ?? '');
        if (answer === null) return;
        const raw = answer.trim();
        if (raw === '' || raw === '/') {
          await api.updateTask(task.id, { dueDate: null });
          flash('已清除截止日');
          await onChanged();
          return;
        }
        // 先让内核解析再提交：宁可当场报"看不懂"，也不静默存错日期
        const dayKey = await api.parseDueInput(raw);
        if (dayKey === null) {
          flash(`看不懂「${raw}」这个日期，可写 2026/10/8、明天、下周三`, 'error');
          return;
        }
        await api.updateTask(task.id, { dueDate: dayKey });
        flash(`截止日已设为 ${dayKey}`);
        await onChanged();
      }),
    },
    {
      label: `优先级（现 ${{ high: '高', normal: '中', low: '低' }[task.priority] ?? task.priority}）`,
      hint: '依次切换 高 → 中 → 低',
      run: (button) => withBusy(button, async () => {
        const next = task.priority === 'high' ? 'normal' : task.priority === 'normal' ? 'low' : 'high';
        await api.updateTask(task.id, { priority: next });
        flash(`优先级已设为 ${{ high: '高', normal: '中', low: '低' }[next]}`);
        await onChanged();
      }),
    },
    {
      label: `预估时长（现 ${task.estimateMinutes === null ? '未填' : `${task.estimateMinutes} 分钟`}）`,
      hint: '填个大概，不做计时；留空表示清除',
      run: (button) => withBusy(button, async () => {
        const answer = window.prompt('预估分钟数（留空表示清除）', task.estimateMinutes === null ? '' : String(task.estimateMinutes));
        if (answer === null) return;
        const raw = answer.trim();
        if (raw === '') {
          await api.updateTask(task.id, { estimateMinutes: null });
          flash('已清除预估时长');
          await onChanged();
          return;
        }
        const minutes = Number(raw);
        if (!Number.isInteger(minutes) || minutes <= 0) {
          flash('预估时长要是正整数分钟数', 'error');
          return;
        }
        await api.updateTask(task.id, { estimateMinutes: minutes });
        flash(`预估时长已设为 ${minutes} 分钟`);
        await onChanged();
      }),
    },
  ]));

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
  const titleInput = el('input', { type: 'text', placeholder: '新项目名称（Enter 创建）' });
  const goalInput = el('input', { type: 'text', placeholder: '目标（可留空）' });
  const createButton = el('button', { class: 'primary' }, '新建项目');

  async function submitProject() {
    const title = titleInput.value.trim();
    if (title.length === 0) {
      flash('请填写项目名称', 'error');
      return;
    }
    await withBusy(createButton, async () => {
      await api.createProject({ title, goal: goalInput.value.trim() || null });
      flash('项目已创建');
      await reload();
    });
  }

  // 两个输入框都支持回车（用户反馈：必须点按钮很别扭）
  for (const input of [titleInput, goalInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void submitProject();
    });
  }
  createButton.addEventListener('click', () => void submitProject());

  const createRow = el('div', { class: 'toolbar' }, [titleInput, goalInput, createButton]);

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

  const taskTitleInput = el('input', { type: 'text', placeholder: '新任务标题（Enter 添加）' });
  const addTaskButton = el('button', { class: 'primary' }, '添加任务');

  async function submitTask() {
    const title = taskTitleInput.value.trim();
    if (title.length === 0) return;
    await withBusy(addTaskButton, async () => {
      await api.createTask({ title, projectId });
      flash('任务已添加');
      await reload();
    });
  }

  // 写完直接回车就加进去（用户反馈：必须点按钮很别扭）
  taskTitleInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submitTask();
  });
  addTaskButton.addEventListener('click', () => void submitTask());

  const addTaskRow = el('div', { class: 'toolbar' }, [taskTitleInput, addTaskButton]);

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
    const subtaskInput = el('input', { type: 'text', placeholder: '新子任务（Enter 添加）' });
    const subtaskAddButton = el('button', {}, '＋');

    async function submitSubtask() {
      const title = subtaskInput.value.trim();
      if (title.length === 0) return;
      await withBusy(subtaskAddButton, async () => {
        await api.createSubtask({ taskId: task.id, title });
        await reload();
      });
    }

    subtaskInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void submitSubtask();
    });
    subtaskAddButton.addEventListener('click', () => void submitSubtask());

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
      el('li', {}, [subtaskInput, subtaskAddButton]),
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
      // 资料折叠行（F-14）：任务上不因资料多而变长，因此默认折叠
      materialFoldRow('task', task.id),
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
    // 项目自己也能挂资料（F-12：资料可挂靠任务**或**项目）
    materialFoldRow('project', projectId),
    addTaskRow,
    nodes.length > 0 ? el('div', {}, nodes) : el('div', { class: 'empty' }, '这个项目还没有任务。'),
  ]);
}

// ============================================================
// 日志（F-16 / F-17）
// ============================================================

/**
 * 进展/卡点的归属标签：`项目 › 任务 › 子任务`，有哪层显示哪层（需求 F-20）。
 * 三层都没有时返回 null —— 不显示空标签，界面保持干净。
 */
function contextTag(entry) {
  const parts = [entry.projectTitle, entry.taskTitle, entry.subtaskTitle]
    .filter((part) => part !== null && part !== undefined && part !== '');
  return parts.length === 0 ? null : el('span', { class: 'tag' }, parts.join(' › '));
}

// ============================================================
// 焦点常驻条（F-15b / F-15c）
// ============================================================

/**
 * 顶部常驻条：显示"当前在做哪件"，并承载「记一笔」。
 *
 * 它解决的是需求 §3.1 里那句"频繁被打断"：回来时**不需要回想**我刚才在做什么。
 * 因此这一条只在有焦点时才有内容 —— 没有焦点时给一句去哪聚焦的提示，
 * 而不是留一个空框（空框会让人以为是坏了）。
 *
 * 由 app.js 在每次重绘后调用；它自己管输入框状态（展开/收起）。
 */
export async function renderFocusBar(root, onChanged) {
  let focused = null;
  try {
    focused = await api.focus();
  } catch {
    focused = null;
  }

  if (focused === null) {
    mount(root, [
      el('span', { class: 'focus-label' }, '当前在做：'),
      el('span', { class: 'item-raw' }, '还没有聚焦的任务 —— 去「全部」里对一条任务点「聚焦」'),
    ]);
    root.classList.add('idle');
    return;
  }
  root.classList.remove('idle');

  const kindSelect = el('select', {}, [
    el('option', { value: 'progress' }, '进展'),
    el('option', { value: 'blocker' }, '卡点'),
    el('option', { value: 'decision' }, '决定'),
              el('option', { value: 'abort' }, '中止'),
  ]);
  const noteInput = el('input', { type: 'text', placeholder: '刚才这件事有什么进展？（Enter 提交）' });

  async function submit() {
    const body = noteInput.value.trim();
    if (body.length === 0) return;
    await withBusy(noteInput, async () => {
      await api.noteOnFocus({ kind: kindSelect.value, body });
      flash('已记入当前任务');
      // 卡点会联动状态并顺带清掉焦点，所以整页与焦点条都要刷新
      await onChanged();
    });
  }

  noteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
    if (event.key === 'Escape') noteInput.blur();
  });

  // 切换聚焦对象（用户提议）：记一笔时常常"其实我要记的是另一件"，
  // 因此把任务名做成可直接切换的下拉，而不是只能去「全部」里重新点聚焦。
  let candidates = [];
  try {
    candidates = await api.focusCandidates();
  } catch {
    candidates = [];
  }

  const others = candidates.filter((item) => !item.isFocused);
  const switchButton = el('button', {
    class: 'focus-title',
    title: '切换当前任务',
    onclick: (event) => {
      event.stopPropagation();
      floating.toggle();
    },
  }, `${focused.title} ▾`);

  const switcher = el('div', { class: 'menu' }, [switchButton]);
  const panel = el('div', { class: 'menu-panel' }, [
    el('div', { class: 'menu-hint' }, '切换到：'),
    ...(others.length === 0
      ? [el('div', { class: 'menu-hint' }, '没有别的可切 —— 去「全部」里对一条任务点「聚焦」')]
      : others.slice(0, 20).map((item) => el('button', {
        class: 'menu-item',
        onclick: (event) => {
          floating.close();
          void withBusy(event.target, async () => {
            // todo 会被内核自动转成进行中 —— 这正是"选中即开始"
            await api.focusTask(item.id);
            flash(item.status === 'todo' ? '已开始并聚焦' : '已切换聚焦');
            await onChanged();
          });
        },
      }, [
        el('span', { class: 'menu-label' }, item.title),
        el('span', { class: 'menu-hint' }, [
          item.status === 'todo' ? '选中即开始' : '进行中',
          item.projectTitle === null ? '' : ` · ${item.projectTitle}`,
        ].join('')),
      ]))),
  ]);
  switcher.append(panel);
  // 贴锚点左边：这一条在最上方，向右展开会顶到搜索框
  const floating = makeFloating(switchButton, panel, switcher, 'left');

  mount(root, [
    el('span', { class: 'focus-label' }, '当前在做：'),
    switcher,
    kindSelect,
    noteInput,
    el('button', { class: 'primary', onclick: () => void submit() }, '记一笔'),
    el('button', {
      title: '取消聚焦（任务仍留在「进行中」里）',
      onclick: (event) => void withBusy(event.target, async () => {
        await api.unfocus();
        flash('已取消聚焦');
        await onChanged();
      }),
    }, '取消聚焦'),
  ]);

  // 供快捷键使用：Ctrl+Shift+Space 把光标直接送到这里
  focusBarInput = noteInput;
}

/**
 * 快捷键用的输入框引用。视图重建时会重新赋值，因此用一个模块级变量。
 * 快捷键本身注册在 app.js（它管外壳），这里只提供落点。
 */
let focusBarInput = null;

/** 让「记一笔」输入框获得焦点；返回是否成功（没有焦点任务时失败） */
export function focusNoteInput() {
  if (focusBarInput === null) return false;
  focusBarInput.focus();
  return true;
}

// ============================================================
// 回收站（F-21b）
// ============================================================

/**
 * 回收站页面（F-21b）。
 *
 * **主筛选是「已忽略」** —— 收件箱唯一的"我不要这条"动作的结果。
 * 它取代了原先并列的「已丢弃」与「已删除」两个筛选：
 * 那两者的用户决策完全相同，差异只在实现（状态字段、是否自动过期），
 * 把实现差异摆成两个筛选等于让用户去关心存储细节。
 *
 * 「已删除」只在**存在历史数据**（旧版本软删除的行）时才出现，
 * 并明确说明它是历史残留 —— 既不清掉用户的数据，也不再让新用户困惑。
 *
 * 页面内保留当前筛选，切走再回来不会跳回默认项。
 */
let trashTab = 'ignored';

export async function renderTrash(root) {
  const overview = await api.trashOverview();
  const { counts, retentionDays } = overview;
  const hasLegacyDeleted = counts.deleted > 0;

  // 没有历史数据时不显示「已删除」，且默认筛选必须是「已忽略」
  if (!hasLegacyDeleted) trashTab = 'ignored';
  else if (trashTab !== 'ignored' && trashTab !== 'deleted') trashTab = 'ignored';

  const switcher = el('div', { class: 'toolbar' }, [
    el('button', {
      class: trashTab === 'ignored' ? 'primary' : '',
      onclick: () => { trashTab = 'ignored'; void reload(); },
    }, `已忽略（${counts.ignored}）`),
    hasLegacyDeleted
      ? el('button', {
        class: trashTab === 'deleted' ? 'primary' : '',
        onclick: () => { trashTab = 'deleted'; void reload(); },
      }, `历史已删除（${counts.deleted}）`)
      : null,
  ]);

  const rows = trashTab === 'deleted'
    ? renderDeletedRows(overview.deleted, retentionDays, reload)
    : renderIgnoredRows(overview.ignored, reload);

  const explain = trashTab === 'deleted'
    ? `这些是旧版本"删除"动作留下的记录，保留 ${retentionDays} 天后自动清理。恢复即回到原样。`
    : '「忽略」表示"我不要这条"。它**不会自动过期**，也仍然能被搜索到；放回待处理即可继续整理。';

  mount(root, [
    el('h2', {}, '回收站'),
    switcher,
    el('div', { class: 'item-raw' }, explain),
    rows,
  ]);
}

function renderDeletedRows(entries, retentionDays, onChanged) {
  if (entries.length === 0) {
    return el('div', { class: 'empty' }, '没有已删除的内容（误删的东西会出现在这里）。');
  }
  return el('ul', { class: 'list' }, entries.map((entry) => el('li', {}, [
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title' }, entry.title === '' ? '（无标题）' : entry.title),
      el('div', { class: 'item-meta' }, [
        el('span', { class: 'tag' }, entry.label),
        el('span', { class: 'item-raw' }, `还剩 ${entry.daysLeft} 天`),
        el('span', {}, shortId(entry.entityId)),
      ]),
    ]),
    el('div', { class: 'row-actions' }, [
      el('button', {
        onclick: (event) => void withBusy(event.target, async () => {
          await api.restoreTrash(entry.entityType, entry.entityId);
          flash('已恢复');
          await onChanged();
        }),
      }, '恢复'),
      el('button', {
        class: 'danger',
        onclick: (event) => void withBusy(event.target, async () => {
          // 全系统唯一不可逆操作：必须二次确认，且说明不可恢复
          if (!window.confirm(
            `彻底删除「${entry.title}」？\n\n` +
            '· 这是物理删除，**无法恢复**\n' +
            '· 若只是想让它消失，什么都不用做 —— ' +
            `${retentionDays} 天后会自动清理`,
          )) return;
          await api.purgeTrash(entry.entityType, entry.entityId);
          flash('已彻底删除');
          await onChanged();
        }),
      }, '彻底删除'),
    ]),
  ])));
}

function renderIgnoredRows(entries, onChanged) {
  if (entries.length === 0) {
    return el('div', { class: 'empty' }, '没有已忽略的内容。忽略的条目会一直留在这里，不会被自动清掉。');
  }
  return el('ul', { class: 'list' }, entries.map((entry) => el('li', {}, [
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title' }, entry.title),
      el('div', { class: 'item-meta' }, [
        el('span', { class: 'tag' }, '已忽略'),
        entry.rawInput === null ? null : el('span', { class: 'item-raw' }, `原文：${entry.rawInput}`),
        el('span', { class: 'item-raw' }, '不过期'),
      ]),
    ]),
    el('div', { class: 'row-actions' }, [
      el('button', {
        title: '把这条放回收件箱继续整理',
        onclick: (event) => void withBusy(event.target, async () => {
          await api.restoreIgnored(entry.id);
          flash('已放回待处理');
          await onChanged();
        }),
      }, '放回待处理'),
      el('button', {
        class: 'danger',
        onclick: (event) => void withBusy(event.target, async () => {
          if (!window.confirm(
            `彻底删除「${entry.title}」？\n\n` +
            '· 这是物理删除，**无法恢复**\n' +
            '· 若只是不想让它占地方，其实可以留着 —— 忽略的内容不过期，也还能被搜到',
          )) return;
          await api.purgeIgnored(entry.id);
          flash('已彻底删除');
          await onChanged();
        }),
      }, '彻底删除'),
    ]),
  ])));
}

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
      // 卡点与进展都标注归属（需求 F-20）：progress_entries 只存外键没有名字，
      // 内核在汇总时补齐 `项目 › 任务 › 子任务`，否则多个任务并行时分不清是哪件事。
      block('卡点', summary.blockers.map((entry) => el('li', {}, [
        contextTag(entry),
        '[卡点] ',
        entry.body,
      ]))),
      block('进展时间线', summary.timeline.map((entry) => el('li', {}, [
        `${timeOf(entry.occurredAt)} `,
        contextTag(entry),
        `[${PROGRESS_LABEL[entry.kind]}] ${entry.body}`,
      ]))),
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

// ============================================================
// 资料（F-11 ~ F-14）
// ============================================================

/** 入口形态的中文名。`text` 与前三者并列，但它**不能打开** */
const ENTRY_KIND_LABEL = { dir: '目录', file: '文件', url: '网址', text: '文字' };

/**
 * 目标选择器（需求 F-12 规则 M2 的落点）。
 *
 * 为什么必须弹窗、不能"一点就存"：资料必须挂靠（M1），而**绝不能自动关联
 * "当前正在做的任务"** —— 挂错目标的犯错成本（之后找不到）远高于多选一次。
 *
 * 用居中遮罩而不是 `makeFloating`：内容是可滚动的树，需要固定高度和自己的
 * 滚动容器，而浮层是"贴着某个按钮"的定位模型，两者不合适。
 *
 * @returns 选中的目标数组；**取消时返回 null**（与"选了 0 个"区分开）
 */
function pickTargets(title, hint) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(null);
    };

    const chosen = new Set();
    const listBox = el('div', { class: 'picker-list' }, el('div', { class: 'empty' }, '载入中…'));
    const confirmButton = el('button', { class: 'primary', disabled: true }, '确认');
    const updateConfirm = () => {
      confirmButton.disabled = chosen.size === 0;
      confirmButton.textContent = chosen.size === 0 ? '确认' : `挂靠到 ${chosen.size} 个目标`;
    };

    const row = (type, id, label, depth) => el('label', {
      class: 'picker-row',
      style: `padding-left: ${10 + depth * 18}px`,
    }, [
      el('input', {
        type: 'checkbox',
        onchange: (event) => {
          if (event.target.checked) chosen.add(`${type}:${id}`);
          else chosen.delete(`${type}:${id}`);
          updateConfirm();
        },
      }),
      el('span', { class: 'tag' }, type === 'project' ? '项目' : '任务'),
      el('span', { class: 'picker-label' }, label),
    ]);

    void (async () => {
      try {
        const [projects, tasks] = await Promise.all([api.listProjects(), api.listTasks({})]);
        const rows = [];
        const byProject = new Map();
        for (const task of tasks) {
          const key = task.projectId ?? '';
          if (!byProject.has(key)) byProject.set(key, []);
          byProject.get(key).push(task);
        }
        for (const project of projects) {
          rows.push(row('project', project.id, project.title, 0));
          for (const task of byProject.get(project.id) ?? []) rows.push(row('task', task.id, task.title, 1));
        }
        const loose = byProject.get('') ?? [];
        if (loose.length > 0) {
          rows.push(el('div', { class: 'picker-group' }, '没有项目的任务'));
          for (const task of loose) rows.push(row('task', task.id, task.title, 1));
        }
        mount(listBox, rows.length === 0
          ? el('div', { class: 'empty' }, '还没有任何项目或任务 —— 先建一个，资料才有地方挂。')
          : rows);
      } catch (error) {
        mount(listBox, el('div', { class: 'empty' }, `载入失败：${error.message}`));
      }
    })();

    const overlay = el('div', { class: 'picker-overlay' }, el('div', { class: 'picker' }, [
      el('div', { class: 'picker-title' }, title),
      hint === null ? null : el('div', { class: 'picker-hint' }, hint),
      listBox,
      el('div', { class: 'picker-actions' }, [
        el('button', { onclick: () => finish(null) }, '取消'),
        confirmButton,
      ]),
    ]));

    confirmButton.addEventListener('click', () => {
      finish([...chosen].map((key) => {
        const [type, id] = key.split(':');
        return { type, id };
      }));
    });
    // 点遮罩空白处等于取消（符合直觉），点面板内部不取消
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

/**
 * 打开一批指针。浏览器会拦截连续弹窗，因此被拦时必须说清怎么办 ——
 * 静默失败会让人以为"打开全部"这个功能坏了。
 */
function openTargets(targets) {
  let blocked = 0;
  for (const target of targets) {
    const isUrl = /^(https?|ftp):\/\//i.test(target);
    // 本地路径交给系统默认程序；`file://` 需要把反斜杠换成斜杠
    const url = isUrl ? target : `file:///${target.replaceAll('\\', '/').replace(/^\/+/, '')}`;
    if (window.open(url, '_blank') === null) blocked += 1;
  }
  if (blocked > 0) {
    flash(`有 ${blocked} 项被浏览器拦截。请允许本站弹出窗口，或用「复制」逐个打开。`, 'error');
  }
}

/** 复制到剪贴板；失败时给一条能用的退路，而不是静默失败 */
async function copyToClipboard(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    flash(okMessage);
  } catch {
    window.prompt('复制失败，请手动复制：', text);
  }
}

/**
 * 一条资料的展示：入口 + 挂靠 + 操作。
 *
 * `text` 入口**不能打开**（它指向实物或无法用路径表达的信息），
 * 因此明确标注为"文字"、只提供复制，并在"打开全部"时跳过它。
 * 让它看起来像个坏掉的链接，比没有这个功能更糟。
 */
function materialRow(material, options, onChanged) {
  const openable = material.entries.filter((entry) => entry.kind !== 'text');

  const entriesBox = el('div', { class: 'material-entries' }, material.entries.map((entry) => el('div', {
    class: 'material-entry',
  }, [
    el('span', { class: `tag${entry.kind === 'text' ? ' tag-text' : ''}` }, ENTRY_KIND_LABEL[entry.kind]),
    el('span', { class: 'entry-target' }, entry.target),
    entry.note === null || entry.note === '' ? null : el('span', { class: 'item-raw' }, entry.note),
    entry.kind === 'text'
      ? el('button', {
        title: '这段文字不能打开，但可以复制',
        onclick: () => void copyToClipboard(entry.target, '已复制文字'),
      }, '复制')
      : el('button', { title: '打开', onclick: () => openTargets([entry.target]) }, '打开'),
    entry.kind === 'text' ? null : el('button', {
      title: '复制路径或网址（打不开时的兜底）',
      onclick: () => void copyToClipboard(entry.target, '已复制'),
    }, '复制'),
  ])));

  const body = el('div', { class: 'item-body' }, [
    el('div', { class: 'item-title' }, material.title === null || material.title === '' ? '（无标题）' : material.title),
    el('div', { class: 'item-meta' }, [
      el('span', {}, `📎 ${material.entries.length} 个入口`),
      openable.length === material.entries.length
        ? null
        : el('span', { class: 'item-raw' }, `其中 ${material.entries.length - openable.length} 条是文字`),
      ...material.links.map((link) => el('span', { class: 'tag' }, `${link.type === 'project' ? '项目' : '任务'}：${link.title}`)),
    ]),
    entriesBox,
  ]);

  const actions = el('div', { class: 'row-actions' }, [
    openable.length === 0
      ? el('span', { class: 'item-raw' }, '无可用打开项')
      : el('button', {
        title: openable.length > 1
          ? '逐个打开（浏览器可能拦截连续弹窗，被拦时按提示允许即可）'
          : '打开',
        onclick: () => openTargets(openable.map((entry) => entry.target)),
      }, openable.length > 1 ? `打开全部 ${openable.length}` : '打开'),
    el('button', {
      title: '改挂靠目标（至少保留一个）',
      onclick: () => void withBusy(null, async () => {
        const targets = await pickTargets('改挂靠', '一条资料可挂靠多个任务或项目；至少保留一个');
        if (targets === null || targets.length === 0) return;
        await api.updateMaterial(material.id, { targets });
        flash('已更新挂靠');
        await onChanged();
      }),
    }, '挂靠'),
    options.compact === true ? null : el('button', {
      class: 'danger',
      title: '删除这条资料，入口一并消失',
      onclick: () => void withBusy(null, async () => {
        if (!window.confirm(`删除资料「${material.title ?? ''}」？\n\n· 它的入口会一并消失（软删除，可恢复）`)) return;
        await api.removeMaterial(material.id);
        flash('已删除');
        await onChanged();
      }),
    }, '删除'),
  ]);

  return el('li', {}, [body, actions]);
}

/** 资料页签的当前筛选（页面内保留，切走再回来不跳回默认项） */
let materialOrphanOnly = false;

/** 资料页（F-14）：按时间倒序，可筛"未挂靠"，可改/追加挂靠 */
export async function renderMaterials(root) {
  let materials;
  try {
    materials = await api.listMaterials({ orphanOnly: materialOrphanOnly });
  } catch (error) {
    mount(root, [
      el('h2', {}, '资料'),
      el('div', { class: 'empty' }, `载入失败：${error.message}`),
    ]);
    return;
  }

  // 未挂靠数量单独查一次：筛选按钮上要显示"有多少条等着处理"，
  // 这正是不让资料退化成垃圾堆的那道工序（需求 §4.1 的动机）
  const orphans = await api.listMaterials({ orphanOnly: true });

  const reload = async () => { await renderMaterials(root); };
  const switcher = el('div', { class: 'toolbar' }, [
    el('button', {
      class: materialOrphanOnly ? '' : 'primary',
      onclick: () => { materialOrphanOnly = false; void reload(); },
    }, `全部（${materials.length}）`),
    el('button', {
      class: materialOrphanOnly ? 'primary' : '',
      title: '没有任何任务/项目挂靠的资料。它们不会自己消失，所以需要这条筛选来暴露出来',
      onclick: () => { materialOrphanOnly = true; void reload(); },
    }, `未挂靠（${orphans.length}）`),
  ]);

  const body = materials.length === 0
    ? el('div', { class: 'empty' }, materialOrphanOnly
      ? '没有未挂靠的资料 —— 每条资料都有着落。'
      : '还没有资料。在收件箱里把带路径/链接的条目「存为资料」，或用速记板粘贴多行。')
    : el('ul', { class: 'list' }, materials.map((material) => materialRow(material, {}, reload)));

  mount(root, [
    el('h2', {}, ['资料 ', el('span', { class: 'count' }, `${materials.length} 条`)]),
    switcher,
    el('div', { class: 'item-raw' },
      '资料只存**指针**（路径、网址、或一段指向实物的文字），不存文件本体。每条资料必须挂靠到至少一个任务或项目。'),
    body,
  ]);
}

/**
 * 任务/项目详情里的资料折叠行（F-14）。
 *
 * **折叠是硬要求**：任务详情不能因为资料多而变长。
 */
export function materialFoldRow(type, id) {
  const box = el('div', { class: 'material-fold' });
  let loaded = false;
  let expanded = false;

  const render = async () => {
    if (!loaded) {
      mount(box, el('div', { class: 'item-raw' }, '载入资料…'));
      try {
        box.dataset.materials = JSON.stringify(await api.materialsForTarget(type, id));
      } catch (error) {
        mount(box, el('div', { class: 'item-raw' }, `资料载入失败：${error.message}`));
        return;
      }
      loaded = true;
    }
    const materials = JSON.parse(box.dataset.materials ?? '[]');
    if (materials.length === 0) {
      mount(box, null);
      return;
    }
    if (!expanded) {
      mount(box, el('button', {
        class: 'fold-toggle',
        onclick: () => { expanded = true; void render(); },
      }, `📎 资料 ${materials.length} 条 ▸`));
      return;
    }
    mount(box, [
      el('button', {
        class: 'fold-toggle',
        onclick: () => { expanded = false; void render(); },
      }, `📎 资料 ${materials.length} 条 ▾`),
      el('ul', { class: 'list' }, materials.map((material) => materialRow(material, { compact: true }, async () => {
        loaded = false;
        await render();
      }))),
    ]);
  };

  void render();
  return box;
}

