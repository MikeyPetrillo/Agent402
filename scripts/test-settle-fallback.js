#!/usr/bin/env node
// Offline test for the settle-fallback chain in src/payments.js:
// Solvador first on the networks it advertises, then PayAI on the networks it
// can settle, then Solvador as the ungated last resort elsewhere (order set
// 2026-09-18: the cheaper fallback runs first).
//
// The property that must never regress is the double-settle gate: a fallback
// facilitator is only tried when every earlier settler PROVABLY did not
// broadcast (an HTTP 402 from /settle, or a billing refusal on our facilitator
// account). A timeout or 5xx anywhere in the chain means a transfer may already
// be on-chain, and trying anyone else could charge the buyer twice. The unit
// half drives the real registerFacilitatorFailureHooks against stub facilitator
// clients; the last part boots a paid server against stub facilitators to
// prove the caller path.
import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { SettleError } from "@x402/core/types";
import { getFreePorts } from "./lib/free-port.js";
import {
  registerFacilitatorFailureHooks,
  fallbackCandidatesFor,
  isPreBroadcastSettleRejection,
} from "../src/payments.js";

let failures = 0;
const check = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); });
};

// A fake x402ResourceServer capturing the hooks the real one would run.
function fakeServer() {
  const hooks = {};
  return {
    hooks,
    onVerifyFailure(fn) { hooks.verifyFailure = fn; return this; },
    onAfterSettle(fn) { hooks.afterSettle = fn; return this; },
    onSettleFailure(fn) { hooks.settleFailure = fn; return this; },
  };
}
const client = (name, behavior, log) => ({
  settle: async () => {
    log.push(name);
    return behavior(); // return a result, or throw
  },
});
const rejection402 = () => Object.assign(new Error("settle failed (402)"), { status: 402 });
const timeout = () => Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
const ctx = (network, error) => ({
  requirements: { network, scheme: "exact" },
  paymentPayload: { p: 1 },
  error,
});
const SEI = "eip155:1329"; // PayAI settles it, Solvador does not advertise it
const NOBODY = "eip155:999999"; // neither advertises it

console.log("settle-fallback chain");

await check("gate: 402-class is pre-broadcast, timeout/5xx is not", () => {
  assert.equal(isPreBroadcastSettleRejection(rejection402()), true);
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("payment-method-required"), {})), true);
  assert.equal(isPreBroadcastSettleRejection(timeout()), false);
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("500 upstream"), { status: 500 })), false);
  assert.equal(isPreBroadcastSettleRejection(null), false);
});

