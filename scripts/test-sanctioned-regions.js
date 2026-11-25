// Sanctioned regions (src/sanctioned-regions.js) and the sanctions events
// store (src/sanctions-events.js).
//
// Unit: the location verdict reads Cloudflare's headers only when trusted,
// blocks the country set and the occupied regions of Ukraine, and lets the
// exempt paths through. Store: events are kept in full, the report word reads
// due until an operator marks them filed, and the ten-year prune never drops
// an unfiled event.
//
// Server (paid mode, a stub facilitator that counts every call): a paid
// request with a payment header through the CDN from a blocked country is
// answered 451 with charged:false and the facilitator is never asked to verify
// or settle; the SAME request from an allowed country does reach /verify (the
// live control); a request whose CF-IPCountry did not come through the
// authenticated CDN path is not blocked; /health and /terms answer from a
// blocked country; the refused payment is on the operator view and the
// status word reads due until it is marked filed.
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

const dir = mkdtempSync(join(tmpdir(), "sanctions-events-"));
process.env.SANCTIONS_EVENTS_FILE = join(dir, "events.jsonl");
delete process.env.SANCTIONS_GEO_BLOCK;
delete process.env.SANCTIONS_GEO_COUNTRIES;

const geo = await import("../src/sanctioned-regions.js");
const { NOT_CHARGED } = await import("../src/not-charged.js");
const ev = await import("../src/sanctions-events.js");

let pass = 0;
let srv = null, facilitator = null;
const fail = (m) => { console.error("FAIL:", m); if (srv) for (const l of srv.log().split("\n").slice(-25)) console.error("  server:", l.slice(0, 300)); srv?.child.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// ---- unit: the verdict
const req = (h, path = "/api/x") => ({ headers: h, path, method: "GET", header: (n) => h[n.toLowerCase()] });
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "IR" }), { trusted: true })?.country === "IR", "Iran is blocked when the header is trusted");
for (const c of ["CU", "KP", "SY"]) ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": c }), { trusted: true })?.country === c, `${c} is blocked`);
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "IR" }), { trusted: false }) === null, "an untrusted CF-IPCountry is never read");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "US" }), { trusted: true }) === null, "an allowed country passes");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "XX" }), { trusted: true }) === null && geo.sanctionedLocationOf(req({ "cf-ipcountry": "T1" }), { trusted: true }) === null, "unknown (XX) and Tor (T1) are not blocked");
for (const code of ["43", "40", "14", "09", "UA-43"]) ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "UA", "cf-region-code": code }), { trusted: true }) !== null, `Ukraine region ${code} is blocked`);
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "UA", "cf-region-code": "30" }), { trusted: true }) === null, "the rest of Ukraine (Kyiv, 30) passes");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "RU", "cf-region": "Crimea" }), { trusted: true }) !== null, "Crimea filed under another country code is blocked by name");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "RU", "cf-region": "Republic of Crimea" }), { trusted: true })?.region === "UA-43", "a region found by name is recorded as its code, never the header's text");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "UA", "cf-region-code": "14" }), { trusted: true })?.region === "UA-14", "a Ukraine region is its ISO 3166-2 code");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "IR", "cf-region-code": "<script>" }), { trusted: true })?.region === null, "a region header that is not a code is dropped");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "IR", "cf-region-code": "23" }), { trusted: true })?.region === "IR-23", "a country refusal keeps its subdivision code");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "RU", "cf-region": "Moscow" }), { trusted: true }) === null, "the rest of Russia is not blocked here (not a comprehensive program)");
ok(geo.sanctionedLocationOf(req({ "cf-ipcountry": "CU" }), { trusted: true, countries: geo.sanctionedCountries({ SANCTIONS_GEO_COUNTRIES: "IR" }) }) === null, "SANCTIONS_GEO_COUNTRIES replaces the country set");

