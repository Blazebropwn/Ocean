import Database from "better-sqlite3";
import { chmod, copyFile, link, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export type DatabaseSnapshot = {
  tables: Record<string, number>;
};

const requiredTables = ["users", "sessions", "kryptotron_instances", "kryptotron_credentials"];

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function inspectDatabase(databasePath: string): DatabaseSnapshot {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma("quick_check") as Array<{ quick_check: string }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw new Error("Kontrola integrity databáze selhala.");
    }

    const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyErrors.length > 0) throw new Error("Databáze obsahuje neplatné vazby.");

    const tableNames = (db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name);

    const missing = requiredTables.filter((name) => !tableNames.includes(name));
    if (missing.length > 0) throw new Error(`V záloze chybí tabulky: ${missing.join(", ")}.`);

    const tables = Object.fromEntries(tableNames.map((name) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as { count: number };
      return [name, row.count];
    }));
    return { tables };
  } finally {
    db.close();
  }
}

export async function restoreDatabaseBackup(backupPath: string, destinationPath: string) {
  const source = resolve(backupPath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("Zdroj zálohy a cíl obnovy musí být odlišné.");

  const sourceSnapshot = inspectDatabase(source);
  const destinationDirectory = dirname(destination);
  const createdDirectory = await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  if (createdDirectory) await chmod(destinationDirectory, 0o700);

  const temporary = join(destinationDirectory, `.${basename(destination)}.${randomUUID()}.restore`);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    const restoredSnapshot = inspectDatabase(temporary);
    if (JSON.stringify(restoredSnapshot) !== JSON.stringify(sourceSnapshot)) {
      throw new Error("Obnovená databáze neodpovídá záloze.");
    }

    await link(temporary, destination);
    await rm(temporary);
    return { destination, snapshot: restoredSnapshot };
  } catch (error: any) {
    await rm(temporary, { force: true });
    if (error?.code === "EEXIST") throw new Error("Cílová databáze už existuje; obnova ji nepřepíše.");
    throw error;
  }
}
