import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { genesisIdentity, hashCode, issueGenesisBatch, redeemGenesis } from "../src/genesis/service.js";
import { appendTide, tideBalance, tideHistory } from "../src/tide/ledger.js";
import { spinSlot } from "../src/slot/service.js";
import { evaluateStops, REELS } from "../src/slot/math.js";

function user(db: OceanDatabase, id: string) {
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES (?,?,?,?)").run(id, id+"@example.test", id, "not-a-password");
}
function funded(db: OceanDatabase) {
  user(db, "alice"); user(db, "bob");
  let codes: Array<{ genesisNumber: number; code: string }> = [];
  issueGenesisBatch(db, values => { codes = values; });
  redeemGenesis(db, "alice", codes[0]!.code);
  return codes;
}
const loss = () => [0, 0, 0];

test("slot v1 exhaustively matches the stated math over 15,625 outcomes", () => {
  for (const reel of REELS) {
    assert.equal(reel.length, 25);
    assert.deepEqual(Object.fromEntries(["wave","fish","shell","octo","core"].map(s=>[s,reel.filter(v=>v===s).length])), {wave:9,fish:6,shell:5,octo:4,core:1});
  }
  let wins=0,payout=0,jackpots=0;
  for(let a=0;a<25;a++) for(let b=0;b<25;b++) for(let c=0;c<25;c++) {
    const r=evaluateStops([a,b,c]); payout+=r.payout; wins+=Number(r.payout>0); jackpots+=Number(r.payout===10000);
    assert.equal(r.payout>0,r.symbols.every(s=>s===r.symbols[0]));
  }
  assert.equal(payout,148720); assert.equal(wins,1135); assert.equal(jackpots,1);
  for(const stops of [[-1,0,0],[25,0,0],[NaN,0,0],[0,0],[1.5,0,0]]) assert.throws(()=>evaluateStops(stops));
});

