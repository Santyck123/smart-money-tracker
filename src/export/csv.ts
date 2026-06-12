import { stringify } from "csv-stringify/sync";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env, requireEnv } from "../config.js";
import { logger } from "../logger.js";
import { EvmAdapter } from "../chains/evm.adapter.js";
import { SolanaAdapter } from "../chains/solana.adapter.js";
import type { Chain } from "../chains/types.js";
import { listAllWalletStats, listPumpEvents, type WalletStatsRow } from "../storage/db.js";
import { computeFlags, type WalletFlags } from "../analysis/filters.js";
import { scoreWallet } from "../analysis/scoring.js";

/**
 * Export final: agrega wallet_stats por wallet, scorea, enriquece flags para
 * el top-N (1-2 requests por wallet — no se hace para las 10k+ de cola) y
 * escribe output/smart-wallets-YYYY-MM-DD.csv ordenado por score desc.
 */

/** Cantidad de wallets top a las que se les resuelven flags vía API. */
const FLAG_ENRICHMENT_TOP_N = 100;

const EXPLORER_URL: Record<Chain, (wallet: string) => string> = {
  eth: (w) => `https://etherscan.io/address/${w}`,
  bsc: (w) => `https://bscscan.com/address/${w}`,
  sol: (w) => `https://solscan.io/account/${w}`,
};

interface RankedWallet {
  wallet: string;
  chain: Chain;
  score: number;
  isBotSuspect: boolean;
  tokensHitCount: number;
  avgHoursBeforePump: number;
  totalUsdBoughtPrepump: number;
  avgSupplyPct: number;
  avgBuyCount: number;
  minMinutesAfterDeploy: number;
  earliestBuyTs: number;
  tokensList: string;
  flags: WalletFlags;
}

