import Bottleneck from "bottleneck";
import { z } from "zod";
import { logger } from "../logger.js";
import type { Chain, ChainAdapter, TokenTransfer } from "./types.js";

/**
 * Adapter Solana vía Helius (RPC + Enhanced Transactions API).
 *
 * Estrategia en dos pasos para no quemar el free tier:
 *  1. RPC `getSignaturesForAddress` sobre el POOL del par: pagina hacia atrás
 *     1000 firmas por request (baratas) hasta pasar `fromTs`. Solo guarda las
 *     firmas cuyo blockTime cae dentro de la ventana [fromTs, toTs].
 *  2. `POST /v0/transactions` (Enhanced API): parsea SOLO esas firmas en
 *     lotes de 100 y extrae los tokenTransfers del mint objetivo.
 *
 * El mint no sirve como address de consulta porque no todos los swaps lo
 * referencian en las account keys; el pool sí participa en cada swap.
 *
 * Free tier: ~10 req/s. Limiter conservador + backoff exponencial ante 429.
 *
 * Nota de unidades: la Enhanced API devuelve `tokenAmount` ya ajustado por
 * decimals (float UI). Se persiste como rawAmount con decimals=0 — el
 * scoring usa tamaños relativos (con log), así que es consistente dentro
 * de cada token.
 */

// ~10 req/s free tier → 1 req cada 150ms con margen
const limiter = new Bottleneck({ minTime: 150, maxConcurrent: 1 });

const MAX_RETRIES = 5;
const SIG_PAGE_LIMIT = 1000;
const MAX_SIG_PAGES = 200; // hasta 200k firmas recorridas por token
const PARSE_BATCH = 100;
const MAX_PARSED_TXS = 5000; // tope de txs parseadas por token (50 requests)

const signatureInfoSchema = z.object({
  signature: z.string(),
  blockTime: z.number().nullable().optional(),
  err: z.unknown().nullable().optional(),
});

const tokenTransferSchema = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  mint: z.string(),
  tokenAmount: z.number(),
});

const enhancedTxSchema = z.object({
  signature: z.string(),
  slot: z.number(),
  timestamp: z.number(),
  transactionError: z.unknown().nullable().optional(),
  tokenTransfers: z.array(z.unknown()).nullable().optional(),
});

