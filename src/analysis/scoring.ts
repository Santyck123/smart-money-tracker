/**
 * Scoring de wallets pre-buyers. PURO: sin I/O, totalmente testeable.
 *
 * Score 0-100 ponderado:
 *  - Timing (30%): cuánto antes del pump compró. Más temprano = mejor,
 *    pero comprar en los primeros minutos post-deploy huele a sniper/insider
 *    y se penaliza fuerte.
 *  - Tamaño relativo (25%): % del supply circulante comprado, normalizado
 *    con log para que las whales no dominen.
 *  - Acumulación (20%): varias compras espaciadas > una sola compra.
 *  - Recurrencia (25%): en cuántos tokens pumpeados distintos aparece como
 *    pre-buyer. 1 = ruido, 3+ = smart money probable.
 */

export interface ScoringWeights {
  timing: number;
  size: number;
  accumulation: number;
  recurrence: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  timing: 0.3,
  size: 0.25,
  accumulation: 0.2,
  recurrence: 0.25,
};

export interface WalletTokenStats {
  /** Horas entre la primera compra y el inicio del pump. */
  hoursBeforePump: number;
  /** Minutos entre el deploy del par y la primera compra. */
  minutesAfterDeploy: number;
  /** Cantidad de compras antes del pump. */
  buyCount: number;
  /** Horas entre la primera y la última compra pre-pump. */
  dispersionHours: number;
  /** Fracción del supply circulante comprada (0-1). NaN/undefined si no se conoce. */
  supplyPctBought?: number | undefined;
  /** Máximo de compras de esta wallet en un mismo segundo. */
  maxBuysPerSecond?: number | undefined;
  /** Cuántas wallets (incluida esta) hicieron su primera compra en el mismo segundo. */
  firstBuyClusterSize?: number | undefined;
}

/** Señales de bot por token:
 *  - ≥3 compras en el mismo segundo (bundler / multi-swap atómico)
 *  - ≥3 compras con dispersión ~nula (ráfaga programática)
 *  - primera compra en el mismo segundo que ≥8 wallets más (bundle de snipers
 *    o copy-trade masivo: humanos no coordinan al segundo)
 */
export function isBotTokenStats(t: WalletTokenStats): boolean {
  if ((t.maxBuysPerSecond ?? 0) >= 3) return true;
  if (t.buyCount >= 3 && t.dispersionHours <= 0.005) return true;
  if ((t.firstBuyClusterSize ?? 0) >= 8) return true;
  return false;
}

/** Penalización al score total cuando la mayoría de las apariciones son bot-like. */
const BOT_PENALTY_FACTOR = 0.25;

/** Ventana post-deploy considerada sospechosa de sniper (minutos). */
export const SNIPER_WINDOW_MINUTES = 5;
/** Horizonte de timing: comprar ≥48h antes del pump satura el componente. */
const TIMING_HORIZON_HOURS = 48;
/** 2% del supply o más satura el componente de tamaño. */
const SIZE_SATURATION_PCT = 0.02;
/** 5 compras o más saturan el sub-componente de cantidad. */
const BUYS_SATURATION = 5;
/** 24h de dispersión saturan el sub-componente temporal. */
const DISPERSION_SATURATION_HOURS = 24;
/** 4 tokens distintos saturan la recurrencia. */
const RECURRENCE_SATURATION = 4;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Timing 0-1: lineal hasta el horizonte; penaliza compras en ventana sniper. */
export function timingScore(hoursBeforePump: number, minutesAfterDeploy: number): number {
  const base = clamp01(hoursBeforePump / TIMING_HORIZON_HOURS);
  if (minutesAfterDeploy >= 0 && minutesAfterDeploy <= SNIPER_WINDOW_MINUTES) {
    return base * 0.15; // sniper probable: casi todo el crédito anulado
  }
  return base;
}

/** Tamaño 0-1: log-normalizado, satura en SIZE_SATURATION_PCT del supply. */
export function sizeScore(supplyPctBought: number | undefined): number {
  if (supplyPctBought === undefined || !Number.isFinite(supplyPctBought) || supplyPctBought <= 0) {
    return 0;
  }
  return clamp01(Math.log1p(supplyPctBought * 1000) / Math.log1p(SIZE_SATURATION_PCT * 1000));
}

/** Acumulación 0-1: 60% cantidad de compras, 40% dispersión temporal. */
export function accumulationScore(buyCount: number, dispersionHours: number): number {
  if (buyCount <= 1) return 0;
  const countPart = clamp01((buyCount - 1) / (BUYS_SATURATION - 1));
  const dispersionPart = clamp01(dispersionHours / DISPERSION_SATURATION_HOURS);
  return 0.6 * countPart + 0.4 * dispersionPart;
}

/** Recurrencia 0-1: 1 token = 0, crece hasta saturar en RECURRENCE_SATURATION. */
export function recurrenceScore(tokensHitCount: number): number {
  if (tokensHitCount <= 1) return 0;
  return clamp01((tokensHitCount - 1) / (RECURRENCE_SATURATION - 1));
}

export interface WalletScoreInput {
  /** Stats por token donde la wallet fue pre-buyer (corrida actual + histórico). */
  perToken: WalletTokenStats[];
}

export interface WalletScoreResult {
  score: number; // 0-100
  components: { timing: number; size: number; accumulation: number; recurrence: number };
  tokensHitCount: number;
  avgHoursBeforePump: number;
  avgSupplyPct: number;
  avgBuyCount: number;
  /** true si la mayoría de las apariciones tienen señales de bot (score ya penalizado). */
  isBotSuspect: boolean;
}

/** Score final: promedia los componentes por-token y agrega recurrencia. */
export function scoreWallet(
  input: WalletScoreInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): WalletScoreResult {
  const tokens = input.perToken;
  if (tokens.length === 0) {
    return {
      score: 0,
      components: { timing: 0, size: 0, accumulation: 0, recurrence: 0 },
      tokensHitCount: 0,
      avgHoursBeforePump: 0,
      avgSupplyPct: 0,
      avgBuyCount: 0,
      isBotSuspect: false,
    };
  }

  const avg = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

  const timing = avg(tokens.map((t) => timingScore(t.hoursBeforePump, t.minutesAfterDeploy)));
  const size = avg(tokens.map((t) => sizeScore(t.supplyPctBought)));
  const accumulation = avg(tokens.map((t) => accumulationScore(t.buyCount, t.dispersionHours)));
  const recurrence = recurrenceScore(tokens.length);

  const total =
    weights.timing * timing +
    weights.size * size +
    weights.accumulation * accumulation +
    weights.recurrence * recurrence;
  const weightSum = weights.timing + weights.size + weights.accumulation + weights.recurrence;

  const botHits = tokens.filter(isBotTokenStats).length;
  const isBotSuspect = botHits / tokens.length >= 0.5;
  const penalty = isBotSuspect ? BOT_PENALTY_FACTOR : 1;

  return {
    score: Math.round((total / weightSum) * 100 * penalty * 10) / 10,
    components: { timing, size, accumulation, recurrence },
    tokensHitCount: tokens.length,
    avgHoursBeforePump: avg(tokens.map((t) => t.hoursBeforePump)),
    avgSupplyPct: avg(tokens.map((t) => t.supplyPctBought ?? 0)),
    avgBuyCount: avg(tokens.map((t) => t.buyCount)),
    isBotSuspect,
  };
}
