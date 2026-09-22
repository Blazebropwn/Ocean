import type { Config } from "../config.js";
import type { OceanDatabase } from "../db.js";
import { loadKryptotronState } from "../kryptotron.js";
import { BinancePortfolioProvider } from "./binance-provider.js";

export function createDefaultPortfolioProvider(db: OceanDatabase, config: Config) {
  return new BinancePortfolioProvider(
    db,
    config.credentialsEncryptionKey,
    undefined,
    undefined,
    undefined,
    async (stateKey) => {
      if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) {
        throw new Error("Úložiště hlavního Kryptotronu není dostupné.");
      }
      return await loadKryptotronState(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, stateKey);
    },
    config.credentialsEncryptionKeyPrevious,
  );
}
