import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { currentUser, hasApprovedAccess } from "./shared.js";
import { genesisIdentity, normalizeCode, redeemGenesis } from "../genesis/service.js";
import { genesisOverview } from "../genesis/admin.js";
import { EconomyError, tideBalance, tideHistory } from "../tide/ledger.js";
import { BET, GAME_VERSION, PAYOUTS, REELS } from "../slot/math.js";
import { spinSlot } from "../slot/service.js";

const redeemSchema = z.object({ code: z.string().max(40).transform(normalizeCode).pipe(z.string().regex(/^(?:[A-Z2-9]{12}|OCN[A-Z2-9]{20})$/)) }).strict();
const spinSchema = z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/) }).strict();
const ledgerQuery = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict();

export function registerEconomyRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  let ipLimiter: ReturnType<FastifyInstance["createRateLimit"]> | undefined;
  let userLimiter: ReturnType<FastifyInstance["createRateLimit"]> | undefined;
  app.get("/api/admin/genesis", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (user.role !== "owner" || !hasApprovedAccess(user, config)) return reply.code(403).send({ error: "Přístup má pouze schválený vlastník." });
    const parsed = z.object({ wave: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatná emise." });
    return genesisOverview(db, parsed.data.wave);
  });
  app.get("/api/tide", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    return { balance: tideBalance(db, user.id), genesis: genesisIdentity(db, user.id) ?? null };
  });
  app.get("/api/tide/ledger", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const parsed = ledgerQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Neplatná stránka ledgeru." });
    return tideHistory(db, user.id, parsed.data.before ?? Number.MAX_SAFE_INTEGER);
  });
  app.get("/api/slot", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!currentUser(db, request)) return reply.code(401).send({ error: "Nejste přihlášeni." });
    return { gameVersion: GAME_VERSION, bet: BET, reels: REELS, payouts: PAYOUTS };
  });
  for (const kind of ["redeem", "spin"] as const) {
    app.post(kind === "redeem" ? "/api/genesis/redeem" : "/api/slot/spins", {
      bodyLimit: 1024,
      config: { rateLimit: { max: kind === "redeem" ? 10 : 30, timeWindow: "1 minute" } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (kind === "redeem") {
        ipLimiter ??= app.createRateLimit({ max: 10, timeWindow: "1 minute", keyGenerator: req => `genesis-ip:${req.ip}` });
        const limit = await ipLimiter(request);
        if (!limit.isAllowed && limit.isExceeded) return reply.header("Retry-After", limit.ttlInSeconds).code(429).send({ error: "Příliš mnoho pokusů. Zkus to za minutu." });
      }
      const user = currentUser(db, request);
      if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
      if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: "Účet ještě nebyl schválen." });
      try {
        if (kind === "redeem") {
          userLimiter ??= app.createRateLimit({ max: 10, timeWindow: "1 minute", keyGenerator: req => `genesis-user:${currentUser(db, req)!.id}` });
          const limit = await userLimiter(request);
          if (!limit.isAllowed && limit.isExceeded) return reply.header("Retry-After", limit.ttlInSeconds).code(429).send({ error: "Příliš mnoho pokusů. Zkus to za minutu." });
          const input = redeemSchema.safeParse(request.body);
          if (!input.success) return reply.code(400).send({ error: "Invalid code", code: "INVALID_CODE" });
          const result = redeemGenesis(db, user.id, input.data.code, config.genesisCodeHmacKey);
          return reply.code(result.replayed ? 200 : 201).send(result);
        }
        const input = spinSchema.safeParse(request.body);
        if (!input.success) return reply.code(400).send({ error: "Neplatný požadavek spinu." });
        const result = spinSlot(db, user.id, input.data.idempotencyKey);
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        if (error instanceof EconomyError) return reply.code(error.status).send({ error: error.message, code: error.code });
        throw error;
      }
    });
  }
}
