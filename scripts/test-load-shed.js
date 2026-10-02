// Admission control (src/load-shed.js + the gates in server.js) and the
// limiter's IPv6 /64 keying and key cap, offline and booted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

// --- unit
const { createComputeBudget, shouldShedFree } = await import("../src/load-shed.js");
const b = createComputeBudget({ budgetMs: 100, windowMs: 1000 });
b.record(60, 1000); ok(!b.over(1000), "under budget: not over");
b.record(50, 1100); ok(b.over(1100), "110 ms of compute inside the window is over a 100 ms budget");
ok(!b.over(2200), "the window rolls: a second later the budget is free again");
ok(shouldShedFree({ inFlight: 0, lagMs: 0 }) === null, "a healthy server sheds nothing");
ok(shouldShedFree({ inFlight: 0, lagMs: 5000, lateTicks: 4, now: Date.now() + 120_000 }) === "lag", "a saturated event loop sheds free traffic (after the boot warm-up)");
ok(shouldShedFree({ inFlight: 0, lagMs: 5000, lateTicks: 4 }) === null, "lag does not shed during the boot warm-up");
ok(shouldShedFree({ inFlight: 0, lagMs: 5000, lateTicks: 0, now: Date.now() + 120_000 }) === null, "one freeze that has ended (the next tick on time) sheds nothing: no 503s after a boot stall");
ok(shouldShedFree({ inFlight: 0, lagMs: 5000, lateTicks: 1, now: Date.now() + 120_000 }) === null, "the requests queued behind ONE stall are served, not shed (the stall tick itself is the only late one)");
ok(shouldShedFree({ inFlight: 0, lagMs: 5000, lateTicks: 2, now: Date.now() + 120_000 }) === null, "two late ticks are not saturation either");
ok(shouldShedFree({ inFlight: 10_000, lagMs: 0 }) === "inflight", "too many requests in flight sheds free traffic");
process.env.LOAD_SHED = "off"; ok(shouldShedFree({ inFlight: 10_000, lagMs: 5000, lateTicks: 4 }) === null, "LOAD_SHED=off disables it"); delete process.env.LOAD_SHED;

process.env.RATE_LIMIT_MAX_KEYS = "3";
const { createLimiter, limiterKey } = await import("../src/rate-limit.js?cap");
ok(limiterKey("2001:db8:1:2:aaaa::1") === limiterKey("2001:db8:1:2:ffff::9") && limiterKey("2001:db8:1:3::1") !== limiterKey("2001:db8:1:2::1"), "IPv6 addresses fold to their /64 (and different /64s stay apart)");
ok(limiterKey("1.2.3.4") === "1.2.3.4" && limiterKey("::ffff:1.2.3.4") === "::ffff:1.2.3.4", "IPv4 and mapped addresses are unchanged");
const lim = createLimiter("t", { perMin: 1, perHour: 10 });
ok(!lim.check("2001:db8:1:2::a").limited && lim.check("2001:db8:1:2::b").limited, "rotating addresses inside one /64 shares one budget");
for (const k of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]) lim.check(k);
ok(lim.size() <= 3, `the key table is capped (${lim.size()} keys at a cap of 3)`);
ok(limiterKey("2001:db8:1:2:aaaa::1|hash") === "2001:db8:1:2:aaaa::1|hash", "a composite key (ip|tool) is used as given, never folded into a different bucket");

