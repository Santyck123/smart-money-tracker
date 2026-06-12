// Prueba real del EvmAdapter contra tokens activos (Fase 2).
import { requireEnv } from "../src/config.js";
import { EvmAdapter } from "../src/chains/evm.adapter.js";
import { extractBuys, findPreBuyers } from "../src/analysis/prebuyers.js";

const key = requireEnv("ETHERSCAN_API_KEY");
const now = Math.floor(Date.now() / 1000);

const targets = [
  { chain: "eth" as const, symbol: "PEPE", token: "0x6982508145454ce325ddbe47a25d4ec3d2311933", pair: "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f" },
  { chain: "bsc" as const, symbol: "CAKE", token: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", pair: "0x0ed7e52944161450477ee417de9cd3a859b14fd0" },
];

for (const t of targets) {
  const adapter = new EvmAdapter(t.chain, key);
  const start = Date.now();
  // ventana: últimas 6h; "pump" simulado hace 1h para probar pre-buyers
  const transfers = await adapter.getTokenTransfers(t.token, now - 6 * 3600, now);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const fakePumpStart = now - 3600;
  const buys = extractBuys(transfers, t.pair);
  const preBuyers = findPreBuyers(buys, fakePumpStart);
  console.log(`\n=== ${t.symbol} (${t.chain}) — ${elapsed}s ===`);
  console.log(`transfers (6h): ${transfers.length} | buys: ${buys.length} | pre-buyers (antes de hace 1h): ${preBuyers.length}`);
  console.table(
    preBuyers.slice(0, 5).map((p) => ({
      wallet: p.wallet.slice(0, 12) + "…",
      buys: p.buys.length,
      firstBuy: new Date(p.firstBuyTs * 1000).toISOString().slice(11, 19),
    })),
  );
  // primera tx entrante de un pre-buyer (valida txlist)
  const sample = preBuyers[0];
  if (sample) {
    const first = await adapter.getFirstIncomingTx(sample.wallet);
    console.log(`firstIncomingTx de ${sample.wallet.slice(0, 12)}…:`, first ? new Date(first.timestamp * 1000).toISOString() : "n/a");
  }
}
