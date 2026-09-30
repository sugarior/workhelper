# 工作秘书 WorkHelper — 技术设计文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1 |
| 状态 | 设计阶段，待评审后进入 M0 编码 |
| 上游文档 | [需求与目标文档](requirements.md) · [已有方案调研](research-existing-solutions.md) |
| 设计范围 | 内核数据模型、服务接口、模块划分、M0 界面契约；桌面壳（Tauri）属 M1 |

---

## 1. 设计目标与约束

需求文档给出的约束，直接决定技术选择：

| 需求约束 | 设计决策 |
| --- | --- |
| G1 捕获 ≤ 3 秒、不打断工作 | 快记通路**不经过任何网络 I/O**；写入是单条 INSERT + 一次提交 |
| 永远不丢已提交记录 | SQLite **WAL** 模式 + 同步写入；`synchronous=NORMAL`（WAL 下断电不丢已提交事务） |
| 数据是我的 | 单一 `workhelper.db` 文件 + `attachments/` 目录，整体可打包搬走；不依赖任何云 |
| AI 只是建议 | AI 模块**无法直接写库**，只能产出提案对象，由确认流程调用写入服务 |
| 内核与界面分离（Q3 预留） | `core/` 不 import 任何界面/HTTP/Tauri 代码；界面层通过服务门面调用 |
| 单机、个人、无同步 | 不做变更日志/事件溯源，关系表即事实源 |

### 1.1 已验证的技术前提（本机实测）

| 前提 | 实测结果 | 影响 |
| --- | --- | --- |
| Node 版本 | v26.10.0 | — |
| **原生运行 TypeScript** | ✅ `node src/x.ts` 直接跑通（含类型注解、ESM） | **零构建步骤**，不需要 tsc/esbuild/tsx |
| **`node:sqlite`** | ✅ 可用，SQLite **3.53.4**，中文读写正常 | **零原生编译依赖**，不需要 better-sqlite3 |
| WebView2 | 153.0.4234.48 | M1 的 Tauri 渲染引擎已就位 |
| Rust / MSVC | ❌ 缺失 | M1 前安装，M0 不受影响 |

> **由此确定的核心工程约束**：M0 的 `dependencies` 为空。全部使用 Node 内置能力，避免在 Windows 上引入 node-gyp、构建工具链与版本地狱。

---

## 2. 架构

### 2.1 三层结构

```
┌──────────────────────────────────────────────────────────────┐
│  界面层  ui/            （可整体替换）                          │
│  M0: 快记窗 + 主界面（极简 HTML，由本地 HTTP 服务提供）           │
│  M1: Tauri 窗口 / 托盘 / 悬浮组件 / 全局快捷键                   │
└───────────────────────────┬──────────────────────────────────┘
                            │  服务门面（进程内函数调用；M1 改用 IPC）
┌───────────────────────────▼──────────────────────────────────┐
│  内核层  core/           （无界面依赖、无网络依赖）              │
│                                                              │
│   domain/     类型与不变量（Project/Task/Subtask/…）           │
│   db/         连接、PRAGMA、迁移、事务封装                      │
│   repo/       每张表的纯 CRUD（SQL 只出现在这一层）              │
│   service/    业务规则（捕获、拆解、日志汇总、搜索）              │
│   day/        日界（4 点切日）与日期解析                        │
│   ai/         AI 适配器（M2）；只产出提案，不写库                 │
└───────────────────────────┬──────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │  data/workhelper.db (WAL)  │
              │  data/attachments/         │
              │  data/backups/             │
              └───────────────────────────┘
```

### 2.2 分层纪律（写成可检查的规则）

1. **SQL 只允许出现在 `core/repo/`**。其它任何目录出现 `db.prepare(` 视为违规。
2. **`core/` 不得 import `ui/`、`http`、`node:http`**。内核可脱离界面独立运行与测试。
3. **`ui/` 不得直接访问数据库**，只能调用 `core/service/` 暴露的门面。
4. **迁移只前进不后退**：每个迁移文件只做 `up`，不做 `down`；回滚靠备份恢复。
5. **时间一律以 UTC ISO 8601 字符串存库**，本地化只在展示层与日界计算处发生。

### 2.3 实现期新增的硬约束（编码时必须遵守）

| 约束 | 原因（均为实测踩坑，非推测） |
| --- | --- |
| **`migrations/*.sql` 必须是纯 ASCII** | SQLite 的 `exec()` 从字节 0 开始解析，文件开头的非 ASCII 注释（例如全角括号）会让解析器误判，报出极具误导性的 `near "/": syntax error`。中文说明写在设计文档与 TS 注释里，SQL 内只用英文注释 |
| **不使用 TS `enum`** | Node 的原生类型剥离不支持它（会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。枚举一律用 `as const` 数组，同时承载编译期联合类型与运行时取值集合 |
| **`node:sqlite` 调用点必须集中** | `node:sqlite` 的 `get()`/`all()` 返回 `unknown`，形状断言只在 `db/connection.ts` 的 `queryOne`/`queryAll` 与各 `repo` 内出现，避免 `as` 散布到业务层 |
| **相对导入必须带 `.ts` 扩展名** | Node ESM 不做扩展名补全；同时 `tsconfig` 开启 `allowImportingTsExtensions` |
| **迁移文件数与 `SCHEMA_VERSION` 必须同步** | 由 `assertSchemaVersionInSync()` 在 `migrate()` 入口强制校验，忘改常量会立即报错而不是静默错位 |

---

## 3. 目录结构

