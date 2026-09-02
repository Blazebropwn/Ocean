const $ = (selector) => document.querySelector(selector);
const message = $("#message");
const registrationInviteToken = new URLSearchParams(location.search).get("invite");
if (registrationInviteToken) history.replaceState(null, "", `${location.pathname}${location.hash}`);
let kryptotronRefresh;
let entriesPaused = false;
let dcaEnabled = false;
let streakEnabled = false;
let arcadeName = null;
let arcadeState = null;
let arcadeFrame = null;

function setLoading(form, loading) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = loading;
  button.dataset.label ||= button.innerHTML;
  button.innerHTML = loading ? "Pracuji…" : button.dataset.label;
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Něco se nepovedlo.");
  return body;
}

function showUser(user) {
  document.body.classList.add("dashboard-active");
  $("#welcome").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#nav-account").classList.remove("hidden");
  $("#display-id").textContent = user.displayId;
  $("#username").textContent = `@${user.username}`;
  $("#avatar").textContent = user.username[0].toUpperCase();
  $("#nav-avatar").textContent = user.username[0].toUpperCase();
  $("#nav-username").textContent = user.username;
  $("#menu-username").textContent = user.username;
  $("#email").textContent = user.email;
  $("#email-status").textContent = user.emailVerified ? "✓ OVĚŘENO" : "ČEKÁ NA OVĚŘENÍ";
  $("#email-status").className = user.emailVerified ? "hidden verified" : "hidden pending";
  $("#invite-admin-link").classList.toggle("hidden", user.role !== "owner");
  $("#verify-banner").classList.toggle("hidden", user.emailVerified);
  const initialView = location.hash === "#arcade" ? "arcade" : location.hash === "#vault" ? "vault" : "overview";
  const initialLink = document.querySelector(`.side-link[href="${location.hash || "#dashboard"}"]`);
  showAppView(initialView, initialLink);
  initializeKryptotron();
  clearInterval(kryptotronRefresh);
  kryptotronRefresh = setInterval(initializeKryptotron, 60_000);
}

