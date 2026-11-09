import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { createSessionToken, generateEd25519KeyPair } from "../src/server/crypto.js";
import { getDbClient, initDatabaseSchema } from "../src/server/db.js";
import { createAdminRealtimeGateway, type AdminRealtimeChange } from "../src/server/realtime/adminGateway.js";
import { createAdminEventBridge } from "../src/server/realtime/adminEventBridge.js";
import {
  registerRealtimePresence, closeRealtimeDeviceSessions,
  setRealtimePresenceEnabled, subscribeRealtimePresence,
} from "../src/server/realtime/presence.js";
import type { DatabaseClient } from "../src/server/database/contracts.js";

class SocketStub extends EventEmitter {
  readyState = 1;
  close(_code?: number, _reason?: string): void { this.readyState = 3; this.emit("close"); }
}

test("ADMIN-RT-02: trusted post-hello presence emits sanitized connect, disconnect and forced-unbind events", () => {
  const notifications: unknown[] = [];
  const unsubscribe = subscribeRealtimePresence(change => notifications.push(change));
  setRealtimePresenceEnabled(true);
  try {
    const first = new SocketStub();
    const second = new SocketStub();
    const identity = (appId: string, deviceId: string) => ({
      appId, licenseId: "license-sensitive", deviceId, hwid: "PRIVATE-HWID", authenticatedAt: Date.now(),
    });
    registerRealtimePresence("rt-first", identity("app-one", "device-one"), first);
    registerRealtimePresence("rt-second", identity("app-two", "device-two"), second);
    first.close();
    assert.equal(closeRealtimeDeviceSessions("device-two"), 1);
    assert.deepEqual(notifications, [
      { appId: "app-one", deviceId: "device-one" },
      { appId: "app-two", deviceId: "device-two" },
      { appId: "app-one", deviceId: "device-one" },
      { appId: "app-two", deviceId: "device-two" },
    ]);
    assert.doesNotMatch(JSON.stringify(notifications), /PRIVATE|HWID|license-sensitive|key/i);
  } finally {
    unsubscribe();
    setRealtimePresenceEnabled(false);
  }
});

