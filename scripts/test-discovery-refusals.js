// scripts/test-discovery-refusals.js
// Who the free search routes turn away (src/discovery-refusals.js).
//   1. the module: counts by route and rule, the client cap and its `other`
//      bucket keep totals exact, client keys are stable within a day and hold
//      no address, the User-Agent is reduced to a family, memory is bounded,
//      the store round trip, and the refused-then-succeeded marks;
//   2. a booted free-mode server: each rule on /api/find and /api/route is
//      counted, the 429 tells a client how to proceed, the operator route
//      refuses without the token and answers no-store with it, no address
//      leaves, and the counts survive a restart.
// Offline: stubs and a local boot only.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "a402-discovery-refusals-"));
process.env.DISCOVERY_REFUSALS_FILE = join(dir, "unit.json");
process.env.POW_SECRET = "discovery-refusals-test-secret-0123456789";
delete process.env.HANGUP_FORGIVE_SALT;
const M = await import("../src/discovery-refusals.js");
const { noteDiscoveryRefusal: refuse, noteDiscoveryServed: served, noteDiscoveryClientCall: called, discoveryRefusalsReport: report, flushDiscoveryRefusals: flush, loadDiscoveryRefusals: load, _resetDiscoveryRefusals: reset, _discoveryRefusalsMemory: memory, clientKeyOf, uaFamilyOf, mergeDay, enforceCap } = M;
const newFile = (name) => { reset(); process.env.DISCOVERY_REFUSALS_FILE = join(dir, name); };
const T = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = "2026-11-09";
const today = async (now = T) => (await report({ now })).days.find((d) => d.day === new Date(now).toISOString().slice(0, 10));

// --- 1a. counts by route and rule
{
  newFile("counts.json");
  const plan = [["find", "client-rate", 3], ["route", "client-rate", 5], ["route", "client-compute", 2], ["route", "shared-compute", 4], ["find", "inflight", 1], ["route", "deadline", 1], ["find", "load-gate", 2]];
  for (const [route, rule, count] of plan) for (let i = 0; i < count; i++) refuse({ address: "198.51.100.7", userAgent: "python-requests/2.31.0", route, rule, now: T });
  const d = await today();
  ok(d.refused === 18 && d.byRoute.find === 6 && d.byRoute.route === 12, `refusals are counted by route (${JSON.stringify(d.byRoute)})`);
  ok(d.byRule["client-rate"] === 8 && d.byRule["client-compute"] === 2 && d.byRule["shared-compute"] === 4 && d.byRule.inflight === 1 && d.byRule.deadline === 1 && d.byRule["load-gate"] === 2, `and by the rule that refused (${JSON.stringify(d.byRule)})`);
  ok(d.byRouteAndRule.route["client-rate"] === 5 && d.byRouteAndRule.find["client-rate"] === 3, "the route and the rule are kept together");
  ok(Object.values(d.byRule).reduce((a, b) => a + b, 0) === d.refused && Object.values(d.byRoute).reduce((a, b) => a + b, 0) === d.refused, "both splits sum to the day's total");
  ok(d.distinctRefusedClients === 1 && d.topClients.length === 1 && d.topClients[0].refused === 18 && d.topClients[0].userAgentFamily === "python-requests", "one address is one client, under its User-Agent family");
  ok(d.byUserAgentFamily["python-requests"] === 18, "refusals are counted per User-Agent family");
}

