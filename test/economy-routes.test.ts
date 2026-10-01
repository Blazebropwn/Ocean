import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { hashToken } from "../src/security.js";
import { issueTestGenesis as issueGenesisBatch, TEST_GENESIS_KEY } from "./helpers/genesis-fixture.js";
import { tideBalance } from "../src/tide/ledger.js";

test("economy API enforces sessions, approvals, origin, strict inputs and ownership", async t=>{
  const db=openDatabase(":memory:");
  const app=buildApp({databasePath:":memory:",port:0,host:"127.0.0.1",appOrigin:"http://localhost:3000",manualApprovalEnabled:true,isProduction:false,genesisCodeHmacKey:TEST_GENESIS_KEY},db);t.after(()=>app.close());
  for(const id of ["alice","bob","pending"]) {
    db.prepare("INSERT INTO users (id,email,username,password_hash,approved_at) VALUES (?,?,?,?,?)").run(id,id+"@example.test",id,"hash",id==="pending"?null:new Date().toISOString());
    db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,?)").run(hashToken(id+"-token"),id,new Date(Date.now()+600000).toISOString());
  }
  let codes:Array<{code:string}>=[];issueGenesisBatch(db,c=>{codes=c.filter(v=>v.rewardTide===300)});
  const headers=(id="alice")=>({cookie:`zero_session=${id}-token`,origin:"http://localhost:3000"});
  for(const url of ["/api/tide","/api/tide/ledger","/api/slot"]) assert.equal((await app.inject({url})).statusCode,401);
  for(const url of ["/api/genesis/redeem","/api/slot/spins"]) assert.equal((await app.inject({method:"POST",url,payload:{}})).statusCode,401);
  const redeem={method:"POST" as const,url:"/api/genesis/redeem",payload:{code:codes[0]!.code}};
  assert.equal((await app.inject({...redeem,headers:headers("pending")})).statusCode,403);
  assert.equal((await app.inject({...redeem,headers:{...headers(),origin:"https://attacker.example"}})).statusCode,403);
  assert.equal((await app.inject({...redeem,headers:headers(),payload:{code:codes[0]!.code,userId:"bob"}})).statusCode,400);
  const results=await Promise.all([app.inject({...redeem,headers:headers(),remoteAddress:"192.0.2.1"}),app.inject({...redeem,headers:headers(),remoteAddress:"192.0.2.2"})]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,201]);assert.equal(tideBalance(db,"alice"),300);
  assert.equal((await app.inject({...redeem,headers:headers("bob")})).statusCode,400);
  const key=randomUUID(),spin={method:"POST" as const,url:"/api/slot/spins",headers:headers(),payload:{idempotencyKey:key}};
  for(const extra of [{payout:10000},{bet:0},{stops:[9,13,19]},{userId:"bob"}]) assert.equal((await app.inject({...spin,payload:{...spin.payload,...extra}})).statusCode,400);
  const first=await app.inject(spin),second=await app.inject(spin);
  assert.equal(first.statusCode,201);assert.equal(second.statusCode,200);assert.deepEqual(first.json().spin,second.json().spin);
  assert.equal((await app.inject({...spin,headers:headers("bob")})).statusCode,409);
  assert.equal((await app.inject({url:"/api/tide/ledger",headers:headers("bob")})).json().entries.length,0);
  assert.equal((await app.inject({url:"/api/tide/ledger?userId=alice",headers:headers("bob")})).statusCode,400);
  assert.equal((await app.inject({url:"/api/tide",headers:headers()})).headers["cache-control"],"no-store");
  const ledger=(await app.inject({url:"/api/tide/ledger",headers:headers()})).json().entries;
  assert.equal(ledger.filter((r:{transactionType:string})=>r.transactionType==="SLOT_BET").length,1);
  assert.equal(ledger.reduce((n:number,r:{amount:number})=>n+r.amount,0),tideBalance(db,"alice"));
});
