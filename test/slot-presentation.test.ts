import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { BET, GAME_VERSION, PAYOUTS, REELS, evaluateStops } from '../src/slot/math.js';

class Element {
  textContent = ''; disabled = false; value = ''; style: Record<string,string> = {}; dataset: Record<string,string> = {};
  children: Element[] = []; attrs: Record<string,string> = {}; listeners: Record<string, (...args: any[]) => any> = {};
  parentElement?: Element; className = '';
  classes = new Set<string>();
  classList = { add: (...names:string[])=>names.forEach(n=>this.classes.add(n)), remove: (...names:string[])=>names.forEach(n=>this.classes.delete(n)),
    toggle: (name:string, on:boolean)=>on?this.classes.add(name):this.classes.delete(name) };
  addEventListener(name:string, callback:(...args:any[])=>any) { this.listeners[name]=callback; }
  setAttribute(name:string,value:string) { this.attrs[name]=value; }
  getAttribute(name:string) { return this.attrs[name]; }
  removeAttribute(name:string) { delete this.attrs[name]; }
  append(...children:Element[]) { this.children.push(...children); }
  replaceChildren(...children:Element[]) { this.children=children; }
  querySelector() { return this.children[0]; }
}
const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(options:{storage?:Map<string,string>; balance?:number; reduced?:boolean}={}) {
  const elements=new Map<string,Element>(), tracks=Array.from({length:3},()=>{const e=new Element();e.parentElement=new Element();return e;});
  const el=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
  const storage=options.storage??new Map<string,string>();
  const state={balance:options.balance??1000, posts:[] as string[], respond:async(_key:string):Promise<{status:number;body:unknown}>=>{throw Error('No response configured');}};
  let time=0, frames:Array<(n:number)=>void>=[];
  const window:any={addEventListener:()=>{}};
  runInNewContext(readFileSync('public/economy.js','utf8'),{
    window, document:{getElementById:el, createElement:()=>new Element(),
      querySelectorAll:(s:string)=>s==='.slot-track'?tracks:el('slot-paytable').children,
      querySelector:(s:string)=>el('slot-paytable').children.find(row=>s.includes(`"${row.dataset.symbol}"`))},
    sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},
    crypto:{randomUUID},AbortSignal,Intl,performance:{now:()=>time},matchMedia:()=>({matches:options.reduced??false}),
    getComputedStyle:()=>({height:'100px'}),requestAnimationFrame:(f:(n:number)=>void)=>frames.push(f),
    fetch:async(path:string,init:any)=>{
      let result:{status:number;body:unknown};
      if(path==='/api/tide') result={status:200,body:{balance:state.balance,genesis:null}};
      else if(path==='/api/slot') result={status:200,body:{gameVersion:GAME_VERSION,bet:BET,reels:REELS,payouts:PAYOUTS}};
      else {const key=JSON.parse(init.body).idempotencyKey;state.posts.push(key);result=await state.respond(key);}
      return {ok:result.status<400,status:result.status,json:async()=>result.body};
    }
  });
  window.OceanEconomy.setUser({id:'player',accessApproved:true});await window.OceanEconomy.open('slot');
  return {state,storage,tracks,el,window,balance:()=>el('header-tide').textContent.replace(/\s/g,''),
    click:()=>el('slot-spin').listeners.click!(),step:async(ms:number)=>{time+=ms;const next=frames;frames=[];next.forEach(f=>f(time));await tick();}};
}
function receipt(key:string, win=true, replayed=false, current?:number) {
 const stops=win?REELS.map(reel=>reel.indexOf('fish')):[0,0,0];const evaluated=evaluateStops(stops);
 const balanceAfter=1000-BET+evaluated.payout;
 return {status:200,body:{spin:{...evaluated,userId:'player',idempotencyKey:key,gameVersion:GAME_VERSION,bet:BET,balanceBefore:1000,balanceAfter},replayed,balance:current??balanceAfter}};
}

test('click deducts immediately; downward reels conceal payout until all stop, including concurrent wallet refresh',async()=>{
 const f=await fixture();let release!:()=>void;
 f.state.respond=async key=>{await new Promise<void>(r=>{release=r});f.state.balance=1090;return receipt(key);};
 const spinning=f.click();assert.equal(f.balance(),'990');assert.equal(f.state.posts.length,1);await f.click();assert.equal(f.state.posts.length,1);
 release();await tick();const before=f.tracks.map(t=>Number(t.style.transform!.match(/-?[\d.]+/)![0]));
 await f.step(100);f.tracks.forEach((t,i)=>assert.ok(Number(t.style.transform!.match(/-?[\d.]+/)![0])>before[i]!, 'symbols move downward'));
 await f.window.OceanEconomy.open('overview');assert.equal(f.balance(),'990','wallet refresh cannot reveal payout early');
 await f.step(1500);assert.equal(f.balance(),'990','last reel has not stopped');
 await f.step(1000);await spinning;assert.equal(f.balance(),'1090');assert.equal(f.el('slot-spin').disabled,false);
 f.tracks.forEach((t,i)=>assert.equal(t.style.transform,`translateY(${-(25+REELS[i]!.indexOf('fish'))*100}px)`));
});

test('loss leaves exactly one deduction and reduced motion still uses the confirmed settlement',async()=>{
 const f=await fixture({reduced:true});f.state.respond=async key=>{f.state.balance=990;return receipt(key,false);};
 const spinning=f.click();assert.equal(f.balance(),'990');await spinning;assert.equal(f.balance(),'990');assert.equal(f.storage.size,0);
});

test('rejected stake restores authoritative wallet; unconfirmed stake survives reload without another subtraction',async()=>{
 const denied=await fixture();denied.state.respond=async()=>{denied.state.balance=5;return {status:409,body:{error:'Insufficient TIDE'}};};
 await denied.click();assert.equal(denied.balance(),'5');assert.equal(denied.storage.size,0);
 const lost=await fixture();lost.state.respond=async()=>{throw Error('Response lost');};
 await lost.click();assert.equal(lost.balance(),'—');assert.equal(lost.storage.size,1);
 const key=lost.state.posts[0];
 const resumed=await fixture({storage:lost.storage,balance:2500});
 resumed.state.respond=async retry=>receipt(retry,true,true,2500);
 const spinning=resumed.click();assert.equal(resumed.balance(),'2500');await tick();assert.equal(resumed.balance(),'2500');
 await resumed.step(2500);await spinning;
 assert.equal(resumed.state.posts[0],key);assert.equal(resumed.balance(),'2500','never restore historical balanceAfter');assert.equal(resumed.storage.size,0);
});

test('inconsistent receipt is not presented as credited winnings',async()=>{
 const f=await fixture();f.state.respond=async key=>{const r=receipt(key);r.body.spin.balanceAfter=999999;return r;};
 await f.click();assert.equal(f.balance(),'—');assert.equal(f.storage.size,1);assert.equal(f.el('slot-machine').classes.has('won'),false);
});
