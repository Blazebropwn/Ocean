import type { DatabaseMigration } from "../migrate.js";

export const workerNotifications: DatabaseMigration = {
  version: 4,
  name: "worker_notifications",
  up(db) {
    db.exec(`
      CREATE TABLE worker_notifications (
        instance_id TEXT NOT NULL REFERENCES kryptotron_instances(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        message TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (instance_id, id)
      );
      CREATE INDEX worker_notifications_pending ON worker_notifications(sent_at, next_attempt_at);
      CREATE TABLE telegram_confirmations (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('dca_on', 'streak_on')),
        expires_at TEXT NOT NULL
      );
    `);
  },
};