```
WorkHelper/
├─ docs/
│  ├─ requirements.md
│  ├─ research-existing-solutions.md
│  └─ design.md                    ← 本文
├─ src/
│  ├─ core/
│  │  ├─ domain/
│  │  │  ├─ types.ts               枚举、实体类型、DTO
│  │  │  ├─ errors.ts              领域错误（NotFound / InvalidTransition / …）
│  │  │  └─ rules.ts               状态机与不变量校验
│  │  ├─ db/
│  │  │  ├─ connection.ts          打开库、PRAGMA、单例
│  │  │  ├─ migrations.ts          迁移执行器（基于 user_version）
│  │  │  ├─ migrations/            001_init.sql、002_xxx.sql …
│  │  │  └─ tx.ts                  事务包装 withTx()
│  │  ├─ repo/
│  │  │  ├─ projects.ts  tasks.ts  subtasks.ts
│  │  │  ├─ progress.ts  inbox.ts  archives.ts
│  │  │  ├─ dailyLogs.ts settings.ts search.ts  trash.ts
│  │  ├─ service/
│  │  │  ├─ capture.ts             捕获：快记、分类、转任务
│  │  │  ├─ planning.ts            规划：项目/任务/子任务、拖拽排序
│  │  │  ├─ tracking.ts            推进：进展记录、状态流转、今日视图
│  │  │  ├─ journal.ts             日志：自动汇总、补录
│  │  │  ├─ export.ts              Markdown 导出（M2）
│  │  │  ├─ backup.ts              启动快照与轮换
│  │  │  └─ index.ts               服务门面（界面唯一入口）
│  │  ├─ day/
│  │  │  ├─ dayKey.ts              4 点切日：本地时间 ↔ 日键
│  │  │  └─ parseDate.ts           自然语言日期解析（高置信度）
│  │  ├─ ai/                       （M2）
│  │  │  ├─ provider.ts            OpenAI 兼容客户端
│  │  │  ├─ prompts/               拆分 / 日报提示词
│  │  │  └─ splitProposal.ts       提案对象与校验（不可直接写库）
│  │  └─ index.ts
│  ├─ ui/                          （M0 极简，M1 替换为 Tauri 前端）
│  │  ├─ server.ts                 本地 HTTP：静态资源 + JSON API
│  │  ├─ static/
│  │  │  ├─ capture.html           快记窗
│  │  │  ├─ capture.js
│  │  │  ├─ main.html              主界面（收件箱 / 今日 / 项目树 / 日志）
│  │  │  └─ main.js
│  └─ cli/
│     ├─ wh.ts                     日常命令入口
│     └─ verify.ts                 数据完整性自检
├─ scripts/
│  └─ dev.ps1                      启动 M0 的本地服务
├─ data/                           （git 忽略）
│  ├─ workhelper.db
│  ├─ attachments/
│  └─ backups/
├─ tests/                          node:test
├─ package.json
├─ tsconfig.json                   仅供编辑器提示，不参与运行
├─ .gitignore
└─ README.md
```

---

## 4. 数据模型

### 4.1 实体关系

```
projects ──< tasks ──< subtasks
    │           │          │
    └───────────┴──────────┴──< progress_entries   (三选一挂载，CHECK 约束)
    
inbox_items ──(转任务)──> tasks          (保留 source_inbox_id 回溯)

daily_logs      一天一条，按 day_key 唯一
archive_items   会议纪要/链接/截图，可关联任意对象，也可游离
attachments     文件元信息，被 archive_items 引用
settings        键值配置（日界小时、AI 参数、UI 偏好）
```

### 4.2 通用约定

- **主键**：`TEXT`，应用侧生成小写 UUID v4（`crypto.randomUUID()`）。不用自增整数，避免日后合并/导入时冲突。
- **时间列**：`TEXT`，UTC ISO 8601（`2026-09-29T07:30:00.000Z`）。SQLite 无原生时间类型，字符串字典序即时间序，可直接比较与排序。
- **日键列**：`TEXT`，本地日期 `YYYY-MM-DD`，由 `day/dayKey.ts` 按日界算出。**冗余存储**是为了让"按天聚合"能走索引，而不是每次全表扫时间戳。
- **布尔**：`INTEGER` 0/1。
- **删除**：`deleted_at TEXT NULL` 软删除；所有业务查询默认追加 `deleted_at IS NULL`。

### 4.3 枚举取值（存在 `CHECK` 约束里，与 `domain/types.ts` 必须一致）

| 字段 | 取值 |
| --- | --- |
| `projects.status` | `active` / `paused` / `done` / `archived` |
| `projects.priority` | `high` / `normal` / `low` |
| `tasks.status` | `todo` / `doing` / `blocked` / `done` / `cancelled` |
| `tasks.priority` | `high` / `normal` / `low` |
| `subtasks.status` | `todo` / `done` |
| `progress_entries.kind` | `progress` / `blocker` / `decision` / `waiting` |
| `inbox_items.status` | `pending` / `converted` / `archived` |
| `archive_items.kind` | `note` / `meeting` / `link` / `file` |

### 4.4 建表 DDL

```sql
-- 001_init.sql

-- 项目：一件事 / 一个阶段 / 一条工作线
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  goal         TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','done','archived')),
  priority     TEXT NOT NULL DEFAULT 'normal'
                 CHECK (priority IN ('high','normal','low')),
  start_date   TEXT,
  due_date     TEXT,
  sort_order   REAL NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_projects_status ON projects(status, sort_order) WHERE deleted_at IS NULL;

-- 任务：可独立交付、有完成判据的工作单元
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  detail           TEXT,
  status           TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('todo','doing','blocked','done','cancelled')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('high','normal','low')),
  due_at           TEXT,                       -- 含时间的截止（用于 P1 截止提醒）
  due_date         TEXT,                       -- 纯日期截止（用于"今天到期"聚合）
  estimate_minutes INTEGER,                    -- Q1：保留字段，不做计时
  blocked_reason   TEXT,                       -- status='blocked' 时必填（由服务层校验）
  planned_for      TEXT,                       -- 手工"加入今日"的日键
  completed_at     TEXT,
  sort_order       REAL NOT NULL DEFAULT 1,
  source_inbox_id  TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id, sort_order)  WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_status  ON tasks(status, due_date)        WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_today   ON tasks(planned_for)             WHERE deleted_at IS NULL;

-- 子任务：任务下的可执行步骤
CREATE TABLE subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  due_date     TEXT,
  completed_at TEXT,
  sort_order   REAL NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_subtasks_task ON subtasks(task_id, sort_order) WHERE deleted_at IS NULL;

-- 进展记录：可挂在项目 / 任务 / 子任务任意一层，恰好挂一个
CREATE TABLE progress_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id)    ON DELETE CASCADE,
  subtask_id  TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'progress'
                CHECK (kind IN ('progress','blocker','decision','waiting')),
  body        TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK (
    (project_id IS NOT NULL) + (task_id IS NOT NULL) + (subtask_id IS NOT NULL) = 1
  )
);
CREATE INDEX idx_progress_task    ON progress_entries(task_id, occurred_at DESC)    WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_project ON progress_entries(project_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_day     ON progress_entries(day_key)                      WHERE deleted_at IS NULL;

-- 收件箱：一切未分类输入的落点
CREATE TABLE inbox_items (
  id           TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  kind_hint    TEXT CHECK (kind_hint IN ('todo','note')),   -- 快记时的芯片选择，仅作提示
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','converted','archived')),
  parsed_due   TEXT,                                        -- 自然语言解析出的日期（高置信度）
  raw_input    TEXT,                                        -- 原始输入，解析前的原文
  converted_to TEXT,                                        -- 转成什么（'task:uuid' / 'archive:uuid'）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_inbox_pending ON inbox_items(created_at DESC) WHERE status='pending' AND deleted_at IS NULL;

-- 每日日志：一天一条
CREATE TABLE daily_logs (
  id         TEXT PRIMARY KEY,
  day_key    TEXT NOT NULL UNIQUE,
  body       TEXT,                 -- 我手写的正文
  mood       TEXT,                 -- 预留，未使用
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 资料条目：会议纪要、链接、截图、文件
CREATE TABLE archive_items (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note','meeting','link','file')),
  title       TEXT,
  body        TEXT,
  url         TEXT,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id     TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
  day_key     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_archive_day  ON archive_items(day_key)  WHERE deleted_at IS NULL;
CREATE INDEX idx_archive_task ON archive_items(task_id)  WHERE deleted_at IS NULL;

-- 附件元信息（文件本体放 data/attachments/）
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  archive_id   TEXT REFERENCES archive_items(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  rel_path     TEXT NOT NULL,        -- 相对 attachments/ 的路径
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- 键值配置
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- JSON 编码
  updated_at TEXT NOT NULL
);

-- 全文检索（F-13）
-- 注意：CJK 文本必须先折叠成 bigram 再写入 tokens 列，原因见 §6.5（已实测）
CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_type UNINDEXED,             -- 'task' | 'subtask' | 'progress' | 'inbox' | 'archive' | 'log'
  entity_id   UNINDEXED,
  title,                             -- 原文，供展示
  body,                              -- 原文，供展示
  tokens,                            -- 折叠索引列：中文 bigram + 英文小写词
  tokenize = 'unicode61 remove_diacritics 2'
);
```

