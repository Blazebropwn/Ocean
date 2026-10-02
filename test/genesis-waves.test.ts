import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { databaseMigrations } from "../src/database/migrations/index.js";
import { GENESIS_WAVE, REWARD_DISTRIBUTION, hashCode, issueGenesisBatch, redeemGenesis, type GenesisCodeExport } from "../src/genesis/service.js";
import { genesisOverview } from "../src/genesis/admin.js";
import { spinSlot } from "../src/slot/service.js";
import { appendTide, tideBalance } from "../src/tide/ledger.js";
import { TEST_GENESIS_KEY, TEST_GENESIS_ADMIN, genesisAdmin, issueTestGenesis } from "./helpers/genesis-fixture.js";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/security.js";

function member(db: OceanDatabase, id: string, role="member", approved=true) {
  db.prepare("INSERT INTO users (id,email,username,password_hash,role,approved_at) VALUES (?,?,?,?,?,?)").run(id,id+"@example.test",id,"hash",role,approved?new Date().toISOString():null);
  db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,?)").run(hashToken(id+"-token"),id,new Date(Date.now()+600000).toISOString());
}
function issued(db: OceanDatabase) { let codes: GenesisCodeExport[]=[];issueTestGenesis(db,values=>{codes=values});return codes; }
const options={adminUserId:TEST_GENESIS_ADMIN,hmacKey:TEST_GENESIS_KEY};