await check("candidates: Solvador first where it advertises, PayAI where it can settle, each skipped elsewhere", () => {
  const pa = {}, sv = {};
  // Base, Polygon, Arbitrum, Avalanche, Solana: both advertise; the cheaper one runs first.
  for (const net of ["eip155:8453", "eip155:137", "eip155:42161", "eip155:43114", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
    assert.deepEqual(fallbackCandidatesFor(net, pa, sv).map((c) => c.name), ["Solvador", "PayAI"], net);
  }
  // Celo, Monad, Robinhood: PayAI cannot settle them; Solvador advertises them and is the only candidate.
  for (const net of ["eip155:42220", "eip155:143", "eip155:4663"]) {
    assert.deepEqual(fallbackCandidatesFor(net, pa, sv).map((c) => c.name), ["Solvador"], net);
  }
  // Sei: PayAI settles it, Solvador does not advertise it, so Solvador keeps the ungated LAST slot.
  assert.deepEqual(fallbackCandidatesFor(SEI, pa, sv).map((c) => c.name), ["PayAI", "Solvador"]);
  // A network neither advertises: Solvador alone, as the last resort it always was.
  assert.deepEqual(fallbackCandidatesFor(NOBODY, pa, sv).map((c) => c.name), ["Solvador"]);
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", pa, null).map((c) => c.name), ["PayAI"]);
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", null, sv).map((c) => c.name), ["Solvador"]);
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", null, null), []);
});

await check("candidates: a network whose primary is Solvador falls back to its own named client, never back to Solvador", () => {
  const pa = {}, sv = {}, celo = {};
  const ov = { "eip155:42220": [{ name: "Celo", client: celo }] };
  assert.deepEqual(fallbackCandidatesFor("eip155:42220", pa, sv, ov).map((c) => c.name), ["Celo"]);
  assert.equal(fallbackCandidatesFor("eip155:42220", pa, sv, ov)[0].client, celo);
  assert.deepEqual(fallbackCandidatesFor("eip155:42220", pa, sv, { "eip155:42220": [] }), [], "no Celo client: no fallback rather than a repeat");
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI"], "other networks keep their chain");
});

await check("source: the order is derived from SOLVADOR_SETTLE_NETWORKS, Solvador pushed before PayAI, and the boot line says so", () => {
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  assert.match(src, /const SOLVADOR_SETTLE_NETWORKS = new Set\(\[/, "Solvador has an allowlist (it runs first, so a wasted attempt would mask PayAI)");
  const fn = src.slice(src.indexOf("export function fallbackCandidatesFor("), src.indexOf("\n}", src.indexOf("export function fallbackCandidatesFor(")));
  const solvadorFirst = fn.indexOf('name: "Solvador"');
  const payai = fn.indexOf('name: "PayAI"');
  assert.ok(solvadorFirst > -1 && payai > -1 && solvadorFirst < payai, "Solvador is pushed before PayAI in fallbackCandidatesFor");
  assert.match(fn, /SOLVADOR_SETTLE_NETWORKS\.has\(network\)/, "the Solvador-first slot is gated on its advertised networks");
  assert.match(fn, /PAYAI_SETTLE_NETWORKS\.has\(network\)/, "PayAI stays gated on the networks it can settle");
  assert.match(src, /Settle fallback: ON - chain \$\{solvadorClient \? "Solvador/, "the boot log names Solvador first");
});

// The shapes @x402/core 2.28 actually throws. HTTPFacilitatorClient builds a
// SettleError(response.status, body) for a non-2xx JSON /settle body (field
// `statusCode`, never `status`); a 200 {success:false} becomes a SettleError
// with a synthetic statusCode 500 (settleResponseToError). The Celo
// facilitator's out-of-funds answer carries no errorReason, so its message
// reads "unknown reason: Out of mainnet settlement funds ...".
const settleError = (statusCode, body) => new SettleError(statusCode, { success: false, transaction: "", network: "eip155:42220", ...body });
const celoOutOfFunds = (statusCode = 402) => settleError(statusCode, { errorMessage: "Out of mainnet settlement funds (this settlement costs 1 micro-USD). Top up at the dashboard." });

await check("gate: SettleError statusCode 402 is pre-broadcast (the field @x402/core sets)", () => {
  const e = settleError(402, { errorReason: "payment_required" });
  assert.equal(e.status, undefined, "the vendor error carries statusCode, not status");
  assert.equal(isPreBroadcastSettleRejection(e), true);
});

await check("gate: billing refusals on our account are pre-broadcast, whatever the status", () => {
  for (const st of [402, 403, 400, 500]) assert.equal(isPreBroadcastSettleRejection(celoOutOfFunds(st)), true, `Celo out-of-funds ${st}`);
  // The labelled form the diagnostics wrapper leaves (prefix only, fields kept).
  const labelled = celoOutOfFunds(403); labelled.message = `[Celo (https://facilitator.example)] ${labelled.message}`;
  assert.equal(isPreBroadcastSettleRejection(labelled), true);
  assert.equal(isPreBroadcastSettleRejection(settleError(403, { errorReason: "free_tier_exhausted" })), true, "PayAI free_tier_exhausted");
  assert.equal(isPreBroadcastSettleRejection(settleError(500, { errorReason: "insufficient_credits" })), true, "insufficient_credits");
  assert.equal(isPreBroadcastSettleRejection(settleError(403, { errorReason: "unexpected_error", errorMessage: "payment-method-required" })), true, "CDP payment-method-required");
});

await check("gate: 5xx, timeouts, aborts, network errors and other wording are NOT pre-broadcast", () => {
  assert.equal(isPreBroadcastSettleRejection(settleError(500, { errorReason: "unexpected_error", errorMessage: "upstream 502" })), false, "SettleError 500");
  assert.equal(isPreBroadcastSettleRejection(settleError(503, {})), false, "SettleError 503 with no words");
  assert.equal(isPreBroadcastSettleRejection(settleError(400, { errorReason: "invalid_payload" })), false, "SettleError 400");
  assert.equal(isPreBroadcastSettleRejection(new Error("Facilitator settle failed (500): <html>bad gateway</html>")), false, "plain 500");
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), false, "abort");
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("Facilitator settle timed out"), { name: "TimeoutError" })), false, "timeout");
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })), false, "socket");
  // Billing words riding on a transport failure prove nothing.
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("insufficient_credits"), { code: "ETIMEDOUT" })), false, "timeout with billing words");
  // A payment verdict is never relabelled by words in its message.
  assert.equal(isPreBroadcastSettleRejection(settleError(500, { errorReason: "transaction_failed", errorMessage: "out of mainnet settlement funds" })), false, "verdict");
  assert.equal(isPreBroadcastSettleRejection(settleError(500, { errorReason: "insufficient_funds" })), false, "the buyer's insufficient_funds");
  // A refusal naming a transaction may be on-chain, whatever it says.
  assert.equal(isPreBroadcastSettleRejection(new SettleError(402, { success: false, errorReason: "insufficient_credits", transaction: "0x" + "ab".repeat(32), network: "eip155:42220" })), false, "names a tx");
});

