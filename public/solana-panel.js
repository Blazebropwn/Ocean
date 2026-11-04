(() => {
  const labels = { scanner:'Scanner', 'rug-check':'Rug Check', sizer:'Sizer', executor:'Executor', logger:'Logger', equity:'Equity' };
  const states = { idle:'Čeká', running:'Pracuje', ok:'Ověřeno', blocked:'Odmítnuto', error:'Chyba' };
  const stages = Object.keys(labels);
  const money = value => Number.isFinite(value) ? new Intl.NumberFormat('cs-CZ',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value) : '—';
  const shortMoney = value => Number.isFinite(value) ? new Intl.NumberFormat('cs-CZ',{notation:'compact',maximumFractionDigits:1}).format(value) : '—';
  const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleTimeString('cs-CZ',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
  const node = (tag,text,className) => { const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el; };
  let root, data=null, eligible=false, visible=false, fetching=false, command=false, timer=null, lastContact=null, generation=0;
  let candidateSignatures=new Map();
  const $ = selector => root?.querySelector(selector);

  function mount() {
    if(root)return true;
    root=document.querySelector('#solana-panel');
    if(!root)return false;
    root.className='solana-console';
    root.innerHTML=`
      <header class="solana-head"><div><h2>Solana <span class="solana-paper">PAPER</span></h2><p>Nové pooly · automatické sledování</p></div><button class="solana-rules-button" type="button" data-solana-open="rules">Pravidla <span aria-hidden="true">↗</span></button></header>
      <div class="solana-wallet" aria-label="Virtuální účet v USDC"><div><span>Hodnota účtu</span><strong data-solana="equity">—</strong><small>virtuální USDC</small></div><div><span>Volné</span><strong data-solana="cash">—</strong><small data-solana="positions-count">0 / 3 pozice</small></div><div><span>Výsledek</span><strong data-solana="pnl">—</strong><small data-solana="trades-count">0 obchodů</small></div></div>
      <div class="solana-controls"><div class="solana-engine-state"><span class="solana-signal" aria-hidden="true"></span><div><strong data-solana="engine-status">Načítám</strong><small data-solana="countdown">Čekám na server</small></div></div><div class="solana-actions"><button type="button" class="solana-one-shot" data-solana="scan" title="Jednorázové vyhodnocení">Sken</button><button type="button" class="solana-start" data-solana="toggle" disabled>Spustit PAPER</button></div></div>
      <p class="solana-feedback" data-solana="feedback" role="status"></p>
      <div class="solana-pipeline" aria-label="Průběh skutečných kontrol"></div>
      <div class="solana-work-line"><span data-solana="work">Spusť sledování. První sken začne automaticky.</span><small data-solana="contact">—</small></div>
      <div class="solana-counters"><span><b data-solana="pools-count">0</b> kontrol poolů</span><span><b data-solana="risk-count">0</b> rizikových kontrol</span><span><b data-solana="cycles-count">0</b> skenů</span></div>
      <div class="solana-stream-grid"><section class="solana-stream"><header><h3>Tržní radar</h3><span data-solana="feed-count">Čeká na data</span></header><div data-solana="candidates" class="solana-candidates"><p class="solana-empty">Po spuštění zde uvidíš skutečné tokeny a výsledky kontrol.</p></div></section><section class="solana-open-positions"><header><h3>Paper pozice</h3><button type="button" class="solana-text-button" data-solana-open="ledger">Evidence →</button></header><div data-solana="positions"></div><div class="solana-equity-history"><span>Equity · průběh PAPER</span><div data-solana="chart"></div></div></section><section class="solana-live-tail"><header><h3>Živý log</h3><span>SCAN → CHECK → SIZE → EXEC → LOG</span></header><div data-solana="tail"></div></section></div>
      <footer class="solana-bottom"><span>Reálná data · virtuální peníze</span><button type="button" class="solana-text-button" data-solana-open="activity">Průběh kontrol →</button></footer>
      <dialog class="solana-dialog" data-solana-dialog="rules" aria-label="Pravidla Solana pilotu"><header><h2>Jak Solana pracuje</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body"><p><b>Spustit PAPER</b> zapne sledování na serveru. Nový sken proběhne přibližně každou minutu, i když přepneš sekci nebo zavřeš stránku. Radar průběžně ukazuje skutečné nálezy, odmítnutí a práci jednotlivých kroků.</p><p><b>Pozastavit</b> zastaví další automatické skeny, přecenění i výstupy. Již rozpracované kontroly se dokončí, nové automatické vstupy se zablokují. Ruční sken nebo uzavření můžeš spustit samostatně.</p><dl data-solana="rules-list"></dl><p>Scanner načítá omezený vzorek nově indexovaných poolů. Rug Check vyhodnocuje report třetí strany; splnění kontrol nezaručuje bezpečnost tokenu. Sizer hlídá vložený kapitál a denní brzdy. Executor potřebuje čerstvou nákupní i zpětnou prodejní kotaci.</p><p>Likvidita a riziková data mohou většinu tokenů vyřadit. Odmítnutí kandidáta neznamená zastavení sledování. Pilot zatím podporuje původní SPL Token program; Token-2022 se odmítá.</p><p>Simulace používá minimální výstup kotace s další rezervou na skluz a modelovaný síťový náklad. Neodesílá transakce a nepotřebuje podpisový klíč. Výsledky nejsou důkazem dosažitelných výnosů.</p><p>Pokud není dostupná čerstvá prodejní kotace, pozice zůstane otevřená a aktuální hodnota účtu je neověřená. Zdroje: <a href="https://www.geckoterminal.com/" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>, <a href="https://rugcheck.xyz/" target="_blank" rel="noopener noreferrer">RugCheck</a>, <a href="https://developers.jup.ag/docs/swap/order-and-execute" target="_blank" rel="noopener noreferrer">Jupiter</a>.</p></div></dialog>
      <dialog class="solana-dialog" data-solana-dialog="activity" aria-label="Průběh kontrol"><header><h2>Průběh kontrol</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body" data-solana="activity"></div></dialog>
      <dialog class="solana-dialog" data-solana-dialog="ledger" aria-label="Evidence Solana"><header><h2>Evidence PAPER</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body"><h3>Simulované obchody</h3><div data-solana="trades"></div><h3>Rozhodnutí a vstupy</h3><div data-solana="decisions"></div></div></dialog>`;
    const pipeline=$('.solana-pipeline');
    for(const [index,id] of stages.entries()){
      const step=node('button',undefined,'solana-step');step.type='button';step.dataset.stage=id;
      const head=node('span',undefined,'solana-step-head');head.append(node('small',String(index+1).padStart(2,'0')),node('b',labels[id]));
      step.append(head,node('span','Čeká','solana-step-state'),node('small',({scanner:'Nové pooly a aktivita','rug-check':'Authority, držitelé a likvidita',sizer:'Velikost pozice a limity',executor:'Kotace a PAPER obchody',logger:'Každé rozhodnutí má důvod',equity:'Ocenění a výsledek účtu'})[id],'solana-step-detail'));step.addEventListener('click',()=>openDialog('activity'));pipeline.append(step);
    }
    $('[data-solana="toggle"]').addEventListener('click',()=>mutate('/api/solana/automation',{enabled:!data?.automation?.enabled},true));
    $('[data-solana="scan"]').addEventListener('click',()=>mutate('/api/solana/cycle'));
    root.querySelectorAll('[data-solana-open]').forEach(button=>button.addEventListener('click',()=>openDialog(button.dataset.solanaOpen)));
    root.querySelectorAll('[data-solana-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
    root.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)dialog.close();}}));
    return true;
  }

  async function request(path,options={}) {
    const response=await fetch(path,{cache:'no-store',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
    const body=await response.json();
    if(!response.ok){const error=new Error(body.error||'Služba není dostupná.');error.status=response.status;error.snapshot=body.snapshot;throw error;}
    return body;
  }

  function revoke() {
    eligible=false;generation++;data=null;lastContact=null;clearTimeout(timer);candidateSignatures.clear();
    root.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    root.querySelectorAll('button').forEach(button=>{button.disabled=true;});
    for(const id of ['candidates','positions','decisions','trades','activity','tail','chart'])$(`[data-solana="${id}"]`).replaceChildren();
    for(const id of ['cash','equity','pnl'])$(`[data-solana="${id}"]`).textContent='—';
    $('[data-solana="engine-status"]').textContent='Přístup není dostupný';
  }

  function clock() {
    if(!data||!root)return;
    const automation=data.automation||{enabled:false,status:'paused'};
    const running=Boolean(data.runtime?.running);
    const connected=lastContact!==null&&Date.now()-lastContact<10000;
    const wait=Math.max(0,Math.ceil((Date.parse(automation.nextRunAt||'')-Date.now())/1000))||0;
    root.dataset.engine=running?'running':automation.enabled?'waiting':'paused';
    $('[data-solana="engine-status"]').textContent=!connected?'Spojení se obnovuje':running?'Pracuje':automation.enabled?'Sledování běží':'Pozastaveno';
    $('[data-solana="countdown"]').textContent=running?`${labels[data.runtime.stage]||'Kontrola'} · ${Math.max(0,Math.floor((Date.now()-Date.parse(data.runtime.startedAt))/1000))} s`:automation.enabled?`Další sken ${wait>0?`za ${wait} s`:'se připravuje'}`:'Automatický sken každých 60 s';
    const toggle=$('[data-solana="toggle"]');toggle.textContent=automation.enabled?'Pozastavit':'Spustit PAPER';toggle.classList.toggle('is-enabled',automation.enabled);toggle.disabled=!eligible||command||!connected;
    const cooldown=Math.max(0,Math.ceil((Date.parse(data.nextCycleAt||'')-Date.now())/1000))||0;
    $('[data-solana="scan"]').disabled=!eligible||command||running||cooldown>0||!connected;
    $('[data-solana="scan"]').title=cooldown>0?`Další sken za ${cooldown} s`:'Jednorázový sken';
    root.querySelectorAll('[data-solana-close-position]').forEach(button=>{button.disabled=!eligible||command||running||cooldown>0||!connected;});
    $('[data-solana="contact"]').textContent=lastContact?`Server ${time(lastContact)}`:'Čekám na server';
  }

  function renderCandidates() {
    const feed=$('[data-solana="candidates"]');
    const candidates=data.candidates||[];
    const focused=feed.contains(document.activeElement);
    if(focused)return;
    feed.replaceChildren();
    $('[data-solana="feed-count"]').textContent=candidates.length?`${candidates.length} posledních nálezů`:'Čeká na data';
    const signatures=new Map();
    for(const candidate of candidates.slice(0,20)){
      const signature=[candidate.observedAt,candidate.status,candidate.reason].join('|');signatures.set(candidate.mint,signature);
      const row=node('article',undefined,'solana-candidate');
      if(candidateSignatures.size&&candidateSignatures.get(candidate.mint)!==signature)row.classList.add('is-new');
      const identity=node('div',undefined,'solana-candidate-name');identity.append(node('b',candidate.symbol||candidate.mint.slice(0,8)),node('small',`${candidate.mint.slice(0,5)}…${candidate.mint.slice(-4)}`));identity.title=candidate.mint;
      const liquidity=node('div',undefined,'solana-candidate-liquidity');liquidity.append(node('b',`$${shortMoney(candidate.liquidityUsd)}`),node('small','likvidita'));
      const result=node('div',undefined,'solana-candidate-result');result.dataset.result=candidate.status;
      const resultNames={eligible:'Kandidát',blocked:'Odmítnuto',checking:'Kontroluji',passed:'Prověřeno',bought:'PAPER nákup'};
      result.append(node('span',resultNames[candidate.status]||'Zjištěno'),node('small',candidate.reason||'Čeká na kontrolu'));result.title=candidate.reason||'';
      row.append(identity,liquidity,result);feed.append(row);
    }
    candidateSignatures=signatures;
    if(!candidates.length)feed.append(node('p','Spusť PAPER. Tady uvidíš nálezy a konkrétní důvody kontrol.','solana-empty'));
  }

  function renderPositions() {
    const container=$('[data-solana="positions"]');container.replaceChildren();
    if(!data.positions?.length){container.append(node('p','Žádná otevřená pozice. Nákup čeká na kandidáta, který projde všemi kontrolami.','solana-empty'));return;}
    for(const position of data.positions){
      const row=node('article',undefined,'solana-position');const info=node('div');info.append(node('b',position.symbol||position.mint.slice(0,8)),node('small',`Náklad ${money(position.costUsdc+position.entryFeeUsdc)} USDC`));info.title=position.mint;
      const value=node('strong',position.markUsdc===null?'Neověřeno':`${money(position.markUsdc)} USDC`);value.title=position.markError||`Prodejní kotace ${time(position.markedAt)}`;
      const button=node('button','Uzavřít');button.type='button';button.dataset.solanaClosePosition=position.id;button.setAttribute('aria-label',`Uzavřít PAPER pozici ${position.symbol}`);button.addEventListener('click',()=>mutate(`/api/solana/positions/${encodeURIComponent(position.id)}/close`));
      row.append(info,value,button);container.append(row);
    }
  }

  function renderActivity() {
    const container=$('[data-solana="activity"]');container.replaceChildren();
    if(!data.decisions?.length)container.append(node('p','Po prvním skenu zde budou skutečné události krok za krokem.','solana-empty'));
    for(const event of data.decisions||[]){const row=node('article',undefined,'solana-event');row.append(node('time',time(event.occurredAt)),node('b',labels[event.stage]||event.stage),node('p',event.reason));container.append(row);}
  }

  function renderTail() {
    const tail=$('[data-solana="tail"]');tail.replaceChildren();
    for(const event of (data.decisions||[]).slice(0,20)){
      const row=node('article',undefined,'solana-tail-row');
      row.dataset.status=event.status;
      row.append(node('time',time(event.occurredAt)),node('b',labels[event.stage]||event.stage),node('span',event.reason));
      row.title=event.reason;tail.append(row);
    }
    if(!data.decisions?.length)tail.append(node('p','Čekám na první skutečnou událost.','solana-empty'));
  }

  function renderChart() {
    const chart=$('[data-solana="chart"]');chart.replaceChildren();
    const history=data.equityHistory||[];
    if(history.length<2){chart.append(node('small',history.length?'První bod uložený. Další vznikne při dalším skenu.':'Křivka začne po dokončených skenech.'));return;}
    const known=history.filter(point=>Number.isFinite(point.valueUsdc));
    if(!known.length){chart.append(node('small','Chybí ověřené ocenění.'));return;}
    const low=Math.min(...known.map(point=>point.valueUsdc));const high=Math.max(...known.map(point=>point.valueUsdc));
    const range=Math.max(high-low,.1);const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 400 45');svg.setAttribute('role','img');svg.setAttribute('aria-label','Historie skutečně uložených PAPER ocenění');
    let segment=[];
    const append=()=>{if(!segment.length)return;const line=document.createElementNS(ns,'polyline');line.setAttribute('points',segment.join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');svg.append(line);segment=[];};
    history.forEach((point,index)=>{if(!Number.isFinite(point.valueUsdc)){append();return;}const x=4+index/(history.length-1)*392;const y=high===low?22:39-(point.valueUsdc-low)/range*33;segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));dot.setAttribute('r','2');dot.setAttribute('fill','currentColor');svg.append(dot);});append();chart.append(svg,node('small',`${money(known[0].valueUsdc)} → ${money(known.at(-1).valueUsdc)} USDC · jen dokončené skeny`));
  }

  function render(dataPart) {
    if(data?.asOf&&dataPart.asOf&&Date.parse(dataPart.asOf)<Date.parse(data.asOf))return;
    data={...data,...dataPart};
    $('[data-solana="equity"]').textContent=money(data.equityUsdc);
    $('[data-solana="equity"]').title=data.equityUsdc===null?'Chybí čerstvá prodejní kotace; zkus další sken.':'Konzervativní model prodejní hodnoty';
    $('[data-solana="cash"]').textContent=money(data.cashUsdc);
    $('[data-solana="positions-count"]').textContent=`${data.positions?.length||0} / ${data.limits.maxOpenPositions} pozice`;
    const pnl=data.equityUsdc===null?null:data.equityUsdc-data.initialUsdc;
    const result=$('[data-solana="pnl"]');result.textContent=pnl===null?'Neověřeno':`${pnl>0?'+':''}${money(pnl)}`;result.className=pnl>0?'solana-positive':pnl<0?'solana-negative':'';
    $('[data-solana="trades-count"]').textContent=`${data.counters?.trades??data.trades?.length??0} simulovaných obchodů`;
    for(const id of stages){
      const card=$(`[data-stage="${id}"]`);const stage=data.stages?.find(item=>item.id===id);
      const active=data.runtime?.running&&data.runtime.stage===id;
      const status=active?'running':stage?.status||'idle';card.dataset.status=status;card.title=active?data.runtime.detail:stage?.detail||'V tomto skenu se tento krok zatím neprovedl.';
      card.querySelector('.solana-step-state').textContent=states[status]||'Čeká';
    }
    $('[data-solana="work"]').textContent=data.runtime?.running?data.runtime.detail||'Ověřuji tržní data…':data.automation?.lastError||data.lastCycle?data.automation?.lastError||`Poslední sken ${time(data.lastCycle.completedAt||data.lastCycle.startedAt)} · důvody jsou v radaru a evidenci.`:'Připraveno. Spusť PAPER sledování.';
    for(const [target,key] of [['pools-count','poolsSeen'],['risk-count','riskChecked'],['cycles-count','cycles']])$(`[data-solana="${target}"]`).textContent=String(data.counters?.[key]||0);
    renderCandidates();renderPositions();renderTail();renderChart();
    if($('[data-solana-dialog="activity"]').open)renderActivity();
    clock();
  }

  async function refresh(full=false) {
    if(!eligible||!visible||fetching)return;
    fetching=true;const version=generation;
    try{const next=await request(full?'/api/solana':'/api/solana/live');if(version===generation&&eligible&&visible){lastContact=Date.now();render(next);}}
    catch(error){if(version!==generation)return;lastContact=null;if([401,403,404].includes(error.status)){revoke();$('[data-solana="feedback"]').textContent='Přístup k pilotu není dostupný. Obnov přihlášení.';}else $('[data-solana="feedback"]').textContent='Spojení se serverem se nepodařilo obnovit. Zkusím to znovu.';clock();}
    finally{fetching=false;}
  }

  async function mutate(path,body,control=false) {
    if(!eligible||command)return;
    command=true;const version=generation;$('[data-solana="feedback"]').textContent=control?'Ukládám ovládání…':'Probíhá skutečné vyhodnocení…';clock();
    try{const next=await request(path,{method:'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});if(version!==generation)return;lastContact=Date.now();render(next);$('[data-solana="feedback"]').textContent=control?(next.automation?.enabled?'Sledování spuštěno. Nový sken přibližně každou minutu.':'Pozastaveno. Další automatické skeny a výstupy se nespustí.'):'Vyhodnocení je uložené v evidenci.';if(control&&next.automation?.enabled)await refresh();}
    catch(error){if(version!==generation)return;if(error.snapshot)render(error.snapshot);$('[data-solana="feedback"]').textContent=error.message;if([401,403,404].includes(error.status))revoke();}
    finally{command=false;clock();}
  }

  function rules() {
    const list=$('[data-solana="rules-list"]');list.replaceChildren();if(!data)return;
    const l=data.limits;
    const values=[['Virtuální začátek',`${money(data.initialUsdc)} USDC`],['Jedna pozice / vložený kapitál',`${money(l.maxPositionUsdc)} / ${money(l.maxExposureUsdc)} USDC`],['Likvidita / objem za 5 min',`${shortMoney(l.minLiquidityUsd)} / ${shortMoney(l.minVolume5mUsd)} USD`],['Stáří poolu','5 minut až 24 hodin'],['Mint / freeze authority','Odvolané'],['Největší držitel / uzamčení',`≤ ${l.maxHolderPct} % / ≥ ${l.minLiquidityLockedPct} %`],['Výstup při skenu',`−${l.stopLossPct} % / +${l.takeProfitPct} % / ${l.maxHoldingMinutes} min`],['Brzdy za posledních 24 h',`${l.maxDailyEntries} vstupů / ${l.maxDailyLossUsdc} USDC realizovaných ztrát`],['Model skluzu / síťového nákladu',`${l.slippageBps/100} % / ${money(l.networkFeeUsdc)} USDC na stranu`]];
    for(const [key,value] of values){const row=node('div');row.append(node('dt',key),node('dd',value));list.append(row);}
  }

  async function openDialog(name) {
    if(!data||!eligible)return;
    if(name==='rules')rules();
    if(name==='activity')renderActivity();
    const dialog=$(`[data-solana-dialog="${name}"]`);dialog.showModal();
    if(name!=='ledger')return;
    const version=generation;
    $('[data-solana="decisions"]').replaceChildren(node('p','Načítám evidenci…'));
    try{
      const full=await request('/api/solana');if(version!==generation||!eligible)return;
      data={...data,...full};const trades=$('[data-solana="trades"]');trades.replaceChildren();
      if(!full.trades.length)trades.append(node('p','Zatím žádný simulovaný obchod.','solana-empty'));
      for(const trade of full.trades){const row=node('article',undefined,'solana-event');row.append(node('time',time(trade.occurredAt)),node('b',`${trade.side==='BUY'?'PAPER nákup':'PAPER prodej'} · ${money(trade.grossUsdc)} USDC`),node('p',`Síťový model: ${money(trade.networkFeeUsdc)} USDC · ${trade.tokenAmount} raw jednotek`));trades.append(row);}
      const decisions=$('[data-solana="decisions"]');decisions.replaceChildren();
      for(const event of full.decisions){const detail=node('details',undefined,'solana-evidence');const summary=node('summary',`${time(event.occurredAt)} · ${labels[event.stage]||event.stage} · ${event.reason}`);detail.append(summary,node('pre',JSON.stringify(event.evidence,null,2)));decisions.append(detail);}
      if(!full.decisions.length)decisions.append(node('p','Evidence se naplní po prvním skenu.','solana-empty'));
    }catch(error){$('[data-solana="decisions"]').replaceChildren(node('p',error.message));}
  }

  function schedule(){clearTimeout(timer);if(visible&&eligible)timer=setTimeout(async()=>{await refresh();schedule();},data?.runtime?.running?1000:2000);}
  window.OceanSolanaPanel={
    setUser(user){if(!mount())return;const allowed=Boolean(user?.features?.solanaTerminal&&!user.suspended&&(user.accessApproved??user.emailVerified));if(allowed===eligible)return;generation++;eligible=allowed;if(!allowed){revoke();}else {root.querySelectorAll('button').forEach(button=>{button.disabled=false;});if(visible)refresh(true).then(schedule);}},
    setVisible(next){if(!mount())return;const changed=visible!==Boolean(next);visible=Boolean(next);if(!visible){clearTimeout(timer);root.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());}else if(eligible&&changed){refresh(true).then(schedule);}},
    refresh:()=>refresh(true),
  };
  setInterval(()=>{if(visible&&eligible)clock();},1000);
})();