test("Genesis #1 reserves exactly 75,000 across 100 opaque HMAC codes and credits the owner exactly once", t=>{
  const db=openDatabase(":memory:");t.after(()=>db.close());const codes=issued(db);
  assert.equal(codes.length,100);assert.equal(new Set(codes.map(c=>c.code)).size,100);
  assert.deepEqual(Object.fromEntries(Object.keys(REWARD_DISTRIBUTION).map(reward=>[reward,codes.filter(c=>c.rewardTide===Number(reward)).length])),REWARD_DISTRIBUTION);
  assert.equal(codes.reduce((sum,c)=>sum+c.rewardTide,0),75000);
  for(const c of codes) {assert.match(c.code,/^OCN-(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/);assert.equal(c.wave,GENESIS_WAVE);}
  assert.equal(tideBalance(db,TEST_GENESIS_ADMIN),25000);
  assert.equal(db.prepare("SELECT SUM(amount) FROM tide_ledger").pluck().get(),25000);
  assert.equal(db.prepare("SELECT COUNT(*) FROM genesis_redemptions").pluck().get(),0);
  const wave=genesisOverview(db).waves[0]!;
  assert.equal(wave.totalSupply,100000);assert.equal(wave.codeAllocation,75000);assert.equal(wave.adminAllocation,25000);assert.equal(wave.unclaimedAmount,75000);assert.equal(wave.accountingValid,true);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>;
  const dump=tables.map(({name})=>JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
  for(const c of codes) assert.equal(dump.includes(c.code),false);
  assert.equal(dump.includes(TEST_GENESIS_KEY),false);
  assert.equal(db.prepare("SELECT code_hash FROM genesis_codes WHERE genesis_number=1").pluck().get(),hashCode(codes[0]!.code,TEST_GENESIS_KEY));
  assert.throws(()=>issueGenesisBatch(db,options,()=>assert.fail("no second export")),/již byly/);
  assert.equal(tideBalance(db,TEST_GENESIS_ADMIN),25000);
  assert.throws(()=>db.exec("UPDATE genesis_waves SET total_supply=200000"),/IMMUTABLE/);
  assert.throws(()=>db.exec("DELETE FROM genesis_waves"),/IMMUTABLE/);
  assert.throws(()=>db.prepare("INSERT INTO genesis_codes VALUES ('extra',?,101,?,'hmac_sha256_v1',300,datetime('now'))").run(GENESIS_WAVE,"e".repeat(64)),/WAVE_CLOSED/);
  assert.throws(()=>db.transaction(()=>appendTide(db,{userId:TEST_GENESIS_ADMIN,amount:25000,transactionType:"GENESIS_ADMIN_ALLOCATION",source:"genesis_admin",referenceId:GENESIS_WAVE,createdAt:new Date().toISOString()}))(),/INVALID_REFERENCE/);
});

test("every reward tier settles its real value; replay and invalid claims do not change supply",t=>{
  const db=openDatabase(":memory:");t.after(()=>db.close());const codes=issued(db);let total=0;
  for(const reward of Object.keys(REWARD_DISTRIBUTION).map(Number)) {
    const c=codes.find(c=>c.rewardTide===reward)!,id=`user_${reward}`;member(db,id);
    const result=redeemGenesis(db,id,' '+c.code.toLowerCase().replaceAll('-',' ')+' ',TEST_GENESIS_KEY);
    assert.equal(result.reward,reward);assert.equal(result.balance,reward);total+=reward;
    const retry=redeemGenesis(db,id,c.code,TEST_GENESIS_KEY);assert.equal(retry.replayed,true);assert.equal(retry.balance,reward);
    const wave=genesisOverview(db).waves[0]!;assert.equal(wave.redeemedAmount,total);assert.equal(wave.unclaimedAmount,75000-total);assert.equal(wave.accountingValid,true);
  }
  member(db,"outsider");const used=codes.find(c=>c.rewardTide===10000)!;
  assert.throws(()=>redeemGenesis(db,"outsider",used.code,TEST_GENESIS_KEY),/Invalid code/);
  assert.throws(()=>redeemGenesis(db,"outsider","OCN-AAAAA-AAAAA-AAAAA-AAAAA",TEST_GENESIS_KEY),/Invalid code/);
  assert.throws(()=>redeemGenesis(db,"outsider",codes[0]!.code,"cd".repeat(32)),/není dostupná/);
  assert.equal(tideBalance(db,"outsider"),0);
  const overview=genesisOverview(db);assert.equal(overview.codes.length,100);assert.equal(JSON.stringify(overview).includes('code_hash'),false);assert.equal(JSON.stringify(overview).includes('digest_key_id'),false);
  for(const c of codes)assert.equal(JSON.stringify(overview).includes(c.code),false);
});

test("failed admin credit, invalid owner and export failure roll the entire issuance back",t=>{
  const db=openDatabase(":memory:");t.after(()=>db.close());genesisAdmin(db);member(db,"member");
  assert.throws(()=>issueGenesisBatch(db,{...options,adminUserId:"member"},()=>assert.fail()),/vlastníka/);
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON tide_ledger WHEN NEW.source='genesis_admin' BEGIN SELECT RAISE(ABORT,'allocation failure'); END");
  assert.throws(()=>issueGenesisBatch(db,options,()=>assert.fail()),/allocation failure/);db.exec("DROP TRIGGER fail_admin");
  assert.throws(()=>issueGenesisBatch(db,options,()=>{throw Error('export failure')}),/export failure/);
  for(const table of ['genesis_waves','genesis_codes','genesis_redemptions','tide_ledger','admin_audit_log'])assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),0);
  assert.equal(issueGenesisBatch(db,options,()=>{}),100);
});