### 4.5 资料的数据模型（迁移 003 / 004）

需求把资料重新定位为**指针**（需求 §4.1），并确认了"入口要能按常用程度排序"（需求 §4.2 D2）。
后者直接决定了入口**不能塞进一个 JSON 字段，必须是子表**——否则无法对单个入口排序。

```sql
-- 003_material_entries.sql
-- 资料本身复用 archive_items，但语义变了：它现在是"指针的容器"。
-- 旧的 task_id / project_id 单值关联保留到 004 完成迁移后再删。

CREATE TABLE archive_entries (
  id         TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('dir', 'file', 'url')),
  target     TEXT NOT NULL,          -- 绝对路径或 URL，原样保存不做规范化
  note       TEXT,                   -- 该入口自己的注释（需求 §4.2 D4）
  sort_order REAL NOT NULL DEFAULT 1,-- 入口级排序，支持"按常用程度"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_archive_entries ON archive_entries(archive_id, sort_order) WHERE deleted_at IS NULL;

-- 004_material_links.sql
-- 一条资料可挂靠多个任务/项目（需求 §4.2 D2 + F-12）。

CREATE TABLE archive_links (
  archive_id TEXT NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'project')),
  target_id   TEXT NOT NULL,        -- 多态，故无外键；由服务层保证存在性
  created_at  TEXT NOT NULL,
  PRIMARY KEY (archive_id, target_type, target_id)
);
CREATE INDEX idx_archive_links_target ON archive_links(target_type, target_id);
```

**为什么 `archive_links.target_id` 不设外键**：它要同时指向 `tasks` 与 `projects`，
SQLite 没有多态外键。代价是删除任务时需要服务层显式清理关联行
（`deleteTask` 里加一步；同时 `verify` 增加"孤儿挂靠"检查项兜底）。

**"必须挂靠"如何强制**：这是跨行的约束，数据库层做不到（一条资料可以有零行 link）。
因此由**服务层在创建/更新资料时校验**，并在 `verify` 里加一条自检：
"存在挂靠数为 0 的正式资料"。这与"进度记录恰好挂一个父对象"用 `CHECK` 强制的思路不同——
那条是行内约束，这条是聚合约束，只能靠服务层 + 自检。

**搜索索引**：资料的索引文本要包含**全部入口的 target 与 note**，
这样才能实现需求 F-15 的"搜资料的标题/注释/路径"。规则：`indexEntity` 时把入口拼进 body。

### 4.6 几个设计取舍的理由

| 取舍 | 原因 |
| --- | --- |
| **收件箱独立建表**，不复用 `tasks` | 任务必须有项目归属，而捕获时不允许要求分类；混用会让 `project_id` 变成可空噪声，并让"今日视图"被未分类条目污染 |
| **进展记录用三列可空外键 + CHECK**，而不是多态 `(target_type, target_id)` | 保留真实外键约束与 `ON DELETE CASCADE`，SQLite 才能在删除父对象时自动清理；多态方案失去引用完整性 |
| **`due_at` 与 `due_date` 分开** | "今天到期"聚合要按本地日键匹配，若只有一个带时区的时间戳，跨时区与跨日界时会算错；两者由服务层保持一致 |
| **`sort_order` 用 REAL** | 拖拽排序时插入到两项之间只需取中间值（`(a+b)/2`），不必重排整列；这是 M0 拖拽体验的关键 |
| **软删除用 `deleted_at`**，不做 `is_deleted` | 一个字段同时承载"是否删除"与"何时删除"，回收站可按 30 天到期清理 |
| **日键冗余存储** | 按天聚合（每日日志、周报）是最频繁查询；实时计算 4 点切日无法用索引 |
| **没有变更日志表** | 单机单用户无同步需求；事实源就是关系表，备份即完整快照 |

---

## 5. 日界算法（4 点切日）

需求 F-17：默认凌晨 4 点切日——凌晨 1 点的记录算前一天。

```ts
// core/day/dayKey.ts
export function dayKeyOf(instant: Date, boundaryHour: number, tzOffsetMinutes?: number): string
```

算法（**纯本地时间运算，不引入时区库**）：

1. 取该时刻的本地时间分量（年、月、日、时、分）。
2. 若 `hour < boundaryHour`，本地日期减一天。
3. 格式化为 `YYYY-MM-DD`。

判定用例（边界必须写成测试）：

| 本地时间 | 日界小时 | 期望日键 |
| --- | --- | --- |
| 2026-09-29 23:59 | 4 | `2026-09-29` |
| 2026-09-30 00:00 | 4 | `2026-09-29` |
| 2026-09-30 03:59 | 4 | `2026-09-29` |
| 2026-09-30 04:00 | 4 | `2026-09-30` |
| 2026-09-30 12:00 | 4 | `2026-09-30` |
| 2026-09-30 00:00 | 0 | `2026-09-30`（0 点时退化为自然日） |
| 2026-01-01 02:00 | 4 | `2025-12-31`（跨年） |
| 2026-03-01 02:00 | 4 | `2026-02-28`（跨月，非闰年） |

**注意**：`occurred_at` 仍存真实 UTC 时间戳，日键只是它的一个派生投影。任何"补录到昨天"的操作都必须同时写 `occurred_at`（真实时刻）与 `day_key`（归属日），两者不要求一致——这是补录能成立的前提。

---

## 6. 内核服务接口（界面层唯一入口）

