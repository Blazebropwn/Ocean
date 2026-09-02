const $ = (selector) => document.querySelector(selector);
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Něco se nepovedlo.");
  return body;
}
async function loadTelegram() {
  const { telegram } = await api("/api/telegram");
  $("#telegram-state").textContent = telegram.connected ? "AKTIVNÍ" : "VYPNUTO";
  $("#telegram-connected").classList.toggle("hidden", !telegram.connected);
  $("#telegram-disconnected").classList.toggle("hidden", telegram.connected);
  $("#telegram-account").textContent = telegram.username ? `@${telegram.username}` : "Telegram propojen";
  if (!telegram.available) { $("#create-telegram-code").disabled = true; $("#telegram-message").textContent = "Telegram zatím není na serveru nastavený."; }
}
$("#create-telegram-code").addEventListener("click", async () => {
  try {
    const { pairing } = await api("/api/telegram/pairing", { method: "POST", body: "{}" });
    const command = `/link ${pairing.code}`;
    $("#pairing-code").textContent = pairing.code;
    $("#pairing-command").textContent = command;
    $("#telegram-open").href = `https://t.me/${pairing.botUsername}?start=${pairing.code}`;
    $("#telegram-code").classList.remove("hidden");
    $("#telegram-message").textContent = "";
  } catch (error) { $("#telegram-message").textContent = error.message; }
});
$("#disconnect-telegram").addEventListener("click", async () => { await api("/api/telegram", { method: "DELETE" }); await loadTelegram(); });
loadTelegram().catch((error) => { $("#telegram-message").textContent = error.message; });
