import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { createEngine } from "../engine/socketcore/index.js";
import { canonicalJson, verifySignature } from "../src/server/crypto.js";
import { createRealtimeEventPublisher } from "../src/server/realtime/eventPublisher.js";
import { createRealtimeTickets, validateRealtimeDevice } from "../src/server/realtime/sessionTickets.js";
import type { DatabaseClient } from "../src/server/database/contracts.js";

function waitForMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error("Realtime response timeout")); }, 4000);
    const listener = (data: WebSocket.RawData) => {
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message?.type === type) { dispose(); resolve(message); }
    };
    const error = (e: Error) => { dispose(); reject(e); };
    function dispose() {
      clearTimeout(timer);
      socket.off("message", listener);
      socket.off("error", error);
    }
    socket.on("message", listener);
    socket.on("error", error);
  });
}
async function connect(url: string, ticket: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {headers:{authorization:"Bearer "+ticket},handshakeTimeout:3000});
  await new Promise<void>((resolve,reject)=>{
    socket.once("open",resolve); socket.once("error",reject);
    socket.once("unexpected-response",(_req,response)=>{
      response.resume(); reject(new Error("Upgrade rejected: "+response.statusCode));
    });
  });
  return socket;
}

test("WS-05 real socket integration: bound ticket, signed policy, scoped event, replay and disabled app", async () => {
  const {privateKey,publicKey} = crypto.generateKeyPairSync("rsa",{
    modulusLength:2048,
    publicKeyEncoding:{format:"pem",type:"spki"},
    privateKeyEncoding:{format:"pem",type:"pkcs8"},
  });
  let enabled=1,keepLogin=1,revoked=false;
  let eventId=0;
  const events: Record<string,unknown>[]=[];
  // Isolated synthetic SQL adapter tests WSS routing without modifying users' DB.
  const db = {
    execute: async (statement: any) => {
      const sql = typeof statement==="string" ? statement : statement.sql;
      const args = typeof statement==="string" ? [] : statement.args;
      if(sql.includes("SELECT d.id AS device_id")) {
        if(args[0]==="TEST-CI-LICENSE"&&args[1]==="HWID-CI"&&args[2]==="test-app")
          return {rows:[{device_id:"dev-ci",license_id:"lic-ci",app_id:"app-ci",activated_at:1}],rowsAffected:0};
        return {rows:[],rowsAffected:0};
      }
      if(sql.includes("d.status AS device_status")) {
        return {rows: args[0]==="dev-ci"&&args[1]==="lic-ci"&&args[2]==="HWID-CI"&&args[3]==="app-ci"?
          [{device_status:"active",license_status:revoked?"revoked":"active",app_status:"active",
            realtime_websocket_enabled:enabled,device_lease_seconds:7200,last_ping_at:Date.now(),expires_at:null}]:[],rowsAffected:0};
      }
      if(sql.includes("SELECT keep_login_on_network_error"))
        return {rows:[{keep_login_on_network_error:keepLogin}],rowsAffected:0};
      if(sql.includes("MAX(id)"))return {rows:[{version:eventId}],rowsAffected:0};
      if(sql.includes("FROM realtime_events"))return {rows:events.filter(x=>Number(x.id)>Number(args[0])).slice(0,200),rowsAffected:0};
      if(sql.includes("ed25519_private_key"))return {rows:[{ed25519_private_key:privateKey}],rowsAffected:0};
      throw new Error("Unexpected synthetic database statement");
    },
  } as unknown as DatabaseClient;

  const issuer=createRealtimeTickets(db);
  const engine=createEngine({
    path:"/api/realtime",
    authenticate:(req:any)=>issuer.authenticate(req),
    authorizeSubscription:async (identity:any,group:string)=>group==="license:"+identity.licenseId||group==="app:"+identity.appId,
    timeouts:{shutdownDrainMs:1000},
  });
  const publisher=createRealtimeEventPublisher(db,engine.connectionManager);
  await publisher.init();
  engine.register("license.hello",async (ctx:any)=>{
    if(!await validateRealtimeDevice(db,ctx.identity)) {ctx.client.ws.close(4003,"invalid");return;}
    const snap=await publisher.snapshot(ctx.identity);
    await ctx.subscribe("license:"+ctx.identity.licenseId);
    await ctx.subscribe("app:"+ctx.identity.appId);
    ctx.reply(snap);
  });
  const http=createServer((_req,res)=>{res.writeHead(200);res.end("existing HTTP");});
  engine.attach(http);
  engine.start();
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const addr=http.address();
  if(!addr||typeof addr==="string")throw Error("test port missing");
  const url="ws://127.0.0.1:"+addr.port+"/api/realtime";
  let socket:WebSocket|undefined;
  try {
    assert.equal((await issuer.issue({license_key:"TEST-CI-LICENSE",hwid:"HWID-CI",app_name:"other-app"},"ci")).status,403);
    const issued=await issuer.issue({license_key:"TEST-CI-LICENSE",hwid:"HWID-CI",app_name:"test-app"},"ci");
    assert.equal(issued.status,200);
    const ticket=(issued.body as any).ticket;
    socket=await connect(url,ticket);
    const snapPromise=waitForMessage(socket,"license.snapshot");
    socket.send(JSON.stringify({type:"license.hello"}));
    const snap=await snapPromise;
    assert.equal(snap.app_id,"app-ci");
    assert.equal(snap.keep_login_on_network_error,true);
    const {signature,...data}=snap;
    assert.equal(verifySignature(canonicalJson(data),signature,publicKey),true);
    await assert.rejects(connect(url,ticket),/Upgrade rejected: 401/,"replayed token must be denied");
    const eventPromise=waitForMessage(socket,"license.state_changed");
    eventId=1;
    events.push({id:1,event_type:"app.changed",app_id:"app-ci",license_id:null,device_id:null,created_at:Date.now()});
    await publisher.tick();
    const evt=await eventPromise;
    const {signature:eventSig,...eventBody}=evt;
    assert.equal(verifySignature(canonicalJson(eventBody),eventSig,publicKey),true);
    assert.equal(evt.license_id,null);
    assert.equal(evt.app_id,"app-ci");
    keepLogin=0;
    const nextSnap=await publisher.snapshot({appId:"app-ci",licenseId:"lic-ci",deviceId:"dev-ci",hwid:"HWID-CI",authenticatedAt:Date.now()});
    assert.equal(nextSnap.keep_login_on_network_error,false);
    enabled=0;
    assert.equal((await issuer.issue({license_key:"TEST-CI-LICENSE",hwid:"HWID-CI",app_name:"test-app"},"ci")).status,403);
    revoked=true;
    assert.equal(await validateRealtimeDevice(db,{appId:"app-ci",licenseId:"lic-ci",deviceId:"dev-ci",hwid:"HWID-CI"}),false);
    const existing=await fetch("http://127.0.0.1:"+addr.port+"/api/health");
    assert.equal(existing.status,200);
  } finally {
    socket?.terminate();
    publisher.stop();
    await engine.stop();
    await new Promise<void>((resolve,reject)=>http.close(err=>err?reject(err):resolve()));
  }
});
