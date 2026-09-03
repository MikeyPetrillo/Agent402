// Self-hostable x402 facilitator for Stellar.
//
// Wires the official @x402/core orchestration (x402Facilitator) to the
// official @x402/stellar facilitator-side scheme (ExactStellarScheme), which
// already implements Soroban simulation/auth-entry validation and on-chain
// settlement confirmation internally - this file is glue, not a payment
// protocol reimplementation. Testnet by default; mainnet is an explicit
// opt-in via FACILITATOR_NETWORK=pubnet (see signer.js).
//
//   node index.js          (reads FACILITATOR_STELLAR_SECRET, PORT from env)
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { getHorizonClient } from "@x402/stellar";
import { loadSigner, NETWORK, RPC_CONFIG } from "./signer.js";
import { invalidVerify, invalidSettle, normalizeVerify, normalizeSettle } from "./shape.js";
import { createSerialQueue } from "./queue.js";
import { withTimeout } from "./timeout.js";
import { installRpcDiagnostics } from "./rpc-diagnostics.js";
import { installRpcRequestTimeout } from "./rpc-timeout.js";
import { installRpcFailover, resolveFallbackUrls } from "./rpc-failover.js";
import { installPollClamp } from "./settle-poll.js";
import { installFeeBid, resolveBidStroops, assertFeeBumpUnpatched } from "./fee-bid.js";
import { AsyncLocalStorage } from "node:async_hooks";

// Must install before ExactStellarScheme ever calls getRpcClient() /
// sendTransaction() - a patch applied after the first real request would
// simply miss it. The request timeout goes FIRST so the diagnostics wrapper
// sits outermost and still sees every sendTransaction result.
// 10s per RPC round-trip: a stalled provider surfaces well inside the
// caller's 30s settle budget WITH an error body (and payer), instead of the
// caller giving up blind at 30s and this side hitting its 60s guard alone
// (2026-08-14 and 2026-08-19, both pre-submission stalls).
installRpcRequestTimeout(process.env.FACILITATOR_RPC_TIMEOUT_MS === undefined ? 10_000 : Number(process.env.FACILITATOR_RPC_TIMEOUT_MS));
installRpcDiagnostics();
// Installed LAST so it wraps the timeout + diagnostics and sees their errors.
// Reads that stay silent past FACILITATOR_RPC_HEDGE_MS (default 3 s) are also
// sent to the first fallback; first answer wins (2026-08-28: a slow-but-
// answering primary spent the whole settle budget without one error).
installRpcFailover(resolveFallbackUrls(NETWORK, process.env.FACILITATOR_RPC_FALLBACK_URLS), {
  hedgeMs: process.env.FACILITATOR_RPC_HEDGE_MS === undefined ? 3_000 : Number(process.env.FACILITATOR_RPC_HEDGE_MS),
});

// The settlement transaction's inclusion-fee bid. @x402/stellar hardcodes the
// network minimum (100 stroops), which loses Stellar's fee auction whenever
// the ledger is busy - measured 2026-08-31 as a 37.5% Stellar rail failure
// rate over 30 days, in two shapes (txInsufficientFee at submission, or
// PENDING then dropped). Stellar charges the clearing price rather than the
// bid, so raising it is a ceiling, not a cost. See fee-bid.js.
const FEE_BID_STROOPS = resolveBidStroops(process.env.FACILITATOR_INCLUSION_FEE_STROOPS);
if (!installFeeBid({ bidStroops: FEE_BID_STROOPS })) {
  console.warn(`[startup] Stellar inclusion-fee bid NOT installed (FACILITATOR_INCLUSION_FEE_STROOPS=${FEE_BID_STROOPS}) - settlements bid the network minimum and will lose the fee auction on busy ledgers.`);
}

