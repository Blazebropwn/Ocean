import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { loadKryptotronSnapshot, setKryptotronEntriesPaused, setDcaEnabled, setStreakEnabled } from "./kryptotron.js";
import { hashToken } from "./security.js";
import { portfolioRiskReportSchema } from "./agents/risk-report.js";
import type { CompletedRun } from "./agents/repository.js";
import { randomBytes } from "node:crypto";

type TelegramMessage = { chat?: { id?: number }; from?: { username?: string }; text?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type TelegramLogger = { info(value: unknown, message?: string): void; warn(value: unknown, message?: string): void };

function command(text = "") {
  const [name = "", argument = ""] = text.trim().split(/\s+/, 2);
  return { name: name.toLowerCase().split("@")[0] ?? "", argument: argument.toUpperCase() };
}

const HELP_TEXT = [
  "🌊 Ocean příkazy:",
  "/status — stav tvého Kryptotronu",
  "/pause — pozastavit nové obchody",
  "/resume — obnovit obchodování",
  "/report — přehled portfolia a limitů",
  "/dca · /dca_on · /dca_off — pravidelné nákupy",
  "/streak · /streak_on · /streak_off — paper strategie",
  "/help — tato nápověda",
  "/link <kód> — propojit účet (kód najdeš v Oceanu)",
].join("\n");

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
    return send(chatId, `Ocean byl propojen.\n\n${HELP_TEXT}`);
  }

  if (parsed.name === "/help") return send(chatId, HELP_TEXT);

  const connection = connectionForChat(db, chatId);
  if (!connection) return send(chatId, "Telegram není propojený s účtem Ocean. Otevři Ocean → profil → Telegram a propoj účet.");
  if (parsed.name === "/pause") {
    if (!connection.remote_state_key || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron teď není dostupný.");
    await setKryptotronEntriesPaused(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, true, connection.remote_state_key);
    return send(chatId, "⏸ Nové obchody jsou pozastavené. Otevřená pozice zůstává chráněná.");
  }
  if (parsed.name === "/resume") {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron teď není dostupný.");
    await setKryptotronEntriesPaused(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, false, connection.remote_state_key);
    return send(chatId, "▶️ Obchodování obnoveno. Kryptotron zase může otevírat nové obchody.");
  }
  if (["/dca_on", "/dca_off", "/streak_on", "/streak_off"].includes(parsed.name)) {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron teď není dostupný.");
    const enabled = parsed.name.endsWith("_on");
    const dca = parsed.name.startsWith("/dca");
    if (enabled) {
      const code = randomBytes(6).toString("hex").toUpperCase();
      db.prepare(`INSERT INTO telegram_confirmations (user_id, token_hash, action, expires_at)
        VALUES (?, ?, ?, datetime('now', '+5 minutes'))
        ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, action=excluded.action, expires_at=excluded.expires_at`)
        .run(connection.user_id, hashToken(code), parsed.name.slice(1));
      return send(chatId, `Zapnout ${dca ? "DCA (pravidelné nákupy)" : "PAPER Streak"}? Potvrď do 5 minut příkazem:\n/confirm ${code}`);
    }
    await (dca ? setDcaEnabled : setStreakEnabled)(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, enabled, connection.remote_state_key);
    return send(chatId, `${dca ? "DCA" : "PAPER Streak"}: ${enabled ? "zapnuto" : "vypnuto"}.`);
  }
  if (parsed.name === "/confirm") {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron teď není dostupný.");
    const pending = db.prepare("DELETE FROM telegram_confirmations WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now') RETURNING action")
      .get(connection.user_id, hashToken(parsed.argument)) as { action: string } | undefined;
    if (!pending) return send(chatId, "Potvrzení není platné nebo už vypršelo.");
    const dca = pending.action === "dca_on";
    await (dca ? setDcaEnabled : setStreakEnabled)(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, true, connection.remote_state_key);
    return send(chatId, `${dca ? "DCA" : "PAPER Streak"}: zapnuto.`);
  }
  if (["/report", "/dca", "/streak"].includes(parsed.name)) {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron zatím není připojený.");
    const snapshot = await loadKryptotronSnapshot(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, connection.remote_state_key);
    return send(chatId, ["🌊 Ocean · přehled",
      `Trading: ${snapshot.entriesPaused ? "pozastaven" : snapshot.status}`,
      `DCA: ${snapshot.dca.enabled ? "zapnuto" : "vypnuto"} · ${snapshot.dca.amount} USDC / asset`,
      `Streak: ${snapshot.streak.enabled ? "zapnuto" : "vypnuto"} · PAPER`,
      `Týdenní ztráta: ${snapshot.limits.weeklyLoss.toFixed(2)} ${snapshot.balance.asset}`,
    ].join("\n"));
  }
  if (parsed.name === "/status" || parsed.name === "/start") {
    if (!connection.remote_state_key || connection.status !== "connected" || !config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return send(chatId, "Kryptotron zatím není připojený.");
    const snapshot = await loadKryptotronSnapshot(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, connection.remote_state_key);
    const balance = snapshot.balance.amount === null ? "—" : `${snapshot.balance.amount.toFixed(2)} ${snapshot.balance.asset}`;
    const position = snapshot.positions.find((item) => item.inPosition)?.symbol ?? "bez pozice";
    return send(chatId, `🌊 Ocean\nKryptotron: ${snapshot.entriesPaused ? "pozastaven" : snapshot.status}\nBalance: ${balance}\nPozice: ${position}`);
  }
  return send(chatId, HELP_TEXT);
}

async function telegramCall(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Telegram odpověděl ${response.status}.`);
  const result = await response.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!result.ok) throw new Error("Telegram požadavek odmítl.");
  return result;
}

export async function deliverWorkerNotifications(db: OceanDatabase, send: (chatId: string, text: string) => Promise<void>) {
  const pending = db.prepare(`SELECT n.instance_id, n.id, n.message, n.attempts, t.chat_id
    FROM worker_notifications n
    JOIN kryptotron_instances i ON i.id = n.instance_id
    JOIN telegram_connections t ON t.user_id = i.user_id
    WHERE n.sent_at IS NULL AND n.attempts < 5 AND n.next_attempt_at <= datetime('now')
    ORDER BY n.created_at, n.id LIMIT 10`).all() as Array<{ instance_id: string; id: string; message: string; attempts: number; chat_id: string }>;
  for (const item of pending) {
    try {
      await send(item.chat_id, item.message);
      db.prepare("UPDATE worker_notifications SET sent_at = datetime('now'), last_error = NULL WHERE instance_id = ? AND id = ?")
        .run(item.instance_id, item.id);
    } catch {
      db.prepare("UPDATE worker_notifications SET attempts = attempts + 1, last_error = 'TELEGRAM_SEND_FAILED', next_attempt_at = datetime('now', ?) WHERE instance_id = ? AND id = ?")
        .run(`+${Math.min(3600, 30 * 2 ** item.attempts)} seconds`, item.instance_id, item.id);
    }
  }
  // Keep deduplication records for a month, without unbounded message history.
  db.prepare("DELETE FROM worker_notifications WHERE created_at < datetime('now', '-30 days')").run();
}

export function agentRunNotificationText(run: CompletedRun, appOrigin: string) {
  const dashboardUrl = `${appOrigin.replace(/\/$/, "")}/#dashboard`;
  const report = portfolioRiskReportSchema.safeParse(run.result);
  if (run.status === "succeeded" && run.validationStatus === "passed" && report.success) {
    return [
      "✅ Kontrola portfolia dokončena",
      "Podrobný výsledek najdeš v Oceanu.",
      dashboardUrl,
    ].join("\n");
  }
  return [
    "⚠️ Kontrolu portfolia se nepodařilo dokončit",
    "Kryptotron tím není zastavený. Podrobnosti najdeš v Oceanu.",
    dashboardUrl,
  ].join("\n");
}

export async function sendAgentRunTelegramNotification(
  config: Config,
  db: OceanDatabase,
  userId: string,
  run: CompletedRun,
  send: (chatId: string, text: string) => Promise<void> = async (chatId, text) => {
    if (!config.telegramBotToken) return;
    const response = await telegramCall(config.telegramBotToken, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
    if (!response.ok) throw new Error("Telegram zprávu odmítl.");
  },
) {
  if (!config.telegramBotToken) return false;
  const connection = db.prepare("SELECT chat_id FROM telegram_connections WHERE user_id = ?")
    .get(userId) as { chat_id: string } | undefined;
  if (!connection) return false;
  await send(connection.chat_id, agentRunNotificationText(run, config.appOrigin));
  return true;
}

export function startTelegramBot(config: Config, db: OceanDatabase, logger: TelegramLogger) {
  if (!config.telegramBotToken) {
    logger.info({}, "Ocean Telegram není nastaven");
    return { stop() {} };
  }
  if (config.telegramPollingEnabled === false) {
    logger.info({}, "Ocean Telegram polling je na této instanci vypnutý");
    return { stop() {} };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  void telegramCall(config.telegramBotToken, "setMyCommands", {
    commands: [
      { command: "status", description: "Stav Kryptotronu" },
      { command: "pause", description: "Pozastavit nové obchody" },
      { command: "resume", description: "Obnovit obchodování" },
      { command: "report", description: "Přehled portfolia a limitů" },
      { command: "dca", description: "Pravidelné nákupy" },
      { command: "streak", description: "Paper strategie" },
      { command: "help", description: "Seznam příkazů" },
    ],
  }).catch((error) => logger.warn({ err: error }, "Nepodařilo se nastavit Telegram příkazy"));
  const send = async (chatId: string, text: string) => { await telegramCall(config.telegramBotToken!, "sendMessage", { chat_id: chatId, text }); };
  const poll = async () => {
    if (stopped) return;
    try {
      await deliverWorkerNotifications(db, async (chatId, text) => {
        await telegramCall(config.telegramBotToken!, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
      });
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
