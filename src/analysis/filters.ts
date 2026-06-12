import { SNIPER_WINDOW_MINUTES } from "./scoring.js";

/**
 * Heurísticas anti-ruido. PURAS: reciben hechos ya resueltos (por los
 * adapters o la DB) y devuelven flags. No eliminan wallets: los flags se
 * exportan como columnas del CSV para que el usuario decida.
 */

export interface WalletFlags {
  isSniper: boolean;
  isInsiderSuspect: boolean;
  isFreshWallet: boolean;
}

export interface WalletFlagFacts {
  /** Minutos entre el deploy del par y la primera compra (mínimo entre tokens). */
  minMinutesAfterDeploy: number;
  /** Primera tx entrante de la wallet, si se pudo resolver. */
  firstIncomingTx?: { from: string; timestamp: number } | undefined;
  /** Address del deployer del token, si se conoce (lowercase). */
  deployerAddress?: string | undefined;
  /** Timestamp de la primera compra de la wallet (el más viejo entre tokens). */
  earliestBuyTs: number;
  /** Cantidad de transacciones históricas conocidas de la wallet (aprox). */
  knownTxCount?: number | undefined;
}

const FRESH_WALLET_MAX_AGE_DAYS = 7;
const FRESH_WALLET_MAX_TX = 10;

/** Compró dentro de la ventana sniper post-deploy en al menos un token. */
export function isSniper(minMinutesAfterDeploy: number): boolean {
  return minMinutesAfterDeploy >= 0 && minMinutesAfterDeploy <= SNIPER_WINDOW_MINUTES;
}

/** Recibió su primer fondeo directamente desde la wallet del deployer. */
export function isInsiderSuspect(
  firstIncomingTx: { from: string } | undefined,
  deployerAddress: string | undefined,
): boolean {
  if (!firstIncomingTx || !deployerAddress) return false;
  return firstIncomingTx.from.toLowerCase() === deployerAddress.toLowerCase();
}

/** Wallet creada <7 días antes de la compra y casi sin historial. */
export function isFreshWallet(
  firstIncomingTx: { timestamp: number } | undefined,
  earliestBuyTs: number,
  knownTxCount: number | undefined,
): boolean {
  if (!firstIncomingTx) return false;
  const ageDays = (earliestBuyTs - firstIncomingTx.timestamp) / 86_400;
  if (ageDays > FRESH_WALLET_MAX_AGE_DAYS) return false;
  // Si conocemos el historial y es abultado, no es fresca aunque sea joven
  if (knownTxCount !== undefined && knownTxCount > FRESH_WALLET_MAX_TX) return false;
  return true;
}

export function computeFlags(facts: WalletFlagFacts): WalletFlags {
  return {
    isSniper: isSniper(facts.minMinutesAfterDeploy),
    isInsiderSuspect: isInsiderSuspect(facts.firstIncomingTx, facts.deployerAddress),
    isFreshWallet: isFreshWallet(facts.firstIncomingTx, facts.earliestBuyTs, facts.knownTxCount),
  };
}
