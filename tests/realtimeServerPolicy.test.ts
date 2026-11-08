import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { apiRouter } from "../src/server/api.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { canonicalJson, createSessionToken, generateEd25519KeyPair, verifySignature } from "../src/server/crypto.js";
import { createRealtimeTickets } from "../src/server/realtime/sessionTickets.js";
import { createRealtimeLeaseManager } from "../src/server/realtime/leaseManager.js";
import { createRealtimeEventPublisher } from "../src/server/realtime/eventPublisher.js";
import { currentRealtimeCursor, eventsAfter } from "../src/server/realtime/eventCursor.js";

test("WS-02: additive policy, authenticated tickets, committed events, signed snapshots and safe lease", async () => {
  const original = Object.fromEntries(["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"].map(k => [k, process.env[k]]));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "libsql";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const db = getDbClient();
  let http: ReturnType<typeof createServer> | undefined;
  try {
    await initDatabaseSchema();
    await initDatabaseSchema(); // schema idempotence, in-memory only
    const keys = generateEd25519KeyPair();
    const now = Date.now();
    await db.execute({ sql: `INSERT INTO admin_config
       (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      args: ["rtadmin", "owner", "unused", "test-jwt-secret", keys.privateKeyPem, keys.publicKeyPem, now, now] });
    await db.execute({ sql: `INSERT INTO apps
      (id,app_slug,display_name,status,app_secret,created_at,updated_at)
      VALUES (?,?,?,'active',?,?,?)`,
      args: ["rt-app", "rt-app", "Realtime Test", "secret", now, now] });
    const defaults = await db.execute("SELECT realtime_websocket_enabled,keep_login_on_network_error FROM apps WHERE id='rt-app'");
    assert.equal(Number(defaults.rows[0].realtime_websocket_enabled), 0);
    assert.equal(Number(defaults.rows[0].keep_login_on_network_error), 0);
    await db.execute({ sql: `INSERT INTO licenses
      (id,key,status,app_id,device_limit,validity_type,validity_value,activated_at,created_at)
      VALUES (?,?,'active',?,1,'lifetime',0,?,?)`, args: ["rt-lic", "RT-EXAMPLE-LICENSE-KEY", "rt-app", now, now] });
    await db.execute({ sql: `INSERT INTO devices
      (id,license_id,hwid,first_bound_at,last_ping_at,status)
      VALUES (?,?,?,?,?,'active')`, args: ["rt-dev", "rt-lic", "hwid-rt", now, now] });

    const issuer = createRealtimeTickets(db);
    const input = { license_key: "RT-EXAMPLE-LICENSE-KEY", hwid: "hwid-rt", app_name: "rt-app" };
    assert.equal((await issuer.issue(input, "127.0.0.1")).status, 403, "default OFF");
    assert.equal((await issuer.issue({ ...input, app_name: "wrong-app" }, "127.0.0.1")).status, 403);
    assert.equal((await issuer.issue({ ...input, hwid: "wrong-device" }, "127.0.0.1")).status, 403);

    // Admin API policy additions preserve existing request and response contracts.
    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = "http://127.0.0.1:" + address.port;
    const bearer = "Bearer " + createSessionToken({username:"owner", exp: Math.floor(Date.now()/1000)+1800}, "test-jwt-secret");
    const invalid = await fetch(base + "/api/apps/rt-app", {
      method:"PATCH", headers: {authorization:bearer, "content-type":"application/json"},
      body:JSON.stringify({realtime_websocket_enabled:"true"}),
    });
    assert.equal(invalid.status, 400, "reject string booleans");
    const enable = await fetch(base + "/api/apps/rt-app", {
      method:"PATCH", headers: {authorization:bearer, "content-type":"application/json"},
      body:JSON.stringify({realtime_websocket_enabled:true,keep_login_on_network_error:true}),
    });
    assert.equal(enable.status, 200);
    const flags = await db.execute("SELECT realtime_websocket_enabled,keep_login_on_network_error FROM apps WHERE id='rt-app'");
    assert.equal(Number(flags.rows[0].realtime_websocket_enabled), 1);
    assert.equal(Number(flags.rows[0].keep_login_on_network_error), 1);
    const issued = await issuer.issue(input, "127.0.0.1");
    assert.equal(issued.status, 200);
    const ticket = "ticket" in issued.body ? issued.body.ticket : undefined;
    assert.equal(typeof ticket, "string");
    const request = { headers: { authorization: "Bearer " + ticket } } as any;
    const principal = await issuer.authenticate(request);
    assert.equal(principal?.licenseId, "rt-lic");
    assert.equal(await issuer.authenticate(request), null, "one-use token");
    assert.equal(await issuer.authenticate({headers: {authorization: "Bearer invalid"}} as any), null);

    const messages: Array<{payload:any;who:string}> = [];
    const client = { identity: principal!, ws: { close: (_code?:number) => { clientClosed++; } } };
    const other = { identity: {...principal!, appId:"unrelated",licenseId:"other",deviceId:"other-device"}, ws:{close:()=>{}} };
    let clientClosed=0;
    const registry = {
      get: (id:string) => id === "socket-1" ? client : undefined,
      broadcast: (payload:any, filter?: (entry:any)=>boolean) => {
        let n=0;
        for(const [who,entry] of [["main",client],["other",other]] as const) {
          if (!filter || filter(entry)) { messages.push({payload,who}); n++; }
        }
        return n;
      },
    };
    const lease = createRealtimeLeaseManager(db, registry);
    lease.register("socket-1", principal!);
    await lease.tick(now+1000);
    const renewed = await db.execute("SELECT last_ping_at FROM devices WHERE id = 'rt-dev'");
    assert.equal(Number(renewed.rows[0].last_ping_at), now+1000);

    const relay = createRealtimeEventPublisher(db, registry, () => lease.tick(now+2000));
    await relay.init();
    const snap = await relay.snapshot(principal!);
    const {signature: snapSig, ...snapData}=snap;
    assert.equal(verifySignature(canonicalJson(snapData), snapSig, keys.publicKeyPem), true);

    await db.execute({sql:"UPDATE licenses SET status='revoked' WHERE id = ?",args:["rt-lic"]});
    const afterMutation = await eventsAfter(db, await currentRealtimeCursor(db)-1);
    assert.ok(afterMutation.some(e=>e.event_type==="license.changed"));
    await relay.tick();
    assert.equal(messages.filter(x=>x.who==="main").length, 1);
    assert.equal(messages.filter(x=>x.who==="other").length, 0);
    const {signature, ...payload}=messages[0].payload;
    assert.equal(verifySignature(canonicalJson(payload), signature, keys.publicKeyPem), true);
    assert.equal(clientClosed, 1, "revoked device socket forced to close by lease revalidation");
    assert.equal((await issuer.issue(input, "127.0.0.1")).status, 403, "revoked license rejected");
    lease.stop(); relay.stop();
  } finally {
    if (http?.listening) await new Promise<void>(resolve => http!.close(()=>resolve()));
    await db.close();
    for(const [key,value] of Object.entries(original)) {
      if(value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
