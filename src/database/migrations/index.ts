import { existingOceanSchema } from "./001_existing_ocean_schema.js";
import { agent001Foundation } from "./002_agent_001_foundation.js";
import { adminAuditLog } from "./003_admin_audit_log.js";
import { workerNotifications } from "./004_worker_notifications.js";
import { tideEconomy } from "./005_tide_economy.js";

import { genesisWaves } from "./006_genesis_waves.js";
import { accountSuspension } from "./007_account_suspension.js";
import { sonarLeaderboard } from "./008_sonar_leaderboard.js";

export const databaseMigrations = [existingOceanSchema, agent001Foundation, adminAuditLog, workerNotifications, tideEconomy, genesisWaves, accountSuspension, sonarLeaderboard];
