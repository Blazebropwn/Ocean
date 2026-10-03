import test from 'node:test';
import assert from 'node:assert/strict';
import { protectionRestoreView, queueProtectionRestore, mergeProtectionRestore } from '../src/protection-restore.js';
import { requestProtectionRestore, saveKryptotronState } from '../src/kryptotron.js';
import { manualCloseView } from '../src/manual-close.js';
const state = (): Record<string, any> => ({ protection_restore_version: 1, manual_close_version: 1, api_permissions_safe: true, safe_mode: true, entries_paused: true,
 last_heartbeat_at: new Date().toISOString(), reconciliation: { status: 'UNRESOLVED', checked_at: new Date().toISOString(), issues: [{code:'PROTECTION_ERROR',symbol:'BTCUSDC'},{code:'PROTECTION_ERROR',symbol:'ETHUSDC'}] },
 positions: Object.fromEntries(['BTCUSDC','ETHUSDC'].map(symbol=>[symbol,{in_position:true,entry_order_client_id:`entry-${symbol}`,position_qty:.001,entry_price:100,protection_status:'CANCELLED',protection_client_id:`ocean-protect-${symbol}`,protection_stop_price:90,protection_activation_price:103,protection_trailing_bips:150}])) });
const queue = (data:Record<string, any>)=>queueProtectionRestore(data,'BTCUSDC','entry-BTCUSDC','ocean-protect-BTCUSDC');

test('restoration requires a paused, fresh account with only missing-protection issues',()=>{
 assert.equal(protectionRestoreView(state()).available,true);
 for(const override of [{entries_paused:false},{protection_restore_version:undefined},{api_permissions_safe:false},{last_heartbeat_at:'2020-01-01'},
 {pending_order:{}},{pending_protection:{}},{dca:{pending:{}}},{pending_trade_logs:[{}]},{manual_close:{status:'queued'}},
 {reconciliation:{status:'UNRESOLVED',checked_at:new Date().toISOString(),issues:[{code:'UNATTRIBUTED_BALANCE',symbol:'BTCUSDC'}]}},
 {reconciliation:{status:'UNRESOLVED',checked_at:'2020-01-01',issues:[{code:'PROTECTION_ERROR',symbol:'BTCUSDC'}]}}])assert.throws(()=>queue({...state(),...override}));
 const data=state();const request=queue(data);assert.equal(queue(data),request);assert.equal(data.entries_paused,true);
 assert.throws(()=>queueProtectionRestore(data,'ETHUSDC','entry-ETHUSDC','ocean-protect-ETHUSDC'));
 assert.equal(manualCloseView({...data,safe_mode:false,reconciliation:{status:'OK',checked_at:new Date().toISOString()}}).available,false);
});

test('restoration pins terms and cannot target a changed or active protection',()=>{
 const data=state();assert.throws(()=>queueProtectionRestore(data,'BTCUSDC','old','ocean-protect-BTCUSDC'));
 data.positions.BTCUSDC.protection_status='ACTIVE';assert.throws(()=>queue(data));
 data.positions.BTCUSDC.protection_status='CANCELLED';data.positions.BTCUSDC.position_qty=NaN;assert.throws(()=>queue(data));
 const request=queue(state());const forged=mergeProtectionRestore({...request,status:'submitting',symbol:'ETHUSDC',quantity:100,stop_price:1},request)!;
 assert.equal(forged.symbol,'BTCUSDC');assert.equal(forged.quantity,.001);assert.equal(forged.stop_price,90);
 assert.equal(mergeProtectionRestore(request,undefined),undefined);
 assert.deepEqual(mergeProtectionRestore(undefined,request),request);
 assert.deepEqual(mergeProtectionRestore(request,{...request,status:'completed'}),{...request,status:'completed'});
});

test('concurrent requests deduplicate and stale workers cannot erase or rewind restore intent',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let stored=state(),writes=0;const old=structuredClone(stored);
 globalThis.fetch=async(_url,init)=>{if(init?.method==='PATCH'){stored=JSON.parse(String(init.body)).data;writes++;return new Response(null,{status:204});}return Response.json([{data:structuredClone(stored)}]);};
 const args=['https://example.test','key','kry_test','BTCUSDC','entry-BTCUSDC','ocean-protect-BTCUSDC'] as const;
 const [one,two]=await Promise.all([requestProtectionRestore(...args),requestProtectionRestore(...args)]);assert.equal(one.id,two.id);assert.equal(writes,1);
 await saveKryptotronState(args[0],args[1],args[2],old);assert.equal(stored.protection_restore.id,one.id);
 const stale=structuredClone(stored);stored.protection_restore.status='completed';const count=writes;
 await assert.rejects(()=>saveKryptotronState(args[0],args[1],args[2],stale),/autoritativní/);assert.equal(writes,count);
});

test('HTTP restore is confirmed, origin-bound, and scoped to the signed-in instance',async t=>{
 const {buildApp}=await import('../src/app.js'),{openDatabase}=await import('../src/db.js');const db=openDatabase(':memory:');
 const app=buildApp({port:0,host:'127.0.0.1',databasePath:':memory:',appOrigin:'http://localhost:3000',isProduction:false,manualApprovalEnabled:true,kryptotronSupabaseUrl:'https://example.test',kryptotronSupabaseKey:'key'},db);t.after(()=>app.close());
 const reg=await app.inject({method:'POST',url:'/api/auth/register',payload:{username:'restore_owner',password:'a safe password'}});const cookie=reg.headers['set-cookie']!.toString().split(';')[0]!;
 const id=(db.prepare('SELECT id FROM kryptotron_instances WHERE user_id=?').get(reg.json().user.id) as {id:string}).id;db.prepare("UPDATE kryptotron_instances SET status='connected',remote_state_key=id WHERE id=?").run(id);
 const payload={symbol:'BTCUSDC',positionId:'entry-BTCUSDC',protectionId:'ocean-protect-BTCUSDC',confirmed:true},url='/api/kryptotron/protection/restore',headers={cookie,origin:'http://localhost:3000'};
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url,payload,headers:{cookie}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,payload,headers:{cookie,origin:'https://evil.test'}})).statusCode,403);
 for(const body of [{...payload,confirmed:false},{...payload,instanceId:'other'},{...payload,quantity:1}])assert.equal((await app.inject({method:'POST',url,payload:body,headers})).statusCode,400);
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let stored=state();globalThis.fetch=async(input,init)=>{assert.equal(new URL(String(input)).searchParams.get('key'),`eq.${id}`);if(init?.method==='PATCH'){stored=JSON.parse(String(init.body)).data;return new Response(null,{status:204});}return Response.json([{data:stored}]);};
 const response=await app.inject({method:'POST',url,payload,headers});assert.equal(response.statusCode,202);assert.equal(stored.entries_paused,true);
 const retry=await app.inject({method:'POST',url,payload,headers});assert.equal(retry.json().request.id,response.json().request.id);
});
