import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express from "express";
import { apiRouter } from "../src/server/api.js";
import { createSessionToken, generateEd25519KeyPair } from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import {
  closeRealtimeDeviceSessions, getRealtimePresenceReport,
  registerRealtimePresence, setRealtimePresenceEnabled,
} from "../src/server/realtime/presence.js";

class StubSocket extends EventEmitter {
  readyState = 1;
  closes: Array<{code?: number; reason?: string}> = [];
  close(code?: number, reason?: string) {
    this.closes.push({code, reason});
    this.readyState = 3;
    this.emit("close");
  }
}

test("WS-04: authenticated scoped presence, server policy, and post-commit forced logout", async () => {
  const keys = ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "libsql";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const db = getDbClient();
  let http: ReturnType<typeof createServer> | undefined;
  setRealtimePresenceEnabled(false);
  try {
    await initDatabaseSchema();
    const now = Date.now();
    const keys = generateEd25519KeyPair();
    await db.execute({sql: `INSERT INTO admin_config
      (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      args:["rt-admin","owner","placeholder","session-key",keys.privateKeyPem,keys.publicKeyPem,now,now]});
    for (const [appId, licenseId, deviceId] of [
      ["app-one", "lic-one", "dev-one"],
      ["app-two", "lic-two", "dev-two"],
    ]) {
      await db.execute({sql: `INSERT INTO apps
        (id,app_slug,display_name,status,app_secret,created_at,updated_at)
        VALUES (?,?,?,'active',?,?,?)`,
        args:[appId,appId,appId,"secret",now,now]});
      await db.execute({sql: `INSERT INTO licenses
        (id,key,status,app_id,device_limit,validity_type,validity_value,activated_at,created_at)
        VALUES (?,?,'active',?,1,'lifetime',0,?,?)`,
        args:[licenseId, "LICENSE-"+licenseId,appId,now,now]});
      await db.execute({sql: `INSERT INTO devices
        (id,license_id,hwid,first_bound_at,last_ping_at,status)
        VALUES (?,?,?,?,?,'active')`,
        args:[deviceId,licenseId,"hwid-"+deviceId,now,now]});
    }
    setRealtimePresenceEnabled(true);
    const first = new StubSocket();
    const second = new StubSocket();
    const principal = (appId:string,licenseId:string,deviceId:string) =>
      ({appId,licenseId,deviceId,hwid:"sensitive-should-never-report",authenticatedAt:now});
    registerRealtimePresence("c1", principal("app-one","lic-one","dev-one"),first);
    registerRealtimePresence("c2", principal("app-two","lic-two","dev-two"),second);
    const scoped = await getRealtimePresenceReport(db, {appId:"app-one", deviceIds:["dev-one","dev-two"]});
    assert.equal(scoped.connectedNow,1);
    assert.equal(scoped.boundActive,1);
    assert.equal(scoped.activeSockets,1);
    assert.deepEqual(scoped.connectedDeviceIds,["dev-one"]);
    assert.equal(scoped.staleBound,0);
    assert.doesNotMatch(JSON.stringify(scoped), /hwid|sensitive|LICENSE-/i);
    const global = await getRealtimePresenceReport(db, {deviceIds:["dev-one","dev-two"]});
    assert.equal(global.connectedNow,2);
    assert.equal(global.boundActive,2);

    const app = express();
    app.use(express.json());
    app.use("/api",apiRouter);
    http=createServer(app);
    await new Promise<void>(resolve => http!.listen(0,"127.0.0.1",resolve));
    const addr=http.address();
    if(!addr || typeof addr==="string") throw Error("test listener unavailable");
    const base="http://127.0.0.1:"+addr.port;
    const auth="Bearer "+createSessionToken({username:"owner",exp:Math.floor(now/1000)+1800},"session-key");
    const unauthorized=await fetch(base+"/api/realtime/presence?app_id=app-one");
    assert.equal(unauthorized.status,401);
    const invalidScope=await fetch(base+"/api/realtime/presence?app_id=bad%20id",{headers:{authorization:auth}});
    assert.equal(invalidScope.status,400);
    const report=await fetch(base+"/api/realtime/presence?app_id=app-one&device_ids=dev-one%2Cdev-two",{headers:{authorization:auth}});
    assert.equal(report.status,200);
    const data=await report.json() as {connectedNow:number;connectedDeviceIds:string[];boundActive:number};
    assert.deepEqual(data.connectedDeviceIds,["dev-one"]);
    assert.equal(data.connectedNow,1);
    assert.equal(data.boundActive,1);

    const toggle=await fetch(base+"/api/apps/app-one",{
      method:"PATCH",headers:{authorization:auth,"content-type":"application/json"},
      body:JSON.stringify({realtime_websocket_enabled:true, keep_login_on_network_error:true}),
    });
    assert.equal(toggle.status,200);
    const flags=await db.execute("SELECT realtime_websocket_enabled,keep_login_on_network_error FROM apps WHERE id='app-one'");
    assert.equal(Number(flags.rows[0].realtime_websocket_enabled),1);
    assert.equal(Number(flags.rows[0].keep_login_on_network_error),1);
    const invalidToggle=await fetch(base+"/api/apps/app-one",{
      method:"PATCH",headers:{authorization:auth,"content-type":"application/json"},
      body:JSON.stringify({keep_login_on_network_error:"yes"}),
    });
    assert.equal(invalidToggle.status,400);

    const noAuthDelete=await fetch(base+"/api/devices/dev-one",{method:"DELETE"});
    assert.equal(noAuthDelete.status,401);
    assert.equal(first.closes.length,0);
    const forceLogout=await fetch(base+"/api/devices/dev-one",{
      method:"DELETE",headers:{authorization:auth},
    });
    assert.equal(forceLogout.status,200);
    assert.deepEqual(first.closes,[{code:4003,reason:"device unbound"}]);
    assert.equal(second.closes.length,0);
    const after=await getRealtimePresenceReport(db,{deviceIds:["dev-one","dev-two"]});
    assert.equal(after.connectedNow,1);
    assert.equal(after.boundActive,1);
    const event=await db.execute("SELECT COUNT(*) AS n FROM realtime_events WHERE event_type='device.deleted' AND device_id='dev-one'");
    assert.ok(Number(event.rows[0].n)>=1,"existing committed event journal covers unbind");
    // Repeated closure never terminates a different app/device.
    assert.equal(closeRealtimeDeviceSessions("dev-one"),0);
  } finally {
    setRealtimePresenceEnabled(false);
    if (http?.listening) await new Promise<void>(resolve=>http!.close(()=>resolve()));
    await db.close();
    for (const [key,value] of Object.entries(oldEnv)) {
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});

test("WS-04: existing compact UI retains layout and differentiates policy from presence", () => {
  const modal=readFileSync(new URL("../src/components/EditAppModal.tsx",import.meta.url),"utf8");
  const devices=readFileSync(new URL("../src/components/DevicesTab.tsx",import.meta.url),"utf8");
  assert.match(modal,/License Session Policy/);
  assert.match(modal,/realtime_websocket_enabled: webSocketEnabled/);
  assert.match(modal,/keep_login_on_network_error: keepLoginOnNetworkError/);
  assert.match(modal,/After a verified WebSocket snapshot, new SDK follows this signed policy/);
  assert.match(devices,/Force logout/);
  assert.match(devices,/Connected/);
  assert.match(devices,/No WS/);
  assert.match(devices,/Last Heartbeat/);
});