async function run({ flag, primaryError, payai, solvador, network = "eip155:8453" }) {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = flag ? "true" : "";
  const calls = [];
  const s = fakeServer();
  registerFacilitatorFailureHooks(
    s,
    payai ? client("PayAI", payai, calls) : null,
    solvador ? client("Solvador", solvador, calls) : null,
  );
  const out = await s.hooks.settleFailure(ctx(network, primaryError));
  if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK;
  else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  return { out, calls };
}

await check("flag off: nothing is ever tried", async () => {
  const { out, calls } = await run({ flag: false, primaryError: rejection402(), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("primary timeout: no fallback at all (may have broadcast)", async () => {
  const { out, calls } = await run({ flag: true, primaryError: timeout(), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("primary 402 on Base: Solvador recovers, PayAI never touched (never billed)", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: () => ({ success: true, tx: "0xabc" }), payai: () => { throw new Error("should not be called"); } });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["Solvador"]);
});

await check("Solvador rejects 402-clean: chain continues, PayAI recovers", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => ({ success: true, tx: "0xdef" }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["Solvador", "PayAI"]);
});

await check("THE gate: Solvador timeout STOPS the chain - PayAI must not run", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: () => { throw timeout(); }, payai: () => ({ success: true }) });
  assert.equal(out, undefined, "a recovery after an ambiguous failure would risk a double-charge");
  assert.deepEqual(calls, ["Solvador"], "PayAI ran after an ambiguous Solvador failure");
});

await check("Sei: PayAI first (Solvador does not advertise it), Solvador still the last resort on a clean PayAI 402", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), network: SEI, payai: () => { throw rejection402(); }, solvador: () => ({ success: true }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["PayAI", "Solvador"]);
});

await check("Celo goes straight to Solvador (PayAI cannot settle it)", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), network: "eip155:42220", payai: () => { throw new Error("should not be called"); }, solvador: () => ({ success: true }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["Solvador"]);
});

await check("thrown 400 (invalid-payload class) never falls back - 402 only", async () => {
  const err400 = Object.assign(new Error("settle failed (400) invalid payload"), { status: 400 });
  assert.equal(isPreBroadcastSettleRejection(err400), false);
  const { out, calls } = await run({ flag: true, primaryError: err400, payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("graceful {success:false} rejections route to afterSettle, never the fallback", async () => {
  // Verified against @x402/core's settlePayment: a facilitator returning
  // { success:false } RETURNS normally - the onSettleFailure catch block is
  // never reached - so buyer-side failures (insufficient_funds, simulation
  // failed, failed on-chain) structurally cannot trigger a fallback settle.
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  const calls = [];
  const s = fakeServer();
  registerFacilitatorFailureHooks(
    s,
    client("PayAI", () => ({ success: true }), calls),
    client("Solvador", () => ({ success: true }), calls),
  );
  await s.hooks.afterSettle({ requirements: { network: "eip155:8453", scheme: "exact" }, result: { success: false, errorReason: "insufficient_funds" } });
  if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK;
  else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  assert.deepEqual(calls, [], "a graceful rejection must never reach a fallback client");
});

await check("no Solvador key: behavior is exactly the old PayAI-only chain", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), payai: () => { throw rejection402(); }, solvador: null });
  assert.equal(out, undefined);
  assert.deepEqual(calls, ["PayAI"]);
});

