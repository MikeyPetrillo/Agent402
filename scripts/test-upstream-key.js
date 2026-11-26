// A buyer's own upstream key (src/upstream-key.js), offline, in both states
// of its switch: Parts 1 and 2 with UPSTREAM_KEY=on, Part 3 with it off.
//
// Part 1, in process: the header leaves req.headers and req.rawHeaders at
// intake; the gate refuses a malformed key and a Tempo, card or credits
// credential, and ignores the header on a route that takes none; the price is
// the catalog's lowest flat price, never above list; no listed tool settles
// first; a call made with the buyer's key is not counted by the egress meter
// (what the daily budgets read) or the hard ceilings, and a call to another
// host inside the same run still is.
//
// Part 2, a paid boot against a stub facilitator and a GitHub stub on port 0
// (scripts/lib/github-stub-preload.js) that records the key and host of every
// read: the 402 quotes the own-key price with the header and the list price
// without it; a payment at the own-key price on a request without the header is
// answered 402 and the facilitator is never asked; with the header the call
// is served, the stub receives the buyer's key and never ours (ours is live:
// a call without the header carries it); a key the upstream refuses answers
// 401 `upstream_key_refused`, uncharged, with no second read; a route that
// takes no key ignores the header; a header over the bound is answered 400
// before any work; a key that arrived over plain HTTP (a remote client the
// trusted hop reports as http) is answered 400 `upstream_key_sent_in_clear`
// with nothing verified or read, a client's own https claim does not clear
// it, and loopback over http still works; and the key appears in no log line,
// answer body, analytics event or stored file.
//
// Part 3, the same paid boot with the switch off (the default): a request
// carrying the header is quoted and charged the list price, the upstream
// receives the server's own token, no surface mentions the feature (llms.txt,
// llms-full.txt, openapi.json, /privacy, /terms, /changelog, the tool page,
// /api/pricing), an oversized or plain-HTTP header draws no refusal of its
// own, and the key is in no log, answer or store.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = randomBytes(6).toString("hex");
const token = (tag) => `ghp_${createHash("sha256").update(`${RUN}:${tag}`).digest("hex").slice(0, 36)}`;
const BUYER = token("buyer"), REFUSED = token("refused"), OURS = token("ours"), LONG = "ghp_" + "a".repeat(400);
const H = "x-agent402-upstream-key";

process.env.UPSTREAM_KEY = "on"; // Parts 1 and 2; Part 3 boots with it off
const uk = await import("../src/upstream-key.js");

// ---------------- the switch ----------------
{
  ok(uk.upstreamKeyEnabled({}) === false && uk.upstreamKeyEnabled({ UPSTREAM_KEY: "" }) === false && uk.upstreamKeyEnabled({ UPSTREAM_KEY: "off" }) === false && uk.upstreamKeyEnabled({ UPSTREAM_KEY: "maybe" }) === false && uk.upstreamKeyEnabled({ UPSTREAM_KEY: "on" }) === true && uk.upstreamKeyEnabled({ UPSTREAM_KEY: "TRUE" }) === true, "switch: off unless UPSTREAM_KEY reads on");
  const def = { slug: "github-repo", price: "$0.005" };
  uk.configureUpstreamKeys({ catalog: { a: def, b: { slug: "cheap", price: "$0.001" } } });
  process.env.UPSTREAM_KEY = "";
  try {
    const req = { headers: { [H]: BUYER, accept: "*/*" }, rawHeaders: ["Accept", "*/*", "X-Agent402-Upstream-Key", BUYER] };
    uk.takeUpstreamKey(req);
    ok(!(H in req.headers) && req.rawHeaders.length === 2, "off: the header is still removed from the request at intake");
    let t = false, b = false, g = false;
    uk.upstreamKeyTransport({ hops: 0 })({ ...req, socket: { remoteAddress: "203.0.113.5" } }, {}, () => { t = true; });
    uk.upstreamKeyTransport({ hops: 0 })(req, {}, () => { t = t && true; });
    uk.upstreamKeyBound()(req, {}, () => { b = true; });
    uk.upstreamKeyGate(() => def)(req, {}, () => { g = true; });
    ok(t && b && g && uk.upstreamKeyFor(req, "github-repo") === null && uk.upstreamKeyQuoteOf(req, def) === null && uk.upstreamKeyPriceUsd(req, def) === 0 && !uk.upstreamKeyApplies(req, def), "off: nothing is kept, no gate refuses, no key is applied and the price is the list price");
    const long = { headers: { [H]: LONG }, rawHeaders: [], socket: { remoteAddress: "203.0.113.5" } };
    uk.takeUpstreamKey(long);
    let lt = false, lb = false;
    uk.upstreamKeyTransport({ hops: 0 })(long, {}, () => { lt = true; });
    uk.upstreamKeyBound()(long, {}, () => { lb = true; });
    ok(lt && lb, "off: an oversized header over plain HTTP draws no refusal");
    ok(uk.upstreamKeyOffered(def) === false && uk.upstreamKeyListed(def) === false && uk.upstreamKeySentence("github-repo") === "" && uk.upstreamKeyBrief({ a: def }) === "" && uk.upstreamKeyLine({ a: def }) === "" && uk.upstreamKeyHeaderParams(def).length === 0 && uk.upstreamKeyPrivacyItem({ a: def }) === "" && uk.upstreamKeyTermsItem() === "", "off: no route takes a key and every copy surface is empty");
    ok(uk.withUpstreamKeyDate("x last updated 2026-11-25. y") === "x last updated 2026-11-25. y" && uk.upstreamKeyStatus().enabled === false && uk.upstreamKeyStatus().counts.removedWhileOff === 2, "off: a legal page keeps its own date, and the operator view says off and counts the removals");
  } finally { process.env.UPSTREAM_KEY = "on"; }
  ok(uk.upstreamKeyOffered(def) && uk.upstreamKeyListed(def) && /Bring your own/.test(uk.upstreamKeySentence("github-repo")) && uk.upstreamKeyTermsItem().includes("you confirm that the key is yours to use") && uk.upstreamKeyStatus().enabled === true, "on: the route takes a key and the copy is written");
  ok(uk.withUpstreamKeyDate("x last updated 2026-11-25. y", { today: "2026-11-26" }) === `x last updated ${uk.UPSTREAM_KEY_TERMS_DATE}. y` && uk.withUpstreamKeyDate("x last updated 2026-11-25. y", { today: "2026-11-25" }) === "x last updated 2026-11-25. y" && uk.withUpstreamKeyDate("x last updated 2027-01-01. y", { today: "2027-01-02" }) === "x last updated 2027-01-01. y", "on: a legal page prints the later of its own date and the clause's, never a date after today");
}

