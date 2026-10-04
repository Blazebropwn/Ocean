import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashToken } from '../src/security.js';
import { workerAccessToken } from '../src/worker-auth.js';
import { processTelegramMessage } from '../src/telegram.js';
import { pausedAutomation } from '../src/account-pause.js';
import type { Config } from '../src/config.js';

const ownerId='usr_'+ '1'.repeat(32), memberId='usr_'+ '2'.repeat(32), instanceId='kry_'+ '3'.repeat(32);
const base:Config={port:0,host:'127.0.0.1',databasePath:':memory:',appOrigin:'http://localhost',isProduction:false,manualApprovalEnabled:true};
function fixture(extra:Partial<Config>={}) {
 const db=openDatabase(':memory:');
 for(const [id,role,name] of [[ownerId,'owner','owner'],[memberId,'member','member']]) {
  db.prepare("INSERT INTO users (id,email,username,password_hash,role,approved_at,email_verified_at) VALUES (?,?,?,'hash',?,datetime('now'),datetime('now'))").run(id,name+'@example.com',name,role);
  db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(hashToken(name!),id);
 }
 const config={...base,...extra},app=buildApp(config,db);
 const headers={cookie:'zero_session=owner',origin:base.appOrigin};
 const change=(suspended:boolean)=>app.inject({method:'POST',url:`/api/members/${memberId}/suspension`,headers,payload:{suspended}});
 return {db,app,config,headers,change};
}

test('suspension is owner-only, origin checked, idempotent, audited and reversible for existing sessions',async()=>{
 const f=fixture();const {app,db,change,headers}=f;
 const url=`/api/members/${memberId}/suspension`;
 for(const h of [{},{cookie:'zero_session=member',origin:base.appOrigin},{cookie:'zero_session=owner',origin:'https://wrong.test'},{cookie:'zero_session=owner'}])
  assert.ok([401,403].includes((await app.inject({method:'POST',url,headers:h,payload:{suspended:true}})).statusCode));
 assert.equal((await app.inject({method:'POST',url:`/api/members/${ownerId}/suspension`,headers,payload:{suspended:true}})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{suspended:'true'}})).statusCode,400);
 assert.equal((await change(true)).statusCode,200);
 assert.equal((await change(true)).statusCode,200);
 const memberHeaders={cookie:'zero_session=member'};
 const me=await app.inject({url:'/api/me',headers:memberHeaders});assert.equal(me.json().user.suspended,true);assert.equal(me.json().user.accessApproved,false);
 for(const [method,path] of [['GET','/api/kryptotron'],['GET','/api/agent'],['GET','/api/slot'],['POST','/api/slot/spins'],['POST','/api/genesis/redeem'],['POST','/api/kryptotron/control'],['POST','/api/kryptotron/dca/control'],['POST','/api/telegram/pairing']]) {
  const r=await app.inject({method:method as 'GET'|'POST',url:path,headers:memberHeaders,...(method==='POST'?{payload:{}}:{})});
  assert.equal(r.statusCode,403,path);assert.equal(r.json().code,'ACCOUNT_SUSPENDED',path);
 }
 assert.equal((await app.inject({url:'/api/tide',headers:memberHeaders})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:`/api/members/${memberId}/approval`,headers,payload:{}})).statusCode,200);
 assert.equal((await app.inject({url:'/api/me',headers:memberHeaders})).json().user.suspended,true,'approval cannot bypass suspension');
 assert.equal((await change(false)).statusCode,200);
 assert.equal((await app.inject({url:'/api/me',headers:memberHeaders})).json().user.accessApproved,true);
 assert.equal((await app.inject({url:'/api/slot',headers:memberHeaders})).statusCode,200);
 assert.deepEqual(db.prepare('SELECT action,actor_user_id FROM admin_audit_log ORDER BY id').all(),[
  {action:'MEMBER_SUSPENDED',actor_user_id:ownerId},{action:'MEMBER_UNSUSPENDED',actor_user_id:ownerId}]);
 await app.close();
});

test('email approval mode also respects suspension and retains logout',async()=>{
 const f=fixture({manualApprovalEnabled:false});await f.change(true);
 const me=await f.app.inject({url:'/api/me',headers:{cookie:'zero_session=member'}});assert.equal(me.json().user.accessApproved,false);
 assert.equal((await f.app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:'zero_session=member'},payload:{}})).statusCode,204);
 await f.app.close();
});

