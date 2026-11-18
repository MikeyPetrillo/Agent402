#!/usr/bin/env node
// The compact PAYMENT-REQUIRED header (src/payment-required-compact.js).
//
// Every paid route's full header is 8.5 to 10.5 KB; a client whose parser caps
// a header line near 8 KB (aiohttp's default max_line_size is 8190) cannot
// read the 402. A request that sends `X-Payment-Compact: 1`, or whose
// User-Agent names aiohttp, gets a shorter header: the resource, the Bazaar
// extension and the builder-code extension untouched, the Base exact accept first, every other plain exact
// accept that fits, a `compact` field naming the body as the full offer, and
// the body keeps every accept.
//
// Part 1 (offline) pins the shaping on a synthetic offer with every kind of
// accept production carries, and the request test.
// Part 2 boots a PAID server with ten EVM rails, upto on Base, a builder code
// and MPP, and reads every priced route three ways (default, the flag, an
// aiohttp User-Agent): the compact header stays under 7,500 bytes on EVERY
// route (also with the rails a local boot cannot offer projected in), keeps
// the resource and the Bazaar extension byte-for-byte, keeps Base exact first,
// leaves the body's full offer and the MPP challenges as they were, and every
// 402 varies on both request headers. A stock x402 client that asks for the
// compact header pays from it and settles exactly once, and the payment the
// facilitator receives carries the app's builder code.
// Part 3 boots the same server with PAYMENT_REQUIRED_COMPACT=off and requires
// the default request's header to be byte-identical on every route, and no
// text surface to offer the compact header or `paymentRequiredHeader`.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import {
  COMPACT_HEADER_MAX_BYTES, COMPACT_REQUEST_HEADER, COMPACT_REQUEST_EXAMPLE, COMPACT_VARY,
  compactPaymentRequired, mergeVary, paymentRequiredCompactEnabled, smallHeaderLimitText, wantsCompactHeader,
} from "../src/payment-required-compact.js";
import { HEADER_NOTE_KEY, withoutPaymentRequired } from "../src/payment-required-body.js";
import { CORS_DEFAULT_ALLOW_HEADERS } from "../src/cors.js";

