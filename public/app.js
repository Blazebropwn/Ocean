const $ = (selector) => document.querySelector(selector);
const message = $("#message");
const registrationInviteToken = new URLSearchParams(location.search).get("invite");
if (registrationInviteToken) history.replaceState(null, "", `${location.pathname}${location.hash}`);
let kryptotronRefresh;
let approvalRefresh;
let entriesPaused = false;
let dcaEnabled = false;
let dcaDraftAmount = null;
let dcaSaving = false;
let streakEnabled = false;
let arcadeState = null;
let arcadeFrame = null;
let octoLastEventKey = null;
let agentLastRunId = null;
let vaultSnapshot = null;
let vaultPage = 0;
let selectedPositionSymbol = null;

const octoLabels = {
  idle: "Čeká na signál",
  scanning: "Kontroluje trh",
  calculating: "Vyhodnocuje",
  trade_open: "V pozici",
  profit: "Uzavřeno se ziskem",
  loss: "Uzavřeno se ztrátou",
  error: "Vyžaduje pozornost",
  sleep: "Pozastaveno",
};
const octoStates = Object.keys(octoLabels);

function setOctoOpen(open) {
  $("#octo-bubble").hidden = !open;
  $("#octo-toggle").setAttribute("aria-expanded", String(open));
}

function setProfileOpen(open) {
  $("#profile-menu").classList.toggle("hidden", !open);
  $("#profile-button").setAttribute("aria-expanded", String(open));
  if (open) setOctoOpen(false);
}

function initializeOcto() {
  $("#octo-assistant").classList.remove("hidden");
}

function renderOcto(presentation) {
  initializeOcto();
  const assistant = $("#octo-assistant");
  const state = octoStates.includes(presentation?.state) ? presentation.state : "idle";
  const message = presentation?.message || "Klid. Čekám na další signál.";
  const eventKey = presentation?.eventKey || `runtime:${state}`;
  const changed = eventKey !== octoLastEventKey;
  octoLastEventKey = eventKey;
  assistant.dataset.state = state;
  assistant.classList.toggle("critical", presentation?.critical === true);
  $("#octo-state-label").textContent = octoLabels[state];
  $("#octo-message").textContent = message;
  $("#octo-toggle").setAttribute("aria-label", `Stav systému: ${message}`);
  $("#octo-bubble").setAttribute("aria-live", presentation?.critical ? "assertive" : "polite");
  const meta = $("#octo-meta");
  meta.textContent = presentation?.meta || "";
  meta.classList.toggle("hidden", !presentation?.meta);

  // Routine status stays behind the bell; critical events remain visible.
  const profileOpen = !$("#profile-menu").classList.contains("hidden");
  if (changed && presentation?.critical === true && !profileOpen) setOctoOpen(true);
}

function renderDisconnectedOcto() {
  renderOcto({
    state: "sleep",
    message: "Binance zatím není připojená.",
    meta: null,
    eventKey: "connection:missing",
    autoOpen: false,
    critical: false,
  });
}

function setLoading(form, loading) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = loading;
  button.dataset.label ||= button.innerHTML;
  button.innerHTML = loading ? "Pracuji…" : button.dataset.label;
}

async function request(path, options = {}) {
  const headers = options.body === undefined ? {} : { "Content-Type": "application/json" };
  const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || "Něco se nepovedlo.");
    error.status = response.status;
    if (body.runId) error.runId = body.runId;
    throw error;
  }
  return body;
}

function showUser(user) {
  const accessApproved = user.accessApproved ?? user.emailVerified;
  document.body.classList.add("dashboard-active");
  document.body.classList.toggle("access-pending", !accessApproved);
  $("#welcome").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#nav-account").classList.remove("hidden");
  $("#display-id").textContent = user.displayId;
  $("#username").textContent = `@${user.username}`;
  $("#avatar").textContent = user.username[0].toUpperCase();
  $("#nav-avatar").textContent = user.username[0].toUpperCase();
  $("#nav-username").textContent = user.username;
  $("#menu-username").textContent = user.username;
  $("#email").textContent = user.email || "";
  $("#email").classList.toggle("hidden", !user.email);
  $("#email-status").textContent = user.emailVerified ? "✓ OVĚŘENO" : "ČEKÁ NA OVĚŘENÍ";
  $("#email-status").className = user.emailVerified ? "hidden verified" : "hidden pending";
  $("#invite-admin-link").classList.toggle("hidden", user.role !== "owner");
  $("#verify-banner").classList.toggle("hidden", accessApproved);
  $("#verify-banner-text").textContent = user.approvalMode === "owner" ? "Účet čeká na schválení vlastníkem." : "Ověřte svůj e-mail.";
  $("#verify-mailbox-link").classList.toggle("hidden", user.approvalMode === "owner");
  $("#resend-verification").classList.toggle("hidden", user.approvalMode === "owner");
  const initialView = location.hash === "#arcade" ? "arcade" : location.hash === "#vault" ? "vault" : "overview";
  const initialLink = document.querySelector(`.side-link[href="${location.hash || "#dashboard"}"]`);
  showAppView(initialView, initialLink);
  clearInterval(kryptotronRefresh);
  clearInterval(approvalRefresh);
  if (!accessApproved) {
    $("#octo-assistant").classList.add("hidden");
    approvalRefresh = setInterval(() => request("/api/me").then(({ user: refreshedUser }) => {
      if (refreshedUser.accessApproved) showUser(refreshedUser);
    }).catch(() => {}), 10_000);
    return;
  }
  initializeOcto();
  initializeKryptotron();
  loadAgentCard();
  kryptotronRefresh = setInterval(initializeKryptotron, 60_000);
}

function setAgentEmpty() {
  agentLastRunId = null;
  $("#agent-state").textContent = "PŘIPRAVEN";
  $("#agent-last-run").textContent = "—";
  $("#agent-actions").textContent = "—";
  $("#agent-result").textContent = "—";
  $("#agent-ledger-open").classList.add("hidden");
}

