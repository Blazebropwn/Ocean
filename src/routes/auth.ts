import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { publicUser, type OceanDatabase, type UserRecord } from "../db.js";
import { changePasswordSchema, loginSchema, recoveryConfirmSchema, recoveryRequestSchema, registerSchema } from "../schemas.js";
import { DUMMY_PASSWORD_HASH, hashPassword, hashToken, newSessionToken, newUserId, newVerificationToken, SESSION_TTL_SECONDS, verifyPassword } from "../security.js";
import { approvalMode, COOKIE_NAME, currentUser, requestMeta } from "./shared.js";

function setSessionCookie(reply: any, token: string, config: Config) {
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
  });
}

function createSession(db: OceanDatabase, userId: string, request: FastifyRequest) {
  const token = newSessionToken();
  const meta = requestMeta(request);
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id_hash, user_id, user_agent, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hashToken(token), userId, meta.agent, meta.ip, expires);
  return token;
}

function issueVerification(db: OceanDatabase, user: UserRecord, config: Config) {
  const token = newVerificationToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const link = `${config.appOrigin}/verify.html?token=${encodeURIComponent(token)}`;
  const create = db.transaction(() => {
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(user.id);
    db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), user.id, expires);
    db.prepare("INSERT INTO mail_outbox (recipient, subject, body) VALUES (?, ?, ?)").run(user.email, "Ověřte svůj OCEAN účet", `Vítejte v OCEAN. Ověřte svůj e-mail:\n\n${link}\n\nOdkaz platí 24 hodin.`);
  });
  create();
}

