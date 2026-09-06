const $ = (selector) => document.querySelector(selector);
const message = $("#message");
const registrationInviteToken = new URLSearchParams(location.search).get("invite");
if (registrationInviteToken) history.replaceState(null, "", `${location.pathname}${location.hash}`);
let kryptotronRefresh;
let approvalRefresh;
let entriesPaused = false;
let dcaEnabled = false;
let streakEnabled = false;
let arcadeState = null;
let arcadeFrame = null;
let octoCloseTimer = null;
let octoLastEventKey = null;
let octoMuted = false;

const octoLabels = {
  idle: "ČEKÁM",
  scanning: "SKENUJI",
  calculating: "POČÍTÁM",
  trade_open: "V POZICI",
  profit: "ZISK",
  loss: "ZTRÁTA",
  error: "POZOR",
  sleep: "KLID",
};
const octoStates = Object.keys(octoLabels);

function readOctoMuted() {
  try { return localStorage.getItem("ocean-octo-muted") === "1"; } catch { return false; }
}

function setOctoOpen(open) {
  clearTimeout(octoCloseTimer);
  octoCloseTimer = null;
  $("#octo-bubble").hidden = !open;
  $("#octo-toggle").setAttribute("aria-expanded", String(open));
}

function initializeOcto() {
  const assistant = $("#octo-assistant");
  assistant.classList.remove("hidden");
  if (assistant.dataset.ready === "true") return;
  assistant.dataset.ready = "true";
  octoMuted = readOctoMuted();
  $("#octo-mute").textContent = octoMuted ? "Povolit automatické zprávy" : "Ztišit automatické zprávy";
  for (const state of octoStates) {
    if (state === "idle") continue;
    const image = new Image();
    image.src = `/kryptotron-octo/${state}.webp`;
  }
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
  $("#octo-toggle").setAttribute("aria-label", `Kryptotron: ${message}`);
  $("#octo-bubble").setAttribute("aria-live", presentation?.critical ? "assertive" : "polite");
  const meta = $("#octo-meta");
  meta.textContent = presentation?.meta || "";
  meta.classList.toggle("hidden", !presentation?.meta);

  const avatar = $("#octo-avatar");
  const nextSource = `/kryptotron-octo/${state}.webp`;
  if (!avatar.getAttribute("src").endsWith(nextSource)) {
    avatar.classList.add("changing");
    avatar.src = nextSource;
    avatar.addEventListener("load", () => avatar.classList.remove("changing"), { once: true });
  }

  if (changed && presentation?.autoOpen && !octoMuted) {
    setOctoOpen(true);
    if (!presentation.critical) octoCloseTimer = setTimeout(() => setOctoOpen(false), 5600);
  }
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
  kryptotronRefresh = setInterval(initializeKryptotron, 60_000);
}

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
  background.addColorStop(0, "#061d26");
  background.addColorStop(.55, "#082832");
  background.addColorStop(1, "#03151c");
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

  ctx.fillStyle = "rgba(84, 238, 226, .16)";
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
  ctx.strokeStyle = "rgba(84, 238, 226, .34)";
  ctx.lineWidth = 2;
  for (const radius of [.08, .17, .27]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.min(width, height) * radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#54eee2";
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
  ctx.strokeStyle = "rgba(84, 238, 226, .13)";
  ctx.lineWidth = Math.max(1, width / 1100);
  for (const ring of [.25, .5, .75, 1]) { ctx.beginPath(); ctx.arc(0, 0, radius * ring, 0, Math.PI * 2); ctx.stroke(); }
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); ctx.stroke(); }
  ctx.shadowColor = "rgba(92, 229, 168, .75)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "#5ce5a8";
  ctx.lineWidth = Math.max(8, width / 100);
  ctx.beginPath(); ctx.arc(0, 0, radius, state.target - state.targetWidth / 2, state.target + state.targetWidth / 2); ctx.stroke();
  const sweep = ctx.createLinearGradient(0, 0, Math.cos(state.angle) * radius, Math.sin(state.angle) * radius);
  sweep.addColorStop(0, "rgba(84,238,226,.12)"); sweep.addColorStop(1, "#54eee2");
  ctx.shadowColor = "rgba(84, 238, 226, .8)";
  ctx.lineWidth = Math.max(2, width / 650);
  ctx.strokeStyle = sweep;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(state.angle) * radius, Math.sin(state.angle) * radius); ctx.stroke();
  ctx.fillStyle = now < state.flashUntil ? "#ffffff" : "#54eee2";
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