async function loadAgentCard() {
  try {
    const { agent } = await request("/api/agent");
    const run = agent.lastRun;
    agentLastRunId = run?.id || null;
    $("#agent-state").textContent = agent.killSwitchActive ? "VYPNUT" : agent.status === "active" ? "AKTIVNÍ" : "POZASTAVEN";
    $("#agent-last-run").textContent = run ? formatDate(run.completedAt || run.startedAt) : "—";
    $("#agent-actions").textContent = run ? String(run.actionCount) : "—";
    $("#agent-result").textContent = !run ? "—" : run.success ? "OVĚŘENO" : run.status === "failed" ? "SELHAL" : run.status.toUpperCase();
    $("#agent-result").className = run?.success ? "positive" : run?.status === "failed" ? "negative" : "";
    $("#agent-ledger-open").classList.toggle("hidden", !run);
  } catch (error) {
    if (error.status === 404) setAgentEmpty();
    else $("#agent-message").textContent = error.message;
  }
}

function appendAgentValue(container, label, value) {
  const item = document.createElement("span");
  const small = document.createElement("small");
  const strong = document.createElement("strong");
  small.textContent = label;
  strong.textContent = value;
  item.append(small, strong);
  container.append(item);
}

async function loadAgentRunDetail(runId) {
  const report = $("#agent-report");
  const ledger = $("#agent-ledger");
  report.replaceChildren();
  ledger.replaceChildren();
  appendAgentValue(report, "Stav", "Načítám…");
  document.querySelectorAll("#agent-run-history button").forEach((button) => button.classList.toggle("active", button.dataset.runId === runId));
  try {
    const { run } = await request(`/api/agent/runs/${runId}`);
    report.replaceChildren();
    const metrics = run.result?.metrics;
    appendAgentValue(report, "Stav", run.success ? "Ověřeno" : "Selhalo");
    appendAgentValue(report, "Riziko", metrics ? `${metrics.riskLevel.toUpperCase()} · ${metrics.riskScore}` : "—");
    appendAgentValue(report, "Největší pozice", metrics?.largestPosition ? `${metrics.largestPosition.asset} · ${metrics.largestPosition.sharePct} %` : "—");
    appendAgentValue(report, "Zásahy člověka", String(run.humanInterventions));
    if (run.error?.message) appendAgentValue(report, "Důvod", run.error.message);
    for (const entry of run.ledger) {
      const item = document.createElement("li");
      const sequence = document.createElement("b");
      const content = document.createElement("span");
      const state = document.createElement("strong");
      sequence.textContent = String(entry.sequence).padStart(2, "0");
      content.textContent = entry.actionType.replaceAll("_", " ");
      state.textContent = entry.result === "success" ? "OK" : "FAIL";
      state.className = entry.result === "success" ? "positive" : "negative";
      item.append(sequence, content, state);
      ledger.append(item);
    }
  } catch (error) {
    report.replaceChildren();
    appendAgentValue(report, "Chyba", error.message);
  }
}

async function openAgentLedger() {
  if (!agentLastRunId) return;
  const dialog = $("#agent-dialog");
  const history = $("#agent-run-history");
  history.replaceChildren();
  dialog.showModal();
  try {
    const { runs } = await request("/api/agent/runs");
    for (const run of runs) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runId = run.id;
      button.textContent = `${formatDate(run.completedAt || run.startedAt)} · ${run.success ? "OK" : run.status === "failed" ? "FAIL" : run.status.toUpperCase()}`;
      button.addEventListener("click", () => loadAgentRunDetail(run.id));
      history.append(button);
    }
    await loadAgentRunDetail(agentLastRunId);
  } catch (error) {
    $("#agent-report").replaceChildren();
    appendAgentValue($("#agent-report"), "Chyba", error.message);
  }
}

$("#agent-run").addEventListener("click", async () => {
  const button = $("#agent-run");
  const feedback = $("#agent-message");
  button.disabled = true;
  button.textContent = "Analyzuji…";
  feedback.textContent = "Načítám portfolio a ověřuji report.";
  try {
    const { run } = await request("/api/agent/runs", { method: "POST", body: "{}" });
    agentLastRunId = run.id;
    feedback.textContent = "Risk report byl ověřen.";
    await loadAgentCard();
  } catch (error) {
    if (error.runId) agentLastRunId = error.runId;
    feedback.textContent = error.message;
    await loadAgentCard();
  } finally {
    button.disabled = false;
    button.textContent = "Spustit analýzu";
  }
});

