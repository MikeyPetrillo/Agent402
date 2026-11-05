#!/usr/bin/env node
// Hourly budget on unpaid price checks per client (src/unpaid-quote-budget.js).
//
// An unpaid request to a priced route earns a 402 with the route's challenges.
// That is free to read and every indexer starts there; the budget exists to
// stop one client walking the whole catalog many times an hour, and must never
// touch the traffic it is not about. So the pure half pins the arithmetic
// (env parsing where a typo must not switch it off, the hour window, the
// Retry-After countdown, bounded memory) and the booted half pins who is NOT
// counted, on a real paid server, because a regression there throttles a
// buyer or an indexer rather than a burst:
//
//   budget 5, one User-Agent: five unpaid requests pass, the sixth is a 429 with
//   Retry-After and a hint that points at /crawler; a POST alias and a HEAD on
//   another priced route count against the same client;
//   the same route spelled with a trailing slash, in capitals, with a doubled
//   slash or percent-escaped is the same route and is counted (an exact lookup
//   on the path as written read those as unpriced while the paywall still built
//   the challenge, which is a budget anyone could walk around);
//   a request carrying a PLAUSIBLE payment header, credits key or proof-of-work
//   solution is never a 429 (it reaches the gates and may be a 402), while a
//   junk one is counted like any other request;
//   a client that settles a payment is not counted for the rest of the hour
//   (every purchase opens with one bare unpaid request, so a buyer would
//   otherwise spend this budget on its own purchases);
//   the key is the client ADDRESS alone (req.ip, an IPv6 /64 as one): a
//   second User-Agent from the same address is the same client, so rotating
//   User-Agents buys nothing; behind the CDN proxy the key is the resolved
//   client (src/cdn-client-ip.js), and a CF-Connecting-IP from a peer that is
//   not the CDN changes nothing;
//   a User-Agent naming one of our own probes is counted like any other: only
//   the signed heartbeat marker exempts, and a forged one does not;
//   a self-declared named indexer or search crawler is counted on its
//   address against NAMED_CLIENT_BUDGET_MULTIPLIER times the budget, never a
//   pass; the MCP connector's loopback is never counted;
//   the discovery documents, pages and unknown paths are never budgeted;
//   a stats read taken in a new hour reports this hour, not the last one;
//   /crawler quotes the budget the gate enforces and /robots.txt points at it;
//   UNPAID_QUOTE_BUDGET_PER_HOUR=off never throttles; a FREE_MODE boot never
//   throttles (no paywall there, and CI sweeps boot in that mode).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

const POW_SECRET = "test-unpaid-quote-budget-secret";
process.env.POW_SECRET = POW_SECRET;
delete process.env.UNPAID_QUOTE_BUDGET_PER_HOUR;
// The connector marker carries a per-process secret (src/mcp-loopback.js); the
// booted servers below inherit this one, the in-process module reads it too.
const MCP_MARKER = `mcp;k=${(process.env.MCP_LOOPBACK_TEST_SECRET = "6b".repeat(24))}`;

const {
  DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR, UNPAID_QUOTE_BUDGET_LOG_CAP, createUnpaidQuoteBudget, unpaidQuoteBudgetPerHour,
  hasCredentialHeader, looksLikePayment, looksLikePowSolution, hasSettlementReceipt, normalizeCatalogPath,
  isNamedClientUserAgent, clientKeyOf, NAMED_CLIENT_BUDGET_MULTIPLIER, isMcpLoopback, isExemptPath, secondsToHourBoundary,
} = await import("../src/unpaid-quote-budget.js");
const { crawlerPage, catalogCrawlSection } = await import("../src/crawler-page.js");
const { perReplica } = await import("../src/rate-limit.js");
const { issueChallenge, issueHeartbeatToken } = await import("../src/pow.js");

let pass = 0;
const procs = [];
let facilitator = null;
const dirs = [];
const cleanup = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  try { facilitator?.close(); } catch { /* closed */ }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
};
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

// ---- pure half -------------------------------------------------------------
ok(DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR === 3000, "the default budget is 3000 unpaid price checks per client per hour");
ok(unpaidQuoteBudgetPerHour({}) === 3000, "unset reads as the default");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "" }) === 3000, "empty reads as the default");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "0" }) === 0, "\"0\" disables");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "off" }) === 0 && unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: " OFF " }) === 0, "\"off\" disables, case and spaces ignored");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "abc" }) === 3000, "a malformed value reads as unset, never as off");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "-5" }) === 3000, "a negative value reads as unset, never as off");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "12.7" }) === 12 && unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "5" }) === 5, "a positive value is taken, whole requests");

ok(secondsToHourBoundary(10 * HOUR + HOUR - 1000) === 1, "Retry-After one second before the hour is 1");
ok(secondsToHourBoundary(10 * HOUR) === 3600, "Retry-After exactly on the hour is the whole hour");
ok(secondsToHourBoundary(10 * HOUR + 1) === 3600 && secondsToHourBoundary(10 * HOUR + 1800_000) === 1800, "Retry-After counts down to the top of the hour");

