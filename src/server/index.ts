import "./chdir.js";
import express, { type Request, type Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { listPumpEvents, listAllWalletStats } from "../storage/db.js";
import { scoreWallet } from "../analysis/scoring.js";

/**
 * Panel web local: dispara el pipeline como proceso hijo, streamea sus logs
 * por SSE y al terminar expone resultados (tokens + wallets) y el CSV.
 *
 * npm run panel → http://localhost:3000
 */

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = path.resolve(".");
const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(ROOT, "output");

/** Si está seteado, /api/run exige header Authorization: Bearer <token>.
 *  Imprescindible cuando el server queda expuesto a internet (deploy 24/7). */
const API_TOKEN = process.env.API_TOKEN;

/** Corridas automáticas cada N horas (0 o vacío = desactivado).
 *  Alternativa sin n8n para tener el pipeline corriendo solo. */
const RUN_INTERVAL_HOURS = Number(process.env.RUN_INTERVAL_HOURS ?? 0);

const runParamsSchema = z.object({
  chains: z.string().regex(/^(eth|bsc|sol)(,(eth|bsc|sol))*$/).default("sol"),
  maxTokens: z.coerce.number().int().min(1).max(100).default(20),
  minPriceChange: z.coerce.number().positive().default(200),
  minVolume: z.coerce.number().positive().default(100_000),
  minLiquidity: z.coerce.number().positive().default(20_000),
  minAgeDays: z.coerce.number().nonnegative().default(0.1),
  maxAgeDays: z.coerce.number().positive().default(30),
  lookbackHours: z.coerce.number().int().min(1).max(168).default(72),
});

// ---- Estado del job (uno por vez) ----
interface Job {
  child: ChildProcess;
  startedAt: number;
  lines: string[];
  status: "running" | "done" | "error";
  exitCode: number | null;
}
let job: Job | null = null;
const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function startJob(params: z.infer<typeof runParamsSchema>): void {
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const args = [
    tsxCli,
    "src/cli.ts",
    "pipeline",
    "--chains",
    params.chains,
    "--max-tokens",
    String(params.maxTokens),
    "--lookback-hours",
    String(params.lookbackHours),
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      PUMP_MIN_PRICE_CHANGE_24H: String(params.minPriceChange),
      PUMP_MIN_VOLUME_24H_USD: String(params.minVolume),
      PUMP_MIN_LIQUIDITY_USD: String(params.minLiquidity),
      PUMP_MIN_PAIR_AGE_DAYS: String(params.minAgeDays),
      PUMP_MAX_PAIR_AGE_DAYS: String(params.maxAgeDays),
    },
  });

  job = { child, startedAt: Date.now(), lines: [], status: "running", exitCode: null };
  broadcast("status", { status: "running", params });

  const onData = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      job?.lines.push(line);
      broadcast("log", { line });
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", (code) => {
    if (job) {
      job.status = code === 0 ? "done" : "error";
      job.exitCode = code;
    }
    broadcast("status", { status: code === 0 ? "done" : "error", exitCode: code });
  });
}

function latestCsv(): string | null {
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith("smart-wallets-") && f.endsWith(".csv"))
    .sort()
    .reverse();
  return files[0] ? path.join(OUTPUT_DIR, files[0]) : null;
}

// ---- HTTP ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, "public")));

app.post("/api/run", (req: Request, res: Response) => {
  if (API_TOKEN && req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    res.status(401).json({ error: "token inválido" });
    return;
  }
  if (job?.status === "running") {
    res.status(409).json({ error: "ya hay una búsqueda corriendo" });
    return;
  }
  const parsed = runParamsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "parámetros inválidos", issues: parsed.error.issues });
    return;
  }
  startJob(parsed.data);
  res.json({ ok: true });
});

/** Estado del job para que un orquestador externo (n8n) pueda pollear. */
app.get("/api/status", (_req: Request, res: Response) => {
  res.json(
    job
      ? { status: job.status, exitCode: job.exitCode, startedAt: job.startedAt, logLines: job.lines.length }
      : { status: "idle" },
  );
});

