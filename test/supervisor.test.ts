import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { workerEnvironment } from "../src/supervisor.js";

test("personal worker environment is isolated and forced to Testnet", () => {
  const config = {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    kryptotronSupervisorEnabled: true, kryptotronPython: "python",
    kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "secret-service-key",
  } satisfies Config;
  const environment = workerEnvironment(
    { BINANCE_API_KEY: "owner-key", BINANCE_API_SECRET: "owner-secret", TELEGRAM_TOKEN: "owner-telegram" },
    { id: "kry_0123456789abcdef0123456789abcdef", environment: "testnet" },
    "member-key", "member-secret", config,
  );
  assert.equal(environment.BINANCE_API_KEY, "member-key");
  assert.equal(environment.BINANCE_API_SECRET, "member-secret");
  assert.equal(environment.KRYPTOTRON_INSTANCE_ID, "kry_0123456789abcdef0123456789abcdef");
  assert.equal(environment.TESTNET, "true");
  assert.equal(environment.TELEGRAM_TOKEN, "");
  assert.equal(environment.DCA_ENABLED, "false");
  assert.equal(environment.STREAK_ENABLED, "false");
});
