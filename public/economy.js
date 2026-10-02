(() => {
  const $ = id => document.getElementById(id);
  const names = { wave: 'Wave', fish: 'Fish', shell: 'Shell', octo: 'Octo', core: 'Ocean Core' };
  const format = n => new Intl.NumberFormat('cs-CZ').format(n);
  let user = null, wallet = null, game = null, busy = false, loadedUser = null, redeemBusy = false;
  let loading = false, unavailable = false, openRequest = 0, walletRequest = 0;
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
    const recover = unavailable || !game;
    $('slot-spin').disabled = busy || loading || !user?.accessApproved || (!recover && !retry && (!wallet || wallet.balance < 10));
    $('slot-spin').setAttribute('aria-label', busy ? 'Probíhá ověření a zobrazení spinu' : loading ? 'Načítám hru' : recover ? 'Znovu načíst hru' : retry ? 'Ověřit poslední spin' : 'Roztočit za 10 TIDE');
    $('slot-spin').title = $('slot-spin').getAttribute('aria-label');
    $('slot-action').textContent = recover && !loading ? 'OBNOVIT' : retry && !busy ? 'OVĚŘIT' : 'SPIN';
    $('slot-reels').setAttribute('aria-busy', String(busy || loading));
    $('slot-machine').dataset.state = busy ? 'spinning' : loading ? 'loading' : recover ? 'unavailable' : retry ? 'pending' : 'ready';
  }
  function renderWallet() {
    if (!wallet) {
      $('header-tide').textContent = '—';
      $('header-tide-status').setAttribute('aria-label', 'Zůstatek TIDE není dostupný');
      controls(); return;
    }
    $('header-tide').textContent = format(wallet.balance);
    $('header-tide-status').setAttribute('aria-label', `${format(wallet.balance)} TIDE`);
    const genesis = wallet.genesis;
    $('profile-genesis').classList.toggle('hidden', !genesis);
    $('profile-genesis').textContent = genesis ? `GENESIS #${String(genesis.number).padStart(3, '0')}` : '';
    $('genesis-code').disabled = redeemBusy;
    $('genesis-submit').disabled = !user?.accessApproved || redeemBusy;
    controls();
  }
  async function refreshWallet() {
    const id = user?.id;
    if (!id) return;
    const request = ++walletRequest;
    let data;
    try { data = await api('/api/tide'); }
    catch (error) {
      if (user?.id !== id || request !== walletRequest) return;
      throw error;
    }
    if (user?.id !== id || request !== walletRequest) return;
    wallet = data; renderWallet();
  }
  function place(i, position) {
    positions[i] = position;
    const cell = tracks[i].querySelector('.slot-cell');
    // Computed height survives navigation away while an animation is finishing.
    if (cell) tracks[i].style.transform = `translateY(${-position * parseFloat(getComputedStyle(cell).height)}px)`;
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
      const payout = document.createElement('strong'); payout.textContent = format(game.payouts[symbol]);
      const coin = document.createElement('img'); coin.src = '/tide-coin.svg'; coin.alt = 'TIDE'; coin.className = 'slot-payout-coin'; coin.width = coin.height = 18;
      payout.append(coin);
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
    if (busy || loading || !user?.accessApproved) return;
    if (unavailable || !game) { await window.OceanEconomy.open('slot'); return; }
    const userId = user.id, storageKey = pendingName();
    let key;
    try {
      key = pending();
      if (!key && (!wallet || wallet.balance < 10)) return;
      key ||= crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
    } catch { $('slot-message').textContent = 'Povol úložiště této stránky pro bezpečné obnovení spinu.'; return; }
    ++walletRequest; // Discard a wallet read started before this settlement.
    busy = true; controls(); $('slot-machine').classList.remove('won', 'anticipating'); $('slot-message').textContent = 'Ověřuji spin…';
    try {
      const result = await api('/api/slot/spins', { idempotencyKey: key });
      const r = result.spin;
      if (!r || r.gameVersion !== game.gameVersion || r.idempotencyKey !== key || r.userId !== userId || r.stops?.length !== 3 || r.symbols?.length !== 3 ||
          r.stops.some((stop, i) => !Number.isInteger(stop) || stop < 0 || stop > 24 || game.reels[i][stop] !== r.symbols[i]) ||
          r.payout !== (r.symbols.every(s => s === r.symbols[0]) ? game.payouts[r.symbols[0]] : 0) ||
          !Number.isSafeInteger(result.balance) || result.balance < 0) throw new Error('Výsledek nelze ověřit. Zkus znovu ověřit stejný spin.');
      if (user?.id !== userId) return;
      // The server has already settled the spin. Animation cannot affect it.
      await present(r);
      if (user?.id !== userId) return;
      ++walletRequest;
      wallet = { ...(wallet || { genesis: null }), balance: result.balance }; renderWallet();
      sessionStorage.removeItem(storageKey);
      try { await refreshWallet(); } catch { /* settlement balance is confirmed */ }
    } catch (error) {
      if (user?.id !== userId) return;
      if ([400, 403, 409].includes(error.status)) {
        sessionStorage.removeItem(storageKey);
        $('slot-message').textContent = error.message;
        try { await refreshWallet(); } catch { wallet = null; unavailable = true; renderWallet(); }
      } else {
        $('slot-message').textContent = 'Potvrzení chybí. Ověř stejný spin tlačítkem; další sázka se nevytvoří.';
      }
    } finally { busy = false; controls(); }
  }
  $('slot-spin').addEventListener('click', spin);
  $('genesis-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (redeemBusy || $('genesis-submit').disabled) return;
    const code = $('genesis-code').value.trim().toUpperCase().replace(/\s/g, '');
    $('genesis-code').value = code;
    redeemBusy = true; $('genesis-code').disabled = true; $('genesis-code').removeAttribute('aria-invalid');
    $('genesis-submit').disabled = true; $('genesis-message').classList.remove('error'); $('genesis-message').textContent = 'Ověřuji kód…';
    try {
      const result = await api('/api/genesis/redeem', { code });
      wallet = { balance: result.balance, genesis: result.genesis }; renderWallet();
      $('genesis-message').textContent = result.replayed ? 'Activated' : `+${format(result.reward)} TIDE`;
      $('genesis-code').value = '';
    } catch (error) {
      $('genesis-message').classList.add('error');
      const invalid = error.status === 400 || ['INVALID_CODE', 'CODE_REDEEMED'].includes(error.code);
      $('genesis-code').setAttribute('aria-invalid', String(invalid));
      $('genesis-message').textContent = invalid ? 'Invalid code' : error.status === 404 ? 'Aktivace není dostupná. Zkus to později.' : error.status ? error.message : 'Potvrzení chybí. Zkus znovu stejný kód.';
    } finally { redeemBusy = false; $('genesis-code').disabled = false; $('genesis-submit').disabled = !user?.accessApproved; }
  });
  window.addEventListener('resize', () => { if (!busy) positions.forEach((p, i) => place(i, p)); });
  window.OceanEconomy = {
    setUser(value) { user = { ...value, accessApproved: value.accessApproved ?? value.emailVerified }; if (loadedUser !== user.id) { loadedUser = user.id; wallet = null; renderWallet(); refreshWallet().catch(() => {}); } },
    async open(view) {
      if (!user || !['overview', 'slot', 'gift'].includes(view)) return;
      if (view === 'slot' && busy) return;
      const request = view === 'slot' ? ++openRequest : null;
      if (view === 'slot') { loading = true; controls(); $('slot-message').textContent = 'Načítám hru…'; }
      if (view === 'gift' && !redeemBusy) { $('genesis-message').textContent = ''; $('genesis-message').classList.remove('error'); }
      try {
        if (view === 'slot') {
          if (!game) {
            const data = await api('/api/slot');
            if (request !== openRequest) return;
            game = data; buildReels();
          }
          else positions.forEach((p, i) => place(i, p));
        }
        await refreshWallet();
        if (view === 'slot' && request === openRequest) {
          unavailable = false;
          if (!busy) $('slot-message').textContent = pending() ? 'Poslední spin čeká na potvrzení. Ověř ho tlačítkem.' : '';
        }
      } catch (error) {
        if (view === 'slot' && request !== openRequest) return;
        if (view !== 'gift') { wallet = null; renderWallet(); }
        if (view === 'slot') {
          let retry = false; try { retry = Boolean(pending()); } catch { /* storage checked before spin */ }
          unavailable = !game || !retry;
          $('slot-message').textContent = unavailable ? 'Hru se nepodařilo načíst. Zkus obnovit spojení.' : 'Poslední spin čeká na potvrzení. Ověř ho tlačítkem.';
        } else if (view === 'gift') { $('genesis-message').textContent = error.status === 404 ? 'Služba není dostupná. Zkus to později.' : error.message; $('genesis-message').classList.add('error'); }
      } finally { if (view === 'slot' && request === openRequest) loading = false; }
      controls();
    },
  };
})();
