// Chain market pages (/base, /solana, ...) serve the cached page BEFORE doing
// any per-request work (2026-10-01): a distributed burst of plain GET /base
// froze the server for 47 s because each request resolved sellers and read
// the revenue snapshot first. ?seller= views stay per request but are capped.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const loop = src.slice(src.indexOf("for (const chainKey of Object.keys(SNAPSHOT_RAIL_LABEL))"), src.indexOf("app.get(\"/api/market/:chain/panel\""));
const memoAt = loop.indexOf("memoSurfaceAsync(`market:${chainKey}:${all}`");
ok(memoAt > 0, "the plain chain page is served through the shared async cache");
ok(memoAt < loop.indexOf("buildChainPage(chainKey, req.query.seller"), "the cache is consulted before any per-request build");
ok(!/resolveMarketSeller\(|revenueSnapshot\(|getActivityForChain\(/.test(loop), "the handler itself does no seller resolution, revenue read or activity scan");
ok(/chainSellerViewsInFlight >= CHAIN_SELLER_VIEW_MAX_INFLIGHT/.test(loop) && /shedResponse\(res, 5\)/.test(loop), "per-request ?seller= views are capped and shed past the cap");

const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  const burst = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/base`).then((r) => r.status)));
  ok(burst.every((s) => s === 200), `a burst of 40 concurrent /base requests all answer 200 (${[...new Set(burst)].join(",")})`);
  const t0 = Date.now();
  const again = await fetch(`${base}/solana`);
  ok(again.status === 200, "another chain page answers");
  const cached = Date.now(); await fetch(`${base}/solana`); const cachedMs = Date.now() - cached;
  ok(cachedMs < 500, `a repeat request is served from the cache (${cachedMs} ms; first ${cached - t0} ms)`);
  const seller = await fetch(`${base}/base?seller=example.com`);
  ok(seller.status === 200, "a ?seller= view still renders");
} finally { proc.kill("SIGKILL"); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
