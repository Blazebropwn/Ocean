// Read-only browser fixtures. Never contacts market APIs or sends real transactions.
const { chromium } = await import(process.env.OCEAN_PLAYWRIGHT_MODULE || 'playwright');
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../../public', import.meta.url).pathname;
const now = new Date().toISOString();
const mint = 'So11111111111111111111111111111111111111112';
const state = {
 mode:'PAPER',initialUsdc:100,cashUsdc:94.99,equityUsdc:99.82,realizedPnlUsdc:0,unrealizedPnlUsdc:-.18,
 limits:{maxPositionUsdc:5,maxOpenPositions:3,maxExposureUsdc:15,minLiquidityUsd:50000,minVolume5mUsd:1000,maxHolderPct:20,minLiquidityLockedPct:95,slippageBps:100,networkFeeUsdc:.01},
 stages:['scanner','rug-check','sizer','executor','logger','equity'].map(id=>({id,status:'ok',detail:'Ověřeno skutečnými vstupy; důvody jsou uložené v evidenci.'})),
 positions:[{id:'solp_01234567890123456789012345678901',mint,symbol:'<img src=x onerror=alert(1)>',tokenAmount:'999999999999999999',costUsdc:5,entryFeeUsdc:.01,openedAt:now,markUsdc:4.83,markedAt:now,markError:null}],
 trades:[{id:'trade1',positionId:'position1',side:'BUY',tokenAmount:'999999999999999999',grossUsdc:5,networkFeeUsdc:.01,occurredAt:now}],
 decisions:[{sequence:1,stage:'executor',status:'ok',mint,reason:'PAPER nákup <script>alert(1)</script>',evidence:{rawAmount:'999999999999999999',malicious:'<img src=x onerror=alert(1)>'},occurredAt:now}],
 lastCycle:{id:'cycle',startedAt:now,completedAt:now,status:'completed'},nextCycleAt:null,asOf:now
};
const browser=await chromium.launch({headless:true,executablePath:process.env.OCEAN_CHROMIUM_PATH,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[],mutations=[];
let allowed=true, denied=false;
page.on('pageerror',error=>errors.push(String(error)));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.hostname!=='ocean.test') return route.abort();
 const path=url.pathname;
 if(path.startsWith('/api/')) {
  if(path==='/api/me') return route.fulfill({contentType:'application/json',body:JSON.stringify({user:{features:{solanaTerminal:allowed}}})});
  if(denied) return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Nedostupné'})});
  if(route.request().method()==='POST'){
   mutations.push({path,body:route.request().postData()});
   if(path.endsWith('/close')) {state.positions=[];state.cashUsdc=99.82;state.equityUsdc=99.82;}
   state.nextCycleAt=new Date(Date.now()+60000).toISOString();
  }
  return route.fulfill({contentType:'application/json',body:JSON.stringify(state)});
 }
 try {const data=await readFile(root+path);return route.fulfill({contentType:({html:'text/html',css:'text/css',js:'text/javascript'})[path.split('.').pop()]||'application/octet-stream',body:data});}
 catch {return route.fulfill({status:404,body:''});}
});
try {
 await page.goto('http://ocean.test/solana.html');
 await page.locator('#terminal').waitFor({state:'visible'});
 assert.equal(mutations.length,0,'opening page never scans or trades');
 assert.match(await page.locator('#equity').innerText(),/99,82/);
 assert.equal(await page.locator('#positions img,#positions script').count(),0,'untrusted token labels are text');
 for(const [width,height] of [[1440,900],[1280,720],[768,1024],[390,844],[390,680],[375,640],[320,568]]) {
  await page.setViewportSize({width,height});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflow,false,`${width}x${height}: no horizontal overflow`);
  assert.equal(await page.locator('[data-stage]').count(),6);
  if(width===390||width===1440) await page.screenshot({path:`/tmp/ocean-solana-${width}.png`,fullPage:true});
 }
 await page.locator('[data-open="ledger-dialog"]').click();
 await page.locator('#decisions details').click();
 assert.match(await page.locator('#decisions pre').innerText(),/999999999999999999/,'raw amounts preserve integer precision');
 assert.equal(await page.locator('#decisions img,#decisions script').count(),0,'evidence is escaped');
 await page.keyboard.press('Escape');
 await page.locator('[data-open="rules-dialog"]').click();
 assert.match(await page.locator('#rules-list').innerText(),/95 %/);
 await page.keyboard.press('Escape');
 state.positions[0].markUsdc=null; state.positions[0].markError='Kotace není dostupná';state.equityUsdc=null;
 await page.reload();await page.locator('#pnl').filter({hasText:'Neověřeno'}).waitFor();
 assert.equal(await page.locator('#equity').innerText(),'—');
 assert.match(await page.locator('#positions').innerText(),/Prodejní kotace chybí/);
 await page.locator('[data-close-position]').click();
 await page.locator('#feedback').filter({hasText:'Vyhodnocení uloženo'}).waitFor();
 assert.equal(mutations.at(-1).path,`/api/solana/positions/solp_01234567890123456789012345678901/close`);
 assert.equal(mutations.at(-1).body,null);
 assert.equal(await page.locator('#scan').isDisabled(),true,'persisted cooldown visible');
 state.nextCycleAt=null;
 await page.reload();await page.locator('#scan').waitFor();await page.locator('#scan').click();
 await page.locator('#feedback').filter({hasText:'Vyhodnocení uloženo'}).waitFor();
 assert.equal(mutations.at(-1).path,'/api/solana/cycle');
 allowed=false;await page.reload();
 await page.locator('#access-message').waitFor({state:'visible'});
 assert.equal(await page.locator('#terminal').isVisible(),false);
 assert.match(await page.locator('#access-message').innerText(),/pouze/);
 allowed=true;denied=true;await page.reload();
 await page.locator('#access-message').waitFor({state:'visible'});
 assert.equal(await page.locator('#terminal').isVisible(),false,'server gate respected even with stale feature flag');
 assert.deepEqual(errors,[]);
 console.log('Solana browser checks passed (viewports, XSS, unpriced equity, mutations, cooldown, access).');
} finally {await browser.close();}
