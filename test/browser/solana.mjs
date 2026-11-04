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
 for(const [width,height]of [[1920,1080],[1440,900],[1280,720],[901,768],[900,768],[390,844],[390,680],[375,640],[320,568]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(60);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}x${height}: no horizontal overflow`);
  assert.equal(await page.locator('.solana-step').count(),6);
  assert.equal(await page.locator('.solana-pipeline').isVisible(),false,'technical steps are tucked into a detail');
  assert.equal(await page.locator('.solana-live-tail').isVisible(),false,'logs do not dominate the main screen');
  assert.equal(await page.locator('.solana-story').isVisible(),true);
  assert.equal(await page.locator('.home-tabs').isVisible(),width<=900);
  const radar=await page.locator('.solana-stream').boundingBox(),positions=await page.locator('.solana-open-positions').boundingBox();
  assert.ok(width>900?positions.x>radar.x:positions.y>=radar.y+radar.height-1,'desktop has two columns; mobile stacks its sections');
  if(width>=375&&height>=640){const fit=await page.locator('.workspace').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,panel:[...document.querySelector('#solana-panel').children].map(child=>[child.className,Math.round(child.getBoundingClientRect().height)])}));assert.ok(fit.scroll<=fit.height+2,`panel fits ${width}x${height}: ${JSON.stringify(fit)}`);}
  if(width===1440||width===390)await page.screenshot({path:`/tmp/ocean-solana-integrated-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('.solana-candidate').first().click();
 assert.equal(await page.locator('[data-solana-dialog=candidate]').isVisible(),true);
 assert.equal(await page.locator('[data-solana=candidate-detail] script,[data-solana=candidate-detail] img').count(),0);
 assert.match(await page.locator('[data-solana=candidate-detail]').innerText(),/málo prostředků/);
 await page.keyboard.press('Escape');
 await page.locator('[data-solana="toggle"]').click();await page.locator('[data-solana="toggle"]').filter({hasText:'Pozastavit'}).waitFor();
 assert.deepEqual(JSON.parse(mutations.at(-1).body),{enabled:true});
 await page.locator('[data-solana-open=technical]').click();
 assert.equal(await page.locator('.solana-pipeline').isVisible(),true,'six steps remain available on demand');
 assert.equal(await page.locator('.solana-step[data-stage=scanner]').getAttribute('data-status'),'running');
 assert.equal(await page.locator('[data-solana="toggle"]').isDisabled(),false,'pause stays available during actual automatic work');
 state.runtime.stage='rug-check';state.runtime.detail='Ověřuji report konkrétního tokenu.';state.candidates[0].status='checking';
 await page.locator('.solana-step[data-stage="rug-check"][data-status=running]').waitFor();
 assert.ok(polls>0,'live updates poll server state');
 await page.keyboard.press('Escape');
 await page.locator('[data-solana="toggle"]').click();await page.locator('[data-solana="engine-status"]').filter({hasText:'Pozastaveno'}).waitFor();
 assert.deepEqual(JSON.parse(mutations.at(-1).body),{enabled:false});
 await page.locator('[data-solana-open=technical]').click();await page.locator('[data-solana-open=activity]').click();assert.equal(await page.locator('[data-solana=activity] script').count(),0);await page.keyboard.press('Escape');
 await page.locator('[data-solana-open=ledger]').click();await page.locator('[data-solana=decisions] .solana-evidence').click();assert.match(await page.locator('[data-solana=decisions] .solana-evidence pre').innerText(),/999999999999999999/);await page.keyboard.press('Escape');
 state.positions=[{id:'solp_01234567890123456789012345678901',mint,symbol:'TEST',costUsdc:5,entryFeeUsdc:.01,markUsdc:null,markError:'Kotace chybí',markedAt:now()}];state.equityUsdc=null;
 await page.locator('[data-solana=pnl]').filter({hasText:'Neověřeno'}).waitFor();
 await page.locator('[data-solana-close-position]').click();await page.locator('[data-solana=positions] .solana-no-trades').waitFor();assert.match(mutations.at(-1).path,/\/positions\/.*\/close$/);
 await page.locator('#trading-tab').click();const before=polls;await page.waitForTimeout(2300);assert.equal(polls,before,'hidden panel stops polling');
 await page.goto('http://ocean.test/solana.html');await page.waitForURL('**/#solana');await page.locator('[data-solana=cash]').filter({hasText:'100,00'}).waitFor();
 allowed=false;await page.goto('http://ocean.test/?no-pilot#solana');await page.locator('#dashboard').waitFor({state:'visible'});assert.equal(await page.locator('#solana-tab').isVisible(),false);assert.equal(await page.locator('#solana-workspace').isVisible(),false);
 assert.deepEqual(errors,[]);console.log('PASS integrated Solana: mobile tabs, friendly desktop overview, expandable technical details, real progress polling, start/pause, XSS, precise evidence, stale marks, hidden polling and legacy redirect.');
}finally{await browser.close();}
