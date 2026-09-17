import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { publicUser, type KryptotronInstanceRecord, type OceanDatabase, type UserRecord } from "../db.js";
import { hashToken, newVerificationToken } from "../security.js";
import { loadKryptotronSnapshot } from "../kryptotron.js";
import { approvalMode, currentUser, requestMeta } from "./shared.js";

const memberDeletionSchema = z.object({ confirmation: z.string().trim().min(1).max(64) }).strict();

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

  app.get("/api/members/:id/kryptotron", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const owner = currentUser(db, request);
    if (!owner) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (owner.role !== "owner") return reply.code(403).send({ error: "Kryptotron člena může zobrazit pouze vlastník." });
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^usr_[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: "Neplatný účet." });
    const member = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'member'").get(id) as { id: string } | undefined;
    if (!member) return reply.code(404).send({ error: "Člen nebyl nalezen." });
    const instance = db.prepare("SELECT * FROM kryptotron_instances WHERE user_id = ?").get(id) as KryptotronInstanceRecord | undefined;
    if (!instance || instance.status !== "connected" || !instance.remote_state_key) return reply.code(409).send({ error: "Člen nemá připojený Kryptotron." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      const snapshot = await loadKryptotronSnapshot(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instance.remote_state_key);
      const open = snapshot.positions.find((position) => position.inPosition);
      return {
        kryptotron: {
          status: snapshot.status,
          environment: snapshot.environment,
          entriesPaused: snapshot.entriesPaused,
          balance: snapshot.balance,
          octo: { state: snapshot.octo.state, message: snapshot.octo.message },
          position: open ? { symbol: open.symbol, protectionActive: open.protectionActive } : null,
          lastError: snapshot.lastError,
        },
      };
    } catch {
      return reply.code(502).send({ error: "Stav Kryptotronu se nepodařilo načíst." });
    }
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

  app.delete("/api/members/:id", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const owner = currentUser(db, request);
    if (!owner) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (owner.role !== "owner") return reply.code(403).send({ error: "Účty může mazat pouze vlastník." });
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^usr_[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: "Neplatný účet." });
    const parsed = memberDeletionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Smazání vyžaduje potvrzení uživatelským jménem." });

    const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(id) as UserRecord | undefined;
    if (!member) return reply.code(404).send({ error: "Člen nebyl nalezen." });
    if (parsed.data.confirmation.toLocaleLowerCase("cs-CZ") !== member.username.toLocaleLowerCase("cs-CZ")) {
      return reply.code(400).send({ error: "Uživatelské jméno nesouhlasí." });
    }

    const instance = db.prepare("SELECT id, status, environment FROM kryptotron_instances WHERE user_id = ?").get(member.id) as
      { id: string; status: string; environment: string } | undefined;
    const meta = requestMeta(request);
    db.transaction(() => {
      // Odstranění uživatele kaskádově zneplatní sessions, klíče, Telegram,
      // Kryptotron i agentní historii. Audit záměrně uchovává jen bezpečný snapshot identity.
      db.prepare(`INSERT INTO admin_audit_log
        (actor_user_id, action, subject_user_id, subject_username, details_json, ip_address, user_agent)
        VALUES (?, 'MEMBER_DELETED', ?, ?, ?, ?, ?)`)
        .run(owner.id, member.id, member.username, JSON.stringify({
          displayId: `OCEAN-${String(member.public_id).padStart(6, "0")}`,
          kryptotron: instance ?? null,
        }), meta.ip, meta.agent);
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'member'").run(member.id);
    })();
    return reply.code(204).send();
  });
}