{
  const b = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true });
  const t0 = 50 * HOUR + 10_000;
  const r1 = b.hit("a", t0), r2 = b.hit("a", t0 + 1), r3 = b.hit("a", t0 + 2);
  ok(!r1.limited && !r2.limited && r3.limited && r3.count === 3, "budget 2: the third request in the hour is limited");
  ok(!b.hit("b", t0 + 3).limited, "a different key has its own count");
  ok(!b.hit("a", t0 + HOUR).limited, "the count resets when the UTC hour turns");
  const off = createUnpaidQuoteBudget({ budget: 0, isPriced: () => true });
  let limited = false;
  for (let i = 0; i < 50; i++) limited = limited || off.hit("a", t0 + i).limited;
  ok(!limited, "budget 0 never limits");
}
// Two containers enforce the published figure between them: each counts its
// RATE_LIMIT_REPLICAS share (perReplica, as every limiter in src/rate-limit.js
// does), the published figure is what the 429 and the operator read quote, and
// a share never divides below one request.
{
  const t0 = 55 * HOUR + 10_000;
  const two = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true, replicas: 2 });
  let limitedAt = 0;
  for (let i = 1; i <= 10 && !limitedAt; i++) if (two.hit("a", t0 + i).limited) limitedAt = i;
  ok(limitedAt === 6, `budget 10 across two replicas: this replica limits the sixth request (limited at ${limitedAt})`);
  ok(two.stats(t0).budget === 10 && two.stats(t0).perReplicaBudget === 5, `the operator read carries the published figure and this replica's share (${JSON.stringify({ budget: two.stats(t0).budget, perReplicaBudget: two.stats(t0).perReplicaBudget })})`);
  const one = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true, replicas: 1 });
  limitedAt = 0;
  for (let i = 1; i <= 12 && !limitedAt; i++) if (one.hit("a", t0 + i).limited) limitedAt = i;
  ok(limitedAt === 11, `control: one replica limits the eleventh (limited at ${limitedAt})`);
  const floor = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, replicas: 4 });
  ok(!floor.hit("a", t0).limited && floor.hit("a", t0 + 1).limited && floor.stats(t0).perReplicaBudget === 1, "a share never divides below one request (a budget of zero is an outage, not a limit)");
  const def = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true });
  ok(def.stats(t0).perReplicaBudget === perReplica(10), `with no replica count handed in, the share is RATE_LIMIT_REPLICAS's (${def.stats(t0).perReplicaBudget})`);
  const req = (over = {}) => ({ method: "GET", path: "/api/uuid", ip: "10.0.0.3", headers: { "user-agent": "walker/2" }, socket: { remoteAddress: "10.0.0.3" }, ...over });
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, once() { return this; } };
  const mw = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true, replicas: 2, log: () => {} });
  for (let i = 0; i < 6; i++) mw.middleware(req(), res, () => {});
  ok(res.code === 429 && /budget 10 per hour/.test(res.body?.hint || ""), "the 429 quotes the published figure, not this replica's share");
}
{
  const b = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true, keyCap: 3 });
  const t = 60 * HOUR;
  b.hit("k1", t); b.hit("k2", t); b.hit("k3", t);
  b.hit("k1", t);          // k1 is now the most recently seen
  b.hit("k4", t);          // over the cap: the least recently seen (k2) goes
  ok(b.stats(t).clientsThisHour === 3, "memory is bounded at the key cap");
  ok(b.hit("k2", t).count === 1 && b.hit("k1", t).count === 3, "the least recently seen key is dropped first, an active one is kept");
}
// A credential must LOOK like one. `Authorization: x` used to buy an exemption
// here, the same class the metered quote limiter closed in its own review, so
// these shapes are now the ONE rule both read (looksLikePayment).
// It must also DECODE to one (src/payment-attempt.js): an x402 payload naming
// a scheme and an offered network, or a Payment credential with a challenge
// and a payload. Junk bytes of any length are counted like any other request.
const REAL_PAYMENT = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} })).toString("base64");
const JUNK_PAYMENT = "A".repeat(40);
const REAL_MPP = `Payment ${Buffer.from(JSON.stringify({ challenge: { id: "c1", realm: "test.local", method: "evm", intent: "charge", request: {} }, payload: {} })).toString("base64url")}`;
const REAL_POW = `${issueChallenge("hash").token}:41`;
ok(looksLikePayment({ "payment-signature": REAL_PAYMENT }) && looksLikePayment({ "x-payment": REAL_PAYMENT }), "a payment header that decodes to a scheme and an offered network is a plausible credential");
ok(looksLikePayment({ authorization: "Bearer a402_notarealkey" }) && looksLikePayment({ authorization: REAL_MPP }), "a credits key and an MPP Payment credential that decodes are plausible credentials");
ok(!looksLikePayment({ authorization: "x" }) && !looksLikePayment({ authorization: "Bearer junk" }) && !looksLikePayment({ "payment-signature": "bm90LWEtcGF5bWVudA" }), "junk in an Authorization or a too-short payment header is NOT a credential");
ok(!looksLikePayment({ "payment-signature": JUNK_PAYMENT }) && !looksLikePayment({ "x-payment": JUNK_PAYMENT }) && !looksLikePayment({ authorization: `Payment ${JUNK_PAYMENT}` }), "a long junk payment header or Payment credential that does not decode is NOT a credential either");
ok(looksLikePowSolution(REAL_POW), "the `<token>:<nonce>` shape pow.js issues is a plausible proof-of-work solution");
ok(!looksLikePowSolution("a:b") && !looksLikePowSolution("not-a-token:1") && !looksLikePowSolution(issueChallenge("hash").token) && !looksLikePowSolution(`${issueChallenge("hash").token}:`), "junk, a token with no nonce and a nonce with no token are not solutions");
ok(hasCredentialHeader({ "payment-signature": REAL_PAYMENT }) && hasCredentialHeader({ "x-pow-solution": REAL_POW }), "a plausible payment or proof-of-work header marks a request as not a price check");
ok(!hasCredentialHeader({}) && !hasCredentialHeader({ authorization: "  " }) && !hasCredentialHeader({ "user-agent": "x" }) && !hasCredentialHeader({ authorization: "x", "x-pow-solution": "a:b" }), "an absent, blank or junk header is not a credential");

