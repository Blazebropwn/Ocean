import { createReadStream, createWriteStream } from "node:fs";
import { chmod, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { OffsiteObjectStore } from "./offsite-backup-lib.js";
import type { Config } from "./config.js";

export type OffsiteStoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

function required(name: string, value?: string) {
  if (!value?.trim()) throw new Error(`${name} není nastaven.`);
  return value.trim();
}

export function loadOffsiteStoreConfig(env = process.env): OffsiteStoreConfig {
  const endpoint = required("OCEAN_BACKUP_S3_ENDPOINT", env.OCEAN_BACKUP_S3_ENDPOINT);
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("OCEAN_BACKUP_S3_ENDPOINT musí používat HTTPS.");
  return {
    endpoint: url.toString().replace(/\/$/, ""),
    region: env.OCEAN_BACKUP_S3_REGION?.trim() || "auto",
    bucket: required("OCEAN_BACKUP_S3_BUCKET", env.OCEAN_BACKUP_S3_BUCKET),
    accessKeyId: required("OCEAN_BACKUP_S3_ACCESS_KEY_ID", env.OCEAN_BACKUP_S3_ACCESS_KEY_ID),
    secretAccessKey: required("OCEAN_BACKUP_S3_SECRET_ACCESS_KEY", env.OCEAN_BACKUP_S3_SECRET_ACCESS_KEY),
    prefix: env.OCEAN_BACKUP_S3_PREFIX?.trim() || "ocean",
  };
}

export function offsiteStoreConfigFromApp(config: Config): OffsiteStoreConfig {
  return loadOffsiteStoreConfig({
    OCEAN_BACKUP_S3_ENDPOINT: config.offsiteBackupS3Endpoint,
    OCEAN_BACKUP_S3_REGION: config.offsiteBackupS3Region,
    OCEAN_BACKUP_S3_BUCKET: config.offsiteBackupS3Bucket,
    OCEAN_BACKUP_S3_ACCESS_KEY_ID: config.offsiteBackupS3AccessKeyId,
    OCEAN_BACKUP_S3_SECRET_ACCESS_KEY: config.offsiteBackupS3SecretAccessKey,
    OCEAN_BACKUP_S3_PREFIX: config.offsiteBackupS3Prefix,
  });
}

export function createS3ObjectStore(config: OffsiteStoreConfig): OffsiteObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async put(key, sourcePath, metadata) {
      const source = await stat(sourcePath);
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentLength: source.size,
        ContentType: "application/octet-stream",
        Metadata: metadata,
        IfNoneMatch: "*",
      }));
    },
    async get(key, destinationPath) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!response.Body) throw new Error("Vzdálená záloha nemá obsah.");
      try {
        await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }));
        await chmod(destinationPath, 0o600);
      } catch (error) {
        await rm(destinationPath, { force: true });
        throw error;
      }
    },
    async size(key) {
      const response = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      if (response.ContentLength === undefined) throw new Error("Vzdálená záloha nemá známou velikost.");
      return response.ContentLength;
    },
  };
}