let pass = 0, proc = null, facilitator = null;
const serverLog = [];
const fail = (m) => {
  console.error("FAIL:", m);
  if (serverLog.length) { console.error("--- server output (last lines) ---"); for (const l of serverLog.slice(-40)) console.error(l); console.error("--- end server output ---"); }
  proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; if (!m.startsWith("·")) console.log(`ok - ${m}`); } else fail(m.replace(/^·\s*/, "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

// ---------------------------------------------------------------------------
// Part 1: offline
// ---------------------------------------------------------------------------
const evm = (network, name = "USD Coin") => ({ scheme: "exact", network, amount: "10000", asset: "0x" + "a".repeat(40), payTo: "0x" + "b".repeat(40), maxTimeoutSeconds: 300, extra: { name, version: "2" } });
const SCHEMA = { type: "object", properties: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(40) }])) };
const BAZAAR = { info: { input: { type: "http", method: "POST", body: { text: "hello" } }, output: { type: "json", example: { ok: true } } }, schema: SCHEMA };
const FULL = {
  x402Version: 2, error: "Payment required",
  resource: { url: "https://agent402.test/api/hash", description: "d".repeat(400), mimeType: "application/json", serviceName: "Hash", tags: ["a", "b"] },
  accepts: [
    { ...evm("eip155:8453"), outputSchema: { input: { type: "http" }, output: SCHEMA } },
    ...["eip155:137", "eip155:42161", "eip155:143", "eip155:43114", "eip155:1329", "eip155:10", "eip155:4663", "eip155:42220", "eip155:57073", "eip155:5042"].map((n) => evm(n)),
    { ...evm("eip155:8453"), scheme: "upto", extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2", facilitatorAddress: "0x" + "c".repeat(40) } },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "10000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "S".repeat(44), maxTimeoutSeconds: 300, extra: { feePayer: "F".repeat(44) } },
    { scheme: "exact", network: "stellar:pubnet", amount: "100000", asset: "C".repeat(56), payTo: "G".repeat(56), maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } },
    { scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", amount: "10000", asset: "31566704", payTo: "A".repeat(58), maxTimeoutSeconds: 300, extra: { tag: "x402-global-challenge", feePayer: "Z".repeat(58) } },
    { ...evm("eip155:8453"), extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x" + "7".repeat(40) } },
    { ...evm("eip155:5042"), extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x" + "7".repeat(40) } },
  ],
  extensions: { bazaar: BAZAAR, "builder-code": { info: { a: "agent402" }, schema: { type: "object" } }, "payment-identifier": { info: { required: false }, schema: { type: "object" } } },
};
{
  const c = compactPaymentRequired(FULL);
  ok(enc(FULL).length >= COMPACT_HEADER_MAX_BYTES, `U1 the synthetic full offer is over the ceiling (${enc(FULL).length} bytes)`);
  ok(c && c.value.length < COMPACT_HEADER_MAX_BYTES && c.value === enc(c.doc), `U2 the compact header is under ${COMPACT_HEADER_MAX_BYTES} bytes (${c?.value.length})`);
  ok(isDeepStrictEqual(c.doc.accepts[0], FULL.accepts[0]), "U3 the Base exact accept is first and unchanged (its outputSchema kept)");
  ok(c.doc.accepts.every((a) => a.scheme === "exact" && a.extra?.name !== "GatewayWalletBatched"), "U4 upto and Gateway batched accepts are left out");
  // With room for them, upto and batched accepts are still left out.
  const three = { ...FULL, accepts: [FULL.accepts[0], FULL.accepts[11], FULL.accepts[15]] };
  const c3 = compactPaymentRequired(three, enc(three).length - 1);
  ok(c3 && c3.doc.accepts.length === 1 && c3.doc.accepts[0] === FULL.accepts[0] && c3.doc.compact.acceptsOmitted === 2, "U4b upto and batched accepts are left out even when they would fit");
  ok(c.doc.accepts.every((a) => FULL.accepts.includes(a)), "U5 every kept accept is the full offer's own object");
  const order = c.doc.accepts.map((a) => FULL.accepts.indexOf(a));
  ok(order.every((v, i) => i === 0 || v > order[i - 1]), "U6 kept accepts keep the full offer's order");
  ok(c.doc.accepts.length > 1, `U7 other exact accepts that fit are kept (${c.doc.accepts.length})`);
  ok(isDeepStrictEqual(c.doc.resource, FULL.resource) && c.doc.extensions.bazaar === FULL.extensions.bazaar && c.doc.error === FULL.error && c.doc.x402Version === 2, "U8 resource, Bazaar extension, error and version are untouched");
  ok(isDeepStrictEqual(Object.keys(c.doc.extensions), ["bazaar", "builder-code"]) && c.doc.extensions["builder-code"] === FULL.extensions["builder-code"], "U9 the extensions kept are bazaar and builder-code, the builder code unchanged");
  ok(isDeepStrictEqual(c.doc.compact, { acceptsOmitted: FULL.accepts.length - c.doc.accepts.length, extensionsOmitted: ["payment-identifier"], fullOfferIn: "body" }), `U10 the compact field counts what was left out and names the body (${JSON.stringify(c.doc.compact)})`);
  // A ceiling that leaves room for the primary accept only: accepts go, the
  // builder code stays.
  const tight = compactPaymentRequired(FULL, enc({ ...FULL, accepts: [FULL.accepts[0]], extensions: { bazaar: BAZAAR, "builder-code": FULL.extensions["builder-code"] }, compact: { acceptsOmitted: FULL.accepts.length - 1, extensionsOmitted: ["payment-identifier"], fullOfferIn: "body" } }).length + 1);
  ok(tight && tight.doc.accepts.length === 1 && tight.doc.extensions["builder-code"] === FULL.extensions["builder-code"], "U9b under a tight ceiling accepts are dropped from the end and the builder code is kept");
  // Adding any omitted plain exact accept would cross the ceiling.
  const omitted = FULL.accepts.filter((a) => a.scheme === "exact" && a.extra?.name !== "GatewayWalletBatched" && !c.doc.accepts.includes(a));
  ok(omitted.every((a) => enc({ ...c.doc, accepts: [...c.doc.accepts, a], compact: { ...c.doc.compact, acceptsOmitted: c.doc.compact.acceptsOmitted - 1 } }).length >= COMPACT_HEADER_MAX_BYTES), "U11 no omitted exact accept would still fit");
  // The stock client schema reads it.
  const { parsePaymentRequired } = await import("@x402/core/schemas");
  ok(parsePaymentRequired(c.doc).success, "U12 the compact object parses as a v2 PaymentRequired");
  // A full header that fits is not shortened; nothing without a plain exact accept is.
  const small = { ...FULL, accepts: [FULL.accepts[1]], extensions: { bazaar: { info: {} } } };
  ok(compactPaymentRequired(small) === null, "U13 a header that already fits is served as it is");
  ok(compactPaymentRequired({ ...FULL, accepts: FULL.accepts.filter((a) => a.scheme !== "exact" || a.extra?.name === "GatewayWalletBatched") }) === null, "U14 an offer with no plain exact accept is not shortened");
  ok(compactPaymentRequired(null) === null && compactPaymentRequired({ x402Version: 2 }) === null, "U15 a malformed offer is not shortened");
  // No Base accept: the first plain exact one leads.
  const noBase = { ...FULL, accepts: FULL.accepts.filter((a) => a.network !== "eip155:8453") };
  const cb = compactPaymentRequired(noBase, enc(noBase).length - 1);
  ok(cb && cb.doc.accepts[0] === noBase.accepts[0], "U16 without a Base accept, the first plain exact accept leads");
}
{
  const r = (headers) => ({ headers });
  ok(wantsCompactHeader(r({ "x-payment-compact": "1" })) && wantsCompactHeader(r({ "x-payment-compact": "true" })), "U17 the flag asks (1, true)");
  ok(!wantsCompactHeader(r({ "x-payment-compact": "0" })) && !wantsCompactHeader(r({})) && !wantsCompactHeader(undefined), "U18 no flag, or 0, does not ask");
  ok(wantsCompactHeader(r({ "user-agent": "Python/3.12 aiohttp/3.10.5" })), "U19 an aiohttp User-Agent asks");
  ok(!wantsCompactHeader(r({ "user-agent": "python-httpx/0.27.0" })) && !wantsCompactHeader(r({ "user-agent": "node" })) && !wantsCompactHeader(r({ "user-agent": "x402-bazaar-validator" })), "U20 other clients do not ask");
  ok(mergeVary("Origin") === `Origin, ${COMPACT_VARY.join(", ")}` && mergeVary(`user-agent, ${COMPACT_REQUEST_HEADER}`) === `user-agent, ${COMPACT_REQUEST_HEADER}` && mergeVary("*") === "*" && mergeVary(undefined) === COMPACT_VARY.join(", "), "U21 Vary gains each token once and keeps its own");
  ok(CORS_DEFAULT_ALLOW_HEADERS.includes(COMPACT_REQUEST_HEADER), "U22 a browser may send the flag (CORS allow list)");
  ok(COMPACT_REQUEST_EXAMPLE === "X-Payment-Compact: 1", "U23 the documented request is X-Payment-Compact: 1");
  // The writeHead hook is mounted before every other middleware, so it runs
  // after every other reader of the header (the MPP shim mints from the full one).
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = (needle) => src.indexOf(needle);
  const mount = at("app.use(paymentRequiredCompactMiddleware())");
  const appAt = at("const app = express()");
  ok(appAt > 0 && mount > appAt && mount < at("app.use(stripMcpMarker)") && mount < src.indexOf("createMppShim(", appAt), "U25 the compact hook is the first middleware on the app (before the MPP shim)");
  // The text surfaces say the same thing, from the module's own figures.
  const flat = (t) => t.replace(/\s+/g, " ").trim();
  const text = smallHeaderLimitText();
  ok(text.includes(COMPACT_REQUEST_EXAMPLE) && text.includes(COMPACT_HEADER_MAX_BYTES.toLocaleString("en-US")) && !/—/.test(text), "U26 the small-header paragraph names the request and the ceiling");
  ok(flat(readFileSync(new URL("../wiki/Paying-with-x402.md", import.meta.url), "utf8")).includes(flat(text)), "U27 the wiki carries the paragraph word for word");
  const { llmsFullTxt } = await import("../src/seo.js");
  const { howToPayPage } = await import("../src/how-to-pay.js");
  ok(llmsFullTxt("https://agent402.test", {}).includes(text), "U28 /llms-full.txt carries the paragraph");
  ok(howToPayPage("https://agent402.test", {}, { networks: [] }).includes("X-Payment-Compact: 1"), "U29 /how-to-pay carries the paragraph");
  // The switch: every text surface reads the one server.js mounts on.
  ok(paymentRequiredCompactEnabled({}) && !paymentRequiredCompactEnabled({ PAYMENT_REQUIRED_COMPACT: "off" }) && !paymentRequiredCompactEnabled({ PAYMENT_REQUIRED_BODY: "off" }), "U30 the compact header is on by default, off with either switch off");
  ok(/const PAYMENT_REQUIRED_COMPACT_ON = paymentRequiredCompactEnabled\(\);/.test(src), "U31 server.js mounts on the same switch the text surfaces read");
  const { x402TestPage } = await import("../src/x402-test-page.js");
  const onPages = [llmsFullTxt("https://agent402.test", {}), howToPayPage("https://agent402.test", {}, { networks: [] }), x402TestPage("https://agent402.test")];
  ok(onPages.every((t) => t.includes("X-Payment-Compact") && t.includes("paymentRequiredHeader")), "U32 with the switch on, /llms-full.txt, /how-to-pay and /x402-test offer the compact header");
  for (const [k, v] of [["PAYMENT_REQUIRED_COMPACT", "off"], ["PAYMENT_REQUIRED_BODY", "off"]]) {
    const prev = process.env[k];
    process.env[k] = v;
    try {
      const offPages = [llmsFullTxt("https://agent402.test", {}), howToPayPage("https://agent402.test", {}, { networks: [] }), x402TestPage("https://agent402.test")];
      ok(offPages.every((t) => !t.includes("X-Payment-Compact") && !t.includes("paymentRequiredHeader")), `U33 with ${k}=off no text surface offers the compact header or paymentRequiredHeader`);
      ok(offPages.slice(0, 2).every((t) => t.includes(smallHeaderLimitText(false)) || t.includes("max_line_size=32768")), `U34 with ${k}=off /llms-full.txt and /how-to-pay still say how to raise the limit`);
    } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; }
  }
  ok(!smallHeaderLimitText(false).includes("X-Payment-Compact") && smallHeaderLimitText(false).includes("max_line_size=32768"), "U35 the off paragraph offers only the raised limit");
  const relayed = withoutPaymentRequired({ x402Version: 2, accepts: [], hint: "h", [HEADER_NOTE_KEY]: { bytes: 1 } });
  ok(!(HEADER_NOTE_KEY in relayed) && relayed.hint === "h", "U24 a relayed refusal drops the header note with the offer");
}

// ---------------------------------------------------------------------------
// Part 2: a booted paid server, every route
// ---------------------------------------------------------------------------
const [PORT, FAC_PORT] = await getFreePorts(2);
const EVM_KINDS = ["eip155:8453", "eip155:137", "eip155:42161", "eip155:143", "eip155:42220", "eip155:43114", "eip155:1329", "eip155:10", "eip155:57073", "eip155:4663"];
const NON_EVM_KINDS = [
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } },
  { x402Version: 2, scheme: "exact", network: "stellar:pubnet", extra: { areFeesSponsored: true } },
  { x402Version: 2, scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", extra: { feePayer: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ" } },
];
const fac = { verify: 0, settle: 0, accepted: [] };
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch { /* not json */ }
    const payer = parsed?.paymentPayload?.payload?.authorization?.from || "0x00000000000000000000000000000000000000a1";
    if (req.url === "/supported") return reply(200, { kinds: [...EVM_KINDS.map((network) => ({ x402Version: 2, scheme: "exact", network })), { x402Version: 2, scheme: "upto", network: "eip155:8453" }, ...NON_EVM_KINDS], extensions: [], signers: {} });
    if (req.url === "/verify") { fac.verify++; fac.accepted.push(parsed?.paymentPayload); return reply(200, { isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: parsed?.paymentRequirements?.network || "eip155:8453", payer }); }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const F = `http://127.0.0.1:${FAC_PORT}`;