// The path an exact catalog lookup has to use: the router matches a trailing
// slash and any capitalization, and the paywall resolves a doubled slash or a
// percent-escaped spelling, so all of these are the same priced route.
ok(["/api/uuid/", "/API/UUID", "//api/uuid", "/api/%75uid", "/api//uuid/"].every((p) => normalizeCatalogPath(p) === "/api/uuid"), "a trailing slash, capitals, a doubled slash and a percent escape all normalize to the route");
ok(normalizeCatalogPath("/") === "/" && normalizeCatalogPath("") === "/" && normalizeCatalogPath("//") === "/", "the root stays the root");
ok(normalizeCatalogPath("/api/%zz") === "/api/%zz", "a malformed escape stays as written rather than throwing");
ok(isExemptPath("/api/pricing/") && isExemptPath("/MCP") && isExemptPath("/openapi.json"), "an exempt path is exempt however it is spelled");

// A settlement receipt on a response the buyer was actually served.
const receiptHeader = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
ok(hasSettlementReceipt({ statusCode: 200, getHeader: (k) => (k.toLowerCase() === "payment-response" ? receiptHeader({ success: true, transaction: "0x1" }) : undefined) }), "an x402 settle receipt on a 200 is a settlement");
ok(hasSettlementReceipt({ statusCode: 200, getHeader: (k) => (k === "Payment-Receipt" ? "signed-receipt" : undefined) }), "an MPP Payment-Receipt on a 200 is a settlement");
ok(!hasSettlementReceipt({ statusCode: 200, getHeader: (k) => (k.toLowerCase() === "payment-response" ? receiptHeader({ success: false }) : undefined) }), "a receipt that reports failure is not a settlement");
ok(!hasSettlementReceipt({ statusCode: 402, getHeader: () => "Payment-Receipt" }) && !hasSettlementReceipt({ statusCode: 200, getHeader: () => undefined }) && !hasSettlementReceipt(null), "a refused response, a response with no receipt and no response at all are not settlements");
ok(isNamedClientUserAgent("x402scan/1.0") && isNamedClientUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), "a named indexer and a search crawler are named clients (a larger bucket, not a pass)");
ok(!isNamedClientUserAgent("agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)") && !isNamedClientUserAgent("agent402-heartbeat/1.0") && !isNamedClientUserAgent("agent402-status-probe/1.0"), "our own User-Agents are not named clients: a probe of ours is known by its signed marker, never by what it calls itself");
ok(!isNamedClientUserAgent("curl/8.4") && !isNamedClientUserAgent("") && !isNamedClientUserAgent("python-httpx/0.27"), "an unnamed client is not a named client");
ok(NAMED_CLIENT_BUDGET_MULTIPLIER === 10, "a named client reads against ten times the budget");
// The key is the address req.ip carries, folded to its /64, never a header.
ok(clientKeyOf({ ip: "203.0.113.9", headers: { "user-agent": "a/1", "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" } }) === "203.0.113.9", "the key is req.ip alone: neither the User-Agent nor a forwarding header a caller wrote moves it");
ok(clientKeyOf({ ip: "2001:db8:1:2::1" }) === clientKeyOf({ ip: "2001:db8:1:2:ffff:aaaa:bbbb:cccc" }) && clientKeyOf({ ip: "2001:db8:1:2::1" }) !== clientKeyOf({ ip: "2001:db8:1:3::1" }), "two IPv6 addresses in one /64 are one key, the next /64 is another");
ok(clientKeyOf({ socket: { remoteAddress: "10.1.1.1" } }) === "10.1.1.1" && clientKeyOf({}) === "-", "with no req.ip the socket address is the key");

