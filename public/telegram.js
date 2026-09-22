const $ = (selector) => document.querySelector(selector);
async function api(path, options = {}) {
  const headers = options.body === undefined ? {} : { "Content-Type": "application/json" };
  const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Něco se nepovedlo.");
  return body;
}
async function loadTelegram() {
  const { telegram } = await api("/api/telegram");
  $("#telegram-state").textContent = telegram.connected ? "Propojeno" : "Nepřipojeno";
  $("#telegram-state").dataset.connected = String(telegram.connected);
  $("#telegram-loading").classList.add("hidden");
  $("#telegram-connected").classList.toggle("hidden", !telegram.connected);
  $("#telegram-disconnected").classList.toggle("hidden", telegram.connected);
  $("#telegram-account").textContent = telegram.username ? `@${telegram.username}` : "Tvůj Telegram";
  $("#create-telegram-code").disabled = !telegram.available;
  $("#telegram-chat").classList.toggle("hidden", !telegram.botUsername);
  if (telegram.botUsername) $("#telegram-chat").href = `https://t.me/${encodeURIComponent(telegram.botUsername)}`;
  if (telegram.connected) $("#telegram-code").classList.add("hidden");
  if (!telegram.available) $("#telegram-message").textContent = "Telegram zatím není na serveru nastavený.";
}
$("#create-telegram-code").addEventListener("click", async () => {
  const button = $("#create-telegram-code");
  button.disabled = true;
  $("#telegram-message").textContent = "";
  $("#telegram-message").classList.remove("success");
  try {
    const { pairing } = await api("/api/telegram/pairing", { method: "POST", body: "{}" });
    const command = `/link ${pairing.code}`;
    $("#pairing-command").textContent = command;
    $("#telegram-open").href = `https://t.me/${encodeURIComponent(pairing.botUsername)}?start=${encodeURIComponent(pairing.code)}`;
    $("#telegram-code").classList.remove("hidden");
    $("#telegram-disconnected").classList.add("pairing-ready");
    button.textContent = "Vytvořit nový kód";
    $("#telegram-message").textContent = "";
  } catch (error) { $("#telegram-message").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#disconnect-telegram").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Odpojuji…";
  $("#telegram-message").textContent = "";
  $("#telegram-message").classList.remove("success");
  try {
    await api("/api/telegram", { method: "DELETE", body: "{}" });
    $("#telegram-code").classList.add("hidden");
    $("#telegram-disconnected").classList.remove("pairing-ready");
    $("#create-telegram-code").textContent = "Propojit Telegram";
    await loadTelegram();
    $("#telegram-message").classList.add("success");
    $("#telegram-message").textContent = "Telegram byl odpojen.";
  } catch (error) {
    $("#telegram-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Odpojit";
  }
});
loadTelegram().catch((error) => {
  $("#telegram-loading").classList.add("hidden");
  $("#telegram-state").textContent = "Nedostupné";
  $("#telegram-message").textContent = error.message;
});
