import type { DatabaseMigration } from "../migrate.js";

export const accountSuspension: DatabaseMigration = {
  version: 7,
  name: "account_suspension",
  up(db) {
    db.exec(`ALTER TABLE users ADD COLUMN suspended_at TEXT;
      ALTER TABLE users ADD COLUMN suspended_by TEXT REFERENCES users(id) ON DELETE SET NULL;`);
  },
};