$("#agent-ledger-open").addEventListener("click", openAgentLedger);
$("#agent-dialog-close").addEventListener("click", () => $("#agent-dialog").close());
$("#agent-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

function showAppView(view, activeLink = null) {
  const selected = ["overview", "arcade", "vault"].includes(view) ? view : "overview";
  if (selected !== "arcade") {
    cancelAnimationFrame(arcadeFrame);
    if (arcadeState) arcadeState.active = false;
  }
  if (selected !== "overview") setOctoOpen(false);
  document.querySelectorAll(".app-view").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${selected}-view`));
  document.querySelectorAll(".side-link[data-view]").forEach((link) => {
    const active = activeLink ? link === activeLink : link.dataset.view === selected;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#workspace-title").textContent = selected === "overview" ? "Přehled" : selected === "arcade" ? "Arcade" : "Vault";
  $("#workspace-subtitle").textContent = selected === "vault"
    ? "Tvoje pravidelné nákupy a jejich historie."
    : selected === "arcade" ? "Malá pauza pod hladinou." : "Peníze, strategie a poslední dění. Na jednom místě.";
  if (selected === "arcade") openArcade();
}

document.querySelectorAll(".side-link[data-view]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", link.getAttribute("href"));
  showAppView(link.dataset.view, link);
}));

const sonarHint = "Pingni ve chvíli, kdy paprsek protne zelený sektor.";

function arcadeBest() {
  return Number(localStorage.getItem("ocean-sonar-best") || 0);
}

function sizeArcadeCanvas() {
  const canvas = $("#game-canvas");
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.floor(bounds.width * ratio));
  const pixelHeight = Math.max(1, Math.floor(bounds.height * ratio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  return { canvas, ctx: canvas.getContext("2d"), width: canvas.width, height: canvas.height };
}

function openArcade() {
  cancelAnimationFrame(arcadeFrame);
  arcadeState = null;
  $("#game-hint").textContent = sonarHint;
  $("#game-score").textContent = "0";
  $("#game-best").textContent = arcadeBest();
  $("#game-tap").textContent = "Spustit";
  requestAnimationFrame(drawArcadeIdle);
}

function drawArcadeSurface(ctx, width, height, now = 0) {
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#151c22");
  background.addColorStop(.55, "#151c22");
  background.addColorStop(1, "#10161b");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(111, 226, 224, .055)";
  ctx.lineWidth = 1;
  const grid = Math.max(44, Math.floor(width / 22));
  ctx.beginPath();
  for (let x = grid; x < width; x += grid) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = grid; y < height; y += grid) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(119, 216, 196, .16)";
  for (let index = 0; index < 16; index += 1) {
    const x = ((index * .173 + now / 90000) % 1) * width;
    const y = ((index * .311 + now / 140000) % 1) * height;
    const radius = 1 + (index % 3);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * .1, width / 2, height / 2, width * .72);
  vignette.addColorStop(0, "rgba(2, 18, 24, 0)");
  vignette.addColorStop(1, "rgba(0, 8, 12, .64)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function drawArcadeIdle() {
  const { ctx, width, height } = sizeArcadeCanvas();
  drawArcadeSurface(ctx, width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  ctx.strokeStyle = "rgba(119, 216, 196, .34)";
  ctx.lineWidth = 2;
  for (const radius of [.08, .17, .27]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.min(width, height) * radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#77d8c4";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
  ctx.fill();
}

function randomTargetAngle(previous = 0) {
  let angle = Math.random() * Math.PI * 2;
  while (Math.abs(Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous))) < 1.05) angle = Math.random() * Math.PI * 2;
  return angle;
}

function startArcade() {
  const now = performance.now();
  arcadeState = { active: true, last: now, score: 0, hits: 0, angle: -Math.PI / 2, speed: 1.45, target: randomTargetAngle(), targetWidth: .72, flashUntil: 0 };
  $("#game-tap").textContent = "PING";
  $("#game-hint").textContent = sonarHint;
  cancelAnimationFrame(arcadeFrame);
  arcadeFrame = requestAnimationFrame(runArcade);
}

function finishArcade(reason = "Pokus skončil") {
  if (!arcadeState?.active) return;
  arcadeState.active = false;
  const score = Math.floor(arcadeState.score);
  const best = Math.max(score, arcadeBest());
  localStorage.setItem("ocean-sonar-best", String(best));
  $("#game-score").textContent = score;
  $("#game-best").textContent = best;
  $("#game-tap").textContent = "Hrát znovu";
  $("#game-hint").textContent = `${reason} · ${score} bodů`;
}

function arcadeTap() {
  if (!arcadeState?.active) return startArcade();
  const now = performance.now();
  const distance = Math.abs(Math.atan2(Math.sin(arcadeState.angle - arcadeState.target), Math.cos(arcadeState.angle - arcadeState.target)));
  if (distance > arcadeState.targetWidth / 2) return finishArcade("Signál minul sektor");
  const accuracy = 1 - distance / (arcadeState.targetWidth / 2);
  arcadeState.hits += 1;
  arcadeState.score += Math.round(100 + accuracy * 100 + Math.max(0, arcadeState.hits - 1) * 10);
  arcadeState.speed = Math.min(3.5, arcadeState.speed + .14);
  arcadeState.targetWidth = Math.max(.3, arcadeState.targetWidth - .025);
  arcadeState.target = randomTargetAngle(arcadeState.target);
  arcadeState.flashUntil = now + 180;
  $("#game-hint").textContent = `Zásah ${arcadeState.hits} · ${accuracy > .78 ? "PERFEKTNÍ" : "SIGNÁL ZACHYCEN"}`;
  $("#game-score").textContent = Math.floor(arcadeState.score);
}

function drawSonar(ctx, width, height, now, delta) {
  const state = arcadeState;
  state.angle = (state.angle + state.speed * delta) % (Math.PI * 2);
  const x = width / 2;
  const y = height / 2;
  const radius = Math.min(width, height) * .36;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "rgba(119, 216, 196, .13)";
  ctx.lineWidth = Math.max(1, width / 1100);
  for (const ring of [.25, .5, .75, 1]) { ctx.beginPath(); ctx.arc(0, 0, radius * ring, 0, Math.PI * 2); ctx.stroke(); }
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); ctx.stroke(); }
  ctx.shadowColor = "rgba(92, 229, 168, .75)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "#5ce5a8";
  ctx.lineWidth = Math.max(8, width / 100);
  ctx.beginPath(); ctx.arc(0, 0, radius, state.target - state.targetWidth / 2, state.target + state.targetWidth / 2); ctx.stroke();
  const sweep = ctx.createLinearGradient(0, 0, Math.cos(state.angle) * radius, Math.sin(state.angle) * radius);
  sweep.addColorStop(0, "rgba(84,238,226,.12)"); sweep.addColorStop(1, "#77d8c4");
  ctx.shadowColor = "rgba(119, 216, 196, .8)";
  ctx.lineWidth = Math.max(2, width / 650);
  ctx.strokeStyle = sweep;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(state.angle) * radius, Math.sin(state.angle) * radius); ctx.stroke();
  ctx.fillStyle = now < state.flashUntil ? "#ffffff" : "#77d8c4";
  ctx.beginPath(); ctx.arc(0, 0, Math.max(5, width / 290), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function runArcade(now) {
  if (!arcadeState?.active) return;
  const delta = Math.min((now - arcadeState.last) / 1000, .035);
  arcadeState.last = now;
  const { ctx, width, height } = sizeArcadeCanvas();
  drawArcadeSurface(ctx, width, height, now);
  drawSonar(ctx, width, height, now, delta);
  if (!arcadeState?.active) return;
  $("#game-score").textContent = Math.floor(arcadeState.score);
  arcadeFrame = requestAnimationFrame(runArcade);
}

$("#game-tap").addEventListener("click", arcadeTap);
$("#game-canvas").addEventListener("pointerdown", arcadeTap);
window.addEventListener("keydown", (event) => { if (event.code === "Space" && !$("#arcade-game").classList.contains("hidden")) { event.preventDefault(); arcadeTap(); } });
window.addEventListener("resize", () => {
  if (!arcadeState?.active && !$("#arcade-game").classList.contains("hidden")) requestAnimationFrame(drawArcadeIdle);
});

function setSystemState(message, warning) {
  $("#system-state-text").textContent = message;
  $("#system-state").classList.toggle("warning", warning);
}

function setVaultUnavailable(message) {
  $("#vault-notice").textContent = message;
  $("#vault-notice").classList.add("warning");
}

function renderVault(snapshot) {
  vaultSnapshot = snapshot;
  const dca = snapshot.dca;
  $("#vault-invested").textContent = formatPrice(dca.totalInvested, snapshot.balance.asset);
  $("#vault-count").textContent = String(dca.purchaseCount);
  $("#vault-amount").textContent = `${formatPrice(dca.amount, snapshot.balance.asset)} / aktivum`;
  $("#vault-schedule").textContent = dca.enabled ? dca.statusText : "Pravidelné nákupy jsou pozastavené";
  $("#vault-notice").textContent = `Historie načtena ${formatDate(snapshot.updatedAt)} · ${snapshot.environment === "mainnet" ? "ostrý provoz" : snapshot.environment === "testnet" ? "zkušební provoz" : "režim neověřen"}`;
  $("#vault-notice").classList.remove("warning");
  const filter = $("#vault-filter");
  const selected = filter.value;
  const all = document.createElement("option");
  all.value = "all"; all.textContent = "Všechna aktiva";
  filter.replaceChildren(all);
  for (const symbol of [...new Set((dca.purchases || []).map((purchase) => purchase.symbol))].sort()) {
    const option = document.createElement("option");
    option.value = symbol; option.textContent = symbol.replace(snapshot.balance.asset, "");
    filter.append(option);
  }
  filter.value = [...filter.options].some((option) => option.value === selected) ? selected : "all";
  renderVaultPurchases();
}

function renderVaultPurchases() {
  const table = $("#vault-purchases");
  table.replaceChildren();
  if (!vaultSnapshot) return;
  const asset = vaultSnapshot.balance.asset;
  const selected = $("#vault-filter").value;
  const allPurchases = (vaultSnapshot.dca.purchases || []).filter((item) => selected === "all" || item.symbol === selected);
  const pageSize = innerWidth <= 760 ? (innerHeight < 740 ? 2 : 3) : (innerHeight < 850 ? 4 : 6);
  const pages = Math.max(1, Math.ceil(allPurchases.length / pageSize));
  vaultPage = Math.min(vaultPage, pages - 1);
  const purchases = allPurchases.slice(vaultPage * pageSize, (vaultPage + 1) * pageSize);
  $("#vault-page").textContent = `${vaultPage + 1} / ${pages}`;
  $("#vault-prev").disabled = vaultPage === 0;
  $("#vault-next").disabled = vaultPage >= pages - 1;
  $("#vault-empty").classList.toggle("hidden", purchases.length > 0);
  $("#vault-empty").textContent = selected === "all" ? "Zatím nemáš evidovaný žádný DCA nákup. Po prvním provedeném nákupu se objeví tady." : "Pro toto aktivum nejsou evidované nákupy.";
  for (const purchase of purchases) {
    const row = document.createElement("tr");
    const symbol = purchase.symbol.replace(asset, "");
    const assetCell = document.createElement("td");
    const label = document.createElement("span"); label.className = "vault-asset";
    const icon = document.createElement("i"); icon.textContent = symbol.slice(0, 1); icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("strong"); name.textContent = symbol;
    label.append(icon, name); assetCell.append(label); row.append(assetCell);
    const at = Number.isFinite(Date.parse(purchase.at)) ? formatDate(purchase.at) : "Datum neevidováno";
    for (const value of [at, `${formatQuantity(purchase.quantity)} ${symbol}`, formatPrice(purchase.amount, asset)]) {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    }
    table.append(row);
  }
}
$("#vault-filter").addEventListener("change", () => { vaultPage = 0; renderVaultPurchases(); });
$("#vault-prev").addEventListener("click", () => { vaultPage = Math.max(0, vaultPage - 1); renderVaultPurchases(); });
$("#vault-next").addEventListener("click", () => { vaultPage += 1; renderVaultPurchases(); });
window.addEventListener("resize", renderVaultPurchases);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderPortfolio(snapshot) {
  const symbols = { USDC: "$", BTC: "₿", ETH: "Ξ", SOL: "◎" };
  const assets = snapshot.holdings?.assets || [];
  const grid = $("#asset-grid"); grid.replaceChildren();
  for (const symbol of ["USDC", "BTC", "ETH", "SOL"]) {
    const holding = assets.find((item) => item.asset === symbol);
    const amount = symbol === "USDC" ? snapshot.balance.amount : holding?.quantity;
    const card = node("article", "asset-card");
    card.classList.toggle("stale", symbol === "USDC" ? Boolean(snapshot.balance.error) || !Number.isFinite(Date.parse(snapshot.balance.updatedAt)) || Date.now() - Date.parse(snapshot.balance.updatedAt) > 180_000 : !snapshot.holdings || snapshot.holdings.stale);
    const heading = node("div", "asset-heading");
    heading.append(node("i", `asset-icon ${symbol.toLowerCase()}`, symbols[symbol]), node("span", "", symbol));
    card.append(heading, node("strong", "", amount == null ? "—" : symbol === "USDC" ? new Intl.NumberFormat("cs-CZ", {minimumFractionDigits:2,maximumFractionDigits:2}).format(amount) : formatQuantity(amount)));
    const subtitle = symbol === "USDC" ? "K dispozici" : snapshot.holdings?.stale ? "Čekám na aktualizaci" : holding?.value == null ? (amount === 0 ? "0,00 USDC" : "Ocenění nedostupné") : `≈ ${formatPrice(holding.value, "USDC")}`;
    card.append(node("small", "", subtitle));
    card.title = symbol === "USDC" ? "Volné USDC pro obchodování" : "Celkové množství na Spotu, včetně prostředků v otevřených objednávkách";
    grid.append(card);
  }
  renderDcaPortfolio(snapshot);
  const list = $("#positions-list"); list.replaceChildren();
  const positions = snapshot.positions.filter((position) => position.inPosition);
  $("#position-count").textContent = String(positions.length);
  list.classList.toggle("compact", positions.length >= 3);
  if (!positions.length) list.append(node("p", "positions-empty", snapshot.entriesPaused ? "Nové obchody jsou pozastavené." : "Žádná otevřená pozice. Čekám na signál."));
  for (const position of positions) {
    const asset = position.symbol.replace(snapshot.balance.asset, "");
    const holding = assets.find((item) => item.asset === asset);
    const price = snapshot.holdings?.stale ? null : holding?.price;
    const pnl = price == null ? null : (price - position.entryPrice) * position.quantity;
    const row = node("button", "position-row"); row.type = "button";
    const info = node("span"); info.append(node("strong", "", asset), node("small", "", `${formatQuantity(position.quantity)} ${asset}`));
    const result = node("span", "position-result");
    result.append(node("strong", pnl == null ? "" : pnl >= 0 ? "positive" : "negative", pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${formatPrice(pnl, snapshot.balance.asset)}`), node("small", position.protectionActive ? "" : "unprotected", position.protectionActive ? "Ochrana aktivní" : "Ověř ochranu"));
    result.title = pnl == null ? "Aktuální ocenění není dostupné" : `Orientační výsledek bez poplatků. Cena z ${formatDate(snapshot.holdings.capturedAt)}.`;
    row.append(node("i", `asset-icon ${asset.toLowerCase()}`, symbols[asset] || asset.slice(0,1)), info, result, node("b", "", "›"));
    row.setAttribute("aria-label", `Detail pozice ${asset}`);
    row.addEventListener("click", () => { selectedPositionSymbol = position.symbol; updatePositionDetail(); $("#position-dialog").showModal(); });
    list.append(row);
  }
  $("#next-check-short").textContent = snapshot.nextCheckAt ? `Další kontrola ${new Intl.DateTimeFormat("cs-CZ",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Prague"}).format(new Date(snapshot.nextCheckAt))}` : "Čekám na kontrolu";
}