test("legacy migration preserves balances, identities, ledger sequence and still-valid old codes",t=>{
  const db=new Database(":memory:");t.after(()=>db.close());db.pragma("foreign_keys=ON");migrateDatabase(db,databaseMigrations.slice(0,5));
  member(db,"old_user");member(db,"new_user");
  for(const [n,code]of [[1,'AAAA-BBBB-CCCC'],[2,'DDDD-EEEE-FFFF']] as const)db.prepare("INSERT INTO genesis_codes VALUES (?,?,?)").run(n,hashCode(code),'2026-09-29T00:00:00Z');
  db.prepare("INSERT INTO genesis_redemptions VALUES ('old_redemption','old_user',1,'2026-09-29T01:00:00Z')").run();
  db.prepare("INSERT INTO tide_ledger (id,user_id,amount,transaction_type,source,reference_id,created_at) VALUES ('old_ledger','old_user',300,'GENESIS_REDEMPTION','genesis','old_redemption','2026-09-29T01:00:00Z')").run();
  const oldSpin=spinSlot(db,"old_user","legacy-spin-key-123456",()=>[0,0,0]);
  const before=db.prepare("SELECT * FROM tide_ledger").all();migrateDatabase(db,databaseMigrations);
  assert.deepEqual(db.prepare("SELECT * FROM tide_ledger").all(),before);assert.equal(tideBalance(db,"old_user"),290);assert.deepEqual(db.pragma('foreign_key_check'),[]);
  assert.equal(redeemGenesis(db,"old_user","AAAA-BBBB-CCCC").replayed,true);
  assert.deepEqual(spinSlot(db,"old_user","legacy-spin-key-123456",()=>{throw Error("must not draw")}).spin,oldSpin.spin);
  assert.equal(redeemGenesis(db,"new_user","DDDD-EEEE-FFFF").reward,300);
  const wave=genesisOverview(db).waves[0]!;assert.equal(wave.id,'LEGACY_300');assert.equal(wave.accountingValid,true);
  genesisAdmin(db);assert.throws(()=>issueGenesisBatch(db,options,()=>assert.fail()),/původní emisi/);
});

test("future promo waves use the same claim and ledger without replacing Genesis identity",t=>{
  const db=openDatabase(":memory:");t.after(()=>db.close());const codes=issued(db);member(db,'event_user');
  const genesis=redeemGenesis(db,'event_user',codes[0]!.code,TEST_GENESIS_KEY).genesis;
  const code='OCN-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
  db.transaction(()=>{
    db.prepare(`INSERT INTO genesis_waves VALUES ('EVENT_001','promo','draft',1,500,0,500,NULL,'{"500":1}',NULL,datetime('now'))`).run();
    db.prepare("INSERT INTO genesis_codes VALUES ('event-code','EVENT_001',1,?,'hmac_sha256_v1',500,datetime('now'))").run(hashCode(code,TEST_GENESIS_KEY));
    db.exec("UPDATE genesis_waves SET status='issued' WHERE id='EVENT_001'");
  })();
  const result=redeemGenesis(db,'event_user',code,TEST_GENESIS_KEY);assert.deepEqual(result.genesis,genesis);assert.equal(result.reward,500);assert.equal(result.balance,codes[0]!.rewardTide+500);
  assert.equal(genesisOverview(db,'EVENT_001').waves.find(w=>w.id==='EVENT_001')!.accountingValid,true);
});

test("owner-only overview exposes metadata, and rate limits apply to user across IPs and IP across users",async t=>{
  const db=openDatabase(":memory:"),codes=issued(db);member(db,'pending_owner','owner',false);
  for(let i=0;i<12;i++)member(db,`member_${i}`);
  db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,?)").run(hashToken(TEST_GENESIS_ADMIN+'-token'),TEST_GENESIS_ADMIN,new Date(Date.now()+600000).toISOString());
  const app=buildApp({databasePath:':memory:',port:0,host:'127.0.0.1',appOrigin:'http://localhost:3000',isProduction:false,manualApprovalEnabled:true,genesisCodeHmacKey:TEST_GENESIS_KEY},db);t.after(()=>app.close());
  const headers=(id:string)=>({cookie:`zero_session=${id}-token`});
  assert.equal((await app.inject({url:'/api/admin/genesis'})).statusCode,401);
  for(const id of ['member_0','pending_owner'])assert.equal((await app.inject({url:'/api/admin/genesis',headers:headers(id)})).statusCode,403);
  const overview=await app.inject({url:'/api/admin/genesis',headers:headers(TEST_GENESIS_ADMIN)});assert.equal(overview.statusCode,200);assert.equal(overview.headers['cache-control'],'no-store');assert.equal(overview.json().codes.length,100);
  assert.equal(overview.body.includes('code_hash'),false);for(const c of codes)assert.equal(overview.body.includes(c.code),false);
  const request={method:'POST' as const,url:'/api/genesis/redeem',payload:{code:'OCN-AAAAA-AAAAA-AAAAA-AAAAA'}};
  for(let i=0;i<11;i++) {
    const response=await app.inject({...request,headers:headers('member_0'),remoteAddress:`198.51.100.${i+1}`});assert.equal(response.statusCode,i<10?400:429);
  }
  for(let i=1;i<12;i++) {
    const response=await app.inject({...request,headers:{...headers(`member_${i}`),'x-forwarded-for':`203.0.113.${i}`},remoteAddress:'192.0.2.1'});assert.equal(response.statusCode,i<=10?400:429);
  }
  const valid=await app.inject({...request,headers:headers('member_1'),remoteAddress:'192.0.2.2',payload:{code:codes[0]!.code}});assert.equal(valid.statusCode,201);
  const used=await app.inject({...request,headers:headers('member_2'),remoteAddress:'192.0.2.3',payload:{code:codes[0]!.code}});
  const invalid=await app.inject({...request,headers:headers('member_2'),remoteAddress:'192.0.2.3'});assert.equal(used.statusCode,invalid.statusCode);assert.deepEqual(used.json(),invalid.json());
});

