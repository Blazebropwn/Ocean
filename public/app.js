const $ = (selector) => document.querySelector(selector);
const message = $("#message");

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
}

async function loadKryptotron() {
  try {
    const { kryptotron } = await request("/api/kryptotron");
    const statuses = { running: "Kontroluje trh", waiting: "Aktivní", degraded: "Má problém", offline: "Nedostupný", unknown: "Propojeno" };
    $("#kryptotron-status").lastChild.textContent = ` ${statuses[kryptotron.status] || "Propojeno"}`;
    $("#kryptotron-status").classList.toggle("warning", kryptotron.status === "degraded" || kryptotron.status === "offline");
    const open = kryptotron.positions.find((position) => position.inPosition);
    $("#bot-position").textContent = open ? `${open.symbol} · v pozici` : "Bez otevřené pozice";
    $("#bot-result").textContent = kryptotron.lastTrade ? `${kryptotron.lastTrade.pnl >= 0 ? "+" : ""}${kryptotron.lastTrade.pnl.toFixed(2)} USDC` : "—";
    $("#bot-result").classList.toggle("positive", Boolean(kryptotron.lastTrade && kryptotron.lastTrade.pnl >= 0));
    $("#bot-result").classList.toggle("negative", Boolean(kryptotron.lastTrade && kryptotron.lastTrade.pnl < 0));
    $("#bot-last-trade").textContent = kryptotron.lastTrade ? `${kryptotron.lastTrade.symbol} · ${kryptotron.lastTrade.result === "WIN" ? "zisk" : "ztráta"}` : "Zatím žádný";
    $("#bot-trades-week").textContent = String(kryptotron.limits.tradesWeek);
    $("#bot-updated").textContent = formatDate(kryptotron.lastMarketCheckAt || kryptotron.updatedAt);
    $("#bot-next-check").textContent = formatDate(kryptotron.nextCheckAt);
    $("#bot-error-wrap").classList.toggle("hidden", !kryptotron.lastError);
    $("#bot-error").textContent = kryptotron.lastError || "";
  } catch (error) {
    $("#kryptotron-status").lastChild.textContent = " Nepřipojeno";
    $("#bot-position").textContent = error.message;
  }
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("cs-CZ", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
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
