// Diagnóstico temporal de fuentes de candidatos DexScreener
const BASE = "https://api.dexscreener.com";

async function get(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

const byChain: Record<string, number> = {};
const tokens: Record<string, string[]> = { ethereum: [], bsc: [], solana: [] };
for (const p of ["/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"]) {
  const d = await get(p);
  console.log(p, "->", d.length, "items");
  for (const x of d) {
    byChain[x.chainId] = (byChain[x.chainId] ?? 0) + 1;
    if (tokens[x.chainId]) tokens[x.chainId]!.push(x.tokenAddress);
  }
}
console.log("por chain:", byChain);

// Validar batch de tokens solana y ver priceChange
for (const chain of ["solana", "bsc", "ethereum"]) {
  const list = [...new Set(tokens[chain])].slice(0, 30);
  if (list.length === 0) { console.log(chain, ": sin candidatos"); continue; }
  const pairs = await get(`/tokens/v1/${chain}/${list.join(",")}`);
  const stats = pairs
    .map((p: any) => ({ s: p.baseToken?.symbol, ch: p.priceChange?.h24, vol: p.volume?.h24, liq: p.liquidity?.usd, age: p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 86_400_000).toFixed(1) : null }))
    .sort((a: any, b: any) => (b.ch ?? -999) - (a.ch ?? -999))
    .slice(0, 8);
  console.log(chain, "tokens:", list.length, "pairs:", pairs.length);
  console.table(stats);
}
