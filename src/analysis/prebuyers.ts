import type { TokenTransfer } from "../chains/types.js";

/**
 * Identificación de pre-buyers a partir de transfers crudos. Chain-agnostic.
 *
 * Heurística MVP: una "compra" es un transfer cuyo destinatario es una wallet
 * y cuyo emisor es el pool/par (o cualquier address que concentre mucho flujo
 * saliente del token, p.ej. routers). Para no depender de conocer todos los
 * routers, tomamos como "vendedores estructurales" las addresses que aparecen
 * como `from` en muchos transfers distintos (pool, router, market maker) y
 * contamos como compra todo transfer pool→wallet anterior a pumpStartTs.
 *
 * TODO: refinar con decodificación real de swaps (logs de Swap en EVM,
 * parsed instructions en Solana) — hoy es una aproximación documentada.
 */

export interface Buy {
  wallet: string;
  txHash: string;
  timestamp: number;
  rawAmount: string;
  decimals: number;
}

export interface PreBuyerSummary {
  wallet: string;
  buys: Buy[];
  firstBuyTs: number;
  lastBuyTs: number;
  /** Total comprado en unidades UI (rawAmount / 10^decimals). */
  totalAmount: number;
}

/** rawAmount → unidades UI. Tolera floats (Helius) y enteros raw (EVM). */
export function toUiAmount(rawAmount: string, decimals: number): number {
  const value = Number(rawAmount);
  if (!Number.isFinite(value)) return 0;
  return decimals > 0 ? value / 10 ** decimals : value;
}

/** Mínimo de transfers salientes para considerar una address "estructural" (pool/router). */
const STRUCTURAL_FROM_THRESHOLD = 5;

export function extractBuys(transfers: TokenTransfer[], pairAddress: string): Buy[] {
  const pair = pairAddress.toLowerCase();

  // Addresses con mucho flujo saliente: pools, routers, distribuidores
  const outCounts = new Map<string, number>();
  for (const t of transfers) {
    outCounts.set(t.from, (outCounts.get(t.from) ?? 0) + 1);
  }
  const structural = new Set<string>([pair]);
  for (const [addr, count] of outCounts) {
    if (count >= STRUCTURAL_FROM_THRESHOLD) structural.add(addr);
  }

  const buys: Buy[] = [];
  for (const t of transfers) {
    // compra = sale de una address estructural hacia una wallet que no lo es
    if (!structural.has(t.from)) continue;
    if (structural.has(t.to)) continue;
    if (t.rawAmount === "0") continue;
    buys.push({
      wallet: t.to,
      txHash: t.txHash,
      timestamp: t.timestamp,
      rawAmount: t.rawAmount,
      decimals: t.decimals,
    });
  }
  return buys;
}

/**
 * Construye las filas de wallet_stats para un pump a partir de sus pre-buyers.
 * Única fuente de verdad de estas métricas (la usan analyze y el rescore).
 */
export function buildWalletStatsRows(
  pump: {
    id: number;
    chain: import("../chains/types.js").Chain;
    pumpStartTs: number;
    pairCreatedAtTs: number;
  },
  preBuyers: PreBuyerSummary[],
): import("../storage/db.js").WalletStatsRow[] {
  // Proxy de supply circulante: total comprado por todos los pre-buyers.
  // TODO: usar supply real (totalSupply EVM / getTokenSupply Solana).
  const totalBought = preBuyers.reduce((acc, p) => acc + p.totalAmount, 0);

  // Cluster de primera compra: cuántas wallets debutaron en el mismo segundo
  // (bundles de snipers / copy-trade — humanos no coordinan al segundo).
  const firstBuyClusters = new Map<number, number>();
  for (const pb of preBuyers) {
    firstBuyClusters.set(pb.firstBuyTs, (firstBuyClusters.get(pb.firstBuyTs) ?? 0) + 1);
  }

  return preBuyers.map((pb) => {
    const perSecond = new Map<number, number>();
    for (const buy of pb.buys) {
      perSecond.set(buy.timestamp, (perSecond.get(buy.timestamp) ?? 0) + 1);
    }
    return {
      wallet: pb.wallet,
      chain: pump.chain,
      pumpEventId: pump.id,
      firstBuyTs: pb.firstBuyTs,
      buyCount: pb.buys.length,
      totalAmount: pb.totalAmount,
      dispersionHours: (pb.lastBuyTs - pb.firstBuyTs) / 3600,
      hoursBeforePump: (pump.pumpStartTs - pb.firstBuyTs) / 3600,
      minutesAfterDeploy:
        pump.pairCreatedAtTs > 0 ? (pb.firstBuyTs - pump.pairCreatedAtTs) / 60 : -1,
      supplyPct: totalBought > 0 ? pb.totalAmount / totalBought : null,
      maxBuysPerSecond: Math.max(...perSecond.values()),
      firstBuyClusterSize: firstBuyClusters.get(pb.firstBuyTs) ?? 1,
    };
  });
}

/** Agrupa compras anteriores a pumpStartTs por wallet. */
export function findPreBuyers(buys: Buy[], pumpStartTs: number): PreBuyerSummary[] {
  const byWallet = new Map<string, Buy[]>();
  for (const buy of buys) {
    if (buy.timestamp >= pumpStartTs) continue;
    const list = byWallet.get(buy.wallet) ?? [];
    list.push(buy);
    byWallet.set(buy.wallet, list);
  }

  const summaries: PreBuyerSummary[] = [];
  for (const [wallet, walletBuys] of byWallet) {
    walletBuys.sort((a, b) => a.timestamp - b.timestamp);
    summaries.push({
      wallet,
      buys: walletBuys,
      firstBuyTs: walletBuys[0]!.timestamp,
      lastBuyTs: walletBuys[walletBuys.length - 1]!.timestamp,
      totalAmount: walletBuys.reduce((acc, b) => acc + toUiAmount(b.rawAmount, b.decimals), 0),
    });
  }
  return summaries.sort((a, b) => a.firstBuyTs - b.firstBuyTs);
}
