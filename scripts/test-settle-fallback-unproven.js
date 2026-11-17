#!/usr/bin/env node
// A settle chain that a fallback stops on an answer that does not prove
// nothing was sent, through the real paywall (src/payments.js) and the hosted
// connector's x402 wire (src/mcp-http.js).
//
//   node scripts/test-settle-fallback-unproven.js
//
// Boots the REAL server in paid mode (Base) with PAYMENT_SETTLE_FALLBACK on,
// against two stub facilitators: the primary and its settle fallback. The
// primary refuses on billing (a refusal made before anything
// is signed), so the fallback is asked. Each case is driven twice, once on
// the HTTP route and once over /mcp (catalog.call on the same route):
//   - the fallback answers an HTTP 500, resets the connection, fails naming a
//     transaction, or answers an HTTP 200 whose body cannot be read: the
//     chain stops there. The 402 carries no offer, does not say the call was
//     not charged, says not to sign a new authorization, names the
//     transaction when one was named, and its receipt no longer reads as the
//     primary's billing refusal; the authorization (or the named transaction)
//     is booked for the late-settlement read. The connector answers no offer;
//   - control: every fallback also refuses on billing: the 402 is the billing
//     refusal and the connector returns a fresh offer;
//   - control: the fallback settles: one settlement, a 200 with its receipt;
//   - the primary itself answers an HTTP 200 with an unreadable body: neither
//     surface says the call was not charged, both say not to sign again;
//   - a fallback's graceful verdict about the buyer's payment with no
//     transaction is a decided answer: the earlier refusal stands, nothing is
//     booked (control: a used authorization stays unconfirmed);
//   - one wallet through fourteen unconfirmed settles is never refused 429,
//     holds at most its bound of bookings, and is served once the
//     facilitators recover;
//   - the same payment sent again: answered unconfirmed with no handler run
//     while the book names it; settled once after a pass read its
//     authorization as unused; answered with the owed record once its
//     transfer landed.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { bootServer } from "./lib/boot-server.js";

