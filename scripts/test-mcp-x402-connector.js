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
//     structuredContent and the MPP challenges in _meta;
//   - the official client pays it and gets the tool output and the settle
//     receipt in _meta["x402/payment-response"]; one verify, one settle;
//   - catalog.call and a flagship with no twin are paid on the slug's own
//     HTTP route and challenge;
//   - memory.read is keyed on the signed payer: the writer reads its value,
//     another wallet does not (and its error answer is not settled);
//   - a payment sent twice is refused the second time, unsettled;
//   - a settle that fails returns the settlement-failed result, no tool output;
//   - a payment the reader refuses, and one the facilitator refuses, return
//     the invalid-payment result (a fresh offer, the reason named);
//   - an MPP credential beside an x402 payment: MPP decides, x402 is not read;
//   - a free tool at its rate limit offers its x402 challenge, and a client
//     that pays is served past the limit;
//   - a tools/call carrying a payment skips the per-IP transport limiter, an
//     unpaid one does not;
//   - a twin's sale books the arrival path x402-mcp.
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
const { X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META } = await import("../src/mcp-x402.js");
const { MCP_PAYMENT_REQUIRED_META, MCP_CREDENTIAL_META } = await import("../src/mcp-mpp.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- module half: which calls carry a payment -------------------------------------
{
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: {} };
  const payment = { x402Version: 2, accepted, payload: { signature: "0x00" } };
  const call = (meta) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web.search", arguments: {}, ...(meta ? { _meta: meta } : {}) } });
  ok(carriesPayment(call({ [X402_PAYMENT_META]: payment })), "a tools/call with an x402 payment the reader accepts carries a payment");
  ok(carriesPayment(call({ [MCP_CREDENTIAL_META]: "Payment abc" })), "a tools/call with an MPP credential carries a payment");
  ok(!carriesPayment(call(null)) && !carriesPayment(call({ progressToken: 1 })), "an unpaid tools/call does not");
  ok(!carriesPayment(call({ [X402_PAYMENT_META]: { ...payment, x402Version: 1 } })) && !carriesPayment(call({ [X402_PAYMENT_META]: "x" })), "a payment the reader refuses does not");
  ok(!carriesPayment({ method: "initialize", params: { _meta: { [X402_PAYMENT_META]: payment } } }) && !carriesPayment(null) && !carriesPayment("x"), "anything but a tools/call does not");
  const hostile = call({});
  Object.defineProperty(hostile.params._meta, X402_PAYMENT_META, { enumerable: true, get() { throw new Error("boom"); } });
  ok(carriesPayment(hostile) === false, "a getter that throws reads as no payment");
}