test("ADMIN-RT-02: subscriber-only committed journal, scoped log cursors and bounded backlog", async () => {
  const delivered: AdminRealtimeChange[] = [];
  let subscribers = 0;
  let queries = 0;
  const events: Array<{id:number;event_type:string;app_id:string|null;license_id:string|null;device_id:string|null;created_at:number}> = [];
  const logs: Array<{id:string;app_slug:string;created_at:number}> = [];
  const apps = [{id:"app-one",app_slug:"alpha"},{id:"app-two",app_slug:"beta"}];
  const db = { execute: async (stmt: any) => {
    queries++;
    const sql: string = typeof stmt === "string" ? stmt : stmt.sql;
    const args: any[] = typeof stmt === "string" ? [] : stmt.args;
    if (sql.includes("COALESCE(MAX(id)")) return {rows:[{version:events.at(-1)?.id ?? 0}]};
    if (sql.includes("FROM realtime_events WHERE id >")) {
      return { rows: events.filter(x => x.id > Number(args[0])).slice(0,200) };
    }
    if (sql.includes("FROM validation_logs ORDER BY")) {
      return { rows: [...logs].sort((a,b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(0,201) };
    }
    if (sql.includes("SELECT id, app_slug FROM apps WHERE")) {
      return { rows: apps.filter(x => args.includes(x.app_slug)) };
    }
    throw Error("Unexpected synthetic query " + sql);
  } } as unknown as DatabaseClient;
  const bridge = createAdminEventBridge(db, {
    subscriberCount: () => subscribers,
    publishChange: value => { delivered.push(value); },
  });
  await bridge.tick();
  assert.equal(queries, 0, "zero subscribers must do no DB work");
  subscribers = 1;
  await bridge.tick();
  assert.equal(delivered.length, 0, "bootstrap baseline must not replay historical customer events");

  const addEvent = (id:number,type:string,appId:string|null) => events.push({
    id,event_type:type,app_id:appId,license_id:"PRIVATE-KEY",device_id:"SECRET-HWID",created_at:Date.now(),
  });
  addEvent(1, "app.changed", "app-one");
  addEvent(2, "license.changed", "app-one");
  addEvent(3, "device.deleted", "app-two");
  logs.push({id:"log-1",app_slug:"beta",created_at:Date.now()});
  await bridge.tick();
  assert.ok(delivered.some(x => x.type==="resource.changed" && x.resource==="apps" && x.app_id==="app-one"));
  assert.ok(delivered.some(x => x.type==="resource.changed" && x.resource==="licenses" && x.app_id==="app-one"));
  assert.ok(delivered.some(x => x.type==="resource.changed" && x.resource==="devices" && x.app_id==="app-two"));
  assert.ok(delivered.some(x => x.type==="resource.changed" && x.resource==="logs" && x.app_id==="app-two"));
  assert.ok(delivered.some(x => x.type==="resource.changed" && x.resource==="stats"));
  assert.doesNotMatch(JSON.stringify(delivered), /PRIVATE-KEY|SECRET-HWID|log-1|beta/);
  const count = delivered.length;
  await bridge.tick();
  assert.equal(delivered.length, count, "no duplicate replay of committed journal or log");
  const beforeIdle = queries;
  subscribers = 0;
  await bridge.tick();
  assert.equal(queries, beforeIdle, "do not poll logs or journal when Admin sessions are absent");
  subscribers = 1;
  addEvent(4,"app.deleted","app-one");
  await bridge.tick();
  assert.equal(delivered.length, count, "newly connected clients use their own initial HTTP snapshot");
  for(let i=5;i<=204;i++)addEvent(i,"license.changed","app-one");
  await bridge.tick();
  assert.ok(delivered.some(x=>x.type==="stream.resync" && x.reason==="backlog"));
  assert.equal(bridge.cursor,204,"bounded 200-event batch advances once, without silent tail loss");
  await bridge.tick();
  assert.equal(bridge.cursor,204);
  bridge.stop();
});

async function wsConnect(port:number, jwt:string, proof:string): Promise<WebSocket> {
  const socket = new WebSocket("ws://127.0.0.1:"+port+"/api/admin/realtime", {
    headers:{origin:"http://127.0.0.1:"+port, Cookie:"vcon_admin_session="+jwt+"; "+proof},
    handshakeTimeout:2000,
  });
  await new Promise<void>((resolve,reject)=>{
    socket.once("open",resolve);
    socket.once("error",reject);
    socket.once("unexpected-response",(_req,res)=>{res.resume();reject(new Error("Upgrade rejected "+res.statusCode));});
  });
  return socket;
}
function messageOf(socket:WebSocket, type:string):Promise<any> {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{socket.off("message",handler);reject(Error("No "+type));},1500);
    function handler(raw:WebSocket.RawData) {
      try {
        const v=JSON.parse(raw.toString());
        if(v.type===type) {clearTimeout(timeout);socket.off("message",handler);resolve(v);}
      } catch {}
    }
    socket.on("message",handler);
  });
}
test("ADMIN-RT-02: authenticated Admin-only socket dispatch is App-scoped, coalesced, ordered and secret-free", async () => {
  const envNames=["NODE_ENV","DATABASE_PROVIDER","DATABASE_URL","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"];
  const original=Object.fromEntries(envNames.map(x=>[x,process.env[x]]));
  process.env.NODE_ENV="test";process.env.DATABASE_PROVIDER="libsql";process.env.DATABASE_URL="file::memory:";
  delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
  const db=getDbClient();
  const gateway=createAdminRealtimeGateway();
  const http=createServer((_req,res)=>res.end("existing HTTP untouched"));
  try {
    await initDatabaseSchema();
    const pair=generateEd25519KeyPair(),secret="test-admin-phase02-secret",now=Date.now();
    await db.execute({sql:`INSERT INTO admin_config
      (id,username,password_hash,jwt_secret,ed25519_private_key,ed25519_public_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      args:["phase02","owner","placeholder",secret,pair.privateKeyPem,pair.publicKeyPem,now,now]});
    gateway.attach(http);
    await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
    const address=http.address();
    if (!address || typeof address==="string") throw Error("No port");
    const port=address.port;
    const jwt=createSessionToken({username:"owner",exp:Math.floor(now/1000)+600},secret);
    const proof1=gateway.issueBootstrap(jwt)!.split(";")[0];
    const one=await wsConnect(port,jwt,proof1);
    const scopedOne=messageOf(one,"admin.scoped");
    one.send(JSON.stringify({type:"admin.scope",app_id:"app-one"}));
    assert.equal((await scopedOne).app_id,"app-one");
    const proof2=gateway.issueBootstrap(jwt)!.split(";")[0];
    const two=await wsConnect(port,jwt,proof2);
    const scopedTwo=messageOf(two,"admin.scoped");
    two.send(JSON.stringify({type:"admin.scope",app_id:"app-two"}));
    assert.equal((await scopedTwo).app_id,"app-two");
    const a:any[]=[],b:any[]=[];
    one.on("message",raw=>{try{const x=JSON.parse(raw.toString());if(x.type==="resource.changed"||x.type==="presence.changed")a.push(x);}catch{}});
    two.on("message",raw=>{try{const x=JSON.parse(raw.toString());if(x.type==="resource.changed"||x.type==="presence.changed")b.push(x);}catch{}});
    for(let i=0;i<50;i++)gateway.publishChange({type:"presence.changed",app_id:"app-one"});
    gateway.publishChange({type:"resource.changed",app_id:"app-two",resource:"licenses",source_version:3});
    gateway.publishChange({type:"resource.changed",app_id:"app-one",resource:"devices",source_version:4});
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(a.length,2,"50 connect events coalesce to one App presence event plus device event");
    assert.equal(b.length,1,"App two receives only its own license invalidation");
    assert.deepEqual(a.map(x=>x.sequence),[1,2],"per-socket sequence contiguous");
    assert.deepEqual(b.map(x=>x.sequence),[1],"filtered events cannot cause false cursor gaps");
    assert.deepEqual(a.map(x=>x.app_id),["app-one","app-one"]);
    assert.deepEqual(b.map(x=>x.app_id),["app-two"]);
    assert.doesNotMatch(JSON.stringify([...a,...b]), /hwid|license_key|password|ip_address|jwt|test-admin-phase02-secret/i);
    assert.equal(gateway.subscriberCount(),2);
    const rejected=messageOf(one,"admin.scoped").catch(()=>null);
    one.send(JSON.stringify({type:"admin.scope",app_id:null}));
    assert.equal((await rejected)?.app_id,null);
    gateway.revokeSession(jwt);
    await new Promise(resolve=>setTimeout(resolve,75));
    assert.equal(gateway.subscriberCount(),0,"revoke closes scoped Admin sessions");
  } finally {
    await gateway.stop();
    if(http.listening)await new Promise<void>(resolve=>http.close(()=>resolve()));
    await db.close();
    for(const [name,value] of Object.entries(original)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  }
});


test("ADMIN-RT remediation-01: SQLite journal covers insert/metadata without duplicate or heartbeat events", async () => {
  const envNames = ["NODE_ENV", "DATABASE_PROVIDER", "DATABASE_URL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PROVIDER = "libsql";
  process.env.DATABASE_URL = "file::memory:";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const db = getDbClient();
  try {
    await initDatabaseSchema();
    const now = Date.now();
    await db.execute({ sql: `INSERT INTO apps
      (id,app_slug,display_name,status,app_secret,created_at,updated_at)
      VALUES (?,?,?,'active',?,?,?)`,
      args: ["p01-app","p01-app","App A","placeholder-secret",now,now] });
    await db.execute({ sql: `INSERT INTO licenses
      (id,key,app_id,status,device_limit,created_at)
      VALUES (?,?,?,'active',1,?)`,
      args: ["p01-lic","FAKE-SECRET-KEY","p01-app",now] });
    await db.execute({ sql: `INSERT INTO devices
      (id,license_id,hwid,first_bound_at,last_ping_at,status)
      VALUES (?,?,?,?,?,'active')`,
      args: ["p01-dev","p01-lic","FAKE-PRIVATE-HWID",now,now] });
    const inserted = (await db.execute(
      "SELECT event_type,app_id,license_id,device_id FROM realtime_events ORDER BY id"
    )).rows;
    assert.deepEqual(inserted.map(x => x.event_type), ["app.changed", "license.changed", "device.changed"]);
    assert.deepEqual(inserted.map(x => x.app_id), ["p01-app", "p01-app", "p01-app"]);
    assert.deepEqual(inserted.map(x => x.license_id), [null, "p01-lic", "p01-lic"]);
    assert.deepEqual(inserted.map(x => x.device_id), [null, null, "p01-dev"]);
    assert.doesNotMatch(JSON.stringify(inserted), /FAKE-SECRET|FAKE-PRIVATE|placeholder-secret/);

    await db.execute("DELETE FROM realtime_events");
    await db.execute("UPDATE apps SET display_name='App B' WHERE id='p01-app'");
    await db.execute("UPDATE apps SET status='inactive',description='mixed' WHERE id='p01-app'");
    await db.execute("UPDATE licenses SET customer_name='Fixture' WHERE id='p01-lic'");
    await db.execute("UPDATE licenses SET status='revoked',customer_email='fixture@example.invalid' WHERE id='p01-lic'");
    await db.execute("UPDATE devices SET device_name='Fixture Device' WHERE id='p01-dev'");
    await db.execute("UPDATE devices SET status='blocked',os_info='fixture' WHERE id='p01-dev'");
    await db.execute({ sql: "UPDATE devices SET last_ping_at=? WHERE id='p01-dev'", args: [now + 5_000] });
    await db.execute("UPDATE apps SET display_name='App B' WHERE id='p01-app'");
    const changed = (await db.execute(
      "SELECT id,event_type,app_id,license_id,device_id FROM realtime_events ORDER BY id"
    )).rows;
    assert.deepEqual(changed.map(x => x.event_type), [
      "app.changed","app.changed","license.changed","license.changed","device.changed","device.changed",
    ], "metadata and mixed policy changes each yield exactly one event; heartbeat/no-op yields none");
    assert.deepEqual(changed.map(x => Number(x.id)), [...changed.map(x => Number(x.id))].sort((a, b) => a - b));
    assert.doesNotMatch(JSON.stringify(changed), /FAKE-SECRET|FAKE-PRIVATE|fixture@example.invalid/);

    await initDatabaseSchema();
    const triggerCount = await db.execute(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='licenx_rt_app_insert'"
    );
    assert.equal(Number(triggerCount.rows[0].count), 1);
    const tx = await db.transaction("write");
    try {
      await tx.execute({ sql: `INSERT INTO apps
        (id,app_slug,display_name,app_secret,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`, args: ["p01-rolled-back","p01-rolled-back","Temporary","private",now,now] });
      await tx.rollback();
    } finally { tx.close(); }
    assert.equal(Number((await db.execute(
      "SELECT COUNT(*) AS count FROM realtime_events WHERE app_id='p01-rolled-back'"
    )).rows[0].count), 0, "rolled-back business INSERT cannot leak journal event");
  } finally {
    await db.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