const PORT = Number(process.env.PORT) || 4021;
const AUTH_TOKEN = (process.env.FACILITATOR_AUTH_TOKEN || "").trim();
const ALLOWED_PAYTO = (process.env.FACILITATOR_ALLOWED_PAYTO || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
// 1 XLM, not 5. A settlement's observed fee_charged is 23,501 stroops =
// 0.00235 XLM (~$0.0007), so 1 XLM is ~425 settlements and 5 XLM was ~2,100 -
// a threshold that pages while years of runway remain is an alarm nobody
// reads. Raised bids do not change this much: even paying the full inclusion
// bid every time, 1 XLM is ~136 settlements.
const LOW_BALANCE_XLM = Number(process.env.FACILITATOR_LOW_BALANCE_XLM) || 1;
// Found live in production (2026-08-14, first full day on mainnet): a
// /settle call hung for 300s straight - no timeout, no error, nothing on
// Horizon either (verified after the fact: neither the payer nor this
// facilitator's own signer account shows any transaction from that window,
// so the underlying RPC call stalled before ever submitting anything). The
// calling side eventually gave up and closed the connection; Railway logged
// it as a 499 with an empty body, which surfaced upstream as an opaque 502.
// @x402/stellar's own documented worst case is a 15-attempt x 1s poll
// (~15s) AFTER submission - these bounds exist to fail fast and loud well
// before that, not to fit real-world settlement time exactly.
// 25 s (was 60 s): the CALLER gives up at 30 s, so a 60 s bound here meant
// every slow settle reached the caller as a bodiless timeout with no payer
// and no hash. Now this side answers first, with both. The post-submit poll
// is capped separately (FACILITATOR_MAX_POLL_ATTEMPTS, settle-poll.js).
const SETTLE_TIMEOUT_MS = Number(process.env.FACILITATOR_SETTLE_TIMEOUT_MS) || 25_000;
const MAX_POLL_ATTEMPTS = Number(process.env.FACILITATOR_MAX_POLL_ATTEMPTS) || 8;
const settleContext = new AsyncLocalStorage();
const VERIFY_TIMEOUT_MS = Number(process.env.FACILITATOR_VERIFY_TIMEOUT_MS) || 30_000;
const HEALTH_TIMEOUT_MS = Number(process.env.FACILITATOR_HEALTH_TIMEOUT_MS) || 10_000;

if (!AUTH_TOKEN) {
  console.warn("[startup] FACILITATOR_AUTH_TOKEN is not set - /verify, /settle, and /supported are UNAUTHENTICATED.");
}
if (!ALLOWED_PAYTO.length) {
  console.warn("[startup] FACILITATOR_ALLOWED_PAYTO is not set - this facilitator will settle to ANY payTo, which lets unrelated parties use it as a free gas sponsor.");
}

const signer = loadSigner();
const horizon = getHorizonClient(NETWORK);

// areFeesSponsored: true is not a preference - it's the only value the
// current x402 Stellar spec/client support (the scheme's own source comment
// says so directly), and the facilitator's signer account pays the
// transaction fee on every settlement regardless of this flag's value.
const stellarScheme = new ExactStellarScheme([signer], {
  areFeesSponsored: true,
  ...(RPC_CONFIG ? { rpcConfig: RPC_CONFIG } : {}),
});

const facilitator = new x402Facilitator().register(NETWORK, stellarScheme);
installPollClamp(Object.getPrototypeOf(stellarScheme), {
  maxAttempts: MAX_POLL_ATTEMPTS,
  onHash: (h) => { const c = settleContext.getStore(); if (c) c.txHash = String(h || ""); },
});
// We configure no feeBumpSigner, so build() (which the fee bid patches) makes
// the transaction we submit. If one is ever added, the fee bump is built with
// the vendor's own hardcoded BASE_FEE and the bid silently reverts - this says
// so at startup rather than letting it return as a mystery failure rate.
assertFeeBumpUnpatched(stellarScheme);

// Settlement is serialized through this queue - see queue.js. Only settle()
// touches the signer's Stellar sequence number; verify() is read-only
// simulation and stays fully concurrent.
const enqueueSettle = createSerialQueue();

const app = express();

function isPlausiblePaymentRequirements(r) {
  return !!r && typeof r === "object"
    && typeof r.scheme === "string"
    && typeof r.network === "string"
    && typeof r.asset === "string"
    && typeof r.amount === "string"
    && typeof r.payTo === "string";
}

function isPlausiblePaymentPayload(p) {
  return !!p && typeof p === "object"
    && typeof p.x402Version === "number"
    && !!p.accepted && typeof p.accepted === "object"
    && !!p.payload && typeof p.payload === "object";
}

function bestEffortNetwork(body) {
  return body?.paymentRequirements?.network || body?.paymentPayload?.accepted?.network || undefined;
}

function safeMessage(err) {
  return (err?.message || String(err)).slice(0, 300);
}

// Best-effort payer recovery for a /settle call that never returned a
// vendor result at all (threw, or hit our own timeout above). A normal
// vendor-reported failure already carries `payer` on every branch of its
// result object (verified against @x402/stellar's own source - it resolves
// `payer` once, early, from the verify step, and threads it through every
// return path); it's only the "we never got a result back" case that has
// nothing. Without this, src/stellar-confirm.js's settlePayerOf(res) reads
// undefined and its whole "ask the chain before believing a failure" check
// silently no-ops - exactly the class of quietly-dead safety net this
// codebase has hit before (see its own header comment). verify() is
// read-only simulation, so calling it again here has no side effects and no
// cost on the (far more common) non-error path.
async function bestEffortPayer(paymentPayload, paymentRequirements) {
  try {
    const v = await withTimeout(facilitator.verify(paymentPayload, paymentRequirements), 10_000, "payer_recovery_verify");
    return typeof v?.payer === "string" && v.payer.trim() ? v.payer.trim() : null;
  } catch {
    return null;
  }
}

// Auth failure is an access-control rejection, not a business outcome, so it
// is NOT held to the "always 200" rule below - a 401 is exactly what
// @x402/core's HTTPFacilitatorClient already treats any non-2xx as (a
// rejection), so this reads correctly to any x402-compliant caller.
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Placed immediately after express.json() so a malformed body never even
// reaches a route handler - it's still answered in schema-shaped JSON with
// HTTP 200, matching every other "we could classify this as invalid" path.
app.use(express.json({ limit: "256kb" }));
app.use((err, req, res, next) => {
  if (err?.type !== "entity.parse.failed") return next(err);
  if (req.path === "/settle") {
    return res.status(200).json(invalidSettle("invalid_request_malformed_body"));
  }
  return res.status(200).json(invalidVerify("invalid_request_malformed_body"));
});

app.get("/supported", requireAuth, (req, res) => {
  try {
    res.status(200).json(facilitator.getSupported());
  } catch (err) {
    console.error("[/supported] unexpected error:", err);
    res.status(200).json({ kinds: [], extensions: [], signers: {} });
  }
});

app.post("/verify", requireAuth, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  if (!isPlausiblePaymentPayload(paymentPayload) || !isPlausiblePaymentRequirements(paymentRequirements)) {
    return res.status(200).json(invalidVerify("invalid_request_malformed_body"));
  }
  if (ALLOWED_PAYTO.length && !ALLOWED_PAYTO.includes(paymentRequirements.payTo)) {
    return res.status(200).json(invalidVerify("payto_not_allowed"));
  }
  try {
    const result = await withTimeout(facilitator.verify(paymentPayload, paymentRequirements), VERIFY_TIMEOUT_MS, "verify");
    res.status(200).json(normalizeVerify(result));
  } catch (err) {
    console.error("[/verify] dispatch error:", err);
    const reason = err?.code === "FACILITATOR_TIMEOUT" ? "verify_timed_out" : "facilitator_dispatch_error";
    res.status(200).json(invalidVerify(reason, undefined, safeMessage(err)));
  }
});

