// 系统服务：设置、备份快照与轮换、完整性自检、回收站。
//
// 数据安全是单机工具的底线：没有云端兜底，误删与磁盘故障是仅有的两种
// 不可逆失败，因此备份与软删除在这里是一等公民能力，而不是附加功能。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  countDiscardedInbox, countTrash, findBlockedWithoutReason, findDoneWithoutTimestamp,
  listDiscardedInbox, listSettings, listTrash, purgeDiscardedInbox, purgeExpired, purgeOne,
  restore, restoreDiscardedInbox, setDayBoundaryHour, setSetting,
  getDayBoundaryHour, getSetting, TRASH_RETENTION_DAYS,
} from '../repo/index.ts';
import { NotFoundError, ValidationError } from '../domain/errors.ts';
import { parseDueInput } from '../day/parseDate.ts';
import { todayKey } from '../day/dayKey.ts';
import type { EntityType } from '../domain/types.ts';
import type { DiscardedEntry, TrashEntry } from '../repo/trashRepo.ts';

/** 备份保留策略：最近 7 个日快照 + 4 个周快照 */
export const BACKUP_KEEP_DAILY = 7;
export const BACKUP_KEEP_WEEKLY = 4;

export interface BackupFile {
  path: string;
  fileName: string;
  byteSize: number;
  createdAt: string;
  kind: 'daily' | 'weekly' | 'manual';
}

export interface IntegrityReport {
  ok: boolean;
  sqliteIntegrity: string;
  foreignKeyOrphans: number;
  /** 业务自检发现的问题，每条都是可读的一句话 */
  issues: string[];
}

export interface SystemService {
  settings: {
    dayBoundaryHour(): number;
    setDayBoundaryHour(hour: number): void;
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    list(): { key: string; value: unknown; updatedAt: string }[];
  };
  /**
   * 把设置的**当前值**取出来（纯数据）。
   *
   * 存在的理由：接口层（HTTP，将来是 IPC）只能传值、不能传函数，
   * 所以不能让界面去拿 settings 对象再调它的方法——那样序列化后只剩空对象
   * （实测：`getSettings()` 返回 `{}`，界面报 "settings.list is not a function"）。
   * 因此这里直接返回数据快照。
   */
  getSettings(): { dayBoundaryHour: number; entries: { key: string; value: unknown; updatedAt: string }[] };
  /**
   * 解析手工输入的截止日期（F-07 的兜底入口）。
   *
   * 放在 system 而不是 planning：它是**纯函数式的日期解析**，与"日界"同属日历能力，
   * 不涉及任何任务数据。界面拿它在提交前做校验与确认，避免"存进去才发现解析错了"。
   *
   * @returns 成功返回日键，看不懂返回 null（界面据此提示，绝不静默存错日期）
   */
  parseDueInput(raw: string): string | null;

  /**
   * 回收站页需要的**扁平**查询（F-21b，供 HTTP 层）。
   *
   * 为什么单独做扁平方法，而不是让界面去调 `trash` / `trash.discarded`：
   * 接口层按 `/api/<服务>/<方法>` 调用**顶层方法名**，因此嵌套对象根本调不到。
   * 而把 `trash` 整个拍平会连带改掉 CLI 的 7 处调用 —— 不划算。
   * 因此只给界面需要的部分开扁平入口，`trash` 对象保留给 CLI。
   *
   * 返回值把两个筛选的列表与计数一次给全，省掉界面四次往返。
   */
  trashOverview(): {
    /** 已删除：误录纠正，30 天后自动清理 */
    deleted: TrashEntry[];
    /** 已丢弃：主动判断，不过期 */
    discarded: DiscardedEntry[];
    counts: { deleted: number; discarded: number };
    retentionDays: number;
  };

  /** 已丢弃的条目放回待处理（"捞回来"） */
  restoreDiscarded(id: string): void;
  /** 彻底删除一条已丢弃条目（物理删除，不可恢复） */
  purgeDiscarded(id: string): void;
  /** 恢复一条已删除的实体（回收站"已删除"筛选） */
  restoreTrash(entityType: EntityType, entityId: string): void;
  /** 彻底删除一条已删除的实体（物理删除，不可恢复） */
  purgeTrash(entityType: EntityType, entityId: string): void;
  backup(reason: 'startup' | 'manual' | 'daily' | 'weekly'): Promise<BackupFile>;
  listBackups(): BackupFile[];
  /** 按"7 个日快照 + 4 个周快照"轮换，返回删除的文件名 */
  rotateBackups(): string[];
  integrityCheck(): IntegrityReport;
  trash: {
    /** 已删除：误录纠正，30 天后自动清理 */
    list(): TrashEntry[];
    count(): number;
    restore(entityType: EntityType, entityId: string): void;
    purgeOne(entityType: EntityType, entityId: string): void;
    purgeExpired(): Record<string, number>;
    retentionDays: number;
    /**
     * 已丢弃：主动判断，**不过期**（需求 F-21b / 硬规则 D2）。
     * 与"已删除"是两条独立路径，见 trashRepo 里的说明。
     */
    discarded: {
      list(): DiscardedEntry[];
      count(): number;
      /** 放回待处理（"捞回来"） */
      restore(id: string): void;
      /** 彻底删除（物理删除，不可恢复） */
      purge(id: string): void;
    };
  };
}

