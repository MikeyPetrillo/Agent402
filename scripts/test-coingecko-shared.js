#!/usr/bin/env node
// The CoinGecko budget and response caches across two replicas.
//
//   node scripts/test-coingecko-shared.js            (starts its own redis-server)
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-coingecko-shared.js
//                                    (used only where no redis-server binary is installed)
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
//   2a. On one Redis, paid calls use the whole day when nothing else does; a
//      flood of made-up ids (unsettled errors), sent one by one or all at
//      once over both servers, reads no more than the unsettled share, and
//      paid calls after it still answer.
//   3. Without Redis, each server holds its RATE_LIMIT_REPLICAS share of the
//      caps, so two servers together still send no more than the cap; a
//      control with RATE_LIMIT_REPLICAS=1 shows one server alone takes it all.
// Deliberately does not skip: it starts a redis-server on a free port, and with
// neither the binary nor REDIS_URL it fails.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort, getFreePorts } from "./lib/free-port.js";
// Each server keeps its own stores (lib/own-stores.js): only Redis is shared.
import { ownStoreEnv } from "./lib/own-stores.js";

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
// Section 2b pauses its Redis (CLIENT PAUSE ALL), which holds EVERY client of
// that server: on a Redis other suites share, a parallel suite's commands
// stalled for three seconds and its controls decided alone. So the suite runs
// on a redis-server of its own whenever the binary is there, and uses the
// caller's REDIS_URL only without one (CI's service container, where the
// Redis suites run one after another).
const candidates = ["/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server", "/usr/bin/redis-server"];
let bin = candidates.find((p) => existsSync(p));
if (!bin) { try { bin = execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim(); } catch { bin = ""; } }
let REDIS_URL = bin ? "" : process.env.REDIS_URL || "";
if (!REDIS_URL) {
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
  else if (/\/coins\/(made-up|burst)-/.test(u.pathname)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "coin not found" })); return; }
  else if (/\/onchain\/networks\/[a-z0-9]+\/pools$/.test(u.pathname)) body = { data: [{ id: "x", attributes: { address: "0x1", name: "A / B", volume_usd: { h24: "1" }, reserve_in_usd: "1", transactions: { h24: { buys: 1, sells: 1 } } }, relationships: { dex: { data: { id: "d" } } } }], included: [] };
  else if (u.pathname.endsWith("/coins/list")) body = [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }];
  else if (u.pathname.endsWith("/coins/bitcoin")) body = { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_data: {} };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;

