import { createHmac, timingSafeEqual } from "node:crypto";

export function workerAccessToken(encryptionKey: Buffer, instanceId: string) {
  return createHmac("sha256", encryptionKey).update(`ocean-worker:${instanceId}`).digest("base64url");
}

export function validWorkerAccessToken(candidate: string, encryptionKey: Buffer, instanceId: string) {
  const expected = workerAccessToken(encryptionKey, instanceId);
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
