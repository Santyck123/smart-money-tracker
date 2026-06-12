import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PumpEvent } from "../pumps/types.js";
import type { Chain, TokenTransfer } from "../chains/types.js";

// En deploy (Railway/Render) DATA_DIR apunta al volumen persistente.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "tracker.db");

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS pump_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      chain TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      dex_id TEXT NOT NULL,
      pump_start_ts INTEGER NOT NULL,
      price_change_24h_pct REAL NOT NULL,
      volume_24h_usd REAL NOT NULL,
      liquidity_usd REAL NOT NULL,
      price_usd REAL NOT NULL,
      pair_created_at_ts INTEGER NOT NULL,
      detected_at_ts INTEGER NOT NULL,
      analyzed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(chain, token_address, pair_address)
    );
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pump_event_id INTEGER NOT NULL REFERENCES pump_events(id),
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      token_address TEXT NOT NULL,
      raw_amount TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      UNIQUE(pump_event_id, tx_hash, from_addr, to_addr, raw_amount)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_pump ON transfers(pump_event_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_addr);
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS wallet_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      chain TEXT NOT NULL,
      pump_event_id INTEGER NOT NULL REFERENCES pump_events(id),
      first_buy_ts INTEGER NOT NULL,
      buy_count INTEGER NOT NULL,
      total_amount REAL NOT NULL,
      dispersion_hours REAL NOT NULL,
      hours_before_pump REAL NOT NULL,
      minutes_after_deploy REAL NOT NULL,
      supply_pct REAL,
      UNIQUE(wallet, pump_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_stats_wallet ON wallet_stats(wallet);
  `);
  addColumnIfMissing(d, "wallet_stats", "max_buys_per_second", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(d, "wallet_stats", "first_buy_cluster_size", "INTEGER NOT NULL DEFAULT 1");
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, def: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

export interface WalletStatsRow {
  wallet: string;
  chain: Chain;
  pumpEventId: number;
  firstBuyTs: number;
  buyCount: number;
  totalAmount: number;
  dispersionHours: number;
  hoursBeforePump: number;
  minutesAfterDeploy: number;
  supplyPct: number | null;
  maxBuysPerSecond: number;
  firstBuyClusterSize: number;
}

export function upsertWalletStats(rows: WalletStatsRow[]): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO wallet_stats (
      wallet, chain, pump_event_id, first_buy_ts, buy_count, total_amount,
      dispersion_hours, hours_before_pump, minutes_after_deploy, supply_pct,
      max_buys_per_second, first_buy_cluster_size
    ) VALUES (
      @wallet, @chain, @pumpEventId, @firstBuyTs, @buyCount, @totalAmount,
      @dispersionHours, @hoursBeforePump, @minutesAfterDeploy, @supplyPct,
      @maxBuysPerSecond, @firstBuyClusterSize
    )
    ON CONFLICT(wallet, pump_event_id) DO UPDATE SET
      buy_count = excluded.buy_count,
      total_amount = excluded.total_amount,
      dispersion_hours = excluded.dispersion_hours,
      hours_before_pump = excluded.hours_before_pump,
      minutes_after_deploy = excluded.minutes_after_deploy,
      supply_pct = excluded.supply_pct,
      max_buys_per_second = excluded.max_buys_per_second,
      first_buy_cluster_size = excluded.first_buy_cluster_size
  `);
  const run = d.transaction((all: WalletStatsRow[]) => {
    for (const row of all) stmt.run(row);
    return all.length;
  });
  return run(rows);
}

/** Stats de todas las apariciones de cada wallet (corrida actual + histórico). */
export function listAllWalletStats(): WalletStatsRow[] {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM wallet_stats").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    wallet: r.wallet as string,
    chain: r.chain as Chain,
    pumpEventId: r.pump_event_id as number,
    firstBuyTs: r.first_buy_ts as number,
    buyCount: r.buy_count as number,
    totalAmount: r.total_amount as number,
    dispersionHours: r.dispersion_hours as number,
    hoursBeforePump: r.hours_before_pump as number,
    minutesAfterDeploy: r.minutes_after_deploy as number,
    supplyPct: r.supply_pct as number | null,
    maxBuysPerSecond: (r.max_buys_per_second as number | undefined) ?? 1,
    firstBuyClusterSize: (r.first_buy_cluster_size as number | undefined) ?? 1,
  }));
}

