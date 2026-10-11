// Optional browser check; install Playwright separately or supply its module path.
const { chromium } = await import(process.env.OCEAN_PLAYWRIGHT_MODULE || 'playwright');
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../../public', import.meta.url).pathname;
const now=new Date().toISOString();
const positions=[{symbol:'BTCUSDC',inPosition:true,entryPrice:86450,quantity:.0002,protectionActive:true,protectionStatus:'ACTIVE',protectionPrice:77805,protectionActivationPrice:89043,protectionTrailingBips:150},{symbol:'ETHUSDC',inPosition:false}];
const costs={status:'verified',reason:'VERIFIED',netPnl:.00685974,grossPnl:.026376,allocatedEntryCost:10.2571262,netProceeds:10.26398594,residualQuantity:.00009591,residualCost:.2342288,entryFees:[{asset:'ETH',amount:.00000409}],exitFees:[{asset:'USDC',amount:.00976006}]};
const closed={symbol:'ETHUSDC',action:'CLOSED',at:now,exitedAt:now,reason:'Uživatel ručně uzavřel pozici.',entryPrice:2439.85,exitPrice:2446.13,quantity:.0042,grossPnl:.026376,costs};
const fixture={environment:'mainnet',status:'waiting',entriesPaused:false,tradingPaused:false,updatedAt:now,lastMarketCheckAt:now,nextCheckAt:now,lastError:null,
 balance:{asset:'USDC',amount:26.98,updatedAt:now,error:null},holdings:{stale:false,capturedAt:now,assets:[{asset:'BTC',quantity:.00036939,price:83000,value:30.66},{asset:'ETH',quantity:.00577461,price:2506,value:14.47},{asset:'SOL',quantity:.12763535,price:109.6,value:13.99}]},
 positions,lastTrade:closed,limits:{dailyLoss:0,weeklyLoss:0},transparency:{strategyStatus:'ACTIVE',safeMode:false,reconciliation:{status:'OK',checkedAt:now,issues:[]},trades:[closed],decisions:[{symbol:'BTCUSDC',checkedAt:now,nextCheckAt:now,marketRegime:'BULL',decision:'HOLD',reason:'Pozice je chráněná.',price:83000,emaFast:82000,emaSlow:81000,risk:{stopLossPct:10,maxOrderQuote:50,dailyLossLimit:5,weeklyLossLimit:15}}]},
 dca:{enabled:true,amount:5,symbols:['BTCUSDC','ETHUSDC','SOLUSDC'],statusText:'Nákupy dokončeny · další termín v neděli',totalInvested:15,purchaseCount:3,purchases:[{symbol:'BTCUSDC',amount:5,quantity:.00006,at:now},{symbol:'ETHUSDC',amount:5,quantity:.002,at:now},{symbol:'SOLUSDC',amount:5,quantity:.045,at:now}]},streak:{enabled:false,status:'READY',streak:0,netPnl:0},events:[]};
