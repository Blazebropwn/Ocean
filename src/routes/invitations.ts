import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { invitationCreateSchema } from "../schemas.js";
import { hashToken, newInvitationId, newVerificationToken } from "../security.js";
import { currentUser, hasApprovedAccess, requestMeta } from "./shared.js";

export function registerInvitationRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.get("/api/invitations", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (user.role !== "owner") return reply.code(403).send({ error: "Tuto sekci může spravovat pouze vlastník." });
    const invitations = db.prepare(`
      SELECT id, email, expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt, created_at AS createdAt,
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'used' WHEN expires_at <= datetime('now') THEN 'expired' ELSE 'active' END AS status
      FROM invitations WHERE created_by = ? ORDER BY created_at DESC LIMIT 50
    `).all(user.id);
    return { invitations };
  });

  app.post("/api/invitations", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (user.role !== "owner") return reply.code(403).send({ error: "Pozvánky může vytvářet pouze vlastník." });
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: "Účet ještě nebyl schválen." });
    const parsed = invitationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Neplatné údaje." });
    const token = newVerificationToken();
    const id = newInvitationId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const inviteUrl = `${config.appOrigin}/?invite=${encodeURIComponent(token)}`;
    db.prepare("INSERT INTO invitations (id, token_hash, email, created_by, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, hashToken(token), parsed.data.email, user.id, expiresAt);
    if (parsed.data.email && !config.manualApprovalEnabled) {
      db.prepare("INSERT INTO mail_outbox (recipient, subject, body) VALUES (?, ?, ?)")
        .run(parsed.data.email, "Pozvánka do OCEAN", `Byli jste pozváni do OCEAN. Účet vytvoříte zde:\n\n${inviteUrl}\n\nPozvánka je jednorázová a platí 7 dní.`);
    }
    const meta = requestMeta(request);
    db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'INVITATION_CREATED', ?, ?)").run(user.id, meta.ip, meta.agent);
    return reply.code(201).send({ invitation: { id, email: parsed.data.email, expiresAt, inviteUrl } });
  });

  app.delete("/api/invitations/:id", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (user.role !== "owner") return reply.code(403).send({ error: "Pozvánky může spravovat pouze vlastník." });
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^inv_[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: "Neplatná pozvánka." });
    const revoked = db.prepare("UPDATE invitations SET revoked_at = datetime('now') WHERE id = ? AND created_by = ? AND used_at IS NULL AND revoked_at IS NULL").run(id, user.id);
    if (revoked.changes !== 1) return reply.code(404).send({ error: "Aktivní pozvánka nebyla nalezena." });
    return reply.code(204).send();
  });
}
