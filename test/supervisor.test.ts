import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { restartDelayMs, workerEnvironment, workerHeartbeatExpired } from "../src/supervisor.js";

test("personal worker environment is isolated and forced to Testnet", () => {
  const config = {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    kryptotronSupervisorEnabled: true, kryptotronPython: "python",
    kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "secret-service-key",
  } satisfies Config;
  const environment = workerEnvironment(
    {
      PATH: "/usr/bin",
      BINANCE_API_KEY: "owner-key",
      BINANCE_API_SECRET: "owner-secret",
      TELEGRAM_TOKEN: "owner-telegram",
      OCEAN_CREDENTIALS_KEY: "ocean-encryption-key",
      SESSION_SECRET: "ocean-session-secret",
    },
    { id: "kry_0123456789abcdef0123456789abcdef", environment: "testnet" },
    "member-key", "member-secret", config, "scoped-token",
  );
  assert.equal(environment.BINANCE_API_KEY, "member-key");
  assert.equal(environment.BINANCE_API_SECRET, "member-secret");
  assert.equal(environment.KRYPTOTRON_INSTANCE_ID, "kry_0123456789abcdef0123456789abcdef");
  assert.equal(environment.TESTNET, "true");
  assert.equal(environment.SUPABASE_KEY, "");
  assert.equal(environment.OCEAN_STATE_TOKEN, "scoped-token");
  assert.equal(environment.OCEAN_STATE_URL, "http://127.0.0.1:0/internal/kryptotron");
  assert.equal(environment.TELEGRAM_TOKEN, "");
  assert.equal(environment.DCA_ENABLED, "false");
  assert.equal(environment.STREAK_ENABLED, "false");
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.OCEAN_CREDENTIALS_KEY, undefined);
  assert.equal(environment.SESSION_SECRET, undefined);
});

test("worker restart backoff is bounded", () => {
  assert.equal(restartDelayMs(1), 10_000);
  assert.equal(restartDelayMs(2), 20_000);
  assert.equal(restartDelayMs(20), 300_000);
});

test("ready worker expires on a missing heartbeat", () => {
  assert.equal(workerHeartbeatExpired({ ready: true, startedAt: 0, lastHeartbeatAt: 1_000 }, 181_000), false);
  assert.equal(workerHeartbeatExpired({ ready: true, startedAt: 0, lastHeartbeatAt: 1_000 }, 181_001), true);
  assert.equal(workerHeartbeatExpired({ ready: false, startedAt: 1_000, lastHeartbeatAt: 1_000 }, 421_000), false);
});
