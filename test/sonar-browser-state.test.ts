import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scoreSonarRun, type SonarRound } from '../src/arcade/sonar.js';

// Exercise real browser controller with deterministic time and a small DOM adapter.
// This does not substitute for visual/viewport checks in a real browser.
function fixture(options: { unavailable?: boolean } = {}) {
  let clock=0, rafId=0;
  const frames=new Map<number,Function>(), timers=new Map<number,Function>(), calls:Array<{url:string;data:any}>=[];
  const round:SonarRound={target:0,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100};
  const course=[round,{...round,target:2}];
  class Element {
    textContent='';children:Element[]=[];attributes=new Map();listeners=new Map<string,Function>();clientWidth=390;width=390;height=400;
    className='';classList={add(){},remove(){}};style={setProperty(){}};
    append(...items:Element[]){this.children.push(...items);} replaceChildren(){this.children=[];}
    setAttribute(key:string,value:string){this.attributes.set(key,value);}removeAttribute(key:string){this.attributes.delete(key);}
    addEventListener(name:string,fn:Function){this.listeners.set(name,fn);}focus(){}
    getBoundingClientRect(){return{width:390,height:400};}
    getContext(){const gradient={addColorStop(){}};return new Proxy({createRadialGradient(){return gradient;},createLinearGradient(){return gradient;}},{get(target:any,key){return target[key]??(()=>{});},set(target:any,key,value){target[key]=value;return true;}});}
    closest(){return null;}
  }
  const elements=new Map(['#game-tap','#game-canvas','#game-hint','#sonar-feedback','#game-score','#sonar-ticker-track','#sonar-ticker','#sonar-announcement'].map(id=>[id,new Element()]));
  const windowListeners=new Map<string,Function>(),documentListeners=new Map<string,Function>();
  const document={hidden:false,querySelector:(id:string)=>elements.get(id)??null,createElement:()=>new Element(),addEventListener:(name:string,fn:Function)=>documentListeners.set(name,fn)};
  const window:any={addEventListener:(name:string,fn:Function)=>windowListeners.set(name,fn),dispatchEvent(){}};
  const context=vm.createContext({window,document,devicePixelRatio:1,performance:{now:()=>clock},AbortSignal,Event,
    matchMedia:()=>({matches:false,addEventListener(){}}),ResizeObserver:class{observe(){}},
    requestAnimationFrame:(fn:Function)=>{frames.set(++rafId,fn);return rafId;},cancelAnimationFrame:(id:number)=>frames.delete(id),
    setInterval:()=>1,clearInterval(){},setTimeout:(fn:Function)=>{timers.set(++rafId,fn);return rafId;},clearTimeout:(id:number)=>timers.delete(id),
    fetch:async(url:string,request:any)=>{const data=request.body?JSON.parse(request.body):undefined;calls.push({url,data});
      if(options.unavailable && url.endsWith('/runs'))return{ok:false,status:404,json:async()=>({error:'Not Found'})};
      let body:any={leaders:[]};if(url.endsWith('/runs'))body={id:'run',rounds:course,maxDurationMs:600000};
      if(url.endsWith('/finish'))body=scoreSonarRun(course,data.taps,data.durationMs);
      return{ok:true,json:async()=>body};}
  });
  vm.runInContext(readFileSync('public/sonar.js','utf8'),context);
  return{window,document,elements,calls,frames,windowListeners,documentListeners,setTime:(n:number)=>{clock=n;},flush:()=>new Promise<void>(resolve=>setImmediate(resolve))};
}

test('SONAR browser deducts no TIDE, displays perfect feedback and submits matching tap timing once',async()=>{
  const f=fixture(),surface=f.elements.get('#game-tap')!;
  f.window.OceanSonar.open({enabled:true});
  surface.listeners.get('pointerdown')!({isPrimary:true,button:0,preventDefault(){}});await f.flush();
  assert.equal(f.elements.get('#game-hint')!.textContent,'');
  assert.equal(f.elements.get('#game-score')!.textContent,'0');
  // Pointer-generated click must not count a second tap after the start.
  surface.listeners.get('click')!({detail:1});
  f.setTime(Math.PI/2*1000);surface.listeners.get('pointerdown')!({isPrimary:true,button:0,preventDefault(){}});
  assert.equal(f.elements.get('#game-score')!.textContent,'100');
  assert.equal(f.elements.get('#sonar-feedback')!.textContent,'+100');
  f.setTime(1700);surface.listeners.get('pointerdown')!({isPrimary:true,button:0,preventDefault(){}});await f.flush();
  const submits=f.calls.filter(c=>c.url.endsWith('/finish'));assert.equal(submits.length,1);
  assert.deepEqual(scoreSonarRun([{target:0,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100},{target:2,width:.8,perfectWidth:.24,speed:1,hitPoints:50,perfectPoints:100}],submits[0]!.data.taps,submits[0]!.data.durationMs),{score:100,hits:1,perfects:1});
  assert.equal(f.elements.get('#game-hint')!.textContent,'Tap');
  f.window.OceanSonar.close();assert.equal(f.calls.filter(c=>c.url.endsWith('/finish')).length,1);
  assert.ok(f.calls.every(c=>c.url.startsWith('/api/arcade/sonar/')));
});

test('SONAR ignores held keys and disabled access; leaving the page submits once and stops frames',async()=>{
  const f=fixture(),surface=f.elements.get('#game-tap')!;
  f.window.OceanSonar.open({enabled:false});surface.listeners.get('click')!({detail:0});await f.flush();
  assert.equal(f.calls.length,0);
  f.window.OceanSonar.open({enabled:true});surface.listeners.get('click')!({detail:0});await f.flush();
  f.setTime(100);
  let prevented=false;f.windowListeners.get('keydown')!({code:'Space',repeat:true,target:surface,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(f.calls.filter(c=>c.url.endsWith('/finish')).length,0);
  f.window.OceanSonar.close();await f.flush();
  assert.equal(f.frames.size,0);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/finish')).length,1);
  assert.deepEqual(f.calls.find(c=>c.url.endsWith('/finish'))!.data.taps,[]);
});

test('SONAR draws the original surface and lets the player retry when the server is outdated',async()=>{
  const options={unavailable:true},f=fixture(options),surface=f.elements.get('#game-tap')!;
  f.window.OceanSonar.open({enabled:true});
  const draw=[...f.frames.values()][0]!;draw(0);
  surface.listeners.get('click')!({detail:0});await f.flush();
  assert.match(f.elements.get('#game-hint')!.textContent,/aktualizaci serveru/);
  assert.equal(surface.attributes.has('aria-busy'),false);
  options.unavailable=false;surface.listeners.get('click')!({detail:0});await f.flush();
  assert.equal(f.elements.get('#game-hint')!.textContent,'');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/runs')).length,2);
  f.window.OceanSonar.close();await f.flush();
});