// ---------------- the intake's place in the middleware order ----------------
{
  const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mounts = [...serverSrc.matchAll(/^(?:if \([A-Z_]+\) )?app\.use\(([^\n]*)$/gm)].map((m) => m[1]);
  const at = mounts.findIndex((m) => m.startsWith("upstreamKeyIntake()"));
  ok(at >= 1 && mounts[at - 1].startsWith("stripMcpMarker)") && mounts.slice(0, at).every((m) => m.startsWith("stripMcpMarker)") || m.startsWith("paymentRequiredCompactMiddleware()")), `server.js removes the key right after the connector's marker strip: nothing else is mounted before it but the compact-header hook (${mounts.slice(0, at + 1).map((m) => m.slice(0, 32)).join(" | ")})`);
  // Neither of the two reads a request's headers as a whole, names this header, or logs.
  for (const f of ["../src/mcp-loopback.js", "../src/payment-required-compact.js"]) {
    const code = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    ok(!/rawHeaders|upstream-key|JSON\.stringify\([^)]*headers|Object\.(keys|entries|values)\([^)]*headers|\.\.\.\s*(req\.)?headers|for\s*\([^)]*\bin\s+(req\.)?headers|console\./i.test(code), `${f.slice(7)}: reads request headers by name only, never this one, and logs nothing`);
  }
  const { stripMcpMarker } = await import("../src/mcp-loopback.js");
  const req = { headers: { [H]: BUYER, accept: "*/*" }, rawHeaders: ["X-Agent402-Upstream-Key", BUYER], socket: { remoteAddress: "203.0.113.5" } };
  let nexted = false;
  stripMcpMarker(req, {}, () => { nexted = true; });
  uk.takeUpstreamKey(req);
  ok(nexted && !(H in req.headers) && req.rawHeaders.length === 0 && !JSON.stringify(Object.getOwnPropertyNames(req).map((k) => [k, typeof req[k] === "string" ? req[k] : ""])).includes(BUYER), "the marker strip passes a keyed request on untouched, and after the intake the key is on no property of the request");
}

// ---------------- Part 1: in process ----------------
{
  const req = { headers: { [H]: ` ${BUYER} `, accept: "*/*" }, rawHeaders: ["Accept", "*/*", "X-Agent402-Upstream-Key", ` ${BUYER} `] };
  uk.takeUpstreamKey(req);
  ok(!(H in req.headers) && !req.rawHeaders.some((v) => String(v).includes(BUYER)) && req.rawHeaders.length === 2, "intake: the header leaves req.headers and req.rawHeaders");
}
{
  const catalog = { a: { slug: "github-repo", price: "$0.005" }, b: { slug: "cheap", price: "$0.001" }, c: { slug: "dear", price: "$0.05" }, q: { slug: "quoted", price: "$0.0001", quote: () => 1 } };
  uk.configureUpstreamKeys({ catalog });
  ok(uk.upstreamKeyPriceOf(catalog.a) === "$0.001", `price: the lowest flat catalog price, a quoted route left out (${uk.upstreamKeyPriceOf(catalog.a)})`);
  uk.configureUpstreamKeys({ catalog: { a: { slug: "github-repo", price: "$0.0005" }, c: { slug: "dear", price: "$0.05" } } });
  ok(uk.upstreamKeyPriceOf({ slug: "github-repo", price: "$0.0005" }) === "$0.0005", "price: never above the tool's own list price");
  ok(!uk.upstreamKeyOffered({ slug: "github-repo", price: "$0.005" }, { UPSTREAM_KEY: "on", REFERRAL_SLUGS: "x,github-repo" }) && uk.upstreamKeyOffered({ slug: "github-repo", price: "$0.005" }, { UPSTREAM_KEY: "on" }) && !uk.upstreamKeyOffered({ slug: "hash", price: "$0.001" }, { UPSTREAM_KEY: "on" }), "a tool sold on the referral routes, or not listed, takes no key");
  uk.configureUpstreamKeys({ catalog });
}
{
  const def = { slug: "github-repo", price: "$0.005" };
  const run = (req) => { let nexted = false, status = null, body = null; const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } }; uk.upstreamKeyGate(() => def)(req, res, () => { nexted = true; }); return { nexted, status, body }; };
  const mk = (v, extra = {}) => { const r = { headers: { [H]: v }, rawHeaders: [], ...extra }; uk.takeUpstreamKey(r); return r; };
  const good = mk(BUYER);
  const g = run(good);
  ok(g.nexted && uk.upstreamKeyFor(good, "github-repo") === BUYER && uk.upstreamKeyQuoteOf(good, def) === "$0.001" && uk.upstreamKeyFor(good, "other") === null, "gate: a well-formed key is applied for its own tool only");
  const bad = run(mk("not-a-token"));
  ok(!bad.nexted && bad.status === 400 && bad.body?.reason === "upstream_key_malformed" && !JSON.stringify(bad.body).includes("not-a-token"), "gate: a malformed key is 400 before any work, and the body does not echo it");
  for (const flag of ["tempoSettled", "tempoSettling", "mppTempoCredential", "stripeSettled", "stripeSettling", "mppStripeCredential", "creditsSettling", "creditsSettled"]) {
    const r = mk(BUYER, { [flag]: true });
    const o = run(r);
    ok(!o.nexted && o.status === 400 && o.body?.reason === "upstream_key_rail_unsupported" && uk.upstreamKeyFor(r, "github-repo") === null, `gate: a ${flag} request with the header is refused 400`);
  }
  const other = mk(BUYER);
  let nexted = false;
  uk.upstreamKeyGate(() => ({ slug: "hash", price: "$0.001" }))(other, {}, () => { nexted = true; });
  ok(nexted && uk.upstreamKeyFor(other, "hash") === null && uk.upstreamKeyQuoteOf(other, { slug: "hash" }) === null, "gate: a route that takes no key ignores the header");
}
{
  // The scheme a keyed request arrived over (arrivedInClear), per peer and trust.
  const REMOTE = "203.0.113.7";
  const rq = ({ peer = REMOTE, ip = peer, encrypted = false, viaCdn = false, ...headers } = {}) => ({ headers, socket: { remoteAddress: peer, encrypted }, ip, viaCdn });
  const clear = (r, hops = 0) => uk.arrivedInClear(r, { hops });
  ok(clear(rq()) === true, "scheme: a plain socket from a remote peer with no trusted proxy is http");
  ok(clear(rq({ "x-forwarded-proto": "https" })) === true && clear(rq({ forwarded: "proto=https" })) === true && clear(rq({ "cf-visitor": '{"scheme":"https"}' })) === true, "scheme: with no trusted proxy, a client's own https claim (X-Forwarded-Proto, Forwarded, CF-Visitor) is not read");
  ok(clear(rq({ encrypted: true })) === false, "scheme: a TLS socket is https");
  ok(clear(rq({ "x-forwarded-proto": "https" }), 1) === false && clear(rq(), 1) === false, "scheme: behind a trusted proxy with no http claim the request is served");
  ok(clear(rq({ "x-forwarded-proto": "http" }), 1) === true && clear(rq({ "x-forwarded-proto": "https, http" }), 1) === true && clear(rq({ "x-forwarded-proto": "HTTP , https" }), 1) === true, "scheme: an http entry in X-Forwarded-Proto wins over an https one beside it");
  ok(clear(rq({ forwarded: 'for=1.2.3.4;proto=http;by=5.6.7.8' }), 1) === true && clear(rq({ forwarded: "for=1.2.3.4;proto=https" }), 1) === false, "scheme: Forwarded proto=http is read");
  ok(clear(rq({ viaCdn: true, encrypted: true, "cf-visitor": '{"scheme":"http"}' })) === true && clear(rq({ viaCdn: true, "cf-visitor": '{"scheme":"https"}' })) === false, "scheme: the CDN's visitor scheme http refuses even on a TLS hop, and a proven CDN request without it is served");
  ok(clear(rq({ peer: "127.0.0.1" })) === false && clear(rq({ peer: "::1", "x-forwarded-proto": "http" })) === false && clear(rq({ peer: "::ffff:127.0.0.1" })) === false, "scheme: loopback is exempt, an http claim with no remote client included");
  ok(clear(rq({ peer: "127.0.0.1", ip: REMOTE, "x-forwarded-proto": "http" }), 1) === true && clear(rq({ peer: "127.0.0.1", "x-forwarded-for": REMOTE, "x-forwarded-proto": "http" })) === true && clear(rq({ peer: "127.0.0.1", ip: REMOTE, "x-forwarded-proto": "https" }), 1) === false, "scheme: a proxy on this host reporting a remote plain-HTTP client is refused");
  // The middleware: 400 with the reason, the key gone from the request, nothing echoed.
  const r = rq({ [H]: BUYER }); r.rawHeaders = [];
  uk.takeUpstreamKey(r);
  let status = null, body = null, nexted = false;
  uk.upstreamKeyTransport({ hops: 0 })(r, { status(s) { status = s; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; });
  let gateNext = false;
  uk.upstreamKeyGate(() => ({ slug: "github-repo", price: "$0.005" }))(r, {}, () => { gateNext = true; });
  ok(!nexted && status === 400 && body?.reason === "upstream_key_sent_in_clear" && body?.charged === false && /revoke/i.test(body?.error || "") && !JSON.stringify(body).includes(BUYER) && gateNext && uk.upstreamKeyFor(r, "github-repo") === null, "transport: a key sent in clear is 400 upstream_key_sent_in_clear, charged false, told to revoke, and never applied");
  const plain = rq(); let through = false;
  uk.upstreamKeyTransport({ hops: 0 })(plain, {}, () => { through = true; });
  ok(through, "transport: a request without the header is never refused for its scheme");
}
{
  // The cool-down after refused keys, on a clock the test moves.
  const def = { slug: "github-repo", price: "$0.005" };
  let now = 1_000_000_000_000;
  uk.__setUpstreamKeyClockForTest(() => now);
  uk.__resetUpstreamKeyCooldownForTest();
  const MAX = uk.UPSTREAM_KEY_REFUSED_MAX, WIN = uk.UPSTREAM_KEY_COOLDOWN_MS;
  const gate = (ip, payer = null) => {
    const req = { headers: { [H]: BUYER }, rawHeaders: [], ip };
    uk.takeUpstreamKey(req);
    let status = null, body = null, nexted = false; const headers = {};
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; }, setHeader(k, v) { headers[k.toLowerCase()] = v; } };
    uk.upstreamKeyGate(() => def, { claimedPayerOf: () => payer })(req, res, () => { nexted = true; });
    return { status, body, nexted, headers, applied: uk.upstreamKeyApplies(req, def) };
  };
  const { stashVerifiedPayment } = await import("../src/verified-payment.js");
  const refuse = async (ip, payer = null) => {
    const req = { ip };
    if (payer) stashVerifiedPayment(req, { payer });
    await uk.runWithUpstreamKey("github-repo", async () => { throw uk.upstreamKeyRefusedError(401, "GitHub"); }, req).catch(() => {});
  };
  const A = "203.0.113.21", B2 = "203.0.113.22", P = "0x00000000000000000000000000000000000000B7", SOLP = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  for (let i = 0; i < MAX - 1; i++) { await refuse(A, P); now += 1000; }
  ok(gate(A, P).nexted && gate(A, P).applied, `cool-down: ${MAX - 1} refused keys are still under the bound`);
  await refuse(A, P);
  const cold = gate(A, P);
  const waitS = Number(cold.headers["retry-after"]);
  ok(cold.status === 429 && cold.body?.reason === "upstream_key_cooldown" && cold.body?.charged === false && !cold.nexted && !cold.applied && Number.isInteger(waitS) && waitS > 0 && waitS <= WIN / 1000 && cold.body.retryAfterSeconds === waitS && /without the header/.test(cold.body.error) && !JSON.stringify(cold.body).includes(BUYER), `cool-down: after ${MAX} refused keys the header is answered 429 with Retry-After in whole seconds, charged false (${cold.status}, ${cold.headers["retry-after"]})`);
  ok(gate(A, null).status === 429 && gate(B2, P.toLowerCase()).status === 429 && gate(B2, P).status === 429, "cool-down: the same address with another payer, and the same payer from another address (in either letter case), are held too");
  ok(gate(B2, "0x00000000000000000000000000000000000000c8").nexted && gate("203.0.113.23", null).nexted, "cool-down: another payer from another address is unaffected");
  // Without the header nothing is held: the gate passes the request on.
  { let through = false; uk.upstreamKeyGate(() => def, { claimedPayerOf: () => P })({ headers: {}, ip: A }, {}, () => { through = true; }); ok(through, "cool-down: the same payer and address without the header pass the gate (the list price is still sold)"); }
  // A served call does not shorten it.
  await uk.runWithUpstreamKey("github-repo", async () => "served", { ip: A });
  ok(gate(A, P).status === 429, "cool-down: a served call in between does not end it early");
  // A base58 payer is kept exactly: its lower-cased spelling is another key.
  for (let i = 0; i < MAX; i++) await refuse("203.0.113.30", SOLP);
  ok(gate("203.0.113.31", SOLP).status === 429 && gate("203.0.113.31", SOLP.toLowerCase()).nexted, "cool-down: a base58 payer is matched exactly, never case-folded");
  // An IPv6 client is one network, its /64, as the rate limiters key it
  // (src/rate-limit.js limiterKey): addresses rotated inside it share a count.
  for (let i = 0; i < MAX; i++) await refuse(`2001:db8:1:2::${(i + 1).toString(16)}`, `0x${String(i + 1).padStart(40, "0")}`);
  ok(gate("2001:db8:1:2:aaaa::9", null).status === 429 && gate("2001:db8:1:3::1", null).nexted, `cool-down: ${MAX} refused keys from ${MAX} addresses of one IPv6 /64, a fresh payer each, hold the next address of that /64; another /64 is unaffected`);
  // Time ends it.
  now += waitS * 1000 - 1000;
  ok(gate(A, P).status === 429, "cool-down: one second before Retry-After it still holds");
  now += 1000;
  ok(gate(A, P).nexted && gate(A, P).applied, "cool-down: at Retry-After the header is taken again");
  now += WIN;
  // Bounded: more distinct addresses than the map holds never grow it past its cap.
  uk.__resetUpstreamKeyCooldownForTest();
  for (let i = 0; i < uk.UPSTREAM_KEY_COOLDOWN_KEYS_MAX + 500; i++) await refuse(`198.18.${i >> 8}.${i & 255}`);
  const st = uk.upstreamKeyStatus();
  ok(st.cooldown.tracked === uk.UPSTREAM_KEY_COOLDOWN_KEYS_MAX && st.cooldown.trackedMax === uk.UPSTREAM_KEY_COOLDOWN_KEYS_MAX, `cool-down: the record is bounded (${st.cooldown.tracked} of ${st.cooldown.trackedMax})`);
  ok(st.byTool["github-repo"].refusedByUpstream >= MAX && st.byTool["github-repo"].cooldown >= 1 && st.counts.cooldown >= 1 && !/0x0{10}|203\.0\.113|198\.18\.|ghp_/.test(JSON.stringify(st)), "status: outcomes per tool, with no key, payer or address");
  uk.__resetUpstreamKeyCooldownForTest();
  uk.__setUpstreamKeyClockForTest(null);
}
{
  const sft = await import("../src/settle-first-tools.js");
  const sf = [...sft.settleFirstSlugs(sft.SETTLE_FIRST_GATEWAY_TOOLS)];
  ok(Object.keys(uk.UPSTREAM_KEY_TOOLS).every((s) => !sf.includes(s)), "no tool that takes a buyer's key settles before its upstream call");
}
{
  // The egress meter over a fetch that never leaves this process.
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { seen.push(String(input)); return new Response("{}", { status: 200 }); };
  const meter = await import("../src/egress-meter.js");
  const caps = await import("../src/upstream-hard-caps.js");
  meter.installEgressMeter();
  const count = (host) => meter.egressReport({ top: 2000 }).hosts.find((h) => h.host === host)?.calls || 0;
  const capCalls = () => JSON.stringify(caps.hardCapStatus());
  const before = { gh: count("api.github.com"), oa: count("api.openai.com"), cap: capCalls() };
  await uk.runWithUpstreamKey("github-repo", async () => { await fetch("https://api.github.com/repos/a/b"); await fetch("https://api.github.com/repos/a/b/languages"); });
  ok(count("api.github.com") === before.gh && capCalls() === before.cap && seen.length === 2, `meter: calls made with the buyer's key are not counted (${count("api.github.com")} of ${before.gh}) and no ceiling moves`);
  await uk.runWithUpstreamKey("github-repo", () => fetch("https://api.openai.com/v1/x"));
  ok(count("api.openai.com") === before.oa + 1 && capCalls() !== before.cap, "meter: a call to another host inside the same run is counted, and its ceiling moves");
  await fetch("https://api.github.com/repos/a/b");
  ok(count("api.github.com") === before.gh + 1, "meter: the same host outside a buyer-key run is counted");
  globalThis.fetch = realFetch;
}