const browser=await chromium.launch({headless:true,executablePath:process.env.OCEAN_CHROMIUM_PATH,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
const mutations=[];
let failPlanSave=false;
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.hostname!=='ocean.test') return route.abort();
 const path=url.pathname;
 if(path.startsWith('/api/')) {
   let body={}; let status=200;
   if(path==='/api/me') body={user:{username:'Preview',displayId:'0001',email:'preview@example.com',emailVerified:true,accessApproved:true,role:'member'}};
   else if(path==='/api/kryptotron/connection') body={connection:{status:'connected',mainnetAvailable:true}};
   else if(path==='/api/kryptotron') body={kryptotron:fixture};
   else if(path==='/api/kryptotron/control') {const data=route.request().postDataJSON();mutations.push({path,...data});if(data.scope==='trading')fixture.tradingPaused=data.entriesPaused;else fixture.entriesPaused=data.entriesPaused;body=data;}
   else if(path==='/api/kryptotron/dca/control'){const data=route.request().postDataJSON();mutations.push({path,...data});fixture.dca.enabled=data.enabled;body=data;}
   else if(path==='/api/kryptotron/dca/settings') {
     const data=route.request().postDataJSON(); mutations.push({path,...data});
     if(failPlanSave){status=502;body={error:'Nastavení se nepodařilo uložit.'};}
     else {fixture.dca.plans=Object.entries(data.amounts).map(([symbol,amount])=>({symbol,amount,frequency:data.frequency,configuredAt:now}));body={plans:fixture.dca.plans};}
   }
   else {status=404;body={error:'No preview data'};}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 }
 try {const file=path==='/'?'/index.html':path;const data=await readFile(root+file); const ext=file.split('.').pop();return route.fulfill({contentType:({html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',woff2:'font/woff2',png:'image/png'})[ext]||'application/octet-stream',body:data});}catch{return route.fulfill({status:404,body:''});}
});
await page.goto('http://ocean.test/#home');
await page.locator('#trading-net-result').filter({hasText:'+0,0069'}).waitFor();
const fit = async label => {
 const geometry=await page.evaluate(()=>Object.fromEntries(['.workspace','.portfolio-surface','#dca-workspace','#trading-workspace'].map(selector=>{
  const el=document.querySelector(selector);return [selector,{height:el.clientHeight,scroll:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth}];
 })));
 for(const [selector,bounds] of Object.entries(geometry)){
  assert.ok(bounds.scroll<=bounds.height+1,`${label} ${selector} vertical: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollWidth<=bounds.width+1,`${label} ${selector} horizontal: ${JSON.stringify(bounds)}`);
 }
 const cardsFit=await page.locator('.asset-card').evaluateAll(cards=>cards.every(card=>{
  const bounds=card.getBoundingClientRect();
  return [...card.children].every(child=>child.getBoundingClientRect().bottom<=bounds.bottom-8);
 }));
 assert.ok(cardsFit,`${label} asset text must stay inside its card`);
 const slidersFit=await page.locator('.dca-amount-row').evaluateAll(rows=>rows.every(row=>{
  const slider=row.querySelector('input').getBoundingClientRect();
  const values=row.querySelector('.dca-row-values').getBoundingClientRect();
  return slider.right<values.left && [...row.querySelectorAll('.dca-slider-ticks button')].every((button,index)=>{
   const bounds=button.getBoundingClientRect();
   return Math.abs(bounds.x+bounds.width/2-(slider.x+8+(slider.width-16)*index/4))<1;
  });
 }));
 assert.ok(slidersFit,`${label} slider stops align and stay beside valuation`);
};
for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,768]]){
 await page.setViewportSize({width,height});
 assert.equal(await page.locator('#dca-workspace').isVisible(),true);
 assert.equal(await page.locator('#trading-workspace').isVisible(),true);
 assert.equal(await page.locator('.home-tabs').isVisible(),false);
 await fit(`${width}x${height}`);
 const [dca,trading]=await Promise.all([page.locator('#dca-workspace').boundingBox(),page.locator('#trading-workspace').boundingBox()]);
 assert.ok(Math.abs(dca.width-trading.width)<2);assert.ok(dca.x<trading.x);
 if(width===1366)await page.screenshot({path:'/tmp/ocean-home-split-desktop.png'});
}
await page.setViewportSize({width:1440,height:900});
assert.equal(await page.locator('#asset-grid .asset-card').count(),4);
assert.equal(await page.locator('#asset-grid .asset-card').nth(1).locator('strong').innerText(),'0,00036939');
assert.equal(await page.locator('#dca-workspace .workspace-note,#dca-workspace .workspace-metrics').count(),0);
assert.equal(await page.locator('#dca-workspace fieldset').count(),1);
assert.equal(await page.locator('#dca-assets input[type=range]').count(),3);
const btc=page.locator('.dca-amount-row[data-symbol="BTCUSDC"]');
const sol=page.locator('.dca-amount-row[data-symbol="SOLUSDC"]');
assert.equal(await btc.locator('.dca-slider-ticks button').count(),5);
assert.equal(await btc.locator('.dca-asset-invested').textContent(),'5,00 USDC');
assert.equal(await btc.locator('.dca-asset-current').textContent(),'≈ 4,98 USDC');
assert.equal(await page.locator('#dca-workspace #dca-invested').textContent(),'15,00 USDC');
assert.equal(await page.locator('#dca-workspace #dca-current-value').textContent(),'≈ 14,92 USDC');
assert.equal(await page.locator('#dca-detail-dialog .dca-row-values,#dca-detail-dialog .dca-totals').count(),0);
for(const amount of [5,10,20,50,100]){
 await btc.locator('.dca-slider-ticks button').filter({hasText:new RegExp(`^${amount}$`)}).click();
 assert.equal(await btc.locator('output').textContent(),`${amount} USDC`);
}
const range=await btc.locator('input').boundingBox();
await page.mouse.move(range.x+range.width-8,range.y+range.height/2);await page.mouse.down();
await page.mouse.move(range.x+8,range.y+range.height/2,{steps:12});await page.mouse.up();
assert.equal(await btc.locator('output').textContent(),'5 USDC');
assert.equal(await btc.locator('.dca-asset-invested').textContent(),'5,00 USDC','editing future purchases must not change historical cost');
await btc.locator('input').focus();await btc.locator('input').press('ArrowRight');
assert.equal(await btc.locator('output').textContent(),'10 USDC');
await page.evaluate(()=>loadKryptotron());
assert.equal(await btc.locator('input').evaluate(el=>el===document.activeElement),true);
assert.equal(await btc.locator('output').textContent(),'10 USDC');
await page.locator('#dca-frequency label').filter({hasText:'Denně'}).click();
assert.equal(mutations.length,0);
await page.locator('#dca-save').click();
await page.locator('#dca-settings-feedback').filter({hasText:'Uloženo'}).waitFor();
assert.deepEqual(mutations[0],{path:'/api/kryptotron/dca/settings',amounts:{BTCUSDC:10,ETHUSDC:5,SOLUSDC:5},frequency:'daily'});
assert.ok(fixture.dca.plans.every(p=>p.frequency==='daily'));
await page.evaluate(()=>loadKryptotron());
assert.equal(await btc.locator('output').textContent(),'10 USDC');
assert.equal(await page.locator('#dca-frequency input:checked').inputValue(),'daily');
failPlanSave=true;
await page.setViewportSize({width:1280,height:720});
await sol.locator('.dca-slider-ticks button').filter({hasText:/^50$/}).click();
await page.locator('#dca-frequency label').filter({hasText:'Měsíčně'}).click();
await page.locator('#dca-save').click();
await page.locator('#dca-settings-feedback').filter({hasText:'nepodařilo'}).waitFor();
await fit('failed save at 1280x720');
assert.equal(fixture.dca.plans[2].amount,5);
assert.ok(fixture.dca.plans.every(p=>p.frequency==='daily'));
assert.equal(await sol.locator('output').textContent(),'50 USDC');
await page.locator('#dca-cancel').click();
assert.equal(await sol.locator('output').textContent(),'5 USDC');
assert.equal(await page.locator('#dca-frequency input:checked').inputValue(),'daily');
failPlanSave=false;
await page.locator('#trading-control').click();
await page.waitForFunction(()=>document.querySelector('#trading-control').textContent==='Povolit vstupy');
assert.equal(fixture.dca.enabled,true);assert.equal(fixture.entriesPaused,false);
await page.locator('#dca-control').click();
await page.waitForFunction(()=>document.querySelector('#dca-control').getAttribute('aria-checked')==='false');
assert.equal(fixture.tradingPaused,true);assert.equal(fixture.entriesPaused,false);
await page.locator('[data-dialog="trading-history-dialog"]').click();
await page.locator('.trade-history-item summary').click();
assert.match(await page.locator('.trade-history-item').innerText(),/Zbytek zůstává majetkem/);
await page.locator('#trading-history-dialog [data-close-dialog]').click();
await page.locator('[data-dialog="dca-detail-dialog"]').click();
assert.equal(await page.locator('#dca-purchases .purchase-row').count(),3);
await page.locator('#dca-detail-dialog [data-close-dialog]').click();
fixture.lastTrade.costs={status:'unverified',reason:'UNAVAILABLE',netPnl:null};fixture.holdings.stale=true;
await page.evaluate(()=>loadKryptotron());
assert.equal(await page.locator('#trading-net-result').textContent(),'Neověřeno');
assert.equal(await page.locator('#dca-current-value').textContent(),'—');
assert.equal(await btc.locator('.dca-asset-current').textContent(),'—');
fixture.lastTrade.costs=costs;fixture.holdings.stale=false;fixture.tradingPaused=false;fixture.dca.enabled=true;
await page.evaluate(()=>loadKryptotron());
for(const width of [390,320,768]){
 await page.setViewportSize({width,height:844});
 for(const name of ['trading','dca']){
  await page.locator('#'+name+'-tab').click();
  assert.equal(await page.locator('#'+name+'-workspace').isVisible(),true);
  assert.equal(await page.locator('#'+(name==='dca'?'trading':'dca')+'-workspace').isVisible(),false);
  assert.equal(await page.locator('#asset-grid').isVisible(),true);
  const overflow=await page.evaluate(()=>[document.documentElement.scrollWidth>innerWidth,...[...document.querySelectorAll('.workspace,.portfolio-surface,.home-pane:not([hidden])')].map(e=>e.scrollWidth>e.clientWidth+1)].some(Boolean));
  assert.equal(overflow,false,`overflow at ${width} / ${name}`);
  if(width===390)await page.screenshot({path:`/tmp/ocean-home-split-${name}-mobile.png`});
 }
 await page.locator('#dca-tab').press('ArrowLeft');
 assert.equal(await page.locator('#trading-tab').evaluate(el=>el===document.activeElement),true);
}
await page.setViewportSize({width:1366,height:768});
await page.locator('#trading-workspace').waitFor({state:'visible'});
await page.locator('#dca-workspace').waitFor({state:'visible'});
assert.equal(await page.locator('#dca-workspace').isVisible(),true);
assert.equal(await page.locator('#trading-workspace').isVisible(),true);
await fit('resize back to desktop');
fixture.positions=[];fixture.lastTrade=null;fixture.transparency.trades=[];fixture.dca.purchases=[];fixture.dca.totalInvested=0;
await page.evaluate(()=>loadKryptotron());
assert.match(await page.locator('#dca-purchases').textContent(),/Zatím žádné/);
assert.equal(await page.locator('#dca-current-value').textContent(),'0,00 USDC');
assert.equal(await btc.locator('.dca-asset-invested').textContent(),'0,00 USDC');
assert.equal(await page.locator('#trading-net-result').textContent(),'—');
assert.deepEqual(errors,[]);
console.log('PASS: equal desktop halves without scroll at 5 sizes; mobile tabs; shared interval and independent amounts; atomic saves, failed-save recovery, draft focus, pointer clicks/drag, aligned slider stops, per-asset values and totals, dialogs, controls, stale/empty data.');
await browser.close();
