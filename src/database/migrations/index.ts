import { existingOceanSchema } from "./001_existing_ocean_schema.js";
import { agent001Foundation } from "./002_agent_001_foundation.js";

export const databaseMigrations = [existingOceanSchema, agent001Foundation];
