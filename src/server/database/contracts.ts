import type { InArgs, InStatement, TransactionMode, Value } from "@libsql/client";

export type { InArgs, InStatement, TransactionMode };

export interface DatabaseResult {
  rows: Record<string, Value>[];
  rowsAffected: number;
}

export interface DatabaseExecutor {
  execute(statement: InStatement): Promise<DatabaseResult>;
  execute(sql: string, args?: InArgs): Promise<DatabaseResult>;
}

export interface DatabaseTransaction extends DatabaseExecutor {
  /** SQLite write transactions already serialize writes; PostgreSQL locks a license row. */
  lockLicense?(licenseId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

export interface DatabaseClient extends DatabaseExecutor {
  readonly closed: boolean;
  batch(statements: InStatement[], mode?: TransactionMode): Promise<DatabaseResult[]>;
  transaction(mode?: TransactionMode): Promise<DatabaseTransaction>;
  close(): void | Promise<void>;
}
