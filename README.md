# smart-money-tracker

Sistema de análisis on-chain que detecta tokens con pump reciente, reconstruye el historial de compras, identifica las wallets que compraron **antes** del pump y exporta un CSV rankeado con las mejores ("smart money").

## Setup

Requiere Node.js 20+.

```bash
npm install
copy .env.example .env   # y completar las keys
```

Keys necesarias en `.env`:

| Variable | Dónde conseguirla | Para qué |
|---|---|---|
| `ETHERSCAN_API_KEY` | https://etherscan.io/myapikey | transfers en Ethereum (API V2 multichain) |
| `HELIUS_API_KEY` | https://dashboard.helius.dev | transfers en Solana (RPC + Enhanced API) |

DexScreener (detección de pumps) no requiere key.

## Uso

```bash
npm run scan -- --chains eth,bsc,sol --max-tokens 30   # detecta pumps → SQLite
npm run analyze                                         # reconstruye transfers y pre-buyers
npm run export                                          # genera output/smart-wallets-YYYY-MM-DD.csv
npm run pipeline -- --chains eth,bsc,sol                # los 3 pasos juntos
```

> En PowerShell el `--` de npm se rompe; usar `npx tsx src/cli.ts scan --chains eth,sol` directo.

Opciones útiles: `analyze --lookback-hours 72`, `export --min-score 30 --no-flags`.

Criterios de pump configurables por env (defaults): `PUMP_MIN_PRICE_CHANGE_24H=200`, `PUMP_MIN_VOLUME_24H_USD=100000`, `PUMP_MIN_LIQUIDITY_USD=20000`, `PUMP_MIN_PAIR_AGE_DAYS=1`, `PUMP_MAX_PAIR_AGE_DAYS=30`.

**Nota**: la mayoría de los pumps reales ocurre en pares con menos de 1 día de vida. Con el default `PUMP_MIN_PAIR_AGE_DAYS=1` se filtran casi todos; bajarlo a `0.1` encuentra mucho más (a costa de más ruido/honeypots recién deployados).

## Scoring (0-100)

| Componente | Peso | Qué mide |
|---|---|---|
| Timing | 30% | Cuánto antes del pump compró (satura a 48h). Compras ≤5 min post-deploy se penalizan ×0.15 (sniper) |
| Tamaño relativo | 25% | % del supply comprado, log-normalizado (satura en 2%) |
| Acumulación | 20% | Varias compras espaciadas > una sola (satura en 5 compras / 24h de dispersión) |
| Recurrencia | 25% | En cuántos tokens pumpeados distintos aparece como pre-buyer (histórico SQLite incluido; satura en 4) |

Flags anti-ruido (columnas del CSV, no eliminan wallets): `is_sniper` (compró ≤5 min post-deploy), `is_insider_suspect` (primer fondeo desde el deployer), `is_fresh_wallet` (wallet <7 días con ≤10 txs), `is_bot_suspect`. Los flags que requieren API solo se resuelven para el top 100.

**Detección de bots** (`is_bot_suspect`) en dos capas:

1. *Por token* — una aparición es bot-like si tiene ≥2 compras en el mismo segundo, ≥3 compras con dispersión < 90s (ráfaga programática), primera compra en el mismo segundo que 4+ wallets (bundle), o ≥15 compras pre-pump (market maker).
2. *Flotas (cross-token)* — `findFleetBots`: si ≥3 wallets debutan en el **mismo segundo exacto** de un token es un bundle coordinado; una wallet que aparece en bundles así en ≥2 tokens distintos es parte de una flota operada por una sola entidad. Esto caza bots sofisticados que espacian compras para evadir los filtros por-token. Se calcula sobre toda la DB sin tocar APIs.

Si una wallet cae en cualquiera de las dos capas, su score se multiplica ×0.15 y desaparece del top. El panel oculta bots/snipers por default.

## Arquitectura

