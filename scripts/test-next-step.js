#!/usr/bin/env node
// A refused payment whose wallet cannot cover the call carries `nextStep`
// (src/next-step.js): state, who acts, the command and how long to wait, beside
// the prose hint. Offline, plus one FREE_MODE boot for payment.info.
//
//   node scripts/test-next-step.js
//
// Unit: every funding retry verb maps to its state and actor, the amount comes
// from the route's own requirements, a refusal that is not about funds gets
// none. Middleware: the 402 to the retried credential carries nextStep and
// marks the request for the funnel; a bare 402 and a refusal of another class
// carry none. Booted: the hosted connector's payment.info carries emptyWallet
// and its output schema names it.
import "./lib/offline-stores.js";
import { bootServer } from "./lib/boot-server.js";
import { textNamesUrl } from "./lib/url-host.js";
import { nextStepForRefusal, emptyWalletGuide, NEXT_STEP_STATES, NEXT_STEP_ACTORS } from "../src/next-step.js";
import { noteVerifyFailure, verifyHintMiddleware, _testResetForTest } from "../src/verify-hint.js";
import { META_OUTPUT_SCHEMAS } from "../src/mcp-flagship.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL: ${m}`); } };

// ---- unit --------------------------------------------------------------------------
const NEEDS = { network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "5000", usd: 0.005 };
const shape = (s) => s && NEXT_STEP_STATES.includes(s.state) && NEXT_STEP_ACTORS.includes(s.whoActs) && typeof s.command === "string" && s.command.length > 20 && Number.isSafeInteger(s.wait?.retryAfterSeconds) && typeof s.wait?.until === "string";
{
  const s = nextStepForRefusal({ retry: "fund-wallet", reasonClass: "insufficient-funds", balanceUsd: 0, priceUsd: 0.005, needs: NEEDS });
  ok(shape(s) && s.state === "wallet-empty" && s.whoActs === "wallet-owner", "an empty Base wallet: wallet-empty, the wallet owner acts");
  ok(s.fund && s.fund.amount === "5000" && s.fund.network === "eip155:8453" && s.fund.usd === 0.005, "the amount to fund is the route's own requirement");
  ok(s.wait.retryAfterSeconds === 60, "the wait defaults to the Retry-After the hint middleware sets (60)");
}
{
  const s = nextStepForRefusal({ retry: "fund-wallet", reasonClass: "insufficient-funds", balanceUsd: null, priceUsd: 0.005 });
  ok(shape(s) && s.state === "wallet-short" && !("fund" in s), "an unread balance reads wallet-short, and no fund block without requirements");
}
{
  const s = nextStepForRefusal({ retry: "lower-price-route", reasonClass: "insufficient-funds", balanceUsd: 0.002, priceUsd: 0.005, needs: NEEDS });
  ok(shape(s) && s.state === "wallet-below-price" && s.whoActs === "caller" && /\/api\/pricing/.test(s.command), "a funded wallet under the price: the caller can act now on a cheaper route");
}
{
  const s = nextStepForRefusal({ retry: "fund-wallet", reasonClass: "no-token-account", retryAfterSeconds: 300, needs: { ...NEEDS, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } });
  ok(shape(s) && s.state === "no-token-account" && s.wait.retryAfterSeconds === 300, "no token account: its own state, and the Solana Retry-After carries through");
}
{
  const s = nextStepForRefusal({ retry: "fund-gateway-deposit", reasonClass: "insufficient-funds" });
  ok(shape(s) && s.state === "gateway-deposit-short" && /Gateway/.test(s.command), "a short Gateway deposit: deposit, not fund the wallet");
}
for (const retry of ["fresh-authorization", "same-payment", "rebuild-payment", "other-network", undefined]) {
  ok(nextStepForRefusal({ retry, reasonClass: "insufficient-funds" }) === null, `retry ${retry}: no nextStep (not a funding refusal)`);
}
ok(nextStepForRefusal(null) === null, "no hint: no nextStep");
{
  const g = emptyWalletGuide("https://example.test/");
  ok(shape(g) && g.state === "wallet-empty" && textNamesUrl(g.meanwhile, "example.test", "/api/pow"), "the general empty-wallet guide names the free proof-of-work path on this origin");
}

