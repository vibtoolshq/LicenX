// WS-05 isolated, bounded, synthetic-only realtime TLS and resource test.
// Never run against customer data or a non-CI VPS.
import fs from "node:fs";
import crypto from "node:crypto";
import {performance} from "node:perf_hooks";
import pg from "pg";
import WebSocket from "ws";

if (process.env.WS05_CI_RUN !== "1" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("WS-05 fixture is limited to the disposable GitHub Actions runner");
}
const mode=process.env.WS05_MODE;
const total=Number(process.env.WS05_CLIENTS ?? "100");
if(!Number.isInteger(total)||total<1||total>1000)throw new Error("WS05_CLIENTS must be 1..1000");
const appId="ws05-ci-app";
const appSlug="ws05-ci-app";
const serial=n=>String(n).padStart(6,"0");
const lic=n=>"ws05-lic-"+serial(n);
const dev=n=>"ws05-dev-"+serial(n);
const key=n=>"WS05-KEY-"+serial(n);
const hwid=n=>"WS05-HWID-"+serial(n);
const httpBase=mode==="proxy"?"https://localhost":"http://127.0.0.1:3000";
const wsUrl=mode==="proxy"?"wss://localhost/api/realtime":"ws://127.0.0.1:3000/api/realtime";
const publicKeyPath=process.env.WS05_PUBLIC_KEY_FILE || "/tmp/ws05-public-key.pem";
const ca=process.env.WS05_CA_FILE?fs.readFileSync(process.env.WS05_CA_FILE):undefined;
const tls=ca?{ca,servername:"localhost"}:{};
const timeoutMs=12_000;
const now=()=>Date.now();

