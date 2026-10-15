#!/usr/bin/env node
// The two Hyperliquid kits share ONE cache for universe-wide info reads.
//
//   node scripts/test-hyperliquid-shared-cache.js     (offline, stubbed fetch)
//
// Hyperliquid meters its info endpoint per IP (1200 weight a minute; these
// reads weigh 20). crypto-signals-kit and derivatives-kit egress from the same
// IP, so this pins: a document one kit read is the document the other kit
// serves inside the TTL; concurrent misses spend one request; a refusal is
// never stored; reads with buyer parameters (candles, books) are never shared;
// and the TTLs stay short enough to be honest about live prices.
import { createTtlCache } from "../src/tools/ttl-dedupe.js";
import { HL_LIVE_TTL_MS, HL_LISTING_TTL_MS, sharedTtlFor, __hlShared } from "../src/tools/hyperliquid-shared.js";
import { CRYPTO_SIGNALS_TOOLS, __test as sig } from "../src/tools/crypto-signals-kit.js";
import { DERIVATIVES_TOOLS, __test as der } from "../src/tools/derivatives-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- the helper on its own --------------------------------------------------
{
  let t = 1_000;
  const c = createTtlCache({ maxEntries: 2, now: () => t });
  let loads = 0;
  const loader = (v) => async () => { loads++; await new Promise((r) => setTimeout(r, 5)); return v; };
  const [a, b, d] = await Promise.all([c.get("k", 100, loader("A")), c.get("k", 100, loader("B")), c.get("k", 100, loader("C"))]);
  ok(loads === 1 && a.value === "A" && b.value === "A" && d.value === "A", "ttl-dedupe: three concurrent misses share one load");
  ok(a.cached === false && b.cached === true && d.cached === true, "ttl-dedupe: only the leader reports an upstream read");
  t += 50;
  const hit = await c.get("k", 100, loader("D"));
  ok(loads === 1 && hit.cached && hit.ageMs === 50, `ttl-dedupe: a stored hit reports its age (${hit.ageMs} ms)`);
  t += 51;
  const again = await c.get("k", 100, loader("E"));
  ok(loads === 2 && again.value === "E" && !again.cached, "ttl-dedupe: past the TTL the value is read again");
  let threw = 0;
  const failing = async () => { loads++; throw Object.assign(new Error("down"), { statusCode: 502 }); };
  await Promise.all([c.get("x", 100, failing).catch(() => threw++), c.get("x", 100, failing).catch(() => threw++)]);
  ok(threw === 2 && loads === 3, "ttl-dedupe: a failed load rejects every joined caller, with one upstream request");
  await c.get("x", 100, loader("ok"));
  ok(loads === 4, "ttl-dedupe: a failure is never stored (the next call loads)");
  await c.get("y", 100, loader(1)); await c.get("z", 100, loader(2));
  ok(c.size() === 2, "ttl-dedupe: bounded at maxEntries, oldest evicted");
  await c.get("n", 0, loader("no-store"));
  ok(c.size() === 2, "ttl-dedupe: ttl 0 dedupes but never stores");
}

// --- which payloads are shared ---------------------------------------------
ok(sharedTtlFor({ type: "metaAndAssetCtxs" }) === HL_LIVE_TTL_MS, "shared: metaAndAssetCtxs on the live TTL");
ok(sharedTtlFor({ type: "metaAndAssetCtxs", dex: "xyz" }) === HL_LIVE_TTL_MS, "shared: a dex-scoped document is shared per dex");
ok(sharedTtlFor({ type: "predictedFundings" }) === HL_LIVE_TTL_MS, "shared: predictedFundings on the live TTL");
ok(sharedTtlFor({ type: "meta" }) === HL_LISTING_TTL_MS, "shared: meta on the listing TTL");
ok(sharedTtlFor({ type: "candleSnapshot", req: { coin: "BTC" } }) === 0, "never shared: candles carry buyer parameters");
ok(sharedTtlFor({ type: "l2Book", coin: "BTC" }) === 0, "never shared: an order book carries a coin");
ok(sharedTtlFor({ type: "fundingHistory", coin: "BTC", startTime: 1 }) === 0, "never shared: funding history carries a window");
ok(sharedTtlFor({ type: "clearinghouseState", user: "0xabc" }) === 0, "never shared: a user's state");
// Budget arithmetic: 1200 weight a minute, 20 a read. One live key at most
// 60000/5000 = 12 reads a minute is a fifth of the budget.
ok(HL_LIVE_TTL_MS >= 5_000 && HL_LIVE_TTL_MS <= 15_000, `live TTL within 5-15 s (${HL_LIVE_TTL_MS} ms)`);
ok((60_000 / HL_LIVE_TTL_MS) * 20 <= 1200 * 0.25, "one live document costs at most a quarter of the per-IP weight budget");

