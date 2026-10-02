(() => {
  const names = { wave:'Wave', fish:'Fish', shell:'Shell', octo:'Octo', core:'Ocean Core' };
  const number = (n, digits=0) => new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:digits}).format(n);
  const percent = n => `${number(n*100,4)} %`;
  let model, running=false;
  function metric(target, label, value, note) {
    const card=document.createElement('article'), title=document.createElement('small'), amount=document.createElement('strong');
    title.textContent=label; amount.textContent=value; card.append(title,amount);
    if(note){const caption=document.createElement('p');caption.textContent=note;card.append(caption);}
    target.append(card);
  }
  window.initAdmin = async () => {
    model=await inviteRequest('/api/admin/slot/math');
    const target=$('#math-metrics');target.replaceChildren();
    metric(target,'Teoretické RTP',percent(model.rtp),'Celková výplata / sázky');
    metric(target,'Pravděpodobnost výhry',percent(model.hitRate),'Alespoň jedna výplata');
    metric(target,'Průměrné čisté saldo',`${number(model.expectedNet,5)}`,'TIDE na jeden spin');
    metric(target,'Kombinace',number(model.combinations),`${model.bet} TIDE / spin`);
    $('#math-version').textContent=model.gameVersion;
    const tbody=$('#math-outcomes');tbody.replaceChildren();
    for(const outcome of model.outcomes){
      const row=document.createElement('tr'),symbol=document.createElement('td'),wrap=document.createElement('span'),img=document.createElement('img');
      wrap.className='math-symbol';img.src=`/slot/${outcome.symbol}.svg`;img.alt='';wrap.append(img,document.createTextNode(names[outcome.symbol]));symbol.append(wrap);row.append(symbol);
      for(const value of [`${number(outcome.payout)} TIDE`,number(outcome.combinations),percent(outcome.probability),percent(outcome.rtpContribution)]){const td=document.createElement('td');td.textContent=value;row.append(td);}
      tbody.append(row);
    }
    $('#math-run').disabled=false;
  };
  $('#math-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!model||running)return;
    const count=Number($('#math-samples').value);if(![1000,10000,100000].includes(count))return;
    running=true;$('#math-run').disabled=true;$('#math-samples').disabled=true;$('#math-results').replaceChildren();
    let wins=0,payout=0,pool=new Uint32Array(4096),cursor=pool.length;
    function stop(size){const limit=Math.floor(4294967296/size)*size;let value;do{if(cursor===pool.length){crypto.getRandomValues(pool);cursor=0;}value=pool[cursor++];}while(value>=limit);return value%size;}
    try{
      for(let done=0;done<count;){
        const end=Math.min(count,done+2000);
        for(;done<end;done++){
          const symbols=model.reels.map(reel=>reel[stop(reel.length)]);
          if(symbols.every(s=>s===symbols[0])){wins++;payout+=model.payouts[symbols[0]];}
        }
        $('#math-message').textContent=`${number(done)} / ${number(count)}`;
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      const results=$('#math-results'),bet=count*model.bet;
      metric(results,'RTP vzorku',percent(payout/bet));metric(results,'Výherní spiny',`${number(wins)} / ${number(count)}`);
      metric(results,'Modelované výplaty',`${number(payout)} TIDE`);metric(results,'Modelované čisté saldo',`${number(payout-bet)} TIDE`);
      $('#math-message').textContent='Náhodný vzorek. Skutečný zůstatek se nemění.';
    }catch{ $('#math-message').textContent='Simulaci se nepodařilo dokončit.'; }
    finally{running=false;$('#math-run').disabled=false;$('#math-samples').disabled=false;}
  });
})();
