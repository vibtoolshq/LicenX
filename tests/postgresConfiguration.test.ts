import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseConfigurationError, resolveDatabaseConfig } from "../src/server/db.js";
import { postgresStatement } from "../src/server/database/sqlDialect.js";

test("PostgreSQL is explicit or inferred from its URL only in Node", () => {
  const url = "postgresql://test:fixture@127.0.0.1/licenx";
  assert.equal(resolveDatabaseConfig(undefined, "production", { DATABASE_URL: url }).provider, "postgres");
  assert.equal(resolveDatabaseConfig(undefined, "production", { DATABASE_PROVIDER: "postgres", DATABASE_URL: url, TURSO_DATABASE_URL: "libsql://old.turso.io" }).url, url);
  for (const env of [
    { DATABASE_PROVIDER: "unknown" },
    { DATABASE_PROVIDER: "postgres" },
    { DATABASE_PROVIDER: "postgres", DATABASE_URL: "file:local.db" },
    { DATABASE_PROVIDER: "libsql", DATABASE_URL: url },
    { DATABASE_URL: `${url}?sslmode=no-verify` },
    { DATABASE_URL: `${url}?sslmode=require&uselibpqcompat=true` },
  ]) assert.throws(() => resolveDatabaseConfig(undefined, "production", env), DatabaseConfigurationError);
  assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: url }), DatabaseConfigurationError);
  assert.equal(resolveDatabaseConfig(undefined, "production", { DATABASE_URL: `${url}?sslmode=require` }).provider, "postgres");
});

test("dialect preserves literals/comments and safely numbers positional values", () => {
  const query = postgresStatement({
    sql: "SELECT '?' AS quoted, $$? LIKE$$ AS literal, ? + ? AS n -- ? LIKE\n WHERE name LIKE ? /* ? LIKE */",
    args: [1, 2, "%test%"],
  });
  assert.equal(query.text, "SELECT '?' AS quoted, $$? LIKE$$ AS literal, $1::bigint + $2::bigint AS n -- ? LIKE\n WHERE name ILIKE $3 /* ? LIKE */");
  assert.deepEqual(query.values, [1, 2, "%test%"]);
  assert.throws(() => postgresStatement({ sql: "SELECT ?", args: [] }));
});
