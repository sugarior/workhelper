// 服务层统一出口。界面层只通过这里访问业务能力，
// 不直接接触 repo/ 或 db/（docs/design.md §2.2 分层纪律）。

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getDayBoundaryHour } from '../repo/settingsRepo.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { createCaptureService } from './captureService.ts';
import { createPlanningService } from './planningService.ts';
import { createTrackingService } from './trackingService.ts';
import { createJournalService } from './journalService.ts';
import { createSearchService } from './searchService.ts';
import { createSystemService } from './systemService.ts';
import type { CaptureService } from './captureService.ts';
import type { PlanningService } from './planningService.ts';
import type { TrackingService } from './trackingService.ts';
import type { JournalService } from './journalService.ts';
import type { SearchService } from './searchService.ts';
import type { SystemService } from './systemService.ts';

export interface WorkHelperServices {
  capture: CaptureService;
  planning: PlanningService;
  tracking: TrackingService;
  journal: JournalService;
  search: SearchService;
  system: SystemService;
  /** 当前日键（按已配置的日界计算），各调用方共用同一口径 */
  currentDayKey(): string;
}

export interface CreateServicesOptions {
  /** 数据目录；备份放在 <dataDir>/backups */
  dataDir: string;
}

export function createServices(database: DatabaseSync, options: CreateServicesOptions): WorkHelperServices {
  const backupDir = join(options.dataDir, 'backups');

  return {
    capture: createCaptureService(database),
    planning: createPlanningService(database),
    tracking: createTrackingService(database),
    journal: createJournalService(database),
    search: createSearchService(database),
    system: createSystemService(database, backupDir),
    currentDayKey() {
      return dayKeyFromIso(nowIso(), getDayBoundaryHour(database));
    },
  };
}

export type { CaptureService, ClassifyTarget, ClassifyResult } from './captureService.ts';
export type { PlanningService, ProjectTree, TaskNode, ReorderKind } from './planningService.ts';
export type { TrackingService, TodayView } from './trackingService.ts';
export type { JournalService, JournalSummary, CompletedSubtask } from './journalService.ts';
export type { SearchService, ResolvedHit } from './searchService.ts';
export type { SystemService, BackupFile, IntegrityReport } from './systemService.ts';
