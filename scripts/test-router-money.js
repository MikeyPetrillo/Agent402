// The router's money invariants, driven through the real payers against
// stubbed sellers (a stubbed fetch or a 127.0.0.1 stub on port 0), a stubbed
// chain and throwaway keys. Nothing is sent to a seller, an RPC or a
// facilitator, and nothing is paid.
//
//   1. One deadline per purchase: every seller request takes what is left of
//      it, and nothing is signed or sent once too little remains.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "router-money-test-"));
process.env.OUTBOUND_LEDGER_FILE = join(dir, "outbound-spend.ndjson");
process.env.MEMORY_DB_FILE = join(dir, "memory.db");
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily.json");
process.env.SOR_ROUTER_PURCHASES_FILE = join(dir, "router-purchases.json");
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
delete process.env.SOR_SPEND_CAP_ATOMIC;
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const buyer = await import("../src/x402-buyer.js");
const { PAY_X402_TIMEOUT_MS, PAY_X402_MIN_LEG_MS } = await import("../src/buyer-timeouts.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const guard = await import("../src/external-spend-guard.js");
buyer.__setBuyerAddressGuardForTest(false); // this suite's sellers are stubs

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const origFetch = globalThis.fetch;
const origTimeout = AbortSignal.timeout;

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0x" + "ef".repeat(20);
const baseAccept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });
const challengeHeader = (accept) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
const paidHeaderOf = (init) => init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["X-PAYMENT"] || null;
const bare402 = (h) => ({ status: 402, headers: { get: (k) => (k.toLowerCase() === "payment-required" ? h : null) }, json: async () => ({}), text: async () => "{}" });
const json200 = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

// --- 1. One deadline per purchase --------------------------------------------
// The clock is the test's own: a stubbed seller "takes" time by moving it, so
// no assertion rests on how long this machine took. The timeout each request
// was started with is read from AbortSignal.timeout itself.
{
  const run = async ({ deadlineMs, legMs, opts = {}, paidAnswer = json200 }) => {
    let clock = 1_000_000;
    const startedAt = clock;
    const legs = [], asked = [];
    AbortSignal.timeout = (ms) => { asked.push(ms); return origTimeout.call(AbortSignal, 600_000); };
    const h = challengeHeader(baseAccept());
    globalThis.fetch = async (_url, init) => {
      const paid = !!paidHeaderOf(init);
      legs.push({ paid, startedAtMs: clock - startedAt, both: !!(init?.headers?.["PAYMENT-SIGNATURE"] && init?.headers?.["X-PAYMENT"]) });
      clock += legMs; // the seller answers legMs later
      return paid ? paidAnswer() : bare402(h);
    };
    const held = buyer._spentThisWindow();
    const out = await buyer.payX402("https://slow.example/x", { maxAtomic: 5000n, method: "POST", body: {}, chain: "base", refusalMaxWaitMs: 0, notDebited: async () => ({ debited: false, observed: 0, expired: false }), now: () => clock, ...(deadlineMs != null ? { deadlineMs } : {}), ...opts })
      .then((r) => ({ paid: true, usd: r.quote?.usd }), (e) => ({ paid: false, status: e.statusCode, committed: e.committed === true, message: e.message }));
    AbortSignal.timeout = origTimeout;
    return { out, legs, asked, heldDelta: buyer._spentThisWindow() - held, endedAtMs: clock - startedAt };
  };

  // Both requests slow, as the review ran it: a 5 s budget, 2.7 s per request.
  const slow = await run({ deadlineMs: 5000, legMs: 2700 });
  ok(slow.out.paid === false && slow.out.status === 504 && /Nothing was signed/.test(slow.out.message || ""), `a seller slow on the unpaid request is refused 504 before signing (${slow.out.status} ${slow.out.message})`);
  ok(slow.legs.length === 1 && slow.legs.every((l) => !l.paid), `no request carried a payment after the budget ran short (${JSON.stringify(slow.legs)})`);
  ok(slow.out.committed === false && slow.heldDelta === 0n, `nothing is held for a payment that was never signed (held ${slow.heldDelta})`);
  // CONTROL: the same seller with room for both requests is paid, and its paid
  // request is started with what was left, not with a whole timeout again.
  const roomy = await run({ deadlineMs: 10_000, legMs: 2700 });
  ok(roomy.out.paid === true && roomy.legs.filter((l) => l.paid).length === 1, `CONTROL: with room for both requests the seller is paid (${JSON.stringify(roomy.out)})`);
  ok(roomy.asked.length === 2 && roomy.asked[0] === 10_000 && roomy.asked[1] === 7300, `each request takes what is left of the one deadline (${JSON.stringify(roomy.asked)})`);
  ok(roomy.legs.every((l) => l.startedAtMs <= 10_000), "every request started inside the deadline");
  // A per-request timeout shorter than what is left still applies.
  const capped = await run({ deadlineMs: 60_000, legMs: 100, opts: { timeoutMs: 4000 } });
  ok(capped.out.paid === true && capped.asked.every((ms) => ms === 4000), `a request never gets more than timeoutMs (${JSON.stringify(capped.asked)})`);
  // CONTROL: a caller with no deadline keeps a whole timeout per request.
  const none = await run({ deadlineMs: null, legMs: 2700 });
  ok(none.out.paid === true && none.asked.length === 2 && none.asked.every((ms) => ms === PAY_X402_TIMEOUT_MS), `CONTROL: with no deadline each request gets timeoutMs, as before (${JSON.stringify(none.asked)})`);
  // The budget already spent when the call starts: the seller is not contacted.
  const spent = await run({ deadlineMs: 1000, legMs: 10 });
  ok(spent.out.status === 504 && spent.legs.length === 0 && spent.heldDelta === 0n, `under the floor at the start, no request is made at all (${spent.legs.length} requests)`);
  ok(PAY_X402_MIN_LEG_MS >= 1000, "the floor is at least a second");
  // The same credential is not sent a second time once too little is left.
  const byName = () => new Response("X-PAYMENT header required", { status: 402 });
  const resendLate = await run({ deadlineMs: 6500, legMs: 2700, paidAnswer: byName });
  ok(resendLate.legs.filter((l) => l.paid).length === 1, `a credential is not resent with under the floor left (${resendLate.legs.filter((l) => l.paid).length} paid sends)`);
  ok(resendLate.out.committed === true && resendLate.heldDelta === 1000n, "the one payment that left stays held");
  const resendEarly = await run({ deadlineMs: 25_000, legMs: 2700, paidAnswer: byName });
  ok(resendEarly.legs.filter((l) => l.paid).length === 2 && resendEarly.legs[2]?.both === true, "CONTROL: with time left the credential is resent once under both header names");
  ok(resendEarly.asked[2] === 25_000 - 5400, `the resend takes what is left too (${resendEarly.asked[2]})`);
  buyer.releaseSpend(2000n, { window: -1 });
}

