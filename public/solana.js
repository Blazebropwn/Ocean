const $ = (selector) => document.querySelector(selector);
const money = (value) => Number.isFinite(value) ? new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const time = (value) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const statusNames = { idle: 'Čeká', ok: 'Hotovo', blocked: 'Stop', error: 'Chyba' };
let snapshot = null;
let busy = false;
let available = false;
let refreshing = false;

async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Terminál není dostupný. Zkus to za chvíli.');
    error.status = response.status;
    error.snapshot = data.snapshot;
    throw error;
  }
  return data;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function lock(message) {
  available = false;
  snapshot = null;
  $('#terminal').hidden = true;
  $('#access-message').hidden = false;
  $('#access-message p').textContent = message;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  for (const id of ['positions', 'trades', 'decisions']) $('#' + id).replaceChildren();
}

function handleAccessError(error) {
  if (error.status === 401) {
    lock('Pro otevření terminálu se přihlas do Oceanu.');
    return true;
  }
  if (error.status === 403 || error.status === 404) {
    lock('Tento pilot je dostupný pouze schválenému účtu Blazebro.');
    return true;
  }
  return false;
}

function updateControls() {
  const wait = Math.max(0, Math.ceil((Date.parse(snapshot?.nextCycleAt || '') - Date.now()) / 1000)) || 0;
  $('#scan').disabled = busy || !available || wait > 0;
  $('#scan').textContent = busy ? 'Vyhodnocuji…' : wait > 0 ? `Další sken za ${wait} s` : 'Spustit sken';
  document.body.classList.toggle('busy', busy);
  $('#terminal').setAttribute('aria-busy', String(busy));
  document.querySelectorAll('[data-close-position]').forEach(button => {
    button.disabled = busy || !available || wait > 0;
    button.title = wait > 0 ? `Další vyhodnocení za ${wait} s` : 'Simulovaný prodej podle nové kotace';
  });
}

function renderPositions() {
  const container = $('#positions');
  container.replaceChildren();
  $('#position-count').textContent = `${snapshot.positions.length} / ${snapshot.limits.maxOpenPositions}`;
  if (!snapshot.positions.length) {
    container.append(element('p', 'Žádná otevřená pozice. Sken nakoupí jen při splnění všech kontrol.', 'empty'));
    return;
  }
  for (const position of snapshot.positions) {
    const row = element('article', undefined, 'position');
    const info = element('div', undefined, 'position-info');
    const label = position.symbol || position.mint.slice(0, 8);
    info.append(element('b', label));
    const shortMint = `${position.mint.slice(0, 6)}…${position.mint.slice(-5)}`;
    info.append(element('small', `${shortMint} · náklad ${money(position.costUsdc + position.entryFeeUsdc)} USDC`));
    info.title = position.mint;
    const value = element('div', `${money(position.markUsdc)} USDC`, 'position-value');
    value.append(element('small', position.markUsdc === null ? 'Prodejní kotace chybí' : `Kotace ${time(position.markedAt)}`));
    if (position.markError) value.title = position.markError;
    const close = element('button', 'Uzavřít');
    close.type = 'button';
    close.dataset.closePosition = position.id;
    close.setAttribute('aria-label', `Uzavřít PAPER pozici ${label}`);
    close.addEventListener('click', () => mutate(`/api/solana/positions/${encodeURIComponent(position.id)}/close`));
    row.append(info, value, close);
    container.append(row);
  }
}

function renderLedger() {
  const trades = $('#trades');
  trades.replaceChildren();
  if (!snapshot.trades.length) trades.append(element('p', 'Zatím žádný simulovaný obchod.', 'muted'));
  for (const trade of snapshot.trades) {
    const row = element('article');
    row.append(element('time', time(trade.occurredAt)));
    row.append(element('strong', `${trade.side === 'BUY' ? 'PAPER nákup' : 'PAPER prodej'} · ${money(trade.grossUsdc)} USDC`));
    row.append(element('span', `Model síťového nákladu: ${money(trade.networkFeeUsdc)} USDC · ${trade.tokenAmount} nejmenších jednotek tokenu`, 'reason'));
    trades.append(row);
  }
  const decisions = $('#decisions');
  decisions.replaceChildren();
  if (!snapshot.decisions.length) decisions.append(element('p', 'Spusť první sken. Každé vyhodnocení zde zanechá důvod a vstupy.', 'muted'));
  for (const decision of snapshot.decisions) {
    const detail = element('details');
    const summary = element('summary');
    summary.append(element('time', time(decision.occurredAt)));
    summary.append(element('strong', `${String(decision.stage).toUpperCase()} · ${statusNames[decision.status] || decision.status}`));
    summary.append(element('span', decision.reason, 'reason'));
    detail.append(summary);
    if (decision.mint) detail.append(element('p', `Mint: ${decision.mint}`, 'muted'));
    detail.append(element('pre', JSON.stringify(decision.evidence, null, 2)));
    decisions.append(detail);
  }
}