function showAppView(view, activeLink = null) {
  const selected = ["overview", "arcade", "vault"].includes(view) ? view : "overview";
  if (selected !== "arcade") {
    cancelAnimationFrame(arcadeFrame);
    if (arcadeState) arcadeState.active = false;
  }
  document.querySelectorAll(".app-view").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${selected}-view`));
  document.querySelectorAll(".side-link[data-view]").forEach((link) => link.classList.toggle("active", activeLink ? link === activeLink : link.dataset.view === selected));
  $("#workspace-title").textContent = selected === "overview" ? "Přehled" : selected === "arcade" ? "Arcade" : "Vault";
}

document.querySelectorAll(".side-link[data-view]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", link.getAttribute("href"));
  showAppView(link.dataset.view, link);
}));

const arcadeGames = {
  sonar: { title: "Sonar", kicker: "ARCADE / 01", hint: "Zastav pulz v cílovém kruhu." },
  dive: { title: "Dive", kicker: "ARCADE / 02", hint: "Tapnutím měníš směr ponoru." },
  depth: { title: "Depth", kicker: "ARCADE / 03", hint: "Zastav sestup v zelené zóně." },
};

function arcadeBest(name) {
  return Number(localStorage.getItem(`ocean-${name}-best`) || 0);
}

function sizeArcadeCanvas() {
  const canvas = $("#game-canvas");
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
  canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
  return { canvas, ctx: canvas.getContext("2d"), width: canvas.width, height: canvas.height };
}

function openArcade(name) {
  arcadeName = name;
  cancelAnimationFrame(arcadeFrame);
  arcadeState = null;
  $("#arcade-library").classList.add("hidden");
  $("#arcade-game").classList.remove("hidden");
  $("#game-title").textContent = arcadeGames[name].title;
  $("#game-kicker").textContent = arcadeGames[name].kicker;
  $("#game-hint").textContent = arcadeGames[name].hint;
  $("#game-score").textContent = "0";
  $("#game-best").textContent = arcadeBest(name);
  $("#game-tap").textContent = "Spustit";
  drawArcadeIdle();
}

function drawArcadeIdle() {
  const { ctx, width, height } = sizeArcadeCanvas();
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#8fcbd0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * .16, 0, Math.PI * 2);
  ctx.stroke();
}

function startArcade() {
  const now = performance.now();
  if (arcadeName === "sonar") arcadeState = { active: true, start: now, score: 0, combo: 0, target: .3 };
  if (arcadeName === "dive") arcadeState = { active: true, last: now, start: now, score: 0, y: .5, direction: 1, obstacles: [] };
  if (arcadeName === "depth") arcadeState = { active: true, start: now, score: 0, rounds: 0, target: .72 };
  $("#game-tap").textContent = arcadeName === "sonar" ? "PING" : arcadeName === "dive" ? "ZMĚNIT SMĚR" : "ZASTAVIT";
  cancelAnimationFrame(arcadeFrame);
  arcadeFrame = requestAnimationFrame(runArcade);
}

function finishArcade() {
  arcadeState.active = false;
  const score = Math.floor(arcadeState.score);
  const best = Math.max(score, arcadeBest(arcadeName));
  localStorage.setItem(`ocean-${arcadeName}-best`, String(best));
  $("#game-score").textContent = score;
  $("#game-best").textContent = best;
  $("#game-tap").textContent = "Hrát znovu";
  $("#game-hint").textContent = `Konec hry · ${score} bodů`;
}

function arcadeTap() {
  if (!arcadeState?.active) return startArcade();
  if (arcadeName === "sonar") {
    const phase = ((performance.now() - arcadeState.start) % 1500) / 1500;
    const distance = Math.abs(phase - arcadeState.target);
    const gain = distance < .025 ? 100 : distance < .07 ? 50 : distance < .13 ? 20 : 0;
    arcadeState.combo = gain ? arcadeState.combo + 1 : 0;
    arcadeState.score += gain + Math.max(0, arcadeState.combo - 1) * 5;
    arcadeState.target = .2 + Math.random() * .55;
  } else if (arcadeName === "dive") {
    arcadeState.direction *= -1;
  } else {
    const phase = (Math.sin((performance.now() - arcadeState.start) / 430) + 1) / 2;
    const distance = Math.abs(phase - arcadeState.target);
    arcadeState.score += distance < .035 ? 100 : distance < .09 ? 50 : distance < .16 ? 20 : 0;
    arcadeState.rounds += 1;
    arcadeState.target = .18 + Math.random() * .64;
    if (arcadeState.rounds >= 5) finishArcade();
  }
  $("#game-score").textContent = Math.floor(arcadeState.score);
}

function runArcade(now) {
  if (!arcadeState?.active) return;
  const { ctx, width, height } = sizeArcadeCanvas();
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = Math.max(2, width / 300);
  if (arcadeName === "sonar") {
    const phase = ((now - arcadeState.start) % 1500) / 1500;
    const maxRadius = Math.min(width, height) * .44;
    ctx.strokeStyle = "#afdadd";
    ctx.beginPath(); ctx.arc(width / 2, height / 2, arcadeState.target * maxRadius, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#087f8c";
    ctx.beginPath(); ctx.arc(width / 2, height / 2, phase * maxRadius, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#087f8c"; ctx.beginPath(); ctx.arc(width / 2, height / 2, 7, 0, Math.PI * 2); ctx.fill();
    if (now - arcadeState.start >= 30000) finishArcade();
  } else if (arcadeName === "dive") {
    const delta = Math.min((now - arcadeState.last) / 1000, .04); arcadeState.last = now;
    arcadeState.y += arcadeState.direction * delta * .34;
    if (arcadeState.y < .06 || arcadeState.y > .94) return finishArcade();
    if (!arcadeState.obstacles.length || arcadeState.obstacles.at(-1).x < .68) arcadeState.obstacles.push({ x: 1.08, gap: .18 + Math.random() * .64, passed: false });
    ctx.fillStyle = "#c6e3e5";
    for (const obstacle of arcadeState.obstacles) {
      obstacle.x -= delta * .24;
      const x = obstacle.x * width, gap = obstacle.gap * height, gapSize = height * .28;
      ctx.fillRect(x, 0, width * .035, Math.max(0, gap - gapSize / 2));
      ctx.fillRect(x, gap + gapSize / 2, width * .035, height);
      if (!obstacle.passed && obstacle.x < .24) { obstacle.passed = true; arcadeState.score += 100; }
      if (Math.abs(obstacle.x - .24) < .035 && Math.abs(arcadeState.y - obstacle.gap) > .14) return finishArcade();
    }
    arcadeState.obstacles = arcadeState.obstacles.filter((item) => item.x > -.1);
    ctx.fillStyle = "#087f8c"; ctx.beginPath(); ctx.arc(width * .24, height * arcadeState.y, 9, 0, Math.PI * 2); ctx.fill();
  } else {
    const phase = (Math.sin((now - arcadeState.start) / 430) + 1) / 2;
    const x = width / 2, top = height * .12, span = height * .76;
    ctx.strokeStyle = "#d2e4e6"; ctx.lineWidth = width * .025; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + span); ctx.stroke();
    ctx.strokeStyle = "#75bfa7"; ctx.lineWidth = width * .035; ctx.beginPath(); ctx.moveTo(x, top + (arcadeState.target - .06) * span); ctx.lineTo(x, top + (arcadeState.target + .06) * span); ctx.stroke();
    ctx.fillStyle = "#087f8c"; ctx.beginPath(); ctx.arc(x, top + phase * span, 10, 0, Math.PI * 2); ctx.fill();
  }
  $("#game-score").textContent = Math.floor(arcadeState.score);
  arcadeFrame = requestAnimationFrame(runArcade);
}

document.querySelectorAll(".game-card").forEach((card) => card.addEventListener("click", () => openArcade(card.dataset.game)));
$("#game-back").addEventListener("click", () => { cancelAnimationFrame(arcadeFrame); arcadeState = null; $("#arcade-game").classList.add("hidden"); $("#arcade-library").classList.remove("hidden"); });
$("#game-tap").addEventListener("click", arcadeTap);
$("#game-canvas").addEventListener("pointerdown", arcadeTap);
window.addEventListener("keydown", (event) => { if (event.code === "Space" && !$("#arcade-game").classList.contains("hidden")) { event.preventDefault(); arcadeTap(); } });

async function loadKryptotron() {
  try {
    const { kryptotron } = await request("/api/kryptotron");
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
  } catch (error) {
    $("#kryptotron-status").lastChild.textContent = " Nepřipojeno";
    $("#bot-position").textContent = error.message;
  }
}

async function initializeKryptotron() {
  try {
    const { connection } = await request("/api/kryptotron/connection");
    const panel = $("#connection-panel");
    const form = $("#connection-form");
    if (connection.status === "connected") {
      panel.classList.add("hidden");
      $("#kryptotron").classList.remove("connection-active");
      await loadKryptotron();
      return;
    }
    panel.classList.remove("hidden");
    $("#kryptotron").classList.add("connection-active");
    const provisioning = connection.status === "provisioning";
    form.classList.toggle("hidden", provisioning);
    $("#provisioning-status").classList.toggle("hidden", !provisioning);
  } catch (error) {
    $("#kryptotron-status").lastChild.textContent = " Nepřipojeno";
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
    time.textContent = event.at ? new Intl.DateTimeFormat("cs-CZ", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.at)) : "—";
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
  return value ? new Intl.DateTimeFormat("cs-CZ", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
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

$("#profile-button").addEventListener("click", () => $("#profile-menu").classList.toggle("hidden"));

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  $("#register-form").classList.toggle("hidden", tab.dataset.tab !== "register");
  $("#login-form").classList.toggle("hidden", tab.dataset.tab !== "login");
  message.textContent = "";
}));

for (const [id, path] of [["#register-form", "/api/auth/register"], ["#login-form", "/api/auth/login"]]) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    message.textContent = "";
    setLoading(form, true);
    try {
      const body = Object.fromEntries(new FormData(form));
      if (id === "#register-form") {
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