// --- 1b. client keys: keyed, day-scoped, no address
{
  const a = clientKeyOf("198.51.100.7", T), b = clientKeyOf("198.51.100.7", T + 3_600_000);
  ok(/^[0-9a-f]{16}$/.test(a) && a === b, "a client's key is 16 hex characters and stable within a UTC day");
  ok(clientKeyOf("198.51.100.7", T + 86_400_000) !== a, "the same address has a different key the next day");
  ok(clientKeyOf("198.51.100.8", T) !== a, "another address has another key");
  ok(clientKeyOf("2001:db8:1:2:aaaa::1", T) === clientKeyOf("2001:db8:1:2:bbbb::9", T) && clientKeyOf("2001:db8:1:3::1", T) !== clientKeyOf("2001:db8:1:2::1", T), "an IPv6 /64 is one client, as in the limiter");
  const before = process.env.POW_SECRET; process.env.POW_SECRET = "another-secret-0123456789abcdef";
  ok(clientKeyOf("198.51.100.7", T) !== a, "the key depends on the server-side secret (a keyed digest, not a plain hash)");
  process.env.POW_SECRET = before;
  newFile("no-address.json");
  for (const ip of ["198.51.100.7", "203.0.113.200", "2001:db8:1:2:aaaa::1"]) refuse({ address: ip, userAgent: "Mozilla/5.0 (X11; Linux x86_64) secret-build-tag", route: "route", rule: "client-rate", now: T });
  await flush({ now: T });
  const text = JSON.stringify(await report({ now: T })) + readFileSync(process.env.DISCOVERY_REFUSALS_FILE, "utf8");
  ok(!/198\.51\.100|203\.0\.113|2001:db8/i.test(text), "neither the report nor the stored document holds an address");
  ok(!/secret-build-tag|Linux|5\.0/.test(text) && /"mozilla"/.test(text), "nor the User-Agent string: only its family");
}

// --- 1c. User-Agent family
{
  const cases = [["agent402-client/0.8.16 node/22", "agent402-client"], ["python-requests/2.31.0", "python-requests"], ["Mozilla/5.0 (Macintosh)", "mozilla"], ["curl/8.4.0", "curl"], ["Go-http-client/1.1", "go-http-client"], ["node", "node"], ["python3.11", "python"], ["okhttp-4.12.0", "okhttp"], ["", "none"], [undefined, "none"], ["()<script>", "script"], ["42/1", "none"]];
  for (const [ua, want] of cases) ok(uaFamilyOf(ua) === want, `User-Agent ${JSON.stringify(ua)} reads as family "${want}" (${uaFamilyOf(ua)})`);
  ok(uaFamilyOf("X".repeat(200) + "/1.0").length === 40, "a family is at most 40 characters");
}

// --- 1d. the cap and the `other` bucket keep totals exact; memory is bounded
{
  process.env.DISCOVERY_REFUSALS_MAX_CLIENTS = "5";
  newFile("cap.json");
  let total = 0;
  // Three heavy clients and a long tail of single refusals.
  for (const [ip, count] of [["198.51.100.1", 40], ["198.51.100.2", 25], ["198.51.100.3", 10]]) for (let i = 0; i < count; i++) { refuse({ address: ip, userAgent: "scanner/1", route: "route", rule: "client-rate", now: T }); total++; }
  for (let i = 0; i < 300; i++) { refuse({ address: `203.0.${Math.floor(i / 250)}.${i % 250}`, userAgent: `agent${i % 3}/1`, route: "find", rule: "shared-compute", now: T }); total++; }
  const mem = memory();
  ok(mem.pendingClients <= 5 && mem.addresses <= 20, `memory holds at most the cap of clients and four times that of addresses (${JSON.stringify(mem)})`);
  let d = await today();
  ok(d.refused === total && total === 375, `the day's total is exact past the cap (${d.refused})`);
  ok(d.topClients.reduce((s, c) => s + c.refused, 0) + d.other.refused === d.refused, "the top rows plus the other remainder equal the total");
  ok(d.topClients[0].refused === 40 && d.topClients[1].refused === 25 && d.topClients[2].refused === 10, "the heaviest clients keep their rows; the tail is what folds");
  ok(d.distinctRefusedClients === 303 && d.distinctIsUpperBound === true, `folded clients still count as distinct, marked an upper bound (${d.distinctRefusedClients})`);
  ok(d.topShare.top1 === Number((40 / 375).toFixed(4)) && d.topShare.top5 >= d.topShare.top1 && d.topShare.top20 >= d.topShare.top5 && d.topShare.top20 <= 1, `the top 1, 5 and 20 shares are of the exact total (${JSON.stringify(d.topShare)})`);
  // The same holds after the stored merge.
  await flush({ now: T });
  for (let i = 0; i < 30; i++) { refuse({ address: `192.0.2.${i}`, userAgent: "late/1", route: "route", rule: "inflight", now: T }); total++; }
  await flush({ now: T });
  d = await today();
  const stored = JSON.parse(readFileSync(process.env.DISCOVERY_REFUSALS_FILE, "utf8"));
  const sd = (stored.body || stored).days[DAY];
  ok(Object.keys(sd.clients).length <= 5, "the stored day holds at most the cap of clients");
  ok(d.refused === total && d.topClients.reduce((s, c) => s + c.refused, 0) + d.other.refused === total, `the total is still exact after two stored merges (${d.refused} of ${total})`);
  ok(Object.values(sd.clients).reduce((s, c) => s + c.r, 0) + sd.other.refused === sd.refused, "in the stored day, client rows plus other equal the total");
  // enforceCap and mergeDay directly.
  const day = { refused: 6, byRoute: {}, byUa: {}, clients: { aaaaaaaaaaaaaaaa: { u: "a", r: 1, s: 2, ok: 1 }, bbbbbbbbbbbbbbbb: { u: "b", r: 5, s: 0, ok: 0 } }, other: { refused: 0, clients: 0, served: 0, succeeded: 0, paid: 0 } };
  const merged = mergeDay(day, null, 1);
  ok(Object.keys(merged.clients).join() === "bbbbbbbbbbbbbbbb" && merged.other.refused === 1 && merged.other.clients === 1 && merged.other.succeeded === 1 && merged.other.served === 2, "the client with the fewest refusals is the one folded, with its marks");
  ok(enforceCap(mergeDay(day, null, 9), 9).other.refused === 0, "under the cap nothing folds");
  delete process.env.DISCOVERY_REFUSALS_MAX_CLIENTS;
}

