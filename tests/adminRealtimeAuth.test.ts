import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import WebSocket from "ws";
import { apiRouter } from "../src/server/api.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { createSessionToken, generateEd25519KeyPair } from "../src/server/crypto.js";
import {
  ADMIN_REALTIME_PATH, ADMIN_REALTIME_PROOF_COOKIE,
  createAdminRealtimeGateway, setActiveAdminRealtimeGateway,
} from "../src/server/realtime/adminGateway.js";
import { createEngine } from "../engine/socketcore/index.js";

function openSocket(
  url: string, headers: Record<string, string> = {},
): Promise<{ status: number; socket?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 2000 });
    socket.once("open", () => resolve({ status: 101, socket }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve({ status: response.statusCode || 0 });
    });
    socket.once("error", reject);
  });
}

test("ADMIN-RT-01 P01: one-use Admin bootstrap, secure WS, isolation and session revocation", async () => {
  const keys = ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "libsql";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const db = getDbClient();
  const gateway = createAdminRealtimeGateway();
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  const server = createServer(app);
  const licenseEngine = createEngine({
    path: "/api/realtime",
    authenticate: async () => null,
    authorizeSubscription: async () => false,
  });
  try {
    await initDatabaseSchema();
    const now = Date.now();
    const keys = generateEd25519KeyPair();
    const secret = "admin-realtime-test-only-secret";
    await db.execute({
      sql: `INSERT INTO admin_config
        (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      args: ["rt-p01", "owner", "placeholder", secret, keys.privateKeyPem, keys.publicKeyPem, now, now],
    });
    gateway.attach(server);
    licenseEngine.attach(server);
    licenseEngine.start();
    setActiveAdminRealtimeGateway(gateway);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const origin = "http://127.0.0.1:" + address.port;
    const base = origin + "/api/admin/realtime/bootstrap";
    const socketUrl = "ws://127.0.0.1:" + address.port + ADMIN_REALTIME_PATH;
    const csrf = "a".repeat(64);
    const jwt = createSessionToken({ username: "owner", exp: Math.floor(Date.now() / 1000) + 1800 }, secret);
    const csrfCookie = "vcon_admin_csrf=" + csrf;
    const sessionCookie = "vcon_admin_session=" + jwt;
    const requestHeaders = {
      Origin: origin, Cookie: sessionCookie + "; " + csrfCookie,
      "X-CSRF-Token": csrf, "Content-Type": "application/json",
    };
    const issue = (headers: Record<string, string> = requestHeaders) =>
      fetch(base, { method: "POST", headers, body: "{}" });

    setActiveAdminRealtimeGateway(null);
    assert.equal((await issue()).status, 404, "default-disabled Admin bootstrap");
    setActiveAdminRealtimeGateway(gateway);
    assert.equal((await issue({ ...requestHeaders, Origin: "https://evil.example" })).status, 403);
    assert.equal((await issue({ ...requestHeaders, "X-CSRF-Token": "bad" })).status, 403);
    assert.equal((await issue({ ...requestHeaders, Cookie: csrfCookie })).status, 401);
    assert.equal((await issue({ ...requestHeaders, Authorization: "Bearer " + jwt })).status, 403);
    const expired = createSessionToken({ username: "owner", exp: Math.floor(Date.now() / 1000) - 60 }, secret);
    assert.equal((await issue({ ...requestHeaders, Cookie: "vcon_admin_session=" + expired + "; " + csrfCookie })).status, 401);
    assert.equal((await openSocket(socketUrl, { Origin: origin })).status, 401);
    assert.equal((await openSocket(socketUrl, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await openSocket(socketUrl, { Origin: origin, Cookie: sessionCookie, })).status, 401);
    assert.equal((await openSocket("ws://127.0.0.1:" + address.port + "/api/realtime")).status, 401,
      "existing license gateway must remain separate");

    const bootstrap = await issue();
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(await bootstrap.json(), { expires_in_seconds: 30 });
    const setCookie = bootstrap.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.match(setCookie, /Path=\/api\/admin\/realtime;/);
    assert.doesNotMatch(JSON.stringify(await issue().then(r => r.json())), /admin-realtime-test-only-secret/);
    // Issuing the next bootstrap intentionally invalidates the preceding proof.
    const renewed = await issue();
    assert.equal(renewed.status, 200);
    const proofCookie = (renewed.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(proofCookie.startsWith(ADMIN_REALTIME_PROOF_COOKIE + "="));

    const headers = { Origin: origin, Cookie: sessionCookie + "; " + proofCookie };
    assert.equal((await openSocket(socketUrl, { ...headers, Origin: "https://evil.example" })).status, 403);
    assert.equal((await openSocket(socketUrl, { ...headers, Cookie: csrfCookie + "; " + proofCookie })).status, 401);
    // Wrong session consumes proof, so a fresh bootstrap is required.
    const fresh = await issue();
    assert.equal(fresh.status, 200);
    const allowedHeaders = {
      Origin: origin,
      Cookie: sessionCookie + "; " + (fresh.headers.get("set-cookie") || "").split(";")[0],
    };
    const success = await openSocket(socketUrl, allowedHeaders);
    assert.equal(success.status, 101);
    assert.ok(success.socket);
    assert.equal((await openSocket(socketUrl, allowedHeaders)).status, 401, "bootstrap must be one use");
    assert.equal((await openSocket(socketUrl + "?ticket=do-not-use", allowedHeaders)).status, 400);
    const ws = success.socket!;
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    const logout = await fetch(origin + "/api/auth/logout", {
      method: "POST", headers: requestHeaders, body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal(await closed, 4003, "logout closes authenticated socket immediately");
    const afterLogout = await issue();
    assert.notEqual(afterLogout.status, 200, "revoked session must not rebootstrap");

    // New signed session can connect; credential rotation closes an existing stream.
    const newToken = createSessionToken({ username: "owner", exp: Math.floor(Date.now() / 1000) + 1801 }, secret);
    const newCookie = "vcon_admin_session=" + newToken;
    const again = await issue({ ...requestHeaders, Cookie: newCookie + "; " + csrfCookie });
    assert.equal(again.status, 200);
    const next = await openSocket(socketUrl, {
      Origin: origin, Cookie: newCookie + "; " + (again.headers.get("set-cookie") || "").split(";")[0],
    });
    assert.equal(next.status, 101);
    // Two concurrent, separately authenticated Admin browser sessions remain isolated.
    const otherToken = createSessionToken({
      username: "owner", exp: Math.floor(Date.now() / 1000) + 1802,
    }, secret);
    const otherProof = await issue({
      ...requestHeaders, Cookie: "vcon_admin_session=" + otherToken + "; " + csrfCookie,
    });
    assert.equal(otherProof.status, 200);
    const other = await openSocket(socketUrl, {
      Origin: origin,
      Cookie: "vcon_admin_session=" + otherToken + "; " +
        (otherProof.headers.get("set-cookie") || "").split(";")[0],
    });
    assert.equal(other.status, 101);
    assert.ok(other.socket);
    const firstClose = new Promise<number>(resolve => next.socket!.once("close", resolve));
    gateway.revokeSession(newToken);
    assert.equal(await firstClose, 4003, "revocation closes only matching session");
    assert.equal(other.socket!.readyState, WebSocket.OPEN,
      "another authenticated Admin socket must not be revoked");
    const rotatedClose = new Promise<number>(resolve => other.socket!.once("close", resolve));
    await db.execute({ sql: "UPDATE admin_config SET jwt_secret = ? WHERE id = ?", args: ["rotated-test-secret", "rt-p01"] });
    await gateway.sweepSessions();
    assert.equal(await rotatedClose, 4003, "rotated Admin session must close");
  } finally {
    setActiveAdminRealtimeGateway(null);
    await gateway.stop();
    await licenseEngine.stop();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
