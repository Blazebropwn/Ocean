import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashToken } from '../src/security.js';
import { issueGenesisBatch, type GenesisCodeExport } from '../src/genesis/service.js';
import { slotMathReport } from '../src/slot/report.js';
import { TEST_GENESIS_KEY } from './helpers/genesis-fixture.js';

test('Mathlab enumerates the production model exactly',()=>{
 const report=slotMathReport();
 assert.equal(report.combinations,15625);assert.equal(report.hits,1135);
 assert.equal(report.rtp,.951808);assert.equal(report.hitRate,.07264);
 assert.ok(Math.abs(report.expectedNet-(-.48192))<1e-10);
 assert.equal(report.outcomes.find(o=>o.symbol==='core')!.combinations,1);
 assert.equal(report.outcomes.reduce((n,o)=>n+o.combinations,0),report.hits);
 assert.ok(Math.abs(report.outcomes.reduce((n,o)=>n+o.rtpContribution,0)-report.rtp)<1e-10);
});

test('admin export requires approved owner and same origin; validates private CSV without exposing codes through inventory',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ocean-admin-')),databasePath=join(root,'ocean.db'),db=openDatabase(databasePath);
 const app=buildApp({databasePath,port:0,host:'127.0.0.1',appOrigin:'http://localhost:3000',isProduction:false,manualApprovalEnabled:true,genesisCodeHmacKey:TEST_GENESIS_KEY},db);
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 for(const [id,role,approved] of [['owner','owner',true],['member','member',true],['pending','owner',false]] as const){
  db.prepare('INSERT INTO users(id,email,username,password_hash,role,approved_at) VALUES (?,?,?,?,?,?)').run(id,id+'@example.test',id,'unusable',role,approved?new Date().toISOString():null);
  db.prepare('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(id+'-token'),id,new Date(Date.now()+600000).toISOString());
 }
 let codes:GenesisCodeExport[]=[];issueGenesisBatch(db,{adminUserId:'owner',hmacKey:TEST_GENESIS_KEY},rows=>{codes=rows});
 const request={method:'POST' as const,url:'/api/admin/genesis/export',payload:{wave:'GENESIS_001'}};
 const headers=(id='owner')=>({cookie:`zero_session=${id}-token`,origin:'http://localhost:3000'});
 assert.equal((await app.inject(request)).statusCode,401);
 for(const id of ['member','pending']){
  assert.equal((await app.inject({...request,headers:headers(id)})).statusCode,403);
  assert.equal((await app.inject({url:'/api/admin/slot/math',headers:headers(id)})).statusCode,403);
 }
 assert.equal((await app.inject({url:'/api/admin/slot/math'})).statusCode,401);
 assert.equal((await app.inject({...request,headers:{cookie:'zero_session=owner-token'}})).statusCode,403);
 assert.equal((await app.inject({...request,headers:{...headers(),origin:'https://other.example'}})).statusCode,403);
 assert.equal((await app.inject({...request,headers:headers(),payload:{wave:'../../ocean'}})).statusCode,400);
 assert.equal((await app.inject({...request,headers:headers(),payload:{wave:'GENESIS_001',path:'/etc/passwd'}})).statusCode,400);
 assert.equal((await app.inject({...request,headers:headers()})).statusCode,404);
 const dir=join(root,'genesis-exports');mkdirSync(dir,{mode:0o700});const file=join(dir,'genesis-codes-GENESIS_001.csv');
 const csv='index,code,reward_tide,wave\n'+codes.map(c=>`${String(c.genesisNumber).padStart(3,'0')},${c.code},${c.rewardTide},${c.wave}`).join('\n')+'\n';
 writeFileSync(file,csv,{mode:0o600});
 const response=await app.inject({...request,headers:headers()});assert.equal(response.statusCode,200);assert.equal(response.body,csv);
 assert.equal(response.headers['cache-control'],'no-store');assert.match(String(response.headers['content-disposition']),/attachment; filename="genesis-codes-GENESIS_001.csv"/);
 const inventory=await app.inject({url:'/api/admin/genesis',headers:headers()});assert.equal(inventory.body.includes(codes[0]!.code),false);
 const audit=db.prepare("SELECT details_json FROM admin_audit_log WHERE action='GENESIS_CODES_EXPORTED'").all();assert.equal(audit.length,1);assert.equal(JSON.stringify(audit).includes(codes[0]!.code),false);
 writeFileSync(file,csv.replace(codes[0]!.code,'OCN-AAAAA-AAAAA-AAAAA-AAAAA'));
 const bad=await app.inject({...request,headers:headers()});assert.equal(bad.statusCode,409);assert.equal(bad.body.includes(codes[0]!.code),false);
 const ledgerBefore=db.prepare('SELECT count(*) AS n FROM tide_ledger').get();
 const math=await app.inject({url:'/api/admin/slot/math',headers:headers()});assert.equal(math.statusCode,200);assert.equal(math.json().rtp,.951808);
 assert.deepEqual(db.prepare('SELECT count(*) AS n FROM tide_ledger').get(),ledgerBefore);assert.deepEqual(db.prepare('SELECT count(*) AS n FROM slot_spins').get(),{n:0});
});