// The middleware, in process: what a walker can and cannot do to its key.
{
  const fakeReq = (ip, headers = {}) => ({ method: "GET", path: "/api/uuid", ip, headers, socket: { remoteAddress: ip } });
  const fakeRes = () => ({ statusCode: 200, set() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, once() { return this; } });
  const run = (b, req) => { const res = fakeRes(); let nexted = false; b.middleware(req, res, () => { nexted = true; }); return nexted ? "next" : res.statusCode; };
  const mk = (extra = {}) => createUnpaidQuoteBudget({ budget: 3, isPriced: () => true, replicas: 1, log: () => {}, ...extra });

  const rot = mk();
  const rotGot = [];
  for (let i = 0; i < 4; i++) rotGot.push(run(rot, fakeReq("203.0.113.1", { "user-agent": `walker-${i}/1.0` })));
  ok(rotGot.slice(0, 3).every((s) => s === "next") && rotGot[3] === 429, `a new User-Agent on every request from one address is refused once the address spends the budget (got ${rotGot.join(",")})`);

  const own = mk();
  const ownGot = [];
  for (const ua of ["agent402-heartbeat/1.0", "agent402-status-probe/1.0", "agent402-ci-sweep/1.0", "agent402-paid-canary"]) ownGot.push(run(own, fakeReq("203.0.113.2", { "user-agent": ua })));
  ok(ownGot.slice(0, 3).every((s) => s === "next") && ownGot[3] === 429, `our own User-Agent strings without the signed marker are counted like any other client (got ${ownGot.join(",")})`);

  const marked = mk({ isSynthetic: (r) => r.headers["x-heartbeat-token"] === "signed" });
  for (let i = 0; i < 3; i++) run(marked, fakeReq("203.0.113.3"));
  ok(run(marked, fakeReq("203.0.113.3")) === 429, "control: the address is spent");
  ok([1, 2, 3, 4, 5].every(() => run(marked, fakeReq("203.0.113.3", { "user-agent": "agent402-heartbeat/1.0", "x-heartbeat-token": "signed" })) === "next"), "a request carrying the signed marker is never counted, even from a spent address");
  ok(run(marked, fakeReq("203.0.113.3", { "user-agent": "agent402-heartbeat/1.0", "x-heartbeat-token": "forged" })) === 429, "a marker that does not verify is counted");

  const named = mk();
  const bot = { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" };
  let botFirst429 = 0;
  for (let i = 1; i <= 40 && !botFirst429; i++) if (run(named, fakeReq("203.0.113.4", bot)) === 429) botFirst429 = i;
  ok(botFirst429 === 3 * NAMED_CLIENT_BUDGET_MULTIPLIER + 1, `a self-declared crawler reads past the plain budget and is refused past ten times it on its address (first 429 at ${botFirst429})`);
  ok(run(named, fakeReq("203.0.113.4", { "user-agent": "walker/1" })) === 429, "the crawler's reads are on its address's one count: a plain client there is refused too");
  const mixed = mk();
  for (let i = 0; i < 3; i++) run(mixed, fakeReq("203.0.113.5", { "user-agent": "walker/1" }));
  ok(run(mixed, fakeReq("203.0.113.5", { "user-agent": "walker/1" })) === 429 && run(mixed, fakeReq("203.0.113.5", bot)) === "next", "a spent plain client switching to a crawler's name gets the named allowance on the same count, never a fresh one");
  let mixed429 = 0;
  for (let i = 1; i <= 40 && !mixed429; i++) if (run(mixed, fakeReq("203.0.113.5", bot)) === 429) mixed429 = i;
  ok(mixed429 > 0 && mixed429 <= 3 * NAMED_CLIENT_BUDGET_MULTIPLIER, `...and that allowance is bounded by the address's whole count (refused after ${mixed429} more)`);

  const v6 = mk();
  for (let i = 0; i < 3; i++) run(v6, fakeReq(`2001:db8:5:6::${i + 1}`));
  ok(run(v6, fakeReq("2001:db8:5:6:ffff:1:2:3")) === 429, "two IPv6 addresses in one /64 share one budget");
  ok(run(v6, fakeReq("2001:db8:5:7::1")) === "next", "the next /64 has its own");
}
ok(isMcpLoopback({ headers: { "x-agent402-via": MCP_MARKER }, socket: { remoteAddress: "127.0.0.1" } }) && isMcpLoopback({ headers: { "x-agent402-via": MCP_MARKER }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "the MCP connector's loopback is recognized");
ok(!isMcpLoopback({ headers: { "x-agent402-via": MCP_MARKER }, socket: { remoteAddress: "10.0.0.5" } }), "the loopback marker from a non-local socket is ignored (the header alone is caller-settable)");
ok(!isMcpLoopback({ headers: { "x-agent402-via": "mcp" }, socket: { remoteAddress: "127.0.0.1" } }), "a marker without the secret on a local socket is not the connector (a same-host proxy)");
ok(!isMcpLoopback({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "a local socket without the marker is not the connector");
ok(isExemptPath("/mcp") && isExemptPath("/api/pricing") && isExemptPath("/openapi.json") && isExemptPath("/.well-known/x402") && !isExemptPath("/api/uuid"), "/mcp and the discovery surfaces are exempt paths, a tool route is not");

{
  const b = createUnpaidQuoteBudget({ budget: 1, isPriced: (m, p) => m === "GET" && p === "/api/uuid" });
  const req = (over = {}) => ({ method: "GET", path: "/api/uuid", headers: { "user-agent": "walker/1" }, socket: { remoteAddress: "10.0.0.9" }, ...over });
  ok(b.isCounted(req()), "an unpaid GET on a priced route is counted");
  ok(b.isCounted(req({ method: "HEAD" })) && b.isCounted(req({ method: "POST" })), "HEAD and a POST alias on a priced route are counted");
  ok(!b.isCounted(req({ method: "PUT" })) && !b.isCounted(req({ method: "OPTIONS" })), "methods no gate chain serves are not counted");
  ok(!b.isCounted(req({ path: "/tools" })) && !b.isCounted(req({ path: "/api/not-a-tool" })), "a page and an unpriced path are not counted");
  ok(["/api/uuid/", "/API/UUID", "//api/uuid", "/api/%75uid"].every((p) => b.isCounted(req({ path: p }))), "the same route spelled differently is still the route, and is counted");
  ok(b.isCounted(req({ headers: { "user-agent": "walker/1", authorization: "x" } })), "a junk Authorization does not buy an exemption");
  ok(!b.isCounted(req({ headers: { "user-agent": "walker/1", authorization: "Bearer a402_notarealkey" } })), "a plausible credits key is not a price check");
  ok(!b.isCounted(req({ headers: { "user-agent": "walker/1", "x-pow-solution": REAL_POW } })), "a plausible proof-of-work solution is not a price check");
  const synth = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, isSynthetic: (r) => r.headers["x-heartbeat-token"] === "yes" });
  ok(!synth.isCounted(req({ headers: { "user-agent": "walker/1", "x-heartbeat-token": "yes" } })), "a signed probe of our own is not counted");
  const broken = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, isSynthetic: () => { throw new Error("boom"); } });
  ok(broken.isCounted(req()), "an unreadable synthetic check counts the request (an unverified token is not ours)");
}

// ---- a buyer stops being counted once it settles ----------------------------
// Every stock x402 purchase opens with an unpaid bare request, so without this
// a buyer spends the budget on its own purchases and the 429 lands on the bare
// request: the client never sees the 402 it came for and the purchase fails.
{
  const fakeRes = () => {
    const hdrs = new Map();
    const finishers = [];
    const res = {
      statusCode: 200,
      set(k, v) { hdrs.set(String(k).toLowerCase(), v); return res; },
      setHeader(k, v) { hdrs.set(String(k).toLowerCase(), v); },
      getHeader: (k) => hdrs.get(String(k).toLowerCase()),
      status(c) { res.statusCode = c; return res; },
      json(b) { res.body = b; return res; },
      once(ev, fn) { if (ev === "finish") finishers.push(fn); return res; },
      finish() { for (const fn of finishers.splice(0)) fn(); },
    };
    return res;
  };
  const drive = (b, { headers = { "user-agent": "buyer/1" }, before } = {}) => {
    const req = { method: "GET", path: "/api/uuid", ip: "10.0.0.7", headers, socket: { remoteAddress: "10.0.0.7" } };
    const res = fakeRes();
    let nexted = false;
    b.middleware(req, res, () => { nexted = true; });
    if (before) before(res);
    res.finish();
    return { nexted, status: res.statusCode };
  };
  const budget = () => createUnpaidQuoteBudget({ budget: 2, isPriced: () => true });
  // Control first: with no settlement the third unpaid request IS a 429, so a
  // pass below means the settlement did it and not the arithmetic.
  const cold = budget();
  drive(cold); drive(cold);
  ok(drive(cold).status === 429, "control: at budget 2, the third unpaid price check from one client is a 429");

  // A client that paid on ANOTHER replica (2026-10-15): the shared record is
  // read on the refusal path, and a hit lets the request through.
  {
    const marks = [];
    const shared = (paid) => ({ mark: (k) => marks.push(k), has: async () => paid });
    const driveAsync = async (b) => {
      const req = { method: "GET", path: "/api/uuid", ip: "10.0.0.8", headers: { "user-agent": "buyer/2" }, socket: { remoteAddress: "10.0.0.8" } };
      const res = fakeRes(); let nexted = false;
      await b.middleware(req, res, () => { nexted = true; });
      return { nexted, status: res.statusCode };
    };
    const elsewhere = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true, sharedSettled: shared(true) });
    await driveAsync(elsewhere); await driveAsync(elsewhere);
    const r = await driveAsync(elsewhere);
    ok(r.nexted && r.status === 200, `a client that paid on another replica passes instead of a 429 (status ${r.status})`);
    const nowhere = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true, sharedSettled: shared(false) });
    await driveAsync(nowhere); await driveAsync(nowhere);
    ok((await driveAsync(nowhere)).status === 429, "...and one that paid nowhere is still refused");
    const local = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true, sharedSettled: shared(false) });
    local.noteSettled?.("10.0.0.9|x");
    ok(typeof local.noteSettled !== "function" || marks.includes("10.0.0.9|x"), "a settlement here is written to the shared record");
  }

  const warm = budget();
  drive(warm); drive(warm);
  const paid = drive(warm, {
    headers: { "user-agent": "buyer/1", "payment-signature": REAL_PAYMENT },
    before: (res) => res.setHeader("PAYMENT-RESPONSE", receiptHeader({ success: true, transaction: "0xabc" })),
  });
  ok(paid.nexted, "the paid retry itself is never counted");
  ok(drive(warm).nexted && drive(warm).nexted, "after one settlement the same client is not counted for the rest of the hour");
  ok(warm.stats().clientsSettledThisHour === 1, "the operator read counts the settled client");

  const refused = budget();
  drive(refused); drive(refused);
  drive(refused, {
    headers: { "user-agent": "buyer/1", "payment-signature": REAL_PAYMENT },
    before: (res) => { res.statusCode = 402; res.setHeader("PAYMENT-RESPONSE", receiptHeader({ success: false })); },
  });
  ok(drive(refused).status === 429, "a payment that did not settle clears nothing");
}

