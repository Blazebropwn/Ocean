import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { readinessIssues } from "../src/readiness.js";

test("development database is ready without optional integrations", () => {
  const db = openDatabase(":memory:");
  const issues = readinessIssues({ port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false }, db);
  assert.deepEqual(issues, []);
  db.close();
});

test("production readiness detects missing mail delivery", () => {
  const db = openDatabase(":memory:");
  const issues = readinessIssues({ port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "https://ocean.example", isProduction: true }, db);
  assert.ok(issues.some((issue) => issue.includes("e-mail")));
  db.close();
});
