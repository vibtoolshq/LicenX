import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  handleCloudflareApi,
  invalidateAdminConfigCache,
  redactValidationDiagnosticText,
} from "../src/server/cloudflareHandler.js";
import {
  canonicalJson,
  createSessionToken,
  generateEd25519KeyPair,
  generateRSAKeyPair,
  signPayloadForCloudflare,
  verifySignature,
} from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";

const licenseId = "license-cloudflare-signing-test";
const licenseKey = "VCON-CLOUDFLARE-SIGNING-TEST";
const hwid = "HWID-CLOUDFLARE-SIGNING-TEST";
let db: ReturnType<typeof getDbClient>;
let privateKeyPem: string;
let publicKeyPem: string;
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
};

before(async () => {
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = "file::memory:";
  db = getDbClient();
  await initDatabaseSchema();
});

beforeEach(async () => {
  const keyPair = generateRSAKeyPair();
  privateKeyPem = keyPair.privateKeyPem;
  publicKeyPem = keyPair.publicKeyPem;

  await db.execute("DELETE FROM devices");
  await db.execute("DELETE FROM validation_logs");
  await db.execute("DELETE FROM licenses");
  await db.execute("DELETE FROM apps");
  await db.execute("DELETE FROM admin_config");
  await db.execute({
    sql: `INSERT INTO apps
          (id, app_slug, display_name, min_version, status, app_secret, created_at, updated_at)
          VALUES ('app_vcon_default', 'vcon_default', 'VCON Default Suite', '1.0.0', 'active', 'sec_test_app', ?, ?)`,
    args: [Date.now(), Date.now()],
  });
  await db.execute({
    sql: `INSERT INTO admin_config
          (id, username, password_hash, jwt_secret, ed25519_private_key,
           ed25519_public_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "admin-test",
      "admin",
      "unused-test-hash",
      "unused-test-secret",
      privateKeyPem,
      publicKeyPem,
      Date.now(),
      Date.now(),
    ],
  });
  invalidateAdminConfigCache();
  await db.execute({
    sql: `INSERT INTO licenses
          (id, key, status, tier, app_id, device_limit, validity_type,
           validity_value, created_at)
          VALUES (?, ?, 'active', 'Standard', ?, 2, 'lifetime', 0, ?)`,
    args: [licenseId, licenseKey, "app_vcon_default", Date.now()],
  });
});

after(async () => {
  if (db) await db.close();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Cloudflare license validation returns a verifiable RSA signature", async () => {
  const response = await handleCloudflareApi(
    new Request("https://licenx.test/api/v1/license/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        hwid,
        app_name: "vcon_default",
        app_version: "1.0.0",
        device_name: "Signing Test",
        os_info: "test",
      }),
    }),
    undefined,
  );

  assert.equal(response.status, 200);
  const responseBody = (await response.json()) as Record<string, unknown>;
  const signature = responseBody.signature;
  const responsePublicKey = responseBody.public_key;
  if (typeof signature !== "string" || typeof responsePublicKey !== "string") {
    assert.fail(
      "Cloudflare validation response omitted its signature or public key",
    );
  }
  const signedData = { ...responseBody };
  delete signedData.signature;
  delete signedData.public_key;

  assert.equal(responsePublicKey, publicKeyPem);
  assert.equal(
    verifySignature(canonicalJson(signedData), signature, publicKeyPem),
    true,
  );
  assert.equal(
    verifySignature(
      canonicalJson({ ...signedData, tier: "tampered" }),
      signature,
      publicKeyPem,
    ),
    false,
  );

  const device = await db.execute({
    sql: "SELECT status FROM devices WHERE license_id = ? AND hwid = ?",
    args: [licenseId, hwid],
  });
  assert.equal(device.rows[0]?.status, "active");
});

test("Cloudflare WebCrypto signer supports existing Ed25519 PKCS#8 keys", async () => {
  const keyPair = generateEd25519KeyPair();
  const payload = canonicalJson({ valid: true, license_key: licenseKey });
  const signature = await signPayloadForCloudflare(
    payload,
    keyPair.privateKeyPem,
  );

  assert.equal(verifySignature(payload, signature, keyPair.publicKeyPem), true);
  assert.equal(
    verifySignature(
      canonicalJson({ valid: false, license_key: licenseKey }),
      signature,
      keyPair.publicKeyPem,
    ),
    false,
  );
});

test("Cloudflare validation correlates failures and limits details to admins", async () => {
  const requestId = "8cb66cb2-6691-49ab-b8d6-526b1b650c0a";
  const privateKeySentinel =
    "-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_KEY_SENTINEL\n-----END RSA PRIVATE KEY-----";
  await db.execute({
    sql: "UPDATE admin_config SET ed25519_private_key = ? WHERE id = ?",
    args: [privateKeySentinel, "admin-test"],
  });

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    loggedErrors.push(values.map(String).join(" "));
  };

  try {
    const publicResponse = await handleCloudflareApi(
      new Request("https://licenx.test/api/v1/license/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LicenX-Diagnostic-Request-ID": requestId,
        },
        body: JSON.stringify({
          license_key: licenseKey,
          hwid,
          app_version: "1.0.0",
          app_name: "vcon_default",
        }),
      }),
      undefined,
    );
    const publicBody = (await publicResponse.json()) as Record<string, unknown>;

    assert.equal(publicResponse.status, 500);
    assert.equal(publicBody.request_id, requestId);
    assert.equal("diagnostic" in publicBody, false);

    const sessionToken = createSessionToken(
      { username: "admin", exp: Math.floor(Date.now() / 1000) + 3600 },
      "unused-test-secret",
    );
    const adminResponse = await handleCloudflareApi(
      new Request("https://licenx.test/api/v1/license/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://licenx.test",
          Cookie: `vcon_admin_session=${sessionToken}; vcon_admin_csrf=csrf-test`,
          "X-CSRF-Token": "csrf-test",
          "X-LicenX-Diagnostic-Request-ID": requestId,
        },
        body: JSON.stringify({
          license_key: licenseKey,
          hwid,
          app_version: "1.0.0",
          app_name: "vcon_default",
        }),
      }),
      undefined,
    );
    const adminBody = (await adminResponse.json()) as {
      diagnostic?: Record<string, unknown>;
      request_id?: string;
    };

    assert.equal(adminResponse.status, 500);
    assert.equal(adminBody.request_id, requestId);
    assert.equal(adminBody.diagnostic?.request_id, requestId);
    assert.equal(adminBody.diagnostic?.stage, "response_signing");
    assert.equal(adminBody.diagnostic?.error_message, "Invalid character");

    const logOutput = loggedErrors.join("\n");
    assert.match(logOutput, /response_signing/);
    assert.match(logOutput, new RegExp(requestId));
    assert.doesNotMatch(logOutput, new RegExp(licenseKey));
    assert.doesNotMatch(logOutput, new RegExp(hwid));
    assert.doesNotMatch(logOutput, /PRIVATE_KEY_SENTINEL/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("validation diagnostics redact credentials and request identifiers", () => {
  const values = {
    databaseUrl: "libsql://db-user:db-password@db.example.test",
    authToken: "TURSO_AUTH_TOKEN_SENTINEL",
    csrfToken: "CSRF_TOKEN_SENTINEL",
    licenseKey: "VCON-LICENSE-KEY-SENTINEL",
    hwid: "HWID-DEVICE-SENTINEL",
    privateKey:
      "-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_KEY_SENTINEL\n-----END RSA PRIVATE KEY-----",
  };
  const request = new Request("https://licenx.test/api/v1/license/validate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${values.authToken}`,
      Cookie: `vcon_admin_session=${values.authToken}`,
      "X-CSRF-Token": values.csrfToken,
    },
  });
  const env = {
    TURSO_DATABASE_URL: values.databaseUrl,
    TURSO_AUTH_TOKEN: values.authToken,
  };
  const body = { license_key: values.licenseKey, hwid: values.hwid };
  const diagnosticText = redactValidationDiagnosticText(
    Object.values(values).join("\n"),
    request,
    env,
    body,
  );

  for (const value of Object.values(values)) {
    assert.equal(diagnosticText.includes(value), false);
  }
  assert.match(diagnosticText, /\[REDACTED\]/);
  assert.match(diagnosticText, /\[REDACTED PEM\]/);

  const unconfiguredDatabaseUrl = redactValidationDiagnosticText(
    "Database failure: postgres://user:password@database.example/private?token=secret",
    new Request("https://licenx.test/"),
    undefined,
    {},
  );
  assert.doesNotMatch(unconfiguredDatabaseUrl, /postgres:\/\//);
  assert.match(unconfiguredDatabaseUrl, /\[REDACTED DATABASE URL\]/);
});

