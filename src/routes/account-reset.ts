import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { currentUser, hasApprovedAccess } from "./shared.js";
import { loadKryptotronState } from "../kryptotron.js";
import { resetView } from "../account-reset.js";
import { requestAccountReset } from "../account-reset-service.js";

export function registerAccountResetRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  function target(request: FastifyRequest) {
    const owner = currentUser(db, request);
    if (!owner || owner.role !== "owner" || !hasApprovedAccess(owner, config)) return null;
    const { id } = request.params as { id: string };
    const instance = db.prepare(`SELECT i.id, i.remote_state_key, u.username FROM kryptotron_instances i
      JOIN users u ON u.id=i.user_id WHERE u.id=? AND u.role='member'`).get(id) as { id: string; remote_state_key: string; username: string } | undefined;
    if (!instance || instance.remote_state_key !== instance.id) return null;
    return { owner, instance, memberId: id };
  }
  app.get("/api/members/:id/account-reset", async (request, reply) => {
    const found = target(request);
    if (!found) return reply.code(403).send({ error: "Přístup má pouze schválený správce k připojenému členovi." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Úložiště není dostupné." });
    try {
      const state = await loadKryptotronState(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, found.instance.id);
      if (!state) return reply.code(409).send({ error: "Stav účtu není dostupný." });
      return { reset: resetView(state), instanceId: found.instance.id,
        archives: db.prepare("SELECT id,created_at AS createdAt FROM account_reset_archives WHERE instance_id=? ORDER BY created_at DESC").all(found.instance.id) };
    } catch { return reply.code(502).send({ error: "Stav resetu se nepodařilo načíst." }); }
  });
  app.get("/api/members/:id/account-reset/archives/:archiveId", async (request, reply) => {
    const found = target(request);
    if (!found) return reply.code(403).send({ error: "Přístup odepřen." });
    const { archiveId } = request.params as { archiveId: string };
    const archive = db.prepare("SELECT state_json FROM account_reset_archives WHERE id=? AND instance_id=?").get(archiveId, found.instance.id) as { state_json: string } | undefined;
    if (!archive) return reply.code(404).send({ error: "Archiv neexistuje." });
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", 'attachment; filename="ocean-account-archive.json"');
    return reply.type("application/json").send(archive.state_json);
  });
  app.post("/api/members/:id/account-reset", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const found = target(request);
    if (!found || request.headers.origin !== config.appOrigin) return reply.code(403).send({ error: "Přístup odepřen nebo neplatný původ požadavku." });
    const parsed = z.object({ confirmation: z.string(), requestId: z.string().uuid(), instanceId: z.string(), epoch: z.string().nullable() }).strict().safeParse(request.body);
    if (!parsed.success || parsed.data.confirmation !== found.instance.username || parsed.data.instanceId !== found.instance.id) return reply.code(400).send({ error: "Potvrď aktuální účet přesným uživatelským jménem." });
    if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return reply.code(503).send({ error: "Úložiště není dostupné." });
    try {
      db.prepare("INSERT INTO admin_audit_log (actor_user_id,action,subject_user_id,subject_username,details_json) VALUES (?,'ACCOUNT_RESET_REQUESTED',?,?,?)")
        .run(found.owner.id, found.memberId, found.instance.username, JSON.stringify({ requestId: parsed.data.requestId, instanceId: found.instance.id }));
      const reset = await requestAccountReset(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, found.instance.id, found.owner.id, parsed.data.requestId, parsed.data.epoch);
      return reply.code(202).send({ reset });
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Reset nebyl potvrzen." }); }
  });
}
