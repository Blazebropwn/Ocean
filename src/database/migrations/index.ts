import { existingOceanSchema } from "./001_existing_ocean_schema.js";
import { agent001Foundation } from "./002_agent_001_foundation.js";
import { adminAuditLog } from "./003_admin_audit_log.js";
import { workerNotifications } from "./004_worker_notifications.js";

export const databaseMigrations = [existingOceanSchema, agent001Foundation, adminAuditLog, workerNotifications];