// withTimeout rejects outside the ALS scope, so the job's ctx is remembered
// on the settle promise chain: the most recent ctx whose job is still the one
// being awaited. Settles are serialized (queue.js), so "current" is exact.
let _currentSettleCtx = null;
const settleCtxOf = () => _currentSettleCtx;
app.post("/settle", requireAuth, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  if (!isPlausiblePaymentPayload(paymentPayload) || !isPlausiblePaymentRequirements(paymentRequirements)) {
    return res.status(200).json(invalidSettle("invalid_request_malformed_body", bestEffortNetwork(req.body)));
  }
  if (ALLOWED_PAYTO.length && !ALLOWED_PAYTO.includes(paymentRequirements.payTo)) {
    return res.status(200).json(invalidSettle("payto_not_allowed", paymentRequirements.network));
  }
  try {
    // The timeout wraps the JOB ITSELF, not just this HTTP call - so
    // enqueueSettle's internal chain advances to the next queued settlement
    // once this rejects, even though the underlying vendor call is still
    // running unseen in the background. That reopens a narrower version of
    // the exact sequence-number race this queue exists to prevent: if the
    // abandoned call eventually DOES submit, and a later queued call reads
    // the signer's sequence number before that submission lands, both
    // transactions can conflict. Accepted trade-off, not an oversight - the
    // alternative (never time out) is the failure this fix exists for, and
    // a stall long enough to matter here is already rare enough that this
    // codebase's usual answer applies: bound the failure, then let the
    // calling side's own chain-confirmation (src/stellar-confirm.js) catch
    // whatever lands late, the same way it already does for OpenZeppelin.
    const ctx = { txHash: "", startedAt: Date.now() };
    const result = await enqueueSettle(() => settleContext.run(ctx, () => withTimeout(
      (_currentSettleCtx = ctx, facilitator.settle(paymentPayload, paymentRequirements)),
      SETTLE_TIMEOUT_MS,
      "settle",
    )));
    console.log(`[/settle] ${result?.success ? "settled" : `not settled (${result?.errorReason || "?"})`} in ${Date.now() - ctx.startedAt}ms${ctx.txHash ? ` tx ${ctx.txHash.slice(0, 12)}...` : " (nothing submitted)"}`);
    res.status(200).json(normalizeSettle(result, paymentRequirements.network));
  } catch (err) {
    const ctx = settleCtxOf(err);
    console.error(`[/settle] dispatch error${ctx?.txHash ? ` (submitted ${ctx.txHash.slice(0, 12)}... before the bound)` : " (nothing submitted)"}:`, err);
    const reason = err?.code === "FACILITATOR_TIMEOUT" ? "settle_timed_out" : "facilitator_dispatch_error";
    // The underlying settle may already have submitted, or may yet submit in
    // the background (see the comment above) - either way this response is
    // reporting failure without knowing that for certain, so the calling
    // side needs `payer` to be able to check the chain itself. Best-effort:
    // if this also fails, the response is no worse than it was before this
    // fix, just still missing payer.
    const payer = await bestEffortPayer(paymentPayload, paymentRequirements);
    // The hash of whatever was submitted before the bound rides along, so the
    // caller's on-chain confirmation can check that exact transaction.
    res.status(200).json({ ...invalidSettle(reason, paymentRequirements.network, safeMessage(err)), payer, ...(ctx?.txHash ? { transaction: ctx.txHash } : {}) });
  }
});

