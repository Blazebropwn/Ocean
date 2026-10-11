// Isolated browser check: all API responses are synthetic; no real TIDE is spent.
const { chromium } = await import(process.env.OCEAN_PLAYWRIGHT_MODULE || 'playwright');
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { BET, GAME_VERSION, PAYOUTS, REELS, evaluateStops } from '../../dist/src/slot/math.js';
const root = new URL('../../public', import.meta.url).pathname;
const browser = await chromium.launch({ headless:true, executablePath:process.env.OCEAN_CHROMIUM_PATH, args:['--no-sandbox'] });
try {
 const page = await browser.newPage({ viewport:{width:1440,height:900} });
 const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
 let balance=1000, posts=0, dropResponse=false, flag=true;
 const receipts=new Map();
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname!=='ocean.test')return route.abort();
  const path=url.pathname;
  if(path.startsWith('/api/')){
   let body={},status=200;
   if(path==='/api/me')body={user:{id:'preview',username:'Preview',emailVerified:true,accessApproved:true,role:'member'}};
   else if(path==='/api/kryptotron/connection')body={connection:{status:'connected',mainnetAvailable:true}};
   else if(path==='/api/tide')body={balance,genesis:null};
   else if(path==='/api/slot')body={gameVersion:GAME_VERSION,bet:BET,payouts:PAYOUTS,reels:REELS};
   else if(path==='/api/slot/spins'){
    posts++;const key=route.request().postDataJSON().idempotencyKey;
    const replayed=receipts.has(key);
    if(!replayed){const result=evaluateStops(REELS.map(r=>r.indexOf('fish')));const before=balance;balance=before-BET+result.payout;receipts.set(key,{...result,userId:'preview',idempotencyKey:key,gameVersion:GAME_VERSION,bet:BET,balanceBefore:before,balanceAfter:balance});}
    if(dropResponse){dropResponse=false;return route.abort();}
    body={spin:receipts.get(key),balance,replayed};
   }else{status=404;body={error:'No preview data'};}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  }
  try{const file=path==='/'?'/index.html':path;let data=await readFile(root+file);if(file==='/index.html'&&!flag)data=Buffer.from(data.toString().replace('data-manual-stop-enabled="true"','data-manual-stop-enabled="false"'));return route.fulfill({body:data,contentType:({html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',woff2:'font/woff2'})[file.split('.').pop()]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('https://ocean.test/#gamble');
 await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 for(const [width,height] of [[1440,900],[1280,720],[390,844],[320,568],[768,1024]]){
  await page.setViewportSize({width,height});
  const bounds=await page.locator('#slot-machine').boundingBox();
  const workspace=await page.locator('.workspace').boundingBox();
  assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,`cabinet width ${width}`);
  assert.ok(bounds.y>=workspace.y-1&&bounds.y+bounds.height<=workspace.y+workspace.height+1,`cabinet height ${width}x${height}: ${JSON.stringify({bounds,workspace})}`);
  for(const button of await page.locator('.slot-stops button').all())assert.ok((await button.boundingBox()).height>=44);
  if(width===390||width===1440)await page.screenshot({path:`/tmp/ocean-slot-stop-${width}.png`});
  await page.locator('#slot-manual-mode').uncheck();
  const auto=await page.locator('#slot-machine').boundingBox();
  assert.ok(auto.y>=workspace.y-1&&auto.y+auto.height<=workspace.y+workspace.height+1,`automatic mode height ${width}x${height}`);
  await page.locator('#slot-manual-mode').check();
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('#slot-spin').click();
 await page.locator('#slot-stop-2').click({timeout:5000});
 await page.locator('.slot-reel').nth(0).click();
 await page.keyboard.press('2');
 await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(posts,1);assert.equal(balance,1090);
 assert.equal(await page.locator('#slot-machine').evaluate(el=>el.classList.contains('won')),true);
 const targets=REELS.map(r=>25+r.indexOf('fish'));
 const positions=await page.locator('.slot-track').evaluateAll(tracks=>tracks.map(t=>-parseFloat(t.style.transform.slice(11))/parseFloat(getComputedStyle(t.firstElementChild).height)));
 positions.forEach((value,i)=>assert.ok(Math.abs(value-targets[i])<.01));
 await page.locator('#slot-manual-mode').uncheck();
 assert.equal(await page.locator('#slot-stops').isVisible(),false);
 await page.reload();await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(await page.locator('#slot-manual-mode').isChecked(),false,'preference survives reload');
 await page.locator('#slot-spin').click();await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(posts,2);assert.equal(balance,1180);
 await page.locator('#slot-manual-mode').check();
 dropResponse=true;
 await page.locator('#slot-spin').click();await page.locator('#slot-action').filter({hasText:'OVĚŘIT'}).waitFor();
 assert.equal(await page.locator('#slot-stop-0').isDisabled(),true);
 const settled=balance;
 await page.locator('#slot-spin').click();await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(balance,settled,'retry must not create another wager');assert.equal(receipts.size,3);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('#slot-spin').click();await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(await page.locator('#slot-stop-0').isDisabled(),true);
 flag=false;await page.reload();await page.waitForFunction(()=>!document.querySelector('#slot-spin').disabled);
 assert.equal(await page.locator('#slot-manual-controls').isVisible(),false,'global flag restores original UI');
 assert.deepEqual(errors,[]);
 console.log('PASS: manual buttons, reel tap, keyboard, unchanged targets and payout, automatic fallback, persistent opt-out, global rollback flag, failed-response retry, reduced motion and cabinet fit at five sizes.');
}finally{await browser.close();}
