#!/usr/bin/env node
// The settle-failure breaker guards EVERY wallet-only tool, not only the /v1
// tiers (2026-09-06). Boots a PAID server against a stub facilitator whose
// /verify says valid and whose /settle says failed - the exact "verify passes,
// settle fails" shape that costs an upstream read with nothing charged - and
// asserts: the first MAX_FAILS calls from one wallet run the handler and end
// 402 (settlement failed), the next is refused 429 BEFORE the handler with
// Retry-After, a different wallet is still served, a PoW-eligible (non
// wallet-only) tool is never consulted, and a settled 200 is an outcome in
// the window. The refusal holds the NETWORK the failed payments named: the
// same wallet paying on another offered network is served at once, and the
// 429 says so in words and in fields.
//
// Handler execution is observed through the stub's settle counter: the vendor
// only calls /settle for a < 400 handler response, so "settles advanced" means
// the handler ran and "settles did not advance" means the refusal came first.
//
// And the /v1 burst ALARM, through a real HTTP /v1 request: every /v1 slug is
// wallet-only, so the dispatcher's catalog consult (global:false) arms the
// outcome listener first and the /v1 handler's own consult (global:true)
// upgrades it. The server boots under scripts/lib/upstream-stub-preload.js so
// /v1/embeddings runs to a 200 with no key and nothing spent, then settlement
// fails; GLOBAL_MAX of them across different wallets must read
// settleFailures=burst on /api/gateway-status while the NEXT buyer is served,
// and one wallet's concurrent burst, however large, must not raise it.
// The breaker counts, replay claims and sales of one booted server: Redis or a
// state database left over from an earlier run would answer this run's fixed
// wallets and nonces (429/409 before any handler), so the child runs on its own
// in-process state whatever the calling shell exports.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import "./lib/file-mode.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, facilitator = null, proc = null;
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 3; // GATEWAY_SETTLE_BREAKER_MAX below
const OP_TOKEN = "settle-breaker-test-operator-token-0123456789";