export function insertTransfers(pumpEventId: number, transfers: TokenTransfer[]): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO transfers (
      pump_event_id, tx_hash, block_number, timestamp, from_addr, to_addr,
      token_address, raw_amount, decimals
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = d.transaction((rows: TokenTransfer[]) => {
    let count = 0;
    for (const t of rows) {
      const info = stmt.run(
        pumpEventId, t.txHash, t.blockNumber, t.timestamp,
        t.from, t.to, t.tokenAddress, t.rawAmount, t.decimals,
      );
      count += info.changes;
    }
    return count;
  });
  return insertAll(transfers);
}

export function getTransfersForPump(pumpEventId: number): TokenTransfer[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM transfers WHERE pump_event_id = ? ORDER BY timestamp ASC")
    .all(pumpEventId) as Record<string, unknown>[];
  return rows.map((r) => ({
    txHash: r.tx_hash as string,
    blockNumber: r.block_number as number,
    timestamp: r.timestamp as number,
    from: r.from_addr as string,
    to: r.to_addr as string,
    tokenAddress: r.token_address as string,
    rawAmount: r.raw_amount as string,
    decimals: r.decimals as number,
  }));
}

export function markAnalyzed(pumpEventId: number): void {
  getDb().prepare("UPDATE pump_events SET analyzed = 1 WHERE id = ?").run(pumpEventId);
}

export function insertPumpEvents(events: PumpEvent[]): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO pump_events (
      token_address, token_symbol, token_name, chain, pair_address, dex_id,
      pump_start_ts, price_change_24h_pct, volume_24h_usd, liquidity_usd,
      price_usd, pair_created_at_ts, detected_at_ts
    ) VALUES (
      @tokenAddress, @tokenSymbol, @tokenName, @chain, @pairAddress, @dexId,
      @pumpStartTs, @priceChange24hPct, @volume24hUsd, @liquidityUsd,
      @priceUsd, @pairCreatedAtTs, @detectedAtTs
    )
    ON CONFLICT(chain, token_address, pair_address) DO UPDATE SET
      pump_start_ts = excluded.pump_start_ts,
      price_change_24h_pct = excluded.price_change_24h_pct,
      volume_24h_usd = excluded.volume_24h_usd,
      liquidity_usd = excluded.liquidity_usd,
      price_usd = excluded.price_usd,
      detected_at_ts = excluded.detected_at_ts
  `);
  const insertAll = d.transaction((rows: PumpEvent[]) => {
    let count = 0;
    for (const row of rows) {
      stmt.run(row);
      count++;
    }
    return count;
  });
  return insertAll(events);
}

export interface PumpEventRow extends PumpEvent {
  id: number;
  analyzed: boolean;
}

export function listPumpEvents(onlyUnanalyzed = false): PumpEventRow[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT * FROM pump_events ${onlyUnanalyzed ? "WHERE analyzed = 0" : ""} ORDER BY detected_at_ts DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    tokenAddress: r.token_address as string,
    tokenSymbol: r.token_symbol as string,
    tokenName: r.token_name as string,
    chain: r.chain as Chain,
    pairAddress: r.pair_address as string,
    dexId: r.dex_id as string,
    pumpStartTs: r.pump_start_ts as number,
    priceChange24hPct: r.price_change_24h_pct as number,
    volume24hUsd: r.volume_24h_usd as number,
    liquidityUsd: r.liquidity_usd as number,
    priceUsd: r.price_usd as number,
    pairCreatedAtTs: r.pair_created_at_ts as number,
    detectedAtTs: r.detected_at_ts as number,
    analyzed: Boolean(r.analyzed),
  }));
}
