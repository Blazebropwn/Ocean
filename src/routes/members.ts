import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { publicUser, type OceanDatabase, type UserRecord } from "../db.js";
import { hashToken, newVerificationToken } from "../security.js";
import { approvalMode, currentUser, requestMeta } from "./shared.js";

export function registerMemberRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.get("/api/members", async (request, reply) => {
    const owner = currentUser(db, request);
    if (!owner) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (owner.role !== "owner") return reply.code(403).send({ error: "Členy může spravovat pouze vlastník." });
    const members = db.prepare("SELECT * FROM users WHERE role = 'member' ORDER BY created_at DESC").all() as UserRecord[];
    const instances = db.prepare(`
      SELECT i.user_id, i.status, i.environment, i.remote_state_key, i.updated_at,
        CASE WHEN c.instance_id IS NOT NULL THEN 1 ELSE 0 END AS has_credentials
      FROM kryptotron_instances i
      LEFT JOIN kryptotron_credentials c ON c.instance_id = i.id
    `).all() as Array<{ user_id: string; status: string; environment: string; remote_state_key: string | null; updated_at: string; has_credentials: number }>;
    const instanceByUser = new Map(instances.map((row) => [row.user_id, row]));
    return {
      members: members.map((member) => {
        const instance = instanceByUser.get(member.id);
        return {
          ...publicUser(member, approvalMode(config)),
          instance: instance ? {
            status: instance.status,
            environment: instance.environment,
            configured: instance.has_credentials === 1 && Boolean(instance.remote_state_key),
            updatedAt: instance.updated_at,
          } : null,
        };
      }),
    };
  });

  app.post("/api/members/:id/approval", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    const owner = currentUser(db, request);
    if (!owner) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (owner.role !== "owner") return reply.code(403).send({ error: "Členy může schvalovat pouze vlastník." });
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^usr_[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: "Neplatný účet." });
    const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(id) as UserRecord | undefined;
    if (!member) return reply.code(404).send({ error: "Člen nebyl nalezen." });
    if (!member.approved_at) {
      const meta = requestMeta(request);
      db.transaction(() => {
        db.prepare("UPDATE users SET approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now') WHERE id = ? AND approved_at IS NULL").run(owner.id, member.id);
        db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'MEMBER_APPROVED', ?, ?)").run(member.id, meta.ip, meta.agent);
      })();
    }
    const approved = db.prepare("SELECT * FROM users WHERE id = ?").get(member.id) as UserRecord;
    return { member: publicUser(approved, approvalMode(config)) };
  });

  app.post("/api/members/:id/password-reset", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const owner = currentUser(db, request);
    if (!owner) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (owner.role !== "owner") return reply.code(403).send({ error: "Obnovu hesla může zahájit pouze vlastník." });
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^usr_[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: "Neplatný účet." });
    const member = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'member'").get(id) as { id: string } | undefined;
    if (!member) return reply.code(404).send({ error: "Člen nebyl nalezen." });

    const token = newVerificationToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const resetUrl = `${config.appOrigin}/reset-password.html?token=${encodeURIComponent(token)}`;
    const meta = requestMeta(request);
    db.transaction(() => {
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(member.id);
      db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), member.id, expiresAt);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'ADMIN_PASSWORD_RESET_ISSUED', ?, ?)").run(member.id, meta.ip, meta.agent);
    })();
    return reply.code(201).send({ reset: { resetUrl, expiresAt } });
  });
}
