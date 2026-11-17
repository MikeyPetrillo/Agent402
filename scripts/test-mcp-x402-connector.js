#!/usr/bin/env node
// The x402 MCP wire on the hosted connector (/mcp): src/mcp-http.js over the
// codec (src/mcp-x402.js) and the flagships' internal twins
// (src/mcp-x402-routes.js), end to end.
//
//   node scripts/test-mcp-x402-connector.js
//
// Boots the REAL server in paid mode (Base, with the MPP gates on) against a
// stub facilitator that counts /verify and /settle, and drives it with the
// official @x402/mcp client over Streamable HTTP:
//   - a flagship's first ask is one result carrying both wires: the twin's
//     PaymentRequired (resource /mcp, an MCP discovery extension) as
//     first text block (never structuredContent) and the MPP challenges in _meta;
//   - the official client pays it and gets the tool output and the settle
//     receipt in _meta["x402/payment-response"]; one verify, one settle;
//   - catalog.call and a flagship with no twin are paid on the slug's own
//     HTTP route and challenge;
//   - memory.read is keyed on the signed payer: the writer reads its value,
//     another wallet does not (and its error answer is not settled);
//   - a payment sent twice is refused the second time, unsettled;
//   - a settle that fails returns no tool output and never an offer: a
//     refusal naming no transaction, the same refusal followed by a settle
//     fallback's 500, a transaction named, a timeout or a bare failure all
//     answer the explanation and nothing to sign, over MPP too, and so does a
//     5xx from the paid route once a payment was presented; the official
//     client signs once in each case; a settle the fallback completes is
//     served with its receipt;
//   - a payment the reader refuses, and one the facilitator refuses, return
//     the invalid-payment result (a fresh offer, the reason named);
//   - an MPP credential beside an x402 payment: MPP decides, x402 is not read;
//   - a free tool at its rate limit offers its x402 challenge, and a client
//     that pays is served past the limit;
//   - a tools/call carrying a payment that decodes meets its own, larger
//     per-IP transport limit, every other call the normal one;
//   - a twin's sale books the arrival path x402-mcp;
//   - the instructions, a paid tool's first ask, the rate-limit text and
//     payment.info name only the wires offered (in-process mounts too).
// The official client is installed --no-save (see test-mcp-x402.js); missing
// or another version fails.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import express from "express";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { bootServer } from "./lib/boot-server.js";

const MCP_CLIENT_VERSION = "2.30.0";
let x402MCPClient;
try {
  ({ x402MCPClient } = await import("@x402/mcp"));
  const v = JSON.parse(readFileSync(new URL("../node_modules/@x402/mcp/package.json", import.meta.url), "utf8")).version;
  if (v !== MCP_CLIENT_VERSION) throw new Error(`found ${v}`);
} catch (e) {
  console.error(`FAIL - the official @x402/mcp@${MCP_CLIENT_VERSION} client is needed (${e.message.split("\n")[0]}); install it with: npm install --no-save --ignore-scripts @x402/mcp@${MCP_CLIENT_VERSION}`);
  process.exit(1);
}

const { carriesPayment } = await import("../src/mcp-http.js");
const { X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META, SETTLEMENT_PENDING_META, paymentRequiredOfResult: PR } = await import("../src/mcp-x402.js");
const { MCP_PAYMENT_REQUIRED_META, MCP_CREDENTIAL_META, createMcpMppLoopback } = await import("../src/mcp-mpp.js");
const { registerOfferedNetworks } = await import("../src/payment-attempt.js");
const { SETTLEMENT_PENDING_DETAIL } = await import("../src/gateway-wire.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- module half: which calls carry a payment -------------------------------------
{
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: {} };
  const payment = { x402Version: 2, accepted, payload: { signature: "0x00" } };
  const call = (meta) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web.search", arguments: {}, ...(meta ? { _meta: meta } : {}) } });
  ok(carriesPayment(call({ [X402_PAYMENT_META]: payment })), "a tools/call with an x402 payment the reader accepts carries a payment");
  const mppCred = `Payment ${Buffer.from(JSON.stringify({ challenge: { id: "c1", method: "evm", intent: "charge" }, payload: { signature: "0x00" } })).toString("base64url")}`;
  ok(carriesPayment(call({ [MCP_CREDENTIAL_META]: mppCred })), "a tools/call with an MPP credential that decodes carries a payment");
  ok(!carriesPayment(call({ [MCP_CREDENTIAL_META]: "x" })) && !carriesPayment(call({ [MCP_CREDENTIAL_META]: "Payment abc" })), "an MPP credential that does not decode does not");
  registerOfferedNetworks(["eip155:8453"]);
  ok(carriesPayment(call({ [X402_PAYMENT_META]: payment })) && !carriesPayment(call({ [X402_PAYMENT_META]: { ...payment, accepted: { ...accepted, network: "eip155:10" } } })),
    "an x402 payment on a network this server does not offer does not carry a payment");
  registerOfferedNetworks([]);
  ok(!carriesPayment(call(null)) && !carriesPayment(call({ progressToken: 1 })), "an unpaid tools/call does not");
  ok(!carriesPayment(call({ [X402_PAYMENT_META]: { ...payment, x402Version: 1 } })) && !carriesPayment(call({ [X402_PAYMENT_META]: "x" })), "a payment the reader refuses does not");
  ok(!carriesPayment({ method: "initialize", params: { _meta: { [X402_PAYMENT_META]: payment } } }) && !carriesPayment(null) && !carriesPayment("x"), "anything but a tools/call does not");
  const hostile = call({});
  Object.defineProperty(hostile.params._meta, X402_PAYMENT_META, { enumerable: true, get() { throw new Error("boom"); } });
  ok(carriesPayment(hostile) === false, "a getter that throws reads as no payment");
}

