import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { hashToken } from "../src/security.js";
import { SolanaPaperEngine } from "../src/solana/engine.js";
import { SolanaPaperAutomation } from "../src/solana/automation.js";
import { SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT, type SolanaMarketProvider, type SolanaQuote } from "../src/solana/types.js";

const OWNER="usr_automation_pilot";
const MINT="So11111111111111111111111111111111111111112";
const START=Date.parse("2026-11-04T12:00:00Z");
function user(db: OceanDatabase,id=OWNER) {
  db.prepare("INSERT INTO users(id,email,username,password_hash,approved_at,email_verified_at) VALUES(?,?,?,'unused',datetime('now'),datetime('now'))").run(id,`${id}@example.invalid`,id);
  db.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(hashToken(`session-${id}`),id);
  return `zero_session=session-${id}`;
}
function config(): Config { return {port:0,host:"127.0.0.1",databasePath:":memory:",appOrigin:"http://localhost:3000",isProduction:false,manualApprovalEnabled:true,solanaPilotUserId:OWNER}; }
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve}; }
function market(now:()=>number): SolanaMarketProvider {
  const at=()=>new Date(now()).toISOString();
  return {
    async scan(){return [{mint:MINT,poolAddress:SOLANA_TOKEN_PROGRAM,symbol:"PILOT",name:"Fixture",decimals:9,poolCreatedAt:new Date(now()-600_000).toISOString(),observedAt:at(),liquidityUsd:100_000,volume5mUsd:2_000,evidence:{fixture:true}}];},
    async risk(mint){return {mint,observedAt:at(),mintAuthorityRevoked:true,freezeAuthorityRevoked:true,tokenProgram:SOLANA_TOKEN_PROGRAM,topHolderPct:10,liquidityLockedPct:99,risks:[],evidence:{fixture:true}};},
    async quote(inputMint,outputMint,inAmount):Promise<SolanaQuote>{const outAmount=inputMint===SOLANA_USDC_MINT?"1000000000":"4900000";return {inputMint,outputMint,inAmount,outAmount,minOutAmount:outAmount,quotedAt:at(),expiresAt:null,priceImpactBps:10,feeBps:10,feeMint:inputMint,route:"fixture",evidence:{signatureFeeLamports:5000,prioritizationFeeLamports:0,rentFeeLamports:0}};},
  };
}

test("automation is opt-in, repeats only when due, persists intent, and stops future cycles on pause",async()=>{
  let now=START,scans=0;const db=openDatabase(":memory:");user(db);const cfg=config();const provider={...market(()=>now),async scan(){scans++;return [];}};
  const engine=new SolanaPaperEngine(db,provider,()=>now);
  let auto=new SolanaPaperAutomation(engine,cfg,{now:()=>now,schedulingEnabled:false});
  auto.start();await auto.tick();assert.equal(scans,0);
  auto.setEnabled(OWNER,true);await auto.tick();assert.equal(scans,1);
  assert.equal(auto.snapshot(OWNER).automation.nextRunAt,new Date(START+60_000).toISOString());
  now+=59_000;await auto.tick();assert.equal(scans,1);
  await auto.close();auto=new SolanaPaperAutomation(new SolanaPaperEngine(db,provider,()=>now),cfg,{now:()=>now,schedulingEnabled:false});auto.start();
  now+=1000;await auto.tick();assert.equal(scans,2);
  assert.deepEqual(auto.snapshot(OWNER).equityHistory.map(point=>point.valueUsdc),[100,100]);
  auto.setEnabled(OWNER,false);now+=60_000;await auto.tick();assert.equal(scans,2);assert.equal(auto.snapshot(OWNER).automation.status,"paused");
  await auto.close();db.close();
});

test("live state reports a real pending risk call and bounded candidates instead of invented work",async()=>{
  const db=openDatabase(":memory:");user(db);const pending=deferred(),entered=deferred();const f=market(()=>START);
  const engine=new SolanaPaperEngine(db,{...f,async risk(mint){entered.resolve();await pending.promise;return f.risk(mint);}},()=>START);
  const auto=new SolanaPaperAutomation(engine,config(),{now:()=>START,schedulingEnabled:false});auto.setEnabled(OWNER,true);
  const job=auto.tick();await entered.promise;
  const live=auto.snapshot(OWNER,true);assert.equal(live.runtime.running,true);assert.equal(live.runtime.stage,"rug-check");assert.equal(live.candidates[0]!.status,"checking");assert.equal(live.counters.riskChecked,1);assert.equal(live.counters.trades,0);
  assert(live.decisions.every(event=>Object.keys(event.evidence).length===0));
  pending.resolve();await job;const done=auto.snapshot(OWNER);assert.equal(done.runtime.running,false);assert.equal(done.positions.length,1);assert.equal(done.counters.trades,1);assert.equal(done.equityHistory[0]!.valueUsdc,99.831);
  await auto.close();db.close();
});

test("pause then restart during a reverse quote invalidates the old automatic entry permit",async()=>{
  const db=openDatabase(":memory:");user(db);const pending=deferred(),entered=deferred();const f=market(()=>START);
  const engine=new SolanaPaperEngine(db,{...f,async quote(input,output,amount){if(input===MINT){entered.resolve();await pending.promise;}return f.quote(input,output,amount);}},()=>START);
  const auto=new SolanaPaperAutomation(engine,config(),{now:()=>START,schedulingEnabled:false});auto.setEnabled(OWNER,true);
  const job=auto.tick();await entered.promise;auto.setEnabled(OWNER,false);auto.setEnabled(OWNER,true);pending.resolve();await job;
  const state=auto.snapshot(OWNER);assert.equal(state.cashUsdc,100);assert.equal(state.positions.length,0);assert.equal(state.counters.trades,0);assert(state.decisions.some(event=>/pozastaven/.test(event.reason)));
  await auto.close();db.close();
});