// Unauthenticated by design - read-only, exposes no secret, just a public
// address and a balance number, so a future external monitor can poll it
// without needing the facilitator's own auth token.
app.get("/health", async (req, res) => {
  try {
    const account = await withTimeout(horizon.loadAccount(signer.address), HEALTH_TIMEOUT_MS, "health");
    const native = account.balances.find((b) => b.asset_type === "native");
    const xlmBalance = native ? Number(native.balance) : 0;
    res.status(200).json({
      signerAddress: signer.address,
      xlmBalance,
      low: xlmBalance < LOW_BALANCE_XLM,
    });
  } catch (err) {
    console.error("[/health] unexpected error:", err);
    res.status(200).json({ signerAddress: signer.address, xlmBalance: null, low: null, error: safeMessage(err) });
  }
});

// Only auto-start when run directly (`node index.js`) - test.js spawns this
// same file as a child process, which is exactly that case; importing this
// module for in-process testing would not be.
if (import.meta.url === `file://${process.argv[1]}`) {
  const httpServer = app.listen(PORT, () => {
    console.log(`agent402-facilitator (Stellar, ${NETWORK}) listening on :${PORT}`);
    console.log(`facilitator address: ${signer.address}`);
  });

  // Graceful shutdown: a Railway redeploy sends SIGTERM. Stop accepting new
  // connections but let an in-flight /verify or /settle finish - these are
  // money-moving requests, and a hard kill mid-settle is the same "took the
  // work, dropped the answer" failure src/server.js's own drain logic exists
  // to prevent. Only works if the platform grants a grace period (Railway
  // defaults to 0s between SIGTERM and SIGKILL - RAILWAY_DEPLOYMENT_DRAINING_SECONDS
  // must be set on this service, same as the main app's).
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received - draining in-flight requests`);
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections();
    setInterval(() => httpServer.closeIdleConnections(), 5_000).unref();
    // Must stay ABOVE SETTLE_TIMEOUT_MS (our own settle call is now bounded
    // by it, see above), or a redeploy could hard-exit while a legitimate,
    // still-within-its-own-bound settlement is in flight - the exact failure
    // this drain logic exists to prevent. Default 60s + 15s margin = 75s,
    // comfortably under production's RAILWAY_DEPLOYMENT_DRAINING_SECONDS=90
    // (the point Railway sends SIGKILL regardless, so exiting any later than
    // that achieves nothing but a worse-attributed crash). Raising
    // FACILITATOR_SETTLE_TIMEOUT_MS past ~75s means also raising
    // RAILWAY_DEPLOYMENT_DRAINING_SECONDS on the Railway service to match -
    // this only derives the floor, it cannot widen Railway's own deadline.
    setTimeout(() => process.exit(0), Math.max(SETTLE_TIMEOUT_MS + 15_000, 30_000)).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app };
