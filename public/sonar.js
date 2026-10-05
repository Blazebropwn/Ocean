(() => {
  const $ = selector => document.querySelector(selector);
  const surface = $('#game-tap'), canvas = $('#game-canvas'), prompt = $('#game-hint');
  const feedback = $('#sonar-feedback'), scoreLabel = $('#game-score'), ticker = $('#sonar-ticker-track');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false, enabled = false, generation = 0, state = null, frame = 0, refresh = 0, flash = 0, starting = false;
  let leaders = [], saving = null;
  const distance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const scoreText = score => Number(score).toLocaleString('cs-CZ');
  async function api(path, data) {
    const response = await fetch('/api/arcade/sonar/' + path, { credentials:'same-origin', method:data === undefined ? 'GET' : 'POST',
      headers:data === undefined ? {} : {'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data), signal:AbortSignal.timeout(10000) });
    const body = await response.json();
    if (body.code === 'ACCOUNT_SUSPENDED') window.dispatchEvent(new Event('ocean-account-suspended'));
    if (!response.ok) throw new Error(response.status===404 ? 'Hra čeká na aktualizaci serveru. Obnov stránku za chvíli.' : body.error || 'Spojení není dostupné.');
    return body;
  }
  function renderTicker() {
    ticker.replaceChildren();
    const entry=leaders[0];
    if(!entry) return;
    const item=document.createElement('span'); item.className='sonar-ticker-entry';
    const mark=document.createElement('span'),name=document.createElement('b'),number=document.createElement('span');
    mark.textContent='♛'; mark.setAttribute('aria-hidden','true');
    name.textContent=entry.username; number.textContent=scoreText(entry.score);
    item.append(mark,name,number); ticker.append(item);
  }
  async function loadLeaders() {
    const current=generation;
    try { const result=await api('leaderboard'); if(!visible || current!==generation) return;
      leaders=result.leaders; renderTicker();
    } catch { /* An unavailable ranking must not interrupt the game. */ }
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
    state.score+=points; state.hits++; state.flashUntil=performance.now()+180; scoreLabel.textContent=scoreText(state.score);
    showFeedback(`+${points}`);
    if(state.hits===state.rounds.length) finish();
  }
  function draw(now=performance.now()) {
    if(!visible) return;
    cancelAnimationFrame(frame);
    const bounds=canvas.getBoundingClientRect(), ratio=Math.min(devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(bounds.width*ratio)),h=Math.max(1,Math.round(bounds.height*ratio));
    if(canvas.width!==w)canvas.width=w; if(canvas.height!==h)canvas.height=h;
    const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,w,h);
    // Preserve the original SONAR palette, grid and luminous arc.
    const background=ctx.createLinearGradient(0,0,w,h);
    background.addColorStop(0,'#151c22');background.addColorStop(.55,'#151c22');background.addColorStop(1,'#10161b');
    ctx.fillStyle=background;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(111,226,224,.055)';ctx.lineWidth=ratio*.5;
    const grid=Math.max(32*ratio,w/22);ctx.beginPath();
    for(let x=grid;x<w;x+=grid){ctx.moveTo(x,0);ctx.lineTo(x,h);}
    for(let y=grid;y<h;y+=grid){ctx.moveTo(0,y);ctx.lineTo(w,y);}ctx.stroke();
    ctx.fillStyle='rgba(119,216,196,.16)';
    const drift=reducedMotion.matches?0:now;
    for(let i=0;i<16;i++){const px=((i*.173+drift/90000)%1)*w,py=((i*.311+drift/140000)%1)*h;ctx.beginPath();ctx.arc(px,py,(.6+(i%3)*.4)*ratio,0,Math.PI*2);ctx.fill();}
    const vignette=ctx.createRadialGradient(w/2,h/2,h*.1,w/2,h/2,Math.max(w,h)*.72);
    vignette.addColorStop(0,'rgba(2,18,24,0)');vignette.addColorStop(1,'rgba(0,8,12,.64)');ctx.fillStyle=vignette;ctx.fillRect(0,0,w,h);
    const x=w/2,y=h/2,r=Math.min(w,h)*.36;
    if(state?.active && elapsed(now)>=state.maxDurationMs)finish();
    ctx.save();ctx.translate(x,y);
    if(!state){
      ctx.strokeStyle='rgba(119,216,196,.34)';ctx.lineWidth=ratio;
      for(const size of [.08,.17,.27]){ctx.beginPath();ctx.arc(0,0,Math.min(w,h)*size,0,Math.PI*2);ctx.stroke();}
      ctx.fillStyle='#77d8c4';ctx.beginPath();ctx.arc(0,0,3*ratio,0,Math.PI*2);ctx.fill();ctx.restore();return;
    }
    const round=state.rounds[Math.min(state.hits,state.rounds.length-1)];
    const angle=state.active?angleAt(elapsed(now)):state.angle;
    ctx.strokeStyle='rgba(119,216,196,.13)';ctx.lineWidth=ratio*.75;
    for(const ring of [.25,.5,.75,1]){ctx.beginPath();ctx.arc(0,0,r*ring,0,Math.PI*2);ctx.stroke();}
    for(let a=0;a<Math.PI*2;a+=Math.PI/4){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);ctx.stroke();}
    ctx.shadowColor='rgba(92,229,168,.75)';ctx.shadowBlur=14*ratio;ctx.strokeStyle='#5ce5a8';ctx.lineWidth=Math.max(6*ratio,w/125);
    ctx.beginPath();ctx.arc(0,0,r,round.target-round.width/2,round.target+round.width/2);ctx.stroke();
    const sweep=ctx.createLinearGradient(0,0,Math.cos(angle)*r,Math.sin(angle)*r);
    sweep.addColorStop(0,'rgba(84,238,226,.12)');sweep.addColorStop(1,'#77d8c4');
    ctx.strokeStyle=sweep;ctx.shadowColor='rgba(119,216,196,.8)';ctx.shadowBlur=12*ratio;ctx.lineWidth=Math.max(1.4*ratio,w/800);
    ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(angle)*r,Math.sin(angle)*r);ctx.stroke();
    ctx.fillStyle=now<(state.flashUntil||0)?'#fff':'#77d8c4';ctx.beginPath();ctx.arc(0,0,Math.max(3*ratio,w/400),0,Math.PI*2);ctx.fill();ctx.restore();
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
  const observer=new ResizeObserver(()=>{if(visible)draw();});observer.observe(surface);
  window.OceanSonar={
    open(options){ this.close(); visible=true;enabled=Boolean(options.enabled);state=null;scoreLabel.textContent=scoreText(0);prompt.textContent='Tap';surface.removeAttribute('aria-busy');surface.setAttribute('aria-label','Spustit SONAR. Klepni nebo stiskni mezerník.');leaders=[];renderTicker();frame=requestAnimationFrame(()=>{if(visible){draw();loadLeaders();}});refresh=setInterval(loadLeaders,60000); },
    close(){finish();visible=false;enabled=false;generation++;starting=false;clearInterval(refresh);cancelAnimationFrame(frame);clearTimeout(flash);feedback.textContent='';}
  };
})();
