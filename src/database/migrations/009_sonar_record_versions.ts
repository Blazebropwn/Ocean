import type { DatabaseMigration } from '../migrate.js';

export const sonarRecordVersions: DatabaseMigration = {
  version: 9,
  name: 'sonar_record_versions',
  up(db) {
    db.exec(`
      CREATE TABLE sonar_records_versioned (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        score INTEGER NOT NULL CHECK (score > 0),
        hits INTEGER NOT NULL,
        perfects INTEGER NOT NULL,
        achieved_at_ms INTEGER NOT NULL,
        PRIMARY KEY (user_id, version)
      );
      INSERT INTO sonar_records_versioned
        SELECT user_id, 'sonar-v2', score, hits, perfects, achieved_at_ms FROM sonar_records;
      DROP TABLE sonar_records;
      ALTER TABLE sonar_records_versioned RENAME TO sonar_records;
      CREATE INDEX sonar_ranking ON sonar_records(version, score DESC, achieved_at_ms ASC, user_id ASC);
    `);
  },
};