function renderRules() {
  const limits = snapshot.limits;
  const list = $('#rules-list');
  list.replaceChildren();
  const entries = [
    ['Začátek pilotu', `${money(snapshot.initialUsdc)} virtuálních USDC`],
    ['Jedna pozice / vložený kapitál', `${money(limits.maxPositionUsdc)} / ${money(limits.maxExposureUsdc)} USDC`],
    ['Otevřené pozice', `nejvýše ${limits.maxOpenPositions}`],
    ['Stáří poolu', '5 minut až 24 hodin'],
    ['Likvidita / objem za 5 minut', `≥ ${money(limits.minLiquidityUsd)} / ${money(limits.minVolume5mUsd)} USD`],
    ['Mint / freeze authority', 'odvolané, ověřené v reportu'],
    ['Největší držitel', `≤ ${limits.maxHolderPct} %`],
    ['Uzamčená likvidita', `≥ ${limits.minLiquidityLockedPct} %`],
    ['Model skluzu', `${limits.slippageBps / 100} % na každé straně`],
    ['Model síťových nákladů', `${money(limits.networkFeeUsdc)} USDC za každou stranu`],
  ];
  if (limits.maxDailyLossUsdc !== undefined) entries.push(['Brzda ztrát / posledních 24 hodin', `${money(limits.maxDailyLossUsdc)} USDC`]);
  if (limits.maxDailyEntries !== undefined) entries.push(['Vstupy / posledních 24 hodin', `nejvýše ${limits.maxDailyEntries}`]);
  if (limits.stopLossPct !== undefined) entries.push(['PAPER výstup při skenu', `−${limits.stopLossPct} % / +${limits.takeProfitPct} % / ${limits.maxHoldingMinutes} min`]);
  for (const [name, value] of entries) {
    const row = element('div');
    row.append(element('dt', name), element('dd', value));
    list.append(row);
  }
}

function render(data) {
  snapshot = data;
  available = true;
  $('#access-message').hidden = true;
  $('#terminal').hidden = false;
  $('#equity').textContent = money(data.equityUsdc);
  $('#equity-note').textContent = data.equityUsdc === null ? 'Část pozic nelze aktuálně ocenit' : 'Včetně odhadu prodejních nákladů';
  $('#cash').textContent = money(data.cashUsdc);
  $('#exposure').textContent = `${data.positions.length} otevřených pozic`;
  const pnl = data.equityUsdc === null ? null : data.equityUsdc - data.initialUsdc;
  $('#pnl').textContent = pnl === null ? 'Neověřeno' : `${pnl > 0 ? '+' : ''}${money(pnl)}`;
  $('#pnl').className = pnl === null || pnl === 0 ? '' : pnl > 0 ? 'positive' : 'negative';
  $('#trade-count').textContent = `${data.trades.length} posledních simulovaných obchodů`;
  $('#scan-time').textContent = data.lastCycle ? `Poslední sken ${time(data.lastCycle.completedAt || data.lastCycle.startedAt)}` : 'Ruční sken · čeká na spuštění';
  for (const stage of data.stages) {
    const card = [...document.querySelectorAll('[data-stage]')].find(node => node.dataset.stage === stage.id);
    if (!card) continue;
    card.dataset.status = stage.status;
    card.querySelector('.stage-status').textContent = statusNames[stage.status] || 'Čeká';
    card.querySelector('p').textContent = stage.detail;
  }
  renderPositions();
  renderLedger();
  renderRules();
  updateControls();
}

async function refresh() {
  if (busy || refreshing || !available) return;
  refreshing = true;
  try {
    const data = await request('/api/solana');
    if (!busy) render(data);
  } catch (error) {
    if (!handleAccessError(error)) {
      available = false;
      $('#feedback').textContent = 'Aktualizace selhala. Zobrazené hodnoty mohou být zastaralé; obnov stránku.';
      updateControls();
    }
  } finally { refreshing = false; }
}

async function mutate(path) {
  if (busy || !available) return;
  busy = true;
  $('#feedback').textContent = 'Ověřuji tržní data. Tento krok může trvat několik desítek sekund.';
  updateControls();
  try {
    render(await request(path, { method: 'POST' }));
    $('#feedback').textContent = 'Vyhodnocení uloženo. Důvody najdeš v evidenci.';
  } catch (error) {
    if (!handleAccessError(error)) {
      if (error.snapshot) render(error.snapshot);
      $('#feedback').textContent = error.message;
    }
  } finally {
    busy = false;
    updateControls();
  }
}

$('#scan').addEventListener('click', () => mutate('/api/solana/cycle'));
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.open).showModal()));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
setInterval(updateControls, 1000);
setInterval(refresh, 15000);
try {
  const { user } = await request('/api/me');
  if (!user.features?.solanaTerminal) lock('Tento pilot je dostupný pouze schválenému účtu Blazebro.');
  else render(await request('/api/solana'));
} catch (error) {
  if (!handleAccessError(error)) lock('Terminál se nepodařilo načíst. Obnov stránku.');
}
