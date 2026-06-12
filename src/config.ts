import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // Opcionales en Fase 1: DexScreener no requiere key. Los comandos que las
  // necesiten (analyze) las validan con requireEnv() antes de correr.
  // string vacío en .env (KEY=) se trata como ausente
  ETHERSCAN_API_KEY: z.string().optional().transform((v) => v || undefined),
  HELIUS_API_KEY: z.string().optional().transform((v) => v || undefined),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PUMP_MIN_PRICE_CHANGE_24H: z.coerce.number().positive().default(200),
  PUMP_MIN_VOLUME_24H_USD: z.coerce.number().positive().default(100_000),
  PUMP_MIN_LIQUIDITY_USD: z.coerce.number().positive().default(20_000),
  PUMP_MIN_PAIR_AGE_DAYS: z.coerce.number().nonnegative().default(1),
  PUMP_MAX_PAIR_AGE_DAYS: z.coerce.number().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Variables de entorno inválidas:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

export interface PumpCriteria {
  minPriceChange24hPct: number;
  minVolume24hUsd: number;
  minLiquidityUsd: number;
  minPairAgeDays: number;
  maxPairAgeDays: number;
}

export const pumpCriteria: PumpCriteria = {
  minPriceChange24hPct: env.PUMP_MIN_PRICE_CHANGE_24H,
  minVolume24hUsd: env.PUMP_MIN_VOLUME_24H_USD,
  minLiquidityUsd: env.PUMP_MIN_LIQUIDITY_USD,
  minPairAgeDays: env.PUMP_MIN_PAIR_AGE_DAYS,
  maxPairAgeDays: env.PUMP_MAX_PAIR_AGE_DAYS,
};

/** Valida que una key exista antes de usar un adapter que la requiere. */
export function requireEnv(key: "ETHERSCAN_API_KEY" | "HELIUS_API_KEY"): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Falta ${key} en .env — copiá .env.example a .env y completala.`);
  }
  return value;
}
