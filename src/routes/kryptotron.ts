import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { type KryptotronInstanceRecord, type OceanDatabase } from "../db.js";
import { binanceConnectionSchema, dcaAmountSchema, dcaControlSchema, kryptotronControlSchema, streakControlSchema } from "../schemas.js";
import { verifyBinanceCredentials } from "../binance.js";
import { credentialsKey, encryptCredential } from "../credentials.js";
import { initializeKryptotronInstance, loadKryptotronSnapshot, requestTestDca, setDcaAmount, setDcaEnabled, setKryptotronEntriesPaused, setStreakEnabled } from "../kryptotron.js";
import { currentUser, hasApprovedAccess, requestMeta } from "./shared.js";

export function registerKryptotronRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  function kryptotronInstance(userId: string) {
    return db.prepare("SELECT * FROM kryptotron_instances WHERE user_id = ?").get(userId) as KryptotronInstanceRecord | undefined;
  }

  function connectedKryptotronInstance(userId: string) {
    const instance = kryptotronInstance(userId);
    return instance?.status === "connected" && instance.remote_state_key ? instance : undefined;
  }

  app.get("/api/kryptotron/connection", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = kryptotronInstance(user.id);
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
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: "Účet ještě nebyl schválen." });
    const instance = kryptotronInstance(user.id);
    if (!instance) return reply.code(404).send({ error: "Profil Kryptotrona nebyl nalezen." });
    if (instance.status === "connected" || instance.status === "provisioning") return reply.code(409).send({ error: "Kryptotron už je připojený nebo čeká na spuštění." });
    const parsed = binanceConnectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Zkontrolujte Binance údaje a potvrzení bezpečnosti." });
    if (parsed.data.environment !== "testnet") {
      return reply.code(403).send({ error: "Osobní Kryptotron je zatím dostupný pouze na Binance Testnetu." });
    }

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

  app.delete("/api/kryptotron/connection", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = kryptotronInstance(user.id);
    if (!instance) return reply.code(404).send({ error: "Profil Kryptotrona nebyl nalezen." });
    if (instance.remote_state_key === "main") {
      return reply.code(409).send({ error: "Hlavní Kryptotron nelze odpojit tímto způsobem." });
    }

    const meta = requestMeta(request);
    db.transaction(() => {
      db.prepare("DELETE FROM kryptotron_credentials WHERE instance_id = ?").run(instance.id);
      db.prepare(`UPDATE kryptotron_instances
        SET remote_state_key = NULL, status = 'unconfigured', environment = 'testnet', updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(instance.id, user.id);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'BINANCE_DISCONNECTED', ?, ?)")
        .run(user.id, meta.ip, meta.agent);
    })();
    return reply.code(204).send();
  });

  app.get("/api/kryptotron", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(user.id);
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
    const instance = connectedKryptotronInstance(user.id);
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
    const instance = connectedKryptotronInstance(user.id);
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
    const instance = connectedKryptotronInstance(user.id);
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

  app.post("/api/kryptotron/dca/test", { config: { rateLimit: { max: 2, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(user.id);
    if (!instance) return reply.code(404).send({ error: "Kryptotron není k tomuto účtu připojen." });
    if (instance.environment !== "testnet") return reply.code(403).send({ error: "Testovací nákup je dostupný pouze na Testnetu." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Kryptotron není dostupný." });
    try {
      const requestId = await requestTestDca(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instance.remote_state_key!);
      const meta = requestMeta(request);
      db.prepare("INSERT INTO security_events (user_id, event_type, ip_address, user_agent) VALUES (?, 'DCA_TEST_REQUESTED', ?, ?)")
        .run(user.id, meta.ip, meta.agent);
      return reply.code(202).send({ requestId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Testovací DCA se nepodařilo zařadit.";
      return reply.code(409).send({ error: message });
    }
  });

  app.post("/api/kryptotron/streak/control", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const instance = connectedKryptotronInstance(user.id);
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
}
