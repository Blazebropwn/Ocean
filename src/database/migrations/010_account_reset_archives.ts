import type { DatabaseMigration } from "../migrate.js";

export const accountResetArchives: DatabaseMigration = {
  version: 10,
  name: "account_reset_archives",
  up(db) {
    db.exec(`CREATE TABLE account_reset_archives (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE INDEX account_reset_instance ON account_reset_archives(instance_id, created_at);`);
  },
};