await check("Celo out-of-funds SettleError (statusCode, no errorReason): Solvador recovers", async () => {
  const { out, calls } = await run({ flag: true, primaryError: celoOutOfFunds(402), network: "eip155:42220", payai: () => { throw new Error("should not be called"); }, solvador: () => ({ success: true, transaction: "0x01", network: "eip155:42220" }) });
  assert.equal(out?.recovered, true);
  assert.equal(out?.result?.success, true);
  assert.deepEqual(calls, ["Solvador"]);
});

await check("primary SettleError 402 on Base: falls back", async () => {
  const { out, calls } = await run({ flag: true, primaryError: settleError(402, { errorReason: "payment_required" }), solvador: () => ({ success: true }), payai: () => ({ success: true }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["Solvador"]);
});

await check("primary SettleError 5xx or timeout: NO fallback", async () => {
  for (const e of [settleError(502, { errorReason: "unexpected_error" }), Object.assign(new Error("Facilitator settle timed out"), { name: "TimeoutError" })]) {
    const { out, calls } = await run({ flag: true, primaryError: e, network: "eip155:42220", solvador: () => ({ success: true }) });
    assert.equal(out, undefined, e.message);
    assert.deepEqual(calls, [], e.message);
  }
});

await check("fallback refuses pre-broadcast (thrown SettleError 402 or billing): next candidate runs", async () => {
  for (const refuse of [() => { throw settleError(402, {}); }, () => { throw settleError(403, { errorReason: "insufficient_credits" }); }]) {
    const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: refuse, payai: () => ({ success: true }) });
    assert.equal(out?.recovered, true);
    assert.deepEqual(calls, ["Solvador", "PayAI"]);
  }
});

await check("fallback graceful 200 billing refusal: next candidate runs", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: () => ({ success: false, errorReason: "insufficient_credits", transaction: "" }), payai: () => ({ success: true }) });
  assert.equal(out?.recovered, true);
  assert.equal(out?.result?.success, true);
  assert.deepEqual(calls, ["Solvador", "PayAI"]);
});

await check("fallback ambiguous failure (SettleError 5xx, graceful non-billing): chain STOPS, never 'recovered' with a failure", async () => {
  const ambiguous = [
    () => { throw settleError(500, { errorReason: "unexpected_error" }); },
    () => ({ success: false, errorReason: "transaction_failed", transaction: "0x" + "cd".repeat(32) }),
    () => ({ success: false, errorReason: "unexpected_error" }),
  ];
  for (const f of ambiguous) {
    const { out, calls } = await run({ flag: true, primaryError: rejection402(), solvador: f, payai: () => ({ success: true }) });
    assert.equal(out, undefined);
    assert.deepEqual(calls, ["Solvador"]);
  }
});