// ---- unit: the middleware
const run = (mw, r) => new Promise((resolve) => {
  const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); } };
  mw(r, res, () => resolve({ status: "next" }));
});
{
  const recorded = [];
  const logged = [];
  const mw = geo.sanctionedRegionsMiddleware({ env: {}, record: (e) => recorded.push(e), log: (l) => logged.push(l) });
  const a = await run(mw, { ...req({ "cf-ipcountry": "KP" }), viaCdn: true });
  ok(a.status === 451 && a.body.charged === false && a.body.reason === "unavailable_in_region" && a.headers["cache-control"] === "no-store", "a blocked request is answered 451, charged:false, no-store");
  ok(!/sanction|ofac|treasury/i.test(JSON.stringify(a.body)), "the 451 body is neutral");
  ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, "/health"), viaCdn: true })).status === "next", "/health answers from anywhere");
  ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, "/terms"), viaCdn: true })).status === "next", "/terms answers from anywhere");
  ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, "/privacy"), viaCdn: true })).status === "next", "/privacy answers from anywhere");
  for (const p of ["/dpa", "/accessibility"]) ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, p), viaCdn: true })).status === "next", `${p} answers from anywhere (a legal page)`);
  ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }), viaCdn: false })).status === "next", "a request that did not come through the CDN is not blocked on its own header");
  ok(recorded.length === 0, "a blocked request with no payment is counted, not stored");
  await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": "e30=" }), viaCdn: true });
  await new Promise((r) => setTimeout(r, 20));
  ok(recorded.length === 1 && recorded[0].aggregate === true && recorded[0].kind === "unproven-refusal" && recorded[0].reason === "unverified-payment" && !("payer" in recorded[0]), "a blocked request whose payment proves no payer is passed on as an aggregate count, with no address");
  recorded.length = 0;
  // Paid route classes are never exempt; the legal pages' own assets are.
  for (const p of ["/mcp", "/v1/chat/completions", "/api/uuid", "/api/decide/execute", "/ref/whois", "/aws/uuid", "/fonts/../server.js", "/fonts/x.js", "/terms/x", "/health/x"]) {
    ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, p), viaCdn: true })).status === 451, `${p} is refused from a blocked region (never exempt)`);
  }
  for (const p of ["/fonts/geist-400-latin.woff2", "/logo.svg", "/favicon.svg", "/favicon.ico"]) {
    ok((await run(mw, { ...req({ "cf-ipcountry": "KP" }, p), viaCdn: true })).status === "next", `${p} answers from anywhere (a legal page's asset)`);
  }
  const off = geo.sanctionedRegionsMiddleware({ env: { SANCTIONS_GEO_BLOCK: "off" } });
  ok((await run(off, { ...req({ "cf-ipcountry": "IR" }), viaCdn: true })).status === "next", "SANCTIONS_GEO_BLOCK=off turns the block off");
  const v = geo.sanctionedRegionsView({});
  ok(v.refused >= 2 && v.refusedWithPayment === 1 && v.aggregated.unverified === 1 && v.eventsRecorded === 0 && v.byCountry.KP >= 1 && v.regionHeaders === "absent", "the operator view counts refusals, the unverified payment as counted only, and says region headers are absent");
  ok(!/sanction|IR|KP|UA-/.test(logged.join(" ").replace(/\[sanctions-geo\]/g, "")), `the refusal log line names no location (${logged[0] || "none"})`);
}

// ---- a Tempo push credential: the money moved before the request arrived
{
  const { Credential } = await import("mppx");
  const push = (hash) => Credential.serialize({ challenge: { id: "c1", realm: "r", method: "tempo", intent: "charge", request: { amount: "10000", currency: "0x20c0000000000000000000000000000000000000", recipient: "0x000000000000000000000000000000000000dead" } }, payload: { type: "hash", hash } });
  const H1 = `0x${"ab".repeat(32)}`, H2 = `0x${"cd".repeat(32)}`;
  ok(geo.pushCredentialHashOf({ headers: { authorization: push(H1) } }) === H1, "a push credential's transaction hash is read");
  ok(geo.pushCredentialHashOf({ headers: { authorization: "Payment x" } }) === null && geo.pushCredentialHashOf({ headers: {} }) === null, "anything else names no push transaction");
  const recorded = [];
  const senders = { [H1]: "0x1111111111111111111111111111111111111111", [H2]: null };
  const mw = geo.sanctionedRegionsMiddleware({ env: {}, record: (e) => recorded.push(e), pushSender: async (r) => senders[geo.pushCredentialHashOf(r)] ?? null, log: () => {} });
  const a = await run(mw, { ...req({ "cf-ipcountry": "IR", authorization: push(H1) }), viaCdn: true });
  ok(a.status === 451 && a.body.charged === undefined && a.body.transferClaimed === false && a.body.reason === "unavailable_in_region", "a push credential's 451 carries transferClaimed:false and no charged:false");
  ok(!a.body.error.includes(NOT_CHARGED) && /not claimed/.test(a.body.error), `the push 451 does not say nothing was charged (${a.body.error})`);
  await new Promise((r) => setTimeout(r, 20));
  ok(recorded.length === 1 && recorded[0].payer === senders[H1] && recorded[0].pushHash === H1 && recorded[0].country === "IR", "the push transfer is recorded with the sender the chain shows, keyed on its hash");
  await run(mw, { ...req({ "cf-ipcountry": "IR", authorization: push(H1) }), viaCdn: true });
  await new Promise((r) => setTimeout(r, 20));
  ok(recorded.length === 2 && recorded[1].payer === senders[H1] && recorded[1].pushHash === H1, "the same push transfer sent again is passed on again, as the same payer and hash (the store adds an attempt to its row)");
  await run(mw, { ...req({ "cf-ipcountry": "IR", authorization: push(H2) }), viaCdn: true });
  await new Promise((r) => setTimeout(r, 20));
  ok(recorded.length === 3 && recorded[2].aggregate === true && recorded[2].kind === "unproven-refusal" && !recorded[2].payer, "a push transfer whose sender the chain does not show is an aggregate count, with no address");
  const sy = await run(mw, { ...req({ "cf-ipcountry": "SY", authorization: push(`0x${"ef".repeat(32)}`) }), viaCdn: true });
  await new Promise((r) => setTimeout(r, 20));
  ok(sy.status === 451 && sy.body.transferClaimed === false && recorded.length === 3, "a push transfer from a country blocked by choice (SY) is refused the same way and never recorded as a report");
  // The x402 payment's 451 is unchanged.
  const x = await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": "e30=" }), viaCdn: true });
  ok(x.body.charged === false && x.body.error.includes(NOT_CHARGED), "an x402 payment's 451 still says nothing was charged");
}