function updatePositionDetail() {
  if (!vaultSnapshot) return;
  const position = vaultSnapshot.positions.find((item) => item.symbol === selectedPositionSymbol && item.inPosition);
  if (!selectedPositionSymbol) return;
  $("#bot-position").textContent = selectedPositionSymbol.replace(vaultSnapshot.balance.asset, "") + (position ? " · otevřená pozice" : " · pozice uzavřená");
  $("#position-symbol").textContent = selectedPositionSymbol;
  $("#bot-entry-price").textContent = position ? formatPrice(position.entryPrice, vaultSnapshot.balance.asset) : "—";
  $("#bot-quantity").textContent = position ? formatQuantity(position.quantity) : "—";
  $("#bot-stop-price").textContent = position?.protectionPrice ? formatPrice(position.protectionPrice, vaultSnapshot.balance.asset) : "—";
  $("#bot-trail-activation").textContent = position?.protectionActivationPrice ? `${formatPrice(position.protectionActivationPrice, vaultSnapshot.balance.asset)} · ${formatBips(position.protectionTrailingBips)}` : "—";
  $("#bot-protection").textContent = !position ? "—" : position.protectionActive ? "Ochrana aktivní" : "Vyžaduje kontrolu";
}

for (const button of document.querySelectorAll("[data-dialog]")) button.addEventListener("click", () => $("#" + button.dataset.dialog).showModal());
for (const button of document.querySelectorAll("[data-close-dialog]")) button.addEventListener("click", () => button.closest("dialog").close());
for (const dialog of document.querySelectorAll(".workspace-dialog")) dialog.addEventListener("click", (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
for (const button of document.querySelectorAll("[data-compact]")) button.addEventListener("click", () => {
  $(".portfolio-surface").dataset.compactView = button.dataset.compact;
  for (const item of document.querySelectorAll("[data-compact]")) item.setAttribute("aria-pressed", String(item === button));
});

async function loadKryptotron() {
  try {
    const { kryptotron } = await request("/api/kryptotron");
    $("#kryptotron-degraded").classList.add("hidden");
    const statuses = { running: "Kontroluje trh", waiting: "Čeká na signál", degraded: "Vyžaduje pozornost", offline: "Nedostupný", unknown: "Propojeno" };
    const open = kryptotron.positions.find((position) => position.inPosition);
    entriesPaused = kryptotron.entriesPaused;
    $("#bot-environment").textContent = kryptotron.environment === "mainnet" ? "Ostrý provoz" : kryptotron.environment === "testnet" ? "Zkušební provoz" : "Režim neověřen";
    $("#position-symbol").textContent = open ? open.symbol.replace(kryptotron.balance.asset, "") : "Bez pozice";
    const needsAttention = Boolean(kryptotron.lastError) || ["degraded", "offline", "unknown"].includes(kryptotron.status);
    setSystemState(needsAttention ? "Vyžaduje pozornost" : "Spojení aktivní", needsAttention);
    renderVault(kryptotron);
    const status = entriesPaused ? "Pozastaveno" : open ? "V pozici" : (statuses[kryptotron.status] || "Propojeno");
    $("#kryptotron-status").lastChild.textContent = ` ${status}`;
    $("#kryptotron-status").classList.toggle("warning", kryptotron.status === "degraded" || kryptotron.status === "offline");
    const balanceAt = Date.parse(kryptotron.balance.updatedAt);
    const balanceStale = !Number.isFinite(balanceAt) || Date.now() - balanceAt > 180_000 || balanceAt > Date.now() + 60_000;
    const holdingsStale = !kryptotron.holdings || kryptotron.holdings.stale;
    if (balanceStale || kryptotron.balance.error || holdingsStale) setSystemState("Zůstatky nejsou aktuální", true);
    const captured = kryptotron.holdings?.capturedAt || kryptotron.balance.updatedAt;
    $("#bot-balance-updated").textContent = captured && Number.isFinite(Date.parse(captured))
      ? new Intl.DateTimeFormat("cs-CZ", {hour:"2-digit",minute:"2-digit",timeZone:"Europe/Prague"}).format(new Date(captured)) : "—";
    $("#bot-balance-updated").title = captured ? `Zůstatky a ocenění portfolia: ${formatDate(captured)}. USDC: ${formatDate(kryptotron.balance.updatedAt)}.` : "Čekám na data";
    renderPortfolio(kryptotron);
    $("#bot-position").textContent = open ? `${open.symbol} · v pozici` : "Bez otevřené pozice";
    dcaEnabled = kryptotron.dca.enabled;
    const dcaTest = $("#dca-test");
    const dcaTestPending = kryptotron.dca.testStatus === "pending" || kryptotron.dca.testStatus === "processing";
    dcaTest.classList.toggle("hidden", kryptotron.environment !== "testnet");
    dcaTest.disabled = dcaTestPending;
    dcaTest.textContent = dcaTestPending ? "Zpracovávám…" : kryptotron.dca.testStatus === "completed" ? "Otestovat znovu" : "Otestovat nákup";
    $("#dca-control").disabled = false;
    $("#dca-settings-open").disabled = false;
    $("#dca-toggle-status").textContent = dcaEnabled ? (kryptotron.entriesPaused ? "Čeká na obnovení" : "Zapnuto") : "Vypnuto";
    $("#dca-amount-value").textContent = `${formatQuantity(kryptotron.dca.amount)} ${kryptotron.balance.asset}`;
    $("#dca-control").classList.toggle("enabled", dcaEnabled);
    $("#dca-control").setAttribute("aria-checked", String(dcaEnabled));
    if (!$("#dca-dialog").open) dcaDraftAmount = kryptotron.dca.amount;
    streakEnabled = kryptotron.streak.enabled;
    $("#streak-control").textContent = streakEnabled ? "Vypnout" : "Zapnout";
    $("#streak-control").classList.toggle("enabled", streakEnabled);
    $("#streak-control").setAttribute("aria-checked", String(streakEnabled));
    $("#streak-status").textContent = streakEnabled ? kryptotron.streak.status.replace("_", " ") : "POZASTAVENO";
    $("#streak-count").textContent = `${kryptotron.streak.streak} výher`;
    $("#streak-pnl").textContent = `${kryptotron.streak.netPnl >= 0 ? "+" : ""}${kryptotron.streak.netPnl.toFixed(2)} ${kryptotron.balance.asset}`;
    $("#bot-protection").textContent = open
      ? (open.protectionActive ? "OCO aktivní" : "Vyžaduje kontrolu")
      : "Čeká na pozici";
    $("#bot-protection").classList.toggle("protected", Boolean(open?.protectionActive));
    $("#bot-entry-price").textContent = open ? formatPrice(open.entryPrice, kryptotron.balance.asset) : "—";
    $("#bot-quantity").textContent = open ? `${formatQuantity(open.quantity)} ${open.symbol.replace(kryptotron.balance.asset, "")}` : "—";
    $("#bot-stop-price").textContent = open?.protectionPrice ? formatPrice(open.protectionPrice, kryptotron.balance.asset) : "—";
    $("#bot-trail-activation").textContent = open?.protectionActivationPrice
      ? `${formatPrice(open.protectionActivationPrice, kryptotron.balance.asset)} · ${formatBips(open.protectionTrailingBips)}`
      : "—";
    $("#bot-result").textContent = kryptotron.lastTrade ? `${kryptotron.lastTrade.pnl >= 0 ? "+" : ""}${kryptotron.lastTrade.pnl.toFixed(2)} ${kryptotron.balance.asset}` : "—";
    $("#bot-result").classList.toggle("positive", Boolean(kryptotron.lastTrade && kryptotron.lastTrade.pnl >= 0));
    $("#bot-result").classList.toggle("negative", Boolean(kryptotron.lastTrade && kryptotron.lastTrade.pnl < 0));
    $("#bot-last-trade").textContent = kryptotron.lastTrade ? `${kryptotron.lastTrade.symbol} · ${kryptotron.lastTrade.result === "WIN" ? "zisk" : "ztráta"}` : "Zatím žádný";
    $("#bot-updated").textContent = formatDate(kryptotron.lastMarketCheckAt || kryptotron.updatedAt);
    $("#bot-next-check").textContent = formatDate(kryptotron.nextCheckAt);
    $("#bot-error-wrap").classList.toggle("hidden", !kryptotron.lastError);
    $("#bot-error").textContent = kryptotron.lastError || "";
    $("#bot-control").textContent = entriesPaused ? "Obnovit" : "Pozastavit";
    $("#bot-control").classList.toggle("resume", entriesPaused);
    updatePositionDetail();
    renderEvents(kryptotron.events);
    renderOcto(kryptotron.octo);
  } catch (error) {
    setSystemState("Data nejsou dostupná", true);
    setVaultUnavailable("Historii se nepodařilo obnovit. Zobrazené údaje mohou být neaktuální.");
    if (error.status === 502 || error.status === 503) {
      $("#kryptotron-degraded").classList.remove("hidden");
      $("#kryptotron-status").lastChild.textContent = " Data mimo dosah";
      $("#kryptotron-status").classList.add("warning");
      renderOcto({ state: "sleep", message: "Stav Kryptotronu je teď mimo dosah. Zkouším to znovu.", meta: "Bot běží dál", eventKey: "data:unavailable", autoOpen: false, critical: false });
    } else {
      $("#kryptotron-degraded").classList.add("hidden");
      $("#kryptotron-status").lastChild.textContent = " Nepřipojeno";
      $("#bot-position").textContent = error.message;
      renderOcto({ state: "error", message: "Stav Kryptotronu se nepodařilo načíst.", meta: "Zkouším spojení obnovit", eventKey: `load:${error.message}`, autoOpen: true, critical: true });
    }
  }
}

async function initializeKryptotron() {
  try {
    const { connection } = await request("/api/kryptotron/connection");
    const panel = $("#connection-panel");
    const form = $("#connection-form");
    const disconnect = $("#disconnect-binance");
    const environmentField = $("#connection-environment-field");
    const environmentSelect = $("#connection-environment");
    const environmentFallback = $("#connection-environment-fallback");
    environmentField.classList.toggle("hidden", !connection.mainnetAvailable);
    environmentSelect.disabled = !connection.mainnetAvailable;
    environmentFallback.disabled = Boolean(connection.mainnetAvailable);
    if (connection.status === "connected") {
      panel.classList.add("hidden");
      disconnect.classList.toggle("hidden", connection.legacy);
      $("#kryptotron").classList.remove("connection-active");
      await loadKryptotron();
      return;
    }
    renderDisconnectedOcto();
    setSystemState(connection.status === "provisioning" ? "Připojuji Binance" : "Binance nepřipojena", false);
    vaultSnapshot = null;
    $("#vault-purchases").replaceChildren();
    for (const id of ["vault-invested", "vault-count", "vault-amount"]) $("#" + id).textContent = "—";
    $("#vault-empty").classList.remove("hidden");
    $("#vault-schedule").textContent = "Nastavení se načte po připojení";
    setVaultUnavailable("Připoj Binance v Přehledu a načti historii nákupů.");
    disconnect.classList.add("hidden");
    panel.classList.remove("hidden");
    $("#kryptotron").classList.add("connection-active");
    const provisioning = connection.status === "provisioning";
    form.classList.toggle("hidden", provisioning);
    $("#provisioning-status").classList.toggle("hidden", !provisioning);
    if (provisioning) {
      $("#provisioning-heading").textContent = "Připravuji Kryptotron";
      $("#provisioning-detail").textContent = "Ocean ověřuje připojení a spouští tvého Kryptotrona. Nové obchody zůstávají pozastavené do aktivace.";
    } else if (connection.status === "error") {
      $("#connection-message").textContent = "Připojení se nepodařilo spustit. Vložte platné klíče znovu.";
    } else {
      $("#connection-message").textContent = "";
    }
  } catch (error) {
    setSystemState("Připojení neověřeno", true);
    setVaultUnavailable("Připojení se nepodařilo ověřit. Zobrazená historie může být neaktuální.");
    $("#kryptotron-status").lastChild.textContent = " Nepřipojeno";
    renderOcto({ state: "error", message: "Spojení se nepodařilo ověřit.", meta: "Zkusím to znovu automaticky", eventKey: "connection:error", autoOpen: true, critical: true });
  }
}

$("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = $("#connection-message");
  feedback.textContent = "";
  setLoading(form, true);
  try {
    const body = Object.fromEntries(new FormData(form));
    body.withdrawalsDisabledConfirmed = body.withdrawalsDisabledConfirmed === "on";
    await request("/api/kryptotron/connection", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    await initializeKryptotron();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    setLoading(form, false);
  }
});

$("#disconnect-binance").addEventListener("click", async (event) => {
  if (!window.confirm("Odpojit Binance a bezpečně odstranit uložené API klíče?")) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Odpojuji…";
  try {
    await request("/api/kryptotron/connection", { method: "DELETE" });
    entriesPaused = true;
    await initializeKryptotron();
  } catch (error) {
    $("#connection-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Odpojit Binance";
  }
});

function renderDcaPortfolio(snapshot) {
  // Cost, goals and valuation all use the same bounded DCA purchase ledger.
  const purchases = snapshot.dca.purchases || [];
  const quantities = new Map();
  let invested = 0;
  for (const purchase of purchases) {
    invested += purchase.amount;
    const asset = purchase.symbol.replace(/USDC$/, "");
    quantities.set(asset, (quantities.get(asset) || 0) + purchase.quantity);
  }
  let value = 0;
  for (const [asset, quantity] of quantities) {
    if (quantity === 0) continue;
    const price = snapshot.holdings?.assets.find((holding) => holding.asset === asset)?.price;
    if (snapshot.holdings?.stale || !Number.isFinite(price) || price <= 0) { value = null; break; }
    value += quantity * price;
  }
  const scope = "Z evidované historie DCA, nejvýše 156 posledních nákupů.";
  $("#dca-invested").textContent = formatPrice(invested, snapshot.balance.asset);
  $("#dca-invested").title = scope;
  const valuation = $("#dca-current-value");
  valuation.textContent = value === null ? "—" : `${value > 0 ? "≈ " : ""}${formatPrice(value, snapshot.balance.asset)}`;
  valuation.title = value === null ? "Čekám na aktuální ceny všech nakoupených aktiv." : `${scope} Nakoupené množství oceněné posledními dostupnými cenami (${formatDate(snapshot.holdings?.capturedAt)}). Nezohledňuje pozdější prodeje, převody ani poplatky.`;
  valuation.classList.toggle("positive", value !== null && value > invested);
  valuation.classList.toggle("negative", value !== null && value < invested);
  const goals = $("#holdings-goals"); goals.replaceChildren();
  for (const [asset, target] of [["BTC", 1], ["ETH", 10], ["SOL", 100]]) {
    const quantity = quantities.get(asset) || 0;
    const progress = Math.min(100, quantity / target * 100);
    const row = node("div", "goal-row");
    const percentage = progress > 0 && progress < 0.01 ? "< 0,01 %" : `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 }).format(progress)} %`;
    row.append(node("strong", "", asset), node("small", "", percentage));
    const track = node("div", "goal-track"); const fill = node("i"); fill.style.width = `${progress}%`;
    track.setAttribute("role", "progressbar"); track.setAttribute("aria-label", `DCA cíl ${target} ${asset}`);
    track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(progress));
    track.setAttribute("aria-valuetext", `${formatQuantity(quantity)} z ${target} ${asset}`);
    row.title = `${formatQuantity(quantity)} / ${target} ${asset} · ${scope}`;
    track.append(fill); row.append(track); goals.append(row);
  }
}

function renderEvents(events) {
  const list = $("#bot-events");
  list.replaceChildren();
  const visible = events.slice(0, 5);
  if (!visible.length) visible.push({ at: null, message: "Zatím žádné události" });
  for (const event of visible) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    const text = document.createElement("span");
    time.textContent = event.at ? new Intl.DateTimeFormat("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" }).format(new Date(event.at)) : "—";
    text.textContent = event.message;
    item.append(time, text);
    list.append(item);
  }
}