// ---------------- Part 2: a paid boot ----------------
const ghSeen = [];
const github = createServer((req, res) => {
  const auth = String(req.headers.authorization || "");
  ghSeen.push({ host: req.headers["x-stub-host"] || null, auth, path: req.url });
  if (auth === `Bearer ${REFUSED}`) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ message: "Bad credentials" })); }
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.endsWith("/languages")) return res.end(JSON.stringify({ JavaScript: 900, HTML: 100 }));
  res.end(JSON.stringify({ full_name: "expressjs/express", description: "web framework", stargazers_count: 10, forks_count: 2, subscribers_count: 1, open_issues_count: 0, license: { spdx_id: "MIT" }, topics: [], language: "JavaScript", private: false, html_url: "https://github.com/expressjs/express" }));
});
const verifies = [], settles = [];
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let p = {}; try { p = JSON.parse(body || "{}"); } catch { /* ignore */ }
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: p.id ?? 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
    const auth = p?.paymentPayload?.payload?.authorization || {};
    if (req.url === "/verify") { verifies.push(String(auth.value)); return reply({ isValid: true, payer: auth.from }); }
    if (req.url === "/settle") { settles.push(String(auth.value)); return reply({ success: true, transaction: "0x" + createHash("sha256").update(String(auth.nonce)).digest("hex"), network: "eip155:8453", payer: auth.from }); }
    reply({});
  });
});
const analytics = [];
const posthog = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    let buf = Buffer.concat(chunks);
    try { if (req.headers["content-encoding"] === "gzip" || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf); } catch { /* keep raw */ }
    analytics.push(req.url + " " + buf.toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
});
for (const s of [github, facilitator, posthog]) await new Promise((r) => s.listen(0, "127.0.0.1", r));
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const OP = "upstream-key-test-operator-token-01234";
const stores = ownStoreEnv("upstream-key");
const storeDir = dirname(stores.TRAFFIC_DIR);
const bodies = [];
let srv = null;
const bootEnv = (st, state) => ({
      ...st, UPSTREAM_KEY: state,
      FREE_MODE: "", NODE_ENV: "test", TRUST_PROXY_HOPS: "1", BASE_URL: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: urlOf(facilitator), AGENT402_BASE_RPC: `${urlOf(facilitator)}/rpc`, FACILITATOR_GAS_CHECK: "off",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "",
      POSTHOG_API_KEY: "phc_uk_suite_test", POSTHOG_HOST: urlOf(posthog), POSTHOG_FORCE: "true",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", REFERRAL_SLUGS: "",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
      FIRST_CALL_ALLOWANCE: "", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
      AGENT402_OPERATOR_TOKEN: OP, GITHUB_TOKEN: OURS, GITHUB_STUB_URL: urlOf(github),
});
const boot = (st, state) => bootServer({ stores: false, readyPath: "/health", args: ["--import", "./scripts/lib/github-stub-preload.js"], env: bootEnv(st, state) });
try {
  srv = await boot(stores, "on");
  const B = srv.url;
  for (let i = 0; i < 120; i++) { const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null); if (r?.status === 402) break; await sleep(250); }
  const pricing = await fetch(`${B}/api/pricing`).then((r) => r.json());
  const rows = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  const micro = (p) => String(Math.round(Number(String(p).replace(/^\$/, "")) * 1e6));
  const row = rows.find((t) => t.slug === "github-repo");
  const flat = rows.filter((t) => typeof t.price === "string" && /^\$\d+(\.\d+)?$/.test(t.price) && !t.quoted && !t.pricedByModel);
  const LIST = micro(row?.price), FEE = micro(flat.map((t) => t.price).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0]);
  ok(!!row && Number(FEE) > 0 && Number(FEE) < Number(LIST), `the own-key price (${FEE}) is the catalog's lowest flat price, under github-repo's list (${LIST})`);
  const BODY = JSON.stringify({ owner: "expressjs", repo: "express" });
  const call = async (path, headers = {}, body = BODY) => {
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const text = await r.text();
    bodies.push(text, [...r.headers].map(([k, v]) => `${k}: ${v}`).join("\n"));
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    let offer = null; try { offer = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8") || "null"); } catch { offer = null; }
    return { status: r.status, json, offer, headers: r.headers };
  };
  const credential = (accept, from = "0x00000000000000000000000000000000000000a1") => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
  })).toString("base64");

  const plain = await call("/api/github-repo");
  const keyed = await call("/api/github-repo", { [H]: BUYER });
  ok(plain.status === 402 && (plain.offer?.accepts || []).every((a) => a.amount === LIST), `402 without the header quotes the list price on every accept (${(plain.offer?.accepts || []).map((a) => a.amount)})`);
  ok(keyed.status === 402 && keyed.offer?.accepts?.length > 0 && keyed.offer.accepts.every((a) => a.amount === FEE), `402 with the header quotes the own-key price on every accept (${(keyed.offer?.accepts || []).map((a) => a.amount)})`);
  const feeAccept = keyed.offer.accepts.find((a) => a.scheme === "exact");

  // Ours is live: a paid call without the header carries the server's token.
  let n0 = ghSeen.length;
  const control = await call("/api/github-repo", { "payment-signature": credential(plain.offer.accepts.find((a) => a.scheme === "exact")) });
  ok(control.status === 200 && ghSeen.slice(n0).length > 0 && ghSeen.slice(n0).every((s) => s.auth === `Bearer ${OURS}`), `control: without the header the read carries the server's own token (${control.status})`);

  // A cheap quote never buys the full call.
  const v0 = verifies.length, s0 = settles.length; n0 = ghSeen.length;
  const cheap = await call("/api/github-repo", { "payment-signature": credential(feeAccept) });
  ok(cheap.status === 402 && verifies.length === v0 && settles.length === s0 && ghSeen.length === n0, `a payment at the own-key price without the header is answered 402, nothing verified, settled or read (${cheap.status})`);

  // With the header: served, the buyer's key and only it reaches the upstream's host.
  n0 = ghSeen.length;
  const paid = await call("/api/github-repo", { [H]: BUYER, "payment-signature": credential(feeAccept), "idempotency-key": `uk-${RUN}` });
  const reads = ghSeen.slice(n0);
  ok(paid.status === 200 && paid.json?.fullName === "expressjs/express" && settles.at(-1) === FEE, `with the header the call is served and settles the own-key price (${paid.status}, ${settles.at(-1)})`);
  ok(reads.length >= 1 && reads.every((s) => s.auth === `Bearer ${BUYER}` && s.host === "api.github.com"), `the upstream received the buyer's key at its own host on every read (${reads.length})`);
  ok(!ghSeen.some((s) => s.auth.includes(BUYER) && s.host !== "api.github.com") && !reads.some((s) => s.auth.includes(OURS)), "our key is never sent with the buyer's call, and the buyer's key goes nowhere else");
  const replay = await call("/api/github-repo", { [H]: BUYER, "payment-signature": credential(feeAccept), "idempotency-key": `uk-${RUN}` });
  ok(replay.status === 200 || replay.status === 402, `a keyed resend answers without exposing the key (${replay.status})`);

  // A refused key: 401, its reason, not charged, no second try with ours.
  const s1 = settles.length; n0 = ghSeen.length;
  const refused = await call("/api/github-repo", { [H]: REFUSED, "payment-signature": credential(feeAccept) });
  ok(refused.status === 401 && refused.json?.reason === "upstream_key_refused" && refused.json?.charged === false, `a key the upstream refuses answers 401 upstream_key_refused, charged false (${refused.status}, ${refused.json?.reason})`);
  ok(settles.length === s1 && !refused.headers.get("payment-response"), "and nothing settled");
  ok(ghSeen.slice(n0).length === 1 && ghSeen.slice(n0)[0].auth === `Bearer ${REFUSED}`, `no fallback: one read, with the buyer's key only (${ghSeen.slice(n0).map((s) => s.auth === `Bearer ${OURS}` ? "ours" : "theirs")})`);

  // Over plain HTTP (the edge's forwarded scheme): 400 before any payment work.
  // The boot trusts one hop, so the forwarded client is a remote address.
  {
    const v3 = verifies.length, s3 = settles.length; n0 = ghSeen.length;
    const REMOTE_XFF = "203.0.113.9";
    const inClear = await call("/api/github-repo", { [H]: BUYER, "x-forwarded-for": REMOTE_XFF, "x-forwarded-proto": "http", "payment-signature": credential(feeAccept) });
    ok(inClear.status === 400 && inClear.json?.reason === "upstream_key_sent_in_clear" && inClear.json?.charged === false && /revoke/i.test(inClear.json?.error || "") && inClear.headers.get("x-content-type-options") === "nosniff", `a key that arrived over plain HTTP is 400 upstream_key_sent_in_clear, charged false (${inClear.status}, ${inClear.json?.reason})`);
    ok(verifies.length === v3 && settles.length === s3 && ghSeen.length === n0, "and nothing was verified, settled or read upstream");
    const spoof = await call("/api/github-repo", { [H]: BUYER, "x-forwarded-for": REMOTE_XFF, "x-forwarded-proto": "https, http", "cf-visitor": '{"scheme":"https"}', "payment-signature": credential(feeAccept) });
    ok(spoof.status === 400 && spoof.json?.reason === "upstream_key_sent_in_clear" && verifies.length === v3 && ghSeen.length === n0, `a client's https claim beside the proxy's http entry does not clear it (${spoof.status})`);
    const other = await call("/api/hash", { [H]: BUYER, "x-forwarded-for": REMOTE_XFF, "x-forwarded-proto": "http" }, JSON.stringify({ text: "hi" }));
    ok(other.status === 400 && other.json?.reason === "upstream_key_sent_in_clear", `on a route that takes no key the exposed key is still reported (${other.status})`);
    const noKey = await call("/api/github-repo", { "x-forwarded-for": REMOTE_XFF, "x-forwarded-proto": "http" });
    ok(noKey.status === 402, `a plain-HTTP request without the header is answered as usual (${noKey.status})`);
    const local = await call("/api/github-repo", { [H]: BUYER, "x-forwarded-proto": "http" });
    ok(local.status === 402 && (local.offer?.accepts || []).every((a) => a.amount === FEE), `loopback over http keeps working: the own-key price is quoted (${local.status})`);
  }

  // A route that takes no key ignores the header.
  const hashPlain = await call("/api/hash", {}, JSON.stringify({ text: "hi" }));
  const hashKeyed = await call("/api/hash", { [H]: BUYER }, JSON.stringify({ text: "hi" }));
  ok(hashKeyed.status === 402 && JSON.stringify(hashKeyed.offer?.accepts?.map((a) => a.amount)) === JSON.stringify(hashPlain.offer?.accepts?.map((a) => a.amount)), "a route that takes no key quotes its list price with the header");
  const hashPaid = await call("/api/hash", { [H]: BUYER, "payment-signature": credential(hashPlain.offer.accepts.find((a) => a.scheme === "exact")) }, JSON.stringify({ text: "hi" }));
  ok(hashPaid.status === 200, `and serves the paid call as usual (${hashPaid.status})`);

  // Over the bound: 400 before any work.
  const v2 = verifies.length; n0 = ghSeen.length;
  const long = await call("/api/github-repo", { [H]: LONG, "payment-signature": credential(feeAccept) });
  ok(long.status === 400 && long.json?.reason === "upstream_key_too_long" && verifies.length === v2 && ghSeen.length === n0 && long.headers.get("x-content-type-options") === "nosniff", `a header over ${uk.UPSTREAM_KEY_MAX_CHARS} characters is 400 before any work, with the security headers (${long.status})`);
  const malformed = await call("/api/github-repo", { [H]: "sk-not-github" });
  ok(malformed.status === 400 && malformed.json?.reason === "upstream_key_malformed", "a value that is not a GitHub token is 400");

  // The cool-down: refused keys from one payer and address, then the header
  // is answered 429 with no read upstream; the call without it still sells.
  {
    const IP = "203.0.113.77", PAYER = "0x00000000000000000000000000000000000000c7";
    const at = (extra = {}) => ({ "x-forwarded-for": IP, ...extra });
    let last = null;
    for (let i = 0; i < uk.UPSTREAM_KEY_REFUSED_MAX; i++) last = await call("/api/github-repo", at({ [H]: REFUSED, "payment-signature": credential(feeAccept, PAYER) }));
    ok(last.status === 401 && last.json?.reason === "upstream_key_refused", `the ${uk.UPSTREAM_KEY_REFUSED_MAX}th refused key is still answered by the upstream's refusal (${last.status})`);
    const v4 = verifies.length, s4 = settles.length; n0 = ghSeen.length;
    const cold = await call("/api/github-repo", at({ [H]: BUYER, "payment-signature": credential(feeAccept, PAYER) }));
    const ra = cold.headers.get("retry-after");
    ok(cold.status === 429 && cold.json?.reason === "upstream_key_cooldown" && cold.json?.charged === false && /^\d+$/.test(ra || "") && Number(ra) > 0 && Number(ra) <= uk.UPSTREAM_KEY_COOLDOWN_MS / 1000, `the next keyed request is 429 upstream_key_cooldown with Retry-After in whole seconds (${cold.status}, ${ra})`);
    ok(ghSeen.length === n0 && verifies.length === v4 && settles.length === s4, "with no read upstream and nothing verified or settled");
    const elsewhere = await call("/api/github-repo", { "x-forwarded-for": "203.0.113.78", [H]: BUYER, "payment-signature": credential(feeAccept, PAYER) });
    ok(elsewhere.status === 429 && elsewhere.json?.reason === "upstream_key_cooldown", `the same payer from another address is held too (${elsewhere.status})`);
    n0 = ghSeen.length;
    const listPaid = await call("/api/github-repo", at({ "payment-signature": credential(plain.offer.accepts.find((a) => a.scheme === "exact"), PAYER) }));
    ok(listPaid.status === 200 && ghSeen.slice(n0).length > 0 && ghSeen.slice(n0).every((x) => x.auth === `Bearer ${OURS}`) && settles.at(-1) === LIST, `the same payer and address without the header are served at the list price (${listPaid.status})`);
    const other = await call("/api/github-repo", { "x-forwarded-for": "203.0.113.79", [H]: BUYER });
    ok(other.status === 402 && (other.offer?.accepts || []).every((a) => a.amount === FEE), `another address with another payer is quoted the own-key price as before (${other.status})`);
    const view = await fetch(`${B}/__operator/upstream-key.json`, { headers: { "X-Operator-Token": OP } }).then((r) => r.json());
    const t = view.byTool?.["github-repo"] || {};
    ok(t.refusedByUpstream === uk.UPSTREAM_KEY_REFUSED_MAX + 1 && t.cooldown === 2 && t.applied >= 3 && t.malformed === 1 && view.counts?.inClear === 3 && view.counts?.tooLong === 1 && view.cooldown?.coolingDown >= 2 && !/ghp_|0x0{20}|203\.0\.113/.test(JSON.stringify(view)), `the operator view counts each outcome per tool, with no key, payer or address (${JSON.stringify(t)})`);
    const anon = await fetch(`${B}/__operator/upstream-key.json`);
    ok(anon.status === 404, `without the operator token the view is a 404 (${anon.status})`);
  }

  // Surfaces.
  const api = await fetch(`${B}/openapi.json`).then((r) => r.json());
  const op = api.paths?.["/api/github-repo"]?.post;
  ok((op?.parameters || []).some((p) => p.in === "header" && p.name === "X-Agent402-Upstream-Key") && !(api.paths?.["/api/hash"]?.post?.parameters || []).some((p) => p.name === "X-Agent402-Upstream-Key"), "openapi: the header parameter is on github-repo only");
  const llms = await fetch(`${B}/llms.txt`).then((r) => r.text());
  const full = await fetch(`${B}/llms-full.txt`).then((r) => r.text());
  ok(llms.includes("X-Agent402-Upstream-Key") && full.includes("X-Agent402-Upstream-Key") && full.includes("upstream_key_refused"), `llms.txt names the header and llms-full.txt states the rule (${Buffer.byteLength(llms)} bytes)`);
  const param = (op?.parameters || []).find((p) => p.name === "X-Agent402-Upstream-Key")?.description || "";
  const advice = /fine-grained token with no permissions/;
  ok(advice.test(param) && /HTTPS only/.test(param) && /short expiry/.test(param) && param.includes("upstream_key_sent_in_clear"), "openapi: the header parameter recommends a no-permission, short-lived token over HTTPS only");
  ok(param.includes("429 with reason upstream_key_cooldown and Retry-After"), "openapi: the header parameter names the cool-down answer");
  ok(advice.test(full) && /HTTPS only/.test(full) && full.includes("upstream_key_sent_in_clear") && /loopback/.test(full), "llms-full.txt: the same advice, the plain-HTTP refusal and its loopback exemption");
  ok(advice.test(row?.description || "") && /HTTPS only/.test(row?.description || ""), "the github-repo description carries the advice");
  const privacy = await fetch(`${B}/privacy`).then((r) => r.text());
  const termsOn = (await fetch(`${B}/terms`).then((r) => r.text())).replace(/\s+/g, " ");
  ok(termsOn.includes("If you send your own key for another service with a call, you confirm that the key is yours to use, that the other service's terms allow this use, and that you are responsible for the key and for the calls made with it. A key you send is one of the inputs you send; <a href=\"/privacy\">/privacy</a> says what we do with it.</li>") && !/We use it only for that call|do not store it/.test(termsOn) && termsOn.includes(`last updated ${uk.UPSTREAM_KEY_TERMS_DATE}.`), "/terms carries the clause and its date while the switch is on");
  const changelogOn = await fetch(`${B}/changelog`).then((r) => r.text());
  ok(changelogOn.includes("X-Agent402-Upstream-Key"), "/changelog carries the entry while the switch is on");
  const viewOn = await fetch(`${B}/__operator/upstream-key.json`, { headers: { "X-Operator-Token": OP } }).then((r) => r.json());
  ok(viewOn.enabled === true, "the operator view says the switch is on");
  ok(/X-Agent402-Upstream-Key/.test(privacy) && /provider \(GitHub, for <code>github-repo<\/code>\)/.test(privacy.replace(/\s+/g, " ")), "/privacy says what is done with the key and names the provider it is sent to");
  const egress = await fetch(`${B}/__operator/egress.json?top=200`, { headers: { "X-Operator-Token": OP } }).then((r) => r.json());
  const ghCalls = (egress.hosts || []).find((h) => h.host === "api.github.com")?.calls || 0;
  ok(ghCalls === 4, `the egress count (what the budgets read) holds the two list-price calls' reads only, two each (${ghCalls})`);
  // The analytics client sends its batch on its 10 s interval.
  for (let i = 0; i < 30 && !analytics.length; i++) await sleep(500);
} finally {
  if (srv) await srv.stop();
}
await sleep(500);
// The key in no log line, answer, analytics event or stored file.
const log = srv ? srv.log() : "";
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else files.push(p); } };
try { walk(storeDir); } catch { /* none */ }
const stored = files.map((p) => { try { return readFileSync(p).toString("latin1"); } catch { return ""; } }).join("\n");
const leaks = (text) => [BUYER, REFUSED, LONG.slice(0, 60)].filter((k) => text.includes(k));
ok(log.length > 0 && leaks(log).length === 0, `no log line carries a buyer's key (${log.length} log bytes)`);
ok(leaks(bodies.join("\n")).length === 0, `no answer body or header carries it (${bodies.length / 2} answers)`);
ok(analytics.length > 0 && leaks(analytics.join("\n")).length === 0, `no analytics event carries it (${analytics.length} batches)`);
ok(files.length > 0 && leaks(stored).length === 0, `no stored record carries it (${files.length} files)`);

