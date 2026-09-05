import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { hashToken } from "../security.js";
import type { OceanDatabase, UserRecord } from "../db.js";

export const COOKIE_NAME = "zero_session";

export function requestMeta(request: FastifyRequest) {
  return {
    ip: request.ip,
    agent: request.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}

export function currentUser(db: OceanDatabase, request: FastifyRequest) {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return undefined;
  return db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > datetime('now')
  `).get(hashToken(token)) as UserRecord | undefined;
}

export function approvalMode(config: Config): "owner" | "email" {
  return config.manualApprovalEnabled ? "owner" : "email";
}

export function hasApprovedAccess(user: UserRecord, config: Config) {
  return config.manualApprovalEnabled ? Boolean(user.approved_at) : Boolean(user.email_verified_at);
}
