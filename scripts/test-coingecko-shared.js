#!/usr/bin/env node
// The CoinGecko budget and response caches across two replicas.
//
//   node scripts/test-coingecko-shared.js            (starts its own redis-server)
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-coingecko-shared.js
//
// The key is metered account-wide, so its minute and day caps are for the
// whole service. Two real servers (src/server.js, FREE_MODE, free ports) run
// against one stub upstream that counts every request it is sent:
//   1. On one Redis, a burst spread over both servers sends the upstream no
//      more than the minute cap, and one server can spend the whole cap (the
//      budget is one counter, not two halves), after which the other refuses.
//   2. On one Redis, an answer fetched on A is served on B with zero upstream
//      requests (crypto-markets-kit, price-feed-kit and crypto-kit caches), and
//      the daily ceiling holds across both.
//   3. Without Redis, each server holds its RATE_LIMIT_REPLICAS share of the
//      caps, so two servers together still send no more than the cap; a
//      control with RATE_LIMIT_REPLICAS=1 shows one server alone takes it all.
// Deliberately does not skip: without REDIS_URL it starts a redis-server on a
// free port, and a missing binary is a failure.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort, getFreePorts } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let redisChild = null, redisDir = null;
function cleanup() {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  if (redisChild) { try { redisChild.kill("SIGKILL"); } catch { /* gone */ } }
  if (redisDir) { try { rmSync(redisDir, { recursive: true, force: true }); } catch { /* gone */ } }
}
const done = (code) => { cleanup(); process.exit(code); };
process.on("SIGINT", () => done(130));

// ---- redis ------------------------------------------------------------------------------
function redisPing(port) {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    let buf = "";
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
    s.on("connect", () => s.write("PING\r\n"));
    s.on("data", (d) => { buf += d; if (buf.includes("PONG")) { s.end(); resolve(true); } });
  });
}
let REDIS_URL = process.env.REDIS_URL || "";
if (!REDIS_URL) {
  const candidates = ["/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server", "/usr/bin/redis-server"];
  let bin = candidates.find((p) => existsSync(p));
  if (!bin) { try { bin = execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim(); } catch { bin = ""; } }
  if (!bin) { console.error("FAIL: no REDIS_URL and no redis-server binary. This test needs a real redis; it deliberately does not skip."); process.exit(1); }
  const port = await getFreePort();
  redisDir = mkdtempSync(join(tmpdir(), "cg-shared-redis-"));
  redisChild = spawn(bin, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", redisDir], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await wait(100); up = await redisPing(port); }
  if (!up) { console.error("FAIL: redis-server did not answer"); done(1); }
  REDIS_URL = `redis://127.0.0.1:${port}`;
  console.log(`# started redis-server on ${port}`);
}

// ---- stub upstream ------------------------------------------------------------------------
let upstream = 0;
const seen = [];
const stub = createServer((req, res) => {
  upstream++;
  const u = new URL(req.url, "http://stub");
  seen.push(u.pathname + u.search);
  let body = {};
  if (u.pathname.endsWith("/search")) body = { coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }], exchanges: [], categories: [], nfts: [] };
  else if (u.pathname.endsWith("/simple/price")) {
    for (const id of String(u.searchParams.get("ids") || "").split(",").filter(Boolean)) body[id] = { usd: 1, usd_24h_change: 0, usd_24h_vol: 0, usd_market_cap: 0, last_updated_at: 1_700_000_000 };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;

// ---- servers ------------------------------------------------------------------------------
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ["REDIS_URL", "SHARED_LIMITS", "SHARED_LIMITS_PREFIX", "RATE_LIMIT_REPLICAS", "COINGECKO_API_KEY", "COINGECKO_MAX_PER_MIN", "COINGECKO_DAILY_MAX"]) delete e[k];
  return { ...e, FREE_MODE: "true", X402_INDEX_CRAWL: "off", COINGECKO_STUB_URL: STUB_URL, SHARED_LIMITS_PROBE_FIRST_MS: "0", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" };
})();
let run = 0;
async function boot(n, env) {
  const prefix = `cg${process.pid}${Date.now().toString(36)}${++run}`;
  const ports = await getFreePorts(n);
  const servers = ports.map((port) => {
    const c = spawn(process.execPath, ["--import", "./scripts/lib/coingecko-stub-preload.js", "src/server.js"], {
      env: { ...BASE_ENV, ...(env.redis ? { REDIS_URL, SHARED_LIMITS_PREFIX: prefix } : {}), ...env.vars, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.log = "";
    c.stdout.on("data", (d) => { c.log += d; });
    c.stderr.on("data", (d) => { c.log += d; });
    children.push(c);
    return { port, child: c, url: `http://127.0.0.1:${port}` };
  });
  const up = async (s) => { for (let i = 0; i < 240; i++) { try { if ((await fetch(`${s.url}/health`)).ok) return true; } catch { /* booting */ } await wait(250); } return false; };
  const ups = await Promise.all(servers.map(up));
  if (!ups.every(Boolean)) { for (const s of servers) console.error(s.child.log.slice(-1500)); ok(false, "servers booted"); done(1); }
  if (env.redis) {
    // The store answers before the first request is counted on it.
    const word = async (s) => { for (let i = 0; i < 80; i++) { const j = await (await fetch(`${s.url}/api/gateway-status`)).json(); if (j.sharedLimits?.status === "on") return "on"; await wait(250); } return "not on"; };
    const words = await Promise.all(servers.map(word));
    ok(words.every((w) => w === "on"), `every server reads the shared store (${words.join(", ")})`);
  }
  return { servers, stop() { for (const s of servers) { try { s.child.kill("SIGKILL"); } catch { /* gone */ } } } };
}
const search = (s, q) => fetch(`${s.url}/api/coin-search?query=${encodeURIComponent(q)}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const pricePf = (s, ids) => fetch(`${s.url}/api/price-coingecko`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const priceCk = (s, coins) => fetch(`${s.url}/api/crypto-price?coins=${encodeURIComponent(coins)}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const okCount = (rs) => rs.filter((r) => r.status === 200).length;

// ---- 1. one minute budget across two servers on one Redis ------------------------------
{
  const CAP = 10;
  const { servers: [A, B], stop } = await boot(2, { redis: true, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "2" } });
  upstream = 0;
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => search(i % 2 ? B : A, `race${i}`)));
  ok(upstream <= CAP, `a burst of 40 distinct requests over both servers sends the upstream no more than the minute cap (${upstream} of ${CAP})`);
  ok(upstream === CAP && okCount(rs) === CAP, `and the whole cap is usable (${okCount(rs)} answered)`);
  ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 503 && /not charged/i.test(JSON.stringify(r.body))), "every request past the cap is a 503 that says nobody paid");
  stop();
}
{
  const CAP = 10;
  const { servers: [A, B], stop } = await boot(2, { redis: true, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "2" } });
  upstream = 0;
  const onA = [];
  for (let i = 0; i < 15; i++) onA.push(await search(A, `seqA${i}`));
  ok(okCount(onA) === CAP, `one server can spend the whole service cap, more than its own share (${okCount(onA)} of 15 on A)`);
  const onB = await Promise.all(Array.from({ length: 10 }, (_, i) => search(B, `seqB${i}`)));
  ok(okCount(onB) === 0, `then the other server refuses: the cap is one counter (${okCount(onB)} answered on B)`);
  ok(upstream === CAP, `upstream requests across both servers: ${upstream} (cap ${CAP})`);
  stop();
}