// ---------------- Part 3: the switch off (the default) ----------------
{
  const offStores = ownStoreEnv("upstream-key-off");
  const offBodies = [];
  let off = null;
  try {
    off = await boot(offStores, "");
    const B = off.url;
    for (let i = 0; i < 120; i++) { const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null); if (r?.status === 402) break; await sleep(250); }
    const BODY = JSON.stringify({ owner: "expressjs", repo: "express" });
    const call = async (path, headers = {}, body = BODY) => {
      const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      const text = await r.text();
      offBodies.push(text, [...r.headers].map(([k, v]) => `${k}: ${v}`).join("\n"));
      let json = null; try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, json, text, pr: r.headers.get("payment-required") || "", headers: r.headers };
    };
    const offerOf = (c) => { try { return JSON.parse(Buffer.from(c.pr, "base64").toString("utf8")); } catch { return null; } };
    const credential = (accept) => Buffer.from(JSON.stringify({ x402Version: 2, resource: accept.resource, accepted: accept, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000d1", to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } })).toString("base64");
    const pricing = await fetch(`${B}/api/pricing`).then((r) => r.json());
    const row = (pricing.endpoints || []).find((t) => t.slug === "github-repo");
    const LIST = String(Math.round(Number(String(row?.price).replace(/^\$/, "")) * 1e6));
    const plain = await call("/api/github-repo");
    const keyed = await call("/api/github-repo", { [H]: BUYER });
    // The quote: the same offer, byte for byte, with the header and without.
    ok(plain.status === 402 && keyed.status === 402 && plain.pr.length > 0 && keyed.pr === plain.pr && keyed.text === plain.text && (offerOf(keyed)?.accepts || []).every((a) => a.amount === LIST), `off: the 402 with the header is the list-price 402, byte for byte (${(offerOf(keyed)?.accepts || []).map((a) => a.amount)})`);
    const accept = offerOf(plain).accepts.find((a) => a.scheme === "exact");
    const s0 = settles.length; let n0 = ghSeen.length;
    const paid = await call("/api/github-repo", { [H]: BUYER, "payment-signature": credential(accept) });
    const reads = ghSeen.slice(n0);
    ok(paid.status === 200 && settles.length === s0 + 1 && settles.at(-1) === LIST, `off: a paid call carrying the header is served and settles the list price (${paid.status}, ${settles.at(-1)})`);
    ok(reads.length > 0 && reads.every((x) => x.auth === `Bearer ${OURS}`), `off: the upstream receives the server's own token, never the header's (${reads.length} reads)`);
    n0 = ghSeen.length;
    const control = await call("/api/github-repo", { "payment-signature": credential(accept) });
    ok(control.status === 200 && JSON.stringify(Object.keys(control.json || {}).sort()) === JSON.stringify(Object.keys(paid.json || {}).sort()) && ghSeen.slice(n0).every((x) => x.auth === `Bearer ${OURS}`), "off control: the same call without the header answers the same shape with the same token");
    // No refusal of the feature's own: an oversized header, a malformed one, one over plain HTTP.
    const long = await call("/api/github-repo", { [H]: LONG });
    const bad = await call("/api/github-repo", { [H]: "sk-not-github" });
    const clear = await call("/api/github-repo", { [H]: BUYER, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "http" });
    ok(long.status === 402 && bad.status === 402 && clear.status === 402 && long.pr === plain.pr && bad.pr === plain.pr, `off: an oversized, a malformed and a plain-HTTP header are each answered the ordinary 402 (${long.status}, ${bad.status}, ${clear.status})`);
    // No surface mentions it.
    const surfaces = {};
    for (const p of ["/llms.txt", "/llms-full.txt", "/openapi.json", "/privacy", "/terms", "/changelog", "/api/pricing", "/tools/github-repo", "/api/github-repo/docs", "/.well-known/x402"]) { const r = await fetch(`${B}${p}`); surfaces[p] = r.status === 200 ? await r.text() : ""; }
    // (An older changelog item's "bring your own upstream key" is about self-hosting, not this header.)
    const WORDS = /Upstream-Key|upstream_key|Bring your own (?:key\b|GitHub)|your own (?:GitHub token|key for another service)|own-key price/i;
    const named = Object.entries(surfaces).filter(([, t]) => WORDS.test(t)).map(([p]) => p);
    ok(surfaces["/llms.txt"].length > 500 && surfaces["/openapi.json"].length > 500 && surfaces["/terms"].length > 500 && surfaces["/changelog"].length > 500 && surfaces["/tools/github-repo"].length > 500 && named.length === 0, `off: no surface mentions the feature (${named.map((p) => `${p}: ${(surfaces[p].match(WORDS) || [])[0]} @ ${surfaces[p].slice(Math.max(0, surfaces[p].search(WORDS) - 70), surfaces[p].search(WORDS) + 50).replace(/\s+/g, " ")}`).join(" || ") || "none"})`);
    ok(!WORDS.test(row?.description || "x") && /Unknown repos return 404\.$/.test(row?.description || ""), "off: the github-repo description ends where it did before the feature");
    ok(/last updated 2026-11-25\./.test(surfaces["/terms"]), "off: /terms keeps its own date");
    const view = await fetch(`${B}/__operator/upstream-key.json`, { headers: { "X-Operator-Token": OP } }).then((r) => r.json());
    ok(view.enabled === false && view.counts?.removedWhileOff >= 5 && view.counts?.applied === 0 && view.counts?.malformed === 0 && view.counts?.tooLong === 0 && view.counts?.inClear === 0, `off: the operator view says off, and only removals are counted (${JSON.stringify(view.counts)})`);
  } finally {
    if (off) await off.stop();
  }
  await sleep(300);
  const offLog = off ? off.log() : "";
  const offFiles = [];
  const walkOff = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walkOff(p); else offFiles.push(p); } };
  try { walkOff(dirname(offStores.TRAFFIC_DIR)); } catch { /* none */ }
  const offStored = offFiles.map((p) => { try { return readFileSync(p).toString("latin1"); } catch { return ""; } }).join("\n");
  ok(offLog.length > 0 && leaks(offLog).length === 0 && leaks(offBodies.join("\n")).length === 0 && leaks(offStored).length === 0, `off: the key is in no log line, answer or stored file (${offFiles.length} files)`);
}
for (const s of [github, facilitator, posthog]) s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
