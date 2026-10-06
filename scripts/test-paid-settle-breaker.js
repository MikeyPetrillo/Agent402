#!/usr/bin/env node
// The settle-failure breaker guards EVERY wallet-only tool, not only the /v1
// tiers (2026-09-06). Boots a PAID server against a stub facilitator whose
// /verify says valid and whose /settle says failed - the exact "verify passes,
// settle fails" shape that costs an upstream read with nothing charged - and
// asserts: the first MAX_FAILS calls from one wallet run the handler and end
// 402 (settlement failed), the next is refused 429 BEFORE the handler with
// Retry-After, a different wallet is still served, a PoW-eligible (non
// wallet-only) tool is never consulted, and a settled 200 clears the count.
//
// Handler execution is observed through the stub's settle counter: the vendor
// only calls /settle for a < 400 handler response, so "settles advanced" means
// the handler ran and "settles did not advance" means the refusal came first.
//
// And the /v1 GLOBAL pause, through a real HTTP /v1 request (2026-09-28): every
// /v1 slug is wallet-only, so the dispatcher's catalog consult (global:false)
// armed the outcome listener first and the /v1 handler's own consult
// (global:true) could not re-arm it - no /v1 settle failure ever reached the
// global count. The server boots under scripts/lib/upstream-stub-preload.js so
// /v1/embeddings runs to a 200 with no key and nothing spent, then settlement
// fails; GLOBAL_MAX of them across different wallets must pause every /v1 tier,
// and one wallet's concurrent burst, however large, must not.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, facilitator = null, proc = null;
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 3; // GATEWAY_SETTLE_BREAKER_MAX below