test('worker remains able to reconcile protection; suspension forces pause on stale GET/PUT and unblock preserves it',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let state:any={environment:'testnet',entries_paused:false,dca:{enabled:true,amount:5,test_request:{id:'test-one',status:'pending'}},streak:{enabled:true},positions:{BTCUSDC:{in_position:true,protection_client_id:'oco-old',protection_status:'ACTIVE'}},pending_protection:{id:'already-submitted'},events:[]};
 let unavailable=false;
 globalThis.fetch=async(_url,init)=>{
  if(unavailable)return new Response(null,{status:503});
  if(init?.method==='PATCH'){state=JSON.parse(String(init.body)).data;return new Response(null,{status:204});}
  return Response.json([{data:state}]);
 };
 const key=Buffer.alloc(32,1),f=fixture({credentialsEncryptionKey:key.toString('base64'),kryptotronSupabaseUrl:'https://fixture.test',kryptotronSupabaseKey:'key'});
 f.db.prepare("INSERT INTO kryptotron_instances (id,user_id,remote_state_key,status,environment) VALUES (?,?,?,'connected','testnet')").run(instanceId,memberId,instanceId);
 const workerHeaders={'x-ocean-instance':instanceId,authorization:`Bearer ${workerAccessToken(key,instanceId)}`};
 unavailable=true;const suspended=await f.change(true);assert.equal(suspended.statusCode,200);assert.equal(suspended.json().automationPausePending,true);
 const failedUnblock=await f.change(false);assert.equal(failedUnblock.statusCode,503);assert.ok((f.db.prepare('SELECT suspended_at FROM users WHERE id=?').get(memberId) as any).suspended_at);
 unavailable=false;
 const forced=(await f.app.inject({url:'/internal/kryptotron/state',headers:workerHeaders})).json().state;
 assert.equal(forced.entries_paused,true);assert.equal(forced.dca.enabled,false);assert.equal(forced.streak.enabled,false);assert.equal(forced.dca.test_request.status,'rejected');
 assert.deepEqual(forced.positions,state.positions);assert.deepEqual(forced.pending_protection,state.pending_protection);
 const stale=structuredClone(state);
 assert.equal((await f.app.inject({method:'PUT',url:'/internal/kryptotron/state',headers:workerHeaders,payload:{state:stale}})).statusCode,204);
 assert.equal(state.entries_paused,true);assert.equal(state.dca.enabled,false);assert.equal(state.streak.enabled,false);
 assert.equal((await f.change(false)).statusCode,200);
 assert.equal(state.entries_paused,true);assert.equal(state.dca.enabled,false);assert.equal(state.positions.BTCUSDC.protection_client_id,'oco-old');
 assert.equal((f.db.prepare('SELECT status FROM kryptotron_instances WHERE id=?').get(instanceId) as any).status,'connected');
 await f.app.close();
});

test('suspended Telegram account cannot resume, pair or confirm a purchase',async()=>{
 const f=fixture();
 f.db.prepare("INSERT INTO kryptotron_instances (id,user_id,remote_state_key,status,environment) VALUES (?,?,NULL,'unconfigured','testnet')").run(instanceId,memberId);
 f.db.prepare("INSERT INTO telegram_connections (user_id,chat_id) VALUES (?,'123')").run(memberId);
 f.db.prepare("INSERT INTO telegram_confirmations (user_id,token_hash,action,expires_at) VALUES (?,'old','dca_on',datetime('now','+1 day'))").run(memberId);
 await f.change(true);assert.equal(f.db.prepare('SELECT count(*) FROM telegram_confirmations').pluck().get(),0);
 for(const text of ['/resume','/dca_on','/streak_on','/confirm old']) {
  const out:string[]=[];await processTelegramMessage(f.db,f.config,{chat:{id:123},text},async(_,message)=>{out.push(message);});assert.match(out[0]!,/pozastavený/);
 }
 const code='A'.repeat(32);f.db.prepare("INSERT INTO telegram_pairings (token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(hashToken(code),memberId);
 const out:string[]=[];await processTelegramMessage(f.db,f.config,{chat:{id:999},text:'/link '+code},async(_,message)=>{out.push(message);});assert.match(out[0]!,/pozastavený/);
 assert.equal(f.db.prepare("SELECT count(*) FROM telegram_connections WHERE chat_id='999'").pluck().get(),0);
 await f.app.close();
});

test('administrative pause retains already-submitted settlements and only rejects unstarted DCA requests',()=>{
 const state={positions:{BTCUSDC:{protection_status:'ACTIVE'}},pending_order:{side:'BUY'},pending_protection:{id:'submitted'},manual_close:{status:'selling'},dca:{pending:{order:'submitted'},test_request:{status:'processing'}},streak:{enabled:true}};
 const paused=pausedAutomation(state);assert.deepEqual(paused.positions,state.positions);assert.deepEqual(paused.pending_order,state.pending_order);assert.deepEqual(paused.pending_protection,state.pending_protection);assert.deepEqual(paused.manual_close,state.manual_close);assert.deepEqual(paused.dca.pending,state.dca.pending);assert.deepEqual(paused.dca.test_request,state.dca.test_request);
});
