import { Command } from "commander";
import { pumpCriteria } from "./config.js";
import { logger } from "./logger.js";
import { detectPumps } from "./pumps/detector.js";
import { insertPumpEvents, listPumpEvents } from "./storage/db.js";
import type { Chain } from "./chains/types.js";

const VALID_CHAINS: Chain[] = ["eth", "bsc", "sol", "polygon", "arbitrum"];

function parseChains(value: string): Chain[] {
  const chains = value.split(",").map((c) => c.trim().toLowerCase()) as Chain[];
  const invalid = chains.filter((c) => !VALID_CHAINS.includes(c));
  if (invalid.length > 0) {
    throw new Error(`Chains inválidas: ${invalid.join(", ")}. Válidas: ${VALID_CHAINS.join(", ")}`);
  }
  return chains;
}

const program = new Command()
  .name("smart-money-tracker")
  .description("Detecta pumps y rankea wallets smart money");

program
  .command("scan")
  .description("Detecta tokens pumpeados vía DexScreener y los guarda en SQLite")
  .option("--chains <chains>", "chains separadas por coma: eth,bsc,sol", "eth,bsc,sol")
  .option("--max-tokens <n>", "máximo de tokens a guardar", "30")
  .action(async (opts: { chains: string; maxTokens: string }) => {
    const chains = parseChains(opts.chains);
    const maxTokens = Number.parseInt(opts.maxTokens, 10);
    const events = await detectPumps(chains, pumpCriteria, maxTokens);
    const saved = insertPumpEvents(events);
    logger.info({ saved }, "pumps guardados en SQLite");
    for (const e of events) {
      logger.info(
        {
          chain: e.chain,
          symbol: e.tokenSymbol,
          change: `+${e.priceChange24hPct.toFixed(0)}%`,
          vol: `$${Math.round(e.volume24hUsd).toLocaleString()}`,
          liq: `$${Math.round(e.liquidityUsd).toLocaleString()}`,
          token: e.tokenAddress,
        },
        "pump",
      );
    }
  });

program
  .command("analyze")
  .description("Reconstruye transfers de pumps pendientes y detecta pre-buyers")
  .option("--lookback-hours <n>", "horas hacia atrás desde pumpStart a reconstruir", "72")
  .action(async (opts: { lookbackHours: string }) => {
    const { runAnalyze } = await import("./analysis/run.js");
    await runAnalyze(Number.parseInt(opts.lookbackHours, 10));
  });

program
  .command("export")
  .description("Genera el CSV rankeado en output/")
  .option("--min-score <n>", "score mínimo para incluir en el CSV", "0")
  .option("--no-flags", "no enriquecer flags vía API (más rápido)")
  .action(async (opts: { minScore: string; flags: boolean }) => {
    const { runExport } = await import("./export/csv.js");
    const outPath = await runExport(Number.parseFloat(opts.minScore), opts.flags);
    logger.info({ outPath }, "export terminado");
  });

program
  .command("pipeline")
  .description("scan + analyze + export, todo junto")
  .option("--chains <chains>", "chains separadas por coma", "eth,bsc,sol")
  .option("--max-tokens <n>", "máximo de tokens a guardar", "30")
  .option("--lookback-hours <n>", "horas hacia atrás desde pumpStart", "72")
  .action(async (opts: { chains: string; maxTokens: string; lookbackHours: string }) => {
    const chains = parseChains(opts.chains);
    const events = await detectPumps(chains, pumpCriteria, Number.parseInt(opts.maxTokens, 10));
    insertPumpEvents(events);
    logger.info({ pumps: events.length }, "scan listo");

    const { runAnalyze } = await import("./analysis/run.js");
    await runAnalyze(Number.parseInt(opts.lookbackHours, 10));
    logger.info("analyze listo");

    const { runExport } = await import("./export/csv.js");
    const outPath = await runExport();
    logger.info({ outPath }, "pipeline completo");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ err: String(err) }, "error fatal");
  process.exit(1);
});
