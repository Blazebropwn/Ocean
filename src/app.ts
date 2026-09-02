import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { join } from "node:path";
import type { Config } from "./config.js";
import { openDatabase, publicUser, type KryptotronInstanceRecord, type UserRecord, type OceanDatabase } from "./db.js";
import { binanceConnectionSchema, changePasswordSchema, dcaAmountSchema, dcaControlSchema, invitationCreateSchema, kryptotronControlSchema, loginSchema, recoveryConfirmSchema, recoveryRequestSchema, registerSchema, streakControlSchema } from "./schemas.js";
import { DUMMY_PASSWORD_HASH, hashPassword, hashToken, newInvitationId, newSessionToken, newUserId, newVerificationToken, SESSION_TTL_SECONDS, verifyPassword } from "./security.js";
import { initializeKryptotronInstance, loadKryptotronSnapshot, setDcaAmount, setDcaEnabled, setKryptotronEntriesPaused, setStreakEnabled } from "./kryptotron.js";
import { verifyBinanceCredentials } from "./binance.js";
import { credentialsKey, encryptCredential } from "./credentials.js";

const COOKIE_NAME = "zero_session";

function requestMeta(request: FastifyRequest) {
  return {
    ip: request.ip,
    agent: request.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}

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

function isAllowedOrigin(origin: string, config: Config) {
  if (origin === config.appOrigin) return true;
  if (config.isProduction) return false;
  try {
    const candidate = new URL(origin);
    const configured = new URL(config.appOrigin);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return candidate.protocol === configured.protocol
      && candidate.port === configured.port
      && loopbackHosts.has(candidate.hostname)
      && loopbackHosts.has(configured.hostname);
  } catch {
    return false;
  }
}

function currentUser(db: OceanDatabase, request: FastifyRequest) {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return undefined;
  return db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > datetime('now')
  `).get(hashToken(token)) as UserRecord | undefined;
}

function kryptotronInstance(db: OceanDatabase, userId: string) {
  return db.prepare("SELECT * FROM kryptotron_instances WHERE user_id = ?").get(userId) as KryptotronInstanceRecord | undefined;
}

function connectedKryptotronInstance(db: OceanDatabase, userId: string) {
  const instance = kryptotronInstance(db, userId);
  return instance?.status === "connected" && instance.remote_state_key ? instance : undefined;
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

export function buildApp(config: Config, database?: OceanDatabase) {
  const db = database ?? openDatabase(config.databasePath);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: config.isProduction ? 1 : false });

  app.register(cookie);
  app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", "data:"] } } });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(staticFiles, { root: join(process.cwd(), "public"), prefix: "/" });

  app.addHook("onRequest", async (request, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin, config)) return reply.code(403).send({ error: "Požadavek byl odmítnut." });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/auth/register", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Neplatné údaje." });

    const { email, username, password, inviteToken } = parsed.data;
    const exists = db.prepare("SELECT 1 FROM users WHERE email = ? OR username = ?").get(email, username);
    if (exists) return reply.code(409).send({ error: "Účet s tímto e-mailem nebo uživatelským jménem již existuje." });

    const userId = newUserId();
    const passwordHash = await hashPassword(password);
    try {
      const register = db.transaction(() => {
        const count = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
        let role: "owner" | "member" = "owner";
        let invitationId: string | null = null;
        if (count > 0) {
          if (!inviteToken) throw new Error("INVITATION_REQUIRED");
          const invitation = db.prepare(`SELECT id, email FROM invitations WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')`)
            .get(hashToken(inviteToken)) as { id: string; email: string | null } | undefined;
          if (!invitation || (invitation.email && invitation.email.toLowerCase() !== email)) throw new Error("INVITATION_REQUIRED");
          role = "member";
          invitationId = invitation.id;
        }
        db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)").run(userId, email, username, passwordHash, role);
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
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") return reply.code(409).send({ error: "Účet s tímto e-mailem nebo uživatelským jménem již existuje." });
      throw error;
    }
    const meta = requestMeta(request);
    db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'ACCOUNT_CREATED', ?, ?)").run(userId, meta.ip, meta.agent);
    const token = createSession(db, userId, request);
    setSessionCookie(reply, token, config);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRecord;
    issueVerification(db, user, config);
    return reply.code(201).send({ user: publicUser(user) });
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
    return { user: publicUser(user) };
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
    const record = db.prepare(`SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > datetime('now')`)
      .get(hashToken(parsed.data.token)) as { user_id: string } | undefined;
    if (!record) return reply.code(400).send({ error: "Odkaz je neplatný nebo vypršel." });

    const passwordHash = await hashPassword(parsed.data.password);
    const meta = requestMeta(request);
    const reset = db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(passwordHash, record.user_id);
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(record.user_id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(record.user_id);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'PASSWORD_RESET', ?, ?)").run(record.user_id, meta.ip, meta.agent);
    });
    reset();
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
    return { user: publicUser(user) };
  });

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
    if (!user.email_verified_at) return reply.code(403).send({ error: "Nejprve ověřte svůj e-mail." });
    const parsed = invitationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Neplatné údaje." });
    const token = newVerificationToken();
    const id = newInvitationId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const inviteUrl = `${config.appOrigin}/?invite=${encodeURIComponent(token)}`;
    db.prepare("INSERT INTO invitations (id, token_hash, email, created_by, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, hashToken(token), parsed.data.email, user.id, expiresAt);
    if (parsed.data.email) {
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

  app.get("/api/kryptotron/connection", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = kryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Profil Kryptotrona nebyl nalezen." });
    return {
      connection: {
        status: instance.status,
        environment: instance.environment,
        configured: instance.status !== "unconfigured" && instance.status !== "error",
        legacy: instance.remote_state_key === "main",
      },
    };
  });

  app.post("/api/kryptotron/connection", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (!user.email_verified_at) return reply.code(403).send({ error: "Nejprve ověřte svůj e-mail." });
    const instance = kryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Profil Kryptotrona nebyl nalezen." });
    if (instance.status === "connected" || instance.status === "provisioning") return reply.code(409).send({ error: "Kryptotron už je připojený nebo čeká na spuštění." });
    const parsed = binanceConnectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Zkontrolujte Binance údaje a potvrzení bezpečnosti." });

    let encryptionKey: Buffer;
    try {
      encryptionKey = credentialsKey(config.credentialsEncryptionKey);
    } catch {
      return reply.code(503).send({ error: "Bezpečné ukládání klíčů zatím není nastavené." });
    }

    try {
      const verification = await verifyBinanceCredentials(parsed.data.apiKey, parsed.data.apiSecret, parsed.data.environment);
      if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) {
        return reply.code(503).send({ error: "Úložiště Kryptotronu zatím není dostupné." });
      }
      const remoteStateKey = instance.id;
      try {
        await initializeKryptotronInstance(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, remoteStateKey, parsed.data.environment);
      } catch {
        return reply.code(503).send({ error: "Oddělenou instanci teď nelze připravit. Zkuste to prosím později." });
      }
      const context = `${user.id}:${instance.id}`;
      const encryptedApiKey = encryptCredential(parsed.data.apiKey, encryptionKey, `${context}:api-key`);
      const encryptedSecret = encryptCredential(parsed.data.apiSecret, encryptionKey, `${context}:api-secret`);
      const save = db.transaction(() => {
        db.prepare(`
          INSERT INTO kryptotron_credentials (
            instance_id, api_key_ciphertext, api_key_iv, api_key_tag,
            api_secret_ciphertext, api_secret_iv, api_secret_tag, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(instance_id) DO UPDATE SET
            api_key_ciphertext = excluded.api_key_ciphertext, api_key_iv = excluded.api_key_iv, api_key_tag = excluded.api_key_tag,
            api_secret_ciphertext = excluded.api_secret_ciphertext, api_secret_iv = excluded.api_secret_iv, api_secret_tag = excluded.api_secret_tag,
            verified_at = datetime('now'), updated_at = datetime('now')
        `).run(instance.id, encryptedApiKey.ciphertext, encryptedApiKey.iv, encryptedApiKey.tag, encryptedSecret.ciphertext, encryptedSecret.iv, encryptedSecret.tag);
        db.prepare("UPDATE kryptotron_instances SET remote_state_key = ?, status = 'provisioning', environment = ?, updated_at = datetime('now') WHERE id = ?")
          .run(remoteStateKey, parsed.data.environment, instance.id);
        const meta = requestMeta(request);
        db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'BINANCE_CONNECTED', ?, ?)")
          .run(user.id, meta.ip, meta.agent);
      });
      save();
      return reply.code(201).send({ connection: { status: "provisioning", environment: parsed.data.environment, configured: true }, verification });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Binance připojení se nepodařilo ověřit.";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/kryptotron", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      return { kryptotron: await loadKryptotronSnapshot(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instance.remote_state_key!) };
    } catch {
      return reply.code(502).send({ error: "Stav Kryptotronu se nepodařilo načíst." });
    }
  });

  app.post("/api/kryptotron/control", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    const parsed = kryptotronControlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatný požadavek." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      await setKryptotronEntriesPaused(
        config.kryptotronSupabaseUrl,
        config.kryptotronSupabaseKey,
        parsed.data.entriesPaused,
        instance.remote_state_key!,
      );
      const meta = requestMeta(request);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?)")
        .run(user.id, parsed.data.entriesPaused ? "KRYPTOTRON_PAUSED" : "KRYPTOTRON_RESUMED", meta.ip, meta.agent);
      return { entriesPaused: parsed.data.entriesPaused };
    } catch {
      return reply.code(502).send({ error: "Ovládání Kryptotronu se nepodařilo uložit." });
    }
  });

  app.post("/api/kryptotron/dca/control", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    const parsed = dcaControlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatný požadavek." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      await setDcaEnabled(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, parsed.data.enabled, instance.remote_state_key!);
      const meta = requestMeta(request);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?)")
        .run(user.id, parsed.data.enabled ? "DCA_ENABLED" : "DCA_DISABLED", meta.ip, meta.agent);
      return { enabled: parsed.data.enabled };
    } catch {
      return reply.code(502).send({ error: "Nastavení DCA se nepodařilo uložit." });
    }
  });

  app.post("/api/kryptotron/dca/amount", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    const parsed = dcaAmountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatný DCA preset." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      await setDcaAmount(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, parsed.data.amount, instance.remote_state_key!);
      const meta = requestMeta(request);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?)")
        .run(user.id, `DCA_AMOUNT_${parsed.data.amount}`, meta.ip, meta.agent);
      return { amount: parsed.data.amount };
    } catch {
      return reply.code(502).send({ error: "DCA preset se nepodařilo uložit." });
    }
  });

  app.post("/api/kryptotron/streak/control", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(db, user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    const parsed = streakControlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatný požadavek." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      await setStreakEnabled(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, parsed.data.enabled, instance.remote_state_key!);
      const meta = requestMeta(request);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?)")
        .run(user.id, parsed.data.enabled ? "STREAK_ENABLED" : "STREAK_DISABLED", meta.ip, meta.agent);
      return { enabled: parsed.data.enabled };
    } catch {
      return reply.code(502).send({ error: "Nastavení Streak Governoru se nepodařilo uložit." });
    }
  });

  app.addHook("onClose", async () => db.close());
  return app;
}
