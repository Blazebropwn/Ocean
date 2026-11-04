// Integrated UI fixtures: no market calls, wallet, or real transactions.
const { chromium }=await import(process.env.OCEAN_PLAYWRIGHT_MODULE||'playwright');
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../../public',import.meta.url).pathname;
const mint='So11111111111111111111111111111111111111112';
const now=()=>new Date().toISOString();
let allowed=true,deny=false,polls=0;
const mutations=[],errors=[];
const state={mode:'PAPER',initialUsdc:100,cashUsdc:100,equityUsdc:100,positions:[],trades:[],asOf:now(),nextCycleAt:null,lastCycle:{id:'cycle',startedAt:now(),completedAt:now(),status:'completed'},limits:{maxOpenPositions:3,maxPositionUsdc:5,maxExposureUsdc:15,minLiquidityUsd:50000,minVolume5mUsd:1000,maxHolderPct:20,minLiquidityLockedPct:95,stopLossPct:10,takeProfitPct:20,maxHoldingMinutes:30,maxDailyEntries:10,maxDailyLossUsdc:5,slippageBps:100,networkFeeUsdc:.01},automation:{enabled:false,status:'paused',intervalSeconds:60,nextRunAt:null,lastError:null},runtime:{running:false,stage:null,startedAt:null,updatedAt:null},counters:{cycles:2,poolsSeen:60,riskChecked:1,rejected:59,trades:0},stages:['scanner','rug-check','sizer','executor','logger','equity'].map(id=>({id,status:id==='scanner'?'blocked':'idle',detail:'Token nesplnil limity.'})),candidates:[{mint,symbol:'<img src=x onerror=alert(1)>',liquidityUsd:22000,volume5mUsd:200,observedAt:now(),status:'blocked',reason:'Likvidita je nižší než 50 000 USD.'}],decisions:[{sequence:1,stage:'scanner',status:'blocked',reason:'<script>alert(1)</script> Likvidita je nízká.',occurredAt:now(),evidence:{raw:'999999999999999999'}}],equityHistory:[{at:now(),valueUsdc:100},{at:now(),valueUsdc:100}]};
state.watchlist={trackedPools:45,trackedTokens:38,refreshedPools:18,refreshErrors:2,lastError:'<img src=x onerror=alert(2)> Chybí nová cena.'};
state.diagnostics={policyVersion:'paper-2026-11-04-v2',inspectedTokens:20,rejectedTokens:20,rejectionCounts:[{reason:'Likvidita je nižší než 50 000 USD.',count:20},{reason:'<script>alert(2)</script> Objem za 5 minut je příliš nízký.',count:17}]};
state.candidates[0].reasons=[state.candidates[0].reason,'<script>alert(2)</script> Objem za 5 minut je příliš nízký.'];state.candidates[0].source='watchlist';
const browser=await chromium.launch({headless:true,executablePath:process.env.OCEAN_CHROMIUM_PATH,args:['--no-sandbox']});
state.candidates.push(...Array.from({length:19},(_,index)=>({...state.candidates[0],mint:mint.slice(0,-2)+String(index+10),symbol:`TOKEN${index+1}`})));
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(String(error)));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());if(url.hostname!=='ocean.test')return route.abort();const path=url.pathname;
 if(path.startsWith('/api/')){
  let body={},status=200;
  if(path==='/api/me')body={user:{id:'preview',username:'Blazebro',displayId:'OCEAN-000001',emailVerified:true,accessApproved:true,role:'member',features:{solanaTerminal:allowed}}};
  else if(path.startsWith('/api/solana')){
   if(deny){status=404;body={error:'Pilot není dostupný.'};}
   else{
    if(path==='/api/solana/live')polls++;
    if(route.request().method()==='POST'){
     mutations.push({path,body:route.request().postData()});
     if(path.endsWith('/automation')){state.automation.enabled=route.request().postDataJSON().enabled;state.automation.status=state.automation.enabled?'running':'paused';state.runtime={running:state.automation.enabled,stage:state.automation.enabled?'scanner':null,detail:'Načítám skutečný feed.',startedAt:now(),updatedAt:now()};state.automation.nextRunAt=state.automation.enabled?new Date(Date.now()+60000).toISOString():null;}
     else if(path.endsWith('/close')){state.positions=[];state.cashUsdc=100;state.equityUsdc=100;}
    }
    state.asOf=now();body=structuredClone(state);if(path.endsWith('/live')){body.trades=[];body.decisions=body.decisions.map(event=>({...event,evidence:{}}));}
   }
  }
  else if(path==='/api/kryptotron/connection')body={connection:{status:'unconfigured'}};
  else if(path==='/api/tide')body={balance:0};
  else{status=404;body={error:'No fixture'};}
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 }
 try{const file=path==='/'?'/index.html':path;return route.fulfill({contentType:({html:'text/html',css:'text/css',js:'text/javascript',svg:'image/svg+xml'})[file.split('.').pop()]||'application/octet-stream',body:await readFile(root+file)});}catch{return route.fulfill({status:404,body:''});}
});
try{
 await page.goto('http://ocean.test/#solana');await page.locator('[data-solana="cash"]').filter({hasText:'100,00'}).waitFor();
 assert.equal(mutations.length,0,'opening the panel does not start automation');
 assert.equal(await page.locator('.solana-candidates img,.solana-candidates script').count(),0);
 assert.equal(await page.locator('[data-solana=cycle-summary]').innerText(),'Poslední kolo: 20 různých tokenů · 20 vynecháno','latest-cycle distinct tokens are not presented as cumulative repeated inspections');
 assert.match(await page.locator('[data-solana=watch-summary]').innerText(),/Sledujeme 45 trhů · obnoveno 18 · 2 chyb/);
 assert.match(await page.locator('.solana-candidate').first().innerText(),/2 důvody vynechání · Znovu prověřeno/);
 state.watchlist.refreshErrors=0;await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 assert.match(await page.locator('[data-solana=watch-summary]').innerText(),/^Část dat chybí · Sledujeme 45 trhů · obnoveno 18$/,'a discovery outage remains visible even when all watched-pool refreshes succeeded');
 assert.equal(await page.locator('[data-solana=watch-summary]').getAttribute('data-error'),'true');
 for(const [width,height]of [[1920,1080],[1440,900],[1280,720],[901,768],[900,768],[390,844],[390,680],[375,640],[320,568]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(60);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}x${height}: no horizontal overflow`);
  assert.equal(await page.locator('.solana-step').count(),6);
  assert.equal(await page.locator('.solana-pipeline').isVisible(),true,'all six actual steps are visible directly on the dashboard');
  assert.equal(await page.locator('.solana-live-tail').isVisible(),true,'recent actual events are visible directly on the dashboard');
  assert.equal(await page.locator('dialog .solana-pipeline,details .solana-pipeline,dialog .solana-live-tail,details .solana-live-tail').count(),0,'work is available without opening a detail');
  assert.equal(await page.locator('.solana-story').isVisible(),true);
  assert.equal(await page.locator('[data-solana=watch-summary]').isVisible(),true,'ongoing observation and refresh counts remain visible on mobile');
  assert.equal(await page.locator('[data-solana=watch-summary]').evaluate(el=>{const range=document.createRange();range.setStart(el.firstChild,0);range.setEnd(el.firstChild,'Část dat chybí'.length);const warning=range.getBoundingClientRect(),box=el.getBoundingClientRect();return warning.y>=box.y&&warning.bottom<=box.bottom&&warning.right<=box.right;}),true,'partial-data warning appears first and is never clipped away');
  assert.equal(await page.locator('.home-tabs').isVisible(),width<=900);
  const radar=await page.locator('.solana-stream').boundingBox(),positions=await page.locator('.solana-open-positions').boundingBox();
  assert.ok(width>900?positions.x>radar.x:positions.y>=radar.y+radar.height-1,'desktop has two columns; mobile stacks its sections');
  if(width>=375&&height>=640){
   const fit=await page.locator('.workspace').evaluate(el=>{
    const boxes=selector=>[...document.querySelectorAll(selector)].map(child=>({class:child.className,stage:child.dataset.stage,...Object.fromEntries(['y','width','height'].map(key=>[key,Math.round(child.getBoundingClientRect()[key]*100)/100]))}));
    return{height:el.clientHeight,scroll:el.scrollHeight,panel:boxes('#solana-panel > *'),workflow:boxes('.solana-story > *'),steps:boxes('.solana-step'),stream:boxes('.solana-stream-grid > section, .solana-stream-grid > section > *'),events:boxes('.solana-tail-row:first-child')};
   });assert.ok(fit.scroll<=fit.height+2,`panel fits ${width}x${height}: ${JSON.stringify(fit)}`);
   const navigation=await page.locator('.side-nav').boundingBox(),bottom=width<=900?navigation.y:height;
   for(const stage of await page.locator('.solana-step').all()){
    const box=await stage.boundingBox();assert.ok(box&&box.width>0&&box.height>0&&box.y>=0&&box.y+box.height<=bottom+1,`${width}x${height}: each actual stage is visible above navigation`);
   }
   const activity=await page.locator('.solana-live-tail').boundingBox(),event=await page.locator('.solana-tail-row').first().boundingBox();
   assert.ok(event&&event.y>=activity.y-1&&event.y+event.height<=Math.min(bottom,activity.y+activity.height)+1,`${width}x${height}: the latest actual event is visible above navigation: ${JSON.stringify({activity,event,bottom})}`);
  }
  if(width===1440||width===390)await page.screenshot({path:`/tmp/ocean-solana-integrated-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('.solana-live-tail script,.solana-live-tail img').count(),0,'visible activity treats market text as text');
 assert.match(await page.locator('.solana-tail-row').first().innerText(),/<script>alert\(1\)<\/script>/);
 await page.locator('.solana-candidate').first().click();
 assert.equal(await page.locator('[data-solana-dialog=candidate]').isVisible(),true);
 assert.equal(await page.locator('[data-solana=candidate-detail] script,[data-solana=candidate-detail] img').count(),0);
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/málo prostředků/);
 assert.equal(await page.locator('[data-solana=candidate-detail] .solana-reasons li').count(),2,'every failed check is visible without expanding a technical detail');
 assert.match(await page.locator('[data-solana=candidate-detail] .solana-reasons').innerText(),/<script>alert\(2\)<\/script>/,'untrusted reasons are plain text');
 assert.equal(await page.locator('[data-solana=candidate-detail] details .solana-reasons').count(),0);
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/Dříve nalezený trh, znovu prověřený/);
 await page.keyboard.press('Escape');
 const modern={watchlist:state.watchlist,diagnostics:state.diagnostics,reasons:state.candidates[0].reasons,source:state.candidates[0].source};
 delete state.watchlist;delete state.diagnostics;delete state.candidates[0].reasons;delete state.candidates[0].source;
 await page.locator('[data-solana-open=rules]').focus();await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 await page.locator('[data-solana=cycle-summary]').waitFor({state:'hidden'});
 assert.equal(await page.locator('[data-solana=cycle-summary]').isVisible(),false,'older snapshots do not invent diagnostics');
 await page.locator('.solana-candidate').first().click();
 assert.equal(await page.locator('[data-solana=candidate-detail] .solana-reasons li').count(),1,'older candidates preserve their first stored reason');
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/Uložený důvod vynechání/);
 await page.keyboard.press('Escape');Object.assign(state,{watchlist:modern.watchlist,diagnostics:modern.diagnostics});Object.assign(state.candidates[0],{reasons:modern.reasons,source:modern.source});
 await page.locator('[data-solana-open=rules]').focus();await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 const beforeLimit={candidates:structuredClone(state.candidates),automation:structuredClone(state.automation)};
 await page.locator('.solana-candidate').first().click();
 const oldObservation=new Date(Date.now()-600000).toISOString();
 state.marketData={provider:'GeckoTerminal',rateLimited:true,retryAt:new Date(Date.now()+120000).toISOString()};
 state.candidateFeed={stale:true,observedAt:oldObservation};
 state.automation={...state.automation,enabled:true,status:'error',lastError:'GeckoTerminal: HTTP 429',nextRunAt:state.marketData.retryAt};
 state.candidates=state.candidates.map((candidate,index)=>({...candidate,observedAt:oldObservation,stale:true,status:['checking','eligible','passed'][index]||candidate.status}));
 await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 await page.locator('[data-solana=candidate-detail] .solana-stale-notice').waitFor();
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/Starší data · poslední načtení/,'an already open detail also switches to historical labeling when the feed becomes stale');
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/předchozí kontrole, aktuální podmínky nejsou ověřené/);
 assert.match(await page.locator('[data-solana=candidate-detail] .solana-reasons').innerText(),/<script>alert\(2\)<\/script>/,'historical rejection evidence remains available as plain text');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('[data-solana=story-title]').innerText(),'Zdroj dat omezuje požadavky');
 assert.match(await page.locator('[data-solana=story-text]').innerText(),/Další pokus spustí automat po odpočtu/);
 assert.equal(await page.locator('[data-solana=scan]').isDisabled(),true,'manual scans cannot bypass provider rate limiting');
 assert.equal(await page.locator('[data-solana=toggle]').isDisabled(),false,'pause remains available during provider cooldown');
 const countdown=()=>page.locator('[data-solana=countdown]').innerText();
 const initialRetry=Number((await countdown()).match(/za (\d+) s/)[1]);
 await page.waitForFunction(previous=>{const text=document.querySelector('[data-solana=countdown]').textContent;return Number(text.match(/za (\d+) s/)?.[1])<previous;},initialRetry,{timeout:4000});
 const nextRetry=Number((await countdown()).match(/za (\d+) s/)[1]);
 assert.ok(initialRetry<=120&&initialRetry>=110&&nextRetry<initialRetry&&nextRetry>=105,'provider countdown uses the actual retry timestamp and keeps decreasing');
 state.automation.nextRunAt=new Date(Date.now()+240000).toISOString();
 await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 await page.waitForFunction(()=>Number(document.querySelector('[data-solana=countdown]').textContent.match(/za (\d+) s/)?.[1])>230);
 const automaticRetry=Number((await countdown()).match(/za (\d+) s/)[1]);
 assert.ok(automaticRetry<=240&&automaticRetry>=235,'enabled automation shows its later actual retry, rather than only the earlier provider cooldown');
 assert.equal(await page.locator('[data-solana=scan]').isDisabled(),true,'source cooldown continues blocking manual checks during the later automatic backoff');
 state.automation.nextRunAt=null;await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 await page.waitForFunction(()=>Number(document.querySelector('[data-solana=countdown]').textContent.match(/za (\d+) s/)?.[1])<125);
 const providerFallback=Number((await countdown()).match(/za (\d+) s/)[1]);
 assert.ok(providerFallback<=120&&providerFallback>=105,'missing automatic retry falls back to the provider cooldown');
 state.automation.nextRunAt=new Date(Date.now()+240000).toISOString();
 assert.equal(await page.locator('[data-solana=feed-title]').innerText(),'Poslední známé nálezy');
 assert.match(await page.locator('[data-solana=watch-summary]').innerText(),/^Starší data · načteno \d/);
 assert.equal(await page.locator('.solana-candidate[data-stale=true]').count(),20,'last known candidates remain visible during the outage');
 assert.equal(await page.locator('.solana-candidate.is-new').count(),0,'historical feed fallback does not animate as new discoveries');
 for(const index of [0,1,2]){
  const candidate=page.locator('.solana-candidate').nth(index);
  assert.equal(await candidate.locator('.solana-candidate-result').getAttribute('data-result'),'stale');
  assert.equal(await candidate.locator('.solana-candidate-result>span').innerText(),'Starší data');
  assert.doesNotMatch(await candidate.locator('.solana-candidate-name').innerText(),/Právě ověřujeme|Ve výběru pro další prověření|Dosavadní prověření prošlo|Znovu prověřeno/,'historical candidates do not appear currently active or freshly eligible');
 }
 for(const [width,height]of [[1440,900],[390,844],[375,640]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(60);
  const fit=await page.locator('.workspace').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,boxes:[...document.querySelectorAll('#solana-panel>*,.solana-story>*,.solana-stream-grid>section')].map(child=>({class:child.className,height:child.getBoundingClientRect().height,y:child.getBoundingClientRect().y}))}));
  assert.ok(fit.scroll<=fit.height+2,`rate-limit and historical-data notices fit ${width}x${height}: ${JSON.stringify(fit)}`);
  assert.equal(await page.locator('[data-solana=watch-summary]').isVisible(),true,'stale label remains visible on mobile');
  assert.equal(await page.locator('.solana-step').count(),6);
  const {event,activity}=await page.evaluate(()=>{const box=selector=>{const rect=document.querySelector(selector)?.getBoundingClientRect();return rect?{y:rect.y,height:rect.height}:null;};return {event:box('.solana-tail-row'),activity:box('.solana-live-tail')};});
  assert.ok(event&&event.y>=activity.y-1&&event.y+event.height<=activity.y+activity.height+1,`latest actual event remains visible during rate limiting at ${width}x${height}`);
 }
 state.positions=[{id:'solp_01234567890123456789012345678901',mint,symbol:'TEST',costUsdc:5,entryFeeUsdc:.01,markUsdc:5,markedAt:now()}];
 await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 assert.equal(await page.locator('[data-solana-close-position]').isDisabled(),false,'GeckoTerminal rate limiting does not block independent Jupiter position closes');
 state.positions=[];
 await page.locator('[data-solana=toggle]').click();
 await page.locator('[data-solana=toggle]').filter({hasText:'Spustit sledování'}).waitFor();
 assert.equal(await page.locator('[data-solana=toggle]').isDisabled(),false,'start remains available while the source cooldown persists');
 assert.match(await page.locator('[data-solana=story-text]').innerText(),/Sledování je pozastavené/);
 const pausedRetry=Number((await countdown()).match(/za (\d+) s/)[1]);
 assert.ok(pausedRetry<=120&&pausedRetry>=90,'paused monitoring shows the earliest provider retry instead of the previous automatic backoff');
 state.marketData={provider:'GeckoTerminal',rateLimited:false,retryAt:null};state.candidateFeed={stale:false,observedAt:now()};
 Object.assign(state,{candidates:beforeLimit.candidates,automation:beforeLimit.automation});
 await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 assert.equal(await page.locator('[data-solana=feed-title]').innerText(),'Objevené tokeny','fresh labels return when source data recovers');
 assert.equal(await page.locator('.solana-candidate[data-stale=true]').count(),0);
 assert.equal(await page.locator('[data-solana=scan]').isDisabled(),false);
 delete state.marketData;delete state.candidateFeed;
 await page.evaluate(()=>window.OceanSolanaPanel.refresh());
 assert.equal(await page.locator('[data-solana=scan]').isDisabled(),false,'older API snapshots without provider status retain compatible controls');
 assert.equal(await page.locator('[data-solana=feed-title]').innerText(),'Objevené tokeny');
 await page.setViewportSize({width:390,height:844});
 await page.locator('[data-solana="toggle"]').click();await page.locator('[data-solana="toggle"]').filter({hasText:'Pozastavit'}).waitFor();
 assert.deepEqual(JSON.parse(mutations.at(-1).body),{enabled:true});
 assert.equal(await page.locator('.solana-step[data-stage=scanner]').getAttribute('data-status'),'running');
 assert.equal(await page.locator('[data-solana="pipeline-caption"]').innerText(),'Právě probíhá','current work is distinguished from the last completed check');
 assert.equal(await page.locator('[data-solana="toggle"]').isDisabled(),false,'pause stays available during actual automatic work');
 state.runtime.stage='rug-check';state.runtime.detail='Ověřuji report konkrétního tokenu.';state.candidates[0].status='checking';
 await page.locator('.solana-step[data-stage="rug-check"][data-status=running]').waitFor();
 await page.locator('[data-solana="story-text"]').filter({hasText:state.runtime.detail}).waitFor();
 assert.ok(polls>0,'live updates poll server state');
 await page.locator('[data-solana="toggle"]').click();await page.locator('[data-solana="engine-status"]').filter({hasText:'Pozastaveno'}).waitFor();
 assert.deepEqual(JSON.parse(mutations.at(-1).body),{enabled:false});
 assert.equal(await page.locator('.solana-step[data-status=running]').count(),0,'paused work has no active stage');
 assert.equal(await page.locator('[data-solana="pipeline-caption"]').innerText(),'Průběh poslední kontroly','paused stages describe the previous check');
 assert.equal(await page.locator('.solana-tail-row').first().isVisible(),true,'previous actual events remain visible when paused');
 await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/solana/cycle'&&response.request().method()==='POST'),page.locator('[data-solana="scan"]').click()]);assert.equal(mutations.at(-1).path,'/api/solana/cycle','manual check is available directly on the dashboard');
 await page.locator('[data-solana-open=activity]').click();assert.equal(await page.locator('[data-solana=activity] script').count(),0);assert.equal(await page.locator('[data-solana=cycle-rejections] li').count(),2);assert.match(await page.locator('[data-solana=cycle-rejections]').innerText(),/mohou překrývat/);await page.keyboard.press('Escape');
 await page.locator('[data-solana-open=ledger]').click();await page.locator('[data-solana=decisions] .solana-evidence').click();assert.match(await page.locator('[data-solana=decisions] .solana-evidence pre').innerText(),/999999999999999999/);await page.keyboard.press('Escape');
 state.positions=[{id:'solp_01234567890123456789012345678901',mint,symbol:'TEST',costUsdc:5,entryFeeUsdc:.01,markUsdc:null,markError:'Kotace chybí',markedAt:now()}];state.equityUsdc=null;
 await page.locator('[data-solana=pnl]').filter({hasText:'Neověřeno'}).waitFor();
 await page.locator('[data-solana-close-position]').click();await page.locator('[data-solana=positions] .solana-no-trades').waitFor();assert.match(mutations.at(-1).path,/\/positions\/.*\/close$/);
 await page.locator('#trading-tab').click();const before=polls;await page.waitForTimeout(2300);assert.equal(polls,before,'hidden panel stops polling');
 await page.goto('http://ocean.test/solana.html');await page.waitForURL('**/#solana');await page.locator('[data-solana=cash]').filter({hasText:'100,00'}).waitFor();
 allowed=false;await page.goto('http://ocean.test/?no-pilot#solana');await page.locator('#dashboard').waitFor({state:'visible'});assert.equal(await page.locator('#solana-tab').isVisible(),false);assert.equal(await page.locator('#solana-workspace').isVisible(),false);
 assert.deepEqual(errors,[]);console.log('PASS integrated Solana: visible six-stage work, actual events and rejection reasons, provider rate-limit countdown and controls, historical feed labels and recovery, responsive fit, real progress polling, start/pause, independent closes, XSS, evidence, stale marks, hidden polling and legacy redirect.');
}finally{await browser.close();}