// A read taken in a new hour must report THIS hour. The window is cleared
// lazily by the next counted request, so early in an hour there may not have
// been one yet.
{
  let t = 70 * HOUR + 5_000;
  const b = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, now: () => t });
  b.hit("a"); b.hit("b");
  b.noteSettled("c");
  const inHour = b.stats();
  ok(inHour.clientsThisHour === 2 && inHour.clientsSettledThisHour === 1, "inside the hour the read reports the clients seen");
  ok(inHour.clientsThrottledCapAt === UNPAID_QUOTE_BUDGET_LOG_CAP && inHour.clientsThrottledCapped === false, "the read names the cap on the throttled-client count and says it is not capped");
  t += HOUR;
  const next = b.stats();
  ok(next.clientsThisHour === 0 && next.clientsSettledThisHour === 0 && next.clientsThrottledThisHour === 0, "a read in the next hour reports zero clients, not the previous hour's, before any counted request has arrived");
  ok(next.budget === 1 && next.throttledSinceBoot === 0, "the budget and the since-boot total are not hour-scoped");
}

{
  const page = crawlerPage("https://x.test", { unpaidQuoteBudget: 1234 });
  ok(page.includes("Crawling this catalog") && page.includes('id="crawling-this-catalog"'), "/crawler carries the section, anchored");
  ok(page.includes("Past 1,234 in an hour"), "/crawler quotes the budget it is handed, formatted");
  ok(page.includes("per client address, whatever the User-Agent") && !/one User-Agent product token/.test(page), "/crawler says the budget is per address, not per User-Agent");
  ok(page.includes("against 12,340 unpaid requests per address") && !/crawlers are not budgeted/.test(page), "/crawler quotes the named-client allowance and no longer says named crawlers are not budgeted");
  ok(page.includes("If-None-Match") && page.includes("/api/pricing") && page.includes("/.well-known/x402"), "/crawler names the three documents and the conditional read");
  ok(!/\u2014|\u2013/.test(catalogCrawlSection(1234).p.join(" ")), "the section carries no em or en dashes");
  ok(crawlerPage("https://x.test", { unpaidQuoteBudget: 0 }).includes("sets no hourly budget"), "with the budget off the page says no budget is enforced, never a number");
  ok(crawlerPage("https://x.test").includes(`Past ${DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR.toLocaleString("en-US")} in an hour`), "with no figure handed in, the page derives the gate's own default");
}