// ---- servers ------------------------------------------------------------------------------
// The word reads degraded for SHARED_LIMITS_DEGRADED_HOLD_MS after any command
// that missed its deadline. A server booting on a host whose cores are taken
// (a parallel suite) misses its first commands while its own boot holds the
// loop, and the default hold kept the word degraded for a minute after Redis
// answered every command since. The servers here hold it for the minimum, so
// the word reads what the store does now; what is shared is asserted by the
// behavior checks. For the same reason the command deadlines are generous here:
// a command that misses it decides on the server's own share by design, so a
// burst on a host whose cores are taken read 12 upstream calls against a cap
// of 10 with Redis healthy. The fallback itself is checked below (no Redis).
const OPERATOR_TOKEN = "coingecko-shared-operator-token-0123456789";
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ["REDIS_URL", "SHARED_LIMITS", "SHARED_LIMITS_PREFIX", "RATE_LIMIT_REPLICAS", "COINGECKO_API_KEY", "COINGECKO_MAX_PER_MIN", "COINGECKO_DAILY_MAX", "COINGECKO_UNSETTLED_SHARE", "COINGECKO_OTHERS_RESERVE"]) delete e[k];
  return { ...e, AGENT402_OPERATOR_TOKEN: OPERATOR_TOKEN, FREE_MODE: "true", X402_INDEX_CRAWL: "off", COINGECKO_STUB_URL: STUB_URL, SHARED_LIMITS_PROBE_FIRST_MS: "0", SHARED_LIMITS_DEGRADED_HOLD_MS: "1000", SHARED_LIMITS_OP_MS: "10000", COINGECKO_SHARED_DEADLINE_MS: "10000", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" };
})();
let run = 0;
async function boot(n, env) {
  const prefix = `cg${process.pid}${Date.now().toString(36)}${++run}`;
  const ports = await getFreePorts(n);
  const servers = ports.map((port) => {
    const c = spawn(process.execPath, ["--import", "./scripts/lib/coingecko-stub-preload.js", "src/server.js"], {
      env: { ...BASE_ENV, ...ownStoreEnv("coingecko"), ...(env.redis ? { REDIS_URL, SHARED_LIMITS_PREFIX: prefix } : {}), ...env.vars, PORT: String(port) },
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
    const word = async (s) => { for (let i = 0; i < 80; i++) { const j = await (await fetch(`${s.url}/api/gateway-status`)).json(); if (j.sharedLimits?.status === "on") return "on"; await wait(250); } const d = await (await fetch(`${s.url}/api/gateway-status`, { headers: { "x-operator-token": OPERATOR_TOKEN } })).json().catch(() => ({})); return `not on: ${JSON.stringify(d.sharedLimits)} ${s.child.log.split("\n").filter((l) => /shared-limit/.test(l)).slice(0, 4).join(" | ")}`; };
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
  const misses = () => [A, B].reduce((n, s) => n + (s.child.log.match(/the shared store did not answer/g) || []).length, 0);
  ok(upstream <= CAP, `a burst of 40 distinct requests over both servers sends the upstream no more than the minute cap (${upstream} of ${CAP}; shared-store misses logged: ${misses()})`);
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
  // A share of the day for unsettled calls that is not empty (10% of 8 rounds
  // to none, and with none every id is checked against its list first, which
  // would add list reads to the counts below).
  const { servers: [A, B], stop } = await boot(2, { redis: true, vars: { COINGECKO_MAX_PER_MIN: "100", COINGECKO_DAILY_MAX: String(DAY), COINGECKO_UNSETTLED_SHARE: "0.5", COINGECKO_API_KEY: "cg-test-key-not-real", RATE_LIMIT_REPLICAS: "2" } });
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
  ok(okCount(onB) === 0 && onB.every((r) => r.status === 503 && /daily .* allowance is used up/.test(JSON.stringify(r.body))), "then B refuses with the daily wording (our own allowance)");
  ok(upstream === DAY, `upstream requests across both servers for the day: ${upstream} (ceiling ${DAY})`);
  stop();
}

// ---- 2a. the day and the unsettled share, on one Redis -------------------------------------
// Paid calls use every read of the day. Made-up ids answer an error (never
// settled) on both servers: a call whose id no list has confirmed reserves a
// place in the unsettled share (10% of the day) before it reads, in one step
// on the shared store, and once the share is full each id is checked against
// the coin list first.
{
  const DAY = 40;
  const vars = { COINGECKO_MAX_PER_MIN: "100000", COINGECKO_DAILY_MAX: String(DAY), COINGECKO_API_KEY: "cg-test-key-not-real", RATE_LIMIT_REPLICAS: "2" };
  const profile = (s, coin) => fetch(`${s.url}/api/coin-profile?coin=${encodeURIComponent(coin)}`).then((r) => r.status);
  {
    const { servers: [A, B], stop } = await boot(2, { redis: true, vars });
    upstream = 0;
    const paid = [];
    for (let k = 0; k < DAY + 6; k++) paid.push(await search(k % 2 ? B : A, `paid${k}`));
    ok(okCount(paid) === DAY && upstream === DAY, `with no unpaid use, paid calls over both servers answer for the whole day (${okCount(paid)} of ${DAY}, upstream ${upstream})`);
    stop();
  }
  {
    const { servers: [A, B], stop } = await boot(2, { redis: true, vars });
    upstream = 0; seen.length = 0;
    const flood = [];
    for (let k = 0; k < 120; k++) flood.push(await profile(k % 2 ? B : A, `made-up-${k}`));
    ok(flood.every((st) => st === 422), `120 made-up ids over both servers are each a 422 (${[...new Set(flood)].join(",")})`);
    const madeUpReads = seen.filter((p) => p.includes("/coins/made-up-")).length;
    ok(madeUpReads === DAY / 10, `only the unsettled share's reads reached the upstream (${madeUpReads} of ${DAY / 10}); the coin list stood in for the rest (${seen.filter((p) => p.includes("/coins/list")).length} list reads)`);
    const cp = [];
    for (let k = 0; k < 40; k++) cp.push((await priceCk(k % 2 ? B : A, `madeprice${k}`)).status);
    ok(cp.every((st) => st === 404) && !seen.some((p) => p.includes("madeprice")), `crypto-price with made-up coins then answers 404 with no read (${[...new Set(cp)].join(",")})`);
    const paid = [];
    for (let k = 0; k < 20; k++) paid.push(await profile(k % 2 ? B : A, "bitcoin"));
    ok(paid.every((st) => st === 200), `paid calls for a real coin after the flood all answer 200 (${[...new Set(paid)].join(",")})`);
    stop();
  }
  {
    // A parallel burst over both servers: every call checks the share before
    // any of them ends, so the check and the place are one step.
    const { servers: [A, B], stop } = await boot(2, { redis: true, vars });
    upstream = 0; seen.length = 0;
    const burst = await Promise.all(Array.from({ length: 200 }, (_, k) => profile(k % 2 ? B : A, `burst-${k}`)));
    const burstReads = seen.filter((p) => p.includes("/coins/burst-")).length;
    ok(burst.every((st) => st === 422), `200 made-up ids sent together over both servers are each a 422 (${[...new Set(burst)].join(",")})`);
    ok(burstReads === DAY / 10, `and only the unsettled share's reads reached the upstream (${burstReads} of ${DAY / 10})`);
    const paid = [];
    for (let k = 0; k < 20; k++) paid.push(await profile(k % 2 ? B : A, "bitcoin"));
    ok(paid.every((st) => st === 200), `paid calls after the burst all answer 200 (${[...new Set(paid)].join(",")})`);
    stop();
  }
  {
    // The screens stop at the day less the reserve kept for the other tools
    // (20%), counted on the one day counter both servers share.
    const { servers: [A, B], stop } = await boot(2, { redis: true, vars });
    upstream = 0;
    const board = (s, network) => fetch(`${s.url}/api/dex-volume-board?network=${network}&pools=20`).then((r) => r.status);
    const boards = await Promise.all(Array.from({ length: DAY }, (_, k) => board(k % 2 ? B : A, `net${k}`)));
    const screens = DAY - DAY / 5;
    ok(boards.filter((st) => st === 200).length === screens && boards.filter((st) => st !== 200).every((st) => st === 503), `boards on ${DAY} networks over both servers answer until the day less the reserve (${boards.filter((st) => st === 200).length} of ${screens}), then 503`);
    const others = [];
    for (let k = 0; k < DAY / 5 + 3; k++) others.push(await search(k % 2 ? B : A, `reserve${k}`));
    ok(okCount(others) === DAY / 5, `the other tools keep the reserve (${okCount(others)} of ${DAY / 5})`);
    stop();
  }
}

// ---- 2b. a Redis that stops answering: the share decides, inside the deadline -------------
{
  const CAP = 10;
  // The production deadlines: this is the case they exist for.
  const { servers: [A], stop } = await boot(1, { redis: true, vars: { COINGECKO_MAX_PER_MIN: String(CAP), RATE_LIMIT_REPLICAS: "2", COINGECKO_SHARED_DEADLINE_MS: "", SHARED_LIMITS_OP_MS: "" } });
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
