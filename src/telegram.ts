import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { loadKryptotronSnapshot, setKryptotronEntriesPaused } from "./kryptotron.js";
import { hashToken } from "./security.js";

type TelegramMessage = { chat?: { id?: number }; from?: { username?: string }; text?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type TelegramLogger = { info(value: unknown, message?: string): void; warn(value: unknown, message?: string): void };

function command(text = "") {
  const [name = "", argument = ""] = text.trim().split(/\s+/, 2);
  return { name: name.toLowerCase().split("@")[0], argument: argument.toUpperCase() };
}

function connectionForChat(db: OceanDatabase, chatId: string) {
  return db.prepare(`SELECT t.user_id, i.remote_state_key, i.status
    FROM telegram_connections t JOIN kryptotron_instances i ON i.user_id = t.user_id
    WHERE t.chat_id = ?`).get(chatId) as { user_id: string; remote_state_key: string | null; status: string } | undefined;
}

export async function processTelegramMessage(db: OceanDatabase, config: Config, message: TelegramMessage, send: (chatId: string, text: string) => Promise<void>) {
  const chatId = message.chat?.id === undefined ? null : String(message.chat.id);
  if (!chatId || typeof message.text !== "string") return;
  const parsed = command(message.text);

  if (parsed.name === "/link" || (parsed.name === "/start" && parsed.argument)) {
    if (!/^[A-F0-9]{32}$/.test(parsed.argument)) return send(chatId, "Neplatný nebo chybějící párovací kód.");
    const pairing = db.prepare("SELECT user_id FROM telegram_pairings WHERE token_hash = ? AND expires_at > datetime('now')")
      .get(hashToken(parsed.argument)) as { user_id: string } | undefined;
    if (!pairing) return send(chatId, "Párovací kód není platný nebo už vypršel.");
    const link = db.transaction(() => {
      db.prepare("DELETE FROM telegram_connections WHERE chat_id = ? OR user_id = ?").run(chatId, pairing.user_id);
      db.prepare("INSERT INTO telegram_connections (user_id, chat_id, telegram_username) VALUES (?, ?, ?)")
        .run(pairing.user_id, chatId, message.from?.username ?? null);
      db.prepare("DELETE FROM telegram_pairings WHERE user_id = ?").run(pairing.user_id);
    });
    link();
    return send(chatId, "Ocean byl propojen. Příkazy: /status a /pause");
  }

  const connection = connectionForChat(db, chatId);
  if (!connection) return send(chatId, "Telegram není propojený s účtem Ocean.");
  if (parsed.name === "/pause") {
    if (!connection.remote_state_key || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron teď není dostupný.");
    await setKryptotronEntriesPaused(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, true, connection.remote_state_key);
    return send(chatId, "⏸ Nové obchody jsou pozastavené. Otevřená pozice zůstává chráněná.");
  }
  if (parsed.name === "/status" || parsed.name === "/start") {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron zatím není připojený.");
    const snapshot = await loadKryptotronSnapshot(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, connection.remote_state_key);
    const balance = snapshot.balance.amount === null ? "—" : `${snapshot.balance.amount.toFixed(2)} ${snapshot.balance.asset}`;
    const position = snapshot.positions.find((item) => item.inPosition)?.symbol ?? "bez pozice";
    return send(chatId, `🌊 Ocean\nKryptotron: ${snapshot.entriesPaused ? "pozastaven" : snapshot.status}\nBalance: ${balance}\nPozice: ${position}`);
  }
  return send(chatId, "Příkazy: /status a /pause");
}

async function telegramCall(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Telegram odpověděl ${response.status}.`);
  return await response.json() as { ok: boolean; result: TelegramUpdate[] };
}

export function startTelegramBot(config: Config, db: OceanDatabase, logger: TelegramLogger) {
  if (!config.telegramBotToken) {
    logger.info({}, "Ocean Telegram není nastaven");
    return { stop() {} };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const send = async (chatId: string, text: string) => { await telegramCall(config.telegramBotToken!, "sendMessage", { chat_id: chatId, text }); };
  const poll = async () => {
    if (stopped) return;
    try {
      const state = db.prepare("SELECT update_offset FROM telegram_bot_state WHERE id = 1").get() as { update_offset: number };
      const response = await telegramCall(config.telegramBotToken!, `getUpdates?timeout=20&offset=${state.update_offset}`);
      for (const update of response.result ?? []) {
        try { if (update.message) await processTelegramMessage(db, config, update.message, send); }
        catch (error) { logger.warn({ err: error, updateId: update.update_id }, "Telegram příkaz selhal"); }
        db.prepare("UPDATE telegram_bot_state SET update_offset = ? WHERE id = 1").run(update.update_id + 1);
      }
    } catch (error) { logger.warn({ err: error }, "Telegram polling selhal"); }
    timer = setTimeout(poll, 3_000);
    timer.unref();
  };
  void poll();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