// --- 1b. route-execute hands the payer the request's own deadline ------------
{
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const cand = (net) => ({ seller: "https://s.example", slug: "x", url: "https://s.example/x", method: "POST", price: "$0.002", networks: [net] });
  const run = async ({ network, chains, reqExtra = {}, env = {} }) => {
    guard.__reset();
    const prev = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    let seen = null;
    const exec = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: EXEC_TIERS[0],
      resolveExternal: async () => [cand(network)],
      payExternal: async (_u, opts) => { seen = { timeoutMs: opts.timeoutMs, deadlineMs: opts.deadlineMs }; return { result: { ok: 1 }, quote: { usd: 0.002 }, receipt: { transaction: "0xab" } }; },
      externalEnabled: () => true, externalChains: () => chains, spendingWalletStatus: () => null, recordPurchase: () => true,
    });
    const req = { ip: "198.51.100.3", header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ network, payload: {} })).toString("base64") : undefined), ...reqExtra };
    const out = await exec.handler({ task: "t", include: "external" }, req).then((r) => ({ status: 200, sellerPaid: r.receipt.sellerPaid !== false }), (e) => ({ status: e.statusCode, message: e.message }));
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return { out, seen, booked: req.__externalSpend ? 1 : 0 };
  };
  const sol = await run({ network: SOL, chains: ["solana"], env: { SOR_SVM_BUDGET_MS: "40000" } });
  ok(sol.out.status === 200 && Number.isFinite(sol.seen?.deadlineMs) && sol.seen.deadlineMs > 0 && sol.seen.deadlineMs <= 40_000, `a Solana buyer's purchase carries one deadline inside its budget (${JSON.stringify(sol.seen)})`);
  const avm = await run({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", chains: ["algorand"], env: { SOR_AVM_BUDGET_MS: "16000" } });
  ok(avm.out.status === 200 && avm.seen?.deadlineMs > 0 && avm.seen.deadlineMs <= 16_000, `an Algorand buyer's purchase carries one deadline inside its budget (${JSON.stringify(avm.seen)})`);
  const evm = await run({ network: "eip155:8453", chains: ["base"] });
  ok(evm.out.status === 200 && evm.seen && evm.seen.deadlineMs === undefined && evm.seen.timeoutMs === undefined, `CONTROL: an EVM buyer off the proxy keeps the payer's own per-request timeout (${JSON.stringify(evm.seen)})`);
  // Through the proxy: 5 s of the answer window is kept for the answer itself.
  const cdnSpent = await run({ network: "eip155:8453", chains: ["base"], reqExtra: { cdnSyncDeadlineMs: Date.now() + 5500 } });
  ok(cdnSpent.out.status === 504 && cdnSpent.seen === null && /nothing was spent/i.test(cdnSpent.out.message || ""), `with the proxy's answer window spent the seller is not paid: 504 before the payer runs (${cdnSpent.out.status}, payer ${JSON.stringify(cdnSpent.seen)})`);
  ok(cdnSpent.booked === 0, "and nothing was booked against the buyer or the wallet");
  const cdnOpen = await run({ network: "eip155:8453", chains: ["base"], reqExtra: { cdnSyncDeadlineMs: Date.now() + 60_000 } });
  ok(cdnOpen.out.status === 200 && cdnOpen.seen?.deadlineMs > PAY_X402_MIN_LEG_MS && cdnOpen.seen.deadlineMs <= 55_000, `CONTROL: with the window open the seller is paid under one deadline inside it (${JSON.stringify(cdnOpen.seen)})`);
  guard.__reset();
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