async function loadKryptotron() {
  try {
    const { kryptotron } = await request("/api/kryptotron");
    $("#kryptotron-degraded").classList.add("hidden");
    const statuses = { running: "Kontroluje trh", waiting: "Čeká na signál", degraded: "Vyžaduje pozornost", offline: "Nedostupný", unknown: "Propojeno" };
    const open = kryptotron.positions.find((position) => position.inPosition);
    entriesPaused = kryptotron.entriesPaused;
    const status = entriesPaused ? "Pozastaveno" : open ? "V pozici" : (statuses[kryptotron.status] || "Propojeno");
    $("#kryptotron-status").lastChild.textContent = ` ${status}`;
    $("#kryptotron-status").classList.toggle("warning", kryptotron.status === "degraded" || kryptotron.status === "offline");
    $("#bot-balance").textContent = kryptotron.balance.amount === null
      ? "—"
      : `${new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(kryptotron.balance.amount)} ${kryptotron.balance.asset}`;
    $("#bot-position").textContent = open ? `${open.symbol} · v pozici` : "Bez otevřené pozice";
    dcaEnabled = kryptotron.dca.enabled;
    const dcaTest = $("#dca-test");
    const dcaTestPending = kryptotron.dca.testStatus === "pending" || kryptotron.dca.testStatus === "processing";
    dcaTest.classList.toggle("hidden", kryptotron.environment !== "testnet");
    dcaTest.disabled = dcaTestPending;
    dcaTest.textContent = dcaTestPending ? "Zpracovávám…" : kryptotron.dca.testStatus === "completed" ? "Otestovat znovu" : "Otestovat nákup";
    $("#dca-status").textContent = dcaEnabled ? (kryptotron.dca.completedWeek ? "Tento týden provedeno" : "Čeká na neděli") : "Pozastaveno";
    $("#dca-control").textContent = dcaEnabled ? "Vypnout" : "Zapnout";
    $("#dca-control").classList.toggle("enabled", dcaEnabled);
    $("#dca-control").setAttribute("aria-checked", String(dcaEnabled));
    $("#dca-invested").textContent = `${new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(kryptotron.dca.totalInvested)} ${kryptotron.balance.asset}`;
    document.querySelectorAll("#dca-presets button").forEach((button) => button.classList.toggle("active", Number(button.dataset.amount) === kryptotron.dca.amount));
    renderDcaProgress(kryptotron.dca.progress);
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
    $("#bot-control").textContent = entriesPaused ? "Obnovit automatizaci" : "Pozastavit nové obchody";
    $("#bot-control").classList.toggle("resume", entriesPaused);
    renderEvents(kryptotron.events);
    renderOcto(kryptotron.octo);
  } catch (error) {
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
    if (connection.status === "connected") {
      panel.classList.add("hidden");
      disconnect.classList.toggle("hidden", connection.legacy);
      $("#kryptotron").classList.remove("connection-active");
      await loadKryptotron();
      return;
    }
    renderDisconnectedOcto();
    disconnect.classList.add("hidden");
    panel.classList.remove("hidden");
    $("#kryptotron").classList.add("connection-active");
    const provisioning = connection.status === "provisioning";
    form.classList.toggle("hidden", provisioning);
    $("#provisioning-status").classList.toggle("hidden", !provisioning);
    if (provisioning) {
      const mainnet = connection.environment === "mainnet";
      $("#provisioning-heading").textContent = mainnet ? "Mainnet čeká na ruční aktivaci" : "Připravuji Kryptotron";
      $("#provisioning-detail").textContent = mainnet
        ? "Automatické spouštění mainnet workerů zatím Ocean nepodporuje. Ozvěte se prosím správci účtu."
        : "Testnet worker se po ověření spustí automaticky.";
    } else if (connection.status === "error") {
      $("#connection-message").textContent = "Připojení se nepodařilo spustit. Vložte platné klíče znovu.";
    } else {
      $("#connection-message").textContent = "";
    }
  } catch (error) {
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

function renderDcaProgress(progress) {
  const container = $("#dca-progress");
  container.replaceChildren();
  for (const item of progress) {
    const row = document.createElement("div");
    const label = document.createElement("strong");
    const track = document.createElement("span");
    const fill = document.createElement("i");
    const value = document.createElement("small");
    label.textContent = item.asset;
    fill.style.width = `${item.percentage}%`;
    value.textContent = `${item.percentage.toFixed(2)} %`;
    track.append(fill);
    row.append(label, track, value);
    container.append(row);
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

document.querySelectorAll("#dca-presets button").forEach((button) => button.addEventListener("click", async () => {
  const amount = Number(button.dataset.amount);
  if (amount >= 100 && !confirm(`${amount} USDC se použije pro každý asset — až ${amount * 3} USDC za týden. Pokračovat?`)) return;
  document.querySelectorAll("#dca-presets button").forEach((item) => { item.disabled = true; });
  try {
    await request("/api/kryptotron/dca/amount", { method: "POST", body: JSON.stringify({ amount }) });
    await loadKryptotron();
  } catch (error) {
    $("#bot-error-wrap").classList.remove("hidden");
    $("#bot-error").textContent = error.message;
  } finally {
    document.querySelectorAll("#dca-presets button").forEach((item) => { item.disabled = false; });
  }
}));

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

$("#octo-toggle").addEventListener("click", () => setOctoOpen($("#octo-bubble").hidden));
$("#octo-close").addEventListener("click", () => setOctoOpen(false));
$("#octo-mute").addEventListener("click", () => {
  octoMuted = !octoMuted;
  try { localStorage.setItem("ocean-octo-muted", octoMuted ? "1" : "0"); } catch {}
  $("#octo-mute").textContent = octoMuted ? "Povolit automatické zprávy" : "Ztišit automatické zprávy";
});

$("#profile-button").addEventListener("click", () => {
  const hidden = $("#profile-menu").classList.toggle("hidden");
  $("#profile-button").setAttribute("aria-expanded", String(!hidden));
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