// --- 1e. refused, then served or calling a tool
{
  newFile("flags.json");
  ok(served("198.51.100.50", T) === false && called("198.51.100.50", { paid: true, now: T }) === false, "a client that was never refused is not tracked when served or paid");
  ok(memory().pendingClients === 0 && memory().addresses === 0, "and costs no memory");
  refuse({ address: "198.51.100.50", userAgent: "agent402-client/0.8.16", route: "route", rule: "client-rate", now: T });
  refuse({ address: "198.51.100.51", userAgent: "curl/8", route: "route", rule: "client-rate", now: T });
  refuse({ address: "198.51.100.52", userAgent: "curl/8", route: "find", rule: "client-compute", now: T });
  refuse({ address: "198.51.100.53", userAgent: "curl/8", route: "find", rule: "client-compute", now: T });
  let d = await today();
  ok(d.refusedThenSucceeded === 0 && d.topClients.every((c) => c.wentOnToSucceed === false && c.servedAfterRefusal === 0), "refused only: nobody is marked as succeeding");
  ok(served("198.51.100.50", T + 60_000) === true && served("198.51.100.50", T + 61_000) === true, "a refused client served later is found");
  ok(called("198.51.100.51", { paid: true, now: T + 62_000 }) === true && called("198.51.100.52", { paid: false, now: T + 63_000 }) === true, "so is one that completes a paid or a free tool call");
  d = await today();
  const by = (ua, refusedRule) => d.topClients.find((c) => c.client === clientKeyOf(refusedRule, T));
  const c50 = by(null, "198.51.100.50"), c51 = by(null, "198.51.100.51"), c52 = by(null, "198.51.100.52"), c53 = by(null, "198.51.100.53");
  ok(c50.wentOnToSucceed && c50.servedAfterRefusal === 2 && c50.searchServed && !c50.paidCall && c50.userAgentFamily === "agent402-client", `served twice after its refusal (${JSON.stringify(c50)})`);
  ok(c51.wentOnToSucceed && c51.paidCall && !c51.searchServed && c52.wentOnToSucceed && c52.freeCall && !c52.paidCall, "the paid and the free call are marked apart");
  ok(c53.wentOnToSucceed === false, "the client that never came back is not marked");
  ok(d.refusedThenSucceeded === 3 && d.refusedThenPaid === 1 && d.distinctRefusedClients === 4, `the day counts refused clients that went on to succeed (${d.refusedThenSucceeded} of ${d.distinctRefusedClients}, ${d.refusedThenPaid} paid)`);
  ok(served("198.51.100.50", T + 86_400_000) === false, "the mark is for the same UTC day only");
}