export function registerAuthRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.post("/api/auth/register", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Neplatné údaje." });

    const { email, username, password, inviteToken } = parsed.data;
    const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
    if (exists) return reply.code(409).send({ error: "Účet s tímto uživatelským jménem již existuje." });

    const userId = newUserId();
    const passwordHash = await hashPassword(password);
    try {
      const register = db.transaction(() => {
        const count = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
        let role: "owner" | "member" = "owner";
        let invitationId: string | null = null;
        let invitationEmail: string | null = null;
        if (count > 0) {
          if (!inviteToken) throw new Error("INVITATION_REQUIRED");
          const invitation = db.prepare(`SELECT id, email FROM invitations WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')`)
            .get(hashToken(inviteToken)) as { id: string; email: string | null } | undefined;
          if (!invitation || (invitation.email && email && invitation.email.toLowerCase() !== email)) throw new Error("INVITATION_REQUIRED");
          role = "member";
          invitationId = invitation.id;
          invitationEmail = invitation.email;
        }
        const accountEmail = email ?? invitationEmail ?? `${userId}@users.ocean.invalid`;
        db.prepare(`INSERT INTO users (id, email, username, password_hash, role, approved_at, approved_by)
          VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'owner' THEN datetime('now') ELSE NULL END, CASE WHEN ? = 'owner' THEN ? ELSE NULL END)`)
          .run(userId, accountEmail, username, passwordHash, role, role, role, userId);
        db.prepare("INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment) VALUES (?, ?, ?, ?, ?)")
          .run(`kry_${userId.slice(4)}`, userId, role === "owner" ? "main" : null, role === "owner" ? "connected" : "unconfigured", role === "owner" ? "mainnet" : "testnet");
        if (invitationId) {
          const consumed = db.prepare("UPDATE invitations SET used_by = ?, used_at = datetime('now') WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").run(userId, invitationId);
          if (consumed.changes !== 1) throw new Error("INVITATION_REQUIRED");
        }
      });
      register();
    } catch (error: any) {
      if (error?.message === "INVITATION_REQUIRED") return reply.code(403).send({ error: "Platná pozvánka je vyžadována." });
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "Účet s tímto uživatelským jménem již existuje." });
      throw error;
    }
    const meta = requestMeta(request);
    db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'ACCOUNT_CREATED', ?, ?)").run(userId, meta.ip, meta.agent);
    const token = createSession(db, userId, request);
    setSessionCookie(reply, token, config);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRecord;
    if (!config.manualApprovalEnabled && email) issueVerification(db, user, config);
    return reply.code(201).send({ user: publicUser(user, approvalMode(config)) });
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatné uživatelské jméno nebo heslo." });
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(parsed.data.username) as UserRecord | undefined;
    const valid = await verifyPassword(user?.password_hash ?? DUMMY_PASSWORD_HASH, parsed.data.password);
    if (!user || !valid) return reply.code(401).send({ error: "Neplatné uživatelské jméno nebo heslo." });

    const token = createSession(db, user.id, request);
    const meta = requestMeta(request);
    db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'SIGNED_IN', ?, ?)").run(user.id, meta.ip, meta.agent);
    setSessionCookie(reply, token, config);
    return { user: publicUser(user, approvalMode(config)) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hashToken(token));
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.post("/api/auth/recovery/request", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const parsed = recoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Zadejte platný e-mail." });
    if (config.manualApprovalEnabled) {
      const owner = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'owner'").get(parsed.data.email) as UserRecord | undefined;
      if (owner && config.resendApiKey && config.emailFrom) {
        const token = newVerificationToken();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const link = `${config.appOrigin}/reset-password.html?token=${encodeURIComponent(token)}`;
        db.transaction(() => {
          db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(owner.id);
          db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), owner.id, expires);
          db.prepare("INSERT INTO mail_outbox (recipient, subject, body) VALUES (?, ?, ?)").run(owner.email, "Obnova hesla OCEAN", `Pro nastavení nového hesla použijte tento odkaz:\n\n${link}\n\nOdkaz platí 1 hodinu.`);
        })();
      }
      return { message: "Členům vytvoří odkaz vlastník. Pro vlastnický účet odešleme odkaz, pokud e-mail odpovídá.", manual: true };
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(parsed.data.email) as UserRecord | undefined;
    if (user) {
      const token = newVerificationToken();
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const link = `${config.appOrigin}/reset-password.html?token=${encodeURIComponent(token)}`;
      const create = db.transaction(() => {
        db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
        db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), user.id, expires);
        db.prepare("INSERT INTO mail_outbox (recipient, subject, body) VALUES (?, ?, ?)").run(user.email, "Obnova hesla OCEAN", `Pro nastavení nového hesla použijte tento odkaz:\n\n${link}\n\nOdkaz platí 1 hodinu.`);
      });
      create();
    }
    return { message: "Pokud účet existuje, poslali jsme odkaz pro obnovu hesla." };
  });

  app.post("/api/auth/recovery/confirm", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = recoveryConfirmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Odkaz nebo heslo nejsou platné." });
    const tokenHash = hashToken(parsed.data.token);
    const record = db.prepare(`SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > datetime('now')`)
      .get(tokenHash) as { user_id: string } | undefined;
    if (!record) return reply.code(400).send({ error: "Odkaz je neplatný nebo vypršel." });

    const passwordHash = await hashPassword(parsed.data.password);
    const meta = requestMeta(request);
    const reset = db.transaction(() => {
      const consumed = db.prepare(`DELETE FROM password_reset_tokens
        WHERE token_hash = ? AND user_id = ? AND expires_at > datetime('now')`).run(tokenHash, record.user_id);
      if (consumed.changes !== 1) throw new Error("RESET_TOKEN_ALREADY_USED");
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(passwordHash, record.user_id);
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(record.user_id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(record.user_id);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'PASSWORD_RESET', ?, ?)").run(record.user_id, meta.ip, meta.agent);
    });
    try {
      reset();
    } catch (error) {
      if (error instanceof Error && error.message === "RESET_TOKEN_ALREADY_USED") {
        return reply.code(400).send({ error: "Odkaz je neplatný nebo už byl použit." });
      }
      throw error;
    }
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { message: "Heslo bylo změněno. Přihlaste se znovu." };
  });

  app.post("/api/account/password", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    const user = currentUser(db, request);
    if (!token || !user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Neplatné údaje." });
    if (!await verifyPassword(user.password_hash, parsed.data.currentPassword)) return reply.code(400).send({ error: "Současné heslo není správné." });
    const passwordHash = await hashPassword(parsed.data.newPassword);
    const sessionHash = hashToken(token);
    const meta = requestMeta(request);
    const change = db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(passwordHash, user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(user.id, sessionHash);
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'PASSWORD_CHANGED', ?, ?)").run(user.id, meta.ip, meta.agent);
    });
    change();
    return { message: "Heslo bylo změněno." };
  });

  app.post("/api/auth/verification/resend", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (config.manualApprovalEnabled) return reply.code(409).send({ error: "Přístup k účtu schvaluje vlastník Oceanu." });
    if (user.email_verified_at) return { message: "E-mail už je ověřený." };
    issueVerification(db, user, config);
    return { message: "Nový ověřovací e-mail byl odeslán." };
  });

  app.post("/api/auth/verification/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const token = typeof request.body === "object" && request.body !== null && "token" in request.body ? (request.body as { token?: unknown }).token : undefined;
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return reply.code(400).send({ error: "Ověřovací odkaz není platný." });
    const record = db.prepare(`
      SELECT user_id FROM email_verification_tokens
      WHERE token_hash = ? AND expires_at > datetime('now')
    `).get(hashToken(token)) as { user_id: string } | undefined;
    if (!record) return reply.code(400).send({ error: "Ověřovací odkaz je neplatný nebo vypršel." });

    const meta = requestMeta(request);
    const confirm = db.transaction(() => {
      db.prepare("UPDATE users SET email_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND email_verified_at IS NULL").run(record.user_id);
      db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(record.user_id);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'EMAIL_VERIFIED', ?, ?)").run(record.user_id, meta.ip, meta.agent);
    });
    confirm();
    return { message: "E-mail byl úspěšně ověřen." };
  });

  app.get("/api/dev/mailbox", async (_request, reply) => {
    if (config.isProduction) return reply.code(404).send({ error: "Nenalezeno." });
    const messages = db.prepare("SELECT id, recipient, subject, body, created_at AS createdAt FROM mail_outbox ORDER BY id DESC LIMIT 20").all();
    return { messages };
  });

  app.get("/api/me", async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    const user = currentUser(db, request);
    if (!user) {
      reply.clearCookie(COOKIE_NAME, { path: "/" });
      return reply.code(401).send({ error: "Relace vypršela." });
    }
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id_hash = ?").run(hashToken(token!));
    return { user: publicUser(user, approvalMode(config)) };
  });
}