await check("source: the gate reuses payment-reject's billing classifier and reads statusCode", () => {
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const start = src.indexOf("export function isPreBroadcastSettleRejection(");
  const fn = src.slice(start, src.indexOf("\n}", start));
  assert.match(fn, /err\.statusCode === 402/);
  assert.match(fn, /isBillingRefusalReceipt\(/);
});

// THE CALLER PATH. A paid server with Celo as the primary facilitator (a stub
// that verifies and then refuses /settle the way the real one does when the
// account is out of funds) and Solvador as the fallback (a stub that settles).
// A buyer paying on Celo must get a 200, exactly one settlement must land
// (Solvador's), the receipt names Celo, and the sale is booked on Celo with
// Solvador's tx. The control: a Celo 5xx never reaches Solvador and the buyer
// gets a 402 (not charged).
await (async () => {
  const [PORT, BASE_FAC, CELO_FAC, SV_FAC] = await getFreePorts(4);
  const B = `http://127.0.0.1:${PORT}`;
  const CELO = "eip155:42220";
  const SV_TX = "0x" + "5e".repeat(32);
  const st = { celoSettles: 0, svSettles: 0, celoMode: "out-of-funds", svBody: null };
  const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const stub = (handler) => createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* ignore */ } handler(req, res, body); });
  });
  const payerOf = (body) => body?.paymentPayload?.payload?.authorization?.from;
  const baseFac = stub((req, res) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return json(res, 200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return json(res, 404, {});
  });
  const celoFac = stub((req, res, body) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: CELO }], extensions: [], signers: {} });
    if (req.url === "/verify") return json(res, 200, { isValid: true, payer: payerOf(body) });
    if (req.url === "/settle") {
      st.celoSettles++;
      if (req.headers["x-api-key"] !== "celo-test-key") return json(res, 401, { error: "unauthorized" });
      if (st.celoMode === "out-of-funds" || st.celoMode === "out-of-funds-403") return json(res, st.celoMode === "out-of-funds" ? 402 : 403, { success: false, errorMessage: "Out of mainnet settlement funds (this settlement costs 1 micro-USD). Top up at the dashboard.", transaction: "", network: CELO });
      return json(res, 502, { success: false, errorReason: "unexpected_error", errorMessage: "upstream", transaction: "", network: CELO });
    }
    return json(res, 404, {});
  });
  const svFac = stub((req, res, body) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: CELO }], extensions: [], signers: {} });
    if (req.url === "/settle") {
      st.svSettles++; st.svBody = body;
      if (req.headers["x-api-key"] !== "solvador-test-key") return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { success: true, transaction: SV_TX, network: CELO, payer: payerOf(body) });
    }
    return json(res, 404, {});
  });
  await Promise.all([[baseFac, BASE_FAC], [celoFac, CELO_FAC], [svFac, SV_FAC]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const tmp = mkdtempSync(join(tmpdir(), "a402-settle-fallback-"));
  const salesDb = join(tmp, "sales.db");
  const env = { ...process.env };
  delete env.STATE_DATABASE_URL;
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(PORT), FREE_MODE: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
      PAYMENT_NETWORKS: "base,celo",
      CELO_FACILITATOR_URL: `http://127.0.0.1:${CELO_FAC}`, CELO_FACILITATOR_KEY: "celo-test-key",
      SOLVADOR_KEY: "solvador-test-key", SOLVADOR_FACILITATOR_URL: `http://127.0.0.1:${SV_FAC}`,
      PAYMENT_SETTLE_FALLBACK: "true", SALES_LEDGER_DB: salesDb,
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) log.push(l.slice(0, 400)); if (log.length > 200) log.splice(0, log.length - 200); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let nonce = 0;
  const PAYER = "0x00000000000000000000000000000000000000c7";
  const credential = (accepted) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonce).toString(16).padStart(64, "0") } },
  })).toString("base64");
  const PATH = "/api/demand-radar?limit=1"; // wallet-only, answers from local state
  const failuresBefore = failures;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
    await check("e2e: the paid server boots with the Solvador fallback on", async () => {
      assert.ok(up, "server never came up");
      assert.ok(log.some((l) => /Settle fallback: ON - chain Solvador/.test(l)), "boot line names the Solvador fallback");
    });
    let accepted;
    await check("e2e: an unpaid call offers exact on Celo USDC", async () => {
      const r = await fetch(`${B}${PATH}`);
      assert.equal(r.status, 402);
      const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8"));
      accepted = (req402.accepts || []).find((a) => a.network === CELO);
      assert.ok(accepted, `no Celo accept in ${JSON.stringify((req402.accepts || []).map((a) => a.network))}`);
    });
    await check("e2e: Celo refuses out-of-funds -> Solvador settles once -> buyer gets 200, booked on Celo with Solvador's tx", async () => {
      const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": credential(accepted) } });
      await r.text();
      assert.equal(r.status, 200, `status ${r.status}`);
      assert.equal(st.celoSettles, 1, "the primary was asked once");
      assert.equal(st.svSettles, 1, "exactly one fallback settle");
      // Solvador was handed the requirements the buyer signed: Celo USDC to our payTo.
      assert.equal(st.svBody?.paymentRequirements?.network, CELO);
      assert.equal(String(st.svBody?.paymentRequirements?.asset).toLowerCase(), String(accepted.asset).toLowerCase());
      assert.equal(String(st.svBody?.paymentRequirements?.payTo).toLowerCase(), String(accepted.payTo).toLowerCase());
      const receipt = JSON.parse(Buffer.from(r.headers.get("payment-response"), "base64").toString("utf8"));
      assert.equal(receipt.success, true);
      assert.equal(receipt.transaction, SV_TX);
      assert.equal(receipt.network, CELO);
      assert.ok(log.some((l) => /recovered eip155:42220 settlement via Solvador fallback/.test(l)), "the recovery is logged");
      const { default: Database } = await import("better-sqlite3");
      let row = null;
      for (let i = 0; i < 40 && !row; i++) {
        try { const db = new Database(salesDb, { readonly: true }); row = db.prepare("SELECT rail, network, tx, payer FROM sales WHERE tx = ?").get(SV_TX) || null; db.close(); } catch { /* not written yet */ }
        if (!row) await sleep(250);
      }
      assert.ok(row, "the sale is in the ledger");
      assert.equal(row.rail, "usdc");
      // The ledger's chain name comes from the settle receipt (networkFromPaymentResponse), as for any Celo sale.
      assert.equal(row.network, "celo");
      assert.equal(String(row.payer).toLowerCase(), PAYER);
    });
    await check("e2e: the same out-of-funds wording on a non-402 status still falls back once (the wording is the proof)", async () => {
      st.celoMode = "out-of-funds-403";
      const sv = st.svSettles, celo = st.celoSettles;
      const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": credential(accepted) } });
      await r.text();
      assert.equal(r.status, 200, `status ${r.status}`);
      assert.equal(st.celoSettles, celo + 1);
      assert.equal(st.svSettles, sv + 1, "exactly one fallback settle");
    });
    await check("e2e control: a Celo 5xx never reaches Solvador, the buyer gets 402 (not charged)", async () => {
      st.celoMode = "5xx";
      const sv = st.svSettles, celo = st.celoSettles;
      const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": credential(accepted) } });
      await r.text();
      assert.equal(r.status, 402, `status ${r.status}`);
      assert.equal(st.celoSettles, celo + 1);
      assert.equal(st.svSettles, sv, "Solvador must not run after an ambiguous primary failure");
    });
  } finally {
    if (failures > failuresBefore) for (const l of log.slice(-40)) console.log("  server:", l);
    proc.kill("SIGKILL");
    for (const s of [baseFac, celoFac, svFac]) s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
})();