app.get("/api/logs", (req: Request, res: Response) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // replay del job actual para clientes que se conectan tarde
  if (job) {
    res.write(`event: status\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`);
    for (const line of job.lines) res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
  }
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/results", (_req: Request, res: Response) => {
  const pumps = listPumpEvents().map((p) => ({
    symbol: p.tokenSymbol,
    name: p.tokenName,
    chain: p.chain,
    priceChange24hPct: p.priceChange24hPct,
    volume24hUsd: p.volume24hUsd,
    liquidityUsd: p.liquidityUsd,
    tokenAddress: p.tokenAddress,
    detectedAt: p.detectedAtTs,
  }));

  const byWallet = new Map<string, ReturnType<typeof listAllWalletStats>>();
  for (const row of listAllWalletStats()) {
    const list = byWallet.get(row.wallet) ?? [];
    list.push(row);
    byWallet.set(row.wallet, list);
  }
  const pumpsById = new Map(listPumpEvents().map((p) => [p.id, p]));
  const wallets = [...byWallet.entries()]
    .map(([wallet, rows]) => {
      const s = scoreWallet({
        perToken: rows.map((r) => ({
          hoursBeforePump: r.hoursBeforePump,
          minutesAfterDeploy: r.minutesAfterDeploy,
          buyCount: r.buyCount,
          dispersionHours: r.dispersionHours,
          supplyPctBought: r.supplyPct ?? undefined,
          maxBuysPerSecond: r.maxBuysPerSecond,
          firstBuyClusterSize: r.firstBuyClusterSize,
        })),
      });
      const minMinutes = Math.min(...rows.map((r) => (r.minutesAfterDeploy < 0 ? Infinity : r.minutesAfterDeploy)));
      return {
        wallet,
        chain: rows[0]!.chain,
        score: s.score,
        isBotSuspect: s.isBotSuspect,
        isSniper: Number.isFinite(minMinutes) && minMinutes <= 5,
        tokensHitCount: s.tokensHitCount,
        avgHoursBeforePump: Math.round(s.avgHoursBeforePump * 10) / 10,
        avgBuyCount: Math.round(s.avgBuyCount * 10) / 10,
        avgSupplyPct: Math.round(s.avgSupplyPct * 10000) / 100,
        tokens: rows.map((r) => pumpsById.get(r.pumpEventId)?.tokenSymbol ?? "?").join("|"),
      };
    })
    .sort((a, b) => b.score - a.score);

  const totals = {
    wallets: wallets.length,
    bots: wallets.filter((w) => w.isBotSuspect).length,
    recurrent: wallets.filter((w) => w.tokensHitCount >= 2).length,
  };

  const csv = latestCsv();
  res.json({ pumps, wallets: wallets.slice(0, 200), totals, csvFile: csv ? path.basename(csv) : null });
});

app.get("/api/csv", (_req: Request, res: Response) => {
  const csv = latestCsv();
  if (!csv) {
    res.status(404).json({ error: "todavía no hay CSV generado" });
    return;
  }
  res.setHeader("content-disposition", `attachment; filename="${path.basename(csv)}"`);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.send(readFileSync(csv, "utf8"));
});

app.listen(PORT, () => {
  logger.info({ url: `http://localhost:${PORT}` }, "panel corriendo");
  if (RUN_INTERVAL_HOURS > 0) {
    logger.info({ intervalHours: RUN_INTERVAL_HOURS }, "scheduler interno activado");
    const tick = (): void => {
      if (job?.status === "running") {
        logger.warn("scheduler: ya hay un job corriendo, salteo esta corrida");
        return;
      }
      logger.info("scheduler: disparando pipeline programado");
      startJob(runParamsSchema.parse({}));
    };
    setInterval(tick, RUN_INTERVAL_HOURS * 3600 * 1000);
    tick(); // primera corrida al arrancar
  }
});