// ---- booted half -----------------------------------------------------------
const [PAID, OFF, FREE, FAC] = await getFreePorts(4);
facilitator = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
});
await new Promise((r) => facilitator.listen(FAC, "127.0.0.1", r));

const quiet = {
  X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
  FREE_ALERTS: "off", FOLLOWUPS: "off", SOLANA_LEADERBOARD: "off",
};
const paidEnv = {
  FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  MPP_SECRET_KEY: "",
  // A paid boot needs the facilitator handshake (against the local stub above)
  // or @x402/core answers 500 where it should build a 402; the leaderboard's
  // first chain refresh is pushed past the test so the boot makes no RPC reads.
  X402_SYNC_ON_START: "", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000",
};
function boot(port, env) {
  const trafficDir = mkdtempSync(join(tmpdir(), "a402-unpaid-budget-"));
  dirs.push(trafficDir);
  const p = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, ...quiet, PORT: String(port), POW_SECRET, TRAFFIC_DIR: trafficDir, AGENT402_OPERATOR_TOKEN: "test-unpaid-budget-operator", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  p.__log = "";
  p.stderr.on("data", (b) => { p.__log = (p.__log + b.toString()).slice(-4000); });
  procs.push(p);
  return p;
}
async function waitUp(base, p) {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* booting */ }
    await sleep(500);
  }
  fail(`server at ${base} never answered /health\n${p.__log}`);
}
// Every 429 the paid server answers is counted here, so the operator read can
// be checked against what this test actually saw rather than a hand-kept total.
let paid429 = 0;
const call = async (base, path, { method = "GET", ua = "budget-walker/1.0", headers = {}, body } = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "user-agent": ua, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body });
  if (base === P && r.status === 429) paid429 += 1;
  return r;
};

// The CDN resolver is on for the paid boot so the key can be checked on the
// resolved client. A request with no X-Forwarded-For comes from 127.0.0.1,
// outside the CDN ranges, so the rest of this boot reads req.ip as before.
const ORIGIN_SECRET = "test-unpaid-budget-origin-secret";
const pPaid = boot(PAID, { ...paidEnv, UNPAID_QUOTE_BUDGET_PER_HOUR: "5", CDN_PROXY: "on", CDN_ORIGIN_SECRET: ORIGIN_SECRET, TRUST_PROXY_HOPS: "1" });
const pOff = boot(OFF, { ...paidEnv, UNPAID_QUOTE_BUDGET_PER_HOUR: "off" });
const pFree = boot(FREE, { FREE_MODE: "true", UNPAID_QUOTE_BUDGET_PER_HOUR: "5" });
const P = `http://127.0.0.1:${PAID}`, O = `http://127.0.0.1:${OFF}`, F = `http://127.0.0.1:${FREE}`;

