// 附件仓储：文件本体存 data/attachments/，此处只存元信息与相对路径。

import type { DatabaseSync } from 'node:sqlite';
import { insert, queryAll, queryOne } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { requireById, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'attachments';

export interface Attachment {
  id: string;
  archiveId: string | null;
  fileName: string;
  relPath: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  deletedAt: string | null;
}

interface AttachmentRow {
  id: string;
  archive_id: string | null;
  file_name: string;
  rel_path: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  deleted_at: string | null;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    archiveId: row.archive_id,
    fileName: row.file_name,
    relPath: row.rel_path,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

export interface AttachmentCreate {
  archiveId?: string | null;
  fileName: string;
  relPath: string;
  byteSize: number;
  sha256: string;
}

export function createAttachment(database: DatabaseSync, input: AttachmentCreate): Attachment {
  const id = newId();
  insert(database, TABLE, {
    id,
    archive_id: input.archiveId ?? null,
    file_name: input.fileName,
    rel_path: input.relPath,
    byte_size: input.byteSize,
    sha256: input.sha256,
    created_at: nowIso(),
  });
  return requireById(getAttachment(database, id), '附件', id);
}

export function getAttachment(database: DatabaseSync, id: string): Attachment | undefined {
  const row = queryOne<AttachmentRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toAttachment(row);
}

export function listAttachments(database: DatabaseSync, archiveId: string): Attachment[] {
  const rows = queryAll<AttachmentRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE archive_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    archiveId,
  );
  return rows.map(toAttachment);
}

/** 按内容摘要查找，用于去重：相同文件的字节只落一份 */
export function findByDigest(database: DatabaseSync, sha256: string): Attachment | undefined {
  const row = queryOne<AttachmentRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE sha256 = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    sha256,
  );
  return row === undefined ? undefined : toAttachment(row);
}

export function deleteAttachment(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '附件', id);
}
