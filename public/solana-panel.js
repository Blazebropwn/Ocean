(() => {
  const labels = { scanner:'Hledání', 'rug-check':'Prověření', sizer:'Rozpočet', executor:'Nákup a prodej', logger:'Záznamy', equity:'Výsledek' };
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
      <header class="solana-head"><div><h2>Solana <span class="solana-paper">Zkušební režim</span></h2><p>Hledání příležitostí s klidem a přehledem</p></div><div class="solana-head-actions"><button type="button" class="solana-one-shot" data-solana="scan" title="Jednorázové vyhodnocení">Zkontrolovat teď</button><button class="solana-rules-button" type="button" data-solana-open="rules">Pravidla <span aria-hidden="true">↗</span></button></div></header>
      <div class="solana-wallet" aria-label="Zkušební účet v USDC"><div><span>Hodnota účtu</span><strong data-solana="equity">—</strong><small>virtuální USDC</small></div><div><span>K dispozici</span><strong data-solana="cash">—</strong><small data-solana="positions-count">0 otevřených obchodů</small></div><div><span>Celkový výsledek</span><strong data-solana="pnl">—</strong><small data-solana="trades-count">0 zkušebních obchodů</small></div></div>
      <div class="solana-controls"><div class="solana-engine-state"><span class="solana-signal" aria-hidden="true"></span><div><strong data-solana="engine-status">Načítám</strong><small data-solana="countdown">Čekám na spojení</small></div></div><button type="button" class="solana-start" data-solana="toggle" disabled>Spustit sledování</button></div>
      <p class="solana-feedback" data-solana="feedback" role="status"></p>
      <section class="solana-story" aria-label="Co se právě děje"><div class="solana-progress-summary"><div><h3 data-solana="story-title">Připraveno na první příležitost</h3><p data-solana="story-text">Spusť sledování a podívej se, co se na trhu děje.</p></div><small data-solana="last-check">První kontrola čeká na spuštění</small></div><div class="solana-pipeline" aria-label="Průběh skutečných kontrol"></div><div class="solana-progress-meta"><div class="solana-progress-notes"><span data-solana="pipeline-caption">Postup vyhodnocení</span><span data-solana="cycle-summary" hidden></span></div><div class="solana-counters"><span title="Součet kontrol včetně opakovaného prověření stejných tokenů"><b data-solana="pools-count">0</b> kontrol celkem</span><span><b data-solana="risk-count">0</b> prověření rizik</span><span><b data-solana="cycles-count">0</b> kontrolních kol</span></div></div></section>
      <div class="solana-stream-grid"><section class="solana-stream"><header><div><h3 data-solana="feed-title">Objevené tokeny</h3><p data-solana="watch-summary">Co jsme právě prověřovali</p></div><span data-solana="feed-count">Čeká na data</span></header><div data-solana="candidates" class="solana-candidates"></div></section><section class="solana-open-positions"><header><h3>Tvé zkušební obchody</h3><button type="button" class="solana-text-button" data-solana-open="ledger">Historie →</button></header><div data-solana="positions"></div><div class="solana-equity-history"><span>Vývoj účtu</span><div data-solana="chart"></div></div></section><section class="solana-live-activity"><header><div><h3>Právě se děje</h3><p>Poslední skutečné události</p></div><button type="button" class="solana-text-button" data-solana-open="activity">Vše →</button></header><div class="solana-live-tail"><div data-solana="tail"></div></div></section></div>
      <footer class="solana-bottom"><span>Virtuální peníze · skutečná tržní data</span><span data-solana="contact">Čekám na spojení</span></footer>
      <dialog class="solana-dialog" data-solana-dialog="candidate" aria-label="Podrobnosti tokenu"><header><h2 data-solana="candidate-title">Detail tokenu</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body" data-solana="candidate-detail"></div></dialog>
      <dialog class="solana-dialog" data-solana-dialog="rules" aria-label="Pravidla Solana pilotu"><header><h2>Pravidla sledování</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body"><p>Začínáš se 100 virtuálními USDC. <b>Spustit sledování</b> zapne kontroly přibližně každou minutu. Běží i po zavření prohlížeče.</p><p><b>Pozastavit</b> zastaví další hledání, přecenění i výstupy. Rozpracovaná kontrola může dokončit již zahájené ocenění či výstup; nové automatické nákupy se zablokují.</p><dl data-solana="rules-list"></dl><p>Token musí projít všemi pravidly a musí existovat nákupní i zpětná prodejní kotace. Neúplná data nebo nedostupná trasa znamenají vynechání. Při neověřené prodejní ceně zůstává obchod otevřený a aktuální výsledek se nezobrazuje.</p><p>Jde o simulaci. Zahrnuje rezervu na skluz a model síťových nákladů, které se mohou od skutečného obchodu lišit. Splnění kontrol ani report třetí strany nezaručují bezpečnost tokenu nebo výnos.</p><p>Zdroje: <a href="https://www.geckoterminal.com/" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>, <a href="https://rugcheck.xyz/" target="_blank" rel="noopener noreferrer">RugCheck</a> a <a href="https://developers.jup.ag/docs/swap/order-and-execute" target="_blank" rel="noopener noreferrer">Jupiter</a>.</p></div></dialog>
      <dialog class="solana-dialog" data-solana-dialog="activity" aria-label="Průběh kontrol"><header><h2>Poslední události</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body" data-solana="activity"></div></dialog>
      <dialog class="solana-dialog" data-solana-dialog="ledger" aria-label="Historie zkušebních obchodů"><header><h2>Historie a podrobnosti</h2><button type="button" data-solana-close aria-label="Zavřít">×</button></header><div class="solana-dialog-body"><h3>Zkušební obchody</h3><div data-solana="trades"></div><h3>Rozhodnutí a vstupy</h3><div data-solana="decisions"></div></div></dialog>`;
    const pipeline=$('.solana-pipeline');
    for(const [index,id] of stages.entries()){
      const step=node('button',undefined,'solana-step');step.type='button';step.dataset.stage=id;
      const head=node('span',undefined,'solana-step-head');head.append(node('small',String(index+1).padStart(2,'0')),node('b',labels[id]));
      step.append(head,node('span','Čeká','solana-step-state'),node('small',({scanner:'Nové tokeny a aktivita','rug-check':'Oprávnění, držitelé a likvidita',sizer:'Velikost obchodu a limity',executor:'Podmínky nákupu i prodeje',logger:'Každé rozhodnutí má důvod',equity:'Hodnota a výsledek účtu'})[id],'solana-step-detail'));step.addEventListener('click',()=>openDialog('activity'));pipeline.append(step);
    }
    $('[data-solana="toggle"]').addEventListener('click',()=>mutate('/api/solana/automation',{enabled:!data?.automation?.enabled},true));
    $('[data-solana="scan"]').addEventListener('click',()=>mutate('/api/solana/cycle'));
    root.querySelectorAll('[data-solana-open]').forEach(button=>button.addEventListener('click',()=>{button.closest('dialog')?.close();openDialog(button.dataset.solanaOpen);}));
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
    const limited=Boolean(data.marketData?.rateLimited);
    const providerRetry=Math.max(0,Math.ceil((Date.parse(data.marketData?.retryAt||'')-Date.now())/1000))||0;
    const wait=Math.max(0,Math.ceil((Date.parse(automation.nextRunAt||'')-Date.now())/1000))||0;
    const retry=Math.max(providerRetry,automation.enabled?wait:0);
    root.dataset.engine=running?'running':limited?'limited':automation.enabled?'waiting':'paused';
    $('[data-solana="engine-status"]').textContent=!connected?'Spojení se obnovuje':running?'Prověřujeme trh':limited?'Zdroj dat má omezení':automation.lastError?'Čekáme na data':automation.enabled?'Sledování běží':'Pozastaveno';
    $('[data-solana="countdown"]').textContent=running?`${labels[data.runtime.stage]||'Kontrola'} · ${Math.max(0,Math.floor((Date.now()-Date.parse(data.runtime.startedAt))/1000))} s`:limited?retry>0?`Obnovení dat za ${retry} s`:'Čekáme na obnovení zdroje':automation.enabled?`Další sken ${wait>0?`za ${wait} s`:'se připravuje'}`:'Automatický sken každých 60 s';
    const toggle=$('[data-solana="toggle"]');toggle.textContent=automation.enabled?'Pozastavit':'Spustit sledování';toggle.classList.toggle('is-enabled',automation.enabled);toggle.disabled=!eligible||command||!connected;
    const cooldown=Math.max(0,Math.ceil((Date.parse(data.nextCycleAt||'')-Date.now())/1000))||0;
    $('[data-solana="scan"]').disabled=!eligible||command||running||cooldown>0||limited||!connected;
    $('[data-solana="scan"]').title=limited?'Zdroj dat omezuje požadavky. Další pokus počká na obnovení.':cooldown>0?`Další sken za ${cooldown} s`:'Jednorázový sken';
    root.querySelectorAll('[data-solana-close-position]').forEach(button=>{button.disabled=!eligible||command||running||cooldown>0||!connected;});
    $('[data-solana="contact"]').textContent=lastContact?`Spojení ověřeno ${time(lastContact)}`:'Čekám na spojení';
    renderStory(connected);
  }

  function renderStory(connected) {
    const automation=data.automation||{};
    const running=Boolean(data.runtime?.running);
    let title='Sledování je pozastavené',text='Spusť ho, až budeš chtít znovu hledat příležitosti.',tone='calm';
    if(!connected){title='Obnovujeme spojení';text='Zobrazené hodnoty mohou být starší. Až se spojení obnoví, přehled se doplní.';tone='attention';}
    else if(running){title='Prověřujeme nové příležitosti';text=data.runtime.detail||'Načítáme trh a ověřujeme podmínky pro případný obchod.';tone='active';}
    else if(data.marketData?.rateLimited){title='Zdroj dat omezuje požadavky';text=automation.enabled?'Další pokus spustí automat po odpočtu.':'Sledování je pozastavené; po spuštění vyčká na data.';tone='attention';}
    else if(automation.lastError){title='Čekáme na nová data';text='Poslední kontrola se nezdařila. Automat ji zkusí znovu v uvedeném čase.';tone='attention';}
    else if(data.equityUsdc===null){title='Část hodnoty účtu čeká na ověření';text='U některého obchodu chybí čerstvá prodejní cena. Výsledek doplníme po úspěšné kontrole.';tone='attention';}
    else if(automation.enabled&&data.positions?.length){title='Sledujeme tvé obchody';text='Průběžně ověřujeme jejich hodnotu a podmínky pro uzavření.';tone='active';}
    else if(data.candidateFeed?.stale){title='Čekáme na čerstvé údaje';text='Nálezy níže pocházejí z předchozí kontroly. Jejich podmínky pro nový nákup teď nejsou ověřené.';tone='attention';}
    else if(automation.enabled&&data.candidates?.length&&data.candidates.every(candidate=>candidate.status==='blocked')){title='Hledáme dál';text='Tokeny v posledním výběru nesplnily pravidla pro nákup. Sledování pokračuje.';tone='active';}
    else if(automation.enabled){title='Rozhlížíme se po trhu';text='Čekáme na dokončení prověřování. Jakmile bude výsledek, uvidíš ho tady.';tone='active';}
    else if(!data.lastCycle){title='Připraveno na první příležitost';text='Začínáš se 100 virtuálními USDC. Spusť sledování a poznej, jak si vybíráme obchody.';}
    $('.solana-story').dataset.tone=tone;
    $('[data-solana="story-title"]').textContent=title;
    $('[data-solana="story-text"]').textContent=text;
    $('[data-solana="last-check"]').textContent=data.lastCycle?`Poslední kontrola ${time(data.lastCycle.completedAt||data.lastCycle.startedAt)}`:'První kontrola čeká na spuštění';
  }

  function simpleReason(candidate) {
    if(candidate.stale&&candidate.status==='checking')return 'Předchozí prověřování nebylo dokončeno.';
    if(candidate.stale&&candidate.status==='eligible')return 'Dříve ve výběru; aktuální podmínky nejsou ověřené.';
    if(candidate.stale&&candidate.status==='passed')return 'Dříve prověřeno; aktuální podmínky nejsou ověřené.';
    if(candidate.status==='checking')return 'Právě ověřujeme podmínky pro obchod.';
    if(candidate.status==='bought')return 'Otevřeli jsme zkušební obchod.';
    if(candidate.status==='passed')return 'Dosavadní prověření prošlo.';
    if(candidate.status==='eligible')return 'Ve výběru pro další prověření.';
    const reason=candidate.reason||'';
    if(/Likvidita je nižší/i.test(reason))return 'Na tomto trhu je zatím málo prostředků.';
    if(/Pool musí být starý/i.test(reason))return 'Stáří trhu nesplňuje naše pravidla.';
    if(/Objem za 5 minut/i.test(reason))return 'Aktivita trhu neprošla požadovaným limitem.';
    if(/program není/i.test(reason))return 'Tento typ tokenu zatím nepodporujeme.';
    if(/Koncentrace/i.test(reason))return 'Rozdělení tokenů mezi držitele neprošlo kontrolou.';
    if(/uzamčení/i.test(reason))return 'Zajištění prostředků na trhu není dostatečně ověřené.';
    if(/authority/i.test(reason))return 'Oprávnění vydavatele tokenu neprošla kontrolou.';
    if(/HTTP|časový limit|nejsou dostupná/i.test(reason))return 'Pro rozhodnutí nám chybí potřebná data.';
    if(/kotace|trasa|skluz|poplatek/i.test(reason))return 'Podmínky nákupu a prodeje se nepodařilo ověřit.';
    if(/limit|Brzda/i.test(reason))return 'Další vstup blokuje některý z nastavených limitů.';
    return 'Zatím nesplnil podmínky pro nákup.';
  }

  function candidateReasons(candidate) {
    const reasons=Array.isArray(candidate.reasons)?candidate.reasons.filter(reason=>typeof reason==='string'&&reason.trim()):[];
    if(!reasons.length&&candidate.reason)reasons.push(candidate.reason);
    return [...new Set(reasons)];
  }

  function showCandidate(candidate) {
    const dialog=$('[data-solana-dialog="candidate"]');dialog.dataset.mint=candidate.mint;dialog.dataset.stale=String(Boolean(candidate.stale));
    $('[data-solana="candidate-title"]').textContent=candidate.symbol||'Detail tokenu';
    const detail=$('[data-solana="candidate-detail"]');detail.replaceChildren();
    if(candidate.stale)detail.append(node('p',`Starší data · poslední načtení ${time(candidate.observedAt||data.candidateFeed?.observedAt)}. Uvedené důvody patří k předchozí kontrole, aktuální podmínky nejsou ověřené.`,'solana-stale-notice'));
    detail.append(node('p',simpleReason(candidate),'solana-candidate-explanation'));
    const reasons=candidateReasons(candidate);
    if(reasons.length){
      detail.append(node('h3',candidate.status==='blocked'?(Array.isArray(candidate.reasons)?'Všechny důvody vynechání':'Uložený důvod vynechání'):'Výsledek poslední kontroly'));
      const list=node('ul',undefined,'solana-reasons');
      for(const reason of reasons)list.append(node('li',reason));
      detail.append(list);
    }
    const values=node('dl');
    for(const [label,value] of [['Prostředky na trhu',`${shortMoney(candidate.liquidityUsd)} USD`],['Objem obchodů za 5 minut',`${shortMoney(candidate.volume5mUsd)} USD`],['Načteno',time(candidate.observedAt)],['Odkud token známe',candidate.stale?'Poslední uložená kontrola':candidate.source==='watchlist'?'Dříve nalezený trh, znovu prověřený':candidate.source==='discovery'?'Nově objevený trh':'Poslední uložená kontrola']]){const row=node('div');row.append(node('dt',label),node('dd',value));values.append(row);}
    detail.append(values);
    const technical=node('details',undefined,'solana-evidence');technical.append(node('summary','Technické údaje'),node('small',`Adresa tokenu: ${candidate.mint}`));detail.append(technical);
    if(!dialog.open)dialog.showModal();
  }

  function renderCandidates() {
    const feed=$('[data-solana="candidates"]');
    const candidates=data.candidates||[];
    const focusedMint=feed.contains(document.activeElement)?document.activeElement.closest('[data-mint]')?.dataset.mint:null;
    const stale=Boolean(data.candidateFeed?.stale);
    const scroll=feed.scrollTop;
    feed.replaceChildren();
    $('[data-solana="feed-title"]').textContent=stale?'Poslední známé nálezy':'Objevené tokeny';
    $('[data-solana="feed-count"]').textContent=stale?`Starší data · ${time(data.candidateFeed?.observedAt)}`:candidates.length?`${candidates.length} posledních nálezů`:'Čeká na data';
    const signatures=new Map();
    for(const stored of candidates.slice(0,20)){
      const candidate={...stored,stale:Boolean(stale||stored.stale)};
      const reasons=candidateReasons(candidate);
      const signature=[candidate.observedAt,candidate.status,candidate.stale,...reasons].join('|');signatures.set(candidate.mint,signature);
      const row=node('button',undefined,'solana-candidate');row.type='button';row.setAttribute('aria-label',`Podrobnosti tokenu ${candidate.symbol||candidate.mint.slice(0,8)}`);row.addEventListener('click',()=>showCandidate(candidate));
      row.dataset.mint=candidate.mint;row.dataset.stale=String(candidate.stale);
      if(!candidate.stale&&candidateSignatures.size&&candidateSignatures.get(candidate.mint)!==signature)row.classList.add('is-new');
      const avatar=node('span',(candidate.symbol||'?').replace(/[^a-z0-9]/ig,'').slice(0,2).toUpperCase()||'◎','solana-token-avatar');avatar.setAttribute('aria-hidden','true');
      const identity=node('span',undefined,'solana-candidate-name');identity.append(node('b',candidate.symbol||candidate.mint.slice(0,8)),node('small',simpleReason(candidate)));
      const context=[];
      if(candidate.status==='blocked'&&reasons.length>1)context.push(`${reasons.length} ${reasons.length<5?'důvody':'důvodů'} vynechání`);
      if(candidate.stale)context.push(`Starší data · ${time(candidate.observedAt||data.candidateFeed?.observedAt)}`);
      else if(candidate.source==='watchlist')context.push('Znovu prověřeno');
      if(context.length)identity.append(node('small',context.join(' · '),'solana-candidate-context'));
      const result=node('div',undefined,'solana-candidate-result');result.dataset.result=candidate.stale?'stale':candidate.status;
      const resultNames={eligible:'Ve výběru',blocked:'Vynecháno',checking:'Prověřujeme',passed:'Prověřeno',bought:'Zkušební nákup'};
      result.append(node('span',candidate.stale?'Starší data':resultNames[candidate.status]||'Zjištěno'),node('small','Podrobnosti ›'));
      row.append(avatar,identity,result);feed.append(row);
      const dialog=$('[data-solana-dialog="candidate"]');
      if(dialog.open&&dialog.dataset.mint===candidate.mint&&dialog.dataset.stale!==String(candidate.stale))showCandidate(candidate);
    }
    candidateSignatures=signatures;
    if(!candidates.length)feed.append(node('p','Po první kontrole tu uvidíš objevené tokeny a výsledek jejich prověření.','solana-empty'));
    feed.scrollTop=scroll;
    if(focusedMint)[...feed.children].find(row=>row.dataset.mint===focusedMint)?.focus({preventScroll:true});
  }

  function renderDiagnostics() {
    const diagnostics=data.diagnostics;
    root.dataset.diagnostics=String(Boolean(diagnostics));
    const summary=$('[data-solana="cycle-summary"]');summary.hidden=!diagnostics;
    if(diagnostics){
      summary.textContent=`${diagnostics.policyVersion==='legacy'?'Starší kolo':'Poslední kolo'}: ${diagnostics.inspectedTokens} různých tokenů · ${diagnostics.rejectedTokens} vynecháno`;
      summary.title=(diagnostics.rejectionCounts||[]).map(entry=>`${entry.count}× ${entry.reason}`).join('\n');
    }
    const watch=$('[data-solana="watch-summary"]'),stats=data.watchlist;
    const stale=Boolean(data.candidateFeed?.stale);
    watch.classList.toggle('solana-watch-summary',Boolean(stats)||stale);
    const errorWord=stats?.refreshErrors===1?'chyba':stats?.refreshErrors<5?'chyby':'chyb';
    watch.textContent=stale?`Starší data · načteno ${time(data.candidateFeed?.observedAt)}`:stats?`${stats.lastError?'Část dat chybí · ':''}Sledujeme ${stats.trackedPools} trhů · obnoveno ${stats.refreshedPools}${stats.refreshErrors?` · ${stats.refreshErrors} ${errorWord}`:''}`:'Co jsme právě prověřovali';
    watch.dataset.error=String(stale||Boolean(stats?.refreshErrors||stats?.lastError));
    watch.title=stats?`${stats.trackedTokens} různých tokenů v průběžném sledování. Obnovení a chyby se vztahují k poslednímu kolu.${stats.lastError?` Poslední chyba: ${stats.lastError}`:''}`:'';
  }

  function renderPositions() {
    const container=$('[data-solana="positions"]');container.replaceChildren();
    if(!data.positions?.length){const empty=node('div',undefined,'solana-no-trades');const icon=node('span','◎','solana-empty-icon');icon.setAttribute('aria-hidden','true');empty.append(icon,node('strong','Čekáme na vhodnou příležitost'),node('p','Zatím nemáš otevřený obchod. Až token splní všechny podmínky, objeví se tady.'));container.append(empty);return;}
    for(const position of data.positions){
      const row=node('article',undefined,'solana-position');const info=node('div');info.append(node('b',position.symbol||position.mint.slice(0,8)),node('small',`Náklad ${money(position.costUsdc+position.entryFeeUsdc)} USDC`));info.title=position.mint;
      const value=node('strong',position.markUsdc===null?'Neověřeno':`${money(position.markUsdc)} USDC`);value.title=position.markError||`Prodejní kotace ${time(position.markedAt)}`;
      const button=node('button','Uzavřít');button.type='button';button.dataset.solanaClosePosition=position.id;button.setAttribute('aria-label',`Uzavřít PAPER pozici ${position.symbol}`);button.addEventListener('click',()=>mutate(`/api/solana/positions/${encodeURIComponent(position.id)}/close`));
      row.append(info,value,button);container.append(row);
    }
  }

  function renderActivity() {
    const container=$('[data-solana="activity"]');container.replaceChildren();
    if(data.diagnostics){
      const diagnostics=data.diagnostics;
      const summary=node('section',undefined,'solana-cycle-diagnostics');summary.dataset.solana='cycle-rejections';
      summary.append(node('h3','Důvody vynechání v posledním kole'),node('p',`${diagnostics.inspectedTokens} různých tokenů prověřeno · ${diagnostics.rejectedTokens} vynecháno.`));
      if(diagnostics.policyVersion==='legacy')summary.append(node('p','Starší záznamy obsahují jen první uložený důvod. Nové kontroly uvádějí všechny.'));
      if(diagnostics.rejectionCounts?.length){
        const list=node('ul',undefined,'solana-reasons');
        for(const entry of diagnostics.rejectionCounts)list.append(node('li',`${entry.count}× ${entry.reason}`));
        summary.append(list,node('small','Jeden token může mít více důvodů. Tyto počty se proto mohou překrývat.'));
      }
      container.append(summary);
    }
    if(!data.decisions?.length)container.append(node('p','Po prvním skenu zde budou skutečné události krok za krokem.','solana-empty'));
    for(const event of data.decisions||[]){const row=node('article',undefined,'solana-event');row.append(node('time',time(event.occurredAt)),node('b',labels[event.stage]||event.stage),node('p',event.reason));container.append(row);}
  }

  function renderTail() {
    const tail=$('[data-solana="tail"]');const viewport=tail.parentElement;const scroll=viewport.scrollTop;tail.replaceChildren();
    for(const event of (data.decisions||[]).slice(0,20)){
      const row=node('article',undefined,'solana-tail-row');
      row.dataset.status=event.status;
      row.append(node('time',time(event.occurredAt)),node('b',labels[event.stage]||event.stage),node('span',event.reason));
      row.title=event.reason;tail.append(row);
    }
    if(!data.decisions?.length)tail.append(node('p','Čekám na první skutečnou událost.','solana-empty'));
    viewport.scrollTop=scroll;
  }

  function renderChart() {
    const chart=$('[data-solana="chart"]');chart.replaceChildren();
    const history=data.equityHistory||[];
    if(history.length<2){chart.append(node('small',history.length?'První bod uložený. Další vznikne při dalším skenu.':'Křivka začne po dokončených skenech.'));return;}
    const known=history.filter(point=>Number.isFinite(point.valueUsdc));
    if(!known.length){chart.append(node('small','Chybí ověřené ocenění.'));return;}
    const low=Math.min(...known.map(point=>point.valueUsdc));const high=Math.max(...known.map(point=>point.valueUsdc));
    const range=Math.max(high-low,.1);const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 400 45');svg.setAttribute('role','img');svg.setAttribute('aria-label','Historie uložené hodnoty zkušebního účtu');
    let segment=[];
    const append=()=>{if(!segment.length)return;const line=document.createElementNS(ns,'polyline');line.setAttribute('points',segment.join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');svg.append(line);segment=[];};
    history.forEach((point,index)=>{if(!Number.isFinite(point.valueUsdc)){append();return;}const x=4+index/(history.length-1)*392;const y=high===low?22:39-(point.valueUsdc-low)/range*33;segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));dot.setAttribute('r','2');dot.setAttribute('fill','currentColor');svg.append(dot);});append();chart.append(svg,node('small',`${money(known[0].valueUsdc)} → ${money(known.at(-1).valueUsdc)} USDC · zaznamenaný vývoj`));
  }

  function render(dataPart) {
    if(data?.asOf&&dataPart.asOf&&Date.parse(dataPart.asOf)<Date.parse(data.asOf))return;
    data={...data,...dataPart,diagnostics:dataPart.diagnostics,watchlist:dataPart.watchlist,marketData:dataPart.marketData,candidateFeed:dataPart.candidateFeed};
    $('[data-solana="equity"]').textContent=money(data.equityUsdc);
    $('[data-solana="equity"]').title=data.equityUsdc===null?'Chybí čerstvá prodejní kotace; zkus další sken.':'Konzervativní model prodejní hodnoty';
    $('[data-solana="cash"]').textContent=money(data.cashUsdc);
    $('[data-solana="positions-count"]').textContent=`${data.positions?.length||0} otevřených obchodů`;
    const pnl=data.equityUsdc===null?null:data.equityUsdc-data.initialUsdc;
    const result=$('[data-solana="pnl"]');result.textContent=pnl===null?'Neověřeno':`${pnl>0?'+':''}${money(pnl)}`;result.className=pnl>0?'solana-positive':pnl<0?'solana-negative':'';
    $('[data-solana="trades-count"]').textContent=`${data.counters?.trades??data.trades?.length??0} zkušebních obchodů`;
    for(const id of stages){
      const card=$(`[data-stage="${id}"]`);const stage=data.stages?.find(item=>item.id===id);
      const active=data.runtime?.running&&data.runtime.stage===id;
      const status=active?'running':stage?.status||'idle';card.dataset.status=status;card.title=active?data.runtime.detail:stage?.detail||'V tomto skenu se tento krok zatím neprovedl.';
      card.querySelector('.solana-step-state').textContent=status==='ok'?({logger:'Zapsáno',equity:'Spočítáno',executor:'Vyhodnoceno'})[id]||states.ok:states[status]||'Čeká';
    }
    $('[data-solana="pipeline-caption"]').textContent=data.runtime?.running?'Právě probíhá':data.lastCycle?'Průběh poslední kontroly':'Postup vyhodnocení';
    for(const [target,key] of [['pools-count','poolsSeen'],['risk-count','riskChecked'],['cycles-count','cycles']])$(`[data-solana="${target}"]`).textContent=String(data.counters?.[key]||0);
    renderCandidates();renderDiagnostics();renderPositions();renderTail();renderChart();
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
    try{const next=await request(path,{method:'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});if(version!==generation)return;lastContact=Date.now();render(next);$('[data-solana="feedback"]').textContent=control?(next.automation?.enabled?'Sledování spuštěno. Trh zkontrolujeme přibližně každou minutu.':'Pozastaveno. Další kontroly a automatické výstupy se nespustí.'):'Vyhodnocení je uložené v evidenci.';const notice=$('[data-solana="feedback"]').textContent;setTimeout(()=>{if($('[data-solana="feedback"]').textContent===notice)$('[data-solana="feedback"]').textContent='';},4000);if(control&&next.automation?.enabled)await refresh();}
    catch(error){if(version!==generation)return;if(error.snapshot)render(error.snapshot);$('[data-solana="feedback"]').textContent=error.message;if([401,403,404].includes(error.status))revoke();}
    finally{command=false;clock();}
  }

  function rules() {
    const list=$('[data-solana="rules-list"]');list.replaceChildren();if(!data)return;
    const l=data.limits;
    const values=[['Virtuální začátek',`${money(data.initialUsdc)} USDC`],['Jedna pozice / vložený kapitál',`${money(l.maxPositionUsdc)} / ${money(l.maxExposureUsdc)} USDC`],['Likvidita / objem za 5 min',`${shortMoney(l.minLiquidityUsd)} / ${shortMoney(l.minVolume5mUsd)} USD`],['Stáří poolu','5 minut až 24 hodin'],['Mint / freeze authority','Odvolané'],['Největší držitel / uzamčení',`≤ ${l.maxHolderPct} % / ≥ ${l.minLiquidityLockedPct} %`],['Rezervy obchodního poolu','Z držitelů vyjímáme jen ověřené účty rezerv PumpSwap. Neověřené účty se započítávají.'],['Výstup při skenu',`−${l.stopLossPct} % / +${l.takeProfitPct} % / ${l.maxHoldingMinutes} min`],['Brzdy za posledních 24 h',`${l.maxDailyEntries} vstupů / ${l.maxDailyLossUsdc} USDC realizovaných ztrát`],['Model skluzu / síťového nákladu',`${l.slippageBps/100} % / ${money(l.networkFeeUsdc)} USDC na stranu`]];
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
      for(const trade of full.trades){const row=node('article',undefined,'solana-event');row.append(node('time',time(trade.occurredAt)),node('b',`${trade.side==='BUY'?'Zkušební nákup':'Zkušební prodej'} · ${money(trade.grossUsdc)} USDC`),node('p',`Síťový model: ${money(trade.networkFeeUsdc)} USDC · ${trade.tokenAmount} raw jednotek`));trades.append(row);}
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