// ---- the server's own push reader: only a transfer that paid THIS server
// (a challenge we issued, the chain's transfer to our Tempo payTo in our
// currency) is recorded, with the chain's sender and value. A credential that
// names a transfer to anyone else, or a challenge we did not issue, is
// counted only (the probe: a stranger's transfer named from a blocked region).
{
  const { Credential, Challenge } = await import("mppx");
  const { keccak256, toBytes } = await import("viem");
  const { ourTempoPushTransfer } = await import("../src/mpp-tempo.js");
  const { TRANSFER_WITH_MEMO_TOPIC } = await import("../src/tempo-confirm.js");
  const SECRET = "geo-push-test-secret", REALM = "geo.test";
  const OURS = "0x00000000000000000000000000000000000a11ce", STRANGER = "0x00000000000000000000000000000000000beef0";
  const TOKEN = "0x20c0000000000000000000000000000000000000", OTHER_TOKEN = "0x20c0000000000000000000000000000000000009";
  const VICTIM = "0x7777777777777777777777777777777777777777", BUYER = "0x2222222222222222222222222222222222222222";
  const saved = { r: process.env.TEMPO_RECIPIENT_ADDRESS, c: process.env.TEMPO_CURRENCY };
  process.env.TEMPO_RECIPIENT_ADDRESS = OURS; delete process.env.TEMPO_CURRENCY;
  const pad = (a) => `0x${a.slice(2).padStart(64, "0")}`;
  const memoFor = (id) => `0x${keccak256(toBytes("mpp")).slice(2, 10)}01${"0".repeat(40)}${keccak256(toBytes(id)).slice(2, 16)}`;
  const minted = (recipient = OURS, currency = TOKEN, amount = "10000") => Challenge.from({ realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 300_000).toISOString(), request: { amount, currency, recipient, decimals: 6, methodDetails: { chainId: 4217 } }, secretKey: SECRET });
  const forged = (recipient = STRANGER) => ({ id: "attacker-known-challenge", realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 300_000).toISOString(), request: { amount: "10000", currency: TOKEN, recipient, methodDetails: { chainId: 4217 } } });
  const credOf = (challenge, hash) => Credential.serialize({ challenge, payload: { type: "hash", hash } });
  // The chain, by hash: each receipt holds one TransferWithMemo log.
  const chain = new Map();
  const onChain = (hash, { token = TOKEN, from, to, id, value }) => chain.set(hash, { status: "0x1", logs: [{ address: token, topics: [TRANSFER_WITH_MEMO_TOPIC, pad(from), pad(to), memoFor(id)], data: `0x${BigInt(value).toString(16).padStart(64, "0")}` }] });
  const reads = [];
  const fetchImpl = async (_u, init) => { const h = JSON.parse(init.body).params[0]; reads.push(h); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chain.get(h) ?? null })); };
  const reader = (r) => ourTempoPushTransfer(String(r.headers.authorization), { secretKey: SECRET, realm: REALM, rpcUrl: "http://stub", fetchImpl });
  // Rows naming a payer, apart from the aggregate counts (which name none).
  const recorded = [], aggregated = [];
  const mw = geo.sanctionedRegionsMiddleware({ env: {}, record: (e) => (e.aggregate ? aggregated : recorded).push(e), pushSender: reader, log: () => {} });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const send = async (auth) => { const a = await run(mw, { ...req({ "cf-ipcountry": "IR", authorization: auth }), viaCdn: true }); await settle(); return a; };

  // The probe: a forged challenge naming a stranger's transfer is never recorded.
  const P = `0x${"ab".repeat(32)}`;
  onChain(P, { from: VICTIM, to: STRANGER, id: "attacker-known-challenge", value: 10000 });
  const pr = await send(credOf(forged(), P));
  ok(pr.status === 451 && pr.body.transferClaimed === false && recorded.length === 0 && aggregated.length === 1 && !aggregated[0].payer, "a push credential naming a transfer to someone else (a challenge we did not issue) is refused, never a row naming an address, and counted in the aggregate");
  ok(reads.length === 0, "a challenge we did not issue is refused before any chain read");
  // A forged challenge that names OUR payTo (HMAC fails) is not recorded either.
  const F = `0x${"ac".repeat(32)}`;
  onChain(F, { from: VICTIM, to: OURS, id: "attacker-known-challenge", value: 10000 });
  await send(credOf(forged(OURS), F));
  ok(recorded.length === 0, "a challenge naming our payTo whose id does not HMAC-verify is never recorded");
  // A challenge we minted for a stranger's address (never happens, but the
  // recipient check is its own) is not recorded.
  const S = `0x${"ad".repeat(32)}`;
  const chS = minted(STRANGER);
  onChain(S, { from: VICTIM, to: STRANGER, id: chS.id, value: 10000 });
  await send(credOf(chS, S));
  ok(recorded.length === 0, "a challenge whose recipient is not our Tempo payTo is never recorded");
  // Our challenge, but the chain's transfer paid someone else or another token.
  const W = `0x${"ae".repeat(32)}`, T = `0x${"af".repeat(32)}`;
  const chW = minted(), chT = minted(OURS, OTHER_TOKEN);
  onChain(W, { from: VICTIM, to: STRANGER, id: chW.id, value: 10000 });
  onChain(T, { token: OTHER_TOKEN, from: VICTIM, to: OURS, id: chT.id, value: 10000 });
  await send(credOf(chW, W)); await send(credOf(chT, T));
  ok(recorded.length === 0, "our challenge with a transfer to someone else, or in a currency we do not offer, is never recorded");
  // The live control: our challenge, a transfer to our payTo in our currency.
  // The event carries the chain's sender and value (more than the challenge
  // asked), never the credential's own amount.
  const G = `0x${"b0".repeat(32)}`;
  const chG = minted();
  onChain(G, { from: BUYER, to: OURS, id: chG.id, value: 12345 });
  await send(credOf(chG, G));
  ok(recorded.length === 1 && recorded[0].payer === BUYER && recorded[0].pushHash === G && recorded[0].amount === "12345" && recorded[0].asset === TOKEN, `a transfer that paid this server is recorded with the chain's sender and value (${JSON.stringify(recorded[0] ? { payer: recorded[0].payer, amount: recorded[0].amount, asset: recorded[0].asset } : null)})`);
  if (saved.r === undefined) delete process.env.TEMPO_RECIPIENT_ADDRESS; else process.env.TEMPO_RECIPIENT_ADDRESS = saved.r;
  if (saved.c !== undefined) process.env.TEMPO_CURRENCY = saved.c;
}

