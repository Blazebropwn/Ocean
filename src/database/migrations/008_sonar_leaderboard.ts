import type { DatabaseMigration } from '../migrate.js';

export const sonarLeaderboard: DatabaseMigration = {
  version: 8,
  name: 'sonar_leaderboard',
  up(db) {
    db.exec(`
      CREATE TABLE sonar_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        rounds_json TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0,1)),
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0)
      );
      CREATE UNIQUE INDEX sonar_active_user ON sonar_runs(user_id) WHERE finished=0;
      CREATE INDEX sonar_run_age ON sonar_runs(started_at_ms);
      CREATE TABLE sonar_records (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        score INTEGER NOT NULL CHECK (score > 0),
        hits INTEGER NOT NULL,
        perfects INTEGER NOT NULL,
        achieved_at_ms INTEGER NOT NULL
      );
      CREATE INDEX sonar_ranking ON sonar_records(score DESC, achieved_at_ms ASC, user_id ASC);
    `);
  },
};