// ---- in-process half: a settle the paid route left pending -------------------------
// The route's 402 for a Circle Gateway batched payment still settling
// (src/verify-hint.js: reason settlement-pending, retry same-payment, the
// "do not sign a new authorization" hint) and for a broadcast transfer not yet
// confirmed (retry watch-transaction). Neither may come back as a fresh offer:
// a client that signs it again could pay twice.
{
  const { mountMcp } = await import("../src/mcp-http.js");
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const offerObj = { x402Version: 2, error: "Payment required", resource: { url: "http://localhost/api/paid-x", description: "paid-x", mimeType: "application/json" }, accepts: [accepted] };
  const payment = { x402Version: 2, accepted, payload: { signature: "0x00" } };
  const TX = `0x${"5c".repeat(32)}`;
  const variants = {
    pending: {
      settle: { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
      body: { error: "Payment required", reason: "settlement-pending", retry: "same-payment", network: "eip155:8453", hint: SETTLEMENT_PENDING_DETAIL },
      retryAfter: "10",
    },
    unconfirmed: {
      settle: { success: false, errorReason: "transaction_pending", transaction: TX, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
      body: { reason: "settlement-unconfirmed", retry: "watch-transaction", network: "eip155:8453", transactions: [TX], hint: "Watch the transaction listed in transactions. Signing a new authorization for this call is a new payment; it does not start or speed that repayment." },
    },
  };
  const SOL_SIG = "5".repeat(87);
  const payer1 = "0x0000000000000000000000000000000000000001";
  Object.assign(variants, {
    // A settle that failed naming a transaction: possibly landed.
    failedTx: { settle: { success: false, errorReason: "transaction_failed", errorMessage: "The payment could not be settled.", transaction: TX, network: "eip155:8453", payer: payer1 }, body: {} },
    failedSolTx: { settle: { success: false, errorReason: "settlement_failed", transaction: SOL_SIG, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: payer1 }, body: {} },
    // No transaction named, and nothing that proves none was sent.
    failedBare: { settle: { success: false, errorReason: "settlement_failed", errorMessage: "The payment could not be settled.", transaction: "", network: "eip155:8453", payer: payer1 }, body: {} },
    failedTimeout: { settle: { success: false, errorReason: "timeout", transaction: "", network: "eip155:8453", payer: payer1 }, body: { hint: "ROUTE-HINT-7" } },
    // Billing words beside a transaction: the transaction decides.
    billingTx: { settle: { success: false, errorReason: "free_tier_exhausted", transaction: TX, network: "eip155:8453", payer: payer1 }, body: {} },
    // The paywall's bare body: no receipt, no offer of its own.
    noReceipt: { settle: null, body: { error: "settlement_failed" }, noOffer: true },
    // A billing refusal on this server's account naming no transaction: the
    // receipt is the first facilitator's, and says nothing of a fallback
    // asked after it. Its 402 carries the route's own offer.
    preBroadcast: { settle: { success: false, errorReason: "free_tier_exhausted", errorMessage: "Settlement refused: free_tier_exhausted", transaction: "", network: "eip155:8453", payer: payer1 }, body: { reason: "facilitator-quota", retry: "other-network", network: "eip155:8453", hint: "Nothing was charged." } },
    preBroadcastWords: { settle: { success: false, errorReason: "settlement_failed", errorMessage: "Settlement refused: insufficient credits", transaction: "", network: "eip155:8453", payer: payer1 }, body: {} },
    // The paid route answered 5xx after the payment was presented.
    route500: { status: 500, settle: null, body: { error: "upstream_failed", hint: "ROUTE-500-HINT" } },
    route503Tx: { status: 503, settle: null, body: { error: "unavailable", transactions: [TX] } },
    // Control: a payment the route's verify refused. Never settled, no receipt.
    verifyRefused: { settle: null, body: { error: "invalid_exact_evm_payload_signature" } },
  });
  let mode = "pending";
  let paidReplays = 0;
  const stubFetch = async (url, init) => {
    const paid = Boolean(init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.Authorization || init?.headers?.authorization);
    const headers = { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(offerObj) };
    if (!paid) return new Response(JSON.stringify({ error: "Payment required" }), { status: 402, headers });
    paidReplays++;
    const v = variants[mode];
    // A settle-failure 402 carries PAYMENT-RESPONSE and no PAYMENT-REQUIRED
    // (src/payment-required-body.js); the unpaid ask above is where the
    // connector could fetch a fresh offer from.
    return new Response(JSON.stringify(v.body), { status: v.status || 402, headers: { "content-type": "application/json", ...(v.noOffer || v.settle?.success === false && !v.retryAfter && !v.body.retry ? {} : { "payment-required": headers["payment-required"] }), ...(v.settle ? { "payment-response": encodePaymentResponseHeader(v.settle) } : {}), ...(v.retryAfter ? { "retry-after": v.retryAfter } : {}) } });
  };
  const CAT = { "POST /api/paid-x": { route: "POST /api/paid-x", slug: "paid-x", name: "paid-x", category: "test", price: "$0.001", description: "paid-x test tool", tags: ["paid-x"], discovery: { inputSchema: { properties: {} }, input: {} }, handler: async () => { throw new Error("ran in-process"); } } };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountMcp(app, CAT, { baseUrl: "http://localhost", isComputePayable: () => false, x402Loopback: createMcpMppLoopback({ port: 1, fetchImpl: stubFetch }), mppLoopback: createMcpMppLoopback({ port: 1, fetchImpl: stubFetch }) });
  const httpSrv = app.listen(0, "127.0.0.1");
  await new Promise((r) => httpSrv.once("listening", r));
  const raw = new Client({ name: "pending", version: "0.0.0" });
  await raw.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpSrv.address().port}/mcp`)));
  try {
    const call = () => raw.callTool({ name: "catalog.call", arguments: { slug: "paid-x", params: {} }, _meta: { [X402_PAYMENT_META]: payment } });
    mode = "pending";
    const p = await call();
    const pText = JSON.stringify(p.content || "");
    ok(p.isError === true && !("structuredContent" in p) && !PR(p) && !/"accepts"/.test(pText) && !/"x402Version"/.test(String(p.content?.[0]?.text)),
      `a Gateway payment still settling answers no fresh offer to sign (${pText.slice(0, 160)})`);
    ok(pText.includes("Do not sign a new authorization") && p._meta?.[SETTLEMENT_PENDING_META]?.retry === "same-payment" && p._meta?.[SETTLEMENT_PENDING_META]?.reason === "settlement-pending" && p._meta?.[SETTLEMENT_PENDING_META]?.retryAfterSeconds === 10,
      `it carries the route's hint, retry same-payment and the wait (${JSON.stringify(p._meta?.[SETTLEMENT_PENDING_META])})`);
    ok(p._meta?.[X402_PAYMENT_RESPONSE_META]?.success === false && p._meta[X402_PAYMENT_RESPONSE_META].errorReason === "settlement_pending" && !/settlement failed/i.test(pText),
      "the pending settle answer rides in _meta, and the result never says the settlement failed");
    mode = "unconfirmed";
    const u = await call();
    const uText = JSON.stringify(u.content || "");
    ok(u.isError === true && !("structuredContent" in u) && !PR(u) && u._meta?.[SETTLEMENT_PENDING_META]?.retry === "watch-transaction" && u._meta?.[SETTLEMENT_PENDING_META]?.transactions?.[0] === TX && /new payment/.test(uText) && !/not charged/.test(uText),
      `an unconfirmed broadcast answers the transactions to watch, no fresh offer, never "not charged" (${uText.slice(0, 160)})`);
    ok(uText.includes(TX) && uText.includes(`_meta[\\"${SETTLEMENT_PENDING_META}\\"].transactions`),
      `its text names the hash and says where the list is (_meta), since the result has no "transactions" field of its own (${uText.slice(-220)})`);
    // A settle that failed, whatever the receipt reads as: the explanation
    // with nothing to sign. A receipt records one facilitator's answer, not
    // what a fallback asked after it did.
    for (const [m, tx] of [["failedTx", TX], ["failedSolTx", SOL_SIG], ["failedBare", null], ["failedTimeout", null], ["billingTx", TX], ["noReceipt", null], ["preBroadcast", null], ["preBroadcastWords", null]]) {
      mode = m;
      const f = await call();
      const fText = JSON.stringify(f.content || "");
      ok(f.isError === true && !("structuredContent" in f) && !PR(f) && !/"accepts"|x402Version/.test(fText) && !/"accepts"|x402Version/.test(JSON.stringify(f._meta || {})) && !f._meta?.[MCP_PAYMENT_REQUIRED_META] && /Do not sign a new authorization for this call/.test(fText) && !/not charged/i.test(fText),
        `${m}: a failed settle answers no offer in text, structuredContent or _meta and says not to sign again (${fText.slice(0, 200)})`);
      const fm = f._meta?.[SETTLEMENT_PENDING_META];
      ok(fm?.reason === "settlement-failed" && (tx ? fm.transactions?.[0] === tx && fm.retry === "watch-transaction" && fText.includes(tx) && /may still land/.test(fText) : !fm.transactions && !fm.retry)
        && (m === "noReceipt" ? !f._meta?.[X402_PAYMENT_RESPONSE_META] : f._meta?.[X402_PAYMENT_RESPONSE_META]?.success === false),
        `${m}: ${tx ? "it names the transaction to watch, exactly as written" : "it names no transaction"}, and the failed receipt rides in _meta when the route sent one (${String(JSON.stringify(fm)).slice(0, 200)})`);
    }
    mode = "failedTimeout";
    ok(JSON.stringify((await call()).content).includes("ROUTE-HINT-7"), "the route's own hint is kept in the text");
    mode = "preBroadcast";
    ok(JSON.stringify((await call()).content).includes("Nothing was charged."), "a refusal naming no transaction keeps the route's own hint too");
    // A 5xx from the paid route after the payment was presented: the route's
    // answer, nothing to sign, and the transaction to watch when it names one.
    for (const [m, tx, word] of [["route500", null, "ROUTE-500-HINT"], ["route503Tx", TX, "unavailable"]]) {
      mode = m;
      const f = await call();
      const fText = JSON.stringify(f.content || "");
      ok(f.isError === true && !("structuredContent" in f) && !PR(f) && !/"accepts"|x402Version/.test(fText + JSON.stringify(f._meta || {})) && /Do not sign a new authorization for this call/.test(fText) && fText.includes(word) && fText.includes(`HTTP ${variants[m].status}`) && (tx ? fText.includes(tx) : !/to watch/.test(fText)),
        `${m}: a 5xx after a payment was presented answers the route's text, no offer, and says not to sign again (${fText.slice(0, 240)})`);
    }
    // Control: a payment the route's verify refused was never settled, and
    // keeps its fresh offer naming the reason.
    {
      mode = "verifyRefused";
      const f = await call();
      ok(f.isError === true && Array.isArray(PR(f)?.accepts) && /invalid_exact_evm_payload_signature/.test(String(PR(f)?.error)) && !f._meta?.[X402_PAYMENT_RESPONSE_META] && !f._meta?.[SETTLEMENT_PENDING_META] && !/Do not sign a new authorization/.test(JSON.stringify(f.content)),
        `verifyRefused: a verify refusal (no settle receipt) answers the invalid-payment result with a fresh offer (${PR(f)?.error})`);
    }
    // The same over MPP: a credential whose settle failed, with a transaction
    // named or none.
    for (const [m, tx] of [["failedTx", TX], ["preBroadcast", null]]) {
      const cred = `Payment ${Buffer.from(JSON.stringify({ challenge: { id: "c1", method: "evm", intent: "charge" }, payload: { signature: "0x00" } })).toString("base64url")}`;
      mode = m;
      let m1 = null, mErr = null;
      try { m1 = await raw.callTool({ name: "catalog.call", arguments: { slug: "paid-x", params: {} }, _meta: { [MCP_CREDENTIAL_META]: cred } }); } catch (e) { mErr = e; }
      const mText = JSON.stringify(m1?.content || "");
      ok(!mErr && m1?.isError === true && !PR(m1) && !/"accepts"/.test(mText) && !m1._meta?.[MCP_PAYMENT_REQUIRED_META] && /Do not sign a new authorization/.test(mText) && (tx ? mText.includes(tx) : true),
        `${m} over MPP: a credential whose settle failed answers no challenge and no offer${tx ? ", and names the transaction" : ""} (${mErr ? mErr.message : mText.slice(0, 200)})`);
    }
    // The official client: one payment for the call, and no second signature.
    {
      const p2 = new x402Client();
      registerExactEvmScheme(p2, { signer: privateKeyToAccount(generatePrivateKey()) });
      const auto = new x402MCPClient(raw, p2, { autoPayment: true });
      for (const m of ["failedTx", "failedBare", "preBroadcast", "preBroadcastWords", "route500"]) {
        mode = m;
        const b4 = paidReplays;
        const o2 = await auto.callTool("catalog.call", { slug: "paid-x", params: {} });
        ok(paidReplays - b4 === 1 && o2.isError === true, `${m}: the official client pays once and does not sign again (${paidReplays - b4} paid replays)`);
      }
    }
    const payer = new x402Client();
    registerExactEvmScheme(payer, { signer: privateKeyToAccount(generatePrivateKey()) });
    const official = new x402MCPClient(raw, payer, { autoPayment: true });
    mode = "pending";
    const before = paidReplays;
    const o = await official.callTool("catalog.call", { slug: "paid-x", params: {} });
    ok(paidReplays - before === 1 && o.isError === true, `the official client pays once and does not sign again on a pending answer (${paidReplays - before} paid replays)`);
  } catch (e) {
    ok(false, e?.stack || String(e));
  } finally {
    try { await raw.close(); } catch { /* closed */ }
    httpSrv.closeAllConnections?.();
    await new Promise((r) => httpSrv.close(r));
  }
}

