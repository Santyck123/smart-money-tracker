import { z } from "zod";
import type { Chain } from "../chains/types.js";
import type { PumpCriteria } from "../config.js";
import { logger } from "../logger.js";
import type { PumpEvent } from "./types.js";

/**
 * Detector de pumps vía DexScreener (sin API key).
 *
 * Limitación documentada: DexScreener no expone un endpoint público de
 * "top pares por chain". Estrategia de candidatos:
 *   1. /token-boosts/top/v1 y /token-profiles/latest/v1 → tokens con actividad
 *   2. /latest/dex/search con queries genéricas por chain
 * Luego cada candidato se valida con datos frescos del par y los criterios
 * de pump configurados.
 */

const DEX_BASE = "https://api.dexscreener.com";

// DexScreener usa estos identificadores de chain
const CHAIN_ID_MAP: Record<Chain, string> = {
  eth: "ethereum",
  bsc: "bsc",
  sol: "solana",
};
const REVERSE_CHAIN_MAP: Record<string, Chain> = {
  ethereum: "eth",
  bsc: "bsc",
  solana: "sol",
};

const pairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  baseToken: z.object({
    address: z.string(),
    name: z.string(),
    symbol: z.string(),
  }),
  priceUsd: z.coerce.number().optional(),
  priceChange: z
    .object({ h24: z.coerce.number().optional() })
    .partial()
    .optional(),
  volume: z
    .object({ h24: z.coerce.number().optional() })
    .partial()
    .optional(),
  liquidity: z
    .object({ usd: z.coerce.number().optional() })
    .partial()
    .optional(),
  pairCreatedAt: z.number().optional(), // ms epoch
});
type DexPair = z.infer<typeof pairSchema>;

const searchResponseSchema = z.object({
  pairs: z.array(z.unknown()).nullable().optional(),
});

const boostSchema = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
});

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`DexScreener ${res.status} en ${url}`);
  }
  return res.json();
}

/** Parsea pares tolerando entradas malformadas: descarta, no aborta. */
function parsePairs(raw: unknown[]): DexPair[] {
  const out: DexPair[] = [];
  for (const item of raw) {
    const parsed = pairSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else logger.debug({ issues: parsed.error.issues.length }, "par descartado por schema");
  }
  return out;
}

/** Candidatos desde token-boosts y token-profiles. Devuelve direcciones por chain. */
async function fetchBoostedCandidates(chains: Chain[]): Promise<Map<Chain, Set<string>>> {
  const wanted = new Set(chains.map((c) => CHAIN_ID_MAP[c]));
  const result = new Map<Chain, Set<string>>(chains.map((c) => [c, new Set<string>()]));

  for (const path of ["/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"]) {
    try {
      const data = await fetchJson(`${DEX_BASE}${path}`);
      const items = z.array(z.unknown()).parse(data);
      for (const item of items) {
        const parsed = boostSchema.safeParse(item);
        if (!parsed.success || !wanted.has(parsed.data.chainId)) continue;
        const chain = REVERSE_CHAIN_MAP[parsed.data.chainId];
        if (chain) result.get(chain)?.add(parsed.data.tokenAddress);
      }
    } catch (err) {
      logger.warn({ err: String(err), path }, "fallo una fuente de candidatos, continúo");
    }
  }
  return result;
}

/** Trae los pares de una lista de tokens (endpoint batch: hasta 30 por request). */
async function fetchPairsForTokens(chain: Chain, tokens: string[]): Promise<DexPair[]> {
  const pairs: DexPair[] = [];
  for (let i = 0; i < tokens.length; i += 30) {
    const batch = tokens.slice(i, i + 30);
    try {
      const data = await fetchJson(`${DEX_BASE}/tokens/v1/${CHAIN_ID_MAP[chain]}/${batch.join(",")}`);
      const items = z.array(z.unknown()).parse(data);
      pairs.push(...parsePairs(items));
    } catch (err) {
      logger.warn({ err: String(err), chain, batchSize: batch.length }, "fallo batch de tokens, continúo");
    }
  }
  return pairs;
}