$("#bot-control").addEventListener("click", async () => {
  const button = $("#bot-control");
  button.disabled = true;
  try {
    const result = await request("/api/kryptotron/control", {
      method: "POST",
      body: JSON.stringify({ entriesPaused: !entriesPaused }),
    });
    entriesPaused = result.entriesPaused;
    await loadKryptotron();
  } catch (error) {
    $("#bot-error-wrap").classList.remove("hidden");
    $("#bot-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#dca-control").addEventListener("click", async () => {
  const button = $("#dca-control");
  button.disabled = true;
  try {
    const result = await request("/api/kryptotron/dca/control", { method: "POST", body: JSON.stringify({ enabled: !dcaEnabled }) });
    dcaEnabled = result.enabled;
    await loadKryptotron();
  } catch (error) {
    $("#bot-error-wrap").classList.remove("hidden");
    $("#bot-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#dca-test").addEventListener("click", async () => {
  const button = $("#dca-test");
  if (!confirm("Provést jednorázový Testnet nákup BTC, ETH a SOL podle zvoleného presetu?")) return;
  button.disabled = true;
  button.textContent = "Zařazuji…";
  try {
    await request("/api/kryptotron/dca/test", { method: "POST", body: "{}" });
    button.textContent = "Zařazeno";
    setTimeout(loadKryptotron, 3000);
  } catch (error) {
    $("#bot-error-wrap").classList.remove("hidden");
    $("#bot-error").textContent = error.message;
    button.textContent = "Otestovat nákup";
    button.disabled = false;
  }
});

function renderDcaDraft() {
  const snapshot = vaultSnapshot;
  if (!snapshot) return;
  document.querySelectorAll("#dca-presets button").forEach((button) => {
    const selected = Number(button.dataset.amount) === dcaDraftAmount;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#dca-save").disabled = dcaSaving || dcaDraftAmount === snapshot.dca.amount;
}

$("#dca-settings-open").addEventListener("click", () => {
  if (!vaultSnapshot || dcaSaving) return;
  dcaDraftAmount = vaultSnapshot.dca.amount;
  $("#dca-settings-error").textContent = "";
  renderDcaDraft();
  $("#dca-dialog").showModal();
});

document.querySelectorAll("#dca-presets button").forEach((button) => button.addEventListener("click", () => {
  dcaDraftAmount = Number(button.dataset.amount);
  $("#dca-settings-error").textContent = "";
  renderDcaDraft();
}));

$("#dca-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!vaultSnapshot || dcaSaving || dcaDraftAmount === vaultSnapshot.dca.amount) return;
  const amount = dcaDraftAmount;
  if (amount >= 100 && !confirm(`Uložit ${amount} USDC na každé aktivum pro příští DCA nákupy?`)) return;
  dcaSaving = true;
  $("#dca-save").disabled = true;
  $("#dca-save").textContent = "Ukládám…";
  document.querySelectorAll("#dca-presets button").forEach((button) => { button.disabled = true; });
  try {
    await request("/api/kryptotron/dca/amount", { method: "POST", body: JSON.stringify({ amount }) });
    $("#dca-dialog").close();
    await loadKryptotron();
  } catch (error) {
    $("#dca-settings-error").textContent = error.message;
    if (!$("#dca-dialog").open) $("#dca-dialog").showModal();
  } finally {
    dcaSaving = false;
    $("#dca-save").textContent = "Uložit";
    document.querySelectorAll("#dca-presets button").forEach((button) => { button.disabled = false; });
    renderDcaDraft();
  }
});

$("#streak-control").addEventListener("click", async () => {
  const button = $("#streak-control");
  button.disabled = true;
  try {
    const result = await request("/api/kryptotron/streak/control", { method: "POST", body: JSON.stringify({ enabled: !streakEnabled }) });
    streakEnabled = result.enabled;
    await loadKryptotron();
  } catch (error) {
    $("#bot-error-wrap").classList.remove("hidden");
    $("#bot-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("cs-CZ", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Prague" }).format(new Date(value)) : "—";
}

function formatPrice(value, asset) {
  return `${new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${asset}`;
}

function formatQuantity(value) {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 8 }).format(value);
}

function formatBips(value) {
  return value ? `trail ${(value / 100).toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} %` : "trail";
}

$("#octo-toggle").addEventListener("click", () => {
  const open = $("#octo-bubble").hidden;
  if (open) setProfileOpen(false);
  setOctoOpen(open);
});
$("#octo-close").addEventListener("click", () => {
  setOctoOpen(false);
  $("#octo-toggle").focus();
});
$(".status-activity").addEventListener("click", () => setOctoOpen(false));
document.addEventListener("pointerdown", (event) => {
  if (!$("#octo-assistant").contains(event.target)) setOctoOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#octo-bubble").hidden) {
    setOctoOpen(false);
    $("#octo-toggle").focus();
  }
});

$("#profile-button").addEventListener("click", () => {
  setProfileOpen($("#profile-menu").classList.contains("hidden"));
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  $("#register-form").classList.toggle("hidden", tab.dataset.tab !== "register");
  $("#login-form").classList.toggle("hidden", tab.dataset.tab !== "login");
  message.textContent = "";
}));
if (registrationInviteToken) document.querySelector('.tab[data-tab="register"]').click();

for (const [id, path] of [["#register-form", "/api/auth/register"], ["#login-form", "/api/auth/login"]]) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    message.textContent = "";
    setLoading(form, true);
    try {
      const body = Object.fromEntries(new FormData(form));
      if (id === "#register-form") {
        if (body.password !== body.confirmation) throw new Error("Hesla se neshodují.");
        if (registrationInviteToken) body.inviteToken = registrationInviteToken;
      }
      const result = await request(path, { method: "POST", body: JSON.stringify(body) });
      showUser(result.user);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setLoading(form, false);
    }
  });
}

$("#logout").addEventListener("click", async () => {
  await request("/api/auth/logout", { method: "POST", body: "{}" });
  location.reload();
});

$("#resend-verification").addEventListener("click", async () => {
  const button = $("#resend-verification");
  button.disabled = true;
  try {
    const result = await request("/api/auth/verification/resend", { method: "POST", body: "{}" });
    button.textContent = result.message;
  } catch (error) {
    button.textContent = error.message;
  }
});

request("/api/me").then(({ user }) => showUser(user)).catch(() => {});