async function fetchWithRetry(input: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await limiter.schedule(() => fetch(input, init));
    if (res.status === 429 || res.status >= 500) {
      const waitMs = 1000 * 2 ** attempt;
      logger.warn({ status: res.status, attempt, waitMs, label }, "helius rate limit/error, backoff");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
  throw new Error(`Helius: agotados los reintentos por rate limit (${label})`);
}

export class SolanaAdapter implements ChainAdapter {
  public readonly chain: Chain = "sol";
  private readonly rpcUrl: string;
  private readonly apiBase: string;

  constructor(private readonly apiKey: string) {
    this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    this.apiBase = `https://api.helius.xyz`;
  }

  /** Paso 1: firmas del pool dentro de la ventana, paginando hacia atrás. */
  private async getSignaturesInWindow(address: string, fromTs: number, toTs: number): Promise<string[]> {
    const signatures: string[] = [];
    let before: string | undefined;
    let pages = 0;

    while (pages < MAX_SIG_PAGES) {
      const res = await fetchWithRetry(
        this.rpcUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSignaturesForAddress",
            params: [address, { limit: SIG_PAGE_LIMIT, ...(before ? { before } : {}) }],
          }),
        },
        "getSignaturesForAddress",
      );
      if (!res.ok) throw new Error(`Helius RPC HTTP ${res.status}`);
      const body = z.object({ result: z.array(z.unknown()).nullable() }).parse(await res.json());
      const infos = (body.result ?? [])
        .map((i) => signatureInfoSchema.safeParse(i))
        .filter((p) => p.success)
        .map((p) => p.data);
      if (infos.length === 0) break;
      pages++;

      let pastWindow = false;
      for (const info of infos) {
        const ts = info.blockTime ?? 0;
        if (ts !== 0 && ts < fromTs) {
          pastWindow = true;
          break;
        }
        if (info.err == null && ts >= fromTs && ts <= toTs) signatures.push(info.signature);
      }
      if (pastWindow || infos.length < SIG_PAGE_LIMIT) break;
      before = infos[infos.length - 1]!.signature;
    }

    if (pages >= MAX_SIG_PAGES) {
      logger.warn({ address, pages }, "tope de páginas de firmas alcanzado, ventana truncada");
    }
    logger.info({ address, signatures: signatures.length, sigPages: pages }, "firmas en ventana");
    return signatures;
  }

  /** Paso 2: parseo en lotes de las firmas seleccionadas. */
  private async parseTransactions(signatures: string[], tokenAddress: string): Promise<TokenTransfer[]> {
    const transfers: TokenTransfer[] = [];
    // Las firmas vienen newest→oldest; se invierten para que, si hay que
    // truncar, sobrevivan las MÁS VIEJAS (las pre-pump, que son las que
    // importan para detectar pre-buyers).
    const toParse = [...signatures].reverse().slice(0, MAX_PARSED_TXS);
    if (signatures.length > MAX_PARSED_TXS) {
      logger.warn(
        { total: signatures.length, cap: MAX_PARSED_TXS },
        "demasiadas txs en ventana, parseo truncado a las más viejas",
      );
    }

    for (let i = 0; i < toParse.length; i += PARSE_BATCH) {
      const batch = toParse.slice(i, i + PARSE_BATCH);
      let res: Response;
      try {
        res = await fetchWithRetry(
          `${this.apiBase}/v0/transactions?api-key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ transactions: batch }),
          },
          "parseTransactions",
        );
      } catch (err) {
        logger.error({ err: String(err), batchStart: i }, "fallo lote de parseo, continúo con el resto");
        continue;
      }
      if (!res.ok) {
        logger.error({ status: res.status, batchStart: i }, "lote de parseo rechazado, continúo");
        continue;
      }
      const items = z.array(z.unknown()).parse(await res.json());
      for (const item of items) {
        const parsed = enhancedTxSchema.safeParse(item);
        if (!parsed.success || parsed.data.transactionError) continue;
        const tx = parsed.data;
        for (const raw of tx.tokenTransfers ?? []) {
          const tt = tokenTransferSchema.safeParse(raw);
          if (!tt.success) continue;
          if (tt.data.mint !== tokenAddress || tt.data.tokenAmount === 0) continue;
          transfers.push({
            txHash: tx.signature,
            blockNumber: tx.slot,
            timestamp: tx.timestamp,
            from: tt.data.fromUserAccount ?? "",
            to: tt.data.toUserAccount ?? "",
            tokenAddress: tt.data.mint,
            rawAmount: String(tt.data.tokenAmount),
            decimals: 0,
          });
        }
      }
    }
    return transfers;
  }

  /**
   * Primera tx conocida de una wallet + tamaño aproximado de su historial.
   * Barato: 1 sola página de firmas. Si la wallet tiene ≥1000 txs solo se
   * sabe que NO es fresca (firstTs=null, txCount=1000).
   * El funder (from) no se resuelve en Solana — TODO: parsear la primera tx.
   */
  async getWalletFirstTx(wallet: string): Promise<{ timestamp: number | null; txCount: number } | null> {
    try {
      const res = await fetchWithRetry(
        this.rpcUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSignaturesForAddress",
            params: [wallet, { limit: SIG_PAGE_LIMIT }],
          }),
        },
        "getWalletFirstTx",
      );
      if (!res.ok) return null;
      const body = z.object({ result: z.array(z.unknown()).nullable() }).parse(await res.json());
      const infos = (body.result ?? [])
        .map((i) => signatureInfoSchema.safeParse(i))
        .filter((p) => p.success)
        .map((p) => p.data);
      if (infos.length === 0) return { timestamp: null, txCount: 0 };
      if (infos.length >= SIG_PAGE_LIMIT) return { timestamp: null, txCount: SIG_PAGE_LIMIT };
      return { timestamp: infos[infos.length - 1]!.blockTime ?? null, txCount: infos.length };
    } catch (err) {
      logger.debug({ err: String(err), wallet }, "fallo getWalletFirstTx");
      return null;
    }
  }

  async getTokenTransfers(
    tokenAddress: string,
    fromTs: number,
    toTs: number,
    pairAddress?: string,
  ): Promise<TokenTransfer[]> {
    const queryAddress = pairAddress ?? tokenAddress;
    const signatures = await this.getSignaturesInWindow(queryAddress, fromTs, toTs);
    const transfers = await this.parseTransactions(signatures, tokenAddress);
    logger.info({ tokenAddress, chain: this.chain, transfers: transfers.length }, "transfers obtenidos");
    return transfers;
  }
}