function reportPercentile(values, pct) {
  const sorted=[...values].sort((a,b)=>a-b);
  return Math.round((sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*pct/100)-1)]||0)*10)/10;
}
function procMetrics(){
  try {
    const status=fs.readFileSync("/proc/1/status","utf8");
    const rss=Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1]??0);
    const fds=fs.readdirSync("/proc/1/fd").length;
    const raw=fs.readFileSync("/proc/1/stat","utf8").split(") ")[1].split(" ");
    const cpuTicks=Number(raw[11])+Number(raw[12]);
    return {serverRssKiB:rss,serverFileDescriptors:fds,serverCpuTicks:cpuTicks};
  }catch{return null;}
}
async function requestTicket(n,application=appSlug) {
  const response=await fetch(httpBase+"/api/v1/realtime/ticket",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({license_key:key(n),hwid:hwid(n),app_name:application}),
    signal:AbortSignal.timeout(timeoutMs),
    ...(ca?{dispatcher:undefined}:{}),
  });
  if(!response.ok)throw new Error("ticket failed "+response.status);
  const body=await response.json();
  if(typeof body.ticket!=="string"||body.ticket.length<40)throw new Error("Invalid ticket response");
  return body.ticket;
}
function signed(payload,publicKey) {
  const {signature,...data}=payload;
  if(!signature || typeof signature!=="string")return false;
  const canonical=JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(x=>[x,data[x]])));
  return crypto.verify("RSA-SHA256",Buffer.from(canonical),publicKey,Buffer.from(signature,"base64"));
}
async function socketSession(n,publicKey) {
  const started=performance.now();
  const ticket=await requestTicket(n);
  const ws=new WebSocket(wsUrl,{headers:{Authorization:"Bearer "+ticket},handshakeTimeout:timeoutMs,...tls});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>done(new Error("WS-05 auth/snapshot timeout")),timeoutMs);
    let settled=false;
    function done(err,result) {
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(err){try{ws.terminate();}catch{}reject(err);}
      else resolve(result);
    }
    ws.on("error",err=>done(new Error("WS handshake/connection error")));
    ws.on("unexpected-response",(_req,res)=>{res.resume();done(new Error("WS rejected "+res.statusCode));});
    ws.on("open",()=>ws.send(JSON.stringify({type:"license.hello"})));
    ws.on("message",data=>{
      try {
        const message=JSON.parse(data.toString());
        if(message.type==="error")return done(new Error("License hello denied"));
        if(message.type!=="license.snapshot")return;
        if(!signed(message,publicKey)||message.app_id!==appId||
           message.device_id!==dev(n)||message.license_id!==lic(n)||
           message.keep_login_on_network_error!==true) {
          return done(new Error("WS snapshot identity/signature/policy mismatch"));
        }
        done(null,{ws,latencyMs:performance.now()-started});
      }catch{done(new Error("Malformed WSS snapshot"));}
    });
  });
}
async function stage(){
  if(!process.env.DATABASE_URL?.includes("/licenx_ci?")||!process.env.DATABASE_URL.includes("@postgres:5432/")){
    throw new Error("Refusing fixture writes outside disposable Docker CI database");
  }
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try{
    const stamp=now();
    await client.query(`INSERT INTO apps
      (id,app_slug,display_name,status,app_secret,realtime_websocket_enabled,keep_login_on_network_error,created_at,updated_at)
      VALUES($1,$1,'WS05 isolated test','active','CI_ONLY',1,1,$2,$2)
      ON CONFLICT(id) DO UPDATE SET realtime_websocket_enabled=1, keep_login_on_network_error=1,status='active'`,[appId,stamp]);
    // One valid license and bound device per synthetic client; no shared HWIDs.
    await client.query(`INSERT INTO licenses
      (id,key,status,app_id,device_limit,validity_type,validity_value,activated_at,created_at)
      SELECT 'ws05-lic-'||lpad(i::text,6,'0'),'WS05-KEY-'||lpad(i::text,6,'0'),
        'active',$1,1,'lifetime',0,$2,$2 FROM generate_series(1,$3) i
      ON CONFLICT(id) DO UPDATE SET status='active',activated_at=EXCLUDED.activated_at`,[appId,stamp,total]);
    await client.query(`INSERT INTO devices(id,license_id,hwid,first_bound_at,last_ping_at,status)
      SELECT 'ws05-dev-'||lpad(i::text,6,'0'),
        'ws05-lic-'||lpad(i::text,6,'0'), 'WS05-HWID-'||lpad(i::text,6,'0'),
        $1,$1,'active' FROM generate_series(1,$2) i
      ON CONFLICT(id) DO UPDATE SET status='active',last_ping_at=EXCLUDED.last_ping_at`,[stamp,total]);
    const res=await client.query("SELECT ed25519_public_key FROM admin_config LIMIT 1");
    if(!res.rows[0]?.ed25519_public_key)throw new Error("Admin signing key missing");
    fs.writeFileSync("/tmp/ws05-public-key.pem",res.rows[0].ed25519_public_key,{mode:0o600});
    console.log("WS05_STAGE synthetic_clients="+total+" isolated_db=licenx_ci policy=ON transport=CI_ONLY");
  }finally{await client.end();}
}
async function runLoad(){
  const publicKey=fs.readFileSync(publicKeyPath,"utf8");
  const count=mode==="proxy"?1:total;
  const before=procMetrics();
  const latency=[],sockets=[],errors=[];
  const begin=performance.now();
  let next=1;
  async function worker(){
    while(next<=count){
      const id=next++;
      try{
        const r=await socketSession(id,publicKey);
        sockets.push(r.ws);
        latency.push(r.latencyMs);
      }catch(e){errors.push(String(e?.message||"unknown").slice(0,80));}
    }
  }
  try{
    await Promise.all(Array.from({length:Math.min(count,12)},worker));
    if(errors.length||sockets.length!==count)
      throw new Error("WS-05 clients failed "+errors.length+"/"+count+" first="+(errors[0]||"missing"));
    const atCapacity=procMetrics();
    const elapsedMs=Math.round(performance.now()-begin);
    console.log(JSON.stringify({
      mode,concurrentAuthenticated:sockets.length,failed:errors.length,elapsedMs,
      p95HandshakeMs:reportPercentile(latency,95),
      p99HandshakeMs:reportPercentile(latency,99),
      serverBefore:before,serverAtCapacity:atCapacity,
      serverRssGrowthKiB: before&&atCapacity?atCapacity.serverRssKiB-before.serverRssKiB:null,
      serverFdGrowth: before&&atCapacity?atCapacity.serverFileDescriptors-before.serverFileDescriptors:null,
      serverCpuTickGrowth:before&&atCapacity?atCapacity.serverCpuTicks-before.serverCpuTicks:null,
      metricsNote: mode==="proxy"?"runner /proc is NOT app metrics":"app /proc/1 snapshot; not sustained load",
    }));
    if(mode==="proxy"){
      // Prove replay and cross-App denial through the actual localhost Caddy WSS.
      const bad=await fetch(httpBase+"/api/v1/realtime/ticket",{method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({license_key:key(1),hwid:hwid(1),app_name:"unrelated-app"}),
        signal:AbortSignal.timeout(timeoutMs)});
      if(bad.status!==403)throw new Error("Cross-App ticket was accepted");
      const replay=await requestTicket(1);
      const first=new WebSocket(wsUrl,{headers:{Authorization:"Bearer "+replay},handshakeTimeout:timeoutMs,...tls});
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("replay first connection timeout")),timeoutMs);
        first.once("open",()=>{clearTimeout(timer);resolve();});
        first.once("error",reject);
      });
      try{first.close();}catch{}
      const second=new WebSocket(wsUrl,{headers:{Authorization:"Bearer "+replay},handshakeTimeout:timeoutMs,...tls});
      const denied=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("token replay denial timed out")),timeoutMs);
        second.once("unexpected-response",(_req,res)=>{clearTimeout(timer);res.resume();resolve(res.statusCode);});
        second.once("open",()=>{clearTimeout(timer);reject(new Error("Replay token accepted"));});
        second.once("error",()=>{});
      });
      if(denied!==401)throw new Error("Replayed ticket not rejected 401");
      console.log("WS05_TLS_CA_TRUSTED WSS_CADDY=PASS replay=401 cross_app=403");
    }
  }finally{
    for(const socket of sockets)try{socket.terminate();}catch{}
  }
}
async function rollbackProbe(){
  const ticket=await fetch(httpBase+"/api/v1/realtime/ticket",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({license_key:key(1),hwid:hwid(1),app_name:appSlug}),
    signal:AbortSignal.timeout(timeoutMs),
  });
  if(ticket.status!==404)throw new Error("HTTP-only rollback still allows WSS ticket issuance");
  const nonce=crypto.randomBytes(32).toString("base64url");
  const ping=await fetch(httpBase+"/api/v1/license/ping",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({license_key:key(1),hwid:hwid(1),nonce}),
    signal:AbortSignal.timeout(timeoutMs),
  });
  const data=await ping.json();
  if(ping.status!==200||data.valid!==true||data.nonce!==nonce)
    throw new Error("Existing signed HTTP heartbeat broke under WS rollback");
  const publicKey=fs.readFileSync(publicKeyPath,"utf8");
  if(!signed(data,publicKey)){
    const {public_key,...payload}=data;
    if(!signed(payload,publicKey))throw new Error("Rollback HTTP signature invalid");
  }
  console.log("WS05_HTTP_ONLY_ROLLBACK=PASS ticket=404 signed_heartbeat=200");
}
if(mode==="stage")await stage();
else if(mode==="direct"||mode==="proxy")await runLoad();
else if(mode==="rollback")await rollbackProbe();
else throw new Error("WS05_MODE must be stage, direct, proxy or rollback");
