#!/usr/bin/env node
// The referral gate (src/referral-gate.js, src/referral-settle.js): copies of
// paid routes under /ref/<slug> whose 402 pays a referral network's split
// contract and which settle through that network's facilitator.
//
//   node scripts/test-referral-gate.js
//
// Part 1 runs the gate in this process against stub tools and a stub
// facilitator: the 402's exact shape, the local money checks, one run per
// authorization, handler-first settlement, the signed facilitator request,
// and the net booking in the sales ledger. Part 2 boots the real server in
// paid mode twice (switches unset, then set) and reads the same amounts off
// the direct routes' own 402s, the discovery surfaces and the log. No payment
// leaves this machine: every key is made here and both facilitators are local.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express from "express";
import { recoverMessageAddress, keccak256, concat, stringToHex, numberToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootPaidServer } from "./lib/paid-boot.js";

const tmp = mkdtempSync(join(tmpdir(), "a402-referral-"));
process.env.SALES_LEDGER_DB = join(tmp, "sales.db");
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const gateMod = await import("../src/referral-gate.js");
const { referralConfig, referralConfigProblem, referralRoutes, referralIneligibility, referralSlugOfPath, createReferralGate, referralNet, baseUnitsOf, checkReferralPayment, parseCommissionBps, commissionBpsFor, REFERRAL_ASSET, REFERRAL_NETWORK } = gateMod;
const { createReferralSettler, referralRequestDigest } = await import("../src/referral-settle.js");
const { createReplayGuard } = await import("../src/replay-guard.js");
const { recordSale, saleByTx } = await import("../src/sales-ledger.js");
const { priceForNetwork } = await import("../src/payments.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- keys made here, never funded ---------------------------------------------
const SIGNER_KEY = generatePrivateKey();
const signer = privateKeyToAccount(SIGNER_KEY);
const buyer = privateKeyToAccount(generatePrivateKey());
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address; // stands in for the split contract
const OUR_WALLET = "0x000000000000000000000000000000000000dEaD";
const KEY_HEX = SIGNER_KEY.slice(2).toLowerCase();

// --- a stub facilitator ---------------------------------------------------------
// Records every request with the exact bytes it received and the address its
// signature recovers to over keccak256(body || uint64_be(timestamp)).
function stubFacilitator() {
  const calls = [];
  const mode = { verify: () => ({ status: 200, body: { isValid: true } }), settle: null, settleDelayMs: 0 };
  let txSeq = 0;
  const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
  mode.settle = () => ({ status: 200, body: { success: true, transaction: nextTx(), network: REFERRAL_NETWORK } });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const call = { path: req.url, raw, signature: req.headers["x-agent-signature"] || null, timestamp: req.headers["x-agent-timestamp"] || null, recovered: null, json: null };
      try { call.json = JSON.parse(raw); } catch { /* asserted by the caller */ }
      if (call.signature && call.timestamp) {
        try {
          const digest = keccak256(concat([stringToHex(raw), numberToHex(Number(call.timestamp), { size: 8 })]));
          call.recovered = await recoverMessageAddress({ message: { raw: digest }, signature: call.signature });
        } catch { call.recovered = null; }
      }
      calls.push(call);
      const pick = req.url === "/verify" ? mode.verify : req.url === "/settle" ? mode.settle : null;
      if (!pick) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.url === "/settle" && mode.settleDelayMs) await wait(mode.settleDelayMs);
      const out = pick(call);
      if (out.hang) return; // never answers
      res.writeHead(out.status, { "content-type": out.type || "application/json" });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, mode,
    of: (path) => calls.filter((c) => c.path === path),
    reset: () => { calls.length = 0; mode.verify = () => ({ status: 200, body: { isValid: true } }); mode.settle = () => ({ status: 200, body: { success: true, transaction: nextTx(), network: REFERRAL_NETWORK } }); mode.settleDelayMs = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

// --- a buyer -------------------------------------------------------------------
const RECEIVE_TYPES = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const TRANSFER_TYPES = { TransferWithAuthorization: RECEIVE_TYPES.ReceiveWithAuthorization };
let nonceSeq = 0;
const freshNonce = () => keccak256(stringToHex(`referral-test-nonce-${process.pid}-${++nonceSeq}-${Math.random()}`));
async function signPayment(accept, { account = buyer, to = accept.payTo, value = accept.amount, validAfter = "0", validBefore = String(Math.floor(Date.now() / 1000) + 60), nonce = freshNonce(), primaryType = "ReceiveWithAuthorization" } = {}) {
  const authorization = { from: account.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce };
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: REFERRAL_ASSET },
    types: primaryType === "ReceiveWithAuthorization" ? RECEIVE_TYPES : TRANSFER_TYPES,
    primaryType,
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
  });
  const payload = { x402Version: 2, accepted: accept, payload: { signature, authorization } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64url"), authorization };
}
const call = async (url, { method = "POST", body, headers = {} } = {}) => {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
  return { status: r.status, headers: r.headers, text, json };
};

// ===============================================================================
// Part 1: the modules, in this process
// ===============================================================================
const fac = await stubFacilitator();
const ENV = {
  REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY,
  REFERRAL_SLUGS: "echo, slow,boom,bytes,list,owntx,chat,busy", REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
  REFERRAL_COMMISSION_BPS: "default:1000,busy:1500,chat:1000", REFERRAL_FEE_BPS: "0",
  REFERRAL_DEADLINE_MS: "1000", REFERRAL_SETTLE_RESERVE_MS: "1000", REFERRAL_SETTLE_MS: "2000", REFERRAL_VERIFY_MS: "2000",
};

