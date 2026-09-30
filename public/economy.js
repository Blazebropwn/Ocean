(() => {
  const $ = id => document.getElementById(id);
  const names = { wave: 'Wave', fish: 'Fish', shell: 'Shell', octo: 'Octo', core: 'Ocean Core' };
  const format = n => new Intl.NumberFormat('cs-CZ').format(n);
  let user = null, wallet = null, game = null, busy = false, loadedUser = null, ledgerCursor = null, ledgerBusy = false;
  const tracks = [...document.querySelectorAll('.slot-track')];
  const positions = [25, 25, 25];
  const pendingName = () => `ocean-slot-pending:${user.id}`;
  function pending() { return sessionStorage.getItem(pendingName()); }
  function image(symbol) {
    const img = document.createElement('img');
    img.src = `/slot/${symbol}.svg`; img.alt = names[symbol]; img.draggable = false;
    return img;
  }
  async function api(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Spojení není dostupné.'), { status: response.status, code: data.code });
    return data;
  }
  function controls() {
    let retry = false;
    try { retry = Boolean(user && pending()); } catch { /* checked before a request */ }
    $('slot-spin').disabled = busy || !user?.accessApproved || !game || (!retry && (!wallet || wallet.balance < 10));
    $('slot-spin').setAttribute('aria-label', retry ? 'Ověřit poslední spin' : 'Roztočit za 10 TIDE');
    $('slot-cost').textContent = retry ? 'Ověřit poslední spin' : '10 TIDE';
  }
  function renderWallet() {
    if (!wallet) return;
    $('profile-tide').textContent = format(wallet.balance);
    $('header-tide').textContent = format(wallet.balance);
    $('header-tide-open').setAttribute('aria-label', `${format(wallet.balance)} TIDE — otevřít historii`);
    $('slot-balance').textContent = format(wallet.balance);
    const genesis = wallet.genesis;
    $('profile-genesis').classList.toggle('hidden', !genesis);
    $('profile-genesis').textContent = genesis ? `GENESIS #${String(genesis.number).padStart(3, '0')}` : '';
    $('genesis-form').classList.toggle('hidden', Boolean(genesis));
    $('genesis-result').classList.toggle('hidden', !genesis);
    $('genesis-identity').textContent = genesis ? `GENESIS #${String(genesis.number).padStart(3, '0')} ACTIVATED` : '';
    $('genesis-submit').disabled = !user?.accessApproved;
    controls();
  }
  async function refreshWallet() {
    const id = user?.id;
    if (!id) return;
    const data = await api('/api/tide');
    if (user?.id !== id) return;
    wallet = data; renderWallet();
  }
  function place(i, position) {
    positions[i] = position;
    const cell = tracks[i].querySelector('.slot-cell');
    if (cell) tracks[i].style.transform = `translateY(${-position * cell.getBoundingClientRect().height}px)`;
  }
  function buildReels() {
    tracks.forEach((track, i) => {
      track.replaceChildren();
      for (let n = 0; n < 100; n++) {
        const cell = document.createElement('div'); cell.className = 'slot-cell';
        cell.append(image(game.reels[i][n % 25])); cell.setAttribute('aria-hidden', 'true'); track.append(cell);
      }
      place(i, 25); track.parentElement.setAttribute('aria-label', `Válec ${i + 1}`);
    });
    $('slot-paytable').replaceChildren();
    for (const symbol of Object.keys(names)) {
      const row = document.createElement('div'); row.className = 'slot-payrow'; row.dataset.symbol = symbol;
      const icons = document.createElement('span');
      for (let n = 0; n < 3; n++) icons.append(image(symbol));
      const payout = document.createElement('strong'); payout.textContent = `${format(game.payouts[symbol])} TIDE`;
      row.append(icons, payout); $('slot-paytable').append(row);
    }
  }
  function animateReel(i, target, duration) {
    const start = positions[i], end = 75 + target;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { place(i, 25 + target); return Promise.resolve(); }
    const started = performance.now();
    return new Promise(resolve => {
      function frame(now) {
        const progress = Math.min(1, (now - started) / duration);
        place(i, start + (end - start) * (1 - Math.pow(1 - progress, 3)));
        if (progress < 1) requestAnimationFrame(frame);
        else { place(i, 25 + target); resolve(); }
      }
      requestAnimationFrame(frame);
    });
  }
  async function present(spin) {
    const machine = $('slot-machine');
    machine.classList.remove('won', 'anticipating');
    document.querySelectorAll('.slot-payrow').forEach(row => row.classList.remove('winner'));
    $('slot-message').textContent = 'V pohybu…';
    const pair = spin.symbols[0] === spin.symbols[1];
    await Promise.all(spin.stops.map((stop, i) => animateReel(i, stop, [1100, 1500, pair ? 2350 : 1900][i]).then(() => {
      tracks[i].parentElement.setAttribute('aria-label', `Válec ${i + 1}: ${names[spin.symbols[i]]}`);
      if (i === 1 && pair) machine.classList.add('anticipating');
    })));
    machine.classList.remove('anticipating');
    machine.classList.toggle('won', spin.payout > 0);
    if (spin.payout > 0) document.querySelector(`.slot-payrow[data-symbol="${spin.symbols[0]}"]`).classList.add('winner');
    $('slot-message').textContent = spin.payout ? `Výhra ${format(spin.payout)} TIDE` : 'Bez výhry';
  }
  async function spin() {
    if (busy || !user?.accessApproved || !game) return;
    let key;
    try {
      key = pending();
      if (!key && (!wallet || wallet.balance < 10)) return;
      key ||= crypto.randomUUID();
      sessionStorage.setItem(pendingName(), key);
    } catch { $('slot-message').textContent = 'Povol úložiště této stránky pro bezpečné obnovení spinu.'; return; }
    busy = true; controls(); $('slot-message').textContent = 'Ověřuji spin…';
    try {
      const result = await api('/api/slot/spins', { idempotencyKey: key });
      const r = result.spin;
      if (r.gameVersion !== game.gameVersion || r.idempotencyKey !== key || r.userId !== user.id || r.stops?.length !== 3 ||
          r.stops.some((stop, i) => !Number.isInteger(stop) || stop < 0 || stop > 24 || game.reels[i][stop] !== r.symbols[i]) ||
          !Number.isSafeInteger(result.balance) || result.balance < 0) throw new Error('Výsledek nelze ověřit. Zkus znovu ověřit stejný spin.');
      // The server has already settled the spin. Animation cannot affect it.
      await present(r);
      wallet = { ...(wallet || { genesis: null }), balance: result.balance }; renderWallet();
      sessionStorage.removeItem(pendingName());
      try { await refreshWallet(); } catch { /* settlement balance is confirmed */ }
    } catch (error) {
      if ([400, 403, 409].includes(error.status)) {
        sessionStorage.removeItem(pendingName());
        $('slot-message').textContent = error.message;
        try { await refreshWallet(); } catch { wallet = null; }
      } else {
        $('slot-message').textContent = 'Potvrzení chybí. Ověř stejný spin tlačítkem; další sázka se nevytvoří.';
      }
    } finally { busy = false; controls(); }
  }
  $('slot-spin').addEventListener('click', spin);
  $('genesis-form').addEventListener('submit', async event => {
    event.preventDefault();
    if ($('genesis-submit').disabled) return;
    $('genesis-submit').disabled = true; $('genesis-message').classList.remove('error'); $('genesis-message').textContent = 'Ověřuji kód…';
    try {
      const result = await api('/api/genesis/redeem', { code: $('genesis-code').value });
      wallet = { balance: result.balance, genesis: result.genesis }; renderWallet();
      $('genesis-message').textContent = result.replayed ? 'Tato aktivace už je uložená.' : '+300 TIDE';
      $('genesis-code').value = '';
    } catch (error) {
      $('genesis-message').classList.add('error'); $('genesis-message').textContent = error.status ? error.message : 'Potvrzení se nepodařilo načíst. Zkus znovu stejný kód.';
    } finally { $('genesis-submit').disabled = !user?.accessApproved; }
  });
  async function ledgerPage(reset) {
    if (ledgerBusy) return;
    ledgerBusy = true; $('tide-history-more').disabled = true;
    if (reset) { ledgerCursor = null; $('tide-history').replaceChildren(); }
    try {
      const data = await api('/api/tide/ledger' + (ledgerCursor ? `?before=${ledgerCursor}` : ''));
      for (const entry of data.entries) {
        const item = document.createElement('li'), description = document.createElement('span'), date = document.createElement('small'), amount = document.createElement('strong');
        description.textContent = { GENESIS_REDEMPTION: 'Genesis aktivace', SLOT_BET: 'Sázka', SLOT_WIN: 'Výhra' }[entry.transactionType];
        date.textContent = new Date(entry.createdAt).toLocaleString('cs-CZ'); description.append(date);
        amount.textContent = `${entry.amount > 0 ? '+' : ''}${format(entry.amount)} TIDE`; item.append(description, amount); $('tide-history').append(item);
      }
      ledgerCursor = data.nextCursor; $('tide-history-more').hidden = !ledgerCursor;
      $('tide-history-message').textContent = $('tide-history').children.length ? '' : 'Zatím žádné pohyby TIDE.';
    } catch (error) { $('tide-history-message').textContent = error.message; }
    finally { ledgerBusy = false; $('tide-history-more').disabled = false; }
  }
  document.querySelectorAll('[data-tide-history]').forEach(button => button.addEventListener('click', () => {
    $('profile-menu').classList.add('hidden'); $('profile-button').setAttribute('aria-expanded', 'false');
    $('tide-dialog').showModal(); ledgerPage(true);
  }));
  $('tide-history-more').addEventListener('click', () => ledgerPage(false));
  window.addEventListener('resize', () => { if (!busy) positions.forEach((p, i) => place(i, p)); });
  window.OceanEconomy = {
    setUser(value) { user = { ...value, accessApproved: value.accessApproved ?? value.emailVerified }; if (loadedUser !== user.id) { loadedUser = user.id; wallet = null; refreshWallet().catch(() => {}); } },
    async open(view) {
      if (!user || !['overview', 'slot', 'gift'].includes(view)) return;
      if (view === 'slot' && busy) return;
      try {
        await refreshWallet();
        if (view === 'slot') {
          if (!game) { game = await api('/api/slot'); buildReels(); }
          else positions.forEach((p, i) => place(i, p));
          if (!busy) $('slot-message').textContent = pending() ? 'Poslední spin čeká na potvrzení. Ověř ho tlačítkem.' : wallet.balance < 10 ? 'Na spin potřebuješ 10 TIDE.' : 'Tři stejné symboly na linii.';
        }
      } catch (error) { if (view === 'overview') { $('header-tide').textContent = '—'; $('header-tide-open').setAttribute('aria-label', 'TIDE není dostupné — otevřít historii'); }
        else $(view === 'slot' ? 'slot-message' : 'genesis-message').textContent = error.message; }
      controls();
    },
  };
})();