/**
 * 备份文件名：wh-YYYYMMDD-HHmmss-<kind>.db
 * 同一秒内多次备份时追加序号（wh-...-daily-1.db），否则后一次会静默覆盖前一次。
 */
export function backupFileName(at: Date, kind: BackupFile['kind'], sequence = 0): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const suffix = sequence === 0 ? '' : `-${sequence}`;
  return `wh-${stamp}-${kind}${suffix}.db`;
}

function parseBackupName(fileName: string): BackupFile | null {
  const matched = /^wh-(\d{8})-(\d{6})-(daily|weekly|manual)(?:-(\d+))?\.db$/.exec(fileName);
  if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) return null;
  const [, datePart, timePart, kind] = matched;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  return {
    path: '',
    fileName,
    byteSize: 0,
    createdAt: new Date(year, month - 1, day, hour, minute, second).toISOString(),
    kind: kind as BackupFile['kind'],
  };
}

export function createSystemService(database: DatabaseSync, backupDir: string): SystemService {
  function readBackups(): BackupFile[] {
    let names: string[];
    try {
      names = readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }

    const files: BackupFile[] = [];
    for (const name of names) {
      const parsed = parseBackupName(name);
      if (parsed === null) continue;
      const full = join(backupDir, name);
      let byteSize = 0;
      try {
        byteSize = statSync(full).size;
      } catch {
        continue;
      }
      files.push({ ...parsed, path: full, byteSize });
    }
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return files;
  }

  const settings = {
    dayBoundaryHour: (): number => getDayBoundaryHour(database),
    setDayBoundaryHour: (hour: number): void => setDayBoundaryHour(database, hour),
    get: <T>(key: string, fallback: T): T => getSetting(database, key, fallback),
    set: (key: string, value: unknown): void => setSetting(database, key, value),
    list: () => listSettings(database),
  };

  return {
    settings,
    getSettings: () => ({
      dayBoundaryHour: settings.dayBoundaryHour(),
      entries: settings.list(),
    }),

    parseDueInput: (raw) => parseDueInput(raw, {
      today: todayKey(settings.dayBoundaryHour(), new Date()),
    }),

    trashOverview: () => ({
      deleted: listTrash(database),
      discarded: listDiscardedInbox(database),
      counts: {
        deleted: countTrash(database),
        discarded: countDiscardedInbox(database),
      },
      retentionDays: TRASH_RETENTION_DAYS,
    }),

    restoreDiscarded(id) {
      withTx(database, () => {
        if (!restoreDiscardedInbox(database, id)) {
          throw new NotFoundError(`这条已丢弃的记录不存在或已被放回：${id}`);
        }
      });
    },

    purgeDiscarded(id) {
      withTx(database, () => {
        if (!purgeDiscardedInbox(database, id)) {
          throw new NotFoundError(`这条已丢弃的记录不存在或已被放回：${id}`);
        }
      });
    },

    // 与 trash.restore / trash.purgeOne 是同一实现，只是暴露成扁平方法供 HTTP 调用。
    // 不做成"两套逻辑"——只是两个门牌。
    restoreTrash: (entityType, entityId) => withTx(database, () => restore(database, entityType, entityId)),
    purgeTrash: (entityType, entityId) => withTx(database, () => purgeOne(database, entityType, entityId)),

    async backup(reason) {
      mkdirSync(backupDir, { recursive: true });
      const at = new Date();

      // 同一秒内可能连续备份多次，此时追加序号，避免静默覆盖前一个快照
      let sequence = 0;
      let fileName = backupFileName(at, reason, sequence);
      while (existsSync(join(backupDir, fileName))) {
        sequence += 1;
        fileName = backupFileName(at, reason, sequence);
      }
      const target = join(backupDir, fileName);

      // node:sqlite 的在线备份：库处于打开且有写入的状态下也能得到一致快照
      await backup(database, target);
      const byteSize = statSync(target).size;
      return { path: target, fileName, byteSize, createdAt: at.toISOString(), kind: reason };
    },

    listBackups() {
      return readBackups();
    },

    /**
     * 轮换：日快照保留最近 7 个，周快照保留最近 4 个，手动快照永不自动清理。
     * 只做"删除多余文件"，不做"日快照升级为周快照"——升级需要挂在备份流程里，
     * 放到这里会让轮换函数带上写入语义，职责不清。
     */
    rotateBackups() {
      const files = readBackups();
      const removed: string[] = [];

      const trim = (list: BackupFile[], keep: number): void => {
        for (const file of list.slice(keep)) {
          try {
            rmSync(file.path, { force: true });
            removed.push(file.fileName);
          } catch {
            // 单个文件删不掉不应中断整个轮换
          }
        }
      };

      // readBackups 已按时间倒序，slice(keep) 即最旧的那些
      trim(files.filter((file) => file.kind === 'daily'), BACKUP_KEEP_DAILY);
      trim(files.filter((file) => file.kind === 'weekly'), BACKUP_KEEP_WEEKLY);
      return removed;
    },

    integrityCheck() {
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      const orphans = database.prepare('PRAGMA foreign_key_check').all() as unknown[];
      const issues: string[] = [];

      const blockedWithoutReason = findBlockedWithoutReason(database);
      if (blockedWithoutReason.length > 0) {
        issues.push(`${blockedWithoutReason.length} 个任务处于阻塞但没有填写原因`);
      }

      const doneWithoutTimestamp = findDoneWithoutTimestamp(database);
      if (doneWithoutTimestamp.length > 0) {
        issues.push(`${doneWithoutTimestamp.length} 个任务已完成但没有完成时间`);
      }

      const strayProgress = database
        .prepare(
          `SELECT COUNT(*) AS c FROM progress_entries
           WHERE deleted_at IS NULL
             AND (project_id IS NOT NULL) + (task_id IS NOT NULL) + (subtask_id IS NOT NULL) <> 1`,
        )
        .get() as { c: number } | undefined;
      if (Number(strayProgress?.c ?? 0) > 0) {
        issues.push(`${Number(strayProgress?.c ?? 0)} 条进展记录没有恰好挂在一个父对象上`);
      }

      const withDueDateNoKey = database
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks
           WHERE deleted_at IS NULL AND due_at IS NOT NULL AND due_date IS NULL`,
        )
        .get() as { c: number } | undefined;
      if (Number(withDueDateNoKey?.c ?? 0) > 0) {
        issues.push(`${Number(withDueDateNoKey?.c ?? 0)} 个任务有精确截止时间但缺少日期投影`);
      }

      const sqliteIntegrity = integrity?.integrity_check ?? '无结果';
      return {
        ok: sqliteIntegrity === 'ok' && orphans.length === 0 && issues.length === 0,
        sqliteIntegrity,
        foreignKeyOrphans: orphans.length,
        issues,
      };
    },

    trash: {
      list: () => listTrash(database),
      count: () => countTrash(database),
      restore: (entityType, entityId) => withTx(database, () => restore(database, entityType, entityId)),
      purgeOne: (entityType, entityId) => withTx(database, () => purgeOne(database, entityType, entityId)),
      purgeExpired: () => withTx(database, () => purgeExpired(database)),
      retentionDays: TRASH_RETENTION_DAYS,

      // 已丢弃：与上面「已删除」并列的第二个筛选（需求 F-21b）。
      // 它不参与 purgeExpired —— 丢弃不过期（硬规则 D2）。
      discarded: {
        list: () => listDiscardedInbox(database),
        count: () => countDiscardedInbox(database),
        restore: (id) => withTx(database, () => {
          if (!restoreDiscardedInbox(database, id)) {
            throw new NotFoundError(`这条已丢弃的记录不存在或已被放回：${id}`);
          }
        }),
        purge: (id) => withTx(database, () => {
          if (!purgeDiscardedInbox(database, id)) {
            throw new NotFoundError(`这条已丢弃的记录不存在或已被放回：${id}`);
          }
        }),
      },
    },
  };
}

/** 备份轮换策略的说明文案，供 CLI 展示 */
export function backupPolicyText(): string {
  return `日快照保留 ${BACKUP_KEEP_DAILY} 个，周快照保留 ${BACKUP_KEEP_WEEKLY} 个，手动快照不自动清理`;
}

export function assertBackupDirWritable(backupDir: string): void {
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (error) {
    throw new ValidationError(`备份目录不可写：${backupDir}（${String(error)}）`);
  }
}