```ts
// core/service/index.ts —— 门面，M1 换成 IPC 时此签名不变

export interface WorkHelperServices {
  capture:  CaptureService;
  planning: PlanningService;
  tracking: TrackingService;
  journal:  JournalService;
  search:   SearchService;
  system:   SystemService;
}
```

### 6.1 CaptureService — 捕获（F-01 ~ F-05）

```ts
interface CaptureService {
  /** 快记：唯一一条不能失败的通路。整条路径同步、单事务、无网络。 */
  quickCapture(input: { text: string; kindHint?: 'todo' | 'note' }): {
    item: InboxItem;
    parsed: ParsedDate | null;   // 高置信度日期解析结果，仅用于界面提示
  };

  listPending(options?: { limit?: number }): InboxItem[];

  /** 单条分类。target 决定落到哪张表 */
  classify(id: string, target:
    | { kind: 'task'; projectId?: string | null; dueDate?: string | null }
    | { kind: 'archive'; archiveKind?: ArchiveKind }
    | { kind: 'discard' }
  ): { kind: string; id: string };

  /** 批量分类（收件箱一次清空多条） */
  classifyMany(ids: string[], target: ClassifyTarget): ClassifyResult[];

  /** 撤销上一次分类（AI 写入后的一键撤销也走这里） */
  undoLastClassification(): boolean;
}
```

**"不存在保存失败"的实现方式**（需求 §6.3）：`quickCapture` 内部只有一个事务、一条 INSERT，无网络、无文件 IO（除 SQLite 自身）。任何解析失败都降级为"原样存标题"，不抛错。

### 6.2 PlanningService — 结构（F-06 ~ F-09）

```ts
interface PlanningService {
  createProject(input: { title: string; goal?: string; dueDate?: string | null }): Project;
  updateProject(id: string, patch: ProjectPatch): Project;

  createTask(input: { title: string; projectId?: string | null; priority?: Priority;
                      dueDate?: string | null; estimateMinutes?: number | null }): Task;
  updateTask(id: string, patch: TaskPatch): Task;
  setTaskStatus(id: string, status: TaskStatus, opts?: { blockedReason?: string }): Task;
  completeTask(id: string, opts?: { cascadeSubtasks?: boolean }): Task;

  createSubtask(input: { taskId: string; title: string }): Subtask;
  updateSubtask(id: string, patch: SubtaskPatch): Subtask;

  /** 拖拽排序：把 movedId 插到 beforeId 之前（null = 末尾） */
  reorder(kind: 'project' | 'task' | 'subtask', movedId: string,
          beforeId: string | null, newParentId?: string | null): void;

  projectTree(projectId: string): ProjectTree;   // 项目 + 任务 + 子任务 + 各自进展计数
}
```

### 6.3 TrackingService — 推进与全部（F-08、F-09、F-10）

```ts
interface TrackingService {
  /** 追加进展记录；target 三选一 */
  addProgress(input: {
    target: { kind: 'project' | 'task' | 'subtask'; id: string };
    kind: ProgressKind;
    body: string;
    /** 补录用：不传则取当前时刻与该时刻的日键 */
    occurredAt?: string;
  }): ProgressEntry;

  /** 任务下的进展时间线 */
  timeline(target: { kind: string; id: string }, options?: { limit?: number }): ProgressEntry[];

  /** 今日视图（F-08）：逾期置顶 + 今日到期 + 手工加入今日 */
  todayView(dayKey?: string): {
    overdue: Task[];
    dueToday: Task[];
    planned: Task[];
    blocked: Task[];
    inboxCount: number;
  };
}
```

**状态联动规则**（写进 `domain/rules.ts` 并单测）：
- 追加 `kind='blocker'` 的进展 → 任务状态自动转 `blocked`，并把 `body` 写入 `blocked_reason`。
- 任务转 `blocked` 而 `blocked_reason` 为空 → 抛 `InvalidTransition`（服务层校验，不靠 UI）。
- 所有子任务 `done` → 提示（不自动）完成任务；`cascadeSubtasks: true` 时才级联标记。
- 任务转 `done` 时写 `completed_at`；从 `done` 改回其它状态时清空 `completed_at`。

### 6.4 JournalService — 日志（F-17 ~ F-19）

```ts
interface JournalService {
  /** 自动汇总（不写库，纯查询投影） */
  summarize(dayKey: string): {
    dayKey: string;
    completedTasks: Task[];
    completedSubtasks: Subtask[];
    createdInbox: InboxItem[];
    createdTasks: Task[];
    carriedOver: Task[];               // 该日未完成、且日界早于今天
    openBlockers: ProgressEntry[];
    timeline: ProgressEntry[];         // 当日全部进展记录，按时间
  };

  get(dayKey: string): DailyLog | null;
  /** 保存手工正文（自动汇总部分不落库，避免数据重复与过期） */
  save(dayKey: string, body: string): DailyLog;
}
```

**关键决策**：自动汇总是**运行时投影**，不写进 `daily_logs.body`。否则任务状态一变，历史日志就变成错的。日志只保存我手写的正文。

**另一个必须记住的口径**（实现期踩坑修正）：进展记录按 **`day_key`（归属日）** 取，
**不能**按 `occurred_at`（真实时刻）的时间区间取。补录一条"三天前做的事"时，
`day_key` 是那一天而 `occurred_at` 是现在——若按时间区间查询，
这条补录会被排除在它所属的那一天之外，补录功能就失效了。
任务与子任务则按时间戳区间取（它们没有独立的归属日字段）。

### 6.5 SearchService — 搜索（F-13）★ 已实测定型

```ts
interface SearchService {
  search(query: string, options?: { types?: EntityType[]; limit?: number }): SearchHit[];
  /** FTS 索引维护：由 repo 写入后同步调用，失败只记日志不阻断业务 */
  reindex(entityType: EntityType, entityId: string): void;
  reindexAll(): number;
}
```

#### 中文检索：实测结论与最终方案

M0 设计初期，FTS5 用 `unicode61` 分词器直接索引中文**实测完全不可用**：

| 查询 | `unicode61` 直接索引 | 原因 |
| --- | --- | --- |
| `"接口文档"`（整串） | ❌ 无结果 | `unicode61` 把连续 CJK 串当成**一个** token，而查询被解析成短语匹配 |
| `"文档"`（子串） | ❌ 无结果 | 子串不是独立 token |
| `data` / `DATA` | ✅ 命中 | 英文分词正常，且大小写不敏感 |

**最终方案：bigram 折叠索引**。写入 `tokens` 列前，把文本折叠成 `unicode61` 能正确切分的形态：

```ts
// core/repo/search.ts
export function toTokens(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) out.push(m[0].toLowerCase());  // 英文/数字
  for (const run of text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {          // 连续 CJK 段
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));        // 相邻双字
  }
  return out.join(' ');
}
// 例：'整理Q3数据平台迁移方案' → 'q3 整理 数据 据平 平台 台迁 迁移 移方 方案'
```

