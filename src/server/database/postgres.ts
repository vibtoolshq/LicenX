import type { Pool, PoolClient, QueryResult } from "pg";
import type { DatabaseClient, DatabaseResult, DatabaseTransaction, InArgs, InStatement, TransactionMode } from "./contracts.js";
import { postgresStatement } from "./sqlDialect.js";

function safeDatabaseError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return Object.assign(new Error("PostgreSQL database operation failed"), {
    code: /^[A-Z0-9_]{2,40}$/.test(code) ? code : "DATABASE_ERROR",
  });
}

async function execute(connection: Pool | PoolClient, statement: InStatement, args?: InArgs): Promise<DatabaseResult> {
  const query = postgresStatement(statement, args);
  let result: QueryResult;
  try {
    result = await connection.query(query.text, query.values);
  } catch (error) {
    throw safeDatabaseError(error);
  }
  const rows = result.rows.map((row) => {
    for (const field of result.fields) {
      if (field.dataTypeID !== 20 || row[field.name] === null) continue;
      const value = Number(row[field.name]);
      if (!Number.isSafeInteger(value)) throw new RangeError("Database integer exceeds safe JavaScript range");
      row[field.name] = value;
    }
    return row;
  });
  return { rows, rowsAffected: result.rowCount ?? 0 };
}

class PostgresTransaction implements DatabaseTransaction {
  private finished = false;
  constructor(private connection: PoolClient) {}

  execute(statement: InStatement, args?: InArgs) {
    if (this.finished) return Promise.reject(new Error("Database transaction is closed"));
    return execute(this.connection, statement, args);
  }

  async lockLicense(licenseId: string) {
    await this.execute({ sql: "SELECT id FROM licenses WHERE id = ? FOR UPDATE", args: [licenseId] });
  }

  private async finish(command: "COMMIT" | "ROLLBACK") {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.connection.query(command);
      this.connection.release();
    } catch (error) {
      this.connection.release(true);
      throw safeDatabaseError(error);
    }
  }

  commit() { return this.finish("COMMIT"); }
  rollback() { return this.finish("ROLLBACK"); }
  close() {
    if (!this.finished) {
      this.finished = true;
      // Destroy an abandoned connection rather than return an open transaction to the pool.
      this.connection.release(true);
    }
  }
}

/** pg is loaded only when a Node PostgreSQL connection is actually requested. */
export class PostgresClient implements DatabaseClient {
  closed = false;
  private poolPromise?: Promise<Pool>;
  constructor(private url: string) {}

  private getPool(): Promise<Pool> {
    if (this.closed) return Promise.reject(new Error("Database client is closed"));
    return this.poolPromise ??= import("pg").then(({ Pool }) => {
      const connectionUrl = new URL(this.url);
      const sslmode = connectionUrl.searchParams.get("sslmode");
      connectionUrl.searchParams.delete("sslmode");
      const pool = new Pool({
        connectionString: connectionUrl.toString(),
        ssl: sslmode && sslmode !== "disable" ? { rejectUnauthorized: true } : undefined,
        max: 10,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      });
      pool.on("error", () => console.error("[LicenX] PostgreSQL idle connection failed"));
      return pool;
    });
  }

  async execute(statement: InStatement, args?: InArgs) {
    return execute(await this.getPool(), statement, args);
  }

  async transaction(mode: TransactionMode = "write"): Promise<DatabaseTransaction> {
    let connection: PoolClient | undefined;
    try {
      connection = await (await this.getPool()).connect();
      await connection.query(mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
      return new PostgresTransaction(connection);
    } catch (error) {
      connection?.release(true);
      throw safeDatabaseError(error);
    }
  }

  async batch(statements: InStatement[], mode?: TransactionMode) {
    const transaction = await this.transaction(mode);
    try {
      const results: DatabaseResult[] = [];
      for (const statement of statements) results.push(await transaction.execute(statement));
      await transaction.commit();
      return results;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  async close() {
    this.closed = true;
    if (this.poolPromise) await (await this.poolPromise).end();
  }
}