// --- configuration ---------------------------------------------------------------
{
  ok(referralConfig({}) === null && referralConfigProblem({}) === null, "no REFERRAL_* variable: off, and nothing to warn about");
  for (const name of ["REFERRAL_PAY_TO", "REFERRAL_FACILITATOR_URL", "REFERRAL_SIGNER_KEY", "REFERRAL_SLUGS", "REFERRAL_SETUP_URL"]) {
    const e = { ...ENV }; delete e[name];
    const why = referralConfigProblem(e);
    ok(referralConfig(e) === null && typeof why === "string" && why.includes(name) && !why.includes(KEY_HEX), `without ${name} the gate is off and the warning names it (no value printed)`);
  }
  ok(referralConfig({ ...ENV, REFERRAL_PAY_TO: "0x1234" }) === null, "a malformed pay-to address: off");
  ok(referralConfig({ ...ENV, REFERRAL_FACILITATOR_URL: "http://facilitator.example" }) === null, "a plain-http facilitator on a public host: off");
  ok(referralConfig({ ...ENV, REFERRAL_FACILITATOR_URL: "https://user:pw@facilitator.example" }) === null, "a facilitator URL with credentials: off");
  ok(referralConfig({ ...ENV, REFERRAL_SIGNER_KEY: "0xabc" }) === null, "a signer key that is not 32 bytes: off");
  ok(referralConfig({ ...ENV, REFERRAL_SLUGS: "ok,Bad Slug!" }) === null, "a slug list with a malformed entry: off");
  ok(referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "9000", REFERRAL_FEE_BPS: "2000" }) === null, "commission plus fee past 10000 bps: off");
  const d = referralConfig({ ...ENV, REFERRAL_DEADLINE_MS: "", REFERRAL_SETTLE_RESERVE_MS: "", REFERRAL_SETTLE_MS: "", REFERRAL_VERIFY_MS: "", REFERRAL_COMMISSION_BPS: "" });
  ok(d && d.deadlineMs === 45_000 && d.settleMs === 30_000 && d.verifyMs === 10_000 && d.settleReserveMs === 10_000 && d.verify === true && d.verifySigned === true && d.commission.default === 1000 && Object.keys(d.commission.bySlug).length === 0 && d.feeBps === 0, "defaults: 45 s handler, 30 s settle, 10 s verify, 10 s reserve, verify on and signed, 1000 bps commission, 0 fee");
  ok(referralConfig({ ...ENV, REFERRAL_VERIFY: "off" }).verify === false && referralConfig({ ...ENV, REFERRAL_VERIFY_SIGNED: "OFF" }).verifySigned === false, "REFERRAL_VERIFY=off and REFERRAL_VERIFY_SIGNED=off are read");
  ok(referralConfig({ ...ENV, REFERRAL_DEADLINE_MS: "abc" }).deadlineMs === 45_000, "a malformed timing knob reads as its default");
  const m = referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "default:1000, v1-chat-auto:1500,V1-Chat-Pro:2000" });
  ok(m && commissionBpsFor(m, "v1-chat-auto") === 1500 && commissionBpsFor(m, "v1-chat-pro") === 2000 && commissionBpsFor(m, "onchain-sql") === 1000, "the commission map is read per slug, and a slug it does not name reads the default");
  ok(commissionBpsFor(referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "echo:500" }), "other") === 1000 && commissionBpsFor(referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "750" }), "other") === 750 && commissionBpsFor(referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "default:0" }), "other") === 0, "the default is 1000 when the map gives none; a bare number or default: sets it");
  for (const bad of ["-5", "default:abc", "echo:10001", "echo", "echo:5,echo:6", "Bad Slug:5", "default:1000;echo:5"]) {
    if (referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: bad }) !== null || parseCommissionBps(bad) !== null) ok(false, `a malformed commission map (${bad}) should leave the gate off`);
  }
  ok(true, "a malformed commission map leaves the gate off (never a guessed rate)");
  ok(referralConfig({ ...ENV, REFERRAL_COMMISSION_BPS: "default:1000,echo:9000", REFERRAL_FEE_BPS: "2000" }) === null, "one slug's commission plus the fee past 10000 bps: off");
}

// --- money arithmetic ----------------------------------------------------------
{
  ok(baseUnitsOf("$0.03") === 30000n && baseUnitsOf("$0.030") === 30000n && baseUnitsOf("$1") === 1000000n && baseUnitsOf("$0.000001") === 1n, "dollars to USDC base units, exact");
  ok(baseUnitsOf("$0.0000001") === null && baseUnitsOf("0.03") === null && baseUnitsOf("$0") === null && baseUnitsOf("$NaN") === null, "a price that is not a positive six-decimal dollar amount has no base units");
  const n = referralNet("30000", { commissionBps: 1000, feeBps: 0 });
  ok(n.grossUsd === 0.03 && n.netUsd === 0.027, `net of a $0.03 sale at 1000 bps is $0.027 (${n.netUsd})`);
  const f = referralNet("30000", { commissionBps: 1000, feeBps: 300 });
  ok(f.netUnits === 26100n, `commission and fee both come off the gross (${f.netUnits})`);
  const tiny = referralNet("5", { commissionBps: 1000, feeBps: 300 });
  ok(tiny.netUnits === 5n, "a leg that rounds to zero is not taken: the remainder stays in net");
  ok(referralNet("30000", { commissionBps: 0, feeBps: 0 }).netUnits === 30000n && referralNet("30000", { commissionBps: 10_000, feeBps: 0 }).netUnits === 0n, "0 bps keeps the gross; 10000 bps leaves nothing");
}

// --- boot checks -----------------------------------------------------------------
{
  const h = async () => ({});
  const catalog = {
    "POST /a": { slug: "fine", price: "$0.03", handler: h },
    "POST /b": { slug: "ident", price: "$0.01", handler: h },
    "POST /c": { slug: "lasting", price: "$0.01", handler: h },
    "POST /d": { slug: "seller", price: "$0.01", handler: h },
    "POST /e": { slug: "long", price: "$0.01", handler: h },
    "POST /f": { slug: "binary", price: "$0.01", handler: h, mimeType: "image/png" },
    "POST /g": { slug: "slowimg", price: "$0.03", handler: h },
    "POST /h": { slug: "free", price: "$0", handler: h },
    "POST /i": { slug: "dust", price: "$0.0000001", handler: h },
  };
  const cfg = { slugs: ["fine", "ident", "lasting", "seller", "long", "binary", "slowimg", "free", "dust", "missing"], deadlineMs: 45_000 };
  const { defs, refused } = referralRoutes(cfg, catalog, (def) => ({ identityBound: def.slug === "ident", lastingEffect: def.slug === "lasting", paysThirdParty: def.slug === "seller", longRunning: def.slug === "long", runBoundMs: def.slug === "slowimg" ? 60_000 : null }));
  ok(defs.size === 1 && defs.has("fine"), `only the eligible slug is served (${[...defs.keys()].join(",")})`);
  const why = Object.fromEntries(refused.map((r) => [r.slug, r.reason]));
  ok(/identity/.test(why.ident) && /outlives/.test(why.lasting) && /outside seller/.test(why.seller) && /long-running/.test(why.long) && /bytes/.test(why.binary) && /upstream wait \(60 s\)/.test(why.slowimg) && /no list price/.test(why.free) && /base units/.test(why.dust) && /not in the catalog/.test(why.missing), "each refused slug carries its reason (identity-bound, lasting effect, outside seller, long-running, binary, upstream wait past the deadline, no price, sub-unit price, missing)");
  ok(referralIneligibility(catalog["POST /g"], { runBoundMs: 60_000, deadlineMs: 60_000 }) === null, "an upstream wait that fits a raised deadline is eligible");
  ok(referralSlugOfPath("/ref/hash") === "hash" && referralSlugOfPath("/REF/Hash/") === "hash" && referralSlugOfPath("/ref/%68ash") === "hash" && referralSlugOfPath("/ref/") === null && referralSlugOfPath("/ref/a/b") === null && referralSlugOfPath("/api/hash") === null && referralSlugOfPath("/ref/" + "a".repeat(500)) === null, "the slug of a /ref path, spelled the ways the router resolves it");
}