查询侧同样折叠，再用**列限定短语匹配**：`WHERE search_fts MATCH 'tokens : "<折叠后的查询>"'`。

**实测数据（1005 条记录，本机 SQLite 3.53.4）**：

| 指标 | 结果 |
| --- | --- |
| 与 `LIKE '%…%'` 兜底的**结果一致性** | **11 / 11 用例完全一致**（含中文整串、子串、中间片段、跨词子串、中英混合、英文大小写、多词） |
| FTS5+bigram 查询耗时 | **3.57 ms**（走倒排索引，随数据量**亚线性**增长） |
| `LIKE '%…%'` 兜底耗时 | 2.25 ms —— 但**这是全表扫描**，1000 条即可见劣化趋势，1 万条约 20ms+，10 万条将突破 200ms 指标 |
| 误报 | 未发现；"看不见的问题" 仅被查询"看不见"命中 |

**决策：采用 FTS5 + bigram 作为唯一检索通路，`LIKE` 仅降级用于查询长度 < 2 个字符的场景**（bigram 无法覆盖单字查询，此时退化为 `LIKE`，因单字查询结果集小，全表扫描代价可接受）。

> 原设计文档把此项列为"未决项 D1"，现**已实测关闭**。

### 6.6 SystemService — 系统

```ts
interface SystemService {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  dayBoundaryHour(): number;            // 默认 4，可配置（F-17）
  createBackup(reason: string): string; // 返回快照路径
  integrityCheck(): { ok: boolean; issues: string[] };  // PRAGMA integrity_check + 业务自检
  trash: { list(): TrashEntry[]; restore(id: string): void; purge(): number };
}
```

---

## 7. M0 界面契约（极简，用于验证闭环）

M0 不做 Tauri，用一个本地 HTTP 服务 + 静态页面跑通闭环（M1 替换为真正的桌面壳，**内核代码一行不改**）。

### 7.1 本地服务

- 只监听 `127.0.0.1`，端口默认 `7317`（可配置），避免任何外部可达面。
- 路由：`GET /` → 主界面；`GET /capture` → 快记窗；`POST /api/<service>/<method>` → 门面转发。
- **不引入 Web 框架**：用 `node:http` 手写 30 行路由。

### 7.2 快记窗（F-01 / F-02 的 M0 形态）

| 元素 | 行为 |
| --- | --- |
| 输入框 | 打开即聚焦；`Enter` 保存并关闭；`Shift+Enter` 换行；`Esc` 取消 |
| 类型芯片 | `收件箱`（默认选中）/ `资料`——**键盘可达**，且点击不移走输入框焦点 |
| 解析提示 | 若识别到高置信度日期，显示浅色标签 `截止 2026-10-07` 与标题预览；识别不到则**不渲染任何元素** |
| 保存反馈 | 窗口收起动画 300ms；不弹确认框 |
| 失败处理 | 不做错误弹窗——写入失败时窗口**不关闭**并在输入框下方显示一行红字 |

**关于芯片数量的澄清（实现期修正）**：本节最初写的是三个芯片（`收件箱 / 进展 / 资料`）。
但按数据模型，进展记录**必须挂在项目/任务/子任务上**（由 `CHECK` 约束保证恰好挂一个），
而快记时还没有目标对象。因此"进展"不属于快记窗——它属于任务视图里的操作。
芯片最终为两个：`收件箱`（`kindHint='todo'`）与 `资料`（`kindHint='note'`）。

M0 用浏览器窗口模拟；M1 用 Tauri 的无边框置顶窗 + 全局快捷键替换。
**已知限制**：浏览器窗口无法真正"不抢焦点"，这一点只有 Tauri 阶段才能成立。

### 7.3 主界面（M0 最小集）

五个页签，只做能验证需求的东西：

| 页签 | 内容 | 验证的需求 |
| --- | --- | --- |
| **收件箱** | 待处理列表 + 多选 + `转任务`（可指定项目）/ `转项目` / `存为资料`（**必须先选目标**）/ `丢弃` / `删除`；顶部显示待处理数量 | F-04、需求 §6.5 |
| **全部** | **所有未结束任务**，分六组：逾期 / 今天到期 / 进行中 / 卡住 / 已排期（未来）/ 没有排期。每组可 `记一笔`、`排入今日`、状态推进、`完成` | **F-09、需求 §6.6 可见性约束** |
| **今日** | 逾期 / 今天到期 / 已排入今日 / 阻塞 四组；额外显示"还有 N 条不在这里"的指引 | F-08、F-10 |
| **项目** | 项目 → 任务 → 子任务树；行内展开进展时间线（**拖拽排序尚未接界面**） | F-06、F-07 |
| **日志** | 日期选择器 + 自动汇总区（只读）+ 手工正文编辑区 | F-20、F-21 |
| **资料** | 按时间倒序列出资料；可筛"未挂靠"；可改/追加挂靠；多选入口批量打开。**默认显示，设置里可隐藏** | **F-11 ~ F-14** |

**两个计数徽标常驻顶部**：收件箱积压数、**未结束任务总数**（有逾期时转红）。
后者是契约 V3 的落点——不这样做，积压会静默增长而我不知道。

**任务/项目上的资料展示**（需求 F-14）：折叠一行 `📎 资料 3 条` → 展开后每个入口一个复选框 + 打开按钮，
底部一个 `[打开选中的 N 项]`。**不自动打开**，保持"自动化都要经我同意"的一致风格。

**收件箱工具栏的布局**（用户确认"选 ② + 需要文字提示"）：
主按钮保持 `转任务` / `存为资料` / `丢弃` 一眼可辨；
`转项目`、`删除`、`撤销` 收进 **`更多 ▾`** 菜单，**每个菜单项带一行说明**
（如"转项目 —— 这一条本身就是一件事"）。理由是这些动作低频，而主路径必须保持零思考。

M0 **刻意不做**：悬浮组件、托盘、全局快捷键、提醒、AI、导出、附件上传（**含文件本体落盘**）。
**资料关联、拖拽排序尚未实现**，属已知缺口，见 §11.5。
**拖入文件识别真实路径需要 Tauri**——浏览器拿不到 `File` 的绝对路径（安全限制），
这是环境约束而非取舍，已在需求 F-13 注明。

### 7.4 可见性契约的实现要点（§6.6 的落点）

这三条是 M0 可用性的关键，改动界面时必须守住：