test("100 hashed codes are issued once; failed export leaves no batch", t => {
  const db=openDatabase(":memory:");t.after(()=>db.close());
  assert.throws(()=>issueGenesisBatch(db,()=>{throw Error("disk failed")}),/disk failed/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM genesis_codes").pluck().get(),0);
  let codes: Array<{genesisNumber:number;code:string}>=[];
  assert.equal(issueGenesisBatch(db,c=>{codes=c}),100);
  assert.equal(new Set(codes.map(c=>c.code)).size,100);
  assert.deepEqual(codes.map(c=>c.genesisNumber),Array.from({length:100},(_,i)=>i+1));
  assert.equal((db.prepare("SELECT code_hash FROM genesis_codes WHERE genesis_number=1").pluck().get()),hashCode(codes[0]!.code));
  assert.throws(()=>issueGenesisBatch(db,()=>assert.fail("must not export")),/již byly/);
});

test("Genesis is permanent, normalized, single per account and replay-safe after spending", t => {
  const db=openDatabase(":memory:");t.after(()=>db.close());const codes=funded(db);
  assert.equal(redeemGenesis(db,"alice",codes[0]!.code.toLowerCase().replaceAll("-"," ")).replayed,true);
  assert.throws(()=>redeemGenesis(db,"bob",codes[0]!.code),/už byl/);
  assert.throws(()=>redeemGenesis(db,"alice",codes[1]!.code),/už má/);
  assert.throws(()=>redeemGenesis(db,"bob","AAAA-BBBB-CCCC"),/není platný/);
  for(let i=0;i<30;i++) spinSlot(db,"alice",randomUUID(),loss);
  assert.equal(tideBalance(db,"alice"),0);assert.equal(genesisIdentity(db,"alice")!.number,1);
  assert.equal(redeemGenesis(db,"alice",codes[0]!.code).balance,0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM tide_ledger WHERE transaction_type='GENESIS_REDEMPTION'").pluck().get(),1);
  assert.throws(()=>spinSlot(db,"alice",randomUUID(),()=>{assert.fail("RNG must not run");return []}),/10 TIDE/);
});

test("locked spin is replayed without RNG, including after reopening SQLite", t => {
  const dir=mkdtempSync(join(tmpdir(),"ocean-tide-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,"test.db");let db=openDatabase(path);funded(db);
  const key=randomUUID();const first=spinSlot(db,"alice",key,()=>[9,13,19]);
  assert.equal(first.spin.payout,10000);assert.equal(first.balance,10290);
  spinSlot(db,"alice",randomUUID(),loss);db.close();db=openDatabase(path);t.after(()=>db.close());
  const retry=spinSlot(db,"alice",key,()=>{throw Error("must not draw");});
  assert.deepEqual(retry.spin,first.spin);assert.equal(retry.replayed,true);assert.equal(retry.balance,10280);
  assert.equal(db.prepare("SELECT COUNT(*) FROM tide_ledger WHERE reference_id=?").pluck().get(first.spin.spinId),2);
});

test("failed credit rolls back both bet and spin; failed reward leaves code usable", t => {
  const db=openDatabase(":memory:");t.after(()=>db.close());const codes=funded(db);
  db.exec("CREATE TRIGGER fail_win BEFORE INSERT ON tide_ledger WHEN NEW.transaction_type='SLOT_WIN' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  const key=randomUUID();assert.throws(()=>spinSlot(db,"alice",key,()=>[9,13,19]),/disk failure/);
  assert.equal(tideBalance(db,"alice"),300);assert.equal(db.prepare("SELECT COUNT(*) FROM slot_spins").pluck().get(),0);
  db.exec("CREATE TRIGGER fail_reward BEFORE INSERT ON tide_ledger WHEN NEW.transaction_type='GENESIS_REDEMPTION' BEGIN SELECT RAISE(ABORT,'reward failure'); END");
  assert.throws(()=>redeemGenesis(db,"bob",codes[1]!.code),/reward failure/);assert.equal(genesisIdentity(db,"bob"),undefined);
  db.exec("DROP TRIGGER fail_reward; DROP TRIGGER fail_win");
  assert.equal(redeemGenesis(db,"bob",codes[1]!.code).balance,300);
  assert.equal(spinSlot(db,"alice",key,loss).balance,290);
});

test("ledger rejects forged credits, duplicate settlement and rewrites", t => {
  const db=openDatabase(":memory:");t.after(()=>db.close());funded(db);
  const entry={userId:"alice",amount:30,transactionType:"SLOT_WIN" as const,source:"ocean_slot_v1" as const,referenceId:"missing",createdAt:new Date().toISOString()};
  assert.throws(()=>appendTide(db,entry),/TRANSACTION/);
  assert.throws(()=>db.transaction(()=>appendTide(db,entry))(),/INVALID_REFERENCE/);
  db.prepare(`INSERT INTO slot_spins (id,user_id,idempotency_key,game_version,bet,stops_json,symbols_json,payout,balance_before,balance_after,created_at)
    VALUES ('unsettled','bob','fixture-without-bet','ocean_slot_v1',10,'[3,1,1]','["wave","wave","wave"]',30,10,30,?)`).run(entry.createdAt);
  assert.throws(()=>db.transaction(()=>appendTide(db,{...entry,userId:"bob",referenceId:"unsettled"}))(),/BET_REQUIRED/);
  assert.throws(()=>db.transaction(()=>appendTide(db,{...entry,userId:"bob",referenceId:"unsettled",transactionType:"SLOT_BET",amount:-10}))(),/BALANCE_RANGE/);
  const spin=spinSlot(db,"alice",randomUUID(),()=>[9,13,19]).spin;
  assert.throws(()=>db.transaction(()=>appendTide(db,{...entry,referenceId:spin.spinId,amount:10000}))(),/UNIQUE/);
  assert.throws(()=>db.transaction(()=>appendTide(db,{...entry,referenceId:spin.spinId,amount:30}))(),/INVALID_REFERENCE/);
  for(const table of ["genesis_codes","genesis_redemptions","slot_spins","tide_ledger"]) {
    assert.throws(()=>db.exec(`DELETE FROM ${table}`),/IMMUTABLE/);
    assert.throws(()=>db.exec(`UPDATE ${table} SET created_at='changed'`),/IMMUTABLE/);
  }
  assert.equal(tideHistory(db,"bob",Number.MAX_SAFE_INTEGER).entries.length,0);
  const first=tideHistory(db,"alice",Number.MAX_SAFE_INTEGER,2);
  const second=tideHistory(db,"alice",first.nextCursor!,2);
  assert.equal(first.entries.length,2);assert.equal(second.entries.length,1);
});

function worker(path:string, action:string, value:string, userId?:string) {
  return new Promise<{ok:boolean;balance?:number}>( (resolve,reject)=>{
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,["--import","tsx","test/helpers/economy-worker.ts",path,action,value,...(userId?[userId]:[])],{stdio:["ignore","pipe","pipe"],env});
    let out="",err="";child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);child.on("error",reject);
    child.on("close",code=>{if(code!==0)reject(Error(err));else {try{resolve(JSON.parse(out));}catch(e){reject(e);}}});
  });
}

test("separate processes cannot redeem twice or overspend the last bet", async t => {
  const dir=mkdtempSync(join(tmpdir(),"ocean-tide-race-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,"test.db"),db=openDatabase(path);t.after(()=>db.close());const codes=funded(db);
  const redeemed=await Promise.all([worker(path,"redeem",codes[1]!.code),worker(path,"redeem",codes[1]!.code)]);
  assert.ok(redeemed.every(r=>r.ok));assert.equal(tideBalance(db,"bob"),300);
  const key=randomUUID();const replays=await Promise.all([worker(path,"spin",key),worker(path,"spin",key)]);
  assert.ok(replays.every(r=>r.ok));assert.equal(tideBalance(db,"alice"),290);
  for(let i=0;i<28;i++) spinSlot(db,"alice",randomUUID(),loss);
  const last=await Promise.all([worker(path,"spin",randomUUID()),worker(path,"spin",randomUUID())]);
  assert.equal(last.filter(r=>r.ok).length,1);assert.equal(tideBalance(db,"alice"),0);
});

test("two accounts racing for one Genesis code produce one identity and one reward", async t => {
  const dir=mkdtempSync(join(tmpdir(),"ocean-genesis-race-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,"test.db"),db=openDatabase(path);t.after(()=>db.close());const codes=funded(db);user(db,"charlie");
  const results=await Promise.all([worker(path,"redeem",codes[1]!.code,"bob"),worker(path,"redeem",codes[1]!.code,"charlie")]);
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(tideBalance(db,"bob")+tideBalance(db,"charlie"),300);
  assert.equal(db.prepare("SELECT COUNT(*) FROM genesis_redemptions WHERE genesis_number=2").pluck().get(),1);
});