const BASE_URL = "https://agent402.test";
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 120) serverLog.splice(0, serverLog.length - 120); };
const bootServer = (port, label, extraEnv = {}) => {
  const env = { ...process.env };
  for (const k of ["TARGET_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY", "NETWORK_PRICE_FLOORS", "NETWORK_PRICE_PREMIUMS", "MPP_CHALLENGE_NETWORKS", "ACCEPT_OUTPUT_SCHEMA", "TEMPO_API_KEY", "CIRCLE_FACILITATOR_API_KEY", "PAYMENT_REQUIRED_BODY", "PAYMENT_REQUIRED_COMPACT"]) delete env[k];
  const child = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], {
    env: {
      ...env, ...ownStoreEnv(label), PORT: String(port), FREE_MODE: "", NODE_ENV: "test", BASE_URL, RAILS_TEST_GRADUATE: "ink",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      PAYMENT_NETWORKS: "base,polygon,arbitrum,monad,celo,avalanche,sei,optimism,ink,robinhood,solana,stellar,algorand", X402_UPTO_NETWORKS: "eip155:8453",
      CELO_FACILITATOR_KEY: "compact-placeholder", SOLVADOR_KEY: "compact-placeholder", SOLVADOR_FACILITATOR_URL: F,
      SOLANA_WALLET_ADDRESS: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", STELLAR_WALLET_ADDRESS: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      STELLAR_FACILITATOR_URL: F, STELLAR_FACILITATOR_KEY: "compact-placeholder", ALGORAND_WALLET_ADDRESS: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", ALGORAND_FACILITATOR_URL: F,
      FACILITATOR_URL: F, PAYAI_FACILITATOR_URL: F, INK_FACILITATOR_URL: F, CELO_FACILITATOR_URL: F, MONAD_FACILITATOR_URL: F, ROBINHOOD_FACILITATOR_URL: F, AGENT402_BASE_RPC: `${F}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "compact-header-test-secret", FACILITATOR_GAS_CHECK: "off",
      BASE_BUILDER_CODE: "agent402",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
      // Routes production serves behind a key: placeholder keys mount them so
      // every priced route answers its 402. Only the unpaid 402 is read.
      X_BEARER_TOKEN: "compact-placeholder", NEYNAR_API_KEY: "compact-placeholder", EXA_API_KEY: "compact-placeholder", TYPESAFE_API_KEY: "compact-placeholder", RUGCHECK_TOOLS: "on", OPENROUTER_TTS_ENABLED: "true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", keepLog); child.stderr.on("data", keepLog);
  return child;
};
const waitUp = async (base) => {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* booting */ } await sleep(500); }
  return false;
};

const GW = JSON.stringify({ model: "openai/gpt-5", max_tokens: 300, messages: [{ role: "user", content: "Reply with the single word: settled" }] });
const UA_DEFAULT = "agent402-compact-test/1.0";
const UA_AIOHTTP = "Python/3.12 aiohttp/3.10.5";
/** Every priced route's 402, read with the given extra headers. */
async function readAll(base, endpoints, headers) {
  const out = new Map();
  const q = endpoints.map((e, i) => [e, i]);
  const worker = async () => {
    while (q.length) {
      const [e] = q.shift();
      const m = e.method || "GET";
      const init = { method: m, headers: { "user-agent": UA_DEFAULT, ...(m === "POST" ? { "content-type": "application/json" } : {}), ...headers } };
      if (m === "POST") init.body = /^\/v1\//.test(e.path) ? GW : "{}";
      const r = await fetch(`${base}${e.path}`, init);
      const text = await r.text();
      out.set(`${m} ${e.path}#${e.slug}`, { status: r.status, header: r.headers.get("payment-required"), vary: r.headers.get("vary") || "", www: r.headers.get("www-authenticate"), text });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

// The MPP challenges with each one's signed id and expiry removed (both are
// minted per request); what is left is the terms each challenge offers.
const challengeTerms = (www) => String(www || "").replace(/\b(id|expires)="[^"]*"/g, "");
const sameChallenges = (a, b) => typeof a === "string" && a.length > 0 && challengeTerms(a) === challengeTerms(b);

// Rails production offers that a local boot does not (Solana, Stellar,
// Algorand, Arc, both Gateway batched accepts), cloned in at the route's price.
function projected(doc) {
  const base = doc.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  if (!base) return doc;
  const { outputSchema: _drop, ...b } = base;
  const add = [
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: b.amount, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "S".repeat(44), maxTimeoutSeconds: 300, extra: { feePayer: "F".repeat(44), transactionVersions: [0, 1] } },
    { scheme: "exact", network: "stellar:pubnet", amount: b.amount + "0", asset: "C".repeat(56), payTo: "G".repeat(56), maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } },
    { scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", amount: b.amount, asset: "31566704", payTo: "A".repeat(58), maxTimeoutSeconds: 300, extra: { tag: "x402-global-challenge", feePayer: "Z".repeat(58) } },
    { ...b, network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", extra: { name: "USDC", version: "2" } },
    { ...b, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x" + "7".repeat(40) } },
    { ...b, network: "eip155:5042", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x" + "7".repeat(40) } },
  ].filter((a) => !doc.accepts.some((x) => x.network === a.network && x.extra?.name === a.extra?.name));
  return { ...doc, accepts: [...doc.accepts, ...add] };
}

try {
  proc = bootServer(PORT, "compact-on");
  const B = `http://127.0.0.1:${PORT}`;
  ok(await waitUp(B), "B0 the paid server booted");
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const endpoints = pricing.endpoints || [];
  const [def, flag, aio] = [await readAll(B, endpoints, {}), await readAll(B, endpoints, { [COMPACT_REQUEST_HEADER]: "1" }), await readAll(B, endpoints, { "user-agent": UA_AIOHTTP })];
  let routes = 0, fullMax = 0;
  const sizes = [], projSizes = [];
  for (const [key, d] of def) {
    if (d.status !== 402 || !d.header) continue;
    routes++;
    fullMax = Math.max(fullMax, d.header.length);
    const full = dec(d.header);
    const body = JSON.parse(d.text);
    ok(isDeepStrictEqual(body.accepts, full.accepts) && isDeepStrictEqual(body.extensions, full.extensions), `· ${key}: the default body mirrors the full header`);
    ok(body[HEADER_NOTE_KEY]?.bytes === d.header.length && body[HEADER_NOTE_KEY]?.compact === false && body[HEADER_NOTE_KEY]?.compactRequest === COMPACT_REQUEST_EXAMPLE, `· ${key}: the default body states the header's size and how to ask for the compact one`);
    for (const [label, got] of [["flag", flag.get(key)], ["aiohttp", aio.get(key)]]) {
      ok(got && got.status === 402 && typeof got.header === "string", `· ${key} (${label}): a 402 with a header`);
      ok(got.header.length < COMPACT_HEADER_MAX_BYTES, `· ${key} (${label}): the header is ${got.header.length} bytes (ceiling ${COMPACT_HEADER_MAX_BYTES})`);
      const c = dec(got.header);
      const gotBody = JSON.parse(got.text);
      ok(isDeepStrictEqual(c.resource, full.resource) && isDeepStrictEqual(c.extensions?.bazaar, full.extensions?.bazaar), `· ${key} (${label}): resource and Bazaar extension untouched`);
      ok(full.extensions?.["builder-code"] && isDeepStrictEqual(c.extensions?.["builder-code"], full.extensions["builder-code"]), `· ${key} (${label}): builder-code extension untouched`);
      if (d.header.length >= COMPACT_HEADER_MAX_BYTES) {
        ok(c.accepts[0].scheme === "exact" && c.accepts[0].network === "eip155:8453" && isDeepStrictEqual(c.accepts[0], full.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453")), `· ${key} (${label}): Base exact first, unchanged`);
        ok(c.accepts.every((a) => full.accepts.some((x) => isDeepStrictEqual(x, a))), `· ${key} (${label}): every kept accept is one of the full offer's`);
        ok(c.compact?.fullOfferIn === "body" && c.compact.acceptsOmitted === full.accepts.length - c.accepts.length, `· ${key} (${label}): the compact field names the body`);
        ok(gotBody[HEADER_NOTE_KEY]?.compact === true && gotBody[HEADER_NOTE_KEY].bytes === got.header.length && gotBody[HEADER_NOTE_KEY].acceptsInBody === full.accepts.length, `· ${key} (${label}): the body note reports the compact header`);
      } else {
        ok(got.header === d.header, `· ${key} (${label}): a header that fits is served as it is`);
      }
      ok(isDeepStrictEqual(gotBody.accepts, full.accepts) && isDeepStrictEqual(gotBody.extensions, full.extensions) && isDeepStrictEqual(gotBody.resource, full.resource), `· ${key} (${label}): the body keeps the full offer`);
      ok(sameChallenges(got.www, d.www), `· ${key} (${label}): the MPP challenges are the same as the default request's`);
      sizes.push(got.header.length);
    }
    for (const v of [d.vary, flag.get(key).vary, aio.get(key).vary]) {
      const toks = v.split(",").map((s) => s.trim().toLowerCase());
      ok(COMPACT_VARY.every((t) => toks.includes(t.toLowerCase())), `· ${key}: the 402 varies on ${COMPACT_VARY.join(" and ")} (got "${v}")`);
    }
    // Production's other rails projected in: the compact header still fits.
    const p = compactPaymentRequired(projected(full));
    const pBytes = p ? p.value.length : enc(projected(full)).length;
    ok(pBytes < COMPACT_HEADER_MAX_BYTES, `· ${key}: with every production rail projected in, the compact header is ${pBytes} bytes`);
    ok(!p || isDeepStrictEqual(p.doc.extensions?.["builder-code"], full.extensions["builder-code"]), `· ${key}: with every production rail projected in, the builder code is kept`);
    projSizes.push(pBytes);
  }
  ok(routes >= 400, `B1 ${routes} priced routes answered 402 with a header (full header up to ${fullMax} bytes)`);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`ok - B2 compact header on every route: max ${Math.max(...sizes)}, median ${med(sizes)} bytes; with production rails projected: max ${Math.max(...projSizes)}, median ${med(projSizes)}`);
  ok(Math.max(...sizes) < COMPACT_HEADER_MAX_BYTES && Math.max(...projSizes) < COMPACT_HEADER_MAX_BYTES, "B3 the ceiling holds on every route");
  ok(fullMax >= COMPACT_HEADER_MAX_BYTES, `B4 control: the default header is over the ceiling somewhere (${fullMax}), so the compact one is exercised`);

  // B5 a stock x402 client that asks for the compact header pays from it.
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);
  for (const [label, extra] of [["flag", { [COMPACT_REQUEST_HEADER]: "1" }], ["aiohttp", { "user-agent": UA_AIOHTTP }]]) {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const asking = (input, init = {}) => {
      const h = new Headers(input instanceof Request ? input.headers : init.headers);
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
      return input instanceof Request ? fetch(new Request(input, { headers: h })) : fetch(input, { ...init, headers: h });
    };
    const ask = await asking(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "compact" }) });
    const offered = dec(ask.headers.get("payment-required"));
    await ask.text();
    ok(offered.compact?.fullOfferIn === "body", `B5 ${label}: POST /api/hash offers the compact header`);
    const v = fac.verify, s = fac.settle;
    const r = await wrapFetchWithPayment(asking, client)(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "compact" }) });
    const out = await r.json().catch(() => ({}));
    ok(r.status === 200 && Object.keys(out).length > 0, `B6 ${label}: a stock x402 client pays from the compact header (got ${r.status})`);
    ok(fac.verify === v + 1 && fac.settle === s + 1, `B7 ${label}: exactly one verify and one settle (${fac.verify - v}/${fac.settle - s})`);
    const sent = fac.accepted.at(-1);
    ok(isDeepStrictEqual(sent?.accepted, offered.accepts[0]) && sent.accepted.network === "eip155:8453", `B8 ${label}: the payment names the compact header's Base exact accept`);
    ok(isDeepStrictEqual(sent?.resource, offered.resource), `B9 ${label}: the payment carries the resource the facilitator indexes`);
    ok(!!r.headers.get("payment-response"), `B10 ${label}: the answer carries its receipt`);
    ok(offered.extensions?.["builder-code"]?.info?.a === "agent402" && sent?.extensions?.["builder-code"]?.info?.a === "agent402", `B11 ${label}: the compact header offers the builder code and the payment the facilitator receives carries it (${JSON.stringify(sent?.extensions?.["builder-code"]?.info)})`);
  }

  // Control for P2: the same pages on this server offer the compact header.
  for (const path of ["/llms-full.txt", "/how-to-pay", "/x402-test"]) {
    const t = await (await fetch(`${B}${path}`)).text();
    ok(t.includes("X-Payment-Compact") && t.includes("paymentRequiredHeader"), `B12 ${path} with the option on offers the compact header and paymentRequiredHeader`);
  }

  // Part 3: the default request's header is byte-identical with the option off.
  proc.kill("SIGKILL");
  await new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", r)));
  const [OFF_PORT] = await getFreePorts(1);
  const OFF_B = `http://127.0.0.1:${OFF_PORT}`;
  proc = bootServer(OFF_PORT, "compact-off", { PAYMENT_REQUIRED_COMPACT: "off" });
  ok(await waitUp(OFF_B), "P0 the PAYMENT_REQUIRED_COMPACT=off server booted");
  const off = await readAll(OFF_B, endpoints, {});
  const offFlag = await readAll(OFF_B, endpoints, { [COMPACT_REQUEST_HEADER]: "1" });
  let same = 0;
  for (const [key, d] of def) {
    if (d.status !== 402 || !d.header) continue;
    const o = off.get(key);
    ok(o && o.header === d.header, `· ${key}: the default header is byte-identical with the option off (${d.header.length} vs ${o?.header?.length})`);
    ok(offFlag.get(key)?.header === d.header, `· ${key}: with the option off, the flag changes nothing`);
    same++;
  }
  ok(same === routes, `P1 the default PAYMENT-REQUIRED header is byte-identical on all ${same} routes`);
  for (const path of ["/llms-full.txt", "/how-to-pay", "/x402-test"]) {
    const t = await (await fetch(`${OFF_B}${path}`)).text();
    ok(t.length > 1000 && !t.includes("X-Payment-Compact") && !t.includes("paymentRequiredHeader"), `P2 ${path} with the option off offers neither the compact header nor paymentRequiredHeader`);
  }
  const offBody = JSON.parse(off.get([...off.keys()].find((k) => off.get(k).status === 402)).text);
  ok(!(HEADER_NOTE_KEY in offBody), "P3 with the option off the 402 body carries no paymentRequiredHeader");

  console.log(`\nPASS - ${pass} checks (the compact PAYMENT-REQUIRED header)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