| 契约 | 实现方式 | 防止的失败形态 |
| --- | --- | --- |
| **V1 全部可见** | `tracking.openTasksView()` 按固定优先级归组：阻塞 → 进行中 → 逾期 → 今天到期 → 未来排期 → 没有排期。**判定互斥**，每条任务恰好落一组 | 无日期无项目的任务无处可去 |
| **V2 不自相矛盾** | 今日页计算"四组之外的未结束任务数"，若大于 0 就渲染一块显式指引，附「去全部看这 N 条」按钮 | 顶上说"未结束 3"、下面说"今天没有待办" |
| **V3 积压可见** | 主界面顶部常驻未结束计数徽标，有逾期时标红 | 任务静默沉底，我不知道有事悬着 |

**归组优先级的理由**：阻塞与进行中优先于时间维度——一条逾期但正在做的任务，
应该显示在「进行中」而不是「逾期」，因为它已经在处理了。把两处都显示会让人以为有两件事。

**测试覆盖**：`service-tracking-journal.test.ts` 里有 5 个"可见性契约"用例，
包含"分组不得重叠也不得遗漏"与"计数必须等于列出的条数"。

---

## 8. 关键流程时序

### 8.1 快记（目标 ≤ 500ms 端到端）

```
热键/打开窗 → 输入文本 → Enter
   ↓
core.service.capture.quickCapture(text)
   ├─ day.parseDate(text)        纯本地正则/规则，无网络 → 返回 {date} | null
   ├─ withTx:
   │    ├─ INSERT inbox_items
   │    └─ search.reindex('inbox', id)     （失败只记日志）
   └─ 返回 item + parsed
   ↓
窗口关闭 + 动画
```

时间预算：SQLite 单条 WAL 提交 ≈ 1–5ms；日期解析为纯字符串规则 ≈ <1ms；**总预算远低于 500ms，瓶颈只会在界面层**。

### 8.2 收件箱清空（F-04）

```
多选 ids → 选择目标
   ├─ 转任务：为每题：INSERT tasks（source_inbox_id 回溯）→ UPDATE inbox_items.status='converted'
   ├─ 归档：  INSERT archive_items → 同上
   └─ 丢弃：  UPDATE inbox_items.status='archived'
   全部在一个事务内；记录 last_classification 供 undoLastClassification() 撤销
```

### 8.3 AI 拆分（M2，先定契约防返工）

```
选中收件箱条目/任务 → 「帮我拆」
   ↓
ai.splitProposal(input)  →  SplitProposal {
      parentTitle, subtasks: [{ title, acceptance?, estimateMinutes?, order }],
      model, raw
   }                        ← 只产出对象，绝不写库
   ↓
界面渲染可编辑预览（增/删/改/合并/重排）
   ↓
用户点确认 → planning.createSubtask(...) × N   ← 写入只发生在这一步
   ↓
记录 proposal 与结果，供整体撤销
```

**硬性约束**：`core/ai/**` 不得 import `core/repo/**`。此约束由 §2.2 第 1 条的可检查规则兜底。

---

## 9. 备份与数据安全（F-15 / Q6）

| 机制 | 实现 |
| --- | --- |
| 启动快照 | 每次进程启动，用 SQLite 在线备份 API 或 `VACUUM INTO` 生成 `data/backups/wh-YYYYMMDD-HHmmss.db` |
| 轮换策略 | 保留最近 **7 个日快照 + 4 个周快照**，超出自动删除 |
| 软删除 | `deleted_at` 标记；回收站保留 **30 天**；`purge()` 清理到期项 |
| 完整性自检 | `PRAGMA integrity_check` + 业务自检（孤儿记录、状态不一致、`blocked` 无原因） |
| 导出兜底 | M2 的 Markdown 导出兼作"人可读备份" |

---

## 10. 测试策略

用 Node 内置 `node:test`，**零测试框架依赖**。

| 层级 | 必测内容 |
| --- | --- |
| 日界 `dayKey.test.ts` | §5 表格中的全部 8 个边界用例 + 跨年跨月 |
| 日期解析 `parseDate.test.ts` | "下周三 / 明天 / 10月8日 / 下个月3号"；**必须包含反例**："看不见的问题"不得被解析成日期 |
| 状态机 `rules.test.ts` | 非法流转被拒；`blocked` 无原因是错误；`done` ↔ 其它状态时 `completed_at` 的正确性 |
| 迁移 `migrations.test.ts` | 空库跑到最新版；重复执行幂等；`user_version` 正确 |
| 服务 `capture.test.ts` | 快记 + 分类 + 撤销；中文文本往返无损 |
| 搜索 `search.test.ts` | 中文子串、英文大小写、1000 条数据下的响应时间 |
| 完整性 `integrity.test.ts` | 软删除后查询不可见；级联删除正确；回收站恢复 |

---

## 11. M0 任务清单（按提交顺序）

| # | 任务 | 产出 | 完成判据 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | 工程骨架 | `package.json`（零依赖）、`tsconfig.json`（仅编辑器提示）、目录树 | `node src/cli/wh.ts --version` 有输出 | ✅ 已完成 |
| T2 | 数据层 | `db/connection.ts`、`migrations.ts`、`001_init.sql` | 空库一键建表；`user_version=1`；重复运行幂等 | ✅ 已完成 |
| T3 | 日界与日期解析 | `day/dayKey.ts`、`day/parseDate.ts` | §10 两个测试文件全绿 | ✅ 已完成 |
| T4 | 领域规则 | `domain/types.ts`、`errors.ts`、`rules.ts` | 状态机测试全绿 | ✅ 已完成 |
| T5 | 仓储层 | `repo/*`（11 个模块） | 每个 repo 有覆盖 CRUD + 软删除的单测 | ✅ 已完成 |
| T6 | 服务层 | `capture`、`planning`、`tracking`、`journal`、`search`、`system` | 服务级单测全绿（含收件箱清空与撤销） | ✅ 已完成 |
| T7 | CLI 验证器 | `cli/wh.ts`、`cli/refs.ts`、`cli/verify.ts` | 能在无界面情况下登记、分类、写日志并自检通过 | ✅ 已完成 |
| T9 | 备份与回收站 | `service/systemService.ts`、`repo/trashRepo.ts` | 快照生成、轮换、恢复、30 天清理测试通过 | ✅ 已完成 |
| T8 | 本地服务与界面 | `ui/server.ts`、`ui/main.ts`、`ui/static/*` | **连续 3 天真实使用**（M0 验收，见需求 §8） | 🟡 已实现，待实测验收 |

> T9 实际与 T6 合并实现（备份与回收站都是 `SystemService` 的一部分），
> 拆成两步反而要来回改接口。T9 的内容已随 T6 一起完成并测试。

**M0 完成判据（不可妥协）**：我能连续 3 天用它登记与推进工作，且过程中没有丢过任何一条记录。

**当前进度**：T1–T9 全部实现完毕，页面与快记窗已可用，212 项内核测试仍全绿。
**剩下的只有验收本身**——即"连续 3 天真实使用"。

### 11.1 T1–T9 实际交付（已完成）

