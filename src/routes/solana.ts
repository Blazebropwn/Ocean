import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { currentUser } from "./shared.js";
import { hasSolanaPilotAccess, SolanaPaperEngine } from "../solana/engine.js";
import { PublicSolanaMarketProvider } from "../solana/providers.js";
import { PaperBusyError } from "../solana/store.js";
import type { SolanaMarketProvider } from "../solana/types.js";
import { SolanaPaperAutomation, type SolanaAutomationOptions } from "../solana/automation.js";

export function registerSolanaRoutes(app: FastifyInstance, db: OceanDatabase, config: Config, provider?: SolanaMarketProvider, options: SolanaAutomationOptions = {}) {
  const engine = new SolanaPaperEngine(db, provider ?? new PublicSolanaMarketProvider({ jupiterApiKey: config.solanaJupiterApiKey }), options.now);
  const automation = new SolanaPaperAutomation(engine, config, options);
  app.addHook("onReady", async () => automation.start());
  function owner(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    const user = currentUser(db, request);
    if (!user) { reply.code(401).send({ error: "Nejste přihlášeni." }); return undefined; }
    if (!hasSolanaPilotAccess(user, config)) { reply.code(404).send({ error: "Terminál není pro tento účet dostupný." }); return undefined; }
    return user;
  }

  app.get("/api/solana", async (request, reply) => {
    const user = owner(request, reply);
    if (!user) return;
    return automation.snapshot(user.id);
  });

  app.get("/api/solana/live", async (request, reply) => {
    const user = owner(request, reply);
    if (!user) return;
    return automation.snapshot(user.id, true);
  });

  app.post("/api/solana/automation", async (request, reply) => {
    const user = owner(request, reply);
    if (!user) return;
    if (request.body === null || Array.isArray(request.body) || typeof request.body !== "object" || Object.keys(request.body).length !== 1 || typeof (request.body as { enabled?: unknown }).enabled !== "boolean") {
      return reply.code(400).send({ error: "Automat přijímá pouze parametr enabled typu boolean." });
    }
    return automation.setEnabled(user.id, (request.body as { enabled: boolean }).enabled);
  });

  async function run(request: FastifyRequest, reply: FastifyReply, positionId?: string) {
    const user = owner(request, reply);
    if (!user) return;
    const authorize = () => hasSolanaPilotAccess(currentUser(db, request), config);
    if (request.body !== undefined && (request.body === null || Array.isArray(request.body) || typeof request.body !== "object" || Object.keys(request.body).length !== 0)) return reply.code(400).send({ error: "PAPER cyklus nepřijímá obchodní parametry." });
    try {
      return await automation.runManual(user.id, authorize, positionId);
    } catch (error) {
      if (!authorize()) return reply.code(403).send({ error: "Přístup k terminálu už není platný." });
      if (error instanceof PaperBusyError) {
        reply.header("retry-after", Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)));
        return reply.code(error.reason === "running" ? 409 : 429).send({ error: error.reason === "running" ? "PAPER cyklus už běží." : "Mezi PAPER cykly musí uplynout alespoň 60 sekund.", retryAt: new Date(error.retryAt).toISOString() });
      }
      return reply.code(422).send({ error: error instanceof Error ? error.message : "PAPER cyklus se nepodařilo dokončit.", snapshot: automation.snapshot(user.id) });
    }
  }

  app.post("/api/solana/cycle", async (request, reply) => run(request, reply));
  app.post<{ Params: { id: string } }>("/api/solana/positions/:id/close", async (request, reply) => {
    const user = owner(request, reply);
    if (!user) return;
    if (!/^solp_[a-f0-9]{32}$/.test(request.params.id)) return reply.code(400).send({ error: "Neplatná PAPER pozice." });
    if (!engine.store.positions(user.id).some((position) => position.id === request.params.id)) return reply.code(404).send({ error: "Otevřená PAPER pozice nebyla nalezena." });
    return run(request, reply, request.params.id);
  });
  return automation;
}
