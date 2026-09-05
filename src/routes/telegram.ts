import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { hashToken, newTelegramPairingCode } from "../security.js";
import { currentUser } from "./shared.js";

export function registerTelegramRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.get("/api/telegram", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const connection = db.prepare("SELECT telegram_username, connected_at FROM telegram_connections WHERE user_id = ?").get(user.id) as { telegram_username: string | null; connected_at: string } | undefined;
    return { telegram: { connected: Boolean(connection), username: connection?.telegram_username ?? null, connectedAt: connection?.connected_at ?? null, botUsername: config.telegramBotUsername ?? null, available: Boolean(config.telegramBotToken && config.telegramBotUsername) } };
  });

  app.post("/api/telegram/pairing", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (config.manualApprovalEnabled && !user.approved_at) return reply.code(403).send({ error: "Účet ještě nebyl schválen." });
    if (!config.telegramBotToken || !config.telegramBotUsername) return reply.code(503).send({ error: "Telegram zatím není nastavený." });
    const code = newTelegramPairingCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.transaction(() => {
      db.prepare("DELETE FROM telegram_pairings WHERE user_id = ?").run(user.id);
      db.prepare("INSERT INTO telegram_pairings (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(code), user.id, expiresAt);
    })();
    return reply.code(201).send({ pairing: { code, expiresAt, botUsername: config.telegramBotUsername } });
  });

  app.delete("/api/telegram", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    db.transaction(() => {
      db.prepare("DELETE FROM telegram_pairings WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM telegram_connections WHERE user_id = ?").run(user.id);
    })();
    return reply.code(204).send();
  });
}