/** Candidatos extra vía búsqueda genérica (devuelve pares directamente). */
async function fetchSearchCandidates(chains: Chain[]): Promise<DexPair[]> {
  const wanted = new Set(chains.map((c) => CHAIN_ID_MAP[c]));
  const pairs: DexPair[] = [];
  // Queries genéricas que devuelven muchos pares activos por quote token
  const queries = ["WETH", "WBNB", "SOL", "USDC", "USDT"];
  for (const q of queries) {
    try {
      const data = await fetchJson(`${DEX_BASE}/latest/dex/search?q=${q}`);
      const parsed = searchResponseSchema.parse(data);
      const found = parsePairs(parsed.pairs ?? []);
      pairs.push(...found.filter((p) => wanted.has(p.chainId)));
    } catch (err) {
      logger.warn({ err: String(err), q }, "fallo búsqueda, continúo");
    }
  }
  return pairs;
}

// ---- GeckoTerminal (sin key, ~30 req/min): segunda fuente de candidatos ----
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_MAP: Record<Chain, string> = { eth: "eth", bsc: "bsc", sol: "solana" };

const geckoPoolSchema = z.object({
  attributes: z.object({
    address: z.string(),
    name: z.string().optional(),
    base_token_price_usd: z.coerce.number().nullable().optional(),
    pool_created_at: z.string().nullable().optional(),
    reserve_in_usd: z.coerce.number().nullable().optional(),
    price_change_percentage: z.object({ h24: z.coerce.number().nullable().optional() }).partial().optional(),
    volume_usd: z.object({ h24: z.coerce.number().nullable().optional() }).partial().optional(),
  }),
  relationships: z.object({
    base_token: z.object({ data: z.object({ id: z.string() }) }),
  }),
});

/** Mapea un pool de GeckoTerminal al mismo shape DexPair del resto del detector. */
function geckoPoolToPair(raw: unknown, chain: Chain): DexPair | null {
  const parsed = geckoPoolSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data.attributes;
  // base_token.data.id viene como "solana_<mint>" / "eth_0x..."
  const tokenAddress = parsed.data.relationships.base_token.data.id.replace(/^[^_]+_/, "");
  const symbol = a.name?.split("/")[0]?.trim() ?? tokenAddress.slice(0, 8);
  return {
    chainId: CHAIN_ID_MAP[chain],
    dexId: "geckoterminal",
    pairAddress: a.address,
    baseToken: { address: tokenAddress, name: symbol, symbol },
    ...(a.base_token_price_usd != null ? { priceUsd: a.base_token_price_usd } : {}),
    priceChange: { h24: a.price_change_percentage?.h24 ?? undefined },
    volume: { h24: a.volume_usd?.h24 ?? undefined },
    liquidity: { usd: a.reserve_in_usd ?? undefined },
    ...(a.pool_created_at ? { pairCreatedAt: Date.parse(a.pool_created_at) } : {}),
  };
}

/** Trending + new pools de GeckoTerminal por chain. */
async function fetchGeckoCandidates(chains: Chain[]): Promise<DexPair[]> {
  const pairs: DexPair[] = [];
  for (const chain of chains) {
    const network = GECKO_NETWORK_MAP[chain];
    for (const endpoint of [`trending_pools`, `new_pools`]) {
      try {
        const data = await fetchJson(`${GECKO_BASE}/networks/${network}/${endpoint}?page=1`);
        const body = z.object({ data: z.array(z.unknown()) }).parse(data);
        for (const raw of body.data) {
          const pair = geckoPoolToPair(raw, chain);
          if (pair) pairs.push(pair);
        }
      } catch (err) {
        logger.warn({ err: String(err), chain, endpoint }, "fallo fuente GeckoTerminal, continúo");
      }
    }
  }
  logger.info({ candidates: pairs.length }, "candidatos de GeckoTerminal");
  return pairs;
}

