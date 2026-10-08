import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashToken } from '../src/security.js';
import { createSonarRounds, scoreSonarRun, SONAR_VERSION, type SonarRound } from '../src/arcade/sonar.js';
import type { Config } from '../src/config.js';

const config: Config = {port:0,host:'127.0.0.1',databasePath:':memory:',appOrigin:'http://localhost',isProduction:false,manualApprovalEnabled:true};
const uid='usr_'+'1'.repeat(32), other='usr_'+'2'.repeat(32);
const headers={cookie:'zero_session=player',origin:config.appOrigin};
function fixture() {
  const db=openDatabase(':memory:');
  for(const [id,name] of [[uid,'player'],[other,'other']]) {
    db.prepare("INSERT INTO users (id,email,username,password_hash,role,approved_at,email_verified_at) VALUES (?,?,?,'hash','member',datetime('now'),datetime('now'))").run(id,name+'@example.com',name);
    db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(hashToken(name!),id);
  }
  return {db,app:buildApp(config,db)};
}
function perfectTaps(rounds:SonarRound[]) {
  let angle=-Math.PI/2,time=0;
  return rounds.map(round=>{let delta=(round.target-angle+Math.PI*4)%(Math.PI*2);if(delta<.1)delta+=Math.PI*2;
    time+=delta/round.speed*1000;angle=round.target;return time;});
}

test('SONAR restores accuracy and streak scoring and rejects play after a miss',()=>{
  const rounds:SonarRound[]=[{target:0,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100},{target:2,width:.6,perfectWidth:.18,speed:1.2,hitPoints:50,perfectPoints:100}];
  assert.deepEqual(scoreSonarRun(rounds,[Math.PI/2*1000],2000),{score:200,hits:1,perfects:1});
  assert.deepEqual(scoreSonarRun(rounds,[(Math.PI/2+.25)*1000],2000),{score:138,hits:1,perfects:0});
  assert.deepEqual(scoreSonarRun(rounds,[100],2000),{score:0,hits:0,perfects:0});
  assert.equal(scoreSonarRun(rounds,[100,200],2000),null);
  assert.equal(scoreSonarRun(rounds,[NaN],2000),null);
  assert.equal(scoreSonarRun(rounds,[1000],500),null);
  assert.equal(scoreSonarRun(rounds,[1],500),null);
  const course=createSonarRounds();
  assert.equal(course[0]!.width,.72); assert.equal(course[0]!.speed,1.45);
  assert.equal(course[0]!.hitPadding,.04); assert.equal(course[255]!.hitPadding,.04);
  assert.equal(course[255]!.width,.3); assert.equal(course[255]!.speed,3.5);
  const taps=perfectTaps(course.slice(0,15));
  assert.deepEqual(scoreSonarRun(course,taps,taps.at(-1)!+1),{score:4050,hits:15,perfects:15});
});

test('SONAR authenticates and checks approval, origin and account suspension',async()=>{
  const {app,db}=fixture();
  try {
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers:{cookie:headers.cookie},payload:{version:SONAR_VERSION}})).statusCode,403);
    db.prepare('UPDATE users SET approved_at=NULL WHERE id=?').run(uid);
    assert.equal((await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{version:SONAR_VERSION}})).statusCode,403);
    db.prepare("UPDATE users SET approved_at=datetime('now'), suspended_at=datetime('now') WHERE id=?").run(uid);
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json().code,'ACCOUNT_SUSPENDED');
  } finally {await app.close();}
});

