import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";

type MailRow = { id: number; recipient: string; subject: string; body: string; attempts: number };
type MailLogger = { info(value: unknown, message?: string): void; warn(value: unknown, message?: string): void };

export async function deliverMailBatch(db: OceanDatabase, config: Config, fetcher: typeof fetch = fetch) {
  if (!config.resendApiKey || !config.emailFrom) return 0;
  const rows = db.prepare("SELECT id, recipient, subject, body, attempts FROM mail_outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 10").all() as MailRow[];
  let delivered = 0;
  for (const row of rows) {
    try {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: config.emailFrom, to: [row.recipient], subject: row.subject, text: row.body }),
      });
      if (!response.ok) throw new Error(`E-mail provider odpověděl ${response.status}.`);
      db.prepare("UPDATE mail_outbox SET sent_at = datetime('now'), attempts = attempts + 1, last_error = NULL WHERE id = ? AND sent_at IS NULL").run(row.id);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Neznámá chyba";
      db.prepare("UPDATE mail_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sent_at IS NULL").run(message, row.id);
    }
  }
  return delivered;
}

export function startMailer(config: Config, db: OceanDatabase, logger: MailLogger) {
  if (!config.resendApiKey || !config.emailFrom) {
    logger.warn({}, "E-mailový provider není nastaven; zprávy zůstávají v lokálním outboxu");
    return { stop() {} };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      const count = await deliverMailBatch(db, config);
      if (count) logger.info({ count }, "E-maily byly odeslány");
    } catch (error) {
      logger.warn({ err: error }, "E-mailový outbox se nepodařilo zpracovat");
    }
    timer = setTimeout(run, 30_000);
    timer.unref();
  };
  void run();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
