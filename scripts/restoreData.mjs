/**
 * Explicit local-only recovery importer; input must be supplied privately.
 * No customer secrets or embedded license/app values are present in source.
 *
 * Usage (only against an operator-approved disposable/local SQLite database):
 *   node scripts/restoreData.mjs --input /private/recovery.json \
 *     --database /private/target.db --confirm-local-import
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";

const APP_COLUMNS = [
  "id", "app_slug", "display_name", "min_version", "status", "app_secret",
  "description", "created_at", "updated_at", "device_lease_seconds",
  "ping_interval_seconds", "offline_grace_seconds",
];
const LICENSE_COLUMNS = [
  "id", "key", "status", "tier", "app_id", "device_limit", "validity_type",
  "validity_value", "activated_at", "expires_at", "created_at", "customer_name",
  "customer_email", "notes", "metadata_json", "r2_backup_id", "pin",
];

function records(data, field) {
  if (!Array.isArray(data[field]) || data[field].length > 100_000) {
    throw new Error("Invalid recovery input list");
  }
  for (const row of data[field]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Invalid recovery input row");
    }
  }
  return data[field];
}

export async function restoreAll({ input, database, confirmed } = {}) {
  if (!confirmed || typeof input !== "string" || typeof database !== "string") {
    throw new Error("Explicit --input, --database and --confirm-local-import are required");
  }
  const source = path.resolve(input);
  const target = path.resolve(database);
  if (source === target || !statSync(source).isFile() || !statSync(target).isFile()) {
    throw new Error("A private input file and an existing separate local target database are required");
  }
  const data = JSON.parse(readFileSync(source, "utf8"));
  const apps = records(data, "apps");
  const licenses = records(data, "licenses");
  if (!apps.length && !licenses.length) {
    throw new Error("Empty recovery input refused");
  }
  const db = createClient({ url: "file:" + target.replaceAll("\\", "/") });
  try {
    const statements = [];
    for (const [name, columns, values] of [
      ["apps", APP_COLUMNS, apps],
      ["licenses", LICENSE_COLUMNS, licenses],
    ]) {
      for (const row of values) {
        if (typeof row.id !== "string" || !row.id) throw new Error("Missing recovery record ID");
        statements.push({
          sql: `INSERT OR REPLACE INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          args: columns.map(column => row[column] ?? null),
        });
      }
    }
    // One transaction avoids silently importing only some of the input.
    await db.batch(statements, "write");
    console.log("Local recovery import completed");
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const value = flag => {
    const pos = argv.indexOf(flag);
    return pos >= 0 ? argv[pos + 1] : undefined;
  };
  restoreAll({
    input: value("--input"),
    database: value("--database"),
    confirmed: argv.includes("--confirm-local-import"),
  }).catch(() => {
    console.error("Local recovery import failed; inspect private input and database");
    process.exitCode = 1;
  });
}