// ---- the agent surfaces document the 451 while the block is on, and only then
{
  const { openapiSpec } = await import("../src/pages.js");
  const { llmsTxt } = await import("../src/seo.js");
  const { KIT } = await import("../src/tools/kit.js");
  const t = KIT.find((x) => x.slug === "uuid") || KIT[0];
  const opOf = () => openapiSpec("https://example.test", { [t.route]: t }).paths[t.route.split(" ")[1]]?.[t.route.split(" ")[0].toLowerCase()];
  const on451 = opOf()?.responses?.["451"]?.description || "";
  ok(/unavailable_in_region/.test(on451) && /before any payment is verified or settled/.test(on451), `/openapi.json: a paid operation documents the 451 (${t.slug})`);
  ok(/- Regions: a request from a region this service does not serve is answered `451` \(reason `unavailable_in_region`\)/.test(llmsTxt("https://example.test", {})), "/llms.txt names the 451 and its reason");
  const prior = process.env.SANCTIONS_GEO_BLOCK;
  process.env.SANCTIONS_GEO_BLOCK = "off";
  try {
    ok(!opOf()?.responses?.["451"] && !/unavailable_in_region/.test(llmsTxt("https://example.test", {})), "with the block off, neither surface names the 451");
  } finally { if (prior === undefined) delete process.env.SANCTIONS_GEO_BLOCK; else process.env.SANCTIONS_GEO_BLOCK = prior; }
}

