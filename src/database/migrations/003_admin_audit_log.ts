import type { DatabaseMigration } from "../migrate.js";

export const adminAuditLog: DatabaseMigration = {
  version: 3,
  name: "admin_audit_log",
  up(db) {
    db.exec(`
      CREATE TABLE admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        subject_user_id TEXT,
        subject_username TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(details_json)),
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX admin_audit_log_created_at ON admin_audit_log(created_at DESC);
      CREATE INDEX admin_audit_log_actor ON admin_audit_log(actor_user_id, created_at DESC);
    `);
  },
};
