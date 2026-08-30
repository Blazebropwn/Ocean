const $ = (selector) => document.querySelector(selector);
const message = $("#message");
let kryptotronRefresh;
let entriesPaused = false;

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
  $("#verify-banner").classList.toggle("hidden", user.emailVerified);
  loadKryptotron();
  clearInterval(kryptotronRefresh);
  kryptotronRefresh = setInterval(loadKryptotron, 60_000);
}

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
