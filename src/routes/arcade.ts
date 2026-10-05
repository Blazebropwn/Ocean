import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { OceanDatabase } from '../db.js';
import { currentUser, hasApprovedAccess } from './shared.js';
import { createSonarRounds, RUN_DURATION_MS, scoreSonarRun, SONAR_VERSION, type SonarRound } from '../arcade/sonar.js';

const finishSchema = z.object({ taps: z.array(z.number().finite().min(0).max(RUN_DURATION_MS)).max(256), durationMs: z.number().finite().min(0).max(RUN_DURATION_MS) }).strict();
export function registerArcadeRoutes(app: FastifyInstance, db: OceanDatabase, config: Config) {
  app.get('/api/arcade/sonar/leaderboard', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: 'Nejste přihlášeni.' });
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: 'Účet nemá přístup ke hře.' });
    const approval = config.manualApprovalEnabled ? 'u.approved_at' : 'u.email_verified_at';
    const leaders = db.prepare(`SELECT u.username, r.score FROM sonar_records r JOIN users u ON u.id=r.user_id
      WHERE r.version=? AND u.suspended_at IS NULL AND ${approval} IS NOT NULL
      ORDER BY r.score DESC, r.achieved_at_ms ASC, r.user_id ASC LIMIT 10`).all(SONAR_VERSION);
    return { version: SONAR_VERSION, leaders, personalBest: (db.prepare('SELECT score FROM sonar_records WHERE user_id=? AND version=?').get(user.id, SONAR_VERSION) as { score: number } | undefined)?.score ?? 0 };
  });
  app.post('/api/arcade/sonar/runs', { bodyLimit: 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: 'Nejste přihlášeni.' });
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: 'Účet nemá přístup ke hře.' });
    if (request.headers.origin !== config.appOrigin) return reply.code(403).send({ error: 'Neplatný původ požadavku.' });
    if ((request.body as { version?: string } | null)?.version !== SONAR_VERSION)
      return reply.code(409).send({ error: 'Hra byla aktualizována. Obnov stránku.' });
    const id = randomUUID(), rounds = createSonarRounds(), now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM sonar_runs WHERE started_at_ms < ?').run(now - 7 * 86_400_000);
      db.prepare('UPDATE sonar_runs SET finished=1 WHERE user_id=? AND finished=0').run(user.id);
      db.prepare('INSERT INTO sonar_runs (id,user_id,version,rounds_json,started_at_ms) VALUES (?,?,?,?,?)').run(id, user.id, SONAR_VERSION, JSON.stringify(rounds), now);
    })();
    return reply.code(201).send({ id, version: SONAR_VERSION, rounds, maxDurationMs: RUN_DURATION_MS });
  });
  app.post('/api/arcade/sonar/runs/:id/finish', { bodyLimit: 8192, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = currentUser(db, request);
    if (!user) return reply.code(401).send({ error: 'Nejste přihlášeni.' });
    if (!hasApprovedAccess(user, config)) return reply.code(403).send({ error: 'Účet nemá přístup ke hře.' });
    if (request.headers.origin !== config.appOrigin) return reply.code(403).send({ error: 'Neplatný původ požadavku.' });
    const input = finishSchema.safeParse(request.body), id = (request.params as { id: string }).id;
    if (!input.success || !z.uuid().safeParse(id).success) return reply.code(400).send({ error: 'Neplatný výsledek hry.' });
    const run = db.prepare('SELECT * FROM sonar_runs WHERE id=? AND user_id=?').get(id, user.id) as { finished: number; score: number; started_at_ms: number; rounds_json: string; version: string } | undefined;
    if (!run) return reply.code(404).send({ error: 'Pokus nebyl nalezen.' });
    if (run.finished) return { score: run.score, replayed: true };
    const age = Date.now() - run.started_at_ms;
    if (![SONAR_VERSION, 'sonar-v2'].includes(run.version) || age > RUN_DURATION_MS + 60_000 || input.data.durationMs > age + 1000)
      return reply.code(400).send({ error: 'Pokus vypršel nebo má neplatný čas.' });
    const result = scoreSonarRun(JSON.parse(run.rounds_json) as SonarRound[], input.data.taps, input.data.durationMs, run.version);
    if (!result) return reply.code(400).send({ error: 'Průběh hry není platný.' });
    db.transaction(() => {
      db.prepare('UPDATE sonar_runs SET finished=1, score=? WHERE id=?').run(result.score, id);
      if (result.score > 0) db.prepare(`INSERT INTO sonar_records (user_id,version,score,hits,perfects,achieved_at_ms) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,version) DO UPDATE SET score=excluded.score,hits=excluded.hits,perfects=excluded.perfects,achieved_at_ms=excluded.achieved_at_ms
        WHERE excluded.score > sonar_records.score`).run(user.id, run.version, result.score, result.hits, result.perfects, Date.now());
    })();
    return { ...result, replayed: false };
  });
}