test('SONAR recomputes results, persists each player best, and makes submission idempotent',async t=>{
  let now=1_900_000_000_000;t.mock.method(Date,'now',()=>now);
  const {app,db}=fixture();
  try {
    const start=await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{version:SONAR_VERSION}});assert.equal(start.statusCode,201);
    const run=start.json(),taps=perfectTaps(run.rounds.slice(0,3)),durationMs=taps.at(-1)!+10;
    now+=Math.ceil(durationMs);
    const url=`/api/arcade/sonar/runs/${run.id}/finish`,payload={taps,durationMs};
    assert.equal((await app.inject({method:'POST',url,headers:{...headers,cookie:'zero_session=other'},payload})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,score:999999}})).statusCode,400);
    const result=await app.inject({method:'POST',url,headers,payload});assert.equal(result.statusCode,200);assert.equal(result.json().score,630);
    assert.equal((await app.inject({method:'POST',url,headers,payload})).json().replayed,true);
    const rank=(await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json();assert.deepEqual(rank.leaders,[{username:'player',score:630}]);assert.equal(rank.personalBest,630);
    const next=(await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{version:SONAR_VERSION}})).json();
    await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${next.id}/finish`,headers,payload:{taps:[],durationMs:0}});
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json().personalBest,630);
    assert.equal(db.prepare('SELECT count(*) FROM tide_ledger').pluck().get(),0,'Arcade must never mutate TIDE');
    db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(uid);
    assert.deepEqual((await app.inject({url:'/api/arcade/sonar/leaderboard',headers:{cookie:'zero_session=other'}})).json().leaders,[]);
  } finally {await app.close();}
});

test('SONAR rejects impossible timing, expired attempts and previous parallel runs',async t=>{
  let now=1_900_000_000_000;t.mock.method(Date,'now',()=>now);
  const {app}=fixture();
  try {
    const start=async()=> (await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{version:SONAR_VERSION}})).json();
    const run=await start(),url=`/api/arcade/sonar/runs/${run.id}/finish`;
    assert.equal((await app.inject({method:'POST',url,headers,payload:{taps:[],durationMs:10000}})).statusCode,400);
    const next=await start();
    assert.equal((await app.inject({method:'POST',url,headers,payload:{taps:[],durationMs:0}})).json().score,0);
    now+=700_000;
    assert.equal((await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${next.id}/finish`,headers,payload:{taps:[],durationMs:0}})).statusCode,400);
  } finally {await app.close();}
});

test('SONAR returns only five eligible players, ordered by score and earliest record',async()=>{
  const {app,db}=fixture();
  try {
    for (let i=0;i<8;i++) {
      const id=`leader_${i}`;
      db.prepare("INSERT INTO users (id,email,username,password_hash,role,approved_at) VALUES (?,?,?,'hash','member',datetime('now'))").run(id,`${id}@example.com`,id);
      db.prepare('INSERT INTO sonar_records (user_id,version,score,hits,perfects,achieved_at_ms) VALUES (?,?,?,1,1,?)').run(id,SONAR_VERSION,1000-Math.floor(i/2)*100,i);
    }
    db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id='leader_0'").run();
    db.prepare("UPDATE users SET approved_at=NULL WHERE id='leader_1'").run();
    const board=(await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json();
    assert.deepEqual(board.leaders.map((row:{username:string})=>row.username),['leader_2','leader_3','leader_4','leader_5','leader_6']);
  } finally { await app.close(); }
});

test('SONAR keeps legacy scores separate and finishes an in-flight legacy run with its original rules',async t=>{
  let now=1_900_000_000_000;t.mock.method(Date,'now',()=>now);
  const {app,db}=fixture();
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{}})).statusCode,409);
    const id='a1111111-1111-4111-8111-111111111111';
    const rounds=[{target:0,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100}];
    db.prepare('INSERT INTO sonar_runs (id,user_id,version,rounds_json,started_at_ms) VALUES (?,?,?,?,?)').run(id,uid,'sonar-v2',JSON.stringify(rounds),now);
    now+=2000;
    const legacy=await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${id}/finish`,headers,payload:{taps:[Math.PI/2*1000],durationMs:2000}});
    assert.equal(legacy.statusCode,200);assert.equal(legacy.json().score,100);
    assert.equal(db.prepare("SELECT score FROM sonar_records WHERE version='sonar-v2'").pluck().get(),100);
    const board=(await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json();
    assert.deepEqual(board.leaders,[]);assert.equal(board.personalBest,0);
    const run=(await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{version:SONAR_VERSION}})).json();
    const taps=perfectTaps(run.rounds.slice(0,1)),durationMs=taps[0]!+10;now+=Math.ceil(durationMs);
    assert.equal((await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${run.id}/finish`,headers,payload:{taps,durationMs}})).json().score,200);
    assert.equal(db.prepare('SELECT count(*) FROM sonar_records WHERE user_id=?').pluck().get(uid),2);
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json().personalBest,200);
  } finally { await app.close(); }
});