// --- across the two kits ----------------------------------------------------
const META = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] };
const CTXS = [
  { funding: "0.0000125", openInterest: "36000", prevDayPx: "76968.0", dayNtlVlm: "4679441788.67", markPx: "77267.0", oraclePx: "77250.0", midPx: "77266.5", premium: "0.0001" },
  { funding: "-0.00005", openInterest: "754447", prevDayPx: "2380.3", dayNtlVlm: "3396726206.45", markPx: "2429.3", oraclePx: "2429.0", midPx: "2429.2", premium: "0.0" },
];
const NOW = Date.now();
const CANDLES = Array.from({ length: 60 }, (_, k) => ({ t: NOW - (60 - k) * 3_600_000, T: NOW - (59 - k) * 3_600_000 - 1, s: "BTC", i: "1h", o: "100", c: String(100 + k), h: String(101 + k), l: "99", v: "10", n: 100 }));
const res = (status, body) => ({ status, ok: status < 400, headers: new Headers(), text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
let mode = "ok";
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u !== sig.HL_INFO || sig.HL_INFO !== der.HL_INFO) throw new Error(`unexpected egress in test: ${u}`);
  const body = JSON.parse(opts.body);
  sent.push(body.type);
  await new Promise((r) => setTimeout(r, 5));
  if (mode === "http500") return res(500, "Internal Error");
  switch (body.type) {
    case "meta": return res(200, META);
    case "metaAndAssetCtxs": return res(200, [META, CTXS]);
    case "candleSnapshot": return res(200, CANDLES);
    default: return res(422, "Failed to deserialize");
  }
};
const hs = (slug) => CRYPTO_SIGNALS_TOOLS.find((t) => t.slug === slug).handler;
const hd = (slug) => DERIVATIVES_TOOLS.find((t) => t.slug === slug).handler;
const count = (type) => sent.filter((t) => t === type).length;

__hlShared.clear(); sent.length = 0;
const pulse = await hs("crypto-market-pulse")({ minVolumeUsd: 0 });
const markets = await hd("perp-markets")({});
ok(pulse.source === "hyperliquid" && markets.source === "hyperliquid", "both kits answer");
ok(count("metaAndAssetCtxs") === 1, `one metaAndAssetCtxs read serves both kits inside the TTL (${count("metaAndAssetCtxs")})`);
const btcPulse = pulse.majors?.BTC?.markPx, btcMarkets = (markets.markets || markets.rows || []).find((r) => r.coin === "BTC")?.markPx;
ok(btcPulse === 77267 && btcMarkets === 77267, `both kits read the same document (BTC ${btcPulse} / ${btcMarkets})`);

__hlShared.clear(); sent.length = 0;
await Promise.all([hs("crypto-market-pulse")({}), hd("perp-markets")({}), hd("perp-markets")({ sort: "funding" }), hs("crypto-market-pulse")({ limit: 3 })]);
ok(count("metaAndAssetCtxs") === 1, `four concurrent calls across both kits spend one read (${count("metaAndAssetCtxs")})`);

sent.length = 0;
await hs("crypto-indicators")({ coin: "BTC", limit: 50 }).catch(() => null);
await hs("crypto-indicators")({ coin: "BTC", limit: 50 }).catch(() => null);
ok(count("candleSnapshot") === 2, `candles are never shared (${count("candleSnapshot")} reads for two calls)`);
ok(count("meta") <= 1, "the coin universe used for validation is read at most once");

__hlShared.clear(); sent.length = 0; mode = "http500";
let refused = 0;
await hs("crypto-market-pulse")({}).catch((e) => { if (e.statusCode === 502) refused++; });
mode = "ok";
const after = await hd("perp-markets")({});
ok(refused === 1 && after.source === "hyperliquid" && count("metaAndAssetCtxs") === 2, "an upstream refusal is never stored: the next call reads again and answers");

{
  const realNow = Date.now; const t0 = realNow();
  sent.length = 0;
  Date.now = () => t0 + HL_LIVE_TTL_MS + 1;
  await hd("perp-markets")({});
  Date.now = realNow;
  ok(count("metaAndAssetCtxs") === 1, "past the live TTL the document is read again");
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