// --- 1f. store round trip, and a client refused before a restart
{
  newFile("roundtrip.json");
  refuse({ address: "198.51.100.60", userAgent: "node", route: "find", rule: "shared-compute", now: T });
  refuse({ address: "198.51.100.61", userAgent: "node", route: "route", rule: "client-rate", now: T });
  served("198.51.100.61", T + 1000);
  const before = await today();
  const f = await flush({ now: T });
  ok(f.ok && f.flushed && existsSync(process.env.DISCOVERY_REFUSALS_FILE), "a flush writes the document");
  ok((await flush({ now: T })).flushed === false, "with nothing pending a flush writes nothing");
  reset(); // a new process: memory gone, the document stays
  const after = await today();
  ok(JSON.stringify(after) === JSON.stringify(before), "after a restart the report reads the same day back");
  ok(served("198.51.100.60", T + 2000) === false, "before the stored keys are read, a served client is not found");
  const l = await load({ now: T });
  ok(l.ok && l.clients === 2, `the start reads today's stored client keys (${JSON.stringify(l)})`);
  ok(served("198.51.100.99", T + 3000) === false && served("198.51.100.60", T + 3000) === true, "a client refused before the restart is found when served after it; another address is not");
  await flush({ now: T });
  const d = await today();
  ok(d.refused === 2 && d.refusedThenSucceeded === 2 && d.distinctRefusedClients === 2, `the mark lands on the stored client without a second row (${JSON.stringify({ r: d.refused, s: d.refusedThenSucceeded, c: d.distinctRefusedClients })})`);
  // Retention: 8 days.
  refuse({ address: "198.51.100.62", userAgent: "node", route: "find", rule: "inflight", now: T + 7 * 86_400_000 });
  await flush({ now: T + 7 * 86_400_000 });
  ok((await report({ now: T + 7 * 86_400_000 })).days.length === 2, "a day seven days old is still kept");
  refuse({ address: "198.51.100.62", userAgent: "node", route: "find", rule: "inflight", now: T + 8 * 86_400_000 });
  await flush({ now: T + 8 * 86_400_000 });
  const kept = (await report({ now: T + 8 * 86_400_000 })).days.map((x) => x.day);
  ok(!kept.includes(DAY) && kept.length === 2 && M.KEEP_DAYS === 8, `a day is deleted after 8 days (${kept})`);
  reset();
}