// Booted, with the Celo settle demotion (src/settle-demotion.js) wrapping the
// primary: one settle asks each facilitator at most once, a refusal is
// recorded once (a graceful {success:false} included, which @x402/core hands
// the failure hook as a new SettleError), and nothing is settled after an
// ambiguous failure. SETTLE_DEMOTE_AFTER=1 demotes Celo on its first refusal.
await (async () => {
  const [PORT, BASE_FAC, CELO_FAC, SV_FAC] = await getFreePorts(4);
  const B = `http://127.0.0.1:${PORT}`;
  const CELO = "eip155:42220";
  const OP = "settle-demotion-wiring-operator-token-0123456789";
  const SV_TX = "0x" + "5f".repeat(32);
  const st = { celo: 0, sv: 0, svMode: "out-of-funds", order: [] };
  const OUT_OF_FUNDS = { success: false, errorMessage: "Out of mainnet settlement funds (this settlement costs 1 micro-USD). Top up at the dashboard.", transaction: "", network: CELO };
  const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const stub = (handler) => createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* ignore */ } handler(req, res, body); });
  });
  const payerOf = (body) => body?.paymentPayload?.payload?.authorization?.from;
  const baseFac = stub((req, res) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return json(res, 200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return json(res, 404, {});
  });
  const celoFac = stub((req, res, body) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: CELO }], extensions: [], signers: {} });
    if (req.url === "/verify") return json(res, 200, { isValid: true, payer: payerOf(body) });
    if (req.url === "/settle") { st.celo++; st.order.push("celo"); return json(res, 200, { ...OUT_OF_FUNDS, payer: payerOf(body) }); }
    return json(res, 404, {});
  });
  const svFac = stub((req, res, body) => {
    if (req.url === "/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: CELO }], extensions: [], signers: {} });
    if (req.url === "/settle") {
      st.sv++; st.order.push("solvador");
      if (st.svMode === "5xx") return json(res, 500, { success: false, errorReason: "unexpected_error", errorMessage: "upstream", transaction: "", network: CELO });
      if (st.svMode === "ok") return json(res, 200, { success: true, transaction: SV_TX, network: CELO, payer: payerOf(body) });
      return json(res, 200, { ...OUT_OF_FUNDS, payer: payerOf(body) });
    }
    return json(res, 404, {});
  });
  await Promise.all([[baseFac, BASE_FAC], [celoFac, CELO_FAC], [svFac, SV_FAC]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const tmp = mkdtempSync(join(tmpdir(), "a402-settle-demotion-"));
  const env = { ...process.env };
  delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(PORT), FREE_MODE: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
      PAYMENT_NETWORKS: "base,celo",
      CELO_FACILITATOR_URL: `http://127.0.0.1:${CELO_FAC}`, CELO_FACILITATOR_KEY: "celo-test-key",
      SOLVADOR_KEY: "solvador-test-key", SOLVADOR_FACILITATOR_URL: `http://127.0.0.1:${SV_FAC}`, SOLVADOR_CELO_PRIMARY: "",
      PAYMENT_SETTLE_FALLBACK: "true", SETTLE_DEMOTE_AFTER: "1", SETTLE_DEMOTE_COOLDOWN_MS: "600000",
      AGENT402_OPERATOR_TOKEN: OP, SALES_LEDGER_DB: join(tmp, "sales.db"), REFUND_DB_DIR: tmp,
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) log.push(l.slice(0, 400)); if (log.length > 200) log.splice(0, log.length - 200); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let nonce = 0;
  const credential = (accepted) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: `0x${(0xd00 + ++nonce).toString(16).padStart(40, "0")}`, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7700 + nonce).toString(16).padStart(64, "0") } },
  })).toString("base64");
  const PATH = "/api/demand-radar?limit=1";
  const refusals = async () => {
    const j = await (await fetch(`${B}/__operator/tool-failures.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    return (j.facilitatorRefusals || []).filter((r) => r.network === CELO);
  };
  const failuresBefore = failures;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
    let accepted;
    await check("demotion e2e: the paid server boots and offers Celo", async () => {
      assert.ok(up, "server never came up");
      const r = await fetch(`${B}${PATH}`);
      assert.equal(r.status, 402);
      const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8"));
      accepted = (req402.accepts || []).find((a) => a.network === CELO);
      assert.ok(accepted, "a Celo accept");
    });
    const pay = async () => { const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": credential(accepted) } }); await r.text(); return r.status; };
    await check("demotion e2e: Celo's graceful refusal is recorded once, then the fallback asks Solvador once", async () => {
      st.order.length = 0;
      assert.equal(await pay(), 402);
      assert.deepEqual(st.order, ["celo", "solvador"], "primary, then the fallback, once each");
      const r = await refusals();
      assert.equal(r.length, 2, `one refusal each for Celo and Solvador (${JSON.stringify(r.map((x) => x.facilitator))})`);
      assert.ok(log.some((l) => /\[settle-demotion\] Celo demoted on eip155:42220/.test(l)), "Celo is demoted");
    });
    await check("demotion e2e: while demoted, Solvador first, then Celo, each asked once; each refusal recorded once", async () => {
      st.order.length = 0;
      assert.equal(await pay(), 402);
      assert.deepEqual(st.order, ["solvador", "celo"], `each facilitator asked once (${st.order.join(",")})`);
      const r = await refusals();
      assert.equal(r.length, 4, `two more refusals, not four (${r.length})`);
    });
    await check("demotion e2e: an ambiguous failure at the alternate stops the settle there", async () => {
      st.svMode = "5xx";
      st.order.length = 0;
      assert.equal(await pay(), 402);
      assert.deepEqual(st.order, ["solvador"], `nobody is asked after a 5xx that may have broadcast (${st.order.join(",")})`);
    });
    await check("demotion e2e control: the alternate settling while Celo is demoted answers 200", async () => {
      st.svMode = "ok";
      st.order.length = 0;
      assert.equal(await pay(), 200);
      assert.deepEqual(st.order, ["solvador"]);
    });
  } finally {
    if (failures > failuresBefore) for (const l of log.slice(-40)) console.log("  server:", l);
    proc.kill("SIGKILL");
    for (const s of [baseFac, celoFac, svFac]) s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
})();

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