export async function runExport(minScore = 0, enrichFlags = true): Promise<string> {
  const pumps = new Map(listPumpEvents().map((p) => [p.id, p]));
  const allStats = listAllWalletStats();
  logger.info({ statRows: allStats.length }, "agregando wallet stats");

  const byWallet = new Map<string, WalletStatsRow[]>();
  for (const row of allStats) {
    const list = byWallet.get(row.wallet) ?? [];
    list.push(row);
    byWallet.set(row.wallet, list);
  }

  const ranked: RankedWallet[] = [];
  for (const [wallet, rows] of byWallet) {
    const result = scoreWallet({
      perToken: rows.map((r) => ({
        hoursBeforePump: r.hoursBeforePump,
        minutesAfterDeploy: r.minutesAfterDeploy,
        buyCount: r.buyCount,
        dispersionHours: r.dispersionHours,
        supplyPctBought: r.supplyPct ?? undefined,
        maxBuysPerSecond: r.maxBuysPerSecond,
        firstBuyClusterSize: r.firstBuyClusterSize,
      })),
    });
    if (result.score < minScore) continue;

    // USD aproximado: cantidad comprada (UI) × precio actual del token.
    // TODO: precio histórico al momento de la compra.
    const totalUsd = rows.reduce((acc, r) => {
      const pump = pumps.get(r.pumpEventId);
      return acc + r.totalAmount * (pump?.priceUsd ?? 0);
    }, 0);

    ranked.push({
      wallet,
      chain: rows[0]!.chain,
      score: result.score,
      isBotSuspect: result.isBotSuspect,
      tokensHitCount: result.tokensHitCount,
      avgHoursBeforePump: result.avgHoursBeforePump,
      totalUsdBoughtPrepump: totalUsd,
      avgSupplyPct: result.avgSupplyPct,
      avgBuyCount: result.avgBuyCount,
      minMinutesAfterDeploy: Math.min(...rows.map((r) => (r.minutesAfterDeploy < 0 ? Infinity : r.minutesAfterDeploy))),
      earliestBuyTs: Math.min(...rows.map((r) => r.firstBuyTs)),
      tokensList: rows
        .map((r) => pumps.get(r.pumpEventId)?.tokenSymbol ?? `#${r.pumpEventId}`)
        .join("|"),
      flags: { isSniper: false, isInsiderSuspect: false, isFreshWallet: false },
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  logger.info({ wallets: ranked.length }, "wallets rankeadas");

  if (enrichFlags) await enrichTopFlags(ranked.slice(0, FLAG_ENRICHMENT_TOP_N));

  // Flags locales (sniper no necesita API) para el resto
  for (const w of ranked) {
    w.flags.isSniper = Number.isFinite(w.minMinutesAfterDeploy)
      ? computeFlags({
          minMinutesAfterDeploy: w.minMinutesAfterDeploy,
          earliestBuyTs: w.earliestBuyTs,
        }).isSniper
      : false;
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.resolve("output");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `smart-wallets-${date}.csv`);

  const csv = stringify(
    ranked.map((w) => ({
      wallet: w.wallet,
      chain: w.chain,
      score: w.score,
      tokens_hit_count: w.tokensHitCount,
      avg_buy_timing_hours_before_pump: w.avgHoursBeforePump.toFixed(2),
      total_usd_bought_prepump: w.totalUsdBoughtPrepump.toFixed(2),
      avg_supply_pct: (w.avgSupplyPct * 100).toFixed(4),
      accumulation_buys_avg: w.avgBuyCount.toFixed(2),
      is_sniper: w.flags.isSniper,
      is_insider_suspect: w.flags.isInsiderSuspect,
      is_fresh_wallet: w.flags.isFreshWallet,
      is_bot_suspect: w.isBotSuspect,
      tokens_list: w.tokensList,
      explorer_url: EXPLORER_URL[w.chain](w.wallet),
    })),
    { header: true, cast: { boolean: (v) => String(v) } },
  );
  writeFileSync(outPath, csv, "utf8");
  logger.info({ outPath, wallets: ranked.length }, "CSV generado");
  return outPath;
}

/** Resuelve primera tx / historial vía API solo para el top-N. */
async function enrichTopFlags(top: RankedWallet[]): Promise<void> {
  const evmAdapters = new Map<Chain, EvmAdapter>();
  let sol: SolanaAdapter | undefined;

  for (const w of top) {
    try {
      let firstIncomingTx: { from: string; timestamp: number } | undefined;
      let knownTxCount: number | undefined;

      if (w.chain === "sol") {
        if (env.HELIUS_API_KEY) {
          sol ??= new SolanaAdapter(requireEnv("HELIUS_API_KEY"));
          const first = await sol.getWalletFirstTx(w.wallet);
          if (first) {
            knownTxCount = first.txCount;
            if (first.timestamp !== null) {
              // funder desconocido en Solana (TODO) — solo edad + historial
              firstIncomingTx = { from: "", timestamp: first.timestamp };
            }
          }
        }
      } else if (env.ETHERSCAN_API_KEY) {
        let adapter = evmAdapters.get(w.chain);
        if (!adapter) {
          adapter = new EvmAdapter(w.chain, requireEnv("ETHERSCAN_API_KEY"));
          evmAdapters.set(w.chain, adapter);
        }
        firstIncomingTx = (await adapter.getFirstIncomingTx(w.wallet)) ?? undefined;
      }

      w.flags = computeFlags({
        minMinutesAfterDeploy: Number.isFinite(w.minMinutesAfterDeploy) ? w.minMinutesAfterDeploy : -1,
        firstIncomingTx,
        // TODO: resolver deployer del token (EVM: getcontractcreation) para is_insider_suspect
        deployerAddress: undefined,
        earliestBuyTs: w.earliestBuyTs,
        knownTxCount,
      });
    } catch (err) {
      logger.warn({ err: String(err), wallet: w.wallet }, "fallo enriquecimiento de flags, continúo");
    }
  }
  logger.info({ enriched: top.length }, "flags enriquecidos para el top");
}
