import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { credentialsKey } from "../credentials.js";
import { validWorkerAccessToken } from "../worker-auth.js";
import { loadKryptotronState, logKryptotronTrade, saveKryptotronState } from "../kryptotron.js";

export function registerInternalWorkerRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  function internalWorker(request: FastifyRequest) {
    const instanceId = request.headers["x-ocean-instance"];
    const authorization = request.headers.authorization;
    if (typeof instanceId !== "string" || !/^kry_[a-f0-9]{32}$/.test(instanceId) || !authorization?.startsWith("Bearer ")) return null;
    const instance = db.prepare("SELECT id FROM kryptotron_instances WHERE id = ? AND remote_state_key = id AND environment = 'testnet' AND status IN ('provisioning', 'connected')").get(instanceId);
    if (!instance) return null;
    try {
      const key = credentialsKey(config.credentialsEncryptionKey);
      return validWorkerAccessToken(authorization.slice(7), key, instanceId) ? instanceId : null;
    } catch { return null; }
  }

  app.get("/internal/kryptotron/state", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    const instanceId = internalWorker(request);
    if (!instanceId) return reply.code(401).send({ error: "Unauthorized" });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Unavailable" });
    const state = await loadKryptotronState(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instanceId);
    return state ? { state } : reply.code(404).send({ error: "Not found" });
  });

  app.put("/internal/kryptotron/state", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    const instanceId = internalWorker(request);
    if (!instanceId) return reply.code(401).send({ error: "Unauthorized" });
    const body = request.body as { state?: unknown } | null;
    if (!body?.state || typeof body.state !== "object" || Array.isArray(body.state)) return reply.code(400).send({ error: "Invalid state" });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Unavailable" });
    await saveKryptotronState(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instanceId, body.state as Record<string, unknown>);
    return reply.code(204).send();
  });

  app.post("/internal/kryptotron/trades", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const instanceId = internalWorker(request);
    if (!instanceId) return reply.code(401).send({ error: "Unauthorized" });
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "Invalid trade" });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Unavailable" });
    await logKryptotronTrade(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instanceId, body as Record<string, unknown>);
    return reply.code(204).send();
  });
}
