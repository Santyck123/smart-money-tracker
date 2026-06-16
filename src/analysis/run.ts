import { requireEnv } from "../config.js";
import { logger } from "../logger.js";
import { EvmAdapter } from "../chains/evm.adapter.js";
import { SolanaAdapter } from "../chains/solana.adapter.js";
import type { Chain, ChainAdapter } from "../chains/types.js";
import { getTransfersForPump, insertTransfers, listPumpEvents, markAnalyzed, upsertWalletStats } from "../storage/db.js";
import { buildWalletStatsRows, extractBuys, findPreBuyers } from "./prebuyers.js";

/**
 * Orquestador de analyze: para cada pump no analizado, baja los transfers
 * de la ventana [pumpStart - lookback, pumpStart + 24h], los persiste y
 * reporta pre-buyers. Un token que falla no aborta el batch.
 */
export async function runAnalyze(lookbackHours: number): Promise<void> {
  const pending = listPumpEvents(true);
  logger.info({ pending: pending.length, lookbackHours }, "pumps pendientes de análisis");
  if (pending.length === 0) return;

  const adapters = new Map<Chain, ChainAdapter>();
  const getAdapter = (chain: Chain): ChainAdapter | undefined => {
    if (adapters.has(chain)) return adapters.get(chain);
    if (chain === "eth" || chain === "bsc" || chain === "polygon" || chain === "arbitrum") {
      const adapter = new EvmAdapter(chain, requireEnv("ETHERSCAN_API_KEY"));
      adapters.set(chain, adapter);
      return adapter;
    }
    if (chain === "sol") {
      const adapter = new SolanaAdapter(requireEnv("HELIUS_API_KEY"));
      adapters.set(chain, adapter);
      return adapter;
    }
    return undefined;
  };

  for (const pump of pending) {
    const adapter = getAdapter(pump.chain);
    if (!adapter) {
      logger.warn({ chain: pump.chain, token: pump.tokenSymbol }, "chain sin adapter todavía, salteo");
      continue;
    }
    try {
      const fromTs = pump.pumpStartTs - lookbackHours * 3600;
      const toTs = pump.pumpStartTs + 24 * 3600;
      const transfers = await adapter.getTokenTransfers(pump.tokenAddress, fromTs, toTs, pump.pairAddress);
      const saved = insertTransfers(pump.id, transfers);
      logger.info({ token: pump.tokenSymbol, chain: pump.chain, transfers: transfers.length, saved }, "transfers persistidos");

      const all = getTransfersForPump(pump.id);
      const buys = extractBuys(all, pump.pairAddress);
      const preBuyers = findPreBuyers(buys, pump.pumpStartTs);
      logger.info(
        { token: pump.tokenSymbol, buys: buys.length, preBuyers: preBuyers.length },
        "pre-buyers detectados",
      );

      const statsRows = buildWalletStatsRows(pump, preBuyers);
      upsertWalletStats(statsRows);
      logger.info({ token: pump.tokenSymbol, walletStats: statsRows.length }, "wallet stats persistidos");
      markAnalyzed(pump.id);
    } catch (err) {
      logger.error({ err: String(err), token: pump.tokenSymbol, chain: pump.chain }, "fallo análisis de token, continúo");
    }
  }
}
