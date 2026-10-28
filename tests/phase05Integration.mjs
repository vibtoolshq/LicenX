// Disposable GitHub Actions integration only. Uses random synthetic keys and local PostgreSQL.
import crypto from "node:crypto";
import pg from "pg";

const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
const base = "http://127.0.0.1:3000";
const appA = "ci-license-app-a";
const appB = "ci-license-app-b";
const keyA = "CI-LICENSE-A";
const keyB = "CI-LICENSE-B";
const hwid = "CI-HWID-01";
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const request = async (endpoint, body, options = {}) => {
  const reply = await fetch(base + endpoint, {
    method: options.method || "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: reply.status, data: await reply.json() };
};

try {
  await sql.connect();
  const now = Date.now();
  for (const id of [appA, appB]) {
    await sql.query(
      "INSERT INTO apps (id, app_slug, display_name, app_secret, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
      [id, id, id === appA ? "বাংলা লাইসেন্স সফটওয়্যার 😀" : id, "sec_synthetic_ci_only", now],
    );
  }
  for (const [id, key, appId] of [["ci_lic_a", keyA, appA], ["ci_lic_b", keyB, appB]]) {
    await sql.query(
      "INSERT INTO licenses (id, key, status, app_id, device_limit, validity_type, validity_value, created_at, pin) VALUES ($1, $2, 'active', $3, 1, 'lifetime', 0, $4, 'CI-PIN')",
      [id, key, appId, now],
    );
  }
  const secret = "vcon_sec_" + crypto.randomBytes(24).toString("hex");
  await sql.query(
    "INSERT INTO admin_api_keys (id, name, key_prefix, secret_hash, permissions_json, app_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)",
    ["apk_ci", "CI only", "vcon_ci", crypto.createHash("sha256").update(secret).digest("hex"),
      JSON.stringify(["licenses:read", "licenses:manage"]), appA, now],
  );
  const headers = { authorization: "Bearer " + secret };
  const allowed = await request("/api/v1/admin/licenses/" + keyA, undefined, { method: "GET", headers });
  assert(allowed.status === 200, "Same-app admin read failed");
  const deniedRead = await request("/api/v1/admin/licenses/" + keyB, undefined, { method: "GET", headers });
  assert(deniedRead.status === 403, "Cross-app admin read was not denied");
  const deniedReset = await request("/api/v1/admin/licenses/" + keyB + "/reset", {}, { headers });
  assert(deniedReset.status === 403, "Cross-app admin reset was not denied");
  const deniedStatus = await request("/api/v1/admin/licenses/" + keyB + "/status", { status: "revoked" }, { method: "PATCH", headers });
  assert(deniedStatus.status === 403, "Cross-app admin status was not denied");
  const untouched = await sql.query("SELECT status FROM licenses WHERE key = $1", [keyB]);
  assert(untouched.rows[0].status === "active", "Cross-app operation modified license B");
  console.log("PASS PostgreSQL admin API scope: same-app allowed, cross-app read/reset/status denied without mutations");

  const nonce = crypto.randomBytes(32).toString("base64url");
  const body = {
    license_key: keyA, hwid, device_name: "CI desktop", os_info: "Linux CI",
    app_name: appA, app_version: "1.0.0", nonce,
  };
  const validation = await request("/api/v1/license/validate", body);
  assert(validation.status === 200 && validation.data.valid === true, "Synthetic license validation failed: " + validation.status);
  const { signature, public_key: unusedResponseKey, ...signed } = validation.data;
  assert(signed.nonce === nonce && signed.request_app === appA, "Validation challenge or request app not signed");
  assert(signed.license_key === keyA && signed.hwid === hwid, "Validation identity not signed");
  const keyRow = await sql.query("SELECT ed25519_public_key FROM admin_config LIMIT 1");
  const trustedPublicKey = keyRow.rows[0].ed25519_public_key;
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(signed).sort().map(k => [k, signed[k]])));
  assert(crypto.verify("RSA-SHA256", Buffer.from(canonical, "utf8"), trustedPublicKey, Buffer.from(signature, "base64")), "Signed validation did not verify against configured key");
  await (await import("node:fs/promises")).writeFile("/tmp/licenx-phase05-vector.json", JSON.stringify({ public_key: trustedPublicKey, payload: signed, signature }), { mode: 0o600 });
  console.log("PASS signed validation identity, nonce, Unicode payload and trusted-key signature");

  const pingBody = { license_key: keyA, hwid, nonce: crypto.randomBytes(32).toString("base64url") };
  const ping = await request("/api/v1/license/ping", pingBody);
  assert(ping.status === 200 && ping.data.valid === true, "Active heartbeat failed");
  await sql.query("UPDATE apps SET status = 'inactive' WHERE id = $1", [appA]);
  const inactive = await request("/api/v1/license/ping", pingBody);
  assert(inactive.status === 403 && inactive.data.code === "APP_INACTIVE", "Inactive app renewed a heartbeat");
  await sql.query("UPDATE apps SET status = 'active' WHERE id = $1", [appA]);
  const resumed = await request("/api/v1/license/ping", pingBody);
  assert(resumed.status === 200, "Re-enabled app could not renew heartbeat");
  await sql.query("UPDATE devices SET status = 'blocked' WHERE license_id = 'ci_lic_a' AND hwid = $1", [hwid]);
  await request("/api/v1/license/logout", { license_key: keyA, hwid });
  const blocked = await sql.query("SELECT status FROM devices WHERE license_id = 'ci_lic_a' AND hwid = $1", [hwid]);
  assert(blocked.rows.length === 1 && blocked.rows[0].status === "blocked", "Client logout removed an admin block");
  console.log("PASS inactive-app heartbeat denial, re-enable, and blocked-device preservation");
} finally {
  await sql.end();
}
