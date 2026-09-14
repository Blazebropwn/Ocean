import Database from "better-sqlite3";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { migrateDatabase } from "./database/migrate.js";
import { databaseMigrations } from "./database/migrations/index.js";

export type UserRecord = {
  id: string;
  public_id: number;
  email: string;
  username: string;
  password_hash: string;
  role: "owner" | "member";
  email_verified_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
};

export type PublicUser = {
  id: string;
  displayId: string;
  email: string | null;
  username: string;
  emailVerified: boolean;
  approved: boolean;
  accessApproved: boolean;
  approvalMode: "owner" | "email";
  role: "owner" | "member";
  createdAt: string;
};

export type KryptotronInstanceRecord = {
  id: string;
  user_id: string;
  remote_state_key: string | null;
  status: "unconfigured" | "provisioning" | "connected" | "suspended" | "error";
  environment: "testnet" | "mainnet";
  created_at: string;
  updated_at: string;
};

export function publicUser(user: UserRecord, approvalMode: "owner" | "email" = "email"): PublicUser {
  const email = user.email.endsWith("@users.ocean.invalid") ? null : user.email;
  return {
    id: user.id,
    displayId: `OCEAN-${String(user.public_id).padStart(6, "0")}`,
    email,
    username: user.username,
    emailVerified: Boolean(user.email_verified_at),
    approved: Boolean(user.approved_at),
    accessApproved: approvalMode === "owner" ? Boolean(user.approved_at) : Boolean(user.email_verified_at),
    approvalMode,
    role: user.role,
    createdAt: user.created_at,
  };
}

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
  migrateDatabase(db, databaseMigrations);
  return db;
}

export type OceanDatabase = ReturnType<typeof openDatabase>;
