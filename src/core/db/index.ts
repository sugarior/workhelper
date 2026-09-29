// db 层对外出口。上层模块从这里取数据库能力，不直接 import 具体实现文件。

export {
  openDatabase, closeDatabase, queryOne, queryAll, execute,
  SCHEMA_VERSION, DEFAULT_DB_FILENAME,
} from './connection.ts';

export { migrate, currentVersion, listMigrations, assertSchemaVersionInSync } from './migrations.ts';
export type { MigrationFile, MigrationResult } from './migrations.ts';

export { withTx, inTransaction } from './tx.ts';

export { toTokens, isFtsQueryUsable, buildFtsMatch } from './tokens.ts';