// ---- 2. shared caches and the daily ceiling on one Redis ---------------------------------
{
  const DAY = 8;
  const { servers: [A, B], stop } = await boot(2, { redis: true, vars: { COINGECKO_MAX_PER_MIN: "100", COINGECKO_DAILY_MAX: String(DAY), COINGECKO_API_KEY: "cg-test-key-not-real", RATE_LIMIT_REPLICAS: "2" } });
  upstream = 0;
  const a1 = await search(A, "cached-q");
  ok(a1.status === 200 && a1.body?.cached === false && upstream === 1, `crypto-markets-kit: the first read on A goes upstream (${a1.status}, upstream ${upstream})`);
  await wait(150); // the shared write is in the background
  const b1 = await search(B, "cached-q");
  ok(b1.status === 200 && b1.body?.cached === true && upstream === 1, `crypto-markets-kit: the same read on B is served from A's answer with zero upstream requests (cached ${b1.body?.cached}, upstream ${upstream})`);
  ok(b1.body?.fetchedAt === a1.body?.fetchedAt, "and B reports when the upstream actually answered");
  const p1 = await pricePf(A, ["bitcoin"]);
  ok(p1.status === 200 && upstream === 2, `price-feed-kit: the first read on A goes upstream (${p1.status}, upstream ${upstream})`);
  await wait(150);
  const p2 = await pricePf(B, ["bitcoin"]);
  ok(p2.status === 200 && upstream === 2 && JSON.stringify(p2.body?.prices) === JSON.stringify(p1.body?.prices), `price-feed-kit: B is served from A's answer with zero upstream requests (upstream ${upstream})`);
  const c1 = await priceCk(A, "BTC");
  ok(c1.status === 200 && upstream === 3, `crypto-kit: the first read on A goes upstream (${c1.status}, upstream ${upstream})`);
  await wait(150);
  const c2 = await priceCk(B, "BTC");
  ok(c2.status === 200 && upstream === 3, `crypto-kit: B is served from A's answer with zero upstream requests (upstream ${upstream})`);
  // The daily ceiling: three of the day's calls are spent; A takes the rest,
  // more than its own share would be, and B is then refused.
  const onA = [];
  for (let i = 0; i < 8; i++) onA.push(await search(A, `dayA${i}`));
  ok(okCount(onA) === DAY - 3, `the day's remaining calls are one counter: A takes all ${DAY - 3} left (${okCount(onA)} answered)`);
  const onB = await Promise.all(Array.from({ length: 4 }, (_, i) => search(B, `dayB${i}`)));
  ok(okCount(onB) === 0 && onB.every((r) => r.status === 503 && /temporarily unavailable/i.test(JSON.stringify(r.body))), "then B refuses with the daily wording");
  ok(upstream === DAY, `upstream requests across both servers for the day: ${upstream} (ceiling ${DAY})`);
  stop();
}