// ---- in-process half: the copy names only the wires this boot offers ---------------
// The initialize instructions, a paid tool's first ask, a free tool at its
// rate limit and payment.info, on three wirings: x402 alone, neither (the
// FREE_MODE boot: no paywall, no MPP gates) and MPP gates whose 402 carries
// no challenge. The booted half below checks both wires on.
{
  const { mountMcp } = await import("../src/mcp-http.js");
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const offerFor = (slug) => ({ x402Version: 2, error: "Payment required", resource: { url: `http://localhost/api/${slug}`, description: slug, mimeType: "application/json" }, accepts: [accepted] });
  // The x402 paywall: every unpaid call answers the route's offer.
  const x402Fetch = async (url) => {
    const slug = String(url).split("/api/")[1]?.split(/[?#]/)[0] || "paid-x";
    return new Response(JSON.stringify({ error: "Payment required" }), { status: 402, headers: { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(offerFor(slug)) } });
  };
  // MPP gates that mint no challenge: a bare 402, no WWW-Authenticate.
  let bareCalls = 0;
  const bareFetch = async () => (bareCalls++, new Response(JSON.stringify({ error: "Payment required" }), { status: 402, headers: { "content-type": "application/json" } }));
  const CAT = {
    "POST /api/paid-x": { route: "POST /api/paid-x", slug: "paid-x", name: "paid-x", category: "test", price: "$0.001", description: "paid-x test tool", tags: ["paid-x"], discovery: { inputSchema: { properties: {} }, input: {} }, handler: async () => { throw new Error("ran in-process"); } },
    // A run that can outlast the blocking wait: paid over MPP as a task, or on its HTTP route.
    "POST /api/long-x": { route: "POST /api/long-x", slug: "long-x", name: "long-x", category: "test", price: "$0.05", description: "long-x test tool", tags: ["long-x"], asyncProfile: { slow: true, maxSeconds: 600 }, discovery: { inputSchema: { properties: {} }, input: {} }, handler: async () => { throw new Error("ran in-process"); } },
    "POST /api/free-x": { route: "POST /api/free-x", slug: "free-x", name: "free-x", category: "test", price: "$0.001", description: "free-x test tool", tags: ["free-x"], discovery: { inputSchema: { properties: {} }, input: {} }, handler: async () => ({ ok: true }) },
  };
  const wirings = {
    "x402 only": { x402Loopback: createMcpMppLoopback({ port: 1, fetchImpl: x402Fetch }), mppLoopback: null },
    "neither (FREE_MODE)": { x402Loopback: null, mppLoopback: null },
    "MPP gates, no challenge": { x402Loopback: null, mppLoopback: createMcpMppLoopback({ port: 1, fetchImpl: bareFetch }) },
    // FREE_MODE with MPP_SECRET_KEY set: the boot's account (payWires) denies
    // both wires, so a loopback handed to the mount is never used.
    "loopbacks the boot's account denies": { x402Loopback: createMcpMppLoopback({ port: 1, fetchImpl: x402Fetch }), mppLoopback: createMcpMppLoopback({ port: 1, fetchImpl: bareFetch }), payWires: { x402: false, mpp: false, names: [], phrase: "" } },
  };
  const texts = (r) => (r?.content || []).map((c) => c.text || "").join("\n");
  for (const [label, loops] of Object.entries(wirings)) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    mountMcp(app, CAT, { baseUrl: "http://localhost", isComputePayable: (def) => def.slug === "free-x", ...loops });
    const httpSrv = app.listen(0, "127.0.0.1");
    await new Promise((r) => httpSrv.once("listening", r));
    const raw = new Client({ name: `copy-${label}`, version: "0.0.0" });
    try {
      await raw.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpSrv.address().port}/mcp`)));
      const x402 = Boolean(loops.x402Loopback) && loops.payWires?.x402 !== false;
      const mpp = Boolean(loops.mppLoopback) && loops.payWires?.mpp !== false;
      const bare0 = bareCalls;
      ok(Boolean(raw.getServerCapabilities()?.experimental?.payment) === mpp, `${label}: the payment capability is advertised ${mpp ? "with" : "only with"} the MPP wire (${JSON.stringify(raw.getServerCapabilities()?.experimental || null)})`);
      const infoDesc = String((await raw.listTools()).tools.find((t) => t.name === "payment.info")?.description || "");
      ok(/settle in USDC over x402/.test(infoDesc) && /over x402 or MPP/.test(infoDesc) === mpp && (x402 || mpp ? /payable here, in the call, over/.test(infoDesc) : !/payable here/.test(infoDesc)),
        `${label}: payment.info's listed description says "or MPP" ${mpp ? "" : "only "}where the connector takes MPP (${infoDesc.slice(0, 200)})`);
      // A long tool: never an x402 offer, never an invitation to sign one.
      const longAsk = await raw.callTool({ name: "catalog.call", arguments: { slug: "long-x", params: {} } });
      const longText = texts(longAsk);
      ok(longAsk.isError === true && !PR(longAsk)?.accepts && !/"accepts"/.test(longText) && !/over x402: sign|x402\/payment|RIGHT HERE over x402/.test(longText)
        && /Prefer: respond-async/.test(longText) && longText.includes("POST /api/long-x") && /not paid here over x402/.test(longText) === x402,
        `${label}: a long tool's first ask offers no x402 accepts and names its HTTP route as a job (${longText.slice(0, 260)})`);
      if (x402) {
        const signed = await raw.callTool({ name: "catalog.call", arguments: { slug: "long-x", params: {} }, _meta: { [X402_PAYMENT_META]: { x402Version: 2, accepted, payload: { signature: "0x00" } } } });
        ok(/^respond_async_required/.test(texts(signed)), `${label}: control: a signed x402 retry of the long tool is refused (${texts(signed).slice(0, 80)}), which is why the ask never invites one`);
        // A payment the reader refuses: the same refusal, never an offer.
        const unreadable = await raw.callTool({ name: "catalog.call", arguments: { slug: "long-x", params: {} }, _meta: { [X402_PAYMENT_META]: { x402Version: 1, accepted, payload: { signature: "0x00" } } } });
        ok(unreadable.isError === true && /^respond_async_required/.test(texts(unreadable)) && !PR(unreadable) && !/"accepts"/.test(texts(unreadable)), `${label}: a long tool called with an unreadable x402 payment gets the same refusal and no offer (${texts(unreadable).slice(0, 80)})`);
      }
      const wires = [x402 && "x402", mpp && "MPP"].filter(Boolean);
      const instructions = String(raw.getInstructions() || "");
      const hosted = instructions.split("\n").find((l) => l.startsWith("Hosted connector")) || "";
      ok(hosted.includes(wires.length ? `other tools paid in the call over ${wires.join(" or ")} from a wallet)` : "others need a wallet on the npm package)"),
        `${label}: the instructions' hosted line names ${wires.join(" and ") || "no in-call wire"} (${hosted.slice(0, 120)})`);
      const ask = await raw.callTool({ name: "catalog.call", arguments: { slug: "paid-x", params: {} } });
      const askText = texts(ask);
      ok(ask.isError === true && (x402 ? /Pay it RIGHT HERE over x402/.test(askText) && Array.isArray(PR(ask)?.accepts) : !/RIGHT HERE/.test(askText) && !/x402\/payment/.test(askText))
        && !/over MPP|org\.paymentauth/.test(askText) && /npx agent402-mcp/.test(askText),
        `${label}: a paid tool's first ask names ${x402 ? "x402 in the call" : "no in-call wire"} and never MPP (${askText.slice(0, 160)})`);
      let limited = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const r = await raw.callTool({ name: "catalog.call", arguments: { slug: "free-x", params: {} } });
        if (/rate limit reached/i.test(texts(r))) limited = r;
      }
      const limitText = texts(limited);
      ok(limited?.isError === true && (x402 ? /pay this call over x402/.test(limitText) && /x402\/payment/.test(limitText) && Array.isArray(PR(limited)?.accepts) : !/x402\/payment|pay this call over x402/.test(limitText) && !PR(limited)?.accepts)
        && !/MPP|org\.paymentauth/.test(limitText),
        `${label}: the rate-limit text names ${x402 ? "x402 in the call" : "no in-call wire"} (${limitText.slice(0, 200)})`);
      const info = await raw.callTool({ name: "payment.info", arguments: {} });
      const how = String(info.structuredContent?.freeTier?.how ?? JSON.parse(info.content?.[0]?.text || "{}").freeTier?.how ?? "");
      ok(how && (x402 ? /over x402/.test(how) && how.includes("x402/payment") : !/over x402|x402\/payment/.test(how)) && (mpp ? /over MPP/.test(how) : !/over MPP|org\.paymentauth/.test(how)),
        `${label}: payment.info names ${[x402 && "x402", mpp && "MPP"].filter(Boolean).join(" and ") || "no in-call wire"} (${how.slice(0, 160)})`);
      if (loops.payWires) ok(bareCalls === bare0, `${label}: no call reached a loopback (${bareCalls - bare0} MPP replays)`);
    } catch (e) {
      ok(false, `${label}: ${e?.stack || String(e)}`);
    } finally {
      try { await raw.close(); } catch { /* closed */ }
      httpSrv.closeAllConnections?.();
      await new Promise((r) => httpSrv.close(r));
    }
  }
}

