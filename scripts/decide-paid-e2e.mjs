// Paid end-to-end check of decide against a live server. NOT in CI: it spends.
//
//   BURNER_KEY=0x... POW_SECRET=... [TARGET_URL=https://agent402.tools] \
//     node scripts/decide-paid-e2e.mjs [--skip-tempo] [--task "..."] [--out run.json]
//
// Base x402, as a stock buyer: POST /api/decide (plan depth), then
// POST /api/decide/execute with the decision's execution credit. Checks each
// call settled (a receipt header), the plan carries firstParty on every tool,
// the credit is taken off the execute price, the run's charges add up, and a
// leftover credit comes back. Then the free feedback route. Tempo MPP: one
// POST /api/decide (quick depth) paid over tempo/charge. Execute is offered on
// Base only, so it is not bought over Tempo.
//
// Every request carries the heartbeat token (HMAC of POW_SECRET), so the
// ledger records these buys as our own traffic, not outside demand.

import { createHmac } from "node:crypto";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) { console.error("decide-paid-e2e: BURNER_KEY is required"); process.exit(2); }
const secret = (process.env.POW_SECRET || "").trim();
if (!secret) console.warn("WARN  POW_SECRET not set: these buys will record as outside demand");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TASK = arg("--task", "Convert 26.2 statute miles to kilometers.");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const heartbeat = () => createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);
const tagged = (base) => (input, init) => { const req = new Request(input, init); if (secret) req.headers.set("X-Heartbeat-Token", heartbeat()); return base(req); };
const receiptOf = (res) => {
  const h = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return { raw: h.slice(0, 80) }; }
};
const post = (f, path, body) => f(`${TARGET}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const pkHex = pk.startsWith("0x") ? pk : `0x${pk}`;
const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }, { disableVendorSpendControls }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"), import("../src/x402-spend-controls.js"),
]);
const account = privateKeyToAccount(pkHex);
console.log(`buyer ${account.address} -> ${TARGET}`);
const client = disableVendorSpendControls(new x402Client());
registerExactEvmScheme(client, { signer: account });
const pay = wrapFetchWithPayment(tagged(fetch), client);

// ---- Base: buy a plan ----
const r1 = await post(pay, "/api/decide", { task: TASK, depth: "plan" });
const d = await r1.json().catch(() => ({}));
const rc1 = receiptOf(r1);
ok(r1.status === 200 && d.decisionId && Array.isArray(d.plan) && d.plan.length > 0, `decide (plan) answered 200 with a plan (${r1.status}, ${d.plan?.length ?? 0} steps${d.error ? `: ${String(d.error).slice(0, 120)}` : ""})`);
ok(rc1?.success === true && rc1?.transaction, `decide settled on ${rc1?.network || "?"} (tx ${rc1?.transaction || "none"})`);
ok((d.plan || []).every((p) => typeof p.tool?.firstParty === "boolean"), "every planned tool discloses firstParty");
console.log(`   plan: ${(d.plan || []).map((p) => `${p.step}. ${p.tool?.slug || p.tool?.id} ${JSON.stringify(p.tool?.exampleParams || {})}`).join(" | ")}`);
const credit = d.executionCredit;
ok(credit?.token && credit.amountUsd > 0, `an execution credit came with the plan ($${credit?.amountUsd ?? 0})`);

if (d.decisionId && credit?.token) {
  // The credit activates when the decide payment settles; the 200 above is sent after that.
  const r2 = await post(pay, "/api/decide/execute", { decisionId: d.decisionId, creditToken: credit.token });
  const x = await r2.json().catch(() => ({}));
  const rc2 = receiptOf(r2);
  ok(r2.status === 200 && (x.status === "complete" || x.status === "partial"), `execute answered 200, run ${x.status || "?"} (${r2.status}${x.error ? `: ${String(x.error).slice(0, 160)}` : ""})`);
  ok(rc2?.success === true, `execute settled (tx ${rc2?.transaction || "none"})`);
  // The credit is redeemed whole against the run and what is not spent comes
  // back as a new credit: paid + credit - spent = leftover. Every x402 payment
  // settles at least $0.001, so a budget at that floor leaves the credit unused.
  const leftover = x.leftoverCredit?.amountUsd || 0;
  if (x.budgetUsd > 0.001 + 1e-9) ok(x.creditAppliedUsd === credit.amountUsd && Math.abs(x.paidUsd + x.creditAppliedUsd - x.spentUsd - leftover) < 1e-6, `the credit was applied: paid $${x.paidUsd} + credit $${x.creditAppliedUsd} - spent $${x.spentUsd} = leftover $${leftover}`);
  else ok(x.creditAppliedUsd === 0 && x.paidUsd === 0.001, `a $0.001 budget is paid at the settlement floor and the credit is left unused (paid $${x.paidUsd}, credit applied $${x.creditAppliedUsd})`);
  const c = x.charges || {};
  const sum = Math.round(((c.firstPartyUsd || 0) + (c.passThroughUsd || 0) + (c.routingFeesUsd || 0) + (c.uncertainUsd || 0)) * 1e6) / 1e6;
  ok(Math.abs(sum - (x.spentUsd || 0)) < 1e-6, `charges add up to what the run spent ($${sum} vs $${x.spentUsd}): ${JSON.stringify(c)}`);
  ok(x.spentUsd <= x.budgetUsd + 1e-9, "the run stayed inside its budget");
  for (const s of x.steps || []) console.log(`   step ${s.step}: ${s.status} ${s.tool?.slug || ""} $${s.costUsd ?? 0} ${s.reason || ""}${s.attempts ? ` attempts=${JSON.stringify(s.attempts).slice(0, 200)}` : ""}`);
  if (x.leftoverCredit) console.log(`   leftover credit $${x.leftoverCredit.amountUsd}`);
  ok(!x.leftoverCredit || x.leftoverCredit.amountUsd > 0, "any leftover credit is positive");
  // --out FILE keeps the whole plan and run (receipts, step results) for a write-up.
  if (arg("--out", null)) (await import("node:fs")).writeFileSync(arg("--out", null), JSON.stringify({ decide: d, decideReceipt: rc1, execute: x, executeReceipt: rc2 }, null, 2));

  // Free feedback on step 1.
  if (d.feedbackToken) {
    const rf = await post(tagged(fetch), "/api/decide/feedback", { decisionId: d.decisionId, feedbackToken: d.feedbackToken, step: 1, outcome: x.steps?.[0]?.status === "ok" ? "success" : "failure", quality: 5 });
    const fb = await rf.json().catch(() => ({}));
    ok(rf.status === 200 && fb.ok === true, `feedback recorded (${rf.status}${fb.error ? `: ${fb.error}` : ""})`);
  }
}

// ---- Tempo MPP: buy a quick decision ----
if (!process.argv.includes("--skip-tempo")) {
  const { Mppx, tempo } = await import("mppx/client");
  const mppx = Mppx.create({ methods: [tempo.charge({ account, autoSwap: true })] });
  let failed = null;
  mppx.onPaymentFailed((e) => { failed = e; });
  const rt = await mppx.fetch(`${TARGET}/api/decide`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "X-Heartbeat-Token": heartbeat() } : {}) }, body: JSON.stringify({ task: TASK, depth: "quick" }) });
  const dt = await rt.json().catch(() => ({}));
  const receipt = rt.headers.get("payment-receipt");
  ok(rt.status === 200 && dt.decisionId && (dt.plan || []).length > 0, `decide (quick) over Tempo MPP answered 200 with a plan (${rt.status}${dt.error ? `: ${String(dt.error).slice(0, 120)}` : ""}${failed ? `; payment failed: ${JSON.stringify(failed).slice(0, 200)}` : ""})`);
  ok(!!receipt, `Tempo settled with a Payment-Receipt (${receipt ? receipt.slice(0, 60) + "..." : "none"})`);
}

console.log(`\ndecide-paid-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