// ---- 2b. a Redis that stops answering: the share decides, inside the deadline -------------
{
  const CAP = 10;
  const { servers: [A], stop } = await boot(1, { redis: true, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "2" } });
  // CLIENT PAUSE holds every other client's commands on the server: connected,
  // but not answering.
  const u = new URL(REDIS_URL);
  const paused = await new Promise((resolve) => {
    const s = connect(Number(u.port || 6379), u.hostname);
    const arg = (x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`;
    s.on("error", () => resolve(false));
    s.on("connect", () => s.write(`*4\r\n${arg("CLIENT")}${arg("PAUSE")}${arg("3000")}${arg("ALL")}`));
    s.on("data", (d) => { s.end(); resolve(String(d).startsWith("+OK")); });
  });
  ok(paused, "control: the shared store is paused for three seconds");
  upstream = 0;
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => search(A, `paused${i}`)));
  const took = Date.now() - t0;
  ok(okCount(rs) === CAP / 2 && upstream === CAP / 2, `a store that does not answer leaves the decision to the server's own share (${okCount(rs)} answered, upstream ${upstream}, share ${CAP / 2})`);
  ok(took < 2_500, `and nobody waits on it: eight requests answered in ${took} ms while the store was paused`);
  await wait(Math.max(0, 3_200 - took));
  stop();
}

// ---- 3. without Redis: each server holds its RATE_LIMIT_REPLICAS share ---------------------
{
  const CAP = 10;
  const { servers: [A, B], stop } = await boot(2, { redis: false, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "2" } });
  const st = await (await fetch(`${A.url}/api/gateway-status`)).json();
  ok(st.sharedLimits?.status === "memory", `no Redis: the servers run on their own memory (${st.sharedLimits?.status})`);
  upstream = 0;
  const onA = [];
  for (let i = 0; i < 15; i++) onA.push(await search(A, `locA${i}`));
  const onB = [];
  for (let i = 0; i < 15; i++) onB.push(await search(B, `locB${i}`));
  ok(okCount(onA) === CAP / 2 && okCount(onB) === CAP / 2, `each server holds half the minute cap (${okCount(onA)} on A, ${okCount(onB)} on B)`);
  ok(upstream <= CAP, `two servers without Redis send the upstream no more than the cap (${upstream} of ${CAP})`);
  stop();
}
{
  const DAY = 6;
  const { servers: [A, B], stop } = await boot(2, { redis: false, vars: { COINGECKO_MAX_PER_MIN: "100", COINGECKO_DAILY_MAX: String(DAY), COINGECKO_API_KEY: "cg-test-key-not-real", RATE_LIMIT_REPLICAS: "2" } });
  upstream = 0;
  const onA = [], onB = [];
  for (let i = 0; i < 6; i++) onA.push(await search(A, `ldA${i}`));
  for (let i = 0; i < 6; i++) onB.push(await search(B, `ldB${i}`));
  ok(okCount(onA) === DAY / 2 && okCount(onB) === DAY / 2 && upstream === DAY, `the daily ceiling is divided too (${okCount(onA)} on A, ${okCount(onB)} on B, upstream ${upstream} of ${DAY})`);
  stop();
}
{
  const CAP = 10;
  const { servers: [C], stop } = await boot(1, { redis: false, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "1" } });
  upstream = 0;
  const rs = [];
  for (let i = 0; i < 15; i++) rs.push(await search(C, `one${i}`));
  ok(okCount(rs) === CAP, `control: with RATE_LIMIT_REPLICAS=1 one server takes the whole cap (${okCount(rs)})`);
  stop();
}

stub.close();
console.log(`\ntest-coingecko-shared: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
