import type { FastifyInstance } from "fastify";
import type { OceanDatabase } from "../db.js";
import { AgentRepository } from "../agents/repository.js";
import { currentUser } from "./shared.js";

const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;

export function registerAgentRoutes(app: FastifyInstance, db: OceanDatabase) {
  const repository = new AgentRepository(db);

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
