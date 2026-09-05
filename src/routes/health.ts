import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { readinessIssues } from "../readiness.js";

export function registerHealthRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/ready", async (_request, reply) => {
    const issues = readinessIssues(config, db);
    return reply.code(issues.length ? 503 : 200).send({ ok: issues.length === 0, issues: issues.length });
  });
}
