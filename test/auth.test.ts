import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../src/security.js";

const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false };

test("register creates an opaque identity and authenticated session", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "Ada@Example.com", username: "ada_zero", password: "correct horse battery staple" } });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.match(body.user.id, /^usr_[a-f0-9]{32}$/);
  assert.equal(body.user.displayId, "OCEAN-000001");
  assert.equal(body.user.email, "ada@example.com");
  assert.ok(response.headers["set-cookie"]?.toString().includes("HttpOnly"));
  await app.close();
});

test("login with username does not reveal whether an account exists", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "nobody", password: "anything" } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "Neplatné uživatelské jméno nebo heslo.");
  await app.close();
});

test("missing accounts use a valid dummy password hash", async () => {
  assert.equal(await verifyPassword(DUMMY_PASSWORD_HASH, "anything"), false);
});

test("protected identity endpoint requires a valid session", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const response = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("email verification token is single-use and marks the user verified", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "verify@example.com", username: "verify_me", password: "a secure test password" } });
  const cookie = registered.headers["set-cookie"]?.toString().split(";")[0];
  const mail = db.prepare("SELECT body FROM mail_outbox ORDER BY id DESC LIMIT 1").get() as { body: string };
  const token = new URL(mail.body.match(/https?:\/\/\S+/)![0]).searchParams.get("token");

  const confirmation = await app.inject({ method: "POST", url: "/api/auth/verification/confirm", payload: { token } });
  assert.equal(confirmation.statusCode, 200);
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie! } });
  assert.equal(me.json().user.emailVerified, true);

  const reused = await app.inject({ method: "POST", url: "/api/auth/verification/confirm", payload: { token } });
  assert.equal(reused.statusCode, 400);
  await app.close();
});

test("development mailbox is unavailable in production", async () => {
  const app = buildApp({ ...config, isProduction: true }, openDatabase(":memory:"));
  const response = await app.inject({ method: "GET", url: "/api/dev/mailbox" });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("development accepts the equivalent loopback origin", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: "http://127.0.0.1:3000" },
    payload: { email: "loopback@example.com", username: "loopback", password: "a secure loopback password" },
  });
  assert.equal(response.statusCode, 201);
  await app.close();
});

test("password recovery resets the password, consumes the token and revokes sessions", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "recover@example.com", username: "recover_me", password: "the original secure password" } });
  const oldCookie = registered.headers["set-cookie"]?.toString().split(";")[0];
  const requested = await app.inject({ method: "POST", url: "/api/auth/recovery/request", payload: { email: "recover@example.com" } });
  assert.equal(requested.statusCode, 200);
  const mail = db.prepare("SELECT body FROM mail_outbox WHERE subject = 'Obnova hesla OCEAN' ORDER BY id DESC LIMIT 1").get() as { body: string };
  const token = new URL(mail.body.match(/https?:\/\/\S+/)![0]).searchParams.get("token");

  const reset = await app.inject({ method: "POST", url: "/api/auth/recovery/confirm", payload: { token, password: "the new secure password" } });
  assert.equal(reset.statusCode, 200);
  const oldSession = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie! } });
  assert.equal(oldSession.statusCode, 401);
  const oldLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "recover_me", password: "the original secure password" } });
  assert.equal(oldLogin.statusCode, 401);
  const newLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "recover_me", password: "the new secure password" } });
  assert.equal(newLogin.statusCode, 200);
  const reused = await app.inject({ method: "POST", url: "/api/auth/recovery/confirm", payload: { token, password: "yet another secure password" } });
  assert.equal(reused.statusCode, 400);
  await app.close();
});

test("recovery request does not reveal whether an account exists", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const response = await app.inject({ method: "POST", url: "/api/auth/recovery/request", payload: { email: "missing@example.com" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().message, "Pokud účet existuje, poslali jsme odkaz pro obnovu hesla.");
  await app.close();
});

test("authenticated user can change an eight-character password", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "change@example.com", username: "change_me", password: "oldpass8" } });
  const cookie = registered.headers["set-cookie"]?.toString().split(";")[0];
  const changed = await app.inject({ method: "POST", url: "/api/account/password", headers: { cookie: cookie! }, payload: { currentPassword: "oldpass8", newPassword: "newpass8" } });
  assert.equal(changed.statusCode, 200);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "change_me", password: "newpass8" } });
  assert.equal(login.statusCode, 200);
  await app.close();
});