function run(args:string[],env:NodeJS.ProcessEnv={...process.env}) {
  delete env.NODE_TEST_CONTEXT;
  return new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
}

test("two issuers racing cannot create a second supply or administrator allocation",async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ocean-wave-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'db.sqlite'),db=openDatabase(file);t.after(()=>db.close());genesisAdmin(db);
  const results=await Promise.all([run(['--import','tsx','test/helpers/economy-worker.ts',file,'issue','unused']),run(['--import','tsx','test/helpers/economy-worker.ts',file,'issue','unused'])]);
  assert.ok(results.every(r=>r.code===0),JSON.stringify(results));assert.equal(results.filter(r=>JSON.parse(r.out).ok).length,1);
  assert.equal(tideBalance(db,TEST_GENESIS_ADMIN),25000);assert.equal(db.prepare('SELECT COUNT(*) FROM genesis_codes').pluck().get(),100);
});

test("CLI exports once with mode 0600, never emits codes, and refuses public paths and existing files",async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ocean-genesis-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'db.sqlite'),output=join(dir,'genesis-codes-GENESIS_001.csv'),db=openDatabase(file);t.after(()=>db.close());genesisAdmin(db);
  const env={...process.env,NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',DATABASE_PATH:file,GENESIS_CODE_HMAC_KEY:TEST_GENESIS_KEY,GENESIS_ADMIN_USER_ID:TEST_GENESIS_ADMIN};
  const denied=await run(['--import','tsx','src/genesis/issue.ts','--output',join(process.cwd(),'public','genesis-codes-denied.csv')],{...env});assert.notEqual(denied.code,0);assert.equal(db.prepare('SELECT COUNT(*) FROM genesis_waves').pluck().get(),0);
  const args=['--import','tsx','src/genesis/issue.ts','--output',output],first=await run(args,{...env});assert.equal(first.code,0,first.err);assert.equal(statSync(output).mode&0o777,0o600);
  const csv=readFileSync(output,'utf8');assert.equal(csv.trim().split('\n').length,101);assert.equal(first.out.includes('OCN-'),false);
  const second=await run(args,{...env});assert.notEqual(second.code,0);assert.equal(readFileSync(output,'utf8'),csv);assert.equal(tideBalance(db,TEST_GENESIS_ADMIN),25000);
  const other=join(dir,'empty.sqlite'),db2=openDatabase(other);genesisAdmin(db2);db2.close();
  const existing=await run(args,{...env,DATABASE_PATH:other});assert.notEqual(existing.code,0);assert.equal(readFileSync(output,'utf8'),csv);
  const check=openDatabase(other);assert.equal(check.prepare('SELECT COUNT(*) FROM genesis_waves').pluck().get(),0);check.close();assert.equal(existsSync(join(process.cwd(),'public','genesis-codes-denied.csv')),false);
});