const { X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META, SETTLEMENT_PENDING_META, paymentRequiredOfResult: PR } = await import("../src/mcp-x402.js");
const { isPreBroadcastSettleRejection, isUnreadableSettleAnswer } = await import("../src/payments.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_NET = "eip155:8453";

// ---- module half: the refusal, the receipt and the gate --------------------------
{
  const { unprovenSettleRefusal, unprovenSettleReceipt, withPendingSettleRefusal, REJECTION_REASONS } = await import("../src/payment-reject.js");
  const TX = `0x${"ab".repeat(32)}`;
  const NOT_CHARGED = /not charged|nothing (?:was|is) charged|never charged/i;
  const none = unprovenSettleRefusal({ network: BASE_NET, booked: true });
  ok(none.reason === "settlement-unconfirmed" && none.retry === "check-wallet" && !("transactions" in none) && none.network === BASE_NET
    && /Do not sign a new authorization/.test(none.detail) && /booked as owed/.test(none.detail) && !NOT_CHARGED.test(none.detail),
    `no transaction named: check-wallet, do not sign again, owed when it lands (${none.detail.slice(0, 120)})`);
  ok(!/owed/.test(unprovenSettleRefusal({ network: BASE_NET, booked: false }).detail), "nothing booked: the refusal promises no repayment");
  const named = unprovenSettleRefusal({ network: BASE_NET, transactions: [TX.toUpperCase().replace("0X", "0x"), "0x12", null], booked: true });
  ok(named.retry === "watch-transaction" && JSON.stringify(named.transactions) === JSON.stringify([TX]) && /Watch the transaction listed/.test(named.detail) && !NOT_CHARGED.test(named.detail),
    `a transaction named: watch-transaction, the hash lowercased, malformed entries dropped (${JSON.stringify(named.transactions)})`);
  ok(unprovenSettleRefusal({ network: "<script>" }).network === null, "a network that is not a CAIP-2 id is not echoed");
  const merged = withPendingSettleRefusal({ error: "Payment rail temporarily unavailable", reason: "facilitator-quota", retry: "other-network", hint: "Nothing was charged.", transactions: ["0xold"], altPayment: { protocol: "proof-of-work" } }, none);
  ok(merged.reason === "settlement-unconfirmed" && merged.retry === "check-wallet" && merged.error === undefined && !("transactions" in merged) && merged.altPayment && !NOT_CHARGED.test(JSON.stringify(merged)),
    `merged over a billing refusal's body: its error, hint, retry and transactions are replaced (${JSON.stringify(merged).slice(0, 140)})`);
  const billing = { success: false, errorReason: "free_tier_exhausted", errorMessage: "Settlement refused: free_tier_exhausted", payer: "0xabc", network: BASE_NET, transaction: "" };
  const restated = unprovenSettleReceipt(billing, { transaction: TX });
  ok(isPreBroadcastSettleRejection(billing) === true && isPreBroadcastSettleRejection(restated) === false && restated.success === false && restated.payer === "0xabc" && restated.network === BASE_NET && restated.transaction === TX
    && !/free_tier/.test(JSON.stringify(restated)), `a billing receipt restated is not read as nothing sent, payer and network kept (${JSON.stringify(restated)})`);
  ok(isPreBroadcastSettleRejection(unprovenSettleReceipt(billing)) === false && unprovenSettleReceipt(billing).transaction === "", "restated with no transaction: still not read as nothing sent");
  ok(unprovenSettleReceipt({ success: true, transaction: TX }) === null && unprovenSettleReceipt(null) === null, "a settled receipt, or none, is never restated");
  const unreadable = Object.assign(new Error("Facilitator settle returned invalid JSON: insufficient_credits free_tier_exhausted"), { name: "FacilitatorResponseError" });
  ok(isUnreadableSettleAnswer(unreadable) && isPreBroadcastSettleRejection(unreadable) === false && isPreBroadcastSettleRejection(new Error("insufficient_credits")) === true,
    "an unreadable settle answer is never a refusal made before sending, whatever words its excerpt carries (control: the same words as a refusal are)");
  ok(REJECTION_REASONS.some((r) => r.reason === "settlement-unconfirmed" && /check-wallet/.test(r.means) && /watch-transaction/.test(r.means) && !NOT_CHARGED.test(r.means)), "the published reason names both retry verbs");
}

const TMP = mkdtempSync(join(tmpdir(), "settle-fallback-unproven-"));
const LATE = join(TMP, "late.json");
// The transaction a failing fallback names for a payment: one per authorization.
const failTxOf = (nonce) => `0x${createHash("sha256").update(`fallback:${String(nonce).toLowerCase()}`).digest("hex")}`;
// primary: billing | ok | garbage200.  fallback: 500 | reset | tx | garbage200 | billing | ok
// | verdict | expired-words | used.
const st = { primary: "billing", fallback: "500" };
// The chain the late-settlement pass reads. dark: an authorization's state
// and a receipt cannot be read (so nothing is proven either way). used:
// nonce -> { tx, receipt } for an authorization a transfer consumed.
const chain = { dark: true, used: new Map() };
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const counts = { primary: 0, fallback: 0, verify: 0 };
let txN = 0;
const stub = (name) => createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: name === "primary" ? [{ x402Version: 2, scheme: "exact", network: BASE_NET }] : [], extensions: [], signers: {} });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    if (req.url === "/rpc") {
      const out = (result) => reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, result });
      const dark = () => reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, error: { message: "stub chain not readable" } });
      const p0 = parsed.params?.[0];
      if (parsed.method === "eth_call") {
        const data = String(p0?.data || "");
        if (data.startsWith("0xe94a0102")) return chain.dark ? dark() : out(word(chain.used.has(`0x${data.slice(-64)}`.toLowerCase()) ? 1 : 0));
        if (data.startsWith("0x313ce567")) return out(word(6));
        return out("0x0");
      }
      if (parsed.method === "eth_getTransactionReceipt") return chain.dark ? dark() : out([...chain.used.values()].find((u) => u.tx === String(p0).toLowerCase())?.receipt ?? null);
      if (parsed.method === "eth_blockNumber") return out("0x3e8");
      if (parsed.method === "eth_getBlockByNumber") return out({ timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
      if (parsed.method === "eth_getLogs") { const u = chain.used.get(String(p0?.topics?.[2] || "").toLowerCase()); return out(u ? [{ transactionHash: u.tx }] : []); }
      return out("0x0");
    }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { counts.verify++; return reply(200, { isValid: true, payer }); }
    if (req.url !== "/settle") return reply(404, {});
    counts[name]++;
    const mode = st[name];
    const refuse = (errorReason, extra = {}) => ({ success: false, errorReason, errorMessage: errorReason, transaction: "", network: BASE_NET, payer, ...extra });
    if (mode === "billing") return reply(402, refuse(name === "primary" ? "free_tier_exhausted" : "insufficient_credits"));
    if (mode === "500") return reply(500, { error: "internal error" });
    if (mode === "reset") return req.socket.destroy();
    if (mode === "tx") return reply(200, refuse("transaction_failed", { transaction: failTxOf(parsed.paymentPayload?.payload?.authorization?.nonce) }));
    if (mode === "garbage200") return reply(200, "<html>upstream gateway</html>");
    if (mode === "verdict") return reply(200, refuse("insufficient_funds"));
    if (mode === "expired-words") return reply(200, refuse("The authorization has expired"));
    if (mode === "used") return reply(200, refuse("authorization_already_used"));
    return reply(200, { success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: BASE_NET, payer });
  });
});
const servers = { primary: stub("primary"), fallback: stub("fallback") };
await Promise.all(Object.values(servers).map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const PRIMARY = urlOf(servers.primary);

let srv = null;
const clients = [];
try {
  srv = await bootServer({
    stores: "settle-fallback-unproven",
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: PRIMARY, AGENT402_BASE_RPC: `${PRIMARY}/rpc`, EVM_RPC_8453: `${PRIMARY}/rpc`, FACILITATOR_GAS_CHECK: "off",
      // The settle chain on Base: the primary, then one fallback.
      SOLVADOR_KEY: "settle-fallback-unproven-key", SOLVADOR_FACILITATOR_URL: urlOf(servers.fallback),
      PAYMENT_SETTLE_FALLBACK: "true", LATE_SETTLE_FILE: LATE,
      // The late-settlement pass runs often and reads a new entry at once; one
      // payer holds at most five open unproven bookings.
      LATE_SETTLE_RECONCILE: "", X402_SYNC_ON_START: "", LATE_SETTLE_RECONCILE_MS: "250", LATE_SETTLE_FIRST_CHECK_MS: "150", LATE_SETTLE_UNPROVEN_PER_PAYER_MAX: "5",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      AGENT402_MCP_MAX_PER_MIN: "100000", AGENT402_MCP_MAX_PER_HOUR: "1000000",
      AGENT402_MCP_REQ_PER_MIN: "100000", AGENT402_MCP_REQ_PER_HOUR: "1000000",
      AGENT402_MCP_PAID_REQ_PER_MIN: "100000", AGENT402_MCP_PAID_REQ_PER_HOUR: "1000000",
    },
  });
  const B = srv.url;
  // A wallet-only route (no proof-of-work tier), paid on its own HTTP route
  // from both surfaces.
  const PATH = "/api/memory";
  const ARGS = { key: `unproven-${Date.now()}`, value: { marker: "stored-value-marker" } };
  const BODY = JSON.stringify(ARGS);
  const TOOL = { name: "catalog.call", arguments: { slug: "memory-write", params: ARGS } };

  const mcp = new Client({ name: "test-settle-fallback-unproven", version: "0.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`), { requestInit: { headers: { "X-Forwarded-For": "203.0.113.70" } } }));
  clients.push(mcp);

  // Every payment is signed by a wallet of its own, so no case meets another's
  // claim, cover or breaker count.
  const signerFor = () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const payments = new x402Client();
    registerExactEvmScheme(payments, { signer: account });
    return { account, payments };
  };
  const httpOffer = async () => {
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
    await r.arrayBuffer();
    return JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  };
  // `signer` pays from one wallet across calls; `header` sends a payment
  // already signed (the same payment again).
  const payHttp = async ({ signer = null, header = null, sent = null } = {}) => {
    let payload = sent?.payload || null, account = sent ? { address: sent.payer } : null;
    if (!header) {
      const sg = signer || signerFor();
      account = sg.account;
      payload = await sg.payments.createPaymentPayload(await httpOffer());
      header = Buffer.from(JSON.stringify(payload)).toString("base64");
    }
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: BODY });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    const hdr = r.headers.get("payment-response");
    let receipt = null; try { receipt = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null; } catch { /* unreadable */ }
    return { status: r.status, text, body, receipt, offered: r.headers.get("payment-required"), payer: account?.address, nonce: payload?.payload?.authorization?.nonce, validBefore: payload?.payload?.authorization?.validBefore, header, payload };
  };
  const again = (p) => payHttp({ header: p.header, sent: p });
  const payMcp = async () => {
    const { account, payments } = signerFor();
    const offer = PR(await mcp.callTool(TOOL));
    const payload = await payments.createPaymentPayload(offer);
    const result = await mcp.callTool({ ...TOOL, _meta: { [X402_PAYMENT_META]: payload } });
    return { result, text: JSON.stringify(result.content || ""), payer: account.address, nonce: payload.payload?.authorization?.nonce, payload };
  };
  const againMcp = async (p) => { const result = await mcp.callTool({ ...TOOL, _meta: { [X402_PAYMENT_META]: p.payload } }); return { result, text: JSON.stringify(result.content || "") }; };
  const isoOf = (v) => new Date(Number(v) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lateEntries = () => { try { return Object.values(JSON.parse(readFileSync(LATE, "utf8")).pending || {}); } catch { return []; } };
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
  const bookedFor = (p) => lateEntries().find((e) => String(e.payer || "").toLowerCase() === p.payer.toLowerCase() && (String(e.nonce || "").toLowerCase() === String(p.nonce).toLowerCase()));
  const NOT_CHARGED = /not charged|nothing (?:was|is) charged|never charged/i;
  const snap = () => ({ ...counts });
  const asked = (c0) => `${counts.primary - c0.primary}/${counts.fallback - c0.fallback}`;

  const first = PR(await mcp.callTool(TOOL));
  ok(first?.x402Version === 2 && first.accepts?.some((a) => a.network === BASE_NET), `the boot offers exact on Base over /mcp (${JSON.stringify(first).slice(0, 100)})`);

  // 1. The fallback stops the chain on an answer that proves nothing.
  for (const [mode, what] of [["500", "an HTTP 500"], ["reset", "a connection reset"], ["tx", "a failure naming a transaction"], ["garbage200", "an HTTP 200 with an unreadable body"]]) {
    st.primary = "billing"; st.fallback = mode;
    const named = mode === "tx";

    let c0 = snap();
    const h = await payHttp();
    ok(h.status === 402 && asked(c0) === "1/1", `${what} at the fallback, HTTP: a 402, the primary and the fallback asked once each (${h.status}, ${asked(c0)})`);
    ok(!h.offered && !Array.isArray(h.body?.accepts), `${what}, HTTP: the 402 carries no offer`);
    ok(h.body && !NOT_CHARGED.test(h.text) && h.body.reason !== "facilitator-quota" && h.body.retry !== "other-network" && h.body.retry !== "fresh-authorization",
      `${what}, HTTP: the body does not say the call was not charged and names no way to pay again (${h.text.slice(0, 260)})`);
    ok(/Do not sign a new authorization|Signing a new authorization for this call is a new payment/.test(String(h.body?.hint)), `${what}, HTTP: the hint says not to sign a new authorization (${String(h.body?.hint).slice(0, 200)})`);
    ok(h.body?.reason === "settlement-unconfirmed" && h.body.network === BASE_NET && h.body.error === undefined, `${what}, HTTP: reason settlement-unconfirmed on the network, no error sentence ahead of the hint (${h.body?.reason})`);
    ok(named ? (h.body?.retry === "watch-transaction" && JSON.stringify(h.body.transactions) === JSON.stringify([failTxOf(h.nonce)])) : (h.body?.retry === "check-wallet" && !h.body.transactions),
      `${what}, HTTP: ${named ? "the transaction to watch is named" : "no transaction is named and the retry verb is check-wallet"} (${h.body?.retry} ${JSON.stringify(h.body?.transactions)})`);
    ok(h.receipt?.success === false && isPreBroadcastSettleRejection(h.receipt) === false && !/free_tier_exhausted/.test(JSON.stringify(h.receipt)) && (!named || h.receipt.transaction === failTxOf(h.nonce)),
      `${what}, HTTP: the receipt is a failed one the route's rule does not read as nothing sent (${JSON.stringify(h.receipt).slice(0, 200)})`);
    ok(await waitFor(() => (named ? lateEntries().some((e) => String(e.tx || "").toLowerCase() === failTxOf(h.nonce) && String(e.payer).toLowerCase() === h.payer.toLowerCase()) : !!bookedFor(h))),
      `${what}, HTTP: ${named ? "the named transaction" : "the authorization"} is booked for the late-settlement read (${lateEntries().length} booked)`);
    ok(h.body?.authorizationValidBefore === isoOf(h.validBefore) && String(h.body?.hint).includes(`before ${isoOf(h.validBefore)}`) && /After that time it can no longer land, and a new payment is safe/.test(String(h.body?.hint)) && /booked as owed/.test(String(h.body?.hint)),
      `${what}, HTTP: the answer names the time the signed authorization stops being usable, after which a new payment is safe (${h.body?.authorizationValidBefore})`);
    ok(named ? h.body?.refundStatusUrl === `https://agent402.tools/api/refunds?tx=${failTxOf(h.nonce)}` : !("refundStatusUrl" in (h.body || {})),
      `${what}, HTTP: ${named ? "refundStatusUrl is the free lookup for the named transaction" : "no refund lookup without a transaction"} (${h.body?.refundStatusUrl})`);
    if (named) {
      const look = await fetch(`${B}/api/refunds?tx=${failTxOf(h.nonce)}`);
      ok(look.status === 200 && (await look.text()).length > 0, `${what}, HTTP: the refund lookup answers for that transaction with no payment (${look.status})`);
    }

    c0 = snap();
    const m = await payMcp();
    ok(m.result.isError === true && asked(c0) === "1/1", `${what} at the fallback, /mcp: an error result, the primary and the fallback asked once each (${asked(c0)})`);
    ok(!PR(m.result) && !/\\"accepts\\"|"accepts"/.test(m.text) && !m.result._meta?.["x402/payment-required"], `${what}, /mcp: no offer to sign (${m.text.slice(0, 200)})`);
    ok(/Do not sign a new authorization|Signing a new authorization for this call is a new payment/.test(m.text) && !NOT_CHARGED.test(m.text), `${what}, /mcp: the text says not to sign a new authorization and never that the call was not charged (${m.text.slice(0, 260)})`);
    ok(!named || (m.text.includes(failTxOf(m.nonce)) && m.result._meta?.[SETTLEMENT_PENDING_META]?.transactions?.includes(failTxOf(m.nonce))), `${what}, /mcp: ${named ? "the transaction to watch is named in the text and in _meta" : "no transaction to name"}`);
    ok(!m.text.includes("stored-value-marker") && !("structuredContent" in m.result), `${what}, /mcp: none of the tool's output`);
    {
      const meta = m.result._meta?.[SETTLEMENT_PENDING_META] || {};
      ok(!/did not settle/.test(m.text) && m.text.split("Do not sign a new authorization").length === 2 && meta.reason === "settlement-unconfirmed" && meta.retry === (named ? "watch-transaction" : "check-wallet")
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(meta.authorizationValidBefore)),
        `${what}, /mcp: the route's explanation once, never "did not settle", _meta reads settlement-unconfirmed with the retry verb (${meta.reason}/${meta.retry})`);
    }
    ok(await waitFor(() => (named ? lateEntries().some((e) => String(e.tx || "").toLowerCase() === failTxOf(m.nonce) && String(e.payer).toLowerCase() === m.payer.toLowerCase()) : !!bookedFor(m))),
      `${what}, /mcp: ${named ? "the named transaction" : "the authorization"} is booked for the late-settlement read`);
  }

  // 2. Control: every fallback refuses before anything is sent. The primary's
  // billing refusal stands and a fresh offer is correct.
  {
    st.primary = "billing"; st.fallback = "billing";
    const before = lateEntries().length;
    let c0 = snap();
    const h = await payHttp();
    ok(h.status === 402 && asked(c0) === "1/1" && h.body?.reason === "facilitator-quota" && h.body.retry === "other-network" && isPreBroadcastSettleRejection(h.receipt) === true,
      `control, HTTP: every settler refused on billing -> the billing refusal, each asked once (${asked(c0)}, ${h.body?.reason}/${h.body?.retry})`);
    c0 = snap();
    const m = await payMcp();
    ok(m.result.isError === true && asked(c0) === "1/1" && Array.isArray(PR(m.result)?.accepts) && /^Payment settlement failed/.test(String(PR(m.result)?.error)) && m.result._meta?.[X402_PAYMENT_RESPONSE_META]?.success === false,
      `control, /mcp: every settler refused on billing -> the settlement-failed result with a fresh offer (${PR(m.result)?.error || m.text.slice(0, 200)})`);
    await sleep(400);
    ok(lateEntries().length === before, `control: nothing is booked for a chain every settler refused before sending (${lateEntries().length - before} new)`);
  }

  // 3. Control: the fallback settles. One settlement, the answer and its receipt.
  {
    st.primary = "billing"; st.fallback = "ok";
    let c0 = snap();
    const h = await payHttp();
    ok(h.status === 200 && asked(c0) === "1/1" && h.receipt?.success === true && /^0x[0-9a-f]{64}$/.test(String(h.receipt.transaction)) && h.body && !h.body.reason,
      `control, HTTP: the fallback settles once -> 200 with its receipt (${h.status}, ${asked(c0)}) ${h.status === 200 ? "" : h.text.slice(0, 200)}`);
    c0 = snap();
    const m = await payMcp();
    ok(m.result.isError !== true && asked(c0) === "1/1" && m.result._meta?.[X402_PAYMENT_RESPONSE_META]?.success === true && String(m.result._meta[X402_PAYMENT_RESPONSE_META].payer).toLowerCase() === m.payer.toLowerCase(),
      `control, /mcp: the fallback settles once -> the tool output with its receipt (${asked(c0)}) ${m.result.isError ? m.text.slice(0, 200) : ""}`);
  }

  // 4. The primary answers an HTTP 200 whose body cannot be read: it may have
  // settled, so neither surface says the call was not charged.
  {
    st.primary = "garbage200"; st.fallback = "ok";
    let c0 = snap();
    const h = await payHttp();
    ok(h.status >= 400 && counts.fallback === c0.fallback, `an unreadable 200 at the primary, HTTP: an error answer and no other settler asked (${h.status}, ${asked(c0)})`);
    ok(!h.offered && !Array.isArray(h.body?.accepts) && !NOT_CHARGED.test(h.text) && h.body?.reason === "settlement-unconfirmed" && h.body.retry === "check-wallet"
      && /not confirmed/.test(String(h.body.hint)) && /Do not sign a new authorization/.test(String(h.body.hint)) && !/upstream gateway/.test(h.text),
      `an unreadable 200 at the primary, HTTP: settlement not confirmed, do not sign again, no offer, none of the facilitator's body (${h.text.slice(0, 300)})`);
    ok(await waitFor(() => !!bookedFor(h)), "an unreadable 200 at the primary, HTTP: the authorization is booked for the late-settlement read");
    c0 = snap();
    const m = await payMcp();
    ok(m.result.isError === true && counts.fallback === c0.fallback && !PR(m.result) && !/\\"accepts\\"|"accepts"/.test(m.text) && !NOT_CHARGED.test(m.text)
      && /not confirmed/.test(m.text) && /Do not sign a new authorization/.test(m.text),
      `an unreadable 200 at the primary, /mcp: settlement not confirmed, do not sign again, no offer (${m.text.slice(0, 300)})`);
  }

  // 5. Control: a handler error (no payment sent) still reads as not charged
  // on the connector, with nothing settled.
  {
    st.primary = "ok"; st.fallback = "ok";
    const { payments } = signerFor();
    const bad = { name: "catalog.call", arguments: { slug: "memory-write", params: { value: 1 } } };
    const offer = PR(await mcp.callTool(TOOL));
    const c0 = snap();
    const r = await mcp.callTool({ ...bad, _meta: { [X402_PAYMENT_META]: await payments.createPaymentPayload(offer) } });
    const t = JSON.stringify(r.content || "");
    ok(r.isError === true && counts.primary === c0.primary && /not charged/.test(t), `control, /mcp: an input the tool refuses is an error that was not charged, nothing settled (${t.slice(0, 160)})`);
  }

  // 6. A fallback's graceful verdict about the buyer's payment that names no
  // transaction is a decided answer: the earlier refusal stands and nothing
  // is booked. Control: a used authorization (a transfer may have used it)
  // stays unconfirmed.
  for (const [mode, what] of [["verdict", "insufficient_funds"], ["expired-words", "an expiry verdict in words"]]) {
    st.primary = "billing"; st.fallback = mode;
    const before = lateEntries().length;
    const c0 = snap();
    const h = await payHttp();
    ok(h.status === 402 && asked(c0) === "1/1" && h.body?.reason === "facilitator-quota" && h.body.retry === "other-network" && isPreBroadcastSettleRejection(h.receipt) === true && !("authorizationValidBefore" in h.body),
      `a fallback's graceful ${what} with no transaction, HTTP: the earlier refusal stands, not check-wallet (${asked(c0)}, ${h.body?.reason}/${h.body?.retry})`);
    await sleep(400);
    ok(lateEntries().length === before && !bookedFor(h), `a fallback's graceful ${what}: nothing is booked (${lateEntries().length - before} new)`);
    const m = await payMcp();
    ok(m.result.isError === true && Array.isArray(PR(m.result)?.accepts), `a fallback's graceful ${what}, /mcp: the settlement-failed result with a fresh offer`);
  }
  {
    st.primary = "billing"; st.fallback = "used";
    const h = await payHttp();
    ok(h.status === 402 && h.body?.reason === "settlement-unconfirmed" && h.body.retry === "check-wallet" && await waitFor(() => !!bookedFor(h)),
      `control: a fallback's graceful "authorization already used" stays unconfirmed and is booked (${h.body?.reason}/${h.body?.retry})`);
  }

  // 7. One wallet, the primary refusing on billing and the fallback answering
  // HTTP 500, fourteen calls: each is the unconfirmed answer, none a 429.
  // The wallet holds at most its bound of bookings (5 here); past it the
  // answer is the same without the repayment promise, and the bound is
  // logged once. Once the facilitators recover the wallet is served.
  {
    st.primary = "billing"; st.fallback = "500";
    const signer = signerFor();
    const got = [];
    for (let i = 0; i < 14; i++) got.push(await payHttp({ signer }));
    ok(got.every((g) => g.status === 402 && g.body?.reason === "settlement-unconfirmed" && g.body.retry === "check-wallet"), `one wallet, fourteen unconfirmed settles: none refused 429 (${got.map((g) => g.status).join(",")})`);
    const mine = () => lateEntries().filter((e) => String(e.payer).toLowerCase() === signer.account.address.toLowerCase());
    await waitFor(() => mine().length >= 5);
    await sleep(300);
    ok(mine().length === 5 && mine().every((e) => e.unproven === true), `one wallet holds its bound of open unproven bookings (${mine().length} of 14)`);
    ok(got.slice(0, 5).every((g) => /booked as owed/.test(g.body.hint)) && got.slice(5).every((g) => !/owed/.test(g.body.hint) && /Do not sign a new authorization/.test(g.body.hint) && !NOT_CHARGED.test(g.text)),
      "past the bound the answer keeps its words and promises no repayment record");
    const lines = srv.log().split("\n").filter((l) => /per-payer bound/.test(l));
    ok(lines.length === 1, `the bound is logged once, not per call (${lines.length} lines)`);
    st.fallback = "ok";
    const served = await payHttp({ signer });
    ok(served.status === 200 && served.receipt?.success === true, `after the facilitators recover the same wallet is served (${served.status}) ${served.status === 200 ? "" : served.text.slice(0, 200)}`);
  }

  // 8. The same payment sent again while the book names its authorization:
  // the unconfirmed answer, with no verify, no handler run and no settle,
  // however many times, and never a 429.
  const entryOf = (p) => lateEntries().find((e) => String(e.payer || "").toLowerCase() === p.payer.toLowerCase() && String(e.nonce || "").toLowerCase() === String(p.nonce).toLowerCase());
  {
    st.primary = "billing"; st.fallback = "500";
    const h = await payHttp();
    await waitFor(() => !!bookedFor(h));
    const c0 = snap();
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await again(h));
    ok(more.every((r) => r.status === 402 && r.body?.reason === "settlement-unconfirmed" && r.body.retry === "check-wallet" && !r.offered && !NOT_CHARGED.test(r.text) && r.receipt?.errorReason === "settlement_unconfirmed"
      && r.body.authorizationValidBefore === isoOf(h.validBefore) && /Do not sign a new authorization/.test(r.body.hint)),
      `the same payment sent again five times: the unconfirmed answer each time, never a 429 or a verdict on the payment (${more.map((r) => `${r.status}/${r.body?.reason}`).join(" ")})`);
    ok(counts.primary === c0.primary && counts.fallback === c0.fallback && counts.verify === c0.verify, `the same payment sent again: no verify, no handler run, no settle (${counts.verify - c0.verify} verifies, ${asked(c0)} settles)`);
    const m = await againMcp(h);
    ok(m.result.isError === true && !PR(m.result) && /Do not sign a new authorization/.test(m.text) && !NOT_CHARGED.test(m.text) && m.result._meta?.[SETTLEMENT_PENDING_META]?.retry === "check-wallet" && counts.primary === c0.primary,
      `the same payment sent again over /mcp: the unconfirmed result, no offer, nothing run (${m.text.slice(0, 160)})`);

    // A pass then reads the authorization as unused on chain: one further
    // settle is handed to the same payment. The facilitators still fail, so
    // that run ends unconfirmed again, and later copies run nothing.
    chain.dark = false;
    ok(await waitFor(() => Number(entryOf(h)?.unusedAt) > 0, 20_000), "a pass reads the booked authorization as unused on chain");
    let c1 = snap();
    const retry = await again(h);
    ok(retry.status === 402 && retry.body?.reason === "settlement-unconfirmed" && asked(c1) === "1/1", `read as unused: the same payment gets one further settle, which ends unconfirmed again (${retry.status}, ${asked(c1)})`);
    ok(Number(entryOf(h)?.resentAt) > 0, "the entry records that its one further settle was used");
    c1 = snap();
    const after = await again(h);
    ok(after.status === 402 && after.body?.reason === "settlement-unconfirmed" && asked(c1) === "0/0", `after that one settle, the same payment runs nothing again (${after.status}, ${asked(c1)})`);
  }

  // 9. Read as unused and the fallback recovered: the same payment settles
  // once and is served.
  {
    st.primary = "billing"; st.fallback = "500"; chain.dark = false;
    const h = await payHttp();
    ok(h.status === 402 && await waitFor(() => Number(entryOf(h)?.unusedAt) > 0, 20_000), "a second booked authorization is read as unused on chain");
    st.fallback = "ok";
    const c0 = snap();
    const r = await again(h);
    ok(r.status === 200 && r.receipt?.success === true && String(r.receipt.payer).toLowerCase() === h.payer.toLowerCase() && asked(c0) === "1/1",
      `read as unused and the fallback recovered: the same payment settles once and is served (${r.status}, ${asked(c0)}) ${r.status === 200 ? "" : r.text.slice(0, 200)}`);
  }

  // 10. The transfer landed after the refusal: the pass books it owed, and
  // the same payment sent again is answered with that record: no run, no
  // second charge, never "not charged".
  {
    st.primary = "billing"; st.fallback = "500"; chain.dark = true;
    const h = await payHttp();
    ok(h.status === 402 && await waitFor(() => !!bookedFor(h)), "a third authorization is booked");
    const e = bookedFor(h);
    const LANDED = `0x${createHash("sha256").update(`landed:${h.nonce}`).digest("hex")}`;
    const topic = (a) => `0x${String(a).slice(2).toLowerCase().padStart(64, "0")}`;
    chain.used.set(String(h.nonce).toLowerCase(), { tx: LANDED, receipt: { status: "0x1", transactionHash: LANDED, logs: [{ address: e.asset, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(e.payer), topic(e.payTo)], data: word(e.amount) }] } });
    chain.dark = false;
    ok(await waitFor(() => !bookedFor(h), 20_000), "the pass finds the transfer that used the authorization and closes the entry");
    const c0 = snap();
    const r = await again(h);
    ok(r.status === 409 && r.body?.reason === "settled-refund-owed" && r.body.retry === "fresh-authorization" && r.body.transaction === LANDED && r.body.refundStatusUrl === `https://agent402.tools/api/refunds?tx=${LANDED}`
      && /recorded as owed/.test(String(r.body.hint)) && !NOT_CHARGED.test(r.text) && !r.offered && asked(c0) === "0/0" && counts.verify === c0.verify,
      `the transfer landed: the same payment is answered with the owed record, nothing run (${r.status} ${r.text.slice(0, 220)})`);
    const look = await fetch(`${B}/api/refunds?tx=${LANDED}`);
    const lookText = await look.text();
    ok(look.status === 200 && /owed|pending/i.test(lookText), `the refund lookup shows the debt for that transfer (${look.status} ${lookText.slice(0, 160)})`);
    const m = await againMcp(h);
    ok(m.result.isError === true && !PR(m.result) && /recorded as owed/.test(m.text) && m.text.includes(LANDED) && !NOT_CHARGED.test(m.text) && asked(c0) === "0/0",
      `the transfer landed, /mcp: the owed record, never "not charged", nothing run (${m.text.slice(0, 200)})`);
  }
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  if (failed && srv) console.error(srv.log().split("\n").filter((l) => /\[payments\]|late-settle|settle/i.test(l)).slice(-40).join("\n"));
  for (const c of clients) { try { await c.close(); } catch { /* closed */ } }
  await srv?.stop();
  for (const s of Object.values(servers)) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
