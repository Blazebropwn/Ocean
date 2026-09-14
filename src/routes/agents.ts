import type { FastifyInstance } from "fastify";
import type { OceanDatabase } from "../db.js";
import { AgentRepository } from "../agents/repository.js";
import { AgentRunError, PortfolioRiskAgentRunner } from "../agents/runner.js";
import { BinancePortfolioProvider } from "../portfolio/binance-provider.js";
import type { PortfolioProvider } from "../portfolio/provider.js";
import type { Config } from "../config.js";
import { currentUser, hasApprovedAccess } from "./shared.js";

const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;

export function registerAgentRoutes(
  app: FastifyInstance,
  db: OceanDatabase,
  config: Config,
  portfolioProvider: PortfolioProvider = new BinancePortfolioProvider(db, config.credentialsEncryptionKey),
) {
  const repository = new AgentRepository(db);
  const runner = new PortfolioRiskAgentRunner(repository, portfolioProvider);

  app.post("/api/agent/runs", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: "Účet ještě nebyl schválen." });

    const agent = repository.ensurePortfolioRiskAgent(user.id);
    if (repository.hasRunningRun(agent.id)) {
      return reply.code(409).send({ error: "Agent už jeden run zpracovává." });
    }
    try {
      const run = await runner.run(agent.id, "manual");
      return reply.code(201).send({ run });
    } catch (error) {
      if (error instanceof AgentRunError && error.runId) {
        return reply.code(422).send({ error: error.message, runId: error.runId });
      }
      throw error;
    }
  });

  app.get("/api/agent", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const agent = repository.getAgentCardForUser(user.id);
    if (!agent) return reply.code(404).send({ error: "Agent nebyl nalezen." });
    return { agent };
  });

  app.get("/api/agent/runs", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    return { runs: repository.listRunsForUser(user.id) };
  });

  app.get("/api/agent/runs/:runId", async (request, reply) => {
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: "Nejste přihlášeni." });
    const runId = (request.params as { runId?: unknown }).runId;
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      return reply.code(400).send({ error: "Neplatný run." });
    }
    const run = repository.getRunDetailForUser(user.id, runId);
    if (!run) return reply.code(404).send({ error: "Run nebyl nalezen." });
    return { run };
  });
}
