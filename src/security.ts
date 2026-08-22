import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$qem0YOSKHuU3h54uSNgy1A$z5ZMPPD7KQRAU492RTdFYYnn7KoOHl2hudCXekNbJ/I";

export function newUserId() {
  return `usr_${randomUUID().replaceAll("-", "")}`;
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function newVerificationToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
