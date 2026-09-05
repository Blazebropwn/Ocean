import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createDatabaseBackup } from "./backup-lib.js";
import { inspectDatabase, restoreDatabaseBackup, type DatabaseSnapshot } from "./restore-lib.js";

const MAGIC = Buffer.from("OCEANBKP", "ascii");
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + IV_LENGTH;

export type OffsiteObjectStore = {
  put(key: string, sourcePath: string, metadata: Record<string, string>): Promise<void>;
  get(key: string, destinationPath: string): Promise<void>;
  size(key: string): Promise<number>;
};

export function backupEncryptionKey(value?: string) {
  if (!value) throw new Error("OCEAN_BACKUP_KEY není nastaven.");
  const normalized = value.trim();
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32 || key.toString("base64") !== normalized) {
    throw new Error("OCEAN_BACKUP_KEY musí být 32 bytů v base64.");
  }
  return key;
}

export async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function encryptBackupFile(sourcePath: string, destinationPath: string, key: Buffer) {
  if (key.length !== 32) throw new Error("Šifrovací klíč zálohy musí mít 32 bytů.");
  const iv = randomBytes(IV_LENGTH);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]);
  const destination = await open(destinationPath, "wx", 0o600);
  try {
    await destination.write(header);
  } finally {
    await destination.close();
  }

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  try {
    await pipeline(createReadStream(sourcePath), cipher, createWriteStream(destinationPath, { flags: "a" }));
    await appendFile(destinationPath, cipher.getAuthTag());
    await chmod(destinationPath, 0o600);
  } catch (error) {
    await rm(destinationPath, { force: true });
    throw error;
  }
}

export async function decryptBackupFile(sourcePath: string, destinationPath: string, key: Buffer) {
  if (key.length !== 32) throw new Error("Šifrovací klíč zálohy musí mít 32 bytů.");
  const source = await open(sourcePath, "r");
  let size: number;
  const header = Buffer.alloc(HEADER_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    size = (await source.stat()).size;
    if (size <= HEADER_LENGTH + TAG_LENGTH) throw new Error("Šifrovaná záloha je neúplná.");
    const headerRead = await source.read(header, 0, HEADER_LENGTH, 0);
    const tagRead = await source.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
    if (headerRead.bytesRead !== HEADER_LENGTH || tagRead.bytesRead !== TAG_LENGTH) {
      throw new Error("Šifrovaná záloha je neúplná.");
    }
  } finally {
    await source.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) {
    throw new Error("Formát šifrované zálohy není podporován.");
  }

  const iv = header.subarray(MAGIC.length + 1);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(sourcePath, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }),
      decipher,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
    );
    await chmod(destinationPath, 0o600);
  } catch (error) {
    await rm(destinationPath, { force: true });
    throw new Error("Šifrovanou zálohu nelze ověřit nebo rozšifrovat.", { cause: error });
  }
}

function sameSnapshot(left: DatabaseSnapshot, right: DatabaseSnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function objectKeyFor(backupPath: string, prefix: string, now = new Date()) {
  const datePath = now.toISOString().slice(0, 10).replaceAll("-", "/");
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "") || "ocean";
  return `${normalizedPrefix}/${datePath}/${basename(backupPath)}.obk`;
}

export async function createOffsiteBackup(options: {
  databasePath: string;
  backupDirectory?: string;
  retentionDays?: number;
  encryptionKey: Buffer;
  store: OffsiteObjectStore;
  prefix?: string;
}) {
  const backupPath = await createDatabaseBackup(options.databasePath, options.backupDirectory, options.retentionDays);
  const expected = inspectDatabase(backupPath);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ocean-offsite-backup-"));
  const encryptedPath = join(temporaryDirectory, `${basename(backupPath)}.obk`);
  const downloadedPath = join(temporaryDirectory, "downloaded.obk");
  const verifiedPath = join(temporaryDirectory, "verified.db");
  const objectKey = objectKeyFor(backupPath, options.prefix ?? "ocean");
  try {
    await encryptBackupFile(backupPath, encryptedPath, options.encryptionKey);
    const checksum = await sha256File(encryptedPath);
    const encryptedSize = (await stat(encryptedPath)).size;
    await options.store.put(objectKey, encryptedPath, { format: "ocean-backup-v1", sha256: checksum });
    if (await options.store.size(objectKey) !== encryptedSize) throw new Error("Velikost vzdálené zálohy nesouhlasí.");

    await options.store.get(objectKey, downloadedPath);
    if (await sha256File(downloadedPath) !== checksum) throw new Error("Kontrolní součet vzdálené zálohy nesouhlasí.");
    await decryptBackupFile(downloadedPath, verifiedPath, options.encryptionKey);
    const verified = inspectDatabase(verifiedPath);
    if (!sameSnapshot(expected, verified)) throw new Error("Vzdálená záloha neodpovídá zdrojové databázi.");
    return { backupPath, objectKey, encryptedSize, snapshot: verified };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreOffsiteBackup(options: {
  objectKey: string;
  destinationPath: string;
  encryptionKey: Buffer;
  store: OffsiteObjectStore;
}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ocean-offsite-restore-"));
  const encryptedPath = join(temporaryDirectory, "downloaded.obk");
  const backupPath = join(temporaryDirectory, "ocean.db.backup");
  try {
    await options.store.get(options.objectKey, encryptedPath);
    await decryptBackupFile(encryptedPath, backupPath, options.encryptionKey);
    return await restoreDatabaseBackup(backupPath, options.destinationPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function readBackupScheduleState(path: string) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { lastSuccessDate?: unknown };
    return typeof parsed.lastSuccessDate === "string" ? parsed.lastSuccessDate : undefined;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeBackupScheduleState(path: string, lastSuccessDate: string) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ lastSuccessDate }), { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
