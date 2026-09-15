import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("Telegram polling defaults off in development and on in production", () => {
  assert.equal(loadConfig({ NODE_ENV: "development" }).telegramPollingEnabled, false);
  assert.equal(loadConfig({ NODE_ENV: "production" }).telegramPollingEnabled, true);
});

test("Telegram polling can be explicitly disabled on any instance", () => {
  assert.equal(loadConfig({
    NODE_ENV: "production",
    OCEAN_TELEGRAM_POLLING_ENABLED: "false",
  }).telegramPollingEnabled, false);
});

test("Risk Agent scheduler is opt-in and uses the Prague post-snapshot default", () => {
  const defaults = loadConfig({ NODE_ENV: "production" });
  assert.equal(defaults.agentSchedulerEnabled, false);
  assert.equal(defaults.agentDailyRunTime, "10:02");
  assert.equal(defaults.agentDailyRunTimeZone, "Europe/Prague");

  const enabled = loadConfig({
    OCEAN_AGENT_SCHEDULER_ENABLED: "true",
    OCEAN_AGENT_DAILY_RUN_TIME: "08:30",
    OCEAN_AGENT_DAILY_RUN_TIME_ZONE: "UTC",
  });
  assert.equal(enabled.agentSchedulerEnabled, true);
  assert.equal(enabled.agentDailyRunTime, "08:30");
  assert.equal(enabled.agentDailyRunTimeZone, "UTC");
});
