import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashToken } from '../src/security.js';
import { createSonarRounds, scoreSonarRun, type SonarRound } from '../src/arcade/sonar.js';
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

test('SONAR awards 100 for perfect, 50 for ordinary hits and rejects play after a miss',()=>{
  const rounds:SonarRound[]=[{target:0,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100},{target:2,width:.6,perfectWidth:.18,speed:1.2,hitPoints:50,perfectPoints:100}];
  assert.deepEqual(scoreSonarRun(rounds,[Math.PI/2*1000],2000),{score:100,hits:1,perfects:1});
  assert.deepEqual(scoreSonarRun(rounds,[(Math.PI/2+.25)*1000],2000),{score:50,hits:1,perfects:0});
  assert.deepEqual(scoreSonarRun(rounds,[100],2000),{score:0,hits:0,perfects:0});
  assert.equal(scoreSonarRun(rounds,[100,200],2000),null);
  assert.equal(scoreSonarRun(rounds,[NaN],2000),null);
  assert.equal(scoreSonarRun(rounds,[1000],500),null);
  assert.equal(scoreSonarRun(rounds,[1],500),null);
  const course=createSonarRounds(),taps=perfectTaps(course.slice(0,15));
  assert.deepEqual(scoreSonarRun(course,taps,taps.at(-1)!+1),{score:1500,hits:15,perfects:15});
});

test('SONAR authenticates and checks approval, origin and account suspension',async()=>{
  const {app,db}=fixture();
  try {
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers:{cookie:headers.cookie},payload:{}})).statusCode,403);
    db.prepare('UPDATE users SET approved_at=NULL WHERE id=?').run(uid);
    assert.equal((await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{}})).statusCode,403);
    db.prepare("UPDATE users SET approved_at=datetime('now'), suspended_at=datetime('now') WHERE id=?").run(uid);
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json().code,'ACCOUNT_SUSPENDED');
  } finally {await app.close();}
});

test('SONAR recomputes results, persists each player best, and makes submission idempotent',async t=>{
  let now=1_900_000_000_000;t.mock.method(Date,'now',()=>now);
  const {app,db}=fixture();
  try {
    const start=await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{}});assert.equal(start.statusCode,201);
    const run=start.json(),taps=perfectTaps(run.rounds.slice(0,3)),durationMs=taps.at(-1)!+10;
    now+=Math.ceil(durationMs);
    const url=`/api/arcade/sonar/runs/${run.id}/finish`,payload={taps,durationMs};
    assert.equal((await app.inject({method:'POST',url,headers:{...headers,cookie:'zero_session=other'},payload})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,score:999999}})).statusCode,400);
    const result=await app.inject({method:'POST',url,headers,payload});assert.equal(result.statusCode,200);assert.equal(result.json().score,300);
    assert.equal((await app.inject({method:'POST',url,headers,payload})).json().replayed,true);
    const rank=(await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json();assert.deepEqual(rank.leaders,[{username:'player',score:300}]);assert.equal(rank.personalBest,300);
    const next=(await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{}})).json();
    await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${next.id}/finish`,headers,payload:{taps:[],durationMs:0}});
    assert.equal((await app.inject({url:'/api/arcade/sonar/leaderboard',headers})).json().personalBest,300);
    assert.equal(db.prepare('SELECT count(*) FROM tide_ledger').pluck().get(),0,'Arcade must never mutate TIDE');
    db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(uid);
    assert.deepEqual((await app.inject({url:'/api/arcade/sonar/leaderboard',headers:{cookie:'zero_session=other'}})).json().leaders,[]);
  } finally {await app.close();}
});

test('SONAR rejects impossible timing, expired attempts and previous parallel runs',async t=>{
  let now=1_900_000_000_000;t.mock.method(Date,'now',()=>now);
  const {app}=fixture();
  try {
    const start=async()=> (await app.inject({method:'POST',url:'/api/arcade/sonar/runs',headers,payload:{}})).json();
    const run=await start(),url=`/api/arcade/sonar/runs/${run.id}/finish`;
    assert.equal((await app.inject({method:'POST',url,headers,payload:{taps:[],durationMs:10000}})).statusCode,400);
    const next=await start();
    assert.equal((await app.inject({method:'POST',url,headers,payload:{taps:[],durationMs:0}})).json().score,0);
    now+=700_000;
    assert.equal((await app.inject({method:'POST',url:`/api/arcade/sonar/runs/${next.id}/finish`,headers,payload:{taps:[],durationMs:0}})).statusCode,400);
  } finally {await app.close();}
});
