// Recalcula wallet_stats desde los transfers ya persistidos (sin APIs)
// y muestra el ranking de scoring real. Útil tras cambiar la lógica.
import { listPumpEvents, getTransfersForPump, upsertWalletStats, listAllWalletStats } from "../src/storage/db.js";
import { buildWalletStatsRows, extractBuys, findPreBuyers } from "../src/analysis/prebuyers.js";
import { findFleetBots, scoreWallet } from "../src/analysis/scoring.js";

const pumps = listPumpEvents();
for (const pump of pumps) {
  const transfers = getTransfersForPump(pump.id);
  if (transfers.length === 0) continue;
  const buys = extractBuys(transfers, pump.pairAddress);
  const preBuyers = findPreBuyers(buys, pump.pumpStartTs);
  upsertWalletStats(buildWalletStatsRows(pump, preBuyers));
  console.log(`${pump.tokenSymbol}: ${preBuyers.length} pre-buyers`);
}

// Agregar por wallet y scorear
const all = listAllWalletStats();
const byWallet = new Map<string, typeof all>();
for (const row of all) {
  const list = byWallet.get(row.wallet) ?? [];
  list.push(row);
  byWallet.set(row.wallet, list);
}

const fleet = findFleetBots(all);
const scored = [...byWallet.entries()].map(([wallet, rows]) => ({
  wallet,
  ...scoreWallet({
    fleetBot: fleet.has(wallet),
    perToken: rows.map((r) => ({
      hoursBeforePump: r.hoursBeforePump,
      minutesAfterDeploy: r.minutesAfterDeploy,
      buyCount: r.buyCount,
      dispersionHours: r.dispersionHours,
      supplyPctBought: r.supplyPct ?? undefined,
      maxBuysPerSecond: r.maxBuysPerSecond,
      firstBuyClusterSize: r.firstBuyClusterSize,
    })),
  }),
}));

scored.sort((a, b) => b.score - a.score);
const bots = scored.filter((s) => s.isBotSuspect).length;
console.log(`\nwallets únicas: ${scored.length} | recurrencia 2+: ${scored.filter((s) => s.tokensHitCount >= 2).length} | 3+: ${scored.filter((s) => s.tokensHitCount >= 3).length} | BOTS detectados: ${bots} (${((bots / scored.length) * 100).toFixed(1)}%)`);
console.table(
  scored.slice(0, 15).map((s) => ({
    wallet: s.wallet.slice(0, 14) + "…",
    score: s.score,
    bot: s.isBotSuspect ? "🤖" : "",
    tokens: s.tokensHitCount,
    avgHsAntes: s.avgHoursBeforePump.toFixed(1),
    avgCompras: s.avgBuyCount.toFixed(1),
    avgSupplyPct: (s.avgSupplyPct * 100).toFixed(2) + "%",
  })),
);
