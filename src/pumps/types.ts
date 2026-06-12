import type { Chain } from "../chains/types.js";

export interface PumpEvent {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  chain: Chain;
  pairAddress: string;
  dexId: string;
  /**
   * Estimación del inicio del pump (unix seconds).
   * TODO: DexScreener no expone velas en el free tier; hoy se aproxima como
   * snapshot - 24h. Mejorable con datos OHLCV de otra fuente (GeckoTerminal).
   */
  pumpStartTs: number;
  priceChange24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceUsd: number;
  pairCreatedAtTs: number;
  detectedAtTs: number;
}