// --- the gate, mounted on a small app --------------------------------------------
const runs = { echo: 0, slow: 0, boom: 0, busy: 0 };
const seen = { chat: null };
const TOOLS = {
  echo: { slug: "echo", name: "Echo", category: "test", price: "$0.03", handler: async (i) => { runs.echo++; return { echo: i.text ?? null, run: runs.echo }; } },
  busy: { slug: "busy", name: "Busy", category: "test", price: "$0.03", handler: async (i) => { runs.busy++; await wait(300); return { echo: i.text ?? null }; } },
  slow: { slug: "slow", name: "Slow", category: "test", price: "$0.03", handler: async () => { runs.slow++; await wait(2500); return { late: true }; } },
  boom: { slug: "boom", name: "Boom", category: "test", price: "$0.03", handler: async () => { runs.boom++; throw Object.assign(new Error("that input cannot be served"), { statusCode: 422 }); } },
  bytes: { slug: "bytes", name: "Bytes", category: "test", price: "$0.03", handler: async () => ({ __binary: Buffer.from("png"), contentType: "image/png" }) },
  list: { slug: "list", name: "List", category: "test", price: "$0.03", handler: async () => [1, 2, 3] },
  owntx: { slug: "owntx", name: "Own", category: "test", price: "$0.03", handler: async () => ({ transaction: "the tool's own field", rows: 1 }) },
  chat: { slug: "chat", name: "Chat", category: "llm", price: "$0.001", quote: (b) => 0.001 * (Number(b?.max_tokens) || 1), handler: async (i, req) => { seen.chat = { stream: i.stream, hasOptions: "stream_options" in i, stash: req.__meteredQuoteUsd }; return { id: "c1", choices: [] }; } },
};
const logLines = [];
const log = { log: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)) };
const sales = [];
const responses = [];
// The server's own per-request price rule (quotedPriceUsd), restated for the stub tools.
const priceUsdOf = (def, req) => {
  const flat = Number(String(def.price).replace(/[^0-9.]/g, ""));
  if (typeof def.quote !== "function") return flat;
  const q = Number(def.quote(req.__handlerInput || req.body || {}));
  if (Number.isFinite(q) && q > 0) { req.__meteredQuoteUsd = q; return q; }
  return flat;
};
function mount(envOverride = {}) {
  const config = referralConfig({ ...ENV, ...envOverride });
  const { defs } = referralRoutes(config, Object.fromEntries(Object.values(TOOLS).map((d) => [`POST /${d.slug}`, d])), () => ({}));
  const gate = createReferralGate({
    config, defs, replayGuard: createReplayGuard(), baseUrl: "https://shop.example",
    settler: createReferralSettler({ facilitatorUrl: config.facilitatorUrl, signerKey: config.signerKey, verifyTimeoutMs: config.verifyMs, settleTimeoutMs: config.settleMs, signVerify: config.verifySigned }),
    priceUsdOf, priceForNetwork,
    preValidate: (def, req) => (def.slug === "echo" && req.body && req.body.text === undefined && req.method === "POST" && req.body.require ? { status: 400, body: { error: "Missing required parameter: text", tool: def.slug } } : null),
    sendToolError: (res, err, slug) => res.status(err?.statusCode || 502).json({ error: String(err?.message || "request failed"), tool: slug }),
    recordSale: (row) => { sales.push(row); return recordSale(row); },
    log,
  });
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.all("/ref/:slug", (req, res) => gate.handler(req, res));
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve) => server.on("listening", () => resolve({ gate, config, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}
const app1 = await mount();
const R = (slug) => `${app1.url}/ref/${slug}`;
const send = async (url, opts) => { const r = await call(url, opts); responses.push(r.text); return r; };

try {
  // --- the unpaid 402 ------------------------------------------------------------
  const TOKEN = '{"v":1,"reviewer":"r-77","sig":"AbC+/=="}  ;, é';
  const bare = await send(R("echo"), { method: "GET", headers: { "x-referrer-token": TOKEN, "x-referrer-buyer-agent-id": "4711" } });
  const accept = bare.json?.accepts?.[0];
  ok(bare.status === 402, `an unpaid GET of a POST tool answers 402 (${bare.status})`);
  ok(JSON.stringify(Object.keys(bare.json || {})) === JSON.stringify(["x402Version", "resource", "accepts", "extensions"]) && bare.json.x402Version === 2, `the 402 body is x402Version, resource, accepts, extensions and nothing else (${Object.keys(bare.json || {}).join(",")})`);
  ok(JSON.stringify(bare.json?.resource) === JSON.stringify({ url: "https://shop.example/ref/echo", description: "Echo", mimeType: "application/json" }), "resource carries url, description and mimeType");
  ok(Array.isArray(bare.json?.accepts) && bare.json.accepts.length === 1 && JSON.stringify(accept) === JSON.stringify({
    scheme: "exact", network: "eip155:8453", asset: REFERRAL_ASSET, amount: "30000", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2", authorizationType: "ReceiveWithAuthorization", facilitatorUrl: fac.url, endpoint: "/ref/echo" },
  }), `the one accept is exact on Base USDC to the split contract, with the documented extra (${JSON.stringify(accept)})`);
  ok(bare.json?.extensions?.attributionToken === TOKEN && bare.json.extensions.buyerAgentId === "4711" && bare.json.extensions.setup_url === "https://setup.example/.well-known/referral", "extensions echo the attribution token byte for byte, the buyer agent id as a string, and the setup URL");
  ok(!bare.headers.get("payment-required") && !bare.json.payment && !bare.json.howToCall && !bare.text.includes("/api/"), "no PAYMENT-REQUIRED header, no payment guide and no pointer to the direct route");
  ok(bare.headers.get("x-robots-tag") === "noindex, nofollow" && /no-store/.test(bare.headers.get("cache-control") || ""), "the answer is noindex and never stored");
  const plain = await send(R("echo"), { method: "POST", body: { text: "a" } });
  ok(plain.json?.extensions?.attributionToken === "" && !("buyerAgentId" in (plain.json?.extensions || {})), "with no referrer headers the token is the empty string and the agent id is absent");
  const longToken = await send(R("echo"), { method: "GET", headers: { "x-referrer-token": "a".repeat(9000) } });
  ok(longToken.status === 402 && longToken.json.extensions.attributionToken === "", "a token past the bound is not echoed (a cut token would be another token)");
  ok((await send(R("nope"), { method: "GET" })).status === 404 && (await send(`${app1.url}/ref/slow%2fecho`, { method: "GET" })).status === 404, "a slug outside the allowlist is a 404");
  const quoted = await send(R("chat"), { method: "POST", body: { max_tokens: 7, messages: [] } });
  const unpriced = await send(R("chat"), { method: "GET" });
  ok(quoted.json?.accepts?.[0]?.amount === "7000" && unpriced.status === 402 && unpriced.json?.accepts?.[0]?.amount === "1000", `a per-request price reads the body (${quoted.json?.accepts?.[0]?.amount}); a probe with no body reads the list price (${unpriced.json?.accepts?.[0]?.amount})`);
  ok(fac.calls.length === 0, "an unpaid request calls the facilitator for nothing");

  // --- local refusals: nothing claimed, nothing sent ------------------------------
  const refusedWith = async (name, opts, reason) => {
    const p = await signPayment(accept, opts);
    const before = fac.calls.length, ranBefore = runs.echo;
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === reason && fac.calls.length === before && runs.echo === ranBefore, `${name}: 402 ${reason}, no handler run, no facilitator call (${r.status} ${r.json?.errorReason})`);
    return p;
  };
  await refusedWith("an authorization to another address", { to: OUR_WALLET }, "invalid_exact_evm_payload_recipient_mismatch");
  await refusedWith("a value one unit under the amount", { value: "29999" }, "invalid_exact_evm_payload_authorization_value_mismatch");
  await refusedWith("a value one unit over the amount", { value: "30001" }, "invalid_exact_evm_payload_authorization_value_mismatch");
  await refusedWith("an expired authorization", { validBefore: String(Math.floor(Date.now() / 1000) - 5) }, "invalid_exact_evm_payload_authorization_valid_before");
  await refusedWith("an authorization that leaves no time to run and settle", { validBefore: String(Math.floor(Date.now() / 1000) + 2) }, "invalid_exact_evm_payload_authorization_valid_before");
  await refusedWith("an authorization not valid yet", { validAfter: String(Math.floor(Date.now() / 1000) + 600) }, "invalid_exact_evm_payload_authorization_valid_after");
  {
    const p = await signPayment(accept);
    const other = { ...p.payload, accepted: { ...accept, network: "eip155:137" } };
    const r = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from(JSON.stringify(other)).toString("base64url") } });
    ok(r.status === 402 && r.json?.errorReason === "invalid_network", `a payment naming another network: 402 invalid_network (${r.json?.errorReason})`);
    const junk = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from("not json").toString("base64url") } });
    ok(junk.status === 402 && junk.json?.success === false && junk.json.errorReason === "invalid_request", `a header that does not decode: 402 invalid_request (${junk.status} ${junk.json?.errorReason})`);
    const empty = await send(R("echo"), { body: { text: "x" }, headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: accept, payload: {} })).toString("base64url") } });
    ok(empty.status === 402 && empty.json?.errorReason === "invalid_payload", `a payment with no authorization: 402 invalid_payload (${empty.json?.errorReason})`);
  }
  {
    const p = await signPayment(accept);
    const r = await send(R("echo"), { body: { require: true }, headers: { "payment-signature": p.header } });
    const again = await send(R("echo"), { body: { text: "now valid" }, headers: { "payment-signature": p.header } });
    ok(r.status === 400 && r.json?.tool === "echo" && again.status === 200, `an input the pre-payment check refuses is a 400 with no claim: the same authorization then buys a valid call (${r.status}, ${again.status})`);
  }
  ok(sales.length === 1, `the refusals above booked nothing (${sales.length} sale so far, the valid call)`);
  fac.reset(); sales.length = 0;

  // --- a paid call ---------------------------------------------------------------
  const paid = await signPayment(accept);
  const good = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": paid.header } });
  const settleCall = fac.of("/settle")[0], verifyCall = fac.of("/verify")[0];
  ok(good.status === 200 && good.json?.echo === "hello" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid call returns the tool's answer with a top-level transaction (${good.status} ${good.text.slice(0, 120)})`);
  ok(fac.of("/verify").length === 1 && fac.of("/settle").length === 1 && fac.calls.findIndex((c) => c.path === "/verify") < fac.calls.findIndex((c) => c.path === "/settle"), "the facilitator was asked to verify once, then to settle once");
  for (const [name, c] of [["/verify", verifyCall], ["/settle", settleCall]]) {
    ok(c && /^0x[0-9a-f]{130}$/i.test(c.signature || "") && /^\d{10}$/.test(c.timestamp || "") && Math.abs(Number(c.timestamp) - Date.now() / 1000) < 60, `${name}: X-Agent-Signature is a 65-byte signature and X-Agent-Timestamp is unix seconds`);
    ok(c && c.recovered && c.recovered.toLowerCase() === signer.address.toLowerCase(), `${name}: the signature recovers to the signer over keccak256(body || uint64_be(timestamp)) of the exact bytes sent`);
    ok(c && c.raw === JSON.stringify({ x402Version: 2, paymentPayload: paid.payload, paymentRequirements: accept }), `${name}: the body is { x402Version: 2, paymentPayload, paymentRequirements } with the payload as decoded and the requirement as quoted`);
    ok(c && referralRequestDigest(c.raw, Number(c.timestamp)) === keccak256(concat([stringToHex(c.raw), numberToHex(Number(c.timestamp), { size: 8 })])), `${name}: the module's digest is the documented one`);
  }
  await wait(50);
  const row = saleByTx(good.json.transaction);
  ok(sales.length === 1 && sales[0].rail === "referral" && sales[0].wire === "referral" && sales[0].network === "base" && sales[0].payer === buyer.address.toLowerCase() && sales[0].tx === good.json.transaction && sales[0].priceUsd === 0.027 && sales[0].quoteUsd === 0.03, `one sale: rail referral, wire referral, network base, the signed payer, the settle transaction, net $0.027 of gross $0.03 (${JSON.stringify(sales[0])})`);
  ok(row && row.rail === "referral" && row.wire === "referral" && row.network === "base" && row.priceUsd === 0.027 && row.payer === buyer.address.toLowerCase() && row.internal === false, `the ledger row reads the same (${JSON.stringify(row)})`);
  ok(row && /^[0-9a-f]{64}$/.test(row.responseSha256 || "") && row.responseSha256 === createHash("sha256").update(good.text, "utf8").digest("hex"), "the row carries the digest of the bytes answered");

  // --- one authorization, one run ---------------------------------------------------
  const replay = await send(R("echo"), { body: { text: "hello" }, headers: { "payment-signature": paid.header } });
  ok(replay.status === 409 && replay.json?.reason === "consumed" && replay.headers.get("x-payment-replay") === "consumed" && fac.of("/settle").length === 1 && sales.length === 1, `the same authorization again is a 409, with no second settle and no second sale (${replay.status} ${replay.json?.reason})`);
  fac.reset(); sales.length = 0;
  {
    const p = await signPayment(accept);
    const before = runs.busy;
    const [a, b] = await Promise.all([0, 1].map(() => send(R("busy"), { body: { text: "twice" }, headers: { "payment-signature": p.header } })));
    const statuses = [a.status, b.status].sort();
    ok(statuses[0] === 200 && statuses[1] === 409 && fac.of("/settle").length === 1 && runs.busy === before + 1 && sales.length === 1 && sales[0].quoteUsd === 0.03 && sales[0].priceUsd === 0.0255, `two identical requests at once: one 200, one 409, one handler run, exactly one settle (${statuses.join("/")}, ${fac.of("/settle").length} settle, ${runs.busy - before} run); its slug's own commission (1500 bps) is what the sale is booked net of (${sales[0]?.priceUsd})`);
  }
  fac.reset(); sales.length = 0;

  // --- handler first: an error or a timeout is never settled ------------------------
  {
    const p = await signPayment(accept);
    const r = await send(R("boom"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 422 && r.json?.error === "that input cannot be served" && r.json.tool === "boom" && fac.of("/settle").length === 0 && sales.length === 0, `a handler 4xx is answered as the tool's own error and not settled (${r.status}, ${fac.of("/settle").length} settle)`);
    const again = await send(R("boom"), { body: {}, headers: { "payment-signature": p.header } });
    ok(again.status === 422 && runs.boom === 2, `its claim was released: the same authorization reaches the handler again (${again.status})`);
  }
  {
    const p = await signPayment(accept);
    const t0 = Date.now();
    const r = await send(R("slow"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 504 && Date.now() - t0 < 2400 && fac.of("/settle").length === 0 && sales.length === 0, `a handler past the deadline answers 504 at the deadline and is not settled (${r.status} after ${Date.now() - t0} ms)`);
    const again = await send(R("echo"), { body: { text: "after" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200, `its claim was released: the same authorization buys another call (${again.status})`);
    await wait(1700); // the slow handler ends
    ok(fac.of("/settle").length === 1, "the handler that finished late settled nothing");
  }
  fac.reset(); sales.length = 0;
  {
    const p = await signPayment(accept);
    const r = await send(R("bytes"), { body: {}, headers: { "payment-signature": p.header } });
    ok(r.status === 500 && fac.of("/settle").length === 0, `a binary answer is a 500, not settled (${r.status})`);
    const l = await send(R("list"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(l.status === 200 && JSON.stringify(l.json?.result) === "[1,2,3]" && /^0x/.test(l.json?.transaction || "") && Object.keys(l.json).length === 2, `an answer that is not a JSON object is served as { result, transaction } (${l.text})`);
    const o = await send(R("owntx"), { body: {}, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(o.status === 200 && o.json?.result?.transaction === "the tool's own field" && /^0x[0-9a-f]{64}$/.test(o.json?.transaction || ""), `an answer with a transaction field of its own is wrapped the same way, so the settle transaction is never mistaken for it (${o.text})`);
  }
  fac.reset(); sales.length = 0;

  // --- chat bodies are never streamed, and are priced after that is decided ---------
  {
    const body = { max_tokens: 9, messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } };
    const q = await send(R("chat"), { body });
    const acc = q.json.accepts[0];
    const r = await send(R("chat"), { body, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(acc.amount === "9000" && r.status === 200 && seen.chat && seen.chat.stream === false && seen.chat.hasOptions === false && Math.abs(seen.chat.stash - 0.009) < 1e-12, `a chat body is served with stream false and no stream_options, at the quoted amount, with the quote stashed on the request (${JSON.stringify(seen.chat)})`);
    ok(sales.length === 1 && sales[0].quoteUsd === 0.009 && Math.abs(sales[0].priceUsd - 0.0081) < 1e-12, `its sale books the quote gross and net (${sales[0]?.quoteUsd}, ${sales[0]?.priceUsd})`);
    const under = await send(R("chat"), { body: { ...body, max_tokens: 50 }, headers: { "payment-signature": (await signPayment(acc)).header } });
    ok(under.status === 402 && under.json?.errorReason === "invalid_exact_evm_payload_authorization_value_mismatch", `an authorization signed for a smaller body does not pay a larger one (${under.status} ${under.json?.errorReason})`);
  }
  fac.reset(); sales.length = 0;

  // --- the facilitator refuses ------------------------------------------------------
  {
    fac.mode.verify = () => ({ status: 200, body: { isValid: false, invalidReason: "unattributed_not_accepted", invalidMessage: "free text that is never echoed" } });
    const p = await signPayment(accept);
    const before = runs.echo;
    const r = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === "unattributed_not_accepted" && !/free text/.test(r.text) && runs.echo === before && fac.of("/settle").length === 0 && sales.length === 0, `a verify refusal: 402 with the facilitator's reason code, no handler run, no settle, no sale (${r.status} ${r.json?.errorReason})`);
    fac.mode.verify = () => ({ status: 200, body: { isValid: true } });
    const again = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200, `its claim was released: the same authorization is served once verify passes (${again.status})`);
    fac.mode.verify = () => ({ status: 500, body: "upstream exploded", type: "text/plain" });
    const down = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(down.status === 503 && down.headers.get("retry-after") === "30" && down.json?.errorReason === "facilitator_unavailable" && runs.echo === before + 1, `a facilitator that gives no verdict: 503 with Retry-After, no handler run (${down.status})`);
    fac.mode.verify = () => ({ status: 200, body: { isValid: true, payer: "0x" + "9".repeat(40) } });
    const other = await send(R("echo"), { body: { text: "v" }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(other.status === 402 && runs.echo === before + 1, `a verify that names another payer is refused (${other.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    fac.mode.settle = () => ({ status: 200, body: { success: false, errorReason: "settle_failed", errorMessage: "free text that is never echoed" } });
    const p = await signPayment(accept);
    const before = runs.echo;
    const r = await send(R("echo"), { body: { text: "s" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.success === false && r.json.errorReason === "settle_failed" && !("transaction" in r.json) && !/free text/.test(r.text) && runs.echo === before + 1 && sales.length === 0, `a settle refusal after the handler: 402 with the reason code, no answer, no sale (${r.status} ${r.json?.errorReason})`);
    ok(logLines.some((l) => /settle failed after a successful handler \(echo .*reason=settle_failed/.test(l)), "the settle failure is logged in one line");
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "ab".repeat(32) } });
    const again = await send(R("echo"), { body: { text: "s" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200 && sales.length === 1, `its claim was released: the same authorization settles on a later call (${again.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    // An answer that does not say whether the payment moved keeps the claim.
    for (const [name, answer] of [["a 500", { status: 500, body: { error: "x" } }], ["a success with no transaction", { status: 200, body: { success: true } }], ["a pending settlement", { status: 200, body: { success: false, errorReason: "settle_pending" } }], ["an authorization already used", { status: 409, body: { success: false, errorReason: "authorization_used" } }], ["an answer that is not JSON", { status: 200, body: "<html>", type: "text/html" }]]) {
      fac.mode.settle = () => answer;
      const p = await signPayment(accept);
      const r = await send(R("echo"), { body: { text: "d" }, headers: { "payment-signature": p.header } });
      const again = await send(R("echo"), { body: { text: "d" }, headers: { "payment-signature": p.header } });
      ok(r.status === 402 && r.json?.success === false && again.status === 409 && sales.length === 0, `${name} from /settle: 402, no sale, and the authorization buys no second run (${r.status} ${r.json?.errorReason}, then ${again.status})`);
    }
    ok(logLines.filter((l) => /SETTLE-IN-DOUBT/.test(l)).length === 5, "each is logged as SETTLE-IN-DOUBT");
    fac.mode.settle = () => ({ hang: true });
    const p = await signPayment(accept);
    const t0 = Date.now();
    const r = await send(R("echo"), { body: { text: "t" }, headers: { "payment-signature": p.header } });
    ok(r.status === 402 && r.json?.errorReason === "facilitator_timeout" && Date.now() - t0 < 4000, `a /settle that never answers ends at the settle timeout: 402 facilitator_timeout (${r.status} after ${Date.now() - t0} ms)`);
    fac.mode.settle = () => ({ status: 503, body: { success: false, errorReason: "lookup_unavailable" } });
    const q = await signPayment(accept);
    const lookup = await send(R("echo"), { body: { text: "l" }, headers: { "payment-signature": q.header } });
    fac.mode.settle = () => ({ status: 200, body: { success: true, transaction: "0x" + "cd".repeat(32) } });
    const retried = await send(R("echo"), { body: { text: "l" }, headers: { "payment-signature": q.header } });
    ok(lookup.status === 402 && lookup.json?.retryable === true && retried.status === 200, `a lookup the facilitator could not make moved nothing: 402 retryable, and the same authorization settles on the retry (${lookup.status}, ${retried.status})`);
  }
  fac.reset(); sales.length = 0;

  // --- a buyer who leaves ---------------------------------------------------------
  const rawPost = (url, body, headers, abortAfterMs) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve("answered")); });
    req.on("error", () => resolve("aborted"));
    req.end(data);
    setTimeout(() => req.destroy(), abortAfterMs);
  });
  {
    const p = await signPayment(accept);
    const outcome = await rawPost(R("busy"), { text: "gone" }, { "payment-signature": p.header }, 120);
    await wait(500);
    ok(outcome === "aborted" && fac.of("/settle").length === 0 && sales.length === 0 && logLines.some((l) => /client gone before settlement \(busy/.test(l)), `a connection closed before settlement starts is not settled (${fac.of("/settle").length} settle, ${sales.length} sale)`);
    const again = await send(R("echo"), { body: { text: "back" }, headers: { "payment-signature": p.header } });
    ok(again.status === 200, `its claim was released (${again.status})`);
  }
  fac.reset(); sales.length = 0;
  {
    fac.mode.settleDelayMs = 400;
    const p = await signPayment(accept);
    const before = app1.gate.stats().chargedNotServed;
    const outcome = await rawPost(R("echo"), { text: "leaving" }, { "payment-signature": p.header }, 150);
    await wait(700);
    ok(outcome === "aborted" && fac.of("/settle").length === 1 && sales.length === 1 && app1.gate.stats().chargedNotServed === before + 1 && logLines.some((l) => /CHARGED-BUT-NOT-SERVED: the buyer's connection closed during settlement \(echo/.test(l)), `a connection closed during the settle call: the sale is booked, logged CHARGED-BUT-NOT-SERVED and counted (${app1.gate.stats().chargedNotServed - before})`);
  }
  fac.reset(); sales.length = 0;

  // --- REFERRAL_VERIFY=off: the local checks stand alone ---------------------------
  const app2 = await mount({ REFERRAL_VERIFY: "off" });
  try {
    const p = await signPayment(accept);
    const r = await send(`${app2.url}/ref/echo`, { body: { text: "local" }, headers: { "payment-signature": p.header } });
    ok(r.status === 200 && fac.of("/verify").length === 0 && fac.of("/settle").length === 1, `with verify off a valid payment is served with no /verify call (${r.status})`);
    const forged = await signPayment(accept, { account: privateKeyToAccount(generatePrivateKey()) });
    forged.payload.payload.authorization.from = buyer.address; // someone else's signature under the buyer's address
    const before = runs.echo;
    const f = await send(`${app2.url}/ref/echo`, { body: { text: "forged" }, headers: { "payment-signature": Buffer.from(JSON.stringify(forged.payload)).toString("base64url") } });
    ok(f.status === 402 && f.json?.errorReason === "invalid_exact_evm_payload_signature" && runs.echo === before && fac.of("/settle").length === 1, `with verify off a signature that is not the payer's is refused locally (${f.status} ${f.json?.errorReason})`);
    const direct = await signPayment(accept, { primaryType: "TransferWithAuthorization" });
    const d = await send(`${app2.url}/ref/echo`, { body: { text: "wrong type" }, headers: { "payment-signature": direct.header } });
    ok(d.status === 402 && d.json?.errorReason === "invalid_exact_evm_payload_signature", `a TransferWithAuthorization signature is not a ReceiveWithAuthorization (${d.status} ${d.json?.errorReason})`);
  } finally { await app2.close(); }
  const app3 = await mount({ REFERRAL_VERIFY_SIGNED: "off" });
  try {
    fac.reset();
    const r = await send(`${app3.url}/ref/echo`, { body: { text: "unsigned verify" }, headers: { "payment-signature": (await signPayment(accept)).header } });
    ok(r.status === 200 && fac.of("/verify")[0].signature === null && fac.of("/settle")[0].recovered?.toLowerCase() === signer.address.toLowerCase(), "with REFERRAL_VERIFY_SIGNED=off /verify carries no signature and /settle still does");
  } finally { await app3.close(); }

  // --- the pure payment check -------------------------------------------------------
  {
    const p = await signPayment(accept);
    const okay = checkReferralPayment(p.payload, accept, { reserveMs: 1000 });
    ok(!okay.reason && okay.auth.from === buyer.address && okay.validBeforeMs > Date.now(), "the pure check passes a payment for the quoted requirement");
    ok(checkReferralPayment({ ...p.payload, payload: { ...p.payload.payload, authorization: { ...p.authorization, to: PAY_TO.toLowerCase() } } }, accept, { reserveMs: 1000 }).reason === undefined, "the pay-to address is compared without case");
    ok(checkReferralPayment({ ...p.payload, payload: { ...p.payload.payload, authorization: { ...p.authorization, value: 30000 } } }, accept).reason === "invalid_payload", "a value that is not a string is refused");
    ok(checkReferralPayment(null, accept).reason === "invalid_request" && checkReferralPayment([], accept).reason === "invalid_request", "a payment that is not an object is refused");
  }

  // --- the key stays where it is ----------------------------------------------------
  const haystack = [...logLines, ...responses, ...fac.calls.map((c) => c.raw + JSON.stringify(c.signature))].join("\n").toLowerCase();
  ok(logLines.length > 10 && responses.length > 40 && !haystack.includes(KEY_HEX), `the signer key is in no log line, no response and no facilitator request (${logLines.length} lines, ${responses.length} responses)`);
  ok(logLines.every((l) => !l.toLowerCase().includes(buyer.address.toLowerCase())), "no log line carries a payer's full address");
} catch (e) {
  failed++;
  console.error(`FAIL - part 1 threw: ${e?.stack || e}`);
} finally {
  await app1.close();
}

// ===============================================================================
// Part 2: the real server, paid mode
// ===============================================================================
const J = { "content-type": "application/json" };
const baseAmountOf = (r) => {
  const header = r.headers.get("payment-required");
  const offer = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : r.json;
  const a = (offer?.accepts || []).find((x) => x.network === "eip155:8453" && x.scheme === "exact");
  return a ? { amount: String(a.amount ?? a.maxAmountRequired), accept: a } : null;
};

// Switches unset: nothing is mounted.
{
  const off = await bootPaidServer({ label: "referral-off", env: { REFERRAL_PAY_TO: "", REFERRAL_FACILITATOR_URL: "", REFERRAL_SIGNER_KEY: "", REFERRAL_SLUGS: "", REFERRAL_SETUP_URL: "" } });
  try {
    const a = await call(`${off.url}/ref/hash`, { method: "GET" });
    const b = await call(`${off.url}/ref/hash`, { body: { text: "a" } });
    const direct = await call(`${off.url}/api/hash`, { body: { text: "a" } });
    ok(a.status === 404 && b.status === 404 && direct.status === 402, `with the REFERRAL_* variables unset /ref/* is a 404 and the direct route is unchanged (${a.status}, ${b.status}, ${direct.status})`);
    ok(!/referral/i.test(off.log()), "and the boot log says nothing about it");
  } finally { await off.stop(); }
}
{
  // A half-set configuration is off, with one warning that names the variable and no value.
  const half = await bootPaidServer({ label: "referral-half", env: { REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY, REFERRAL_SLUGS: "hash", REFERRAL_SETUP_URL: "" } });
  try {
    const a = await call(`${half.url}/ref/hash`, { method: "GET" });
    ok(a.status === 404 && /referral gate is off: missing REFERRAL_SETUP_URL/.test(half.log()) && !half.log().toLowerCase().includes(KEY_HEX), `a half-set configuration serves nothing and warns once, naming the variable (${a.status})`);
  } finally { await half.stop(); }
}

fac.reset();
const srv = await bootPaidServer({
  label: "referral-on",
  env: {
    WALLET_ADDRESS: OUR_WALLET,
    REFERRAL_PAY_TO: PAY_TO, REFERRAL_FACILITATOR_URL: fac.url, REFERRAL_SIGNER_KEY: SIGNER_KEY, REFERRAL_SETUP_URL: "https://setup.example/.well-known/referral",
    REFERRAL_SLUGS: "hash,v1-chat-metered,v1-chat,v1-chat-auto,v1-chat-pro,v1-chat-premium,onchain-sql,image-gen,image-gen-premium,attest,qr,no-such-tool",
    REFERRAL_COMMISSION_BPS: "default:1000,v1-chat-auto:1500,v1-chat-pro:1500,v1-chat-premium:1500",
    AGENT402_OPERATOR_TOKEN: "referral-gate-operator-token-0123456789",
    // The committed placeholder table: the metered quote needs one, and the
    // suite never depends on a real rate.
    UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
  },
});
try {
  const bootLog = srv.log();
  const servedLine = /Referral gate enabled for (\d+) route\(s\): ([^\n]*)/.exec(bootLog);
  const served = servedLine ? servedLine[2].split(",").map((s) => s.trim()) : [];
  ok(servedLine && ["hash", "onchain-sql", "v1-chat-auto", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-chat"].every((x) => served.includes(x)) && served.length === 7, `the boot serves the eligible slugs (${servedLine ? servedLine[2] : "no line"})`);
  ok(/\[referral\] image-gen is not served under \/ref: its own upstream wait \(60 s\) is past the handler deadline \(45 s\)/.test(bootLog), "image-gen is left out at boot: its upstream wait is past the default handler deadline");
  ok(/\[referral\] image-gen-premium is not served under \/ref: long-running/.test(bootLog) && /\[referral\] no-such-tool is not served under \/ref: not in the catalog/.test(bootLog), "a long-running slug and a slug missing from the catalog are left out with a reason");
  for (const slug of ["attest", "qr"]) {
    if (!new RegExp(`"${slug}"`).test(JSON.stringify(served)) && new RegExp(`\\[referral\\] ${slug} is not served`).test(bootLog)) ok(true, `${slug} is left out at boot (${(new RegExp(`\\[referral\\] ${slug} is not served under /ref: ([^\\n]*)`).exec(bootLog) || [])[1]})`);
    else ok(false, `${slug} should be left out at boot (identity-bound, lasting effect or binary)`);
  }
  for (const slug of ["image-gen", "image-gen-premium", "attest", "qr", "no-such-tool", "answer"]) {
    const r = await call(`${srv.url}/ref/${slug}`, { method: "GET" });
    if (r.status !== 404) ok(false, `/ref/${slug} answers ${r.status}, expected 404`);
  }
  ok(true, "every slug left out at boot answers 404");

  // The 402 on the real server.
  const bare = await call(`${srv.url}/ref/hash`, { method: "GET", headers: { "x-referrer-token": "tok.en-1" } });
  const refAccept = bare.json?.accepts?.[0];
  ok(bare.status === 402 && bare.json?.x402Version === 2 && refAccept?.payTo === PAY_TO && refAccept.network === "eip155:8453" && refAccept.asset === REFERRAL_ASSET && refAccept.extra?.endpoint === "/ref/hash" && refAccept.extra.authorizationType === "ReceiveWithAuthorization" && bare.json.extensions?.attributionToken === "tok.en-1", `GET /ref/hash answers the referral 402 (${bare.status})`);
  ok(!bare.headers.get("payment-required") && !bare.headers.get("www-authenticate") && !bare.json.payment && !bare.json.howToCall && !bare.text.includes("/api/hash") && !bare.text.includes(OUR_WALLET), "it carries no PAYMENT-REQUIRED or WWW-Authenticate header, no payment guide, no pointer to the direct route and not this server's own wallet");
  ok(bare.headers.get("x-robots-tag") === "noindex, nofollow" && bare.headers.get("x-content-type-options") === "nosniff" && /max-age=/.test(bare.headers.get("strict-transport-security") || ""), "it is noindex and carries the always-on security headers");
  ok(bare.json.resource?.url?.endsWith("/ref/hash") && bare.json.resource.mimeType === "application/json", "resource names the referral path");

  // Amount parity with the direct route's own Base accept, per request.
  const parity = async (name, refPath, directPath, body) => {
    const d = baseAmountOf(await call(`${srv.url}${directPath}`, { body }));
    const r = await call(`${srv.url}${refPath}`, { body });
    const got = r.json?.accepts?.[0]?.amount;
    ok(!!d && r.status === 402 && got === d.amount && BigInt(got) > 0n, `${name}: the referral amount is the direct route's Base amount (${got} vs ${d?.amount})`);
    return { got, direct: d };
  };
  const flat = await parity("a flat-price tool", "/ref/hash", "/api/hash", { text: "abc" });
  ok(flat.got === "1000", `hash asks its list price in base units (${flat.got})`);
  const small = await parity("a metered chat body", "/ref/v1-chat-metered", "/v1/metered/chat/completions", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 });
  const large = await parity("a larger metered chat body", "/ref/v1-chat-metered", "/v1/metered/chat/completions", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Summarize the history of settlement systems. ".repeat(200) }], max_tokens: 4000 });
  ok(BigInt(large.got) > BigInt(small.got), `the metered quote follows the body (${small.got} then ${large.got})`);
  const streamed = await parity("a metered chat body asking for a stream", "/ref/v1-chat-metered", "/v1/metered/chat/completions", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true, stream_options: { include_usage: true } });
  ok(BigInt(streamed.got) > 0n, "turning the stream off does not change the quote");
  const home = await parity("a flat chat tier at its own price", "/ref/v1-chat", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  const cross = await parity("a flat chat tier priced by another tier's model", "/ref/v1-chat", "/v1/chat/completions", { model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  ok(BigInt(cross.got) > BigInt(home.got), `the price follows the model named (${home.got} then ${cross.got})`);
  // The model-priced tiers: the amount follows the model the request names.
  const chatBody = (model) => ({ ...(model ? { model } : {}), messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  const proHome = await parity("the pro tier at its own price", "/ref/v1-chat-pro", "/v1/pro/chat/completions", chatBody());
  const proDear = await parity("the pro tier naming a dearer tier's model", "/ref/v1-chat-pro", "/v1/pro/chat/completions", chatBody("anthropic/claude-opus-5.5"));
  ok(BigInt(proDear.got) > BigInt(proHome.got), `on the pro tier a dearer model raises the amount (${proHome.got} then ${proDear.got})`);
  const premHome = await parity("the premium tier at its own price", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody());
  const premNamed = await parity("the premium tier naming its own model", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody("anthropic/claude-opus-5.5"));
  const premOther = await parity("the premium tier naming another tier's model", "/ref/v1-chat-premium", "/v1/premium/chat/completions", chatBody("openai/gpt-6.1-terra"));
  ok(premNamed.got === premHome.got && premNamed.got === proDear.got && premOther.got === proHome.got, `a model is priced at its own tier on either route (${premHome.got}, ${premOther.got})`);
  const autoFlat = await parity("the auto tier", "/ref/v1-chat-auto", "/v1/auto/chat/completions", chatBody());
  ok(BigInt(autoFlat.got) > 0n, "the auto tier asks its flat price");
  const probe = await call(`${srv.url}/ref/v1-chat-metered`, { method: "GET" });
  const floor = await call(`${srv.url}/ref/v1-chat-metered`, { body: { nonsense: true } });
  ok(probe.status === 402 && floor.status === 402 && probe.json.accepts[0].amount === floor.json.accepts[0].amount && BigInt(probe.json.accepts[0].amount) > 0n, `a bare GET and an unpriceable body both answer 402 at the route's list price (${probe.json?.accepts?.[0]?.amount})`);
  {
    // A body over the global 100 KB parser reaches the metered copy's own parser.
    const big = { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "word ".repeat(30_000) }], max_tokens: 16 };
    const d = baseAmountOf(await call(`${srv.url}/v1/metered/chat/completions`, { body: big }));
    const r = await call(`${srv.url}/ref/v1-chat-metered`, { body: big });
    ok(r.status === 402 && d && r.json?.accepts?.[0]?.amount === d.amount, `a 150 KB metered body is parsed and quoted like the direct route (${r.status}, ${r.json?.accepts?.[0]?.amount} vs ${d?.amount})`);
  }

  // A paid call end to end.
  const p = await signPayment(refAccept);
  const good = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": p.header } });
  ok(good.status === 200 && good.json?.hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && /^0x[0-9a-f]{64}$/.test(good.json?.transaction || ""), `a paid /ref/hash returns the tool's answer with the settle transaction (${good.status} ${good.text.slice(0, 140)})`);
  ok(fac.of("/settle").length === 1 && fac.of("/settle")[0].recovered?.toLowerCase() === signer.address.toLowerCase() && fac.of("/settle")[0].json?.paymentRequirements?.payTo === PAY_TO && fac.of("/settle")[0].json.paymentRequirements.amount === "1000", "the referral facilitator settled it once, on a request signed by the signer key, for the quoted requirement");
  const replay = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": p.header } });
  ok(replay.status === 409 && fac.of("/settle").length === 1, `the same authorization again is a 409 (${replay.status})`);
  const invalid = await call(`${srv.url}/ref/hash`, { body: {}, headers: { "payment-signature": (await signPayment(refAccept)).header } });
  ok(invalid.status === 400 && invalid.json?.tool === "hash" && fac.of("/settle").length === 1, `a paid call with an invalid input is the direct route's 400, not settled (${invalid.status})`);
  const padded = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": Buffer.from(JSON.stringify((await signPayment(refAccept)).payload)).toString("base64") } });
  ok(padded.status === 200, `standard base64 is read like base64url (${padded.status})`);
  const garbage = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": "!!!not-base64!!!" } });
  ok(garbage.status === 402 && garbage.json?.success === false && garbage.json.errorReason === "invalid_request", `a header that does not decode is a 402 invalid_request (${garbage.status} ${garbage.json?.errorReason})`);

  // The two paywalls do not take each other's payments.
  {
    const settlesBefore = fac.of("/settle").length;
    const cross1 = await call(`${srv.url}/api/hash`, { body: { text: "abc" }, headers: { "payment-signature": (await signPayment(refAccept)).header } });
    ok(cross1.status === 402 && !cross1.json?.hex, `a referral payment sent to the direct route is refused (${cross1.status})`);
    const directAccept = flat.direct.accept;
    const directPay = await signPayment({ ...directAccept }, { to: directAccept.payTo, value: directAccept.amount, primaryType: "TransferWithAuthorization" });
    const cross2 = await call(`${srv.url}/ref/hash`, { body: { text: "abc" }, headers: { "payment-signature": directPay.header } });
    ok(cross2.status === 402 && cross2.json?.errorReason === "invalid_exact_evm_payload_recipient_mismatch" && fac.of("/settle").length === settlesBefore, `a direct-route payment sent to /ref is refused before any facilitator call (${cross2.status} ${cross2.json?.errorReason})`);
  }

  // No discovery surface names the copies.
  for (const path of ["/api/pricing", "/openapi.json", "/llms.txt", "/llms-full.txt", "/.well-known/x402", "/sitemap.xml", "/robots.txt", "/api/rails"]) {
    const r = await call(`${srv.url}${path}`, { method: "GET" });
    ok(r.status === 200 && !/\/ref\//.test(r.text) && !/referral/i.test(r.text) && !r.text.toLowerCase().includes(PAY_TO.toLowerCase()), `${path} does not mention /ref, the gate or its pay-to address`);
  }
  const status = await call(`${srv.url}/api/gateway-status`, { method: "GET" });
  ok(status.status === 200 && !/referral/i.test(status.text), "/api/gateway-status carries no word for it");
  const stats = await call(`${srv.url}/api/stats`, { method: "GET" });
  ok(stats.status === 200 && !/referral/i.test(stats.text), "/api/stats does not count it");
  const op = await call(`${srv.url}/__operator/tool-failures.json`, { method: "GET", headers: { "x-operator-token": "referral-gate-operator-token-0123456789" } });
  ok(op.status === 200 && op.json?.referralGate?.sinceBoot?.settled === 2 && op.json.referralGate.routes.includes("hash"), `the operator view carries the gate's counters (${JSON.stringify(op.json?.referralGate?.sinceBoot)})`);

  const log = srv.log();
  ok(/\[referral\] settled hash payer=0x[0-9a-fA-F]{4} tx=0x[0-9a-f]{64}/.test(log) && !log.toLowerCase().includes(KEY_HEX) && !log.toLowerCase().includes(buyer.address.toLowerCase()), "the server log has the settle line with a shortened payer, and neither the signer key nor a full payer address");
  ok(srv.exited() === null, "the server is still up");
} catch (e) {
  failed++;
  console.error(`FAIL - part 2 threw: ${e?.stack || e}`);
  console.error(srv.log().slice(-2000));
} finally {
  await srv.stop();
  await fac.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
