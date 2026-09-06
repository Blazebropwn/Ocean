import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import { buildVersionedPages, versionAssetReferences } from "../src/asset-versioning.js";

const publicRoot = join(process.cwd(), "public");
const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false };

test("asset references gain a content hash and drop stale manual versions", () => {
  const versioned = versionAssetReferences('<link href="/command-deck.css?v=11"><script src="/app.js"></script>', publicRoot);
  assert.match(versioned, /\/command-deck\.css\?v=[0-9a-f]{10}"/);
  assert.doesNotMatch(versioned, /\?v=11/);
  assert.match(versioned, /\/app\.js\?v=[0-9a-f]{10}"/);
});

test("a missing asset is left unversioned rather than breaking the page", () => {
  const versioned = versionAssetReferences('<script src="/nope.js?v=3"></script>', publicRoot);
  assert.match(versioned, /src="\/nope\.js"/);
  assert.doesNotMatch(versioned, /\?v=/);
});

test("the same asset hashes identically wherever it is referenced", () => {
  const references = buildVersionedPages(publicRoot)
    .flatMap((page) => [...page.html.matchAll(/\/command-deck\.css\?v=([0-9a-f]{10})/g)].map((match) => match[1]));
  assert.ok(references.length >= 2);
  assert.equal(new Set(references).size, 1);
});

test("the server serves HTML with content-hashed asset URLs", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const index = await app.inject({ method: "GET", url: "/" });
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["content-type"] ?? "", /text\/html/);
  assert.match(index.body, /\/command-deck\.css\?v=[0-9a-f]{10}/);
  assert.match(index.body, /\/app\.js\?v=[0-9a-f]{10}/);

  const invites = await app.inject({ method: "GET", url: "/invites.html" });
  assert.equal(invites.statusCode, 200);
  assert.match(invites.body, /\/invites\.js\?v=[0-9a-f]{10}/);

  const cssUrl = index.body.match(/\/command-deck\.css\?v=[0-9a-f]{10}/)?.[0];
  const stylesheet = await app.inject({ method: "GET", url: cssUrl! });
  assert.equal(stylesheet.statusCode, 200);
  assert.match(stylesheet.headers["content-type"] ?? "", /text\/css/);
  await app.close();
});
