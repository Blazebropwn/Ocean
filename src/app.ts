import Fastify, { type RawServerDefault } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { join } from "node:path";
import type { Config } from "./config.js";
import { openDatabase, type OceanDatabase } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInternalWorkerRoutes } from "./routes/internal-worker.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerKryptotronRoutes } from "./routes/kryptotron.js";
import { registerMemberRoutes } from "./routes/members.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { buildVersionedPages } from "./asset-versioning.js";

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

export function buildApp(config: Config, database?: OceanDatabase) {
  const db = database ?? openDatabase(config.databasePath);
  const trustProxy = config.trustedProxies?.length ? config.trustedProxies : false;
  const app = Fastify<RawServerDefault>({ logger: process.env.NODE_ENV !== "test", trustProxy });

  const publicRoot = join(process.cwd(), "public");
  app.register(cookie);
  app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", "data:"] } } });
  app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.register(staticFiles, { root: publicRoot, prefix: "/", index: false });

  for (const page of buildVersionedPages(publicRoot)) {
    for (const route of page.routes) {
      app.get(route, (_request, reply) => reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache").send(page.html));
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin, config)) return reply.code(403).send({ error: "Požadavek byl odmítnut." });
  });

  registerHealthRoutes(app, db, config);
  registerInternalWorkerRoutes(app, db, config);
  registerAuthRoutes(app, db, config);
  registerInvitationRoutes(app, db, config);
  registerMemberRoutes(app, db, config);
  registerTelegramRoutes(app, db, config);
  registerKryptotronRoutes(app, db, config);

  app.addHook("onClose", async () => db.close());
  return app;
}