// ---- booted half -------------------------------------------------------------------
const BASE_NET = "eip155:8453";
const TMP = mkdtempSync(join(tmpdir(), "mcp-x402-conn-"));
const SALES_DB = join(TMP, "sales.db");
const counts = { verify: 0, settle: 0 };
const stub = { settleFailTx: null, settleRefuse: null, verifyInvalid: null };
let txN = 0;
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") {
      counts.verify++;
      if (stub.verifyInvalid) { const reason = stub.verifyInvalid; stub.verifyInvalid = null; return reply({ isValid: false, invalidReason: reason, payer }); }
      return reply({ isValid: true, payer });
    }
    // A refusal that names no transaction; answered until the test clears it,
    // so a settle fallback asking the same stub reads the same refusal.
    if (req.url === "/settle" && stub.settleRefuse) { counts.settle++; return reply({ success: false, errorReason: stub.settleRefuse, transaction: "", network: BASE_NET, payer }); }
    if (req.url === "/settle" && stub.settleFailTx) { counts.settle++; const transaction = stub.settleFailTx; stub.settleFailTx = null; return reply({ success: false, errorReason: "transaction_failed", transaction, network: BASE_NET, payer }); }
    if (req.url === "/settle") { counts.settle++; return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: BASE_NET, payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
// The settle fallback (PAYMENT_SETTLE_FALLBACK): a second facilitator, asked
// only after the first one's refusal that names no transaction. `mode` is its
// answer to /settle: the same refusal, an HTTP 500, or a completed settle.
const fallback = { settles: 0, mode: "refuse" };
const fallbackFacilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") {
      fallback.settles++;
      if (fallback.mode === "500") return reply({ error: "internal error" }, 500);
      if (fallback.mode === "ok") return reply({ success: true, transaction: `0x${"fb".repeat(28)}${(++txN).toString(16).padStart(8, "0")}`, network: BASE_NET, payer });
      return reply({ success: false, errorReason: "free_tier_exhausted", transaction: "", network: BASE_NET, payer });
    }
    reply({});
  });
});
await new Promise((r) => fallbackFacilitator.listen(0, "127.0.0.1", r));
const FAC2 = `http://127.0.0.1:${fallbackFacilitator.address().port}`;
let srv = null;
const clients = [];
try {
  srv = await bootServer({
    stores: "mcp-x402-conn",
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, SOLVADOR_FACILITATOR_URL: FAC2, PAYMENT_SETTLE_FALLBACK: "true", AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "test-key", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "test-mcp-x402-conn-secret", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: SALES_DB, REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      // The free-tier limiter at 2 calls a minute per client, the transport
      // limiter at 12 requests a minute: each client below has its own address.
      AGENT402_MCP_MAX_PER_MIN: "2", AGENT402_MCP_MAX_PER_HOUR: "1000",
      AGENT402_MCP_REQ_PER_MIN: "12", AGENT402_MCP_REQ_PER_HOUR: "100000",
      AGENT402_MCP_PAID_REQ_PER_MIN: "30", AGENT402_MCP_PAID_REQ_PER_HOUR: "100000",
    },
  });
  const B = srv.url;
  const connect = async (ip, account = null) => {
    const raw = new Client({ name: "test-mcp-x402-connector", version: "0.0.0" });
    let client = raw;
    let payments = null;
    if (account) {
      payments = new x402Client();
      registerExactEvmScheme(payments, { signer: account });
      client = new x402MCPClient(raw, payments, { autoPayment: true });
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`), { requestInit: { headers: { "X-Forwarded-For": ip } } }));
    clients.push(client);
    return { client, raw, payments };
  };
  const [A, Bw] = [0, 1].map(() => privateKeyToAccount(generatePrivateKey()));
  const key = `conn-${Date.now()}`;

  // 1. First ask on a flagship: both wires on one result.
  // The reference SDK client lists the tools first, which arms its check of
  // every structuredContent against the tool's listed outputSchema (error
  // results included): each first ask must still be a result it reads.
  const plain = await connect("203.0.113.10");
  await plain.client.listTools();
  const lister = await connect("203.0.113.9"), lister2 = await connect("203.0.113.8");
  await lister2.client.listTools();
  const listedTools = (await lister.client.listTools()).tools;
  const strict = listedTools.filter((t) => t.outputSchema && ["web.search", "web.news", "web.answer", "market.quote", "browser.render", "audio.transcribe", "memory.write", "catalog.call"].includes(t.name));
  const unread = [];
  let unreadCalls = 0;
  for (const [name, args] of [["web.search", { q: "x402" }], ["web.news", { q: "x402" }], ["web.answer", { q: "x402" }], ["market.quote", { symbol: "AAPL" }], ["browser.render", { url: "https://example.com" }], ["audio.transcribe", { url: "https://example.com/a.mp3" }], ["memory.write", { key, value: 1 }], ["catalog.call", { slug: "search", params: { q: "x402" } }]]) {
    try {
      const r = await (unreadCalls++ < 4 ? lister : lister2).client.callTool({ name, arguments: args });
      if (!(r.isError === true && !("structuredContent" in r) && Array.isArray(PR(r)?.accepts) && Array.isArray(r._meta?.[MCP_PAYMENT_REQUIRED_META]?.challenges))) unread.push(`${name}: ${JSON.stringify(r).slice(0, 120)}`);
    } catch (e) { unread.push(`${name}: threw ${String(e?.message).slice(0, 120)}`); }
  }
  ok(strict.length === 8 && unread.length === 0, `the reference SDK client, tools listed, reads the first ask of every paid tool with an outputSchema: no structuredContent, the offer in the first text block, the MPP challenges in _meta (${unread.join(" | ") || "8 read"})`);
  const ask = await plain.client.callTool({ name: "memory.read", arguments: { key } });
  const pr = PR(ask);
  ok(ask.isError === true && !("structuredContent" in ask) && pr?.x402Version === 2 && Array.isArray(pr.accepts) && pr.accepts.some((a) => a.network === BASE_NET), `memory.read's first ask is an isError result whose first text block is a v2 PaymentRequired, with no structuredContent (${JSON.stringify(pr).slice(0, 120)})`);
  ok(pr?.resource?.url === "https://agent402.tools/mcp" && pr.extensions?.bazaar?.info?.input?.type === "mcp" && pr.extensions.bazaar.info.input.toolName === "memory.read", `it is the twin's offer: resource /mcp, an MCP extension for memory.read (${pr?.resource?.url})`);
  ok(JSON.stringify(JSON.parse(ask.content?.[0]?.text || "null")) === JSON.stringify(pr), "content[0].text is the same PaymentRequired as JSON");
  const mppAsk = ask._meta?.[MCP_PAYMENT_REQUIRED_META];
  ok(mppAsk?.httpStatus === 402 && Array.isArray(mppAsk.challenges) && mppAsk.challenges.some((c) => c.method === "evm" && c.intent === "charge"), `the MPP challenges ride unchanged in _meta (${(mppAsk?.challenges || []).map((c) => c.method).join(",")})`);
  ok(/agent402-mcp|credits/.test(JSON.stringify(ask.content.slice(1))), "the readable text naming the ways to pay follows the JSON block");
  // The copy names both wires this boot offers.
  const askText = ask.content.slice(1).map((c) => c.text || "").join("\n");
  ok(/Pay it RIGHT HERE over x402/.test(askText) && /Or pay it here over MPP/.test(askText), `the first ask's text names x402 first, then MPP (${askText.slice(0, 200)})`);
  const hostedLine = String(plain.client.getInstructions() || "").split("\n").find((l) => l.startsWith("Hosted connector")) || "";
  ok(hostedLine.includes("other tools paid in the call over x402 or MPP from a wallet)"), `the initialize instructions name x402 and MPP (${hostedLine.slice(0, 120)})`);
  const infoRes = await plain.client.callTool({ name: "payment.info", arguments: {} });
  const howBoth = String((infoRes.structuredContent || JSON.parse(infoRes.content?.[0]?.text || "{}")).freeTier?.how || "");
  ok(/payable in the call on this connector over x402/.test(howBoth) && howBoth.includes("_meta[\"x402/payment\"]") && /and over MPP/.test(howBoth), `payment.info names x402 and MPP (${howBoth.slice(0, 160)})`);
  const httpOffer = JSON.parse(Buffer.from((await fetch(`${B}/api/memory?key=x`)).headers.get("payment-required") || "", "base64").toString("utf8"));
  ok(JSON.stringify(pr.accepts) === JSON.stringify(httpOffer.accepts), "the twin's accepts are the HTTP route's");
  const catAsk = await plain.client.callTool({ name: "catalog.call", arguments: { slug: "memory-read", params: { key } } });
  ok(catAsk.isError === true && PR(catAsk)?.resource?.url === "https://agent402.tools/api/memory" && Array.isArray(catAsk._meta?.[MCP_PAYMENT_REQUIRED_META]?.challenges),
    `catalog.call's first ask offers the slug's own HTTP challenge (${PR(catAsk)?.resource?.url}) beside the MPP challenges`);

  // A long tool on the boot with both wires: the MPP challenges and the task
  // path, no x402 accepts (a signed x402 retry is refused, see the control).
  {
    const longAsk = await plain.client.callTool({ name: "catalog.call", arguments: { slug: "domain-audit", params: { domain: "example.com" } } });
    const longText = (longAsk.content || []).map((c) => c.text || "").join("\n");
    ok(longAsk.isError === true && !PR(longAsk)?.accepts && !/"accepts"/.test(longText) && !/RIGHT HERE over x402|x402\/payment/.test(longText) && Array.isArray(longAsk._meta?.[MCP_PAYMENT_REQUIRED_META]?.challenges),
      `a long tool's first ask (domain-audit) carries the MPP challenges and no x402 accepts (${longText.slice(0, 200)})`);
    ok(/not paid here over x402/.test(longText) && /Pay it RIGHT HERE over MPP as an MCP task/.test(longText) && /Prefer: respond-async/.test(longText), "its text names MPP as a task and the HTTP route as a job");
    const offerElsewhere = PR(await plain.client.callTool({ name: "memory.read", arguments: { key } }));
    const c1 = { ...counts };
    const signed = await plain.client.callTool({ name: "catalog.call", arguments: { slug: "domain-audit", params: { domain: "example.com" } }, _meta: { [X402_PAYMENT_META]: { x402Version: 2, accepted: offerElsewhere.accepts[0], payload: { signature: "0x00" } } } });
    ok(/^respond_async_required/.test(String(signed.content?.[0]?.text)) && counts.verify === c1.verify, `control: a signed x402 retry of domain-audit is refused before the paywall (${String(signed.content?.[0]?.text).slice(0, 60)})`);
    const unreadable = await plain.client.callTool({ name: "catalog.call", arguments: { slug: "domain-audit", params: { domain: "example.com" } }, _meta: { [X402_PAYMENT_META]: { x402Version: 1, accepted: offerElsewhere.accepts[0], payload: { signature: "0x00" } } } });
    ok(/^respond_async_required/.test(String(unreadable.content?.[0]?.text)) && !PR(unreadable) && !/"accepts"/.test(JSON.stringify(unreadable.content)) && counts.verify === c1.verify, `domain-audit called with an unreadable x402 payment gets the same refusal and no offer (${String(unreadable.content?.[0]?.text).slice(0, 60)})`);
    const listedInfo = listedTools.find((t) => t.name === "payment.info")?.description || "";
    ok(/settle in USDC over x402 or MPP \(payable here, in the call, over x402 or MPP\)/.test(listedInfo), `payment.info's listed description names x402 or MPP on this boot (${listedInfo.slice(0, 160)})`);
  }

  // 2. The official client pays: memory.write (no twin: the HTTP route), then memory.read on the twin.
  const payA = await connect("203.0.113.11", A);
  await payA.raw.listTools(); // output validation armed under the official client too
  let c0 = { ...counts };
  const wrote = await payA.client.callTool("memory.write", { key, value: { hello: "x402" } });
  ok(wrote.paymentMade === true && wrote.isError !== true && wrote.paymentResponse?.success === true && counts.verify === c0.verify + 1 && counts.settle === c0.settle + 1,
    `the official client pays memory.write (no twin) on its HTTP route: output and receipt, one verify, one settle (${counts.verify - c0.verify}/${counts.settle - c0.settle}) ${wrote.isError ? JSON.stringify(wrote.content).slice(0, 300) : ""}`);
  c0 = { ...counts };
  const read = await payA.client.callTool("memory.read", { key });
  const readText = JSON.stringify(read.content || "");
  ok(read.paymentMade === true && read.isError !== true && readText.includes("x402") && readText.includes("hello"), `the official client pays memory.read on the twin and gets the tool output (${readText.slice(0, 160)})`);
  ok(read.paymentResponse?.success === true && read.paymentResponse.payer?.toLowerCase() === A.address.toLowerCase() && /^0x[0-9a-f]{64}$/.test(read.paymentResponse.transaction) && read.paymentResponse.network === BASE_NET,
    `the settle receipt rides in _meta["${X402_PAYMENT_RESPONSE_META}"] naming the payer (${JSON.stringify(read.paymentResponse)})`);
  ok(counts.verify === c0.verify + 1 && counts.settle === c0.settle + 1, `one verify and one settle for it (${counts.verify - c0.verify}/${counts.settle - c0.settle})`);

  // 3. Payer attribution: another wallet reads nothing, and its error is not settled.
  const payB = await connect("203.0.113.12", Bw);
  c0 = { ...counts };
  const other = await payB.client.callTool("memory.read", { key });
  const otherText = JSON.stringify(other.content || "");
  ok(other.isError === true && !otherText.includes("x402\\\"") && !/"hello"/.test(otherText) && /not charged/.test(otherText) && !other.paymentResponse,
    `another wallet's memory.read does not see the writer's value and is an error, not charged (${otherText.slice(0, 160)})`);
  ok(counts.verify === c0.verify + 1 && counts.settle === c0.settle, `its payment was verified and never settled (${counts.verify - c0.verify}/${counts.settle - c0.settle})`);

  // 4. Replay: the same payment sent twice is answered once and refused unsettled.
  const offer = PR(await plain.client.callTool({ name: "memory.read", arguments: { key } }));
  const once = await payA.payments.createPaymentPayload(offer);
  const sendRaw = (c, payment, args = { key }, name = "memory.read", extraMeta = {}) => c.callTool({ name, arguments: args, _meta: { [X402_PAYMENT_META]: payment, ...extraMeta } });
  c0 = { ...counts };
  const first = await sendRaw(payA.raw, once);
  ok(first.isError !== true && first._meta?.[X402_PAYMENT_RESPONSE_META]?.success === true && counts.settle === c0.settle + 1, `a payment sent by hand settles once (${counts.settle - c0.settle}) ${first.isError ? JSON.stringify(first.content).slice(0, 200) : ""}`);
  const again = await sendRaw(payA.raw, once);
  ok(again.isError === true && !again._meta?.[X402_PAYMENT_RESPONSE_META] && counts.settle === c0.settle + 1 && !JSON.stringify(again.content).includes("hello"),
    `the same payment sent again is refused, unsettled, with no output (${JSON.stringify(again.content).slice(0, 200)})`);

  // 5. A settle that fails naming a transaction (it may have landed): the
  // route's 402 through the real paywall is answered with no offer, the
  // transaction to watch and none of the tool's output.
  const FAIL_TX = `0x${"9b".repeat(32)}`;
  stub.settleFailTx = FAIL_TX;
  c0 = { ...counts };
  const failedSettle = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
  const fsText = JSON.stringify(failedSettle.content || "");
  ok(counts.settle === c0.settle + 1 && failedSettle.isError === true && !PR(failedSettle) && !/"accepts"/.test(fsText) && /Do not sign a new authorization/.test(fsText) && fsText.includes(FAIL_TX)
    && failedSettle._meta?.[SETTLEMENT_PENDING_META]?.transactions?.[0] === FAIL_TX,
    `a settle that failed naming a transaction answers no offer and the transaction to watch (${fsText.slice(0, 240)})`);
  ok(!fsText.includes("hello") && failedSettle._meta?.[X402_PAYMENT_RESPONSE_META]?.success === false, "it carries none of the tool's output and the failed receipt");
  // The official client, paying automatically: one payment, no second one.
  stub.settleFailTx = `0x${"9c".repeat(32)}`;
  c0 = { ...counts };
  const autoFailed = await payA.client.callTool("memory.read", { key });
  ok(autoFailed.isError === true && counts.verify === c0.verify + 1 && counts.settle === c0.settle + 1 && stub.settleFailTx === null,
    `the official client signs once for a settle that failed naming a transaction (${counts.verify - c0.verify} verifies, ${counts.settle - c0.settle} settles)`);
  // The first facilitator's refusal names no transaction (a billing refusal
  // on this server's account), so the settle fallback is asked. Whatever it
  // answers short of a completed settle, the route's receipt is the first
  // refusal: no offer, nothing to sign, none of the tool's output.
  const noOffer = (r) => {
    const t = JSON.stringify(r.content || "");
    return r.isError === true && !("structuredContent" in r) && !PR(r) && !/"accepts"|x402Version/.test(t + JSON.stringify(r._meta || {})) && !r._meta?.[MCP_PAYMENT_REQUIRED_META]
      && /Do not sign a new authorization for this call/.test(t) && !t.includes("hello") && r._meta?.[X402_PAYMENT_RESPONSE_META]?.success === false;
  };
  for (const [mode, what] of [["refuse", "refused by the first facilitator and by the fallback, no transaction named"], ["500", "refused by the first facilitator, then answered 500 by the fallback"]]) {
    stub.settleRefuse = "free_tier_exhausted";
    fallback.mode = mode;
    c0 = { ...counts };
    let f0 = fallback.settles;
    const refused = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
    ok(counts.settle === c0.settle + 1 && fallback.settles === f0 + 1 && noOffer(refused),
      `a settle ${what} answers no offer in text, structuredContent or _meta, and says not to sign again (${counts.settle - c0.settle} + ${fallback.settles - f0} settle calls; ${JSON.stringify(refused.content).slice(0, 240)})`);
    // The official client, paying automatically: one signature for the call.
    c0 = { ...counts };
    f0 = fallback.settles;
    const auto = await payA.client.callTool("memory.read", { key });
    ok(auto.isError === true && counts.verify === c0.verify + 1 && counts.settle === c0.settle + 1 && fallback.settles === f0 + 1 && !JSON.stringify(auto.content).includes("hello"),
      `the official client signs once for a settle ${what} (${counts.verify - c0.verify} verifies, ${counts.settle - c0.settle} + ${fallback.settles - f0} settle calls)`);
  }
  // Control: the fallback is live. The same refusal, completed by the
  // fallback, is a paid answer with the fallback's receipt.
  {
    fallback.mode = "ok";
    c0 = { ...counts };
    const f0 = fallback.settles;
    const recovered = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
    stub.settleRefuse = null;
    fallback.mode = "refuse";
    const receipt = recovered._meta?.[X402_PAYMENT_RESPONSE_META];
    ok(recovered.isError !== true && JSON.stringify(recovered.content).includes("hello") && receipt?.success === true && /^0xfb/.test(String(receipt.transaction)) && fallback.settles === f0 + 1,
      `control: the same refusal completed by the fallback is served with the fallback's receipt in _meta (${JSON.stringify(receipt)})`);
  }

  // 6. Invalid payments: the reader's refusal and the facilitator's.
  c0 = { ...counts };
  const badShape = await sendRaw(payA.raw, { ...once, x402Version: 1 });
  ok(badShape.isError === true && PR(badShape)?.error === "unsupported_version" && PR(badShape)?.resource?.url === "https://agent402.tools/mcp" && counts.verify === c0.verify,
    `a payment the reader refuses returns a fresh offer naming the reason, nothing verified (${PR(badShape)?.error})`);
  stub.verifyInvalid = "invalid_exact_evm_payload_signature";
  const badSig = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
  ok(badSig.isError === true && Array.isArray(PR(badSig)?.accepts) && /invalid/i.test(String(PR(badSig)?.error)) && counts.settle === c0.settle,
    `a payment the facilitator refuses returns the invalid-payment result, unsettled (${PR(badSig)?.error})`);

  // 7. MPP wins when both ride along: a tampered MPP credential is refused as
  // MPP (-32043) and the x402 payment beside it is never read.
  {
    const evmCh = mppAsk.challenges.find((c) => c.method === "evm");
    const tampered = { challenge: { ...evmCh, id: "x".repeat(evmCh.id.length) }, payload: { from: A.address, to: "0x000000000000000000000000000000000000dEaD", value: evmCh.request.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${"77".repeat(32)}`, signature: `0x${"11".repeat(65)}`, type: "authorization" } };
    c0 = { ...counts };
    let err = null;
    try { await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer), { key }, "memory.read", { [MCP_CREDENTIAL_META]: tampered }); } catch (e) { err = e; }
    ok(err?.code === -32043 && counts.verify === c0.verify && counts.settle === c0.settle, `an MPP credential beside an x402 payment is decided by MPP (code ${err?.code}), the x402 payment is not presented (${counts.verify - c0.verify} verifies)`);
  }

  // 8. A free tool at its limit offers its own x402 challenge; paying serves it.
  {
    const free = await connect("203.0.113.30");
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await free.client.callTool({ name: "catalog.call", arguments: { slug: "uuid", params: {} } }));
    ok(runs[0].isError !== true && runs[1].isError !== true, "a free tool runs free under its limit");
    const limited = runs[2];
    ok(limited.isError === true && PR(limited)?.x402Version === 2 && PR(limited).resource?.url === "https://agent402.tools/api/uuid" && /rate limit reached/i.test(JSON.stringify(limited.content)),
      `at its limit it offers the route's x402 challenge with the limit text (${PR(limited)?.resource?.url})`);
    const limitedText = (limited.content || []).map((c) => c.text || "").join("\n");
    ok(/pay this call over x402/.test(limitedText) && limitedText.includes("_meta[\"x402/payment\"]"), `the limit text says how to pay this call over x402 (${limitedText.slice(0, 200)})`);
    const payer = await connect("203.0.113.30", A);
    c0 = { ...counts };
    const paid = await payer.client.callTool("catalog.call", { slug: "uuid", params: {} });
    ok(paid.paymentMade === true && paid.isError !== true && paid.paymentResponse?.success === true && counts.settle === c0.settle + 1 && JSON.stringify(paid.content).includes("uuid"),
      `a client that pays is served past the limit, with a receipt (${counts.settle - c0.settle} settle) ${paid.isError ? JSON.stringify(paid.content).slice(0, 200) : ""}`);
  }

  // 9. The transport limiter. A payment-carrying call has its own, larger
  // per-IP limit only when it reaches a paywall replay with a payment that
  // decodes; every other call (a junk credential, a payment on a free
  // discovery tool or an unknown tool) meets the normal one. Inside the
  // handler that refusal is an error result, at the transport a 429.
  {
    const post = (ip, name, meta, args = {}) => fetch(`${B}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ip, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
    }).then(async (r) => {
      const t = await r.text();
      return r.status === 429 || /Too many requests/.test(t) ? "limited" : r.status;
    });
    const burst = async (ip, name, meta, n = 20, args = {}) => { const out = []; for (let i = 0; i < n; i++) out.push(await post(ip, name, meta, args)); return out; };
    const limitedAfter12 = (s) => s.slice(0, 12).every((x) => x === 200) && s.slice(12).every((x) => x === "limited");
    const fakeX402 = await payA.payments.createPaymentPayload(offer);
    const junk = { ...fakeX402, payload: { ...fakeX402.payload, signature: "0x00" } };
    const probes = [
      ["no payment", "catalog.find", null, { task: "uuid" }],
      ["an MPP credential \"x\"", "catalog.find", { [MCP_CREDENTIAL_META]: "x" }, { task: "uuid" }],
      ["an x402 payment signed 0x00", "catalog.find", { [X402_PAYMENT_META]: junk }, { task: "uuid" }],
      ["an x402 payment signed 0x00", "catalog.search", { [X402_PAYMENT_META]: junk }, { query: "uuid" }],
      ["an x402 payment signed 0x00", "server.describe", { [X402_PAYMENT_META]: junk }, {}],
      ["a real x402 payment", "no.such.tool", { [X402_PAYMENT_META]: fakeX402 }, {}],
    ];
    let n = 40;
    for (const [what, name, meta, args] of probes) {
      const s = await burst(`203.0.113.${n++}`, name, meta, 20, args);
      ok(limitedAfter12(s), `${name} with ${what}: 12 served, then limited like no payment (${s.join(",")})`);
    }
    // A real paid call is not throttled by that limit: 20 paid memory.read
    // calls from one address, each signed afresh, all served and settled.
    const paidIp = "203.0.113.60";
    const payIn = await connect(paidIp);
    const c9 = { ...counts };
    const served = [];
    for (let i = 0; i < 20; i++) {
      const r = await sendRaw(payIn.client, await payA.payments.createPaymentPayload(offer));
      served.push(r.isError !== true && r._meta?.[X402_PAYMENT_RESPONSE_META]?.success === true);
    }
    ok(served.every(Boolean) && counts.settle - c9.settle === 20, `20 paid calls from one address pass the 12/min limit, each settled (${served.filter(Boolean).length} served, ${counts.settle - c9.settle} settles)`);
    // ...and has its own ceiling (30/min here): a payment that decodes is
    // bounded too, never unlimited.
    const replay = await payA.payments.createPaymentPayload(offer);
    const capped = await burst("203.0.113.61", "memory.read", { [X402_PAYMENT_META]: replay }, 34, { key });
    ok(capped.slice(0, 30).every((x) => x === 200) && capped.slice(30).every((x) => x === "limited"), `payment-carrying calls meet their own per-IP limit (${capped.filter((x) => x === "limited").length} of 34 limited)`);
  }

  // 10. A twin's sale books x402-mcp, its slug and the x402 wire.
  let rows = [];
  for (let i = 0; i < 40; i++) {
    try { const d = new Database(SALES_DB, { readonly: true }); rows = d.prepare("SELECT payer, via, slug, wire FROM sales ORDER BY id").all(); d.close(); } catch { rows = []; }
    if (rows.some((r) => r.slug === "memory-read")) break;
    await sleep(100);
  }
  const twinRow = rows.find((r) => r.slug === "memory-read");
  const writeRow = rows.find((r) => r.slug === "memory-write");
  ok(twinRow?.via === "x402-mcp" && twinRow.wire === "x402" && String(twinRow.payer).toLowerCase() === A.address.toLowerCase(), `memory.read paid on the twin books slug memory-read, wire x402, path x402-mcp (${JSON.stringify(twinRow)})`);
  ok(writeRow && writeRow.via !== "x402-mcp", `memory.write paid on its HTTP route books its own path (${JSON.stringify(writeRow)})`);
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  for (const c of clients) { try { await c.close(); } catch { /* closed */ } }
  await srv?.stop();
  facilitator.closeAllConnections?.();
  await new Promise((r) => facilitator.close(r));
  fallbackFacilitator.closeAllConnections?.();
  await new Promise((r) => fallbackFacilitator.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
