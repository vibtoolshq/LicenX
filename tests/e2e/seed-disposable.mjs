/** Disposable CI-only PostgreSQL fixtures; never use with an external/customer DB. */
import { Client } from "pg";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.LICENX_ADMIN_E2E_CI !== "1" ||
    !/^postgres(?:ql)?:\/\/[^/]+@postgres:5432\/licenx_ci(?:\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to seed outside isolated GitHub Actions PostgreSQL");
}

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query("BEGIN");
  const now = Date.now();
  for (const [id, slug, name] of [
    ["ci_e2e_app_a", "ci-e2e-alpha", "CI E2E Alpha"],
    ["ci_e2e_app_b", "ci-e2e-beta", "CI E2E Beta"],
  ]) {
    await db.query(
      "INSERT INTO apps (id,app_slug,display_name,app_secret,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, slug, name, "ci-only-no-real-key", now, now],
    );
  }
  for (const [id, app, name] of [
    ["ci_e2e_license_a", "ci_e2e_app_a", "CI-E2E-LICENSE-A"],
    ["ci_e2e_license_b", "ci_e2e_app_b", "CI-E2E-LICENSE-B"],
  ]) {
    await db.query(
      "INSERT INTO licenses (id,key,app_id,device_limit,created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, name, app, 200, now],
    );
  }
  const total = 150;
  for (let i = 0; i < total; i++) {
    const index = String(i).padStart(3, "0");
    const license = i === total - 1 ? "ci_e2e_license_b" : "ci_e2e_license_a";
    await db.query(
      "INSERT INTO devices (id,license_id,hwid,device_name,first_bound_at,last_ping_at,status) VALUES ($1,$2,$3,$4,$5,$6,'active')",
      ["ci_e2e_device_" + index, license, "ci-e2e-hwid-" + index,
        "CI Browser Fixture " + index, now - 180000, now + i * 1000],
    );
  }
  // Phase-02: bounded >100 record fixtures; dates precede CI live mutations.
  for (let i = 0; i < 150; i++) {
    const index = String(i).padStart(3, "0");
    const createdAt = now - (151 - i) * 1000;
    await db.query(
      "INSERT INTO apps (id,app_slug,display_name,app_secret,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["ci_e2e_app_" + index, "ci-browser-app-" + index,
        "CI Browser App " + index, "ci-only-no-real-key",
        i % 5 === 0 ? "inactive" : "active", createdAt, createdAt],
    );
    await db.query(
      "INSERT INTO licenses (id,key,app_id,status,tier,device_limit,created_at) VALUES ($1,$2,$3,$4,$5,1,$6)",
      ["ci_e2e_license_" + index, "CI-BROWSER-LICENSE-" + index,
        "ci_e2e_app_" + index, i % 7 === 0 ? "suspended" : "active",
        i % 4 === 0 ? "Pro" : "Standard", createdAt],
    );
  }
  for (let i = 0; i < 180; i++) {
    const index = String(i).padStart(3, "0");
    await db.query(
      "INSERT INTO validation_logs (id,license_key,app_slug,hwid,ip_address,action,status_code,message,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      ["ci_e2e_log_" + index, "CI-ONLY-LICENSE-" + index,
        "ci-e2e-alpha", "ci-only-hwid-" + index, "127.0.0.1",
        i % 2 === 0 ? "validate" : "reject", i % 2 === 0 ? 200 : 403,
        "CI Synthetic Audit Log " + index, now - (181 - i) * 1000],
    );
  }
  await db.query("COMMIT");
  console.log(JSON.stringify({ fixture: "ci-only", apps: 152, licenses: 152, devices: total, logs: 180 }));
} catch (error) {
  await db.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await db.end();
}