test("F08 Cloudflare v2 proof is signed, one-use, and invalid after same-device rebind", async () => {
  const validate = async () => {
    const response = await handleCloudflareApi(
      new Request("https://licenx.test/api/v1/license/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: licenseKey, hwid, app_name: "vcon_default",
          app_version: "1.0.0", nonce: "CF_PROOF_VALIDATION_1234567890",
          logout_proof_version: 2, device_name: "Proof Test", os_info: "test",
        }),
      }), undefined,
    );
    assert.equal(response.status, 200);
    const data = await response.json() as Record<string, any>;
    const { signature, public_key, ...signed } = data;
    assert.equal(verifySignature(canonicalJson(signed), signature, publicKeyPem), true);
    assert.equal(typeof data.device_logout_proof, "string");
    return data.device_logout_proof as string;
  };
  const logout = async (token: string) => {
    const response = await handleCloudflareApi(
      new Request("https://licenx.test/api/v2/license/logout", {
        method: "POST", headers: { Authorization: "Bearer " + token },
        body: "{}",
      }), undefined,
    );
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const first = await validate();
  const forgedParts = first.split(".");
  forgedParts[2] = (forgedParts[2][0] === "A" ? "B" : "A") + forgedParts[2].slice(1);
  const forged = forgedParts.join(".");
  assert.equal((await logout(forged)).status, 403);
  assert.equal((await logout(first)).status, 200);
  assert.equal((await logout(first)).status, 403, "replay must fail on another request");
  const afterFirst = await db.execute({
    sql: "SELECT status FROM devices WHERE license_id = ? AND hwid = ?", args: [licenseId, hwid],
  });
  assert.equal(afterFirst.rows[0]?.status, "logged_out");

  const replacement = await validate();
  assert.notEqual(first, replacement);
  assert.equal((await logout(first)).status, 403, "old token cannot unbind replacement");
  const concurrent = await Promise.all([logout(replacement), logout(replacement)]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 403],
    "exactly one parallel logout may consume a durable generation");
});