| 项 | 结果 |
| --- | --- |
| 测试 | **212 项内核测试全部通过**（`node --test tests/`），零测试框架依赖 |
| 依赖 | `dependencies` 为空，`node_modules` 不存在 |
| 构建步骤 | 无需构建：`node src/cli/wh.ts` 与 `node src/ui/main.ts` 都直接运行 |
| 数据层 | 10 张表 + 部分索引 + FTS5，2 个迁移，结构版本 v2 |
| 仓储层 | 11 个模块，85 个导出 |
| 服务层 | 6 个服务 + 统一门面 `createServices()` |
| CLI | 28 条命令，支持 `--json` 与短 ID 前缀解析 |
| 界面 | 本地 HTTP 服务（仅绑 127.0.0.1）+ 快记窗 + 四页签主界面 + 全局搜索 |

界面相关的额外验证：**接口冒烟测试 28 项**（含白名单拦截、参数形状、错误消息非空）、
**前端视图驱动测试 7 项**（用 DOM 桩跑通「取数 → 渲染 → 事件 → 保存落库」整条路）。

### 11.4 界面阶段的坑（实现期发现）

| # | 问题 | 后果 | 修复 |
| --- | --- | --- | --- |
| 12 | 接口把 `{}` 当成一个位置参数传给 `backup(reason)` | 备份文件名变成 `wh-...-[object Object].db`，且轮换逻辑认不出它 | 明确约定"数组=位置参数，非数组=首个参数"，界面侧按此显式适配 |
| 13 | 非领域错误的响应体里 `message` 为空 | 400 响应没有任何可读信息，排查全靠猜 | 所有错误路径都带上消息 |
| 14 | 服务方法签名不统一（有的收对象、有的收字符串） | 界面按统一方式调用时出现 `[object Object]`、`query.trim is not a function` | 在**界面层**做一次显式形状适配，而不是让服务端去猜 |
| 15 | CLI 默认数据目录基于当前工作目录 | 从桌面快捷方式或别的目录调用时"数据不见了" | 改为基于**脚本自身位置**推导项目根（`core/paths.ts`） |

**关于 #14 的取舍**：更彻底的做法是把所有服务方法统一成"单对象入参"，
但那要改动已通过 212 项测试的签名。当前选择是在界面层集中适配，
并把约定写进注释——**因为适配点是唯一的**（`api.js`），风险可控；
若日后接口消费者增多，再统一签名。

### 11.5 已知限制（诚实记录，不装作没有）

| 限制 | 说明 | 何时解决 |
| --- | --- | --- |
| 浏览器窗口无法真正"不抢焦点" | 需求 §6.1 在 M0 阶段只能部分满足 | M1 的 Tauri 无边框窗 |
| 没有全局热键 | 只能靠桌面快捷方式（A4 过渡方案） | M1 |
| **拖拽排序未接界面** | 未决项 D2 要求"指针事件优先"，内核侧 `reorder(kind, movedId, beforeId)` 已就绪并有测试，但界面还没接拖拽交互 | M1 界面阶段 |
| **跨项目移动任务无界面入口** | 内核 `updateTask({projectId})` 可用 | 与拖拽一并做 |
| **资料浏览页缺失（F-12）** | 归档的内容只能靠搜索找到，没有浏览入口 | M1 界面阶段 |
| **标签字段未实现** | 需求 §4 列了"标签"，数据模型里没有对应表/字段 | 与 F-07 详情编辑一并做（需迁移 003） |
| 收件箱"删除"入口缺失 | 内核 `deleteInboxItem` 与回收站都支持 | M1 界面阶段 |

### 11.6 M0 验收期由真实使用发现的界面缺陷

| # | 缺陷 | 现象 | 根因与修复 |
| --- | --- | --- | --- |
| 16 | **未结束任务在界面上消失** | 页面顶上说"未结束 3"，下面写"今天没有待办"；无截止日期或无项目的任务**永远看不到** | **需求漏了一个视图**（见需求 §9.3 R1）。新增 F-09「全部」视图 + §6.6 可见性约束 + 未结束计数徽标；5 个契约测试锁定 |
| 17 | **嵌套数组被字符串化** | 今日页只显示统计数字，任务列表变成一行 `[object HTMLDivElement]` | `el`/`mount` 只判断最外层是不是数组，内层数组落到 `String(child)`。改为递归摊平 `flattenNodes` |
| 18 | **资料条目与日志正文未进索引** | 归档的资料、写好的日志都搜不到（F-13 要求可搜） | 索引调用散落在 8 处写入路径里，漏了两处。收拢为 `service/indexer.ts` 统一维护，并补 4 个测试 |
| 19 | 接口参数形状不一致（11 处） | 点击「转任务」报 `Unknown named parameter 'id'`；项目页、"开始"、"解除"、"重开"、日志页同样失效 | 单参数方法传了裸值而协议要求数组。在 `api.js` 的 `call()` 里加**规范化**（非数组自动包成数组），从结构上杜绝 |
| 20 | `getSettings()` 返回带方法的对象 | HTTP 传不了函数，序列化后只剩 `{}`，界面报 `settings.list is not a function` | 改为返回**纯数据快照** `{ dayBoundaryHour, entries }` |
| 21 | 星期查找表缺阿拉伯数字键 | `周1`/`星期7` 被正则匹配到却在查表得到 `undefined` 并**静默返回 null** | `WEEKDAY_DIGITS` 补 `1-7` 键。类型是 `Record<string, number>` 所以 TS 不报警 |
| 22 | 剥离日期后残留中文空格 | `写一份下周三要交的接口文档` → `写一份 要交的接口文档` | 按语言习惯收紧：CJK 之间去空格，中英之间保留 |
| 23 | 浏览器跑缓存的旧前端代码 | 改完 `api.js` 后界面仍按旧形状发请求，表现为"修了但没生效" | `cache-control` 由 `no-store` 改为 `no-cache`（每次校验），脚本标签加版本参数 |

**#16 的教训最值得记**：它不是实现 bug，而是**需求漏了一个视图**。
契约 2（"永远不强迫我在记录时做决定"）必然产生"无日期无项目"的任务，
但文档从没回答"这类任务在哪里能看到"。我按字面实现了 F-08，结果就是一个自相矛盾的页面。
**规律：每写一条"降低输入门槛"的契约，都必须同时回答"这些输入事后在哪里被收容"。**

测试分布：`dayKey` 13、`parseDate` 18、`migrations` 17、`rules` 13、
`repo-*` 5 个文件、`service-*` 3 个文件、`cli` 19 项（真实 spawn 子进程，顺带验证跨进程落盘）。
当前合计 **225 项内核测试**，另有 **43 项接口契约测试**（直接驱动 `api.js`）与
**19 项可见性验证**（驱动界面事件并校验实际发出的请求）。