function passesCriteria(pair: DexPair, criteria: PumpCriteria, nowMs: number): boolean {
  const change = pair.priceChange?.h24;
  const volume = pair.volume?.h24;
  const liquidity = pair.liquidity?.usd;
  const createdAt = pair.pairCreatedAt;
  if (change === undefined || volume === undefined || liquidity === undefined || createdAt === undefined) {
    return false;
  }
  const ageDays = (nowMs - createdAt) / 86_400_000;
  return (
    change >= criteria.minPriceChange24hPct &&
    volume >= criteria.minVolume24hUsd &&
    liquidity >= criteria.minLiquidityUsd &&
    ageDays >= criteria.minPairAgeDays &&
    ageDays <= criteria.maxPairAgeDays
  );
}

function toPumpEvent(pair: DexPair, nowMs: number): PumpEvent {
  const chain = REVERSE_CHAIN_MAP[pair.chainId];
  if (!chain) throw new Error(`chain desconocida: ${pair.chainId}`);
  const nowTs = Math.floor(nowMs / 1000);
  const createdTs = Math.floor((pair.pairCreatedAt ?? 0) / 1000);
  // TODO: aproximación sin velas. Para pares con >24h de vida: snapshot - 24h.
  // Para pares más jóvenes, la mitad de la vida del par: la primera mitad se
  // considera acumulación y la segunda el pump. Mejorable con OHLCV externo.
  const pumpStartTs =
    createdTs > 0 && nowTs - createdTs < 86_400
      ? createdTs + Math.floor((nowTs - createdTs) / 2)
      : nowTs - 86_400;
  return {
    tokenAddress: pair.baseToken.address,
    tokenSymbol: pair.baseToken.symbol,
    tokenName: pair.baseToken.name,
    chain,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    pumpStartTs,
    priceChange24hPct: pair.priceChange?.h24 ?? 0,
    volume24hUsd: pair.volume?.h24 ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    priceUsd: pair.priceUsd ?? 0,
    pairCreatedAtTs: Math.floor((pair.pairCreatedAt ?? 0) / 1000),
    detectedAtTs: nowTs,
  };
}

export async function detectPumps(
  chains: Chain[],
  criteria: PumpCriteria,
  maxTokens: number,
): Promise<PumpEvent[]> {
  const nowMs = Date.now();
  logger.info({ chains, criteria }, "buscando candidatos en DexScreener");

  const [boosted, searchPairs, geckoPairs] = await Promise.all([
    fetchBoostedCandidates(chains),
    fetchSearchCandidates(chains),
    fetchGeckoCandidates(chains),
  ]);

  // Resolver pares de los tokens boosted
  const allPairs: DexPair[] = [...searchPairs, ...geckoPairs];
  for (const [chain, tokens] of boosted) {
    if (tokens.size === 0) continue;
    allPairs.push(...(await fetchPairsForTokens(chain, [...tokens])));
  }
  logger.info({ candidates: allPairs.length }, "candidatos recolectados");

  // Filtrar por criterios y deduplicar por token (mejor par por liquidez)
  const byToken = new Map<string, DexPair>();
  for (const pair of allPairs) {
    if (!passesCriteria(pair, criteria, nowMs)) continue;
    const key = `${pair.chainId}:${pair.baseToken.address}`;
    const existing = byToken.get(key);
    if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
      byToken.set(key, pair);
    }
  }

  const events = [...byToken.values()]
    .sort((a, b) => (b.priceChange?.h24 ?? 0) - (a.priceChange?.h24 ?? 0))
    .slice(0, maxTokens)
    .map((p) => toPumpEvent(p, nowMs));

  logger.info({ pumps: events.length }, "pumps detectados");
  return events;
}