test("F08 Cloudflare refresh invalidates prior proof and expiry is fail-closed", async () => {
  const request = (route: string, payload: Record<string, unknown>) =>
    handleCloudflareApi(new Request("https://licenx.test/api/" + route, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), undefined);
  const first = await request("v1/license/validate", {
    license_key: licenseKey, hwid, app_name: "vcon_default",
    app_version: "1.0.0", device_name: "V2", os_info: "test",
    nonce: "CF_REPLAY_VALIDATION_1234567890", logout_proof_version: 2,
  });
  assert.equal(first.status, 200);
  const firstProof = (await first.json() as Record<string, any>).device_logout_proof as string;
  const refreshed = await request("v1/license/ping", {
    license_key: licenseKey, hwid, app_name: "vcon_default",
    nonce: "CF_PROOF_HEARTBEAT_1234567890", logout_proof_version: 2,
  });
  assert.equal(refreshed.status, 200);
  const refreshedProof = (await refreshed.json() as Record<string, any>).device_logout_proof as string;
  const loginGeneration = JSON.parse(Buffer.from(firstProof.split(".")[1], "base64url").toString()).generation;
  const pingGeneration = JSON.parse(Buffer.from(refreshedProof.split(".")[1], "base64url").toString()).generation;
  assert.ok(pingGeneration > loginGeneration, "generation advances even in the same millisecond");

  const send = async (proof: string) => handleCloudflareApi(
    new Request("https://licenx.test/api/v2/license/logout", {
      method: "POST", headers: { Authorization: "Bearer " + proof }, body: "{}",
    }), undefined,
  );
  assert.equal((await send(firstProof)).status, 403);
  const parts = refreshedProof.split(".");
  const expiredClaim = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  expiredClaim.expires = Date.now() - 1000;
  const encoded = Buffer.from(JSON.stringify(expiredClaim)).toString("base64url");
  const crypto = await import("node:crypto");
  const mac = crypto.createHmac("sha256", privateKeyPem)
    .update("licenx-cf-logout-v2:").update(encoded).digest("base64url");
  assert.equal((await send("lx2." + encoded + "." + mac)).status, 403);
  assert.equal((await send(refreshedProof)).status, 200);
  assert.equal((await send(refreshedProof)).status, 403);
});