// --- booted: every free request sheds when the in-flight ceiling is 1; the
// protected ones do not, and the discovery CPU budget refuses before computing.
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", AGENT402_OPERATOR_TOKEN: "shed-test-operator-token-0123456789", SHED_INFLIGHT: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const from = (ip, extra = {}) => ({ headers: { "x-forwarded-for": ip, ...extra } });
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted (/health is never shed)");
  const free = await fetch(`${base}/api/find?q=hash`, from("203.0.113.5"));
  ok(free.status === 503 && free.headers.get("retry-after") === "2" && /paid calls keep flowing/.test((await free.json()).error), `a free request past the ceiling is shed with 503 + Retry-After (${free.status})`);
  const paid = await fetch(`${base}/api/hash`, { method: "POST", ...from("203.0.113.5", { "content-type": "application/json", "payment-signature": "x".repeat(40) }), body: JSON.stringify({ text: "a" }) });
  ok(paid.status !== 503, `a priced route carrying a payment credential is not shed (${paid.status})`);
  const alias = await fetch(`${base}/api/hash`, { ...from("203.0.113.5", { "payment-signature": "x".repeat(40) }) });
  ok(alias.status !== 503, `...through the method alias too (GET on a POST tool: ${alias.status})`);
  const gw = await fetch(`${base}/v1/metered/v1/messages`, { method: "POST", ...from("203.0.113.5", { "content-type": "application/json", authorization: "Bearer a402_" + "k".repeat(24) }), body: "{}" });
  ok(gw.status !== 503, `a payment-bearing /v1 gateway call (SDK path alias) is not shed (${gw.status})`);
  const forgedFree = await fetch(`${base}/api/find?q=hash`, from("203.0.113.5", { "payment-signature": "x".repeat(40) }));
  ok(forgedFree.status === 503, "a payment header on a FREE route buys nothing: still shed");
  const chainAlias = await fetch(`${base}/api/chain/eth_blocknumber`, from("203.0.113.5"));
  ok(chainAlias.status !== 503, `an /api/chain/<verb> alias of a priced tool is not shed (${chainAlias.status})`);
  const mcp = await fetch(`${base}/mcp`, { method: "POST", ...from("203.0.113.5", { "content-type": "application/json", accept: "application/json, text/event-stream" }), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  ok(mcp.status !== 503, `/mcp (which carries paid tool calls in its body) is not shed (${mcp.status})`);
  await fetch(`${base}/r/cs_live_supersecretsessionid`, from("203.0.113.5"));
  const perfKeys = await (await fetch(`${base}/__operator/perf.json?min=1&top=200`, from("203.0.113.5", { authorization: "Bearer shed-test-operator-token-0123456789" }))).json();
  ok(!JSON.stringify(perfKeys).includes("supersecretsessionid"), "a report link's id (its credential) never reaches a timing key");
  await fetch(`${base}/tools/some-tool-slug`, from("203.0.113.5"));
  const keys2 = (await (await fetch(`${base}/__operator/perf.json?min=1&top=200`, from("203.0.113.5", { authorization: "Bearer shed-test-operator-token-0123456789" }))).json()).routes.map((r) => r.route);
  ok(keys2.includes("GET /tools/*") && !keys2.some((k) => k.includes("some-tool-slug")), "a page outside /api and /v1 collapses to its first segment");
  const unpaidPriced = await fetch(`${base}/api/hash`, { method: "POST", ...from("203.0.113.5", { "content-type": "application/json" }), body: JSON.stringify({ text: "a" }) });
  ok(unpaidPriced.status !== 503, `an UNPAID call to a priced route is not shed either: the 402 is the first step of a purchase (${unpaidPriced.status})`);
  const op = await fetch(`${base}/__operator/perf.json`, from("203.0.113.5", { authorization: "Bearer shed-test-operator-token-0123456789" }));
  const perf = await op.json();
  ok(op.status === 200 && perf.shed.shed >= 2, `operator reads are never shed, and the shed count is visible (${JSON.stringify(perf.shed)})`);
  const sh = await (await fetch(`${base}/__operator/serving-health.json`, from("203.0.113.5", { authorization: "Bearer shed-test-operator-token-0123456789" }))).json();
  ok(["ok", "degraded"].includes(sh.status) && typeof sh.responses1h.total === "number" && sh.responses1h.s5xx === 0 && sh.responses1h.paid >= 1, `serving health counts responses; shed 503s are not counted as 5xx; paid calls are counted (${JSON.stringify(sh.responses1h)})`);
  ok(Array.isArray(sh.reasons) && sh.thresholds && sh.loop && "stalls1h" in sh.loop, "the verdict carries its reasons, thresholds and loop counts");
  const unauth = await fetch(`${base}/__operator/serving-health.json`, from("203.0.113.5"));
  ok(unauth.status === 404, "serving health is operator-only");
} finally { proc.kill("SIGKILL"); }

const port2 = await getFreePort();
const proc2 = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port2), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", DISCOVERY_CPU_BUDGET_MS: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
const base2 = `http://127.0.0.1:${port2}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base2}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await fetch(`${base2}/api/route?q=${encodeURIComponent(`json csv convert ${i}`)}`, from(`198.51.100.${i}`))).status);
  ok(statuses.includes(503) && statuses[0] === 200, `past the global CPU budget, uncached searches from DIFFERENT addresses are refused (${statuses.join(",")})`);
  // With the crawler off the index never reads ready, and answers computed then
  // are deliberately not cached, so the ordering is pinned from source instead.
  const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function serveCachedDiscovery("), src.indexOf('app.get("/api/find"'));
  ok(body.indexOf("cacheGet(cacheKey)") < body.indexOf("discoveryCpuBudget.over()") && body.indexOf("discoveryCpuBudget.over()") < body.indexOf("computeFn("), "the CPU budget is checked after the cache lookup and before the compute, so a cache hit is never refused");
  // The in-flight ceiling: sliced router queries can overlap, and a burst
  // passes the CPU budget before any of it is charged, so a count of computes
  // in progress bounds them. Checked after the cache, before the compute; the
  // count is released in a finally so a throwing compute cannot leak a slot.
  const inflightCheck = body.indexOf("discoveryInFlight >= DISCOVERY_MAX_INFLIGHT");
  ok(inflightCheck > body.indexOf("cacheGet(cacheKey)") && inflightCheck < body.indexOf("computeFn("), "the in-flight ceiling is checked after the cache lookup and before the compute");
  ok(/discoveryInFlight\+\+;\s*let result, syncMs;\s*try \{[\s\S]*?\} finally \{\s*discoveryInFlight--;/.test(body), "...and the in-flight count is released in a finally");
  ok(/const meter = \(ms\) => \{[^}]*discoveryCpuBudget\.record\(ms\)/.test(body), "each router slice is charged to the CPU budget as it runs");
} finally { proc2.kill("SIGKILL"); }

console.log(`test-load-shed: ${n} passed`);