try {
  await Promise.all([waitUp(P, pPaid), waitUp(O, pOff), waitUp(F, pFree)]);
  // AFTER the boot, not before it: waitUp allows 90 s, so a check made before
  // spawning guarantees nothing about the hour the assertions run in. A count
  // that straddles the hour resets mid-test and the sixth request is not a 429.
  if (secondsToHourBoundary() < 90) {
    const wait = secondsToHourBoundary() * 1000 + 2000;
    console.log(`(waiting ${Math.round(wait / 1000)} s for the hour to turn so the count cannot reset mid-test)`);
    await sleep(wait);
  }

  // Budget 5 from one client.
  const firstFive = [];
  for (let i = 0; i < 5; i++) firstFive.push((await call(P, "/api/uuid")).status);
  ok(firstFive.every((s) => s !== 429), `the first five unpaid price checks pass (got ${firstFive.join(",")})`);
  ok(firstFive.every((s) => s === 402), `and they are the paywall's own 402s (got ${firstFive.join(",")})`);
  const sixth = await call(P, "/api/uuid");
  ok(sixth.status === 429, `the sixth unpaid price check from the same client is a 429 (got ${sixth.status})`);
  const ra = Number(sixth.headers.get("retry-after"));
  ok(Number.isInteger(ra) && ra >= 1 && ra <= 3600, `the 429 carries Retry-After in seconds to the hour (got ${sixth.headers.get("retry-after")})`);
  const body = await sixth.json();
  ok(body.ok === false && body.error === "rate-limited", "the 429 body says rate-limited");
  ok(typeof body.hint === "string" && body.hint.includes("/crawler") && body.hint.includes("unpaid price checks") && body.hint.includes("budget 5"), "the hint names unpaid price checks, the budget and /crawler");
  ok(body.retryAfterSeconds === ra, "retryAfterSeconds matches the header");
  ok(!sixth.headers.get("payment-required"), "a throttled request is answered before the paywall builds a challenge");
  ok((await call(P, "/api/uuid", { method: "POST", body: "{}" })).status === 429, "a POST alias on the same priced route counts against the same client");
  ok((await call(P, "/api/hash", { method: "HEAD" })).status === 429, "a HEAD on another priced route counts against the same client");

  // The same route, spelled differently. The paywall resolves every one of
  // these and builds its challenge, so an exact lookup on the path as written
  // was a budget a crawler could walk around by appending a slash.
  for (const [path, how] of [["/api/uuid/", "a trailing slash"], ["/API/UUID", "capitals"], ["//api/uuid", "a doubled slash"], ["/api/%75uid", "a percent escape"]]) {
    const r = await call(P, path);
    ok(r.status === 429, `${how} does not walk around the budget (${path} got ${r.status})`);
  }

  // Requests that carry a PLAUSIBLE credential are never budgeted; junk is.
  const paidTry = await call(P, "/api/uuid", { headers: { "payment-signature": REAL_PAYMENT } });
  ok(paidTry.status !== 429 && paidTry.status === 402, `a request with a payment-signature header is never a 429 (got ${paidTry.status})`);
  const xpay = await call(P, "/api/uuid", { headers: { "x-payment": REAL_PAYMENT } });
  ok(xpay.status !== 429, `a request with an x-payment header is never a 429 (got ${xpay.status})`);
  const pow = await call(P, "/api/uuid", { headers: { "x-pow-solution": `${issueChallenge("uuid").token}:41` } });
  ok(pow.status !== 429, `a request with a proof-of-work solution is never a 429 (got ${pow.status})`);
  const bearer = await call(P, "/api/uuid", { headers: { authorization: "Bearer a402_notarealkey" } });
  ok(bearer.status !== 429, `a request with a credits key is never a 429 (got ${bearer.status})`);
  const mppCred = await call(P, "/api/uuid", { headers: { authorization: REAL_MPP } });
  ok(mppCred.status !== 429, `a request with an MPP Payment credential is never a 429 (got ${mppCred.status})`);
  // A header alone is not a credential: `Authorization: x` bought a full 402
  // and an exemption before this, which is a budget anyone could opt out of;
  // so did any 32 bytes of junk in a payment header.
  for (const [label, headers] of [
    ["a junk Authorization", { authorization: "x" }],
    ["a too-short payment header", { "payment-signature": "bm90LWEtcGF5bWVudA" }],
    ["a long junk payment header", { "payment-signature": JUNK_PAYMENT }],
    ["a long junk x-payment header", { "x-payment": JUNK_PAYMENT }],
    ["a junk Payment credential", { authorization: `Payment ${JUNK_PAYMENT}` }],
    ["a payload naming a network this server does not sell on", { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:1" }, payload: {} })).toString("base64") }],
    ["a malformed proof-of-work solution", { "x-pow-solution": "not-a-token:1" }],
  ]) {
    const r = await call(P, "/api/uuid", { headers });
    ok(r.status === 429, `${label} is counted like any other request (got ${r.status})`);
  }

  // Our own User-Agent strings are caller text: without the signed marker
  // they are this spent address's requests like any other.
  for (const ua of ["agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)", "agent402-heartbeat/1.0", "agent402-status-probe/1.0"]) {
    const r = await call(P, "/api/uuid", { ua });
    ok(r.status === 429, `${ua.split(" ")[0]} without the signed marker is counted on its address (got ${r.status})`);
  }
  const hb = [];
  for (let i = 0; i < 8; i++) hb.push((await call(P, "/api/uuid", { ua: "agent402-heartbeat/1.0", headers: { "x-heartbeat-token": issueHeartbeatToken() } })).status);
  ok(hb.every((s) => s === 402), `a signed heartbeat probe from the throttled address is never budgeted (got ${[...new Set(hb)].join(",")})`);
  const forged = await call(P, "/api/uuid", { headers: { "x-heartbeat-token": "forged-token-value-000000000000" } });
  ok(forged.status === 429, `a forged heartbeat token is counted like any other request (got ${forged.status})`);
  const forgedMcp = await call(P, "/api/uuid", { headers: { "x-agent402-via": "mcp" } });
  ok(forgedMcp.status === 429, `a marker without the secret is budgeted like any client (got ${forgedMcp.status})`);
  const mcp = await call(P, "/api/uuid", { headers: { "x-agent402-via": MCP_MARKER } });
  ok(mcp.status !== 429, `the MCP connector's loopback (local socket + marker) is not budgeted (got ${mcp.status})`);

  // One address, another User-Agent: the same client.
  const other = await call(P, "/api/uuid", { ua: "other-walker/2.0" });
  ok(other.status === 429, `a different User-Agent from the same address is the same client (got ${other.status})`);

  // Discovery, pages and unpriced paths stay open to the throttled client.
  for (const path of ["/api/pricing", "/openapi.json", "/.well-known/x402", "/llms.txt", "/health"]) {
    const r = await call(P, path);
    ok(r.status === 200, `${path} is never throttled (got ${r.status})`);
  }
  ok((await call(P, "/api/pricing", { method: "HEAD" })).status === 200, "a HEAD on /api/pricing is never throttled");
  const miss = await call(P, "/api/this-is-not-a-tool");
  ok(miss.status !== 429, `an unpriced /api path is never budgeted (got ${miss.status})`);
  const crawler = await call(P, "/crawler");
  const crawlerHtml = await crawler.text();
  ok(crawler.status === 200 && crawlerHtml.includes("Past 5 in an hour"), "/crawler quotes the budget the running gate enforces");
  const robots = await (await call(P, "/robots.txt")).text();
  ok(robots.includes(`${P}/crawler`) && /^# Crawling this catalog/m.test(robots), "/robots.txt points crawlers at /crawler");

  // The operator read carries counts only.
  const op = await (await fetch(`${P}/__operator/traffic.json?days=1`, { headers: { authorization: "Bearer test-unpaid-budget-operator" } })).json();
  const ub = op.unpaidQuoteBudget || {};
  ok(ub.budget === 5 && ub.clientsThrottledThisHour === 1 && ub.clientsThisHour === 1, `the operator traffic read reports the budget and the clients seen (got ${JSON.stringify(ub)})`);
  ok(ub.throttledSinceBoot === paid429, `the throttled total matches the 429s this test saw (${ub.throttledSinceBoot} vs ${paid429})`);
  ok(ub.clientsThrottledCapAt === UNPAID_QUOTE_BUDGET_LOG_CAP && ub.clientsThrottledCapped === false, "the read names the cap on the throttled-client count rather than reporting a capped number as a count");
  ok(!/127\.0\.0\.1|::1|budget-walker/.test(JSON.stringify(ub)), "the operator figures carry no address and no User-Agent");

  // Clients told apart by address. X-Forwarded-For stands in for the hosting
  // edge (trust proxy, one hop), so each block below is a fresh address.
  const from = (ip, extra = {}) => ({ ...extra, headers: { "x-forwarded-for": ip, ...(extra.headers || {}) } });
  const statuses = async (n, mkOpts) => { const got = []; for (let i = 0; i < n; i++) got.push((await call(P, "/api/uuid", mkOpts(i))).status); return got; };
  {
    const got = await statuses(6, (i) => from("203.0.113.10", { ua: `rotating-${i}/1.0` }));
    ok(got.slice(0, 5).every((s) => s === 402) && got[5] === 429, `rotating the User-Agent on every request from one address is refused after the budget (got ${got.join(",")})`);
  }
  {
    const bot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const got = await statuses(5 * NAMED_CLIENT_BUDGET_MULTIPLIER + 1, () => from("203.0.113.12", { ua: bot }));
    const first429 = got.indexOf(429) + 1;
    ok(first429 === 5 * NAMED_CLIENT_BUDGET_MULTIPLIER + 1 && got.slice(0, 50).every((s) => s === 402), `a self-declared search crawler reads ten times the budget on its address, then is a 429 (first 429 at request ${first429})`);
    const plain = await call(P, "/api/uuid", from("203.0.113.12"));
    ok(plain.status === 429, `its count is the address's: a plain client there is refused too (got ${plain.status})`);
    const idx = await statuses(9, () => from("203.0.113.14", { ua: "x402scan-indexer/2.0" }));
    ok(idx.every((s) => s === 402), `a named indexer reads past the plain budget (9 requests, got ${[...new Set(idx)].join(",")})`);
  }
  {
    const got = await statuses(5, (i) => from(`2001:db8:aa:bb::${i + 1}`));
    const same64 = await call(P, "/api/uuid", from("2001:db8:aa:bb:ffff:1:2:3"));
    const next64 = await call(P, "/api/uuid", from("2001:db8:aa:bc::1"));
    ok(got.every((s) => s === 402) && same64.status === 429, `two IPv6 addresses in one /64 share a budget (got ${got.join(",")} then ${same64.status})`);
    ok(next64.status === 402, `the next /64 has its own (got ${next64.status})`);
  }
  // Behind the CDN: a peer inside the CDN ranges carrying the origin secret
  // names the client in CF-Connecting-IP, and the budget keys on that client
  // whichever edge address carried it.
  {
    const viaCdn = (peer, client) => from(peer, { headers: { "x-origin-auth": ORIGIN_SECRET, "cf-connecting-ip": client } });
    const got = await statuses(6, (i) => viaCdn(`173.245.48.${10 + i}`, "198.51.100.20"));
    ok(got.slice(0, 5).every((s) => s === 402) && got[5] === 429, `through the CDN the budget keys on the resolved client, across edge addresses (got ${got.join(",")})`);
    const otherClient = await call(P, "/api/uuid", viaCdn("173.245.48.10", "198.51.100.21"));
    ok(otherClient.status === 402, `another client behind the same edge address has its own count (got ${otherClient.status})`);
    const forged = await statuses(6, (i) => from("192.0.2.50", { headers: { "x-origin-auth": ORIGIN_SECRET, "cf-connecting-ip": `198.51.100.${30 + i}` } }));
    ok(forged.slice(0, 5).every((s) => s === 402) && forged[5] === 429, `a CF-Connecting-IP from a peer outside the CDN ranges is ignored: the peer is the key (got ${forged.join(",")})`);
    const noSecret = await statuses(6, (i) => from("173.245.48.40", { headers: { "cf-connecting-ip": `198.51.100.${50 + i}` } }));
    ok(noSecret.slice(0, 5).every((s) => s === 402) && noSecret[5] === 429, `a CDN-range peer without the origin secret is keyed on itself (got ${noSecret.join(",")})`);
  }

  // Budget off: never throttles.
  const offGot = [];
  for (let i = 0; i < 9; i++) offGot.push((await call(O, "/api/uuid")).status);
  ok(offGot.every((s) => s !== 429), `UNPAID_QUOTE_BUDGET_PER_HOUR=off never throttles (got ${[...new Set(offGot)].join(",")})`);
  ok((await (await call(O, "/crawler")).text()).includes("sets no hourly budget"), "with the budget off, /crawler says so instead of quoting a number");

  // FREE_MODE: never throttles, even with a budget set.
  const freeGot = [];
  for (let i = 0; i < 9; i++) freeGot.push((await call(F, "/api/uuid")).status);
  ok(freeGot.every((s) => s !== 429), `a FREE_MODE boot never throttles (got ${[...new Set(freeGot)].join(",")})`);
  ok(freeGot.every((s) => s === 200), `and FREE_MODE still serves the tool (got ${[...new Set(freeGot)].join(",")})`);

  console.log(`\nPASS - ${pass} checks (unpaid price-check budget)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