const PAYER_A = "0x00000000000000000000000000000000000000a1";
const PAYER_B = "0x00000000000000000000000000000000000000b2";
let settleMode = "fail"; let verifies = 0, settles = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = PAYER_A; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* ignore */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply(200, { isValid: true, payer }); }
    if (req.url === "/settle") {
      settles++;
      if (settleMode === "fail") return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer });
      // A facilitator refusing on a billing quota of OURS, both shapes: the
      // graceful 200 {success:false} and a thrown non-2xx settle response.
      if (settleMode === "quota") return reply(200, { success: false, errorReason: "free_tier_exhausted", transaction: "", network: "eip155:8453", payer });
      if (settleMode === "quota-thrown") return reply(403, { success: false, errorReason: "free_tier_exhausted", errorMessage: "free tier exhausted", transaction: "", network: "eip155:8453", payer });
      return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn("node", ["--import", "./scripts/lib/upstream-stub-preload.js", "src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "", OPENAI_API_KEY: "test-key-never-used",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    GATEWAY_SETTLE_BREAKER_MAX: String(MAX), GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "4",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 80) serverLog.splice(0, serverLog.length - 80); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

let nonceN = 0;
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
})).toString("base64");
// demand-radar is wallet-only and answers from local state - no upstream, so the
// breaker's effect is observable without any key. hash is PoW-eligible: the
// control that the consult is scoped to paid (not PoW-eligible) tools.
const WALLET_ONLY = { path: "/api/demand-radar?limit=1", method: "GET" };
const POW_TOOL = { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "x" }) };
const accepts = {};
const acceptFor = async (t) => {
  if (accepts[t.path]) return accepts[t.path];
  const r = await fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json" }, body: t.body });
  ok(r.status === 402, `unpaid ${t.method} ${t.path} -> 402 (got ${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[t.path] = (req402.accepts || []).find((a) => a.network === "eip155:8453"); ok(!!accepts[t.path], `${t.path} offers exact on Base`);
  return accepts[t.path];
};
const pay = async (t, payer) => fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json", "payment-signature": credential(await acceptFor(t), payer) }, body: t.body });

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  // A FACILITATOR billing refusal on an EVM rail (free_tier_exhausted, both
  // wire shapes). Nothing withdraws that offer from the next 402 - only the
  // Algorand sub-cent gate does that, for its own refusal - so the per-wallet
  // bound is what stops a served-never-charged loop, and it holds: MAX are
  // served, the next is 429. What changed on 2026-09-28 is the WORDS: each 402
  // names the rail, and the 429 names the facilitator's billing limit instead
  // of telling the buyer to check a wallet that was never the problem.
  {
    const PAYER_Q = "0x00000000000000000000000000000000000000d4";
    for (let i = 1; i <= MAX; i++) {
      settleMode = i % 2 ? "quota" : "quota-thrown";
      const before = settles;
      const r = await pay(WALLET_ONLY, PAYER_Q);
      const body = await r.json().catch(() => ({}));
      ok(r.status === 402 && settles === before + 1, `quota refusal ${i} (${settleMode}): served, then refused at settle -> 402 (status ${r.status}, settles ${settles})`);
      ok(body.reason === "facilitator-quota" && body.retry === "other-network" && /not because of your wallet/.test(body.hint || "") && !/failed to settle/.test(body.error || ""), `quota refusal ${i}: the 402 names the rail, not the wallet (got ${body.reason}: ${String(body.error).slice(0, 50)})`);
    }
    const before = settles;
    const r = await pay(WALLET_ONLY, PAYER_Q);
    const body = await r.json().catch(() => ({}));
    ok(r.status === 429 && settles === before, `quota refusal ${MAX + 1}: refused 429 BEFORE the handler - an EVM billing refusal stays bounded per wallet (status ${r.status}, settles ${settles} == ${before})`);
    ok(/billing limit on this server's own account/.test(body.error || "") && /not because of the wallet/.test(body.error || "") && !/USDC balance/.test(body.error || ""), `...and that 429 names the facilitator's billing limit, not the wallet's balance (got: ${String(body.error).slice(0, 110)})`);
  }
  settleMode = "fail";

  // MAX failed settlements from wallet A: each one ran the handler (settles advanced) and ended 402.
  for (let i = 1; i <= MAX; i++) {
    const before = settles;
    const r = await pay(WALLET_ONLY, PAYER_A);
    ok(r.status === 402 && settles === before + 1, `wallet A call ${i}: handler ran, settle refused -> 402 (status ${r.status}, settles ${settles})`);
    // A settle refusal carries PAYMENT-RESPONSE and no PAYMENT-REQUIRED, so the
    // 402 body mirror (src/payment-required-body.js) adds no offer to it.
    const body = await r.json().catch(() => ({}));
    if (i === 1) ok(!r.headers.get("payment-required") && !("x402Version" in body) && !("accepts" in body), `wallet A call 1: the settle-refusal 402 states no offer (keys: ${Object.keys(body).join(",") || "none"})`);
  }
  // The next is refused BEFORE the handler: no settle attempt, 429, Retry-After, nothing charged.
  {
    const before = settles, v = verifies;
    const r = await pay(WALLET_ONLY, PAYER_A);
    const body = await r.json().catch(() => ({}));
    ok(r.status === 429 && settles === before, `wallet A call ${MAX + 1}: refused 429 before the handler (status ${r.status}, settles ${settles} == ${before})`);
    ok(r.headers.get("retry-after") && /failed to settle/.test(body.error || ""), `429 carries Retry-After and says why (${String(body.error).slice(0, 60)}...)`);
    ok(verifies === v + 1, "the refusal came after verify (the paywall still verified the credential) and before any handler work");
  }
  // A different wallet is still served (its own count is zero).
  {
    const before = settles;
    const r = await pay(WALLET_ONLY, PAYER_B);
    ok(r.status === 402 && settles === before + 1, `wallet B is unaffected: handler ran, settle refused -> 402 (settles ${settles})`);
  }
  // A PoW-eligible tool is never consulted: wallet A, though blocked, still reaches /api/hash's handler.
  {
    const before = settles;
    const r = await pay(POW_TOOL, PAYER_A);
    ok(r.status === 402 && settles === before + 1, `a non wallet-only tool is not breakered: blocked wallet A still reaches /api/hash (settles ${settles})`);
  }
  // A settled 200 clears wallet B; a later burst from B counts from zero again.
  {
    settleMode = "ok";
    const r = await pay(WALLET_ONLY, PAYER_B);
    ok(r.status === 200, `wallet B: a settled call answers 200 (got ${r.status})`);
    settleMode = "fail";
    let last = 0;
    for (let i = 1; i <= MAX; i++) { last = (await pay(WALLET_ONLY, PAYER_B)).status; }
    ok(last === 402, `after a settled 200 the count restarts: ${MAX} new failures from wallet B are all served (last status ${last})`);
    const r2 = await pay(WALLET_ONLY, PAYER_B);
    ok(r2.status === 429, `... and the next is 429 (got ${r2.status})`);
  }
  // Per-wallet ONLY: by now 8+ catalog settle failures have happened across two
  // wallets, well past GLOBAL_MAX (4) - and a THIRD wallet is still served,
  // because catalog failures neither honour nor feed the global pause.
  {
    const before = settles;
    const r = await pay(WALLET_ONLY, "0x00000000000000000000000000000000000000c3");
    ok(r.status === 402 && settles === before + 1, `no global pause from catalog failures: a third wallet still reaches the handler (status ${r.status})`);
  }
  // THE /v1 GLOBAL PAUSE, through HTTP. The catalog failures above (well past
  // GLOBAL_MAX, across three wallets) fed nothing global.
  const V1 = (i) => ({ path: "/v1/embeddings", method: "POST", body: JSON.stringify({ input: `settle breaker probe ${i}` }) });
  const wallet = (i) => "0x" + "e".repeat(38) + i.toString(16).padStart(2, "0");
  const GLOBAL_MAX = 4; // GATEWAY_SETTLE_BREAKER_GLOBAL_MAX below
  // ONE wallet, a concurrent burst: every call passes the per-wallet check
  // before any of the burst's failures lands, so well over GLOBAL_MAX handlers
  // run and fail to settle. That wallet is the per-wallet bound's business; it
  // must not pause every /v1 buyer (the global pause counts distinct buyers).
  {
    await acceptFor(V1(0));
    const before = settles;
    const burst = await Promise.all(Array.from({ length: 10 }, (_, k) => pay(V1(100 + k), wallet(0x90))));
    const ran = settles - before;
    ok(ran >= GLOBAL_MAX && burst.every((r) => r.status === 402 || r.status === 429), `one wallet's burst of 10 concurrent /v1 calls: ${ran} handlers ran and failed to settle (>= GLOBAL_MAX ${GLOBAL_MAX}, so the old per-failure count would have paused /v1)`);
    const b0 = settles;
    const r = await pay(V1(200), wallet(0x91));
    ok(r.status === 402 && settles === b0 + 1, `...and a DIFFERENT wallet's /v1 call still reaches its handler: one buyer cannot pause every /v1 tier (status ${r.status}, settles ${settles})`);
  }
  // Now /v1 calls from DIFFERENT fresh wallets (one failure each, far under
  // the per-wallet MAX) run the handler and fail to settle. Two buyers failed
  // above; GLOBAL_MAX - 2 more reach the threshold, and the next /v1 call, from
  // yet another wallet, must be refused 503 before the handler.
  {
    for (let i = 1; i <= GLOBAL_MAX - 2; i++) {
      const before = settles;
      const r = await pay(V1(i), wallet(i));
      ok(r.status === 402 && settles === before + 1, `/v1 call ${i} from its own wallet: the handler ran (upstream stubbed), settlement failed -> 402 (status ${r.status}, settles ${settles})`);
    }
    const before = settles;
    const r = await pay(V1(99), wallet(99));
    const body = await r.json().catch(() => ({}));
    ok(r.status === 503 && settles === before && /briefly paused/.test(body.error || "") && r.headers.get("retry-after"), `after /v1 settle failures from ${GLOBAL_MAX} different wallets the NEXT /v1 call is paused 503 before the handler (status ${r.status}, settles ${settles} == ${before})`);
    const g = await (await fetch(`${B}/api/gateway-status`)).json().catch(() => ({}));
    const txt = JSON.stringify(g);
    ok(!txt.includes(wallet(1)), "the pause is reported without naming a wallet");
    // The catalog neither honours nor feeds the /v1 pause: a fresh wallet still reaches a wallet-only catalog tool.
    const c = settles;
    const cat = await pay(WALLET_ONLY, "0x00000000000000000000000000000000000000f6");
    ok(cat.status === 402 && settles === c + 1, `the /v1 pause does not reach the catalog: a wallet-only catalog tool still runs its handler (status ${cat.status})`);
  }
  // Status surface stays counts-only.
  {
    const s = await (await fetch(`${B}/api/gateway-status`)).json().catch(() => ({}));
    const txt = JSON.stringify(s);
    ok(!txt.includes(PAYER_A) && !txt.includes(PAYER_B), "/api/gateway-status never carries a wallet address");
  }
  console.log(`\nPASS - ${pass} checks (settle-failure breaker on every paid tool)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) {
  fail(`threw: ${e?.stack || e}`);
}
