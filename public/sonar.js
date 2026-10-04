(() => {
  const $ = selector => document.querySelector(selector);
  const surface = $('#game-tap'), canvas = $('#game-canvas'), prompt = $('#game-hint');
  const feedback = $('#sonar-feedback'), scoreLabel = $('#game-score'), ticker = $('#sonar-ticker-track');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false, enabled = false, generation = 0, state = null, frame = 0, refresh = 0, flash = 0, starting = false;
  let leaders = [], tickerMessage = '—', saving = null;
  const distance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const scoreText = score => String(score).padStart(6, '0');
  async function api(path, data) {
    const response = await fetch('/api/arcade/sonar/' + path, { credentials:'same-origin', method:data === undefined ? 'GET' : 'POST',
      headers:data === undefined ? {} : {'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data), signal:AbortSignal.timeout(10000) });
    const body = await response.json();
    if (body.code === 'ACCOUNT_SUSPENDED') window.dispatchEvent(new Event('ocean-account-suspended'));
    if (!response.ok) throw new Error(body.error || 'Spojení není dostupné.');
    return body;
  }
  function renderTicker() {
    ticker.replaceChildren(); ticker.classList.remove('is-running');
    if (!leaders.length) { const empty=document.createElement('span'); empty.className='sonar-ticker-empty'; empty.textContent=tickerMessage; ticker.append(empty); return; }
    const group=document.createElement('div'); group.className='sonar-ticker-group';
    leaders.forEach((entry,index) => {
      const item=document.createElement('span'); item.className='sonar-ticker-entry';
      const name=document.createElement('b'), number=document.createElement('span'), dot=document.createElement('i');
      name.textContent=`${['🥇','🥈','🥉'][index] || String(index+1).padStart(2,'0')} ${entry.username}`;
      dot.textContent='·'; number.textContent=Number(entry.score).toLocaleString('cs-CZ'); item.append(name,dot,number); group.append(item);
    });
    ticker.append(group);
    if (reducedMotion.matches) return;
    // Two equally wide groups make the seam continuous at any viewport width.
    const originals=[...group.children];
    for(let repeat=0; group.getBoundingClientRect().width < $('#sonar-ticker').clientWidth && repeat<12; repeat++) {
      originals.forEach(item=>{const copy=item.cloneNode(true); copy.setAttribute('aria-hidden','true'); group.append(copy);});
    }
    const copy=group.cloneNode(true); copy.setAttribute('aria-hidden','true'); ticker.append(copy);
    ticker.style.setProperty('--ticker-duration', Math.max(24,group.getBoundingClientRect().width/24)+'s'); ticker.classList.add('is-running');
  }
  async function loadLeaders() {
    const current=generation;
    try { const result=await api('leaderboard'); if(!visible || current!==generation) return;
      leaders=result.leaders; tickerMessage='První místo čeká na tebe.'; renderTicker();
    } catch { if(visible && current===generation && !leaders.length) { tickerMessage='Žebříček není dostupný.'; renderTicker(); } }
  }
  function announce(text) { $('#sonar-announcement').textContent=text; }
  function showFeedback(text) { clearTimeout(flash); feedback.textContent=text; flash=setTimeout(()=>{feedback.textContent='';},280); }
  function elapsed(now=performance.now()) { return state ? Math.min(state.maxDurationMs,now-state.started) : 0; }
  function angleAt(time) { return state.angle + state.rounds[state.hits].speed * (time-state.lastTap)/1000; }
  async function start() {
    if(!visible || !enabled || starting) return;
    const current=generation; starting=true; prompt.textContent=''; surface.setAttribute('aria-busy','true');
    try {
      if(saving) await saving.catch(()=>{});
      if(!visible || !enabled || current!==generation) return;
      const run=await api('runs',{});
      if(!visible || !enabled || current!==generation) return;
      state={...run,active:true,started:performance.now(),angle:-Math.PI/2,lastTap:0,taps:[],score:0,hits:0};
      scoreLabel.textContent=scoreText(0); feedback.textContent='';
      surface.setAttribute('aria-label','Ping. Klepni nebo stiskni mezerník při průchodu paprsku zónou.');
      announce('Hra začala.'); cancelAnimationFrame(frame); frame=requestAnimationFrame(draw);
    } catch(error) { if(visible && current===generation) {prompt.textContent=error.message+' · Tap'; announce(error.message);} }
    finally { if(current===generation) {starting=false; surface.removeAttribute('aria-busy');} }
  }
  async function finish() {
    if(!state?.active) return;
    const completed=state,current=generation; completed.active=false;
    const durationMs=elapsed();
    cancelAnimationFrame(frame); clearTimeout(flash); feedback.textContent='';
    prompt.textContent='Tap'; surface.setAttribute('aria-label',`Skóre ${completed.score}. Klepni pro nový pokus.`);
    announce(`Konec pokusu. ${completed.score} bodů.`);
    const pending=api(`runs/${completed.id}/finish`,{taps:completed.taps,durationMs}); saving=pending;
    try {
      const result=await pending;
      if(current!==generation || !visible) return;
      if(state===completed) scoreLabel.textContent=scoreText(result.score);
      await loadLeaders();
    } catch { if(current===generation && visible && state===completed) {prompt.textContent='Výsledek se nepodařilo uložit · Tap'; announce('Výsledek se nepodařilo uložit.');} }
    finally {if(saving===pending)saving=null;}
  }
  function tap() {
    if(!visible || !enabled || document.querySelector('dialog[open]')) return;
    if(!state?.active) { start(); return; }
    const time=elapsed();
    if(time>=state.maxDurationMs) { finish(); return; }
    if(time-state.lastTap<25) return;
    const round=state.rounds[state.hits], angle=angleAt(time), gap=distance(angle,round.target);
    state.taps.push(time); state.angle=angle%(Math.PI*2); state.lastTap=time;
    if(gap>round.width/2) { finish(); return; }
    const perfect=gap<=round.perfectWidth/2, points=perfect?round.perfectPoints:round.hitPoints;
    state.score+=points; state.hits++; scoreLabel.textContent=scoreText(state.score);
    showFeedback(perfect?`PERFECT · +${points}`:`+${points}`);
    if(state.hits===state.rounds.length) finish();
  }
  function draw(now=performance.now()) {
    if(!visible) return;
    cancelAnimationFrame(frame);
    const bounds=canvas.getBoundingClientRect(), ratio=Math.min(devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(bounds.width*ratio)),h=Math.max(1,Math.round(bounds.height*ratio));
    if(canvas.width!==w)canvas.width=w; if(canvas.height!==h)canvas.height=h;
    const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,w,h);
    const x=w/2,y=h/2,r=Math.min(w*.4,h*.4), active=state?.active;
    if(active && elapsed(now)>=state.maxDurationMs) { finish(); }
    const round=active?state.rounds[state.hits]:{target:-.5,width:.8,perfectWidth:.24};
    const angle=active?angleAt(elapsed(now)):-Math.PI/2, perfect=active && distance(angle,round.target)<=round.perfectWidth/2;
    const glow=ctx.createRadialGradient(x,y,0,x,y,r*1.4); glow.addColorStop(0,'rgba(49,135,128,.12)');glow.addColorStop(1,'rgba(9,23,29,0)');
    ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);ctx.save();ctx.translate(x,y);
    ctx.strokeStyle='rgba(126,197,183,.14)';ctx.lineWidth=ratio;
    for(const ring of [.25,.5,.75,1]) {ctx.beginPath();ctx.arc(0,0,r*ring,0,Math.PI*2);ctx.stroke();}
    ctx.strokeStyle='rgba(126,197,183,.09)';
    for(let i=0;i<8;i++){const a=i*Math.PI/4;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);ctx.stroke();}
    for(let i=0;i<60;i++){const a=i*Math.PI/30,inner=i%5===0?1.035:1.045;ctx.strokeStyle=i%5===0?'rgba(157,214,201,.35)':'rgba(157,214,201,.14)';ctx.beginPath();ctx.moveTo(Math.cos(a)*r*inner,Math.sin(a)*r*inner);ctx.lineTo(Math.cos(a)*r*1.06,Math.sin(a)*r*1.06);ctx.stroke();}
    function zone(width,inner,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(0,0,r,width[0],width[1]);ctx.arc(0,0,r*inner,width[1],width[0],true);ctx.closePath();ctx.fill();}
    zone([round.target-round.width/2,round.target+round.width/2],.79,'rgba(93,175,169,.25)');
    zone([round.target-round.perfectWidth/2,round.target+round.perfectWidth/2],.77,perfect?'rgba(191,255,222,.8)':'rgba(110,230,185,.47)');
    ctx.strokeStyle=perfect?'#d4ffe9':'#84e5bf';ctx.lineWidth=ratio*3;ctx.beginPath();ctx.arc(0,0,r,round.target-round.perfectWidth/2,round.target+round.perfectWidth/2);ctx.stroke();
    if(active && !reducedMotion.matches){ for(let i=16;i>=1;i--){const a=angle-i*.012;ctx.strokeStyle=`rgba(110,217,195,${.06*(1-i/17)})`;ctx.lineWidth=r*.014;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);ctx.stroke();} }
    ctx.strokeStyle=perfect?'#e3fff3':'#8cdcc9';ctx.lineWidth=ratio*1.5;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(angle)*r,Math.sin(angle)*r);ctx.stroke();
    ctx.fillStyle=perfect?'#effff6':'#a5eedb';ctx.beginPath();ctx.arc(0,0,ratio*3,0,Math.PI*2);ctx.fill();ctx.restore();
    if(state?.active)frame=requestAnimationFrame(draw);
  }
  surface.addEventListener('pointerdown',event=>{if(!event.isPrimary || event.button!==0)return;tap();});
  // Synthetic click supports keyboard/assistive activation without a second pointer tap.
  surface.addEventListener('click',event=>{if(event.detail===0)tap();});
  surface.addEventListener('keydown',event=>{if(event.code==='Enter' && event.repeat)event.preventDefault();});
  window.addEventListener('keydown',event=>{
    if(!visible || event.code!=='Space' || event.target.closest('input,textarea,select,dialog,a,button:not(#game-tap)'))return;
    event.preventDefault();if(!event.repeat)tap();
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){finish();clearInterval(refresh);}else if(visible){loadLeaders();refresh=setInterval(loadLeaders,60000);}});
  const observer=new ResizeObserver(()=>{if(visible){draw();renderTicker();}});observer.observe(surface);
  reducedMotion.addEventListener('change',()=>{if(visible)renderTicker();});
  window.OceanSonar={
    open(options){ this.close(); visible=true;enabled=Boolean(options.enabled);state=null;scoreLabel.textContent=scoreText(0);prompt.textContent='Tap';surface.removeAttribute('aria-busy');surface.setAttribute('aria-label','Spustit SONAR. Klepni nebo stiskni mezerník.');leaders=[];tickerMessage='—';renderTicker();frame=requestAnimationFrame(()=>{if(visible){draw();loadLeaders();}});refresh=setInterval(loadLeaders,60000); },
    close(){finish();visible=false;enabled=false;generation++;starting=false;clearInterval(refresh);cancelAnimationFrame(frame);clearTimeout(flash);feedback.textContent='';}
  };
})();