const PAYER_A = "0x00000000000000000000000000000000000000a1";
const PAYER_B = "0x00000000000000000000000000000000000000b2";
const PAYER_C = "0x00000000000000000000000000000000000000c3";
let settleMode = "fail"; let verifies = 0, settles = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = PAYER_A, net = "eip155:8453"; try { const j = JSON.parse(body); payer = j?.paymentPayload?.payload?.authorization?.from || payer; net = j?.paymentRequirements?.network || j?.paymentPayload?.accepted?.network || net; } catch { /* ignore */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: "eip155:137" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply(200, { isValid: true, payer }); }
    if (req.url === "/settle") {
      settles++;
      if (settleMode === "fail") return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: net, payer });
      // A facilitator refusing on a billing quota of OURS, both shapes: the
      // graceful 200 {success:false} and a thrown non-2xx settle response.
      if (settleMode === "quota") return reply(200, { success: false, errorReason: "free_tier_exhausted", transaction: "", network: net, payer });
      if (settleMode === "quota-thrown") return reply(403, { success: false, errorReason: "free_tier_exhausted", errorMessage: "free tier exhausted", transaction: "", network: net, payer });
      // The facilitator failing on its side (an HTTP 503 whose body is no
      // settle answer): no verdict on the payment.
      if (settleMode === "down") return reply(503, { error: "upstream network unavailable" });
      // A revert, with and without the token's own balance words.
      if (settleMode === "revert") return reply(200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: "execution reverted", transaction: "", network: net, payer });
      if (settleMode === "revert-balance") return reply(200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: "execution reverted: ERC20: transfer amount exceeds balance", transaction: "", network: net, payer });
      return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: net, payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn("node", ["--import", "./scripts/lib/upstream-stub-preload.js", "src/server.js"], {
  env: {
    ...process.env, ...ownStoreEnv("settle-breaker"), PORT: String(PORT), FREE_MODE: "", OPENAI_API_KEY: "test-key-never-used",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    // Two networks, so both facilitator clients a multi-chain boot builds are
    // pointed at the stub: nothing here reaches a real facilitator.
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, SOLVADOR_KEY: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYMENT_SETTLE_FALLBACK: "", AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base,polygon", EVM_RPC_137: `http://127.0.0.1:${FAC_PORT}/rpc`, MPP_SECRET_KEY: "",
    GATEWAY_SETTLE_BREAKER_MAX: String(MAX), GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "4",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    AGENT402_OPERATOR_TOKEN: OP_TOKEN,
    // /v1/embeddings prices its margin clamp from the upstream cost table and
    // answers 503 before any settle when the table has no embeddings row. The
    // server reads the committed placeholder table, never the private one from
    // the caller's environment, so the /v1 half runs the same with or without
    // the secret (a fork PR, a local shell) and never depends on a real rate.
    UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const OP_HEADERS = { Authorization: `Bearer ${OP_TOKEN}` };
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
const BASE = "eip155:8453", POLYGON = "eip155:137";
const accepts = {};
const acceptFor = async (t, network = BASE) => {
  const k = `${network} ${t.path}`;
  if (accepts[k]) return accepts[k];
  const r = await fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json" }, body: t.body });
  ok(r.status === 402, `unpaid ${t.method} ${t.path} -> 402 (got ${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[k] = (req402.accepts || []).find((a) => a.network === network && a.scheme === "exact"); ok(!!accepts[k], `${t.path} offers exact on ${network}`);
  return accepts[k];
};
const pay = async (t, payer, network = BASE) => fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json", "payment-signature": credential(await acceptFor(t, network), payer) }, body: t.body });

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

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
    // The exact text, and the fields an agent acts on without parsing it.
    const secs = Number(r.headers.get("retry-after"));
    const m = /^Recent payments from this wallet on eip155:8453 failed to settle \(3 in the last 10 min: they verified, the call was served, and the settlement then refused the payment itself, for its balance, its signature, or an authorization already used or expired\); paid tools refuse new calls from it on eip155:8453 until (\d{4}-\d\d-\d\dT[\d:.]+Z) \(about (\d+) s\)\. That holds eip155:8453 only: this wallet can pay on any other network this route offers right now \(the networks are accepts\[\]\.network in the route's 402\)\. Nothing was charged for this request\. Before paying on eip155:8453 again, check the wallet's balance of the payment token there and sign a new authorization\.$/.exec(body.error || "");
    ok(!!m && Number(m[2]) === secs, `the 429 names the refused network, says another network works now, when Base opens again and what to check (${body.error})`);
    ok(body.retry === "other-network" && body.refusedNetwork === BASE && body.retryAfterSeconds === secs && secs >= 1 && body.otherNetworksFrom === "accepts[].network in this route's 402", `machine-readable fields ride beside the message (${JSON.stringify({ retry: body.retry, refusedNetwork: body.refusedNetwork, retryAfterSeconds: body.retryAfterSeconds, otherNetworksFrom: body.otherNetworksFrom })})`);
    // THE SAME WALLET ON ANOTHER NETWORK, in the same instant: the route's 402
    // lists Polygon (where the fields point), and a payment there reaches the
    // handler (settles advanced). The Base refusal beside it is the control.
    const s0 = settles;
    const onY = await pay(WALLET_ONLY, PAYER_A, POLYGON);
    ok(onY.status !== 429 && settles === s0 + 1, `wallet A, refused on Base, is served on Polygon at once: the handler ran (status ${onY.status}, settles ${settles} == ${s0 + 1})`);
    const s1 = settles;
    const onX = await pay(WALLET_ONLY, PAYER_A);
    ok(onX.status === 429 && settles === s1, `control: the same wallet's next Base payment is still refused before the handler (status ${onX.status})`);
    settleMode = "ok";
    const paidY = await pay(WALLET_ONLY, PAYER_A, POLYGON);
    settleMode = "fail";
    ok(paidY.status === 200, `and a Polygon payment that settles answers 200 while Base stays refused (got ${paidY.status})`);
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
  // A settled 200 is an outcome, not an eraser: wallet B (one failure so far)
  // settles one call, then fails again; with three failures against one
  // settled call it is refused, since failures are more than half its outcomes.
  {
    settleMode = "ok";
    const r = await pay(WALLET_ONLY, PAYER_B);
    ok(r.status === 200, `wallet B: a settled call answers 200 (got ${r.status})`);
    settleMode = "fail";
    const statuses = [];
    for (let i = 1; i <= MAX; i++) statuses.push((await pay(WALLET_ONLY, PAYER_B)).status);
    ok(statuses.join(",") === "402,402,429", `one settled call does not restart the count: wallet B's failures (1 + ${MAX}) against one settled call refuse it on the third (got ${statuses.join(",")})`);
    // Wallet B had settled a call, so its refusal is a refused PAYING buyer:
    // buyerRefusals reads refusing on /api/gateway-status (the word only) and
    // the operator detail carries the count. Wallet A, with no settled call,
    // was refused above and counts for nothing: the count is exactly one.
    const gw = await (await fetch(`${B}/api/gateway-status`)).json();
    ok(JSON.stringify(gw.buyerRefusals) === JSON.stringify({ status: "refusing" }), `a refused paying buyer reads buyerRefusals=refusing, the word only (${JSON.stringify(gw.buyerRefusals)})`);
    const op = await (await fetch(`${B}/__operator/tool-failures.json`, { headers: OP_HEADERS })).json();
    ok(op.buyerRefusalsWindow === 1 && op.buyerRefusals === "refusing", `the operator detail counts one refused paying buyer, none for the wallet that never settled (${op.buyerRefusalsWindow})`);
  }
  // A wallet that mostly settles is never refused by a few failures: wallet C
  // settles four calls, then three fail in a row; every one of them is served.
  {
    settleMode = "ok";
    for (let i = 0; i < 4; i++) ok((await pay(WALLET_ONLY, PAYER_C)).status === 200, `wallet C settles call ${i + 1}`);
    settleMode = "fail";
    const statuses = [];
    for (let i = 1; i <= MAX; i++) statuses.push((await pay(WALLET_ONLY, PAYER_C)).status);
    ok(statuses.every((st) => st === 402), `${MAX} failures against four settled calls never refuse wallet C (got ${statuses.join(",")})`);
    const r = await pay(WALLET_ONLY, PAYER_C);
    ok(r.status === 402, `and its next call still reaches the handler (got ${r.status})`);
    const r2 = await pay(WALLET_ONLY, PAYER_B);
    ok(r2.status === 429, `... and the next is 429 (got ${r2.status})`);
  }
  // Per-wallet ONLY: by now 8+ catalog settle failures have happened across two
  // wallets, well past GLOBAL_MAX (4) - and a THIRD wallet is still served.
  // Catalog failures do not feed the /v1 burst alarm (checked below: the word
  // still reads ok after the single-wallet burst).
  {
    const before = settles;
    const r = await pay(WALLET_ONLY, "0x00000000000000000000000000000000000000c3");
    ok(r.status === 402 && settles === before + 1, `a third wallet still reaches the handler (status ${r.status})`);
  }
  // THE /v1 BURST ALARM, through HTTP. The catalog failures above (well past
  // GLOBAL_MAX, across three wallets) fed nothing into it.
  const V1 = (i) => ({ path: "/v1/embeddings", method: "POST", body: JSON.stringify({ input: `settle breaker probe ${i}` }) });
  const wallet = (i) => "0x" + "e".repeat(38) + i.toString(16).padStart(2, "0");
  const GLOBAL_MAX = 4; // GATEWAY_SETTLE_BREAKER_GLOBAL_MAX below
  // ONE wallet, a concurrent burst: every call passes the per-wallet check
  // before any of the burst's failures lands, so well over GLOBAL_MAX handlers
  // run and fail to settle. That wallet is the per-wallet bound's business; it
  // must not raise the alarm (it counts distinct buyers).
  {
    await acceptFor(V1(0));
    // One settled /v1 call first: a 503 here means the route itself cannot
    // serve (no cost row, no stubbed upstream), which would make every burst
    // assertion below read 0 handlers for a reason that is not the breaker.
    {
      settleMode = "ok";
      const r = await pay(V1(0), wallet(0x8f));
      const body = await r.json().catch(() => ({}));
      settleMode = "fail";
      ok(r.status === 200, `/v1/embeddings serves a paid call to a 200 before the breaker checks (got ${r.status}${r.status === 200 ? "" : `: ${String(body.error || "").slice(0, 80)}`})`);
    }
    const before = settles;
    const burst = await Promise.all(Array.from({ length: 10 }, (_, k) => pay(V1(100 + k), wallet(0x90))));
    const ran = settles - before;
    ok(ran >= GLOBAL_MAX && burst.every((r) => r.status === 402 || r.status === 429), `one wallet's burst of 10 concurrent /v1 calls: ${ran} handlers ran and failed to settle (>= GLOBAL_MAX ${GLOBAL_MAX}; statuses ${burst.map((r) => r.status).join(",")})`);
    const b0 = settles;
    const r = await pay(V1(200), wallet(0x91));
    ok(r.status === 402 && settles === b0 + 1, `...and a DIFFERENT wallet's /v1 call still reaches its handler (status ${r.status}, settles ${settles})`);
    const w0 = (await (await fetch(`${B}/api/gateway-status`)).json()).settleFailures;
    ok(w0?.status === "ok", `one buyer's burst does not raise the alarm: settleFailures reads ok (${JSON.stringify(w0)})`);
  }
  // Now /v1 calls from DIFFERENT fresh wallets (one failure each, far under
  // the per-wallet MAX) run the handler and fail to settle. Two buyers failed
  // above; GLOBAL_MAX - 2 more reach the count. Nobody is refused for it: the
  // next /v1 call, from yet another wallet, reaches its handler, and
  // settleFailures reads burst on /api/gateway-status.
  {
    const wordOf = async (headers) => (await (await fetch(`${B}/api/gateway-status`, { headers })).json().catch(() => ({}))).settleFailures;
    for (let i = 1; i <= GLOBAL_MAX - 2; i++) {
      if (i === GLOBAL_MAX - 2) ok(JSON.stringify(await wordOf()) === JSON.stringify({ status: "ok" }), `control: one buyer short of the count, settleFailures reads ok, the word only (${JSON.stringify(await wordOf())})`);
      const before = settles;
      const r = await pay(V1(i), wallet(i));
      ok(r.status === 402 && settles === before + 1, `/v1 call ${i} from its own wallet: the handler ran (upstream stubbed), settlement failed -> 402 (status ${r.status}, settles ${settles})`);
    }
    const g = await (await fetch(`${B}/api/gateway-status`)).json().catch(() => ({}));
    ok(JSON.stringify(g.settleFailures) === JSON.stringify({ status: "burst" }), `after /v1 settle failures from ${GLOBAL_MAX} different wallets settleFailures reads burst, the word only (${JSON.stringify(g.settleFailures)})`);
    const op = await wordOf({ "X-Operator-Token": OP_TOKEN });
    ok(op?.status === "burst" && op.threshold === GLOBAL_MAX && op.trips === 1 && typeof op.until === "string", `the operator read adds the counts (${JSON.stringify(op)})`);
    const before = settles;
    const r = await pay(V1(99), wallet(99));
    const body = await r.json().catch(() => ({}));
    ok(r.status === 402 && settles === before + 1 && !/paused/.test(body.error || ""), `the NEXT /v1 buyer is served while the word reads burst: its handler ran and reached settlement (status ${r.status}, settles ${settles} == ${before + 1})`);
    settleMode = "ok";
    const paid = await pay(V1(98), wallet(98));
    settleMode = "fail";
    ok(paid.status === 200, `and a /v1 buyer whose payment settles gets its 200 during the alarm (got ${paid.status})`);
    const txt = JSON.stringify(g) + JSON.stringify(op);
    ok(!txt.includes(wallet(1)), "the alarm is reported without naming a wallet");
    // THE SERVICE-WIDE BOUND: GLOBAL_MAX buyers' payments failed, so a wallet
    // whose own payments mostly fail is held after ONE unsettled /v1 run, not
    // MAX: wallet 99 (one failure, nothing settled) is refused before its
    // handler; wallet 98 (one settled, then one failure) is still served.
    {
      const b2 = settles;
      const held = await pay(V1(97), wallet(99));
      const hb = await held.json().catch(() => ({}));
      ok(held.status === 429 && settles === b2 && /failed to settle \(1 in the last/.test(hb.error || "") && /Nothing was charged/.test(hb.error || ""), `while the bound is up a wallet with one failed /v1 settle of its own is refused 429 before the handler (status ${held.status}, settles ${settles} == ${b2}: ${String(hb.error).slice(0, 70)})`);
      const s98 = settles;
      const f98 = await pay(V1(96), wallet(98));
      const again = await pay(V1(95), wallet(98));
      ok(f98.status === 402 && again.status === 402 && settles === s98 + 2, `a wallet that settled a call is served beside one failure while the bound is up (statuses ${f98.status},${again.status}, settles ${settles - s98})`);
    }
    // Control: the per-wallet rule still acts on its own wallet during the alarm.
    const w = wallet(0x92);
    for (let i = 0; i < MAX; i++) await pay(V1(300 + i), w);
    const b1 = settles;
    const own = await pay(V1(310), w);
    ok(own.status === 429 && settles === b1, `control: during the alarm a wallet with failed settles of its own is refused 429 before the handler (status ${own.status})`);
  }
  // A FACILITATOR billing refusal on an EVM rail (free_tier_exhausted, both
  // wire shapes), and the facilitator answering HTTP 503 at settle. Neither is
  // a verdict on the buyer's payment, so neither is counted against the
  // wallet: every call is served and answered 402 (nothing charged), the
  // billing one naming the rail, and the wallet is never refused 429 for
  // them. The run raises the burst alarm instead (scripts/test-gateway-settle-breaker.js),
  // which is why this runs after the alarm checks above.
  {
    const PAYER_Q = "0x00000000000000000000000000000000000000d4";
    for (let i = 1; i <= MAX + 1; i++) {
      settleMode = i % 2 ? "quota" : "quota-thrown";
      const before = settles;
      const r = await pay(WALLET_ONLY, PAYER_Q);
      const body = await r.json().catch(() => ({}));
      ok(r.status === 402 && settles === before + 1, `quota refusal ${i} (${settleMode}): served, then refused at settle -> 402 (status ${r.status}, settles ${settles})`);
      ok(body.reason === "facilitator-quota" && body.retry === "other-network" && /not because of your wallet/.test(body.hint || "") && !/failed to settle/.test(body.error || ""), `quota refusal ${i}: the 402 names the rail, not the wallet (got ${body.reason}: ${String(body.error).slice(0, 50)})`);
    }
    settleMode = "down";
    const PAYER_D = "0x00000000000000000000000000000000000000d5";
    for (let i = 1; i <= MAX + 1; i++) {
      const before = settles;
      const r = await pay(WALLET_ONLY, PAYER_D);
      ok(r.status === 402 && settles === before + 1, `facilitator 503 at settle ${i}: served, not settled -> 402, never 429 (status ${r.status}, settles ${settles})`);
    }
    // ONE authorization re-presented while the facilitator fails: the same
    // signed credential is served MAX times unsettled, then refused before
    // the handler with the field that says to sign a new one; a new
    // authorization from the same wallet is served at once.
    const PAYER_R = "0x00000000000000000000000000000000000000d6";
    const same = credential(await acceptFor(WALLET_ONLY), PAYER_R);
    const resend = () => fetch(`${B}${WALLET_ONLY.path}`, { method: WALLET_ONLY.method, headers: { "content-type": "application/json", "payment-signature": same } });
    const st = [];
    for (let i = 0; i < MAX; i++) { const s0 = settles; const r = await resend(); st.push(`${r.status}${settles === s0 + 1 ? "" : "!"}`); }
    const s0 = settles;
    const rr = await resend();
    const rb = await rr.json().catch(() => ({}));
    ok(st.every((x) => x === "402") && rr.status === 429 && settles === s0 && rb.hint === "sign-new-authorization" && /Sign a new authorization/.test(rb.error || ""), `one authorization re-presented: served ${MAX} times unsettled, then refused 429 before the handler (${st.join(",")} then ${rr.status} ${rb.hint}: ${String(rb.error).slice(0, 60)})`);
    const s1 = settles;
    const fresh = await pay(WALLET_ONLY, PAYER_R);
    ok(fresh.status === 402 && settles === s1 + 1, `the same wallet with a new authorization is served at once (status ${fresh.status})`);
  }
  // Through the wire, what a revert proves: with the token's balance words it
  // is a verdict (three refuse, in the verdict words); without them it is of
  // unknown cause, still bounded per wallet, at three times the count, in
  // words that blame no one.
  {
    const UNKNOWN_MAX = 3 * MAX;
    settleMode = "revert-balance";
    const PAYER_RB = "0x00000000000000000000000000000000000000e6";
    for (let i = 1; i <= MAX; i++) { const s0 = settles; const r = await pay(WALLET_ONLY, PAYER_RB); ok(r.status === 402 && settles === s0 + 1, `revert naming the balance ${i}: served, refused at settle (status ${r.status})`); }
    let s0 = settles;
    let r = await pay(WALLET_ONLY, PAYER_RB);
    let body = await r.json().catch(() => ({}));
    ok(r.status === 429 && settles === s0 && /refused the payment itself/.test(body.error || ""), `a revert naming the balance is a verdict: the next is refused 429 before the handler (${r.status}: ${String(body.error).slice(0, 80)})`);
    settleMode = "revert";
    const PAYER_RV = "0x00000000000000000000000000000000000000e7";
    for (let i = 1; i <= UNKNOWN_MAX; i++) { const s1 = settles; const r1 = await pay(WALLET_ONLY, PAYER_RV); ok(r1.status === 402 && settles === s1 + 1, `bare revert ${i} (unknown cause): served, refused at settle (status ${r1.status})`); }
    s0 = settles;
    r = await pay(WALLET_ONLY, PAYER_RV);
    body = await r.json().catch(() => ({}));
    ok(r.status === 429 && settles === s0 && /did not complete/.test(body.error || "") && !/balance|signature|failed to settle/.test(body.error || ""), `after ${UNKNOWN_MAX} bare reverts the wallet is refused 429 before the handler, in words that blame no one (${r.status}: ${String(body.error).slice(0, 100)})`);
  }
  settleMode = "fail";
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