// --- 2. source: where the server counts
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
{
  const gate = src.slice(src.indexOf("async function serveCachedDiscovery("), src.indexOf("// Remember each /api/route and /api/find answer briefly"));
  for (const rule of ["client-rate", "client-compute", "shared-compute", "inflight", "deadline"]) ok(gate.includes(`refused("${rule}")`), `serveCachedDiscovery counts the ${rule} refusal`);
  ok((gate.match(/status = (429|503)/g) || []).length === (gate.match(/refused\("/g) || []).length, "every 429 and 503 the gate answers is counted under a rule");
  ok(/rule: "load-gate"/.test(src.slice(src.indexOf("const why = shouldShedFree("), src.indexOf("// Canonical host"))), "the load gate counts a search it turns away");
  ok(/noteDiscoveryClientCall\(clientIp\(req\), \{ paid: method === "usdc" \|\| method === "credits" \}\)/.test(src), "a finished tool call marks a refused client, paid or free");
  // The limiter and the per-client share are read nowhere but the search gate.
  ok(src.split("discoveryComputeLimiter.check(").length === 2 && src.split("discoveryClientBudget(clientIp").length === 2, "no tool route reads the search limiter or the per-client compute share");
}

// --- 3. booted server
const TOKEN = "discovery-refusals-operator-token-0123456789";
const HANG = "hang-marker-51c2";
const DEADLINE_MS = 1500;
const stores = ownStoreEnv("discovery-refusals");
const boot = async () => {
  try {
    const srv = await bootServer({
      stores: false,
      env: {
        ...stores, TRUST_PROXY_HOPS: "1", FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "",
        AGENT402_OPERATOR_TOKEN: TOKEN, DISCOVERY_TEST_HANG_QUERY: HANG, DISCOVERY_COMPUTE_DEADLINE_MS: String(DEADLINE_MS), DISCOVERY_MAX_INFLIGHT: "1",
        DISCOVERY_COMPUTE_PER_MIN: "3", DISCOVERY_CPU_BUDGET_MS: "600000", DISCOVERY_CLIENT_CPU_MS: "600000", DISCOVERY_REFUSALS_FLUSH_MS: "1000", RATE_LIMIT_REPLICAS: "1",
      },
    });
    return { base: srv.url, up: true, stop: srv.stop };
  } catch (e) { console.error(String(e?.message || e).slice(-1500)); return { up: false, stop: async () => {} }; }
};
const ask = async (base, path, q, ip, ua = "agent402-client/0.8.16 node/22", method = "GET") => {
  const r = method === "GET"
    ? await fetch(`${base}${path}?q=${encodeURIComponent(q)}&include=local&top=3`, { headers: { "X-Forwarded-For": ip, "User-Agent": ua } })
    : await fetch(`${base}${path}`, { method: "POST", headers: { "X-Forwarded-For": ip, "User-Agent": ua, "content-type": "application/json" }, body: JSON.stringify({ q, include: "local", top: 3 }) });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body };
};
const opGet = (base, headers = {}) => fetch(`${base}/__operator/discovery-refusals.json`, { headers });
const utc = () => new Date().toISOString().slice(0, 10);
// The run must not straddle 00:00 UTC: the day under test is read once.
if (new Date().getUTCHours() === 23 && new Date().getUTCMinutes() >= 57) await sleep((60 - new Date().getUTCSeconds() + 185) * 1000);
const bootDay = utc();

const A = "203.0.113.21", B = "203.0.113.22", C = "203.0.113.23";
let srv = await boot();
try {
  ok(srv.up, "server booted");
  const { base } = srv;
  // The operator route.
  const anon = await opGet(base);
  ok(anon.status === 404, `without a token the operator route answers 404 (${anon.status})`);
  const wrong = await opGet(base, { authorization: "Bearer not-the-token" });
  ok(wrong.status === 404, "and with a wrong one");
  const authed = await opGet(base, { authorization: `Bearer ${TOKEN}` });
  const cc = authed.headers.get("cache-control") || "";
  ok(authed.status === 200 && /private/.test(cc) && /no-store/.test(cc), `with the token it answers 200, private and no-store (${cc})`);
  const empty = await authed.json();
  ok(Array.isArray(empty.days) && empty.keepDays === 8 && empty.days.every((d) => d.refused === 0), "before any refusal it reports no refusals");

  // client-rate: three uncached searches a minute here; the fourth and fifth are refused.
  const first = [];
  for (let i = 0; i < 3; i++) first.push(await ask(base, "/api/find", `convert csv to json variant ${i}`, A));
  ok(first.every((r) => r.status === 200), `searches inside the limit are served (${first.map((r) => r.status)})`);
  const r4 = await ask(base, "/api/find", "hash a string with sha256", A);
  const r5 = await ask(base, "/api/route", "resize an image to a thumbnail", A, undefined, "POST");
  ok(r4.status === 429 && r5.status === 429, `past it the client is answered 429 on both routes (${r4.status}, ${r5.status})`);
  ok(r4.retryAfter === "60" && r4.body?.retryAfterSeconds === 60, "the 429 carries Retry-After and retryAfterSeconds");
  ok(r4.body?.reason === "discovery-client-rate" && /Tool calls, paid or proof-of-work, are not counted against it/.test(r4.body?.toolCalls || ""), `it names its rule and says tool calls are outside this limit (${JSON.stringify(r4.body)})`);
  ok(/30 uncached searches a minute and 600 an hour/.test(r4.body?.detail || ""), "the published limit text is unchanged");

  // inflight and deadline: one slot here; a hung compute holds it.
    const hung = ask(base, "/api/route", `${HANG} one`, B, "python-requests/2.31.0");
  await sleep(400);
  const shut = await ask(base, "/api/find", "parse a date string", C, "curl/8.4.0");
  ok(shut.status === 503 && shut.body?.reason === "discovery-inflight" && shut.retryAfter === "2" && shut.body?.retryAfterSeconds === 2, `with the slot held another client is shed with Retry-After (${shut.status} ${JSON.stringify(shut.body)})`);
  const late = await hung;
  ok(late.status === 503 && late.body?.reason === "discovery-deadline", "the hung compute answers at the deadline");
  // The shed client retries once the slot is free and is served.
  const retry = await ask(base, "/api/find", "parse a date string", C, "curl/8.4.0");
  ok(retry.status === 200, `the shed client's retry is served (${retry.status})`);
  // Our own loopback caller (no forwarding header) is never limited or counted.
  for (let i = 0; i < 6; i++) await fetch(`${base}/api/find?q=${encodeURIComponent(`loopback sweep ${i}`)}`);

  const rep = await (await opGet(base, { authorization: `Bearer ${TOKEN}` })).json();
  const d = rep.days.find((x) => x.day === bootDay);
  ok(d && d.refused === 4, `four refusals are counted for the day (${d?.refused})`);
  ok(d.byRoute.find === 2 && d.byRoute.route === 2, `by route (${JSON.stringify(d.byRoute)})`);
  ok(d.byRule["client-rate"] === 2 && d.byRule.inflight === 1 && d.byRule.deadline === 1 && d.byRule["client-compute"] === 0, `and by rule (${JSON.stringify(d.byRule)})`);
  ok(d.distinctRefusedClients === 3 && d.topClients.length === 3 && d.topClients[0].refused === 2, "three clients, the limited one first");
  const top = d.topClients[0];
  ok(/^[0-9a-f]{16}$/.test(top.client) && top.userAgentFamily === "agent402-client" && top.servedAfterRefusal === 0 && top.wentOnToSucceed === false, `the top row carries a digest, a family, the served count and the mark (${JSON.stringify(top)})`);
  const shed = d.topClients.find((c) => c.userAgentFamily === "curl");
  ok(shed.servedAfterRefusal === 1 && shed.wentOnToSucceed === true && shed.searchServed === true && shed.paidCall === false, `the client served after its refusal is marked (${JSON.stringify(shed)})`);
  ok(d.topClients.map((c) => c.userAgentFamily).sort().join() === "agent402-client,curl,python-requests", "each client's User-Agent is reduced to its family");
  ok(d.refusedThenSucceeded === 1 && d.topShare.top1 === 0.5 && d.topShare.top5 === 1 && d.topShare.top20 === 1 && d.other.refused === 0, `one refused client went on to be served; shares of the total (${JSON.stringify(d.topShare)})`);
  const text = JSON.stringify(rep);
  ok(!/203\.0\.113|127\.0\.0\.1|node\/22|2\.31/.test(text), "the operator answer holds no address and no User-Agent string");
  for (const path of ["/api/gateway-status", "/api/stats", "/health"]) {
    const pub = await (await fetch(`${base}${path}`)).text();
    ok(!pub.includes(top.client) && !/discoveryRefusals|discovery-refusals/.test(pub), `${path} carries nothing of the counter`);
  }

  // Restart: the day's counts and clients are read back, and a client refused
  // before the restart is marked when it is served after it.
  await sleep(1300); // one flush interval
  await srv.stop();
  srv = await boot();
  ok(srv.up, "server booted again on the same stores");
  const rep2 = await (await opGet(srv.base, { authorization: `Bearer ${TOKEN}` })).json();
  const d2 = rep2.days.find((x) => x.day === bootDay);
  ok(d2 && d2.refused === 4 && d2.topClients[0].client === top.client && d2.byRule.inflight === 1, `the counts survive the restart (${d2?.refused})`);
  await sleep(600); // the start's read of today's stored keys
  const back = await ask(srv.base, "/api/find", "parse a date string", B, "python-requests/2.31.0");
  ok(back.status === 200, "the client refused before the restart is served after it");
  const rep3 = await (await opGet(srv.base, { authorization: `Bearer ${TOKEN}` })).json();
  const d3 = rep3.days.find((x) => x.day === bootDay);
  const curl = d3.topClients.find((c) => c.userAgentFamily === "python-requests");
  ok(curl?.wentOnToSucceed === true && curl.servedAfterRefusal === 1 && d3.refusedThenSucceeded === 2 && d3.distinctRefusedClients === 3, `and is marked on its stored row (${JSON.stringify(curl)})`);
} finally {
  await srv.stop();
}

console.log(`\n${n} passed`);
process.exit(0);