### 11.2 实现期发现并修复的 11 个真实缺陷（全部已写入测试固化）

| # | 缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | 日志汇总按 `occurred_at` 区间取进展 | **补录的进展永远不回属于自己的日志**（补录是核心需求） | 改按 `day_key` 取，并加测试锁定 |
| 2 | `day_key` 用表级 `UNIQUE` | 软删除当天日志后**再也写不回来** | 迁移 002 改为部分唯一索引（只约束未删除行） |
| 3 | 备份文件名精度只到秒 | 同一秒内连续备份**互相覆盖**（10 次只剩 1 个文件） | 追加序号后缀，并让解析支持序号 |
| 4 | `softDeleteById` 硬写 `updated_at` | `attachments` 没有该列，删除附件直接 `no such column` | 按表的真实列决定是否写 |
| 5 | 完成/取消的任务仍可写进展 | "完成的任务底下还在长记录"，日志完成数对不上 | 增加终态守卫 `assertTaskNotTerminal` |
| 6 | 同名状态流转被当作合法 no-op | `done → done` 静默成功并刷新完成时间 | 同名流转一律拒绝，终态必须显式重开 |
| 7 | SQL 文件含非 ASCII 注释 | 建表失败并报出误导性的 `near "/": syntax error` | SQL 注释全部改 ASCII（见 §2.3） |
| 8 | `quickCapture` 未写检索索引 | 收件箱内容搜不到 | 捕获后同步索引，失败只告警不阻断 |
| 9 | 收件箱排序无 tiebreak | 同一毫秒内多条记录顺序不稳定 | 加 `rowid DESC` 作次级排序键 |
| 10 | 星期语义歧义 | `下周一` 被当成"最近的周一"而非"下一周的周一" | 固定语义并更名 `forwardWeekdayOffset` |
| 11 | 迁移数与 `SCHEMA_VERSION` 可漂移 | 忘改常量导致升级判断错位 | `assertSchemaVersionInSync()` 强制校验 |

### 11.3 关键经验（写下来避免重犯）

- **补录最容易出错的地方是"按什么维度取数据"**：进展记录带归属日 `day_key`，
  而 `occurred_at` 是真实时刻。汇总必须按归属日，否则补录内容会从自己的日志里消失（缺陷 1）。
- **软删除与唯一约束会互相打架**：见到表级 `UNIQUE` 就要问"这行被软删除后还能重建吗"（缺陷 2）。
- **测试里不要硬编码日期**：默认日界是凌晨 4 点，下午跑测试时 `todayKey()` 与日历日期会差一天。
  测试夹具提供 `useDbWithCalendarDay()` 明确消除这层歧义（这个坑我踩了两次）。
- **通用辅助函数里的隐含假设必须被验证**：`softDeleteById` 假设了"每张表都有 `updated_at`"，
  该假设直到附件测试才被打破（缺陷 4）。
- **文件命名含时间戳时，要想清楚同粒度内重复调用会怎样**（缺陷 3）。
- **跨进程的测试不要断言"名字必须长什么样"**：备份测试曾断言第二个文件必须带 `-1` 后缀，
  但两次调用是两个独立进程，可能已跨到下一秒，此时不带后缀才是正确的。
  该断言制造了一个约 1/4 概率失败的不稳定测试——不稳定测试比没有测试更糟，
  因为它会训练人忽视红灯。断言应落在"不变量"上（两个文件、都不为空），而不是字面名字。

---

## 12. 设计阶段的未决项

| # | 项 | 状态 |
| --- | --- | --- |
| ~~D1~~ | ~~中文搜索是否需要引入 bigram 索引或分词表~~ | ✅ **已实测定型**：采用 FTS5 + bigram，见 §6.5 |
| D2 | 拖拽排序的 UI 实现（HTML5 DnD vs 指针事件） | M0 T8 开始时决 |
| D3 | Tauri 侧 IPC 形态（命令 vs 通道）与内核是否独立进程 | M1 设计时决 |
| D4 | 附件的去重与存储布局 | ✅ 仓储已支持按 `sha256` 查重（`findByDigest`）；**物理落盘与分片布局待 T8/M1 接入 UI 时实现** |
| D5 | `due_at` 与 `due_date` 的一致性维护点 | ⚠️ **当前由服务层维护，但尚无校验**。已列入 `verify` 的检查项（"有精确截止时间但缺少日期投影"），完整的一致性维护待接入截止提醒（F-21）时补齐 |
| ~~D6~~ | ~~FTS5 索引如何定位单条记录~~ | ✅ **已实现**：由 `(entity_type, entity_id)` 经 FNV-1a 推导稳定 rowid，单条重建即"删+插"，无需映射表（见 `repo/searchRepo.ts`） |

---

## 13. 设计验证记录（已实测，非推测）

设计中的高风险假设在动工前已全部实测，避免基于"想当然"编码：

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| Node 原生运行 TypeScript | 用带类型注解 + ESM + `node:sqlite` 的脚本直接 `node run` | ✅ 通过，**无需构建步骤** |
| `node:sqlite` 可用性 | 建表、中文读写、版本查询 | ✅ 可用，SQLite **3.53.4**，中文无损 |
| `journal_mode=WAL` | `PRAGMA` 读取回值 | ✅ 返回 `wal` |
| `foreign_keys=ON` | `PRAGMA` 读取回值 | ✅ 生效 |
| **§4.4 全部 DDL** | 原样执行建表 + 索引 + FTS5 虚拟表 | ✅ 全部成功，无语法错误 |
| `progress_entries` 的 `CHECK` 约束 | 尝试插入"三列全空"与"挂两个父对象" | ✅ 两种情况均被拒绝 |
| `ON DELETE CASCADE` 级联 | 删任务后统计孤儿进展记录 | ✅ 剩余 0 条 |
| 部分索引是否被使用 | `EXPLAIN QUERY PLAN` | ✅ `SCAN inbox_items USING INDEX idx_inbox_pending` |
| 中文全文检索 | 11 个用例对比 FTS5+bigram vs LIKE | ✅ 11/11 一致，3.57ms（详见 §6.5） |
| 快记通路时间预算 | 单条 WAL 提交 + 纯本地日期解析 | 预算远低于 500ms 指标，瓶颈只在界面层 |

**验证脚本位置**：`D:\temp\wh-probe\`（临时目录，不属于工程；T3/T5 会把其中的关键断言固化为 `tests/` 下的正式测试）。

安全提醒（工程纪律，非推测）：在本机对「工作秘书」自身跑 `PRAGMA integrity_check` / `foreign_key_check` / `quick_check` 属正常运维；但**切勿对本机其他 SQLite 库执行写操作或修复类 PRAGMA**（例如其他软件的数据文件），那可能造成不可逆的数据损坏。本项目只操作 `data/workhelper.db`。