test("revocation during provider await disables durable intent and prevents any trade",async()=>{
  for(const action of ["suspend","delete"]){
    const db=openDatabase(":memory:");user(db);const f=market(()=>START);
    const engine=new SolanaPaperEngine(db,{...f,async risk(mint){if(action==="delete")db.prepare("DELETE FROM users WHERE id=?").run(OWNER);else db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(OWNER);return f.risk(mint);}},()=>START);
    const auto=new SolanaPaperAutomation(engine,config(),{now:()=>START,schedulingEnabled:false});auto.setEnabled(OWNER,true);await auto.tick();
    assert.equal(db.prepare("SELECT count(*) FROM solana_paper_trades").pluck().get(),0);
    assert.equal(db.prepare("SELECT enabled FROM solana_paper_automation WHERE user_id=?").pluck().get(OWNER),action==="delete"?undefined:0);
    await auto.close();db.close();
  }
});

test("provider outage backs off without hammering and successful recovery clears the error",async()=>{
  let now=START,fail=true,calls=0;const db=openDatabase(":memory:");user(db);const f=market(()=>now);
  const engine=new SolanaPaperEngine(db,{...f,async scan(){calls++;if(fail)throw new Error("Tržní feed není dostupný.");return [];}},()=>now);
  const auto=new SolanaPaperAutomation(engine,config(),{now:()=>now,schedulingEnabled:false});auto.setEnabled(OWNER,true);await auto.tick();
  assert.equal(calls,1);assert.equal(auto.snapshot(OWNER).automation.status,"error");
  assert.equal(auto.snapshot(OWNER).automation.nextRunAt,new Date(START+120_000).toISOString());
  now+=60_000;await auto.tick();assert.equal(calls,1);
  fail=false;now+=60_000;await auto.tick();assert.equal(calls,2);assert.equal(auto.snapshot(OWNER).automation.lastError,null);
  await auto.close();db.close();
});

test("closing the scheduler drains a pending cycle and disallows its new entry",async()=>{
  const db=openDatabase(":memory:");user(db);const pending=deferred(),entered=deferred();const f=market(()=>START);
  const engine=new SolanaPaperEngine(db,{...f,async risk(mint){entered.resolve();await pending.promise;return f.risk(mint);}},()=>START);
  const auto=new SolanaPaperAutomation(engine,config(),{now:()=>START,schedulingEnabled:false});auto.setEnabled(OWNER,true);const job=auto.tick();await entered.promise;
  let closed=false;const closing=auto.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(db.open,true);
  pending.resolve();await job;await closing;assert.equal(closed,true);assert.equal(engine.snapshot(OWNER).positions.length,0);assert.equal(engine.snapshot(OWNER).cashUsdc,100);db.close();
});

test("automation API keeps owner gating, rejects LIVE parameters and returns compact actual activity",async()=>{
  const db=openDatabase(":memory:");const cookie=user(db);const other=user(db,"usr_other");
  const app=buildApp(config(),db,{solanaMarketProvider:{...market(()=>START),async scan(){return [];}},solanaAutomation:{now:()=>START,schedulingEnabled:false}});
  assert.equal((await app.inject({method:"POST",url:"/api/solana/automation",payload:{enabled:true}})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/api/solana/automation",headers:{cookie:other},payload:{enabled:true}})).statusCode,404);
  for(const payload of [{mode:"LIVE",enabled:true},{enabled:"true"},{},null,[]])assert.equal((await app.inject({method:"POST",url:"/api/solana/automation",headers:{cookie,"content-type":"application/json"},payload:JSON.stringify(payload)})).statusCode,400);
  const started=await app.inject({method:"POST",url:"/api/solana/automation",headers:{cookie},payload:{enabled:true}});assert.equal(started.json().automation.enabled,true);
  assert.equal((await app.inject({method:"POST",url:"/api/solana/cycle",headers:{cookie}})).statusCode,200);
  const live=(await app.inject({method:"GET",url:"/api/solana/live",headers:{cookie}})).json();assert.equal(live.mode,"PAPER");assert.equal(live.counters.cycles,1);assert(live.decisions.every((event:{evidence:object})=>Object.keys(event.evidence).length===0));
  assert.equal((await app.inject({method:"POST",url:"/api/solana/automation",headers:{cookie},payload:{enabled:false}})).json().automation.enabled,false);
  await app.close();
});

test("lost sell quotes record an unknown equity point without rewriting the prior known point",async()=>{
  let now=START,fail=false;const db=openDatabase(":memory:");user(db);const f=market(()=>now);
  const engine=new SolanaPaperEngine(db,{...f,async quote(input,output,amount){if(fail)throw new Error("Prodejní kotace chybí.");return f.quote(input,output,amount);}},()=>now);
  await engine.cycle(OWNER,()=>true);now+=60_000;fail=true;await engine.cycle(OWNER,()=>true);
  assert.deepEqual(engine.snapshot(OWNER).equityHistory.map(point=>point.valueUsdc),[99.831,null]);assert.equal(engine.snapshot(OWNER).equityUsdc,null);db.close();
});