// ---- the geo-payment gate: only a payment whose signature proves its payer is reportable
{
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const PAY_TO = "0x000000000000000000000000000000000000dEaD";
  const accept = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
  const signed = async (account, nonce = `0x${randomBytes(32).toString("hex")}`) => {
    const t = Math.floor(Date.now() / 1000);
    const authorization = { from: account.address, to: PAY_TO, value: "10000", validAfter: String(t - 60), validBefore: String(t + 300), nonce };
    const signature = await account.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: accept.asset }, types: TYPES, primaryType: "TransferWithAuthorization", message: { ...authorization, value: 10000n, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature, authorization } })).toString("base64");
  };
  const outerFile = process.env.SANCTIONS_EVENTS_FILE;
  process.env.SANCTIONS_EVENTS_FILE = join(mkdtempSync(join(tmpdir(), "geo-gate-")), "events.jsonl");
  ev.__resetSanctionsEventsForTests();
  geo.__resetSanctionedRegionsForTests();
  // The server's own record callback shape (src/server.js): an aggregate, or the proven payer's event.
  const recordGeo = ({ req: r, payer, country, region, aggregate, kind, reason }) => (aggregate
    ? ev.recordSanctionsAggregate({ kind, reason, rail: "x402", route: `${r.method} ${r.path}`, country, region })
    : ev.recordSanctionsEvent({ kind: "geo-payment", address: payer, rail: "x402", route: `${r.method} ${r.path}`, ip: r.ip, country, region }));
  ev.__resetSanctionsEventLimitsForTests();
  const mw = geo.sanctionedRegionsMiddleware({ env: {}, log: () => {}, verify: (r) => geo.verifiedGeoPayer(r, { payTo: PAY_TO }), record: recordGeo });
  const rowsOf = async () => (await ev.sanctionsEventsOperatorView({ recent: 1000 })).recent;
  const own = async () => (await rowsOf()).filter((r) => !r.aggregate);
  const aggOf = async (kind) => (await rowsOf()).filter((r) => r.aggregate && r.kind === kind);
  // 500 forged payments (a stated address, no valid signature; and the MPP form) from one client.
  const victim = privateKeyToAccount(generatePrivateKey());
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature: "0x" + "11".repeat(65), authorization: { from: victim.address, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } } })).toString("base64");
  for (let i = 0; i < 500; i++) {
    const h = i % 2 ? { "payment-signature": forged } : { authorization: "Payment x" };
    await run(mw, { ...req({ "cf-ipcountry": "IR", ...h }), ip: "203.0.113.9", viaCdn: true });
  }
  await new Promise((r) => setTimeout(r, 50));
  const un = await aggOf("unproven-refusal");
  ok(ev.sanctionsReportStatus() === "clear" && (await own()).length === 0 && un.length === 1 && un[0].count === 500 && un[0].country === "IR" && un[0].address === null && !JSON.stringify(un).includes(victim.address.slice(2, 12)), `500 forged payments from a blocked region: no row naming an address, all 500 in the hour's unproven aggregate (${un[0]?.count}); the word stays clear`);
  // One genuinely signed payment: one event, naming the signer.
  const buyer = privateKeyToAccount(generatePrivateKey());
  const hdr = await signed(buyer);
  await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": hdr }), ip: "203.0.113.10", viaCdn: true });
  await new Promise((r) => setTimeout(r, 50));
  let rows = await own();
  ok(rows.length === 1 && rows[0].address?.toLowerCase() === buyer.address.toLowerCase() && rows[0].country === "IR" && rows[0].attempts === 1 && ev.sanctionsReportStatus() === "due", "a payment whose signature verifies is recorded once, naming its signer; the word reads due");
  // The same payment again: an attempt on its row, never a second row, never dropped.
  for (let i = 0; i < 3; i++) await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": hdr }), ip: "203.0.113.10", viaCdn: true });
  await new Promise((r) => setTimeout(r, 50));
  rows = await own();
  ok(rows.length === 1 && rows[0].attempts === 4, `the same payment re-sent adds an attempt each time (${rows[0]?.attempts} attempts on ${rows.length} row)`);
  // One client: at most GEO_EVENTS_PER_CLIENT_DAY rows of its own a day; the rest in the hour's aggregate.
  for (let i = 0; i < geo.GEO_EVENTS_PER_CLIENT_DAY + 4; i++) await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": await signed(privateKeyToAccount(generatePrivateKey())) }), ip: "203.0.113.11", viaCdn: true });
  await new Promise((r) => setTimeout(r, 100));
  rows = await own();
  let gAgg = await aggOf("geo-payment");
  ok(rows.filter((r) => r.ip === "203.0.113.11").length === geo.GEO_EVENTS_PER_CLIENT_DAY && gAgg.length === 1 && gAgg[0].count === 4 && gAgg[0].byReason["client-bound"] === 4 && gAgg[0].report === "rejected" && gAgg[0].country === "IR", `one client records ${geo.GEO_EVENTS_PER_CLIENT_DAY} rows a day; the other 4 are counted in the hour's geo-payment aggregate (${gAgg[0]?.count})`);
  // 120 fresh wallets rotating inside one IPv6 /64: one client. Its overflow is counted, and a
  // later genuine list hit is recorded in full (list hits share no budget with geo rows).
  const before64 = (await own()).length;
  for (let i = 0; i < 120; i++) await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": await signed(privateKeyToAccount(generatePrivateKey())) }), ip: `2001:db8:7:9:${(i + 1).toString(16)}::1`, viaCdn: true });
  await new Promise((r) => setTimeout(r, 100));
  gAgg = await aggOf("geo-payment");
  ok((await own()).length - before64 === geo.GEO_EVENTS_PER_CLIENT_DAY && gAgg[0].byReason["client-bound"] === 4 + 120 - geo.GEO_EVENTS_PER_CLIENT_DAY, `120 wallets from one /64: ${geo.GEO_EVENTS_PER_CLIENT_DAY} rows, the other ${120 - geo.GEO_EVENTS_PER_CLIENT_DAY} in the aggregate count (${gAgg[0].byReason["client-bound"] - 4})`);
  const hit = await ev.recordSanctionsEvent({ kind: "screen-hit", address: "0x" + "5e".repeat(20), rail: "x402", route: "POST /api/hash", ip: "2001:db8:7:9::99" });
  ok(hit?.kind === "screen-hit" && (await own()).some((r) => r.id === hit.id), "a genuine list hit afterwards, from the same /64, is recorded");
  // An IPv4-mapped spelling is the IPv4 client.
  const mappedBefore = (await own()).length;
  for (let i = 0; i < geo.GEO_EVENTS_PER_CLIENT_DAY + 2; i++) await run(mw, { ...req({ "cf-ipcountry": "IR", "payment-signature": await signed(privateKeyToAccount(generatePrivateKey())) }), ip: i % 2 ? "198.51.100.77" : "::ffff:198.51.100.77", viaCdn: true });
  await new Promise((r) => setTimeout(r, 100));
  ok((await own()).length - mappedBefore === geo.GEO_EVENTS_PER_CLIENT_DAY, "an IPv4 address and its IPv4-mapped spelling are one client");
  // The hourly bound: past it, new proven payments are counted in the aggregate.
  const hourGate = geo.createGeoPaymentGate({ verify: async () => ({ payer: "0x" + randomBytes(20).toString("hex"), nonce: "0x01" }), perHour: 3 });
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await hourGate({ req: { ip: `192.0.2.${i}` }, country: "CU", region: null }));
  ok(outs.slice(0, 3).every((o) => o.payer && !o.aggregate) && outs.slice(3).every((o) => o.aggregate && o.kind === "geo-payment" && o.reason === "hour-bound" && !o.payer), "past the hourly bound, a proven payment is an aggregate count (no address), never dropped");
  rows = await own();
  // Syria: in the block list by choice, not a program: refused, counted, never reported.
  const before = rows.length;
  const sy = await run(mw, { ...req({ "cf-ipcountry": "SY", "payment-signature": await signed(privateKeyToAccount(generatePrivateKey())) }), ip: "203.0.113.12", viaCdn: true });
  await new Promise((r) => setTimeout(r, 50));
  ok(sy.status === 451 && (await own()).length === before && geo.sanctionedRegionsView({}).countedOnly.nonProgram === 1, "a verified payment from SY is refused and counted, never recorded as a report");
  // File mode appends one line per event (never rewrites the file for a new one).
  const { readFileSync: rf } = await import("node:fs");
  const fileLines = rf(process.env.SANCTIONS_EVENTS_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(fileLines.length === (await rowsOf()).length && fileLines.some((l) => l.aggregate && l.count === 500) && fileLines.some((l) => l.attempts === 4), "file mode holds one line per row, with the attempt and aggregate counts");
  process.env.SANCTIONS_EVENTS_FILE = outerFile;
  ev.__resetSanctionsEventsForTests();
}