// ---- middleware --------------------------------------------------------------------
const PAYER = "0xc59e74ed6386b2a12d892fff2509a6965a0498dc";
const REVERT = "[CDP (Base)] invalid_payload: contract call failed: unable to call contract: execution reverted";
const SIG = "0x" + "11".repeat(65);
const cred = (nonce) => ({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: { signature: SIG, authorization: { from: PAYER, to: "0x000000000000000000000000000000000000dEaD", value: "5000", validAfter: "0", validBefore: "9999999999", nonce } } });
const toHeader = (c) => Buffer.from(JSON.stringify(c)).toString("base64");
const mkRes = (status) => ({ statusCode: status, headersSent: false, headers: {}, out: null, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.out = b; return this; } });
const REQS = { scheme: "exact", network: "eip155:8453", asset: NEEDS.asset, amount: "5000", payTo: "0x000000000000000000000000000000000000dEaD" };
_testResetForTest();
{
  const C = cred("0x" + "a1".repeat(32));
  await noteVerifyFailure({ paymentPayload: C, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, requirements: REQS, now: () => Date.now(), balanceReader: async () => 0 });
  const req = { headers: { "payment-signature": toHeader(C) } };
  const r = mkRes(402); verifyHintMiddleware()(req, r, () => {}); r.json({ x402Version: 2, accepts: [] });
  ok(r.out.retry === "fund-wallet" && r.out.nextStep?.state === "wallet-empty" && r.out.nextStep.whoActs === "wallet-owner", `the 402 to an empty wallet's retried credential carries nextStep (${JSON.stringify(r.out.nextStep)})`);
  ok(typeof r.out.hint === "string" && r.out.payerUsdcOnBase === 0, "the prose hint and the balance field stay beside it");
  ok(req.__paymentNextStepState === "wallet-empty", "the request is marked with the state for the funnel");
}
{
  const C = cred("0x" + "a2".repeat(32));
  await noteVerifyFailure({ paymentPayload: C, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now: () => Date.now(), balanceReader: async () => 0.002 });
  const r = mkRes(402); verifyHintMiddleware()({ headers: { "payment-signature": toHeader(C) } }, r, () => {}); r.json({ x402Version: 2 });
  ok(r.out.retry === "lower-price-route" && r.out.nextStep?.state === "wallet-below-price" && r.out.nextStep.whoActs === "caller", "a funded wallet under the price: nextStep says the caller acts");
}
{
  const C = cred("0x" + "a3".repeat(32));
  await noteVerifyFailure({ paymentPayload: C, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now: () => Date.now(), balanceReader: async () => 12 });
  const req = { headers: { "payment-signature": toHeader(C) } };
  const r = mkRes(402); verifyHintMiddleware()(req, r, () => {}); r.json({ x402Version: 2 });
  ok(r.out.retry === "fresh-authorization" && !("nextStep" in r.out) && !("__paymentNextStepState" in req), "control: a stale authorization from a funded wallet gets no nextStep");
}
{
  const r = mkRes(402); let passed = false; verifyHintMiddleware()({ headers: {} }, r, () => { passed = true; }); r.json({ x402Version: 2 });
  ok(passed && !("nextStep" in r.out), "a first-contact 402 (no credential) is untouched");
}

// ---- booted: payment.info ----------------------------------------------------------
ok(META_OUTPUT_SCHEMAS["payment.info"]?.properties?.emptyWallet?.type === "object", "payment.info's output schema names emptyWallet");
const srv = await bootServer({ env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" }, stores: "next-step" });
try {
  const rpc = async (body) => {
    const r = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : t);
  };
  const out = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment.info", arguments: {} } });
  const sc = out?.result?.structuredContent || JSON.parse(out?.result?.content?.[0]?.text || "{}");
  ok(shape(sc.emptyWallet) && sc.emptyWallet.state === "wallet-empty" && sc.emptyWallet.meanwhile.startsWith("Tools marked proof-of-work"), `payment.info carries emptyWallet (${JSON.stringify(sc.emptyWallet)?.slice(0, 120)})`);
} finally { await srv.stop(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