```
src/
  cli.ts                  # commander: scan, analyze, export, pipeline
  config.ts               # env + criterios con zod
  chains/                 # ChainAdapter común: EVM (Etherscan V2) y Solana (Helius)
  pumps/detector.ts       # DexScreener
  analysis/               # prebuyers, scoring (puro), filters (puro), run
  storage/db.ts           # SQLite (better-sqlite3): pump_events, transfers, wallet_stats
  export/csv.ts           # CSV final rankeado
```

La lógica de análisis es chain-agnostic: los adapters exponen `getTokenTransfers(token, fromTs, toTs, pair?)` y todo lo demás trabaja sobre esa interfaz.

Tests (`npm test`): scoring y filtros, lógica pura sin HTTP.

## Deploy 24/7 (Railway)

El repo incluye `Dockerfile`. Pasos en Railway:

1. **New Project → Deploy from GitHub repo** → elegir este repo (detecta el Dockerfile solo).
2. En el servicio → **Settings → Volumes → Add Volume**: mount path `/data`.
3. En **Variables**, cargar:
   ```
   ETHERSCAN_API_KEY=...
   HELIUS_API_KEY=...
   DATA_DIR=/data
   OUTPUT_DIR=/data/output
   RUN_INTERVAL_HOURS=6
   API_TOKEN=un_token_secreto_largo
   PUMP_MIN_PAIR_AGE_DAYS=0.1
   ```
4. **Settings → Networking → Generate Domain** para acceder al panel desde internet.

Con `RUN_INTERVAL_HOURS` el pipeline corre solo; el histórico (SQLite) y los CSV viven en el volumen `/data` y sobreviven deploys. `API_TOKEN` protege `POST /api/run`; para dispararlo desde n8n: header `Authorization: Bearer <token>`. Estado del job: `GET /api/status`.

> El panel queda público en el dominio generado (solo lectura excepto /api/run, que exige token). Si querés privacidad total, no generes dominio y accedé vía `railway run` / túnel.

## Límites conocidos del free tier

- **Chains EVM soportadas en el free tier de Etherscan V2** (probado): Ethereum, Polygon y Arbitrum ✅. NO soporta BSC, Base, Optimism ni Avalanche (`chainid` → "Free API access is not supported for this chain") — el código queda listo por si se paga el plan; esas chains se detectan como candidatas vía GeckoTerminal pero el análisis de wallets se saltea. Límite: 5 req/s, 100k req/día (limiter global incluido).
- **DexScreener** no tiene endpoint de "top pares"; los candidatos salen de token-boosts/profiles + búsquedas, complementados con **GeckoTerminal** (trending + new pools por chain, sin key, ~30 req/min). Con ambas fuentes ETH detecta algo más, pero Solana sigue dominando.
- **Helius**: por token se recorren las firmas del pool (1000/req) y se parsean máx 5.000 txs priorizando las más viejas (pre-pump). En pools muy calientes (50k+ txs en la ventana) la cola post-pump se trunca; un token muy explosivo puede quedar con pre-buyers incompletos (~2 min por token hot).

## TODOs de mejora

- `pumpStartTs` es una aproximación (pares <24h: mitad de vida del par; resto: snapshot −24h). Mejorable con velas OHLCV (p.ej. GeckoTerminal).
- `avg_supply_pct` usa como proxy el share del total comprado pre-pump, no el supply circulante real (`totalSupply` / `getTokenSupply`).
- `total_usd_bought_prepump` usa el precio actual del token, no el histórico al momento de la compra.
- `is_insider_suspect` requiere resolver el deployer del token (EVM: `getcontractcreation`; Solana: TODO) — hoy siempre `false`.
- En Solana no se resuelve el funder de la primera tx (solo edad + historial para `is_fresh_wallet`).
- PnL histórico de wallets (¿vendieron arriba?) — v2.
- Fuera de alcance v1: trades, dashboard, notificaciones, webhooks en tiempo real.
