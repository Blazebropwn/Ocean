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
