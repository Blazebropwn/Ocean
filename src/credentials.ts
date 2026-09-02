import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
};

export function credentialsKey(value?: string) {
  if (!value) throw new Error("OCEAN_CREDENTIALS_KEY není nastaven.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("OCEAN_CREDENTIALS_KEY musí být 32 bytů v base64.");
  return key;
}

export function encryptCredential(value: string, key: Buffer, context: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptCredential(value: EncryptedValue, key: Buffer, context: string) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
