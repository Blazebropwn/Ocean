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
let failPlanSave=false, connectionStatus='connected', legacy=false, rejectDisconnect=false, failSnapshot=false;
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.hostname!=='ocean.test') return route.abort();
 const path=url.pathname;
 if(path.startsWith('/api/')) {
   let body={}; let status=200;
   if(path==='/api/me') body={user:{username:'deepHunter',displayId:'0001',email:'preview@example.com',emailVerified:true,accessApproved:true,role:'member'}};
   else if(path==='/api/kryptotron/connection') {
     if(route.request().method()==='DELETE') {mutations.push({path,method:'DELETE'});if(rejectDisconnect){status=409;body={error:'Odpojení blokuje otevřená pozice.'};}else{connectionStatus='unconfigured';body={};}}
     else if(route.request().method()==='POST') {mutations.push({path,...route.request().postDataJSON()});connectionStatus='provisioning';body={};}
     else body={connection:{status:connectionStatus,mainnetAvailable:true,legacy}};
   }
   else if(path==='/api/kryptotron') {if(failSnapshot){status=503;body={error:'Unavailable'};}else body={kryptotron:fixture};}
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
try {
await page.goto('http://ocean.test/#home');
await page.waitForFunction(()=>document.querySelector('#trading-toggle-status').textContent==='Zapnuto');
const fit = async label => {
 const overflow=await page.evaluate(()=>[document.documentElement,...document.querySelectorAll('.workspace,.portfolio-surface,.home-pane:not([hidden])')].some(el=>el.scrollWidth>el.clientWidth+1));
 assert.equal(overflow,false,`${label}: horizontal overflow`);
};
for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,768],[390,844],[320,568],[768,1024]]){
 await page.setViewportSize({width,height});
 for(const name of ['home','trading','dca']){
  await page.locator('#'+name+'-tab').click();
  for(const id of ['home','trading','dca'])assert.equal(await page.locator('#'+id+'-workspace').isVisible(),id===name);
  await page.evaluate(()=>loadKryptotron());
  assert.equal(await page.locator('#'+name+'-tab').getAttribute('aria-selected'),'true');
  await fit(`${width}x${height}/${name}`);
 }
 await page.locator('#home-tab').click();
 const cards=await page.locator('.asset-card').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};}));
 assert.equal(cards.length,4);
 assert.ok(cards.every(c=>Math.abs(c.width-cards[0].width)<1&&Math.abs(c.height-cards[0].height)<1));
 assert.equal(cards[0].y,cards[1].y);assert.equal(cards[2].y,cards[3].y);assert.ok(cards[2].y>cards[0].y);
 const nav=await page.locator('.side-nav').boundingBox();
 assert.ok(cards[2].bottom<=nav.y&&nav.y-cards[2].bottom<32,`cards use available height ${width}x${height}: ${JSON.stringify({cards,nav})}`);
 const contained=await page.locator('.asset-card').evaluateAll(cards=>cards.every(card=>[...card.children].every(child=>{const a=card.getBoundingClientRect(),b=child.getBoundingClientRect();return b.right<=a.right&&b.bottom<=a.bottom;})));
 assert.ok(contained,'values remain inside cards');
 if(width===390||width===1440)await page.screenshot({path:`/tmp/ocean-home-redesign-${width}.png`});
}
assert.equal(await page.locator('.home-summaries,.overview-footer,#more-dialog,#tools-dialog').count(),0);
assert.equal(await page.locator('#nav-username').textContent(),'DeepHunter');
assert.equal(await page.locator('#menu-username').textContent(),'DeepHunter');
await page.locator('#home-tab').press('ArrowLeft');assert.equal(await page.locator('#dca-tab').getAttribute('aria-selected'),'true');
await page.locator('#dca-tab').press('Home');assert.equal(await page.locator('#home-tab').getAttribute('aria-selected'),'true');
await page.locator('#trading-tab').click();await page.locator('.position-row').click();
assert.equal(await page.locator('#bot-current-value').textContent(),'≈ 16,60 USDC');
assert.equal(await page.locator('#bot-current-pnl').textContent(),'-0,69 USDC');
assert.doesNotMatch(await page.locator('#position-dialog').innerText(),/ETH|Poslední obchod/);
await page.locator('#position-dialog [data-close-dialog]').click();
await page.locator('#trading-control').click();
await page.waitForFunction(()=>document.querySelector('#trading-toggle-status').textContent==='Vypnuto');
assert.equal(fixture.dca.enabled,true);assert.equal(fixture.entriesPaused,false);
await page.locator('#dca-tab').click();
const btc=page.locator('.dca-amount-row[data-symbol="BTCUSDC"]');
assert.equal(await btc.locator('.dca-asset-invested').textContent(),'5,00 USDC');
assert.equal(await btc.locator('.dca-asset-current').textContent(),'≈ 4,98 USDC');
assert.equal(await page.locator('#dca-current-value').textContent(),'≈ 14,92 USDC');
assert.equal(await page.locator('#dca-edit-actions').isVisible(),false);
for(const amount of [5,10,20,50,100]){
 await btc.locator('.dca-slider-ticks button').filter({hasText:new RegExp(`^${amount}$`)}).click();
 assert.equal(await btc.locator('output').textContent(),`${amount} USDC`);
}
await btc.locator('input').focus();await btc.locator('input').press('Home');await btc.locator('input').press('ArrowRight');
await page.evaluate(()=>loadKryptotron());
assert.equal(await btc.locator('input').evaluate(el=>el===document.activeElement),true);
assert.equal(await btc.locator('output').textContent(),'10 USDC');
await page.locator('#dca-frequency label').filter({hasText:'Denně'}).click();
await page.locator('#dca-save').click();await page.locator('#dca-settings-feedback').filter({hasText:'Uloženo'}).waitFor();
assert.deepEqual(mutations.at(-1),{path:'/api/kryptotron/dca/settings',amounts:{BTCUSDC:10,ETHUSDC:5,SOLUSDC:5},frequency:'daily'});
failPlanSave=true;
await btc.locator('.dca-slider-ticks button').filter({hasText:/^50$/}).click();
await page.locator('#dca-save').click();await page.locator('#dca-settings-feedback').filter({hasText:'nepodařilo'}).waitFor();
assert.equal(fixture.dca.plans[0].amount,10);assert.equal(await btc.locator('output').textContent(),'50 USDC');
await page.locator('#dca-cancel').click();assert.equal(await btc.locator('output').textContent(),'10 USDC');
await page.locator('#dca-control').click();await page.waitForFunction(()=>document.querySelector('#dca-control').getAttribute('aria-checked')==='false');
assert.equal(fixture.tradingPaused,true);assert.equal(fixture.entriesPaused,false);
fixture.holdings.stale=true;await page.evaluate(()=>loadKryptotron());
assert.equal(await page.locator('#dca-current-value').textContent(),'—');
await page.locator('#home-tab').click();assert.match(await page.locator('#asset-grid').innerText(),/Čekám na aktualizaci/);
fixture.holdings.stale=false;fixture.holdings.assets[0].quantity=.12345678;await page.evaluate(()=>loadKryptotron());
assert.equal(await page.locator('#asset-grid .asset-card').nth(1).locator('strong').textContent(),'0,12345678');
failSnapshot=true;await page.evaluate(()=>loadKryptotron());assert.match(await page.locator('#asset-grid').innerText(),/Aktualizace nedostupná/);
failSnapshot=false;await page.evaluate(()=>loadKryptotron());
await page.locator('#profile-button').click();await page.locator('[data-dialog="account-settings-dialog"]').click();
await page.locator('[data-dialog="connected-accounts-dialog"]').click();await page.locator('[data-dialog="binance-dialog"]').click();
assert.match(await page.locator('#binance-dialog').innerText(),/Ostrý provoz/);
assert.equal(await page.locator('#connection-form').isVisible(),false);
assert.equal(await page.locator('#disconnect-binance').isVisible(),true);
page.once('dialog',dialog=>dialog.dismiss());await page.locator('#disconnect-binance').click();
assert.equal(mutations.filter(m=>m.method==='DELETE').length,0);
rejectDisconnect=true;page.once('dialog',dialog=>dialog.accept());await page.locator('#disconnect-binance').click();
await page.locator('#disconnect-message').filter({hasText:'blokuje otevřená pozice'}).waitFor();assert.equal(connectionStatus,'connected');
legacy=true;await page.evaluate(()=>initializeKryptotron());assert.equal(await page.locator('#disconnect-binance').isVisible(),false);
legacy=false;await page.evaluate(()=>initializeKryptotron());
await page.locator('#binance-dialog [data-close-dialog]').click();
fixture.entriesPaused=true;fixture.transparency.safeMode=true;fixture.transparency.reconciliation.status='UNCERTAIN';
await page.evaluate(()=>loadKryptotron());assert.equal(await page.locator('#trading-control').isDisabled(),true);
await page.locator('#trading-tab').click();await page.locator('.position-row').click();
assert.equal(await page.locator('#bot-protection').textContent(),'Neověřeno');await page.locator('#position-dialog [data-close-dialog]').click();
await page.locator('[data-dialog="strategy-dialog"]').click();assert.equal(await page.locator('#streak-control').isVisible(),true);
await page.locator('[data-dialog="activity-dialog"]').click();assert.equal(await page.locator('#activity-dialog').evaluate(el=>el.open),true);
await page.locator('#activity-dialog [data-close-dialog]').click();
await page.locator('.side-link[data-view="vault"]').click();assert.equal(await page.locator('#agent-card').isVisible(),true);
await page.locator('.side-link[data-view="overview"]').click();
await page.setViewportSize({width:320,height:320});await page.locator('#home-tab').click();await fit('short viewport');
await page.locator('.asset-card').last().scrollIntoViewIfNeeded();
const last=await page.locator('.asset-card').last().boundingBox(),bottom=await page.locator('.side-nav').boundingBox();
assert.ok(last.y+last.height<=bottom.y,'short screen can scroll cards above navigation');
connectionStatus='unconfigured';await page.evaluate(()=>initializeKryptotron());
assert.equal(await page.locator('#asset-grid .asset-card').count(),4);
assert.equal(await page.locator('#asset-grid .asset-card strong').first().textContent(),'—');assert.equal(await page.locator('#trading-control').isDisabled(),true);
await page.setViewportSize({width:390,height:844});
await page.locator('#profile-button').click();await page.locator('[data-dialog="account-settings-dialog"]').click();
await page.locator('[data-dialog="connected-accounts-dialog"]').click();await page.locator('[data-dialog="binance-dialog"]').click();
assert.equal(await page.locator('#connection-form').isVisible(),true);
await page.locator('#connection-form [name="apiKey"]').fill('test-key-not-a-real-key');
await page.locator('#connection-form [name="apiSecret"]').fill('test-secret-not-a-real-secret');
await page.locator('#connection-form [name="withdrawalsDisabledConfirmed"]').check();
await page.screenshot({path:'/tmp/ocean-binance-settings-mobile.png'});
await page.locator('#connection-form [type="submit"]').click();
await page.locator('#provisioning-status').waitFor({state:'visible'});
assert.deepEqual(mutations.at(-1),{path:'/api/kryptotron/connection',environment:'testnet',apiKey:'test-key-not-a-real-key',apiSecret:'test-secret-not-a-real-secret',withdrawalsDisabledConfirmed:true});
connectionStatus='connected';await page.evaluate(()=>initializeKryptotron());
assert.equal(await page.locator('#streak-control').isDisabled(),false);
rejectDisconnect=false;page.once('dialog',dialog=>dialog.accept());await page.locator('#disconnect-binance').click();
await page.locator('#connection-form').waitFor({state:'visible'});
assert.equal(connectionStatus,'unconfigured');assert.equal(await page.locator('#trading-control').isDisabled(),true);
assert.deepEqual(errors,[]);
console.log('PASS: flexible 2x2 overview, all-width tabs, preserved trading/DCA controls, displayed names, relocated tools, Binance confirmation/rejection/legacy guard, unavailable data and natural scrolling.');
} finally {await browser.close();}
