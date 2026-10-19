// rwa-asset joins an asset's metadata only with ITS OWN market row: when the
// markets answer does not carry the requested id, market is null, never
// another asset's row. Offline: fetch answers with bodies shaped like the
// rwas endpoints.
import { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache, resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const handler = CRYPTO_MARKETS_TOOLS.find((t) => t.slug === "rwa-asset").handler;
const run = (i) => { resetCgRateLimit(); return handler(i); };

const silverMeta = { id: "silver", symbol: "xag", name: "Silver", asset_type: "commodity", image: { large: "https://img/silver.png" }, web_slug: "silver", last_updated: "2026-10-19T12:00:00Z" };
const goldRow = { id: "gold", symbol: "xau", name: "Gold", asset_type: "commodity", image: "https://img/gold.png", tokenized_market_data: { current_price: 4376.6, market_cap: 5219552133, total_volume: 557496353 }, last_updated: "2026-10-19T12:00:00Z" };
const silverRow = { ...goldRow, id: "silver", symbol: "xag", name: "Silver", tokenized_market_data: { current_price: 51.2, market_cap: 1, total_volume: 1 } };
let markets = [goldRow];
const res = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith("/rwas/markets")) return res(markets);
  if (u.pathname.endsWith("/rwas/silver")) return res(silverMeta);
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "{}" };
};

clearCryptoMarketsCache();
const a = await run({ id: "silver" });
ok(a.id === "silver" && a.name === "Silver", "the metadata is the requested asset's");
ok(a.market === null, `a markets answer without the requested id leaves market null (got ${JSON.stringify(a.market)?.slice(0, 80)})`);

clearCryptoMarketsCache();
markets = [goldRow, silverRow];
const b = await run({ id: "silver" });
ok(b.market && b.market.id === "silver" && b.market.price === 51.2, "the requested asset's own row is joined when present");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