// ---- unit: the store
{
  ev.__resetSanctionsEventsForTests();
  ok(ev.sanctionsReportStatus() === "clear", "an empty store reads clear");
  const mon = Date.UTC(2026, 10, 23, 12); // a Monday
  ok(new Date(ev.addBusinessDays(mon)).toISOString().slice(0, 10) === "2026-12-07", "ten business days from a Monday skip two weekends");
  const a = await ev.recordSanctionsEvent({ kind: "screen-hit", address: "0xAbCdEf0000000000000000000000000000000001", rail: "x402", network: "eip155:8453", amount: "10000", route: "POST /api/x" }, { now: mon });
  ok(a && a.report === "rejected" && a.address === "0xAbCdEf0000000000000000000000000000000001" && a.dueBy.startsWith("2026-12-07"), "a screen hit is kept in full (case preserved) with its report deadline");
  const g = await ev.recordSanctionsEvent({ kind: "geo-payment", country: "ua", region: "UA-43", route: "POST /api/x" }, { now: mon });
  const g2 = await ev.recordSanctionsEvent({ kind: "geo-payment", country: "Iran", region: "Simferopol, 44.95,34.10", route: "POST /api/x" }, { now: mon });
  ok(g.country === "UA" && g.region === "UA-43" && g2.country === null && g2.region === null, "a geo event keeps a country or region only in its code form");
  await ev.markSanctionsEventsFiled({ ids: [g.id, g2.id], reference: "TEST-GEO" });
  ok(ev.sanctionsReportStatus() === "due", "an unfiled reportable event reads due");
  ev.__resetSanctionsEventsForTests();
  ok(ev.sanctionsReportStatus() === "due", "the event survives a reload from the file");
  let threw = null;
  try { await ev.markSanctionsEventsFiled({ all: true, reference: "" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, "marking filed needs the filing reference");
  const m = await ev.markSanctionsEventsFiled({ ids: [a.id], reference: "OFAC-RS-12345" });
  ok(m.marked === 1 && ev.sanctionsReportStatus() === "clear", "marked filed, the word reads clear");
  const old = await ev.recordSanctionsEvent({ kind: "blocked-refund", address: "Abc1base58CaseKept", amountUsd: 0.01 }, { now: Date.UTC(2014, 0, 6) });
  const dry = await ev.pruneSanctionsEvents({ now: Date.UTC(2026, 10, 24) });
  ok(dry.due === 0 && dry.removed === 0, "an unfiled reportable event past ten years is never pruned");
  await ev.markSanctionsEventsFiled({ ids: [old.id], reference: "OFAC-RS-1" });
  const dry2 = await ev.pruneSanctionsEvents({ now: Date.UTC(2026, 10, 24) });
  ok(dry2.due === 1 && dry2.removed === 0, "the prune is a dry run by default");
  const real = await ev.pruneSanctionsEvents({ now: Date.UTC(2026, 10, 24), apply: true });
  ok(real.removed === 1 && (await ev.pruneSanctionsEvents({ now: Date.UTC(2026, 10, 24) })).due === 0, "applied, it removes only events past ten years");
  ok(ev.sanctionsRetentionYears({ SANCTIONS_EVENTS_RETENTION_YEARS: "3" }) === 10, "retention never drops below ten years");
  let bad = null;
  try { bad = await ev.recordSanctionsEvent({ kind: "nope" }); } catch { bad = "threw"; }
  ok(bad === null, "an unknown kind is refused without throwing into the caller");
}

// ---- server: paid mode behind the CDN
const OP = "sanctions-regions-operator-token-0123456789";
const SECRET = "origin-secret-for-sanctions-test-0123";
let verifies = 0, settles = 0;
facilitator = createServer((r, res) => {
  let body = ""; r.on("data", (c) => (body += c)); r.on("end", () => {
    const reply = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (r.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (r.url === "/verify") { verifies++; return reply(200, { isValid: false, invalidReason: "invalid_signature" }); }
    if (r.url === "/settle") { settles++; return reply(200, { success: false, errorReason: "invalid", transaction: "", network: "eip155:8453" }); }
    if (r.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = facilitator.address().port;
try {
  try {
    srv = await bootServer({
      stores: "sanctioned-regions", readyPath: "/health", timeoutMs: 180_000,
      env: { WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FREE_MODE: "",
        FACILITATOR_URL: `http://127.0.0.1:${FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`,
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
        CDN_PROXY: "on", CDN_ORIGIN_SECRET: SECRET, CF_IP_RANGES_EXTRA: "127.0.0.1/32,::1/128",
        AGENT402_OPERATOR_TOKEN: OP, SANCTIONS_EVENTS_FILE: join(dir, "server-events.jsonl"),
        SANCTIONS_GEO_BLOCK: "", SANCTIONS_GEO_COUNTRIES: "" },
    });
  } catch (e) { fail(`server did not boot: ${e.message.slice(0, 1500)}`); }
  const B = srv.url;
  const cdn = (country) => ({ "X-Origin-Auth": SECRET, "CF-Connecting-IP": "203.0.113.9", ...(country ? { "CF-IPCountry": country } : {}) });
  const offer = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", ...cdn("US") }, body: JSON.stringify({ text: "hi" }) });
  ok(offer.status === 402, `an unpaid call from an allowed country gets the 402 offer (got ${offer.status})`);
  const pr = JSON.parse(Buffer.from(offer.headers.get("payment-required") || "", "base64").toString() || "{}");
  const accepted = (pr.accepts || []).find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  ok(!!accepted, "the offer names an exact Base accept");
  const now = Math.floor(Date.now() / 1000);
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x1111111111111111111111111111111111111111", to: accepted.payTo, value: accepted.amount, validAfter: String(now - 60), validBefore: String(now + 300), nonce: "0x" + randomBytes(32).toString("hex") } } })).toString("base64");
  // A genuinely signed payment (a fresh nonce each), as a buyer's client sends it.
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const buyer = privateKeyToAccount(generatePrivateKey());
  const signedPayment = async () => {
    const authorization = { from: buyer.address, to: accepted.payTo, value: String(accepted.amount), validAfter: String(now - 60), validBefore: String(now + 300), nonce: "0x" + randomBytes(32).toString("hex") };
    const signature = await buyer.signTypedData({ domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: Number(accepted.network.split(":")[1]), verifyingContract: accepted.asset },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
    return Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted, payload: { signature, authorization } })).toString("base64");
  };
  const paidWith = (payment, country, extra = {}) => fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": payment, ...cdn(country), ...extra }, body: JSON.stringify({ text: "hi" }) });
  const payment = forged;
  const paid = (country, extra = {}) => paidWith(payment, country, extra);

  for (let i = 0; i < 20; i++) await paid("IR");
  await new Promise((r) => setTimeout(r, 100));
  ok((await (await fetch(`${B}/api/gateway-status`)).json()).sanctionsReport?.status === "clear", "forged payments from a blocked region leave the public word clear (nothing reportable recorded)");
  const blocked = await paidWith(await signedPayment(), "IR");
  const bb = await blocked.json().catch(() => ({}));
  ok(blocked.status === 451 && bb.charged === false, `a paid request from Iran through the CDN is answered 451, charged:false (got ${blocked.status})`);
  ok(verifies === 0 && settles === 0, "the blocked payment was never verified or settled");
  const ukr = await paidWith(await signedPayment(), "UA", { "cf-region-code": "43" });
  ok(ukr.status === 451 && verifies === 0, "a paid request from Crimea is answered 451 before verification");

  const control = await paid("US");
  ok(control.status !== 451 && verifies >= 1, `the same payment from an allowed country reaches /verify (live control: ${control.status}, verifies ${verifies})`);
  const before = verifies;
  const noAuth = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": payment, "CF-IPCountry": "IR", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ text: "hi" }) });
  ok(noAuth.status !== 451 && verifies > before, "a CF-IPCountry without the origin secret is ignored (not blocked by a client's own header)");

  ok((await fetch(`${B}/health`, { headers: cdn("KP") })).status === 200, "/health answers from North Korea");
  ok((await fetch(`${B}/terms`, { headers: cdn("KP") })).status === 200, "/terms answers from North Korea");
  ok((await fetch(`${B}/api/pricing`, { headers: cdn("KP") })).status === 451, "a free route is blocked too");

  await new Promise((r) => setTimeout(r, 100));
  const status = await (await fetch(`${B}/api/gateway-status`)).json();
  ok(status.sanctionsReport?.status === "due" && Object.keys(status.sanctionsReport).length === 1, "the public status reads one word: due");
  const opView = await (await fetch(`${B}/__operator/sanctions-events.json`, { headers: { "X-Operator-Token": OP } })).json();
  ok(opView.unfiled.length === 2 && opView.unfiled.every((e) => e.kind === "geo-payment" && e.address?.toLowerCase() === buyer.address.toLowerCase() && e.network === "eip155:8453"), "the operator view holds both verified refused payments in full, naming the signer");
  const byCountry = Object.fromEntries(opView.unfiled.map((e) => [e.country, e.region]));
  ok(byCountry.IR === null && byCountry.UA === "UA-43", `each event keeps the refusal's country or region code (got ${JSON.stringify(byCountry)})`);
  ok(opView.unfiled.every((e) => !JSON.stringify(e).includes("Crimea") && !("city" in e) && !("latitude" in e)), "no other location value is stored with an event");
  ok(opView.geo.refusedWithPayment === 22 && opView.geo.eventsRecorded === 2 && opView.geo.aggregated.unverified === 20, `the operator view counts the refused payments, recorded and aggregated (${JSON.stringify(opView.geo.aggregated)})`);
  const unAgg = opView.recent.filter((e) => e.aggregate && e.kind === "unproven-refusal");
  ok(unAgg.length === 1 && unAgg[0].count === 20 && unAgg[0].address === null, `the 20 forged payments are one aggregate row with their count (${unAgg[0]?.count})`);
  ok((await fetch(`${B}/__operator/sanctions-events.json`)).status === 404, "the events are not readable without the token");
  const filed = await fetch(`${B}/__operator/sanctions-events/filed`, { method: "POST", headers: { "Content-Type": "application/json", "X-Operator-Token": OP }, body: JSON.stringify({ all: true, reference: "RS-TEST-1" }) });
  ok(filed.status === 200 && (await filed.json()).marked === 2, "an operator marks them filed");
  ok((await (await fetch(`${B}/api/gateway-status`)).json()).sanctionsReport.status === "clear", "the word reads clear after filing");
  ok(settles === 0, "nothing was settled in this run");
} finally {
  await srv?.stop();
  facilitator.close();
}
console.log(`\n${pass} passed`);
