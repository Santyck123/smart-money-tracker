import Bottleneck from "bottleneck";
import { z } from "zod";
import { logger } from "../logger.js";
import type { Chain, ChainAdapter, TokenTransfer } from "./types.js";

/**
 * Adapter EVM vía Etherscan API V2 (una key, multichain con `chainid`).
 * Ethereum: chainid=1 — BNB Chain: chainid=56.
 *
 * Límites free tier: 5 req/s y 100k req/día COMPARTIDOS entre chains →
 * el limiter es global (módulo), no por instancia.
 */

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

// Solo chains soportadas por el free tier de Etherscan V2 (probado:
// eth=1, polygon=137, arbitrum=42161 OK; bsc/base/optimism/avax = pago).
const CHAIN_IDS: Partial<Record<Chain, number>> = { eth: 1, bsc: 56, polygon: 137, arbitrum: 42161 };

// 5 req/s compartidos: 1 request cada 220ms con margen, sin concurrencia.
const limiter = new Bottleneck({ minTime: 220, maxConcurrent: 1 });

const MAX_RETRIES = 4;
const PAGE_SIZE = 1000; // máximo razonable de tokentx por página

const tokenTxSchema = z.object({
  hash: z.string(),
  blockNumber: z.coerce.number(),
  timeStamp: z.coerce.number(),
  from: z.string(),
  to: z.string(),
  contractAddress: z.string(),
  value: z.string(),
  tokenDecimal: z.coerce.number(),
});

const responseSchema = z.object({
  status: z.string(),
  message: z.string(),
  result: z.union([z.array(z.unknown()), z.string()]),
});

async function etherscanGet(params: Record<string, string>, apiKey: string): Promise<unknown[]> {
  const url = new URL(ETHERSCAN_V2_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", apiKey);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await limiter.schedule(() => fetch(url));
    if (res.status === 429 || res.status >= 500) {
      const waitMs = 1000 * 2 ** attempt;
      logger.warn({ status: res.status, attempt, waitMs }, "etherscan rate limit/error, backoff");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);

    const body = responseSchema.parse(await res.json());
    // status "0" + "No transactions found" es respuesta válida vacía
    if (body.status === "0" && /no transactions found/i.test(body.message)) return [];
    // Rate limit lógico (HTTP 200 con error en el body)
    if (typeof body.result === "string" && /rate limit/i.test(body.result)) {
      const waitMs = 1000 * 2 ** attempt;
      logger.warn({ attempt, waitMs }, "etherscan rate limit (body), backoff");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (body.status !== "1" || !Array.isArray(body.result)) {
      throw new Error(`Etherscan error: ${body.message} — ${String(body.result).slice(0, 200)}`);
    }
    return body.result;
  }
  throw new Error("Etherscan: agotados los reintentos por rate limit");
}

export class EvmAdapter implements ChainAdapter {
  constructor(
    public readonly chain: Chain,
    private readonly apiKey: string,
  ) {
    if (!(chain in CHAIN_IDS)) throw new Error(`EvmAdapter no soporta chain ${chain}`);
  }

  private get chainId(): number {
    return CHAIN_IDS[this.chain]!;
  }

  /** Resuelve un timestamp al número de bloque más cercano. */
  private async getBlockByTime(ts: number, closest: "before" | "after"): Promise<number | null> {
    try {
      const url = new URL(ETHERSCAN_V2_BASE);
      url.searchParams.set("chainid", String(this.chainId));
      url.searchParams.set("module", "block");
      url.searchParams.set("action", "getblocknobytime");
      url.searchParams.set("timestamp", String(ts));
      url.searchParams.set("closest", closest);
      url.searchParams.set("apikey", this.apiKey);
      const res = await limiter.schedule(() => fetch(url));
      if (!res.ok) return null;
      const body = z.object({ status: z.string(), result: z.unknown() }).parse(await res.json());
      if (body.status !== "1") return null;
      return z.coerce.number().parse(body.result);
    } catch {
      return null;
    }
  }

  /**
   * Transfers ERC-20 del contrato `tokenAddress` entre fromTs y toTs.
   * Resuelve la ventana temporal a bloques (getblocknobytime) y pagina
   * tokentx con startblock/endblock ordenado asc.
   * Límite conocido: máx ~10 páginas x 1000 registros por ventana; para
   * tokens muy activos puede quedar truncada (se loggea warning).
   */
  async getTokenTransfers(tokenAddress: string, fromTs: number, toTs: number): Promise<TokenTransfer[]> {
    const [startBlock, endBlock] = await Promise.all([
      this.getBlockByTime(fromTs, "after"),
      this.getBlockByTime(Math.min(toTs, Math.floor(Date.now() / 1000)), "before"),
    ]);
    if (startBlock === null || endBlock === null) {
      logger.warn({ tokenAddress, chain: this.chain }, "no pude resolver bloques para la ventana, salteo token");
      return [];
    }

    const transfers: TokenTransfer[] = [];
    let page = 1;
    let reachedEnd = false;

    while (!reachedEnd) {
      let rows: unknown[];
      try {
        rows = await etherscanGet(
          {
            chainid: String(this.chainId),
            module: "account",
            action: "tokentx",
            contractaddress: tokenAddress,
            startblock: String(startBlock),
            endblock: String(endBlock),
            page: String(page),
            offset: String(PAGE_SIZE),
            sort: "asc",
          },
          this.apiKey,
        );
      } catch (err) {
        logger.error({ err: String(err), tokenAddress, chain: this.chain, page }, "fallo tokentx, devuelvo lo acumulado");
        break;
      }

      if (rows.length === 0) break;

      for (const row of rows) {
        const parsed = tokenTxSchema.safeParse(row);
        if (!parsed.success) {
          logger.debug({ tokenAddress }, "transfer descartado por schema");
          continue;
        }
        const tx = parsed.data;
        if (tx.timeStamp > toTs) {
          reachedEnd = true;
          break;
        }
        if (tx.timeStamp < fromTs) continue;
        transfers.push({
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          timestamp: tx.timeStamp,
          from: tx.from.toLowerCase(),
          to: tx.to.toLowerCase(),
          tokenAddress: tx.contractAddress.toLowerCase(),
          rawAmount: tx.value,
          decimals: tx.tokenDecimal,
        });
      }

      if (rows.length < PAGE_SIZE) break;
      page++;
      if (page > 10) {
        logger.warn({ tokenAddress, chain: this.chain }, "límite de 10 páginas alcanzado (~10k tx), ventana truncada");
        break;
      }
    }

    logger.info({ tokenAddress, chain: this.chain, transfers: transfers.length }, "transfers obtenidos");
    return transfers;
  }

  /** Primera transacción entrante de una wallet (para detectar insiders/frescura). */
  async getFirstIncomingTx(wallet: string): Promise<{ from: string; timestamp: number } | null> {
    const rows = await etherscanGet(
      {
        chainid: String(this.chainId),
        module: "account",
        action: "txlist",
        address: wallet,
        page: "1",
        offset: "1",
        sort: "asc",
      },
      this.apiKey,
    );
    const first = rows[0];
    if (!first) return null;
    const parsed = z
      .object({ from: z.string(), timeStamp: z.coerce.number() })
      .safeParse(first);
    return parsed.success
      ? { from: parsed.data.from.toLowerCase(), timestamp: parsed.data.timeStamp }
      : null;
  }
}
