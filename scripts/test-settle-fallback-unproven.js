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
//     surface says the call was not charged, both say not to sign again.
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
// primary: billing | ok | garbage200.  fallback: 500 | reset | tx | garbage200 | billing | ok.
const st = { primary: "billing", fallback: "500" };
const counts = { primary: 0, fallback: 0, verify: 0 };
let txN = 0;
const stub = (name) => createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: name === "primary" ? [{ x402Version: 2, scheme: "exact", network: BASE_NET }] : [], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
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
      PAYMENT_SETTLE_FALLBACK: "true", LATE_SETTLE_RECONCILE: "off", LATE_SETTLE_FILE: LATE,
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
  const payHttp = async () => {
    const { account, payments } = signerFor();
    const payload = await payments.createPaymentPayload(await httpOffer());
    const r = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") }, body: BODY });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    const hdr = r.headers.get("payment-response");
    let receipt = null; try { receipt = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null; } catch { /* unreadable */ }
    return { status: r.status, text, body, receipt, offered: r.headers.get("payment-required"), payer: account.address, nonce: payload.payload?.authorization?.nonce };
  };
  const payMcp = async () => {
    const { account, payments } = signerFor();
    const offer = PR(await mcp.callTool(TOOL));
    const payload = await payments.createPaymentPayload(offer);
    const result = await mcp.callTool({ ...TOOL, _meta: { [X402_PAYMENT_META]: payload } });
    return { result, text: JSON.stringify(result.content || ""), payer: account.address, nonce: payload.payload?.authorization?.nonce };
  };
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

    c0 = snap();
    const m = await payMcp();
    ok(m.result.isError === true && asked(c0) === "1/1", `${what} at the fallback, /mcp: an error result, the primary and the fallback asked once each (${asked(c0)})`);
    ok(!PR(m.result) && !/\\"accepts\\"|"accepts"/.test(m.text) && !m.result._meta?.["x402/payment-required"], `${what}, /mcp: no offer to sign (${m.text.slice(0, 200)})`);
    ok(/Do not sign a new authorization|Signing a new authorization for this call is a new payment/.test(m.text) && !NOT_CHARGED.test(m.text), `${what}, /mcp: the text says not to sign a new authorization and never that the call was not charged (${m.text.slice(0, 260)})`);
    ok(!named || (m.text.includes(failTxOf(m.nonce)) && m.result._meta?.[SETTLEMENT_PENDING_META]?.transactions?.includes(failTxOf(m.nonce))), `${what}, /mcp: ${named ? "the transaction to watch is named in the text and in _meta" : "no transaction to name"}`);
    ok(!m.text.includes("stored-value-marker") && !("structuredContent" in m.result), `${what}, /mcp: none of the tool's output`);
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
