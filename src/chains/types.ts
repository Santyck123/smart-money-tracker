export type Chain = "eth" | "bsc" | "sol";

export interface TokenTransfer {
  txHash: string;
  blockNumber: number;
  timestamp: number; // unix seconds
  from: string;
  to: string;
  tokenAddress: string;
  /** Cantidad en unidades enteras del token (raw, sin dividir por decimals). */
  rawAmount: string;
  decimals: number;
}

export interface Swap {
  txHash: string;
  timestamp: number;
  wallet: string;
  tokenAddress: string;
  side: "buy" | "sell";
  rawAmount: string;
  decimals: number;
}

/**
 * Interfaz común para EVM (Etherscan V2) y Solana (Helius).
 * Toda la lógica de análisis es chain-agnostic y consume esta interfaz.
 */
export interface ChainAdapter {
  readonly chain: Chain;
  /**
   * Transfers del token en la ventana [fromTs, toTs].
   * `pairAddress` es un hint opcional: en Solana las transacciones se
   * consultan por el pool del par (el mint no aparece en todos los swaps).
   */
  getTokenTransfers(
    tokenAddress: string,
    fromTs: number,
    toTs: number,
    pairAddress?: string,
  ): Promise<TokenTransfer[]>;
}
