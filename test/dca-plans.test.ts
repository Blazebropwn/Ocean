import test from "node:test";
import assert from "node:assert/strict";
import { readDcaPlans } from "../src/dca-plans.js";
import { dcaSettingsSchema } from "../src/schemas.js";
import { setDcaSettings, saveKryptotronState, setDcaAmount } from "../src/kryptotron.js";

const amounts = { BTCUSDC: 5, ETHUSDC: 10, SOLUSDC: 20 };
test("DCA validates three amounts and exactly one shared interval", () => {
  for (const amount of [5,10,20,50,100]) for (const frequency of ["daily","weekly","monthly"]) {
    assert.ok(dcaSettingsSchema.safeParse({ amounts: { ...amounts, BTCUSDC: amount }, frequency }).success);
  }
  for (const invalid of [{amounts:{...amounts,BTCUSDC:200},frequency:'daily'}, {amounts:{BTCUSDC:5},frequency:'daily'},
    {amounts:{...amounts,BNBUSDC:5},frequency:'daily'}, {amounts,frequency:'hourly'}, {amounts,frequency:'weekly',symbol:'BTCUSDC'}]) {
    assert.equal(dcaSettingsSchema.safeParse(invalid).success,false);
  }
});

test("shared interval overrides historical per-asset frequencies without changing amounts", () => {
  assert.ok(readDcaPlans({amount:200}).every(p=>p.amount===200 && p.frequency==='weekly'));
  const plans=readDcaPlans({amount:5,frequency:'monthly',plans:{SOLUSDC:{amount:20,frequency:'daily'}}});
  assert.deepEqual(plans.map(p=>p.amount),[5,5,20]);
  assert.ok(plans.every(p=>p.frequency==='monthly'));
});

test("one atomic settings write preserves pending fills, controls, history and no-op scheduling", async t => {
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  let state: Record<string,any>={entries_paused:true,trading_paused:true,dca:{enabled:false,amount:5,
    pending:{symbol:'BTCUSDC',amount:5},purchases:[{symbol:'BTCUSDC',amount:5}],completed_week:'2026-W44'}};
  let writes=0;
  globalThis.fetch=async (input,init)=>{
    assert.ok(String(input).includes('key=eq.user%2Finstance'));
    if(!init?.method)return new Response(JSON.stringify([{data:state}]));
    writes++;state=JSON.parse(String(init.body)).data;return new Response(null,{status:204});
  };
  const stale=structuredClone(state);
  const input={amounts,frequency:'daily' as const};
  const first=await setDcaSettings('https://example.supabase.co','key','user/instance',input);
  assert.equal(writes,1);assert.equal(state.dca.frequency,'daily');
  assert.ok(Object.values(state.dca.plans).every((p:any)=>p.frequency==='daily'));
  assert.equal(state.dca.enabled,false);assert.equal(state.entries_paused,true);assert.equal(state.trading_paused,true);
  assert.deepEqual(state.dca.pending,stale.dca.pending);assert.deepEqual(state.dca.purchases,stale.dca.purchases);
  assert.equal(state.dca.completed_week,'2026-W44');
  await setDcaSettings('https://example.supabase.co','key','user/instance',input);
  assert.equal(writes,1,'same settings do not move future start');
  await saveKryptotronState('https://example.supabase.co','key','user/instance',stale);
  assert.equal(state.dca.frequency,'daily');assert.equal(state.dca.plans.SOLUSDC.configured_at,first[2]!.configuredAt);
  await setDcaSettings('https://example.supabase.co','key','user/instance',{amounts:{...amounts,BTCUSDC:50},frequency:'daily'});
  assert.equal(state.dca.plans.SOLUSDC.configured_at,first[2]!.configuredAt,'unchanged assets keep their next slot');
  await setDcaSettings('https://example.supabase.co','key','user/instance',{amounts,frequency:'monthly'});
  assert.ok(readDcaPlans(state.dca).every(p=>p.frequency==='monthly'));
  await assert.rejects(setDcaAmount('https://example.supabase.co','key',50,'user/instance'));
  state.account_reset={status:'queued'};
  await assert.rejects(setDcaSettings('https://example.supabase.co','key','user/instance',input));
});

test("plan API uses the logged-in instance and rejects unsupported amounts and suspended users", async t => {
  const { buildApp } = await import('../src/app.js');
  const { openDatabase } = await import('../src/db.js');
  const db=openDatabase(':memory:');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let instance=''; let state: Record<string,any>={entries_paused:false,dca:{enabled:true,amount:5}};
  globalThis.fetch=async (input,init)=>{
    const target = new URL(String(input));
    assert.equal(target.origin + target.pathname, 'https://example.supabase.co/rest/v1/bot_state');
    assert.equal(target.searchParams.get('key'), `eq.${instance}`);
    if(!init?.method)return new Response(JSON.stringify([{data:state}]));
    state=JSON.parse(String(init.body)).data;return new Response(null,{status:204});
  };
  const app=buildApp({port:0,host:'127.0.0.1',databasePath:':memory:',appOrigin:'http://localhost',isProduction:false,
    kryptotronSupabaseUrl:'https://example.supabase.co',kryptotronSupabaseKey:'server-key'},db);
  t.after(()=>app.close());
  const registration=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:'plans@example.com',username:'planner',password:'secure test password'}});
  const cookie=registration.headers['set-cookie']!.toString().split(';')[0]!;
  const user=registration.json().user;
  db.prepare("UPDATE users SET email_verified_at=datetime('now') WHERE id=?").run(user.id);
  const row=db.prepare('SELECT id FROM kryptotron_instances WHERE user_id=?').get(user.id) as {id:string};instance=row.id;
  db.prepare("UPDATE kryptotron_instances SET status='connected',environment='testnet',remote_state_key=id WHERE id=?").run(instance);
  const payload={amounts:{BTCUSDC:5,ETHUSDC:50,SOLUSDC:10},frequency:'monthly'};
  assert.equal((await app.inject({method:'POST',url:'/api/kryptotron/dca/settings',payload})).statusCode,401);
  const headers={cookie};
  for(const invalid of [{...payload,amounts:{...payload.amounts,ETHUSDC:200}},{...payload,instance_id:'another-user'}])
    assert.equal((await app.inject({method:'POST',url:'/api/kryptotron/dca/settings',headers,payload:invalid})).statusCode,400);
  const saved=await app.inject({method:'POST',url:'/api/kryptotron/dca/settings',headers,payload});
  assert.equal(saved.statusCode,200);assert.equal(saved.json().plans[1].frequency,'monthly');
  assert.equal(state.dca.plans.ETHUSDC.amount,50);assert.equal(state.entries_paused,false);
  db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(user.id);
  assert.equal((await app.inject({method:'POST',url:'/api/kryptotron/dca/settings',headers,payload:{...payload,amounts:{...payload.amounts,ETHUSDC:10}}})).statusCode,403);
  assert.equal(state.dca.plans.ETHUSDC.amount,50);
});