// ---- booted half -------------------------------------------------------------------
const BASE_NET = "eip155:8453";
const TMP = mkdtempSync(join(tmpdir(), "mcp-x402-conn-"));
const SALES_DB = join(TMP, "sales.db");
const counts = { verify: 0, settle: 0 };
const stub = { settleFailTx: null, verifyInvalid: null };
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
    if (req.url === "/settle" && stub.settleFailTx) { counts.settle++; const transaction = stub.settleFailTx; stub.settleFailTx = null; return reply({ success: false, errorReason: "transaction_failed", transaction, network: BASE_NET, payer }); }
    if (req.url === "/settle") { counts.settle++; return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: BASE_NET, payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
let srv = null;
const clients = [];
try {
  srv = await bootServer({
    stores: "mcp-x402-conn",
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "test-mcp-x402-conn-secret", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: SALES_DB, REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      // The free-tier limiter at 2 calls a minute per client, the transport
      // limiter at 12 requests a minute: each client below has its own address.
      AGENT402_MCP_MAX_PER_MIN: "2", AGENT402_MCP_MAX_PER_HOUR: "1000",
      AGENT402_MCP_REQ_PER_MIN: "12", AGENT402_MCP_REQ_PER_HOUR: "100000",
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
  const plain = await connect("203.0.113.10");
  const ask = await plain.client.callTool({ name: "memory.read", arguments: { key } });
  const pr = ask.structuredContent;
  ok(ask.isError === true && pr?.x402Version === 2 && Array.isArray(pr.accepts) && pr.accepts.some((a) => a.network === BASE_NET), `memory.read's first ask is an isError result whose structuredContent is a v2 PaymentRequired (${JSON.stringify(pr).slice(0, 120)})`);
  ok(pr?.resource?.url === "https://agent402.tools/mcp" && pr.extensions?.bazaar?.info?.input?.type === "mcp" && pr.extensions.bazaar.info.input.toolName === "memory.read", `it is the twin's offer: resource /mcp, an MCP extension for memory.read (${pr?.resource?.url})`);
  ok(JSON.stringify(JSON.parse(ask.content?.[0]?.text || "null")) === JSON.stringify(pr), "content[0].text is the same PaymentRequired as JSON");
  const mppAsk = ask._meta?.[MCP_PAYMENT_REQUIRED_META];
  ok(mppAsk?.httpStatus === 402 && Array.isArray(mppAsk.challenges) && mppAsk.challenges.some((c) => c.method === "evm" && c.intent === "charge"), `the MPP challenges ride unchanged in _meta (${(mppAsk?.challenges || []).map((c) => c.method).join(",")})`);
  ok(/agent402-mcp|credits/.test(JSON.stringify(ask.content.slice(1))), "the readable text naming the ways to pay follows the JSON block");
  const httpOffer = JSON.parse(Buffer.from((await fetch(`${B}/api/memory?key=x`)).headers.get("payment-required") || "", "base64").toString("utf8"));
  ok(JSON.stringify(pr.accepts) === JSON.stringify(httpOffer.accepts), "the twin's accepts are the HTTP route's");
  const catAsk = await plain.client.callTool({ name: "catalog.call", arguments: { slug: "memory-read", params: { key } } });
  ok(catAsk.isError === true && catAsk.structuredContent?.resource?.url === "https://agent402.tools/api/memory" && Array.isArray(catAsk._meta?.[MCP_PAYMENT_REQUIRED_META]?.challenges),
    `catalog.call's first ask offers the slug's own HTTP challenge (${catAsk.structuredContent?.resource?.url}) beside the MPP challenges`);

  // 2. The official client pays: memory.write (no twin: the HTTP route), then memory.read on the twin.
  const payA = await connect("203.0.113.11", A);
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
  const offer = (await plain.client.callTool({ name: "memory.read", arguments: { key } })).structuredContent;
  const once = await payA.payments.createPaymentPayload(offer);
  const sendRaw = (c, payment, args = { key }, name = "memory.read", extraMeta = {}) => c.callTool({ name, arguments: args, _meta: { [X402_PAYMENT_META]: payment, ...extraMeta } });
  c0 = { ...counts };
  const first = await sendRaw(payA.raw, once);
  ok(first.isError !== true && first._meta?.[X402_PAYMENT_RESPONSE_META]?.success === true && counts.settle === c0.settle + 1, `a payment sent by hand settles once (${counts.settle - c0.settle}) ${first.isError ? JSON.stringify(first.content).slice(0, 200) : ""}`);
  const again = await sendRaw(payA.raw, once);
  ok(again.isError === true && !again._meta?.[X402_PAYMENT_RESPONSE_META] && counts.settle === c0.settle + 1 && !JSON.stringify(again.content).includes("hello"),
    `the same payment sent again is refused, unsettled, with no output (${JSON.stringify(again.content).slice(0, 200)})`);

  // 5. A settle that fails: the settlement-failed result, none of the tool's output.
  stub.settleFailTx = `0x${"9b".repeat(32)}`;
  c0 = { ...counts };
  const failedSettle = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
  const fsText = JSON.stringify(failedSettle.content || "");
  ok(counts.settle === c0.settle + 1 && failedSettle.isError === true && /^Payment settlement failed/.test(String(failedSettle.structuredContent?.error)) && Array.isArray(failedSettle.structuredContent?.accepts),
    `a failed settle answers the settlement-failed result (${failedSettle.structuredContent?.error})`);
  ok(!fsText.includes("hello") && failedSettle._meta?.[X402_PAYMENT_RESPONSE_META]?.success !== true, "it carries none of the tool's output and no success receipt");

  // 6. Invalid payments: the reader's refusal and the facilitator's.
  c0 = { ...counts };
  const badShape = await sendRaw(payA.raw, { ...once, x402Version: 1 });
  ok(badShape.isError === true && badShape.structuredContent?.error === "unsupported_version" && badShape.structuredContent?.resource?.url === "https://agent402.tools/mcp" && counts.verify === c0.verify,
    `a payment the reader refuses returns a fresh offer naming the reason, nothing verified (${badShape.structuredContent?.error})`);
  stub.verifyInvalid = "invalid_exact_evm_payload_signature";
  const badSig = await sendRaw(payA.raw, await payA.payments.createPaymentPayload(offer));
  ok(badSig.isError === true && Array.isArray(badSig.structuredContent?.accepts) && /invalid/i.test(String(badSig.structuredContent?.error)) && counts.settle === c0.settle,
    `a payment the facilitator refuses returns the invalid-payment result, unsettled (${badSig.structuredContent?.error})`);

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
    ok(limited.isError === true && limited.structuredContent?.x402Version === 2 && limited.structuredContent.resource?.url === "https://agent402.tools/api/uuid" && /rate limit reached/i.test(JSON.stringify(limited.content)),
      `at its limit it offers the route's x402 challenge with the limit text (${limited.structuredContent?.resource?.url})`);
    const payer = await connect("203.0.113.30", A);
    c0 = { ...counts };
    const paid = await payer.client.callTool("catalog.call", { slug: "uuid", params: {} });
    ok(paid.paymentMade === true && paid.isError !== true && paid.paymentResponse?.success === true && counts.settle === c0.settle + 1 && JSON.stringify(paid.content).includes("uuid"),
      `a client that pays is served past the limit, with a receipt (${counts.settle - c0.settle} settle) ${paid.isError ? JSON.stringify(paid.content).slice(0, 200) : ""}`);
  }

  // 9. The transport limiter: a paid tools/call skips it, an unpaid one does not.
  {
    const post = (ip, meta) => fetch(`${B}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ip, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no.such.tool", arguments: {}, ...(meta ? { _meta: meta } : {}) } }),
    }).then(async (r) => { await r.arrayBuffer(); return r.status; });
    const payment = await payA.payments.createPaymentPayload(offer);
    const paidStatuses = [];
    for (let i = 0; i < 20; i++) paidStatuses.push(await post("203.0.113.40", { [X402_PAYMENT_META]: payment }));
    ok(paidStatuses.every((s) => s === 200), `20 paid tools/call requests from one address pass a 12/min transport limit (${[...new Set(paidStatuses)].join(",")})`);
    const unpaid = [];
    for (let i = 0; i < 20; i++) unpaid.push(await post("203.0.113.41", null));
    ok(unpaid.includes(429) && unpaid.slice(0, 12).every((s) => s === 200), `control: unpaid ones are refused past it (${unpaid.filter((s) => s === 429).length} x 429)`);
    const junk = [];
    for (let i = 0; i < 20; i++) junk.push(await post("203.0.113.42", { [X402_PAYMENT_META]: { x402Version: 1 } }));
    ok(junk.includes(429), "a payment the reader refuses does not skip it");
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
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
