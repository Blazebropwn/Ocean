import { credentialsKey, decryptCredential, encryptCredential, type EncryptedValue } from "./credentials.js";
import type { OceanDatabase } from "./db.js";

type CredentialRow = {
  instance_id: string;
  user_id: string;
  key_version: number;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_tag: string;
  api_secret_ciphertext: string;
  api_secret_iv: string;
  api_secret_tag: string;
};

export type RotationResult = {
  total: number;
  alreadyCurrent: number;
  migrated: string[];
  failed: Array<{ instanceId: string; error: string }>;
};

/**
 * Re-encrypts every stored Binance credential still readable only by the previous key so it
 * becomes readable by the current (primary) key, without ever requiring downtime: rows already
 * on the current key are left untouched, so this is safe to re-run if it was interrupted.
 *
 * Preconditions the caller must arrange: both OCEAN_CREDENTIALS_KEY (new) and
 * OCEAN_CREDENTIALS_KEY_PREVIOUS (old) set for this run only; the running server keeps decrypting
 * with both until every row is migrated and the previous key is removed from its own config.
 */
export function rotateCredentialsKey(db: OceanDatabase, currentKeyValue: string | undefined, previousKeyValue: string | undefined): RotationResult {
  const currentKey = credentialsKey(currentKeyValue);
  if (!previousKeyValue) throw new Error("OCEAN_CREDENTIALS_KEY_PREVIOUS není nastaven — není z čeho migrovat.");
  const previousKey = credentialsKey(previousKeyValue);
  if (previousKey.equals(currentKey)) throw new Error("OCEAN_CREDENTIALS_KEY_PREVIOUS je stejný jako OCEAN_CREDENTIALS_KEY — rotace by nic nezměnila.");

  const rows = db.prepare(`
    SELECT c.instance_id, i.user_id, c.key_version,
      c.api_key_ciphertext, c.api_key_iv, c.api_key_tag,
      c.api_secret_ciphertext, c.api_secret_iv, c.api_secret_tag
    FROM kryptotron_credentials c
    JOIN kryptotron_instances i ON i.id = c.instance_id
  `).all() as CredentialRow[];

  const result: RotationResult = { total: rows.length, alreadyCurrent: 0, migrated: [], failed: [] };
  const update = db.prepare(`
    UPDATE kryptotron_credentials SET
      api_key_ciphertext = ?, api_key_iv = ?, api_key_tag = ?,
      api_secret_ciphertext = ?, api_secret_iv = ?, api_secret_tag = ?,
      key_version = ?, updated_at = datetime('now')
    WHERE instance_id = ?
  `);

  for (const row of rows) {
    const context = `${row.user_id}:${row.instance_id}`;
    const stored: { apiKey: EncryptedValue; apiSecret: EncryptedValue } = {
      apiKey: { ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag },
      apiSecret: { ciphertext: row.api_secret_ciphertext, iv: row.api_secret_iv, tag: row.api_secret_tag },
    };
    try {
      decryptCredential(stored.apiKey, currentKey, `${context}:api-key`);
      decryptCredential(stored.apiSecret, currentKey, `${context}:api-secret`);
      result.alreadyCurrent += 1;
      continue;
    } catch {
      // Not yet migrated — fall through and try the previous key below.
    }

    try {
      const apiKey = decryptCredential(stored.apiKey, previousKey, `${context}:api-key`);
      const apiSecret = decryptCredential(stored.apiSecret, previousKey, `${context}:api-secret`);
      const newApiKey = encryptCredential(apiKey, currentKey, `${context}:api-key`);
      const newApiSecret = encryptCredential(apiSecret, currentKey, `${context}:api-secret`);
      if (decryptCredential(newApiKey, currentKey, `${context}:api-key`) !== apiKey
        || decryptCredential(newApiSecret, currentKey, `${context}:api-secret`) !== apiSecret) {
        throw new Error("Ověření po zápisu selhalo.");
      }
      update.run(
        newApiKey.ciphertext, newApiKey.iv, newApiKey.tag,
        newApiSecret.ciphertext, newApiSecret.iv, newApiSecret.tag,
        row.key_version + 1, row.instance_id,
      );
      result.migrated.push(row.instance_id);
    } catch (error) {
      result.failed.push({ instanceId: row.instance_id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
