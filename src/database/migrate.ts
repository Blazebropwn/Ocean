import type Database from "better-sqlite3";

export type DatabaseMigration = {
  version: number;
  name: string;
  up(db: Database.Database): void;
};

type AppliedMigration = { version: number; name: string };

function validateMigrations(migrations: readonly DatabaseMigration[]) {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(`Neplatné pořadí migrací: očekávána verze ${expectedVersion}, nalezena ${migration.version}.`);
    }
  }
}

export function migrateDatabase(db: Database.Database, migrations: readonly DatabaseMigration[]) {
  validateMigrations(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as AppliedMigration[];
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  const unknown = applied.find(({ version }) => version > latestKnownVersion || !migrations.some((migration) => migration.version === version));
  if (unknown) throw new Error(`Databáze používá neznámou migraci ${unknown.version} (${unknown.name}).`);

  for (const record of applied) {
    const expected = migrations.find(({ version }) => version === record.version);
    if (expected?.name !== record.name) {
      throw new Error(`Migrace ${record.version} má neočekávaný název ${record.name}.`);
    }
  }

  const apply = db.transaction((migration: DatabaseMigration) => {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  });

  const appliedVersions = new Set(applied.map(({ version }) => version));
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) apply(migration);
  }
}
