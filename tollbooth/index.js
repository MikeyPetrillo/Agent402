#!/usr/bin/env node
// agent402-tollbooth — an open-source, self-hostable x402 "pay-per-crawl" gate.
//
// Put it in front of any site or API: human visitors pass through free, while
// AI crawlers / agents must pay per request — either in USDC over the x402
// protocol, or for free by solving a proof-of-work (no wallet, no signup, no
// Stripe, no Cloudflare). Use it two ways:
//
//   1. Express middleware:   app.use(createTollbooth({ ... }))
//   2. Reverse proxy (CLI):  TOLLBOOTH_UPSTREAM=https://your-site.com npx agent402-tollbooth
//
// The proof-of-work rail works out of the box with zero configuration. To also
// accept USDC, set `payTo` and supply `verifyX402` (wire it to the standard
// x402 server middleware / your facilitator — see README).
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { createPow } from "./pow.js";
import { makeBotMatcher, AI_BOTS } from "./bots.js";
import { memorySink } from "./sinks.js";
import { challengesFromPaymentRequired, translateCredential, receiptFromPaymentResponse, isMppCredential, DEFAULT_MPP_CHAIN_IDS } from "./mpp.js";
import { tempoConfig, mintTempoChallenges, parseTempoCredential, checkTempoBinding, tempoRelay, relayInput, broadcastIdempotencyKey, tempoReceiptHeader, tempoProblem, confirmTempoSettlement } from "./tempo.js";

export { AI_BOTS, makeBotMatcher } from "./bots.js";
export { createPow, leadingZeroBits } from "./pow.js";
export { memorySink, kvStatsSink, httpStatsSink } from "./sinks.js";
export { sqliteReplayStore, redisReplayStore } from "./replay.js";
export { challengesFromPaymentRequired, translateCredential, receiptFromPaymentResponse, DEFAULT_MPP_CHAIN_IDS } from "./mpp.js";
export { tempoConfig, mintTempoChallenges, parseTempoCredential, checkTempoBinding, tempoRelay, toBaseUnits, TEMPO_USDC_E, TEMPO_PATHUSD, TEMPO_MAINNET_CHAIN_ID } from "./tempo.js";

const VERIFY_TIMEOUT_MS = Number(process.env.TOLLBOOTH_VERIFY_TIMEOUT_MS) || 10_000;

// P1.5 / FR4-10: a first-party `verifyX402` built from a standard @x402/express
// payment middleware, that OWNS timeout + cancellation. The gate calls
// verifyX402(req, opts) and puts an AbortSignal on `opts.signal` (aborted when
// the gate's own verify timeout fires); this wrapper honors it — once the signal
// aborts (or its own optional backstop timeout fires) it settles the verify
// promise immediately and reports NOT-verified, so a slow middleware can't leave
// the gate hanging or produce a charged-then-denied result after the gate has
// returned 402. Grants on next(); denies when the middleware writes a 402.
//
// DEPRECATED (0.7.0) - use `createTollbooth({ x402: paymentMiddleware })` instead.
// @x402/express v2's default `authorization` flow verifies BEFORE the handler
// but SETTLES AFTER the handler ends the response (it wraps res.end and awaits
// it). This wrapper hands the middleware a stub response that the real handler
// never ends, so with a v2 middleware it grants on verify and the settlement
// never runs: the buyer is served and never charged. It only ever settled with
// v1 middlewares that settled before calling next(). Kept for those callers;
// warns once at construction. The `x402` option delegates to the middleware
// with the REAL response, so verify, handler and settle happen in the
// middleware's own order, exactly once.
//
// LIMITATION (documented): @x402/express settles by BROADCASTING and exposes no
// cancel hook, so this wrapper cannot abort an on-chain settle already in flight.
// Keep TOLLBOOTH_VERIFY_TIMEOUT_MS comfortably above your settle latency so the
// abort is a backstop, not the normal path; or front it with a facilitator that
// supports cancellation.
let warnedVerifierFromExpress = false;
export function x402VerifierFromExpress(paymentMiddleware, { timeoutMs } = {}) {
  if (typeof paymentMiddleware !== "function") {
    throw new TypeError("x402VerifierFromExpress: paymentMiddleware must be a function");
  }
  if (!warnedVerifierFromExpress) {
    warnedVerifierFromExpress = true;
    console.warn("[agent402-tollbooth] x402VerifierFromExpress is deprecated: with @x402/express v2 (settle-after-handler) it grants on verify and never settles. Pass the middleware as createTollbooth({ x402: paymentMiddleware }) instead.");
  }
  return (req, opts = {}) => new Promise((resolve, reject) => {
    const signal = opts?.signal;
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(v);
    };
    const onAbort = () => finish(resolve, false); // gate timed out → treat as not verified
    if (signal?.aborted) return finish(resolve, false);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(resolve, false), timeoutMs);
    // Minimal response shim: the middleware calls next() to GRANT, or writes a
    // 402 via status/json/send/end to DENY.
    const res = {
      setHeader() { return this; }, getHeader() {}, removeHeader() { return this; }, getHeaders() { return {}; },
      status() { return this; }, json() { finish(resolve, false); return this; },
      send() { finish(resolve, false); return this; }, end() { finish(resolve, false); return this; },
      writeHead() { return this; }, write() { return true; }, flushHeaders() {},
    };
    try {
      Promise.resolve(paymentMiddleware(req, res, () => finish(resolve, true))).catch((e) => finish(reject, e));
    } catch (e) { finish(reject, e); }
  });
}
// Headers a client must never be able to forge through the proxy: the gate's own
// trust signals and forwarding/hop-by-hop headers.
const STRIP_INBOUND = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "x-tollbooth-paid", "x-tollbooth-error", "x-pow-error", "x-forwarded-host", "forwarded",
  // client-IP / scheme trust headers an upstream might honour (spoofable by the bot)
  "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fastly-client-ip", "x-forwarded-proto", "x-forwarded-port", "via",
]);

/**
 * Create the tollbooth Express middleware.
 * @param {object} [config]
 * @param {string} [config.price="$0.001"]     advertised price per request
 * @param {string|null} [config.payTo]         wallet for the x402 quote (enables USDC rail)
 * @param {string} [config.network="base"]     x402 network (e.g. base, or robinhood / eip155:4663 for USDG)
 * @param {string} [config.asset="USDC"]        stablecoin symbol in the quote (USDG on Robinhood Chain)
 * @param {boolean} [config.pow=true]          enable the free proof-of-work rail
 * @param {number} [config.powDifficulty]      PoW difficulty in leading zero bits
 * @param {object} [config.replayStore]        shared single-use PoW backend, `{ claim(token, expiresAtMs) => boolean|Promise<boolean> }`.
 *                                             Default is THIS PROCESS'S memory; required for multi-worker / multi-instance / serverless. See replay.js.
 * @param {string[]} [config.botUserAgents]    user-agents to charge (default: AI_BOTS)
 * @param {(req)=>boolean} [config.charge]     custom "should this client pay?" predicate
 * @param {(req)=>boolean} [config.free]       custom force-allow predicate (wins over charge)
 * @param {(req, requirements)=>boolean|Promise<boolean>} [config.verifyX402]  legacy verify-only USDC check (deprecated for settle-after-handler middlewares; see `x402`)
 * @param {Function} [config.x402]              an @x402/express `paymentMiddleware(...)` (or compatible (req,res,next)) that owns
 *                                             verify + settle. The gate delegates paid requests to it with the REAL response, so
 *                                             settlement runs in the middleware's own order (v2: after the handler), and it lifts
 *                                             the middleware's PAYMENT-REQUIRED onto the gate's 402 so stock x402 v2 clients can pay.
 * @param {boolean} [config.mpp]               accept MPP (Machine Payments Protocol) clients too - default true when `x402` is set.
 *                                             Adds WWW-Authenticate: Payment challenges to the 402 and settles Authorization: Payment
 *                                             credentials through the same `x402` middleware (evm/charge on the chains it advertises).
 * @param {string} [config.mppSecret]          HMAC secret binding MPP challenge ids (default: powSecret / TOLLBOOTH_SECRET, else per-process random)
 * @param {number[]|"all"} [config.mppNetworks] EVM chain ids to offer as MPP challenges (default Base + Celo, what a stock mppx client can sign)
 * @param {string} [config.resourceBaseUrl]    absolute base for the x402 `resource`/PoW binding
 * @param {string} [config.message]            human-readable note included in the 402
 * @param {boolean} [config.observe]           observe-only: classify, count, never 402 (deploy a week before enforcing)
 * @param {object} [config.statsSink]          pluggable durable-stats sink (default: in-memory). See sinks.js.
 */
/** Tempo config from env (null when TOLLBOOTH_TEMPO_API_KEY is unset). */
export function tempoFromEnv(env = process.env) {
  const apiKey = (env.TOLLBOOTH_TEMPO_API_KEY || "").trim();
  if (!apiKey) return null;
  const recipient = (env.TOLLBOOTH_TEMPO_RECIPIENT || env.TOLLBOOTH_PAYTO || "").trim();
  const currencies = (env.TOLLBOOTH_TEMPO_CURRENCY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const splits = (env.TOLLBOOTH_TEMPO_SPLITS || "").split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [recipient, amount] = pair.split(":").map((x) => x.trim());
    return { recipient, amount };
  });
  return {
    apiKey, recipient,
    ...(currencies.length ? { currencies } : {}),
    ...(splits.length ? { splits } : {}),
    ...(env.TOLLBOOTH_TEMPO_API_BASE ? { apiBaseUrl: env.TOLLBOOTH_TEMPO_API_BASE } : {}),
  };
}

export function createTollbooth(config = {}) {
  const {
    price = process.env.TOLLBOOTH_PRICE || "$0.001",
    payTo = process.env.TOLLBOOTH_PAYTO || null,
    network = process.env.TOLLBOOTH_NETWORK || "base",
    // Any stablecoin the operator's facilitator settles. USDC on the default
    // chains; set TOLLBOOTH_NETWORK=robinhood (or eip155:4663) with
    // TOLLBOOTH_ASSET=USDG to charge crawlers in USDG on Robinhood Chain.
    asset = process.env.TOLLBOOTH_ASSET || "USDC",
    pow = true,
    powDifficulty,
    powSecret,
    // Shared single-use record for solved proof-of-work tokens. Unset means
    // per-process memory, which is only single-use within ONE process: a stable
    // TOLLBOOTH_SECRET (needed so tokens verify across workers at all) then makes
    // one solve redeemable once per worker inside the token TTL. Pass a store
    // from replay.js for any deploy with more than one process.
    replayStore,
    botUserAgents = AI_BOTS,
    // Who pays. Default "bots" = the original behavior (charge AI crawler UAs).
    //  "all"    — charge every client except a `free()` match (UA detection is
    //             not a security boundary; this stops relying on it).
    //  "strict" — charge anything that isn't a real-browser request (browser-like
    //             UA + an HTML Accept). Raises the bar on naive scrapers.
    // An explicit charge()/free() still wins over the mode.
    mode = process.env.TOLLBOOTH_MODE || "bots",
    charge,
    free,
    verifyX402,
    x402 = null,
    mpp = config.mpp ?? (process.env.TOLLBOOTH_MPP ? process.env.TOLLBOOTH_MPP !== "false" : !!x402),
    mppSecret,
    mppNetworks = process.env.TOLLBOOTH_MPP_NETWORKS
      ? (process.env.TOLLBOOTH_MPP_NETWORKS.trim().toLowerCase() === "all" ? "all" : process.env.TOLLBOOTH_MPP_NETWORKS.split(",").map((s) => Number(s.trim())).filter(Number.isInteger))
      : DEFAULT_MPP_CHAIN_IDS,
    // Native MPP on Tempo (0.9.0): { apiKey, recipient, currency|currencies,
    // splits: [{recipient, amount}], decimals, chainId, apiBaseUrl }. Settles
    // through Tempo's relay, independent of `x402` - a tollbooth can charge in
    // USDC.e on Tempo with no x402 facilitator at all. From env:
    // TOLLBOOTH_TEMPO_API_KEY + TOLLBOOTH_TEMPO_RECIPIENT (+ TOLLBOOTH_TEMPO_CURRENCY,
    // TOLLBOOTH_TEMPO_SPLITS="0xabc:0.0002,0xdef:0.0001").
    tempo = config.tempo !== undefined ? config.tempo : tempoFromEnv(process.env),
    resourceBaseUrl = process.env.TOLLBOOTH_RESOURCE_BASE || "",
    // Adaptive proof-of-work: raise difficulty as charged-request load climbs, so
    // high-volume abuse pays escalating CPU regardless of how it disguises itself.
    // Off by default — behavior is unchanged unless explicitly enabled.
    adaptive = config.adaptive ?? (process.env.TOLLBOOTH_ADAPTIVE === "true"),
    adaptivePerBit = Number(process.env.TOLLBOOTH_ADAPTIVE_PER_BIT) || 300, // +1 bit per N charged req/min
    maxDifficulty,
    // Observe-only mode: classify every request as charge-vs-free and count it,
    // but always let it through (never return 402). Use it to measure a site's
    // bot traffic for a week before flipping the meter on. Off by default.
    observe = config.observe ?? (process.env.TOLLBOOTH_OBSERVE === "true"),
    // Pluggable durable-stats sink. Default = in-memory (current behavior).
    // See sinks.js for kvStatsSink (Cloudflare KV) and httpStatsSink.
    statsSink,
    message = "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  } = config;

  const isBot = makeBotMatcher(botUserAgents);
  const powEngine = pow ? createPow({ difficulty: powDifficulty, secret: powSecret, replayStore }) : null;
  if (x402 && typeof x402 !== "function") throw new TypeError("createTollbooth: `x402` must be an Express middleware function");
  // MPP rides the x402 middleware (settlement authority) - without one there
  // is nothing to settle an MPP credential with, so it stays off.
  const mppOn = !!(mpp && x402);
  // Challenge ids are HMAC-bound; a stable secret is needed across workers.
  // Same caveat as PoW: per-process random works for one process only.
  const mppKey = mppOn
    ? String(mppSecret || powSecret || process.env.TOLLBOOTH_MPP_SECRET || process.env.TOLLBOOTH_SECRET || randomBytes(32).toString("hex"))
    : null;
  if (mppOn && !(mppSecret || powSecret || process.env.TOLLBOOTH_MPP_SECRET || process.env.TOLLBOOTH_SECRET)) {
    console.warn("[agent402-tollbooth] MPP enabled with a per-process random secret - set TOLLBOOTH_SECRET (or mppSecret) for multi-worker deploys.");
  }
  const tempoCfg = tempo ? tempoConfig(tempo) : null; // throws on a bad config - never boot a gate that mints unpayable challenges
  const tempoKey = tempoCfg
    ? (mppKey || String(mppSecret || powSecret || process.env.TOLLBOOTH_MPP_SECRET || process.env.TOLLBOOTH_SECRET || randomBytes(32).toString("hex")))
    : null;
  if (tempoCfg && !mppKey && !(mppSecret || powSecret || process.env.TOLLBOOTH_MPP_SECRET || process.env.TOLLBOOTH_SECRET)) {
    console.warn("[agent402-tollbooth] Tempo enabled with a per-process random secret - set TOLLBOOTH_SECRET (or mppSecret) for multi-worker deploys.");
  }
  const tempoRelayClient = tempoCfg ? tempoRelay(tempoCfg) : null;
  // Single-use record for tempo credentials (challenge id), sharing the
  // operator's replayStore when given (same atomic `claim` contract as PoW).
  const tempoSeen = new Map(); // id -> expiresAt (in-process fallback)
  const tempoClaim = async (id, expiresAtMs) => {
    if (replayStore && typeof replayStore.claim === "function") return replayStore.claim(`tempo:${id}`, expiresAtMs);
    const now = Date.now();
    for (const [k, exp] of tempoSeen) if (exp <= now) tempoSeen.delete(k);
    if (tempoSeen.has(id)) return false;
    tempoSeen.set(id, expiresAtMs);
    return true;
  };

  // Passive analytics — never affects request handling, just counts what happens.
  // `mem` is an always-on in-process mirror so `.stats()` stays synchronous for
  // single-process Node deployments. A durable `statsSink` (KV/HTTP) is written
  // through alongside and is the source of truth for `.snapshot()`.
  const mem = memorySink();
  const sink = statsSink || mem;
  const writeThrough = statsSink && statsSink !== mem;
  // Never let a buggy custom sink throw inside the request path — stats are
  // non-critical and must not be able to break a payment decision.
  const incr = (k, n = 1) => {
    try { mem.incr(k, n); } catch { /* ignore */ }
    if (writeThrough) { try { sink.incr(k, n); } catch { /* ignore */ } }
  };

  const looksHuman = (req) => {
    const ua = req.headers["user-agent"] || "";
    const accept = req.headers["accept"] || "";
    return /mozilla\/5\.0/i.test(ua) && /text\/html/i.test(accept);
  };
  const shouldCharge = (req) => {
    try {
      if (typeof free === "function" && free(req)) return false;
      if (typeof charge === "function") return Boolean(charge(req));
    } catch { return true; /* fail closed: charge on predicate error */ }
    if (mode === "all") return true;
    if (mode === "strict") return !looksHuman(req);
    return isBot(req.headers["user-agent"] || ""); // "bots" (default)
  };

  // Sliding-window of recent charged requests → adaptive PoW difficulty.
  const baseDifficulty = powEngine?.difficulty ?? (Number(process.env.TOLLBOOTH_POW_BITS) || 18);
  const ceilDifficulty = Math.min(Number(maxDifficulty) || baseDifficulty + 6, 32);
  const ADAPT_WINDOW_MS = 60_000;
  let chargedWindow = [];
  const difficultyNow = () => {
    if (!adaptive) return baseDifficulty;
    const cut = Date.now() - ADAPT_WINDOW_MS;
    if (chargedWindow.length > 100_000) chargedWindow = chargedWindow.filter((t) => t > cut); // hard bound
    else while (chargedWindow.length && chargedWindow[0] < cut) chargedWindow.shift();
    return Math.min(baseDifficulty + Math.floor(chargedWindow.length / Math.max(1, adaptivePerBit)), ceilDifficulty);
  };
  const resourceOf = (req) => {
    // Canonicalize to path+search (matches the edge impl) so the PoW binding is
    // stable and not confusable via a raw/abnormal request target.
    const raw = req.originalUrl || req.url || "/";
    let pathAndSearch = raw;
    try { const u = new URL(raw, "http://internal.invalid"); pathAndSearch = u.pathname + u.search; } catch { /* keep raw */ }
    // F18: bind the canonical ORIGIN, not just path+query, so a proof minted for
    // /x on site A cannot be replayed on site B. Prefer a configured
    // resourceBaseUrl; otherwise derive the origin from the request host (same
    // site => same origin; a different host => a different resource). Reusing one
    // TOLLBOOTH_SECRET across sites should ALSO use a unique secret per site.
    const origin = resourceBaseUrl
      ? resourceBaseUrl.replace(/\/$/, "")
      : `${req.protocol || "https"}://${String(req.headers?.host || (req.get && req.get("host")) || "").toLowerCase()}`;
    return origin + pathAndSearch;
  };

  function tollbooth(req, res, next) {
    incr("requests");
    if (!shouldCharge(req)) { incr("freeAllowed"); return next(); }
    // Observe-only: classify as would-charge but let it through. Lets operators
    // measure bot traffic on a live site before turning on enforcement.
    if (observe) { incr("wouldCharge"); res.setHeader("X-Tollbooth-Observed", "would-charge"); return next(); }
    const resource = resourceOf(req);
    // F18: the PoW challenge additionally binds the HTTP METHOD, so a proof
    // solved for GET /x can't be replayed against POST /x. The x402 `resource`
    // stays a plain URL (below) for wire compatibility.
    const powResource = `${(req.method || "GET").toUpperCase()} ${resource}`;

    // `headers` = extra response headers to carry on the 402 (the x402
    // middleware's own PAYMENT-REQUIRED and, when MPP is on, the derived
    // WWW-Authenticate: Payment challenges).
    const send402 = (extra = {}, headers = {}) => {
      incr("charged");
      if (adaptive) chargedWindow.push(Date.now());
      const body = {
        error: "Payment Required",
        message,
        accepts: payTo
          ? [{ scheme: "exact", network, maxAmountRequired: String(price), asset, payTo, resource }]
          : [],
        ...extra,
      };
      if (powEngine) body.proofOfWork = powEngine.challenge(powResource, difficultyNow());
      // Native Tempo challenge(s) on every 402, next to whatever evm challenges
      // the x402 rail lifted - a stock mppx client pays whichever it speaks.
      if (tempoCfg) {
        const tempoWww = mintTempoChallenges({ price, realm: mppRealm(req), secretKey: tempoKey, tempo: tempoCfg });
        if (tempoWww) headers = { ...headers, "WWW-Authenticate": [headers["WWW-Authenticate"], tempoWww].filter(Boolean).join(", ") };
      }
      for (const [k, v] of Object.entries(headers)) { if (v != null && v !== "") res.setHeader(k, v); }
      res.status(402).json(body);
    };

    // Native Tempo rail: validate with the relay BEFORE the handler, buffer
    // the handler's response, broadcast ONLY after a <400 response (the same
    // settle-after-handler discipline @x402/express enforces), then replay
    // the buffered response with a Payment-Receipt. A refused credential gets
    // the gate's 402 with fresh challenges plus an RFC 9457 `problem`.
    const tempoRail = async (cred) => {
      const reject = (kind, detail) => { res.setHeader("X-Tollbooth-Error", `tempo-${kind}`); return send402({ problem: tempoProblem(kind, detail) }); };
      const binding = checkTempoBinding(cred, { secretKey: tempoKey, realm: mppRealm(req), price, tempo: tempoCfg });
      if (!binding.ok) return reject(/below this route's price/.test(binding.reason) ? "payment-insufficient" : "invalid-challenge", `Challenge is invalid: ${binding.reason}. Request the resource again for a fresh challenge.`);
      let claimed;
      try { claimed = await tempoClaim(cred.challenge.id, Date.parse(cred.challenge.expires) || Date.now() + 300_000); } catch { claimed = false; }
      if (!claimed) return reject("invalid-challenge", "Challenge is invalid: this credential was already used or is in flight. Request the resource again for a fresh challenge.");
      const input = relayInput(cred);
      const v = await tempoRelayClient.validate(input).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!v.ok) {
        // Operator log gets the relay's full message (`detail`); the buyer's
        // 402 problem gets status + code only (`error`) - never an upstream body.
        console.warn(`[agent402-tollbooth] tempo credential rejected by validate (${req.method} ${req.url}): ${v.detail || v.error}`);
        return reject("verification-failed", `Payment verification failed: ${String(v.error || "the Tempo relay rejected the credential").slice(0, 160)}.`);
      }
      // Buffer the handler's response (writeHead/write/end/flushHeaders) -
      // Node's real 'finish' never fires while end is buffered, so the sync
      // primitive is a promise resolved inside the buffered end.
      const originalWriteHead = res.writeHead.bind(res);
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      const originalFlushHeaders = typeof res.flushHeaders === "function" ? res.flushHeaders.bind(res) : null;
      let buffered = [];
      let settled = false;
      let endCalled;
      const endPromise = new Promise((resolve) => { endCalled = resolve; });
      const restore = () => {
        settled = true;
        res.writeHead = originalWriteHead; res.write = originalWrite; res.end = originalEnd;
        if (originalFlushHeaders) res.flushHeaders = originalFlushHeaders;
      };
      res.writeHead = (...a) => { if (!settled) { buffered.push(["writeHead", a]); return res; } return originalWriteHead(...a); };
      res.write = (...a) => { if (!settled) { buffered.push(["write", a]); return true; } return originalWrite(...a); };
      res.end = (...a) => { if (!settled) { buffered.push(["end", a]); endCalled(); return res; } return originalEnd(...a); };
      if (originalFlushHeaders) res.flushHeaders = () => { if (!settled) { buffered.push(["flushHeaders", []]); return; } return originalFlushHeaders(); };
      const replay = () => {
        for (const [fn, a] of buffered) {
          if (fn === "writeHead") originalWriteHead(...a);
          else if (fn === "write") originalWrite(...a);
          else if (fn === "flushHeaders") { if (originalFlushHeaders) originalFlushHeaders(); }
          else originalEnd(...a);
        }
        buffered = [];
      };
      try { next(); } catch (err) { restore(); return next(err); }
      await endPromise;
      if (res.statusCode >= 400) { restore(); replay(); return; } // handler failed: never broadcast, nobody charged
      let b = await tempoRelayClient.broadcast(input, { idempotencyKey: broadcastIdempotencyKey(input) }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!b.ok && tempoCfg.confirm) {
        // The relay's verdict and the chain's truth can diverge (measured
        // live 2026-08-20: a yParity-style v byte the node normalizes makes
        // the relay's post-broadcast hash check fail a payment that SETTLED;
        // the buyer retried into a double charge). Ask the chain whether this
        // credential's own transaction landed before discarding the response —
        // exact txid derivation from the signed bytes, verification never a
        // re-broadcast, fails closed to the 402. See tempo.js.
        const check = tempoCfg.confirmSettlement || ((c) => confirmTempoSettlement(c, { rpcUrl: tempoCfg.confirmRpcUrl, fetchImpl: tempoCfg.fetch }));
        const confirmed = await Promise.resolve(check(cred)).catch(() => null);
        if (confirmed?.txId) {
          console.warn(`[agent402-tollbooth] tempo relay reported settlement failure but the credential's transaction SETTLED on-chain (${req.method} ${req.url} tx=${confirmed.txId}) - honouring the settlement (verified from the chain, nothing re-broadcast). Relay said: ${b.detail || b.error}`);
          b = { ok: true, receipt: { method: "tempo", reference: confirmed.txId } };
        }
      }
      if (!b.ok) {
        // Broadcast failed AFTER a successful handler: discard the body, 402
        // (mirrors @x402/express's settle-failure path). Loud - this is the
        // one path that can be our latency rather than the relay's verdict.
        console.warn(`[agent402-tollbooth] tempo broadcast failed after a successful handler (${req.method} ${req.url}) - answered 402, not charged: ${b.detail || b.error}`);
        buffered = [];
        restore();
        return reject("verification-failed", `Payment verification failed: Tempo settlement was not accepted (${String(b.error || "no relay detail").slice(0, 160)}).`);
      }
      incr("tempoPaid");
      restore();
      res.setHeader("Payment-Receipt", tempoReceiptHeader(b.receipt));
      res.setHeader("X-Tollbooth-Paid", "mpp-tempo");
      replay();
    };

    // Paid rail, middleware mode: delegate to the operator's x402 middleware
    // with the REAL response so verify -> handler -> settle run in ITS order,
    // exactly once. Its 402 (no/invalid payment) is intercepted and replaced by
    // the gate's 402 - same body contract as ever (accepts + proofOfWork +
    // message) plus the middleware's PAYMENT-REQUIRED header lifted verbatim,
    // so a stock x402 v2 client can pay a tollbooth-gated site, and - when MPP
    // is on - WWW-Authenticate: Payment challenges derived from that same
    // header, so a stock mppx client can too. Anything the middleware writes
    // that is NOT a 402 (facilitator 5xx, its own paywall HTML) passes through
    // untouched: it is the operator's stack answering, not ours to rewrite.
    const middlewareRail = () => {
      // ---- MPP inbound: Authorization: Payment -> PAYMENT-SIGNATURE ----
      // Only when the request is not already speaking x402 (pass-through is
      // the no-regression rule), and only a credential whose challenge id
      // HMAC-verifies as OURS. Anything else is ignored: the middleware
      // answers 402 and the interceptor below mints fresh challenges.
      let viaMpp = false;
      if (mppOn && !req.headers["payment-signature"] && !req.headers["x-payment"] && isMppCredential(req.headers.authorization)) {
        const sig = translateCredential(req.headers.authorization, { secretKey: mppKey });
        if (sig) {
          req.headers["payment-signature"] = sig;
          delete req.headers.authorization; // consumed - never let it be double-read downstream
          viaMpp = true;
        }
      }
      // ---- MPP outbound receipt: mirror PAYMENT-RESPONSE as Payment-Receipt ----
      // The middleware sets PAYMENT-RESPONSE after settlement and then replays
      // the handler's buffered writeHead, so hooking writeHead HERE (before the
      // middleware wraps it) sees the settled header at replay time.
      if (viaMpp) {
        const origWriteHead = res.writeHead;
        res.writeHead = function tollboothMppWriteHead(...args) {
          try {
            if (res.statusCode === 200 && !res.getHeader("Payment-Receipt")) {
              const settle = res.getHeader("PAYMENT-RESPONSE") || res.getHeader("payment-response");
              const receipt = settle ? receiptFromPaymentResponse(String(settle)) : null;
              if (receipt) res.setHeader("Payment-Receipt", receipt);
            }
          } catch { /* receipts are additive - never break the response */ }
          return origWriteHead.apply(this, args);
        };
      }
      // ---- 402 interceptor around the real response ----
      // The middleware answers "no/invalid payment" with res.status(402) +
      // setHeader(PAYMENT-REQUIRED ...) + json({}) (or send(html) for its
      // paywall). Swallow THAT write and emit the gate's 402 instead, carrying
      // the headers it set. Everything else reaches the real response.
      let intercepting = true;
      let granted = false;
      const realStatus = res.status.bind(res);
      const realJson = res.json.bind(res);
      const realSend = res.send.bind(res);
      const realEnd = res.end.bind(res);
      const restore = () => { intercepting = false; res.status = realStatus; res.json = realJson; res.send = realSend; res.end = realEnd; };
      const finish402 = () => {
        // Collect the middleware's 402 headers before restoring; the gate's
        // own send402 re-applies them on top of its body.
        const lifted = {};
        for (const name of ["PAYMENT-REQUIRED", "payment-required", "X-PAYMENT-REQUIRED", "x-payment-required"]) {
          const v = res.getHeader(name);
          if (v) lifted[name.toUpperCase() === "PAYMENT-REQUIRED" ? "PAYMENT-REQUIRED" : name] = String(v);
        }
        if (mppOn && lifted["PAYMENT-REQUIRED"]) {
          const www = challengesFromPaymentRequired(lifted["PAYMENT-REQUIRED"], { secretKey: mppKey, realm: mppRealm(req), chainIds: mppNetworks });
          if (www) lifted["WWW-Authenticate"] = www;
        }
        restore();
        // The middleware may have set a Content-Type for its own body; the
        // gate answers JSON.
        try { res.removeHeader("Content-Type"); } catch { /* ignore */ }
        send402({}, lifted);
      };
      // Pass-through never reassigns res.* here: on grant, @x402/express has
      // already captured these guards as its "original" methods and installed
      // its own buffering wrappers on top (that is how settle-after-handler
      // works). Reassigning would clobber those wrappers and the middleware
      // would wait forever for a res.end it never sees - i.e. serve without
      // settling. Only the 402 path restores (nothing is wrapped there).
      const guard = (write) => (...args) => {
        if (intercepting && !granted && res.statusCode === 402) { finish402(); return res; }
        return write(...args);
      };
      res.status = (code) => { realStatus(code); return res; };
      res.json = guard(realJson);
      res.send = guard(realSend);
      res.end = guard(realEnd);
      const grant = () => {
        granted = true;
        intercepting = false;
        incr(viaMpp ? "mppPaid" : "x402Paid");
        res.setHeader("X-Tollbooth-Paid", viaMpp ? "mpp" : "x402");
        return next();
      };
      let out;
      try {
        out = x402(req, res, grant);
      } catch (e) {
        restore();
        res.setHeader("X-Tollbooth-Error", "x402-middleware-threw");
        return send402();
      }
      return Promise.resolve(out).catch(() => {
        if (granted || res.headersSent) return; // the middleware's own settle-failure 402 already went out
        restore();
        res.setHeader("X-Tollbooth-Error", "x402-middleware-threw");
        send402();
      });
    };
    const mppRealm = (r) => {
      // Protection-space identifier for the challenge: the site's host, or the
      // configured resource base's host - the same origin the PoW binds.
      try { if (resourceBaseUrl) return new URL(resourceBaseUrl).host; } catch { /* fall through */ }
      return String(r.headers?.host || (r.get && r.get("host")) || "tollbooth").toLowerCase();
    };

    // Paid rail: x402 (USDC). Settlement verification is operator-supplied so
    // we reuse the standard, audited x402 stack rather than reinvent it. Reached
    // either directly or after the free rail declined, so it lives in a function
    // the (possibly async) proof-of-work branch can hand control back to.
    const paidRail = () => {
      if (tempoCfg) {
        const cred = parseTempoCredential(req.headers.authorization);
        if (cred) return tempoRail(cred);
      }
      if (x402) return middlewareRail();
      const payHeader = req.headers["x-payment"] || req.headers["payment-signature"];
      if (payTo && typeof verifyX402 === "function" && payHeader) {
        // Bound verification time so a slow/hung verifier can't exhaust resources.
        // F19: pass an AbortSignal and ABORT it on timeout, so a slow verifier that
        // also SETTLES cannot move money after we have already returned 402 (a
        // charged denial). A pure-verification callback may ignore the signal; a
        // settling one MUST cancel/drain in-flight work on it before returning.
        const ac = new AbortController();
        const timeout = new Promise((resolve) => setTimeout(() => { ac.abort(); resolve(false); }, VERIFY_TIMEOUT_MS));
        return Promise.race([Promise.resolve(verifyX402(req, { price, network, asset, payTo, resource, signal: ac.signal })), timeout])
          .then((ok) => {
            ac.abort(); // verification resolved: cancel anything still in flight
            if (ok) { incr("x402Paid"); res.setHeader("X-Tollbooth-Paid", "x402"); return next(); }
            send402();
          })
          .catch(() => { ac.abort(); res.setHeader("X-Tollbooth-Error", "x402-verify-failed"); send402(); });
      }

      return send402();
    };

    // Free rail: proof-of-work.
    const powHeader = req.headers["x-pow-solution"];
    if (powEngine && powHeader) {
      const afterPow = (r) => {
        if (r.ok) { incr("powSolved"); res.setHeader("X-Tollbooth-Paid", "pow"); return next(); }
        res.setHeader("X-Pow-Error", r.reason);
        return paidRail();
      };
      // pow.verify is synchronous with the default in-process replay store and
      // returns a promise when a shared store (SQLite/Redis) answers with one.
      // Branch on the shape instead of awaiting unconditionally: the default path
      // must keep resolving inside this tick, because a synchronous caller (and
      // our own single-process tests) would otherwise see the middleware return
      // before it has decided anything.
      const r = powEngine.verify(powHeader, powResource);
      if (r && typeof r.then === "function") {
        // A rejected verify would leave the request hanging with no response, so
        // it degrades to the same refusal the store-throw path produces.
        return r.then(afterPow, () => afterPow({ ok: false, reason: "replay store unavailable" }));
      }
      return afterPow(r);
    }

    return paidRail();
  }

  tollbooth.shouldCharge = shouldCharge;
  tollbooth.pow = powEngine;
  tollbooth.observe = observe;
  // Live counters for operators: how much traffic, how much was charged, and how
  // it was settled. A point-in-time snapshot (never mutated by the caller).
  // .stats() is sync (in-process mirror). .snapshot() is async (durable sink).
  tollbooth.stats = () => ({ ...mem.snapshot(), difficultyNow: difficultyNow(), observe });
  tollbooth.snapshot = async () => ({ ...(await sink.snapshot()), difficultyNow: difficultyNow(), observe });
  // Swallow flush errors — flush() is typically wired to ctx.waitUntil on the
  // edge; an unhandled rejection there pollutes logs without affecting the
  // already-sent response.
  tollbooth.flush = async () => { try { if (sink.flush) await sink.flush(); } catch { /* ignore */ } };
  return tollbooth;
}

/** Minimal reverse proxy: forward to `upstream` with the host PINNED (no SSRF via
 *  the request target), client trust/forwarding headers stripped, and the
 *  response STREAMED (no unbounded buffering). */
export function createProxy(upstream, { maxBody = 10 * 1024 * 1024 } = {}) {
  const base = new URL(upstream);
  return async (req, res) => {
    try {
      // Take ONLY the path+query from the (possibly hostile) target; the
      // authority is always the operator's upstream — protocol-relative or
      // absolute-form targets cannot redirect us to another host.
      const reqUrl = new URL(req.originalUrl || req.url || "/", base);
      const target = new URL(reqUrl.pathname + reqUrl.search, base);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!STRIP_INBOUND.has(k.toLowerCase())) headers[k] = v;
      }
      headers["x-forwarded-for"] = req.socket?.remoteAddress || ""; // set by us, not the client
      const method = req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, maxBody);
      const up = await fetch(target, { method, headers, body, redirect: "manual" });
      res.status(up.status);
      up.headers.forEach((val, key) => {
        const lk = key.toLowerCase();
        // fetch already decoded the body; drop hop-by-hop / length/encoding headers.
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lk)) return;
        res.setHeader(key, val);
      });
      if (up.body) Readable.fromWeb(up.body).pipe(res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `tollbooth proxy failed: ${e.message}` });
      else res.end();
    }
  };
}

function readBody(req, cap = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Chain names the CLI accepts for TOLLBOOTH_NETWORK, to CAIP-2. A raw
// `eip155:<id>` passes through. USDC-settling EVM chains only: the middleware
// built below registers @x402/evm's exact scheme, whose default money parser
// knows USDC on these networks; anything else (USDG on Robinhood Chain,
// Solana, Stellar, Algorand) needs the library API with the matching scheme.
export const CLI_NETWORKS = {
  base: "eip155:8453", "base-sepolia": "eip155:84532", polygon: "eip155:137", arbitrum: "eip155:42161",
  optimism: "eip155:10", avalanche: "eip155:43114", celo: "eip155:42220", sei: "eip155:1329", monad: "eip155:143",
};

/** Build a real @x402/express v2 middleware from env for the CLI, or null.
 *
 *  Before 0.8.0, TOLLBOOTH_PAYTO in CLI mode only ADVERTISED a quote: the gate
 *  had no verifier there, so every request that carried a payment was refused
 *  with a fresh 402 - a price nobody could pay, and the operator saw no error.
 *  With TOLLBOOTH_FACILITATOR_URL set as well, the CLI now constructs the
 *  standard @x402/express stack (verify -> proxy the request -> settle only on
 *  a <400 response, in the middleware's own order, exactly once) and hands it
 *  to createTollbooth({ x402 }), which also mints MPP challenges and accepts
 *  Authorization: Payment credentials by default - so `npx agent402-tollbooth`
 *  takes money over BOTH wires from env alone. @x402/* are optional peers
 *  (this package stays dependency-free otherwise); asking for settlement
 *  without them installed FAILS the start (fail closed: the operator believes
 *  they are charging).
 *
 *  Exported (with an injectable `env`) so the test can drive the same code the
 *  CLI runs, not a copy of it. */
export async function buildCliX402Middleware(env = process.env) {
  const payTo = env.TOLLBOOTH_PAYTO || "";
  const facilitatorUrl = env.TOLLBOOTH_FACILITATOR_URL || "";
  // Coinbase's facilitator (CDP) authenticates every verify/settle call with
  // a short-lived JWT signed by a CDP API key, so a static header cannot
  // reach it; @coinbase/x402's createFacilitatorConfig mints them. With the
  // two keys set the CLI settles through CDP (no fee is taken from the
  // payment; CDP's own free tier is 1,000 settlements a month, then $0.001
  // each), no URL needed. This is
  // the path a Coinbase Business account uses to get paid by agents.
  const cdpKeys = env.TOLLBOOTH_CDP_API_KEY_ID && env.TOLLBOOTH_CDP_API_KEY_SECRET;
  if (!payTo) return null;
  if (!facilitatorUrl && !cdpKeys) {
    console.warn("⚠ TOLLBOOTH_PAYTO is set without TOLLBOOTH_FACILITATOR_URL (or TOLLBOOTH_CDP_API_KEY_ID/SECRET): the 402 advertises a USDC quote but nothing here can verify or settle a payment, so every paid request is refused. Set TOLLBOOTH_FACILITATOR_URL (a public x402 facilitator that settles your network - keyless free tiers exist; https://x402.org/facilitator for base-sepolia) to actually charge, over x402 and MPP.");
    return null;
  }
  const asset = (env.TOLLBOOTH_ASSET || "USDC").toUpperCase();
  if (asset !== "USDC") {
    console.error(`✖ TOLLBOOTH_FACILITATOR_URL is set but TOLLBOOTH_ASSET=${asset}: the CLI's built-in settlement registers @x402/evm's exact USDC scheme only. For ${asset} use the library API - createTollbooth({ x402: paymentMiddleware(...) }) with the scheme your facilitator settles - or set TOLLBOOTH_ASSET=USDC. Refusing to start rather than advertise a quote it cannot settle.`);
    process.exit(1);
  }
  const rawNet = String(env.TOLLBOOTH_NETWORK || "base").trim().toLowerCase();
  const network = /^eip155:\d+$/.test(rawNet) ? rawNet : CLI_NETWORKS[rawNet];
  if (!network) {
    console.error(`✖ TOLLBOOTH_NETWORK=${rawNet} is not a chain the CLI can settle USDC on. Known: ${Object.keys(CLI_NETWORKS).join(", ")}, or a raw eip155:<chainId>. Refusing to start.`);
    process.exit(1);
  }
  let paymentMiddleware, HTTPFacilitatorClient, x402ResourceServer, ExactEvmScheme;
  try {
    ({ paymentMiddleware } = await import("@x402/express"));
    ({ HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server"));
    ({ ExactEvmScheme } = await import("@x402/evm/exact/server"));
  } catch (e) {
    console.error(`✖ TOLLBOOTH_FACILITATOR_URL or TOLLBOOTH_CDP_API_KEY_ID/SECRET is set, so this gate must settle x402 payments, but the x402 packages are not installed (${String(e?.message || e).slice(0, 120)}). Install them next to agent402-tollbooth: npm i @x402/express @x402/core @x402/evm . Refusing to start rather than advertise a quote it cannot settle.`);
    process.exit(1);
  }
  // Optional facilitator auth headers, sent on /verify, /settle and /supported
  // alike (facilitators disagree on the header name, so the operator names it).
  let authHeaders = null;
  if (env.TOLLBOOTH_FACILITATOR_HEADERS) {
    try { authHeaders = JSON.parse(env.TOLLBOOTH_FACILITATOR_HEADERS); } catch { console.error("✖ TOLLBOOTH_FACILITATOR_HEADERS must be a JSON object of header name -> value. Refusing to start."); process.exit(1); }
  }
  let cdpConfig = null;
  if (cdpKeys) {
    if (facilitatorUrl || authHeaders) console.warn("⚠ TOLLBOOTH_CDP_API_KEY_ID/SECRET are set, so TOLLBOOTH_FACILITATOR_URL / TOLLBOOTH_FACILITATOR_HEADERS are ignored: settlement goes through Coinbase's facilitator.");
    let createFacilitatorConfig;
    try { ({ createFacilitatorConfig } = await import("@coinbase/x402")); } catch (e) {
      console.error(`✖ TOLLBOOTH_CDP_API_KEY_ID/SECRET are set, so this gate must settle through Coinbase's facilitator, but @coinbase/x402 is not installed (${String(e?.message || e).slice(0, 120)}). Install it: npm install @coinbase/x402`);
      process.exit(1);
    }
    cdpConfig = createFacilitatorConfig(env.TOLLBOOTH_CDP_API_KEY_ID, env.TOLLBOOTH_CDP_API_KEY_SECRET);
    // Prove the key can sign BEFORE claiming to settle: createFacilitatorConfig
    // validates nothing, and a key that cannot mint a JWT would otherwise boot
    // "settling via Coinbase CDP" and answer every paid request 500 (nobody
    // charged, every agent turned away). Minting one JWT is local, no network.
    try { await cdpConfig.createAuthHeaders(); } catch (e) {
      const why = String(e?.message || e).replace(env.TOLLBOOTH_CDP_API_KEY_SECRET, "<secret>").slice(0, 160);
      console.error(`✖ TOLLBOOTH_CDP_API_KEY_SECRET cannot sign a facilitator request (${why}). Check the CDP API key secret; nothing is being charged.`);
      process.exit(1);
    }
  }
  const client = new HTTPFacilitatorClient(cdpConfig || {
    url: facilitatorUrl,
    ...(authHeaders ? { createAuthHeaders: async () => ({ verify: authHeaders, settle: authHeaders, supported: authHeaders }) } : {}),
  });
  const resourceServer = new x402ResourceServer(client).register(network, new ExactEvmScheme());
  const price = env.TOLLBOOTH_PRICE || "$0.001";
  const routes = {
    // Every method, every path (the proxy forwards them all); no verb prefix
    // means "*" in @x402/core's matcher. Never a bazaar extension on a wildcard.
    "/*": { accepts: [{ scheme: "exact", network, price, payTo }], description: "agent402-tollbooth: paid access for automated clients", mimeType: "application/json" },
  };
  return paymentMiddleware(routes, resourceServer);
}

async function startCli() {
  const upstream = process.env.TOLLBOOTH_UPSTREAM;
  const port = Number(process.env.PORT) || 4021;
  const _secret = process.env.TOLLBOOTH_SECRET;
  if (!_secret) {
    console.warn("⚠ TOLLBOOTH_SECRET not set — proof-of-work tokens use a random per-process secret: they won't survive a restart and will be rejected across multiple workers/instances. Set a stable TOLLBOOTH_SECRET in production.");
  } else if (/^change-me/i.test(_secret) || _secret === "change-me-to-a-long-random-string") {
    // FATAL, not a warning. The placeholder is published in our own deploy
    // template, so anyone can read it, mint a token with difficulty 0 and walk
    // through the gate without doing any work - the operator believes they are
    // charging while everything is free. A warning scrolls past in a container
    // log; refusing to start cannot be missed, and it fails CLOSED.
    console.error("✖ TOLLBOOTH_SECRET is the public placeholder from the deploy template. It is readable by anyone, so proof-of-work tokens can be forged and your gate bypassed for free. Refusing to start. Generate a real secret: openssl rand -hex 32");
    process.exit(1);
  }
  // A stable secret makes one solved token verifiable by EVERY process sharing
  // it, and the single-use record defaults to this process's memory, so behind a
  // load balancer, or under `cluster`, one solve buys a free request per process
  // for the token's lifetime. TOLLBOOTH_REPLAY_SQLITE points every process at one
  // claim table and closes that. Opt-in, because a single-process proxy (the
  // common case for this CLI) needs no file and no extra dependency.
  let replayStore;
  const replayPath = process.env.TOLLBOOTH_REPLAY_SQLITE;
  if (replayPath) {
    const { sqliteReplayStore } = await import("./replay.js");
    // node:sqlite is built in (Node 22.5+); better-sqlite3 covers older Node and
    // is what many operators already have installed. Neither is a dependency of
    // this package: the store is opt-in, so its driver is too.
    let db = null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(replayPath);
    } catch {
      try {
        const { default: Database } = await import("better-sqlite3");
        db = new Database(replayPath);
      } catch { db = null; }
    }
    if (!db) {
      // The operator asked for a shared store; starting without one would leave
      // the replay hole open while the config says it is closed. Fail closed.
      console.error(`✖ TOLLBOOTH_REPLAY_SQLITE=${replayPath} was set but no SQLite driver could be opened. Run Node 22.5+ (built-in node:sqlite) or install better-sqlite3. Refusing to start.`);
      process.exit(1);
    }
    try {
      // busy_timeout matters more than it looks: a claim that hits SQLITE_BUSY
      // throws, pow.js fails closed on a throw, and the refusal lands on a
      // crawler that did the work. WAL is best-effort because converting a
      // brand-new file needs an exclusive lock a sibling worker may hold
      // (measured: 2 of 160 simultaneous boots lost that lock); the winner writes
      // the mode into the file, so the losers inherit it and nothing is lost.
      db.exec("PRAGMA busy_timeout = 5000");
      try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* a sibling worker is setting it */ }
      replayStore = sqliteReplayStore(db);
    } catch (e) {
      // Not retried: the failure this actually produces is a permanently broken
      // file (for example an orphaned -wal/-shm left beside a deleted database),
      // which no number of attempts clears. Refuse to start rather than serve
      // with per-process-only replay protection while the config claims otherwise.
      console.error(`✖ TOLLBOOTH_REPLAY_SQLITE=${replayPath} could not be initialised: ${e.message}. If a stale ${replayPath}-wal / -shm pair is present without its database, remove them. Refusing to start.`);
      process.exit(1);
    }
    console.log(`shared proof-of-work replay store: sqlite ${replayPath}`);
  } else if (_secret) {
    console.warn("⚠ No shared proof-of-work replay store (TOLLBOOTH_REPLAY_SQLITE unset): solved tokens are single-use PER PROCESS only. Fine for one process; behind a load balancer or under `cluster`, one solve is redeemable once per process within its 5-minute TTL.");
  }
  const { default: express } = await import("express");
  const app = express();
  const x402mw = await buildCliX402Middleware();
  const gate = createTollbooth({ resourceBaseUrl: process.env.TOLLBOOTH_RESOURCE_BASE || upstream || "", replayStore, ...(x402mw ? { x402: x402mw } : {}) });
  // Operator analytics — aggregate counts only (no per-request data), mounted
  // before the gate so they're always reachable and never themselves charged.
  // Two opt-in admin tokens (legacy `TOLLBOOTH_STATS_TOKEN` covers /stats only;
  // `TOLLBOOTH_ADMIN_TOKEN` covers both the HTML dashboard AND /stats). If
  // neither is set the surfaces remain public (aggregate counts only — current
  // behavior) so existing deploys don't break. Comparison is timing-safe.
  const { dashboardHtml } = await import("./dashboard.js");
  const { timingSafeEqual } = await import("node:crypto");
  const ADMIN_TOKEN = process.env.TOLLBOOTH_ADMIN_TOKEN || "";
  const STATS_TOKEN = process.env.TOLLBOOTH_STATS_TOKEN || "";
  if (!ADMIN_TOKEN) {
    console.warn("⚠ TOLLBOOTH_ADMIN_TOKEN not set — the /__tollbooth analytics dashboard is publicly reachable (aggregate counts only, no per-request/payer data). Set TOLLBOOTH_ADMIN_TOKEN to require a token.");
  }
  const presented = (req) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    const hdr = req.headers["x-admin-token"];
    if (typeof hdr === "string") return hdr;
    return "";
  };
  // tokenMatch returns true only on a real, timing-safe equal match. An empty
  // `expected` is treated as "no rule configured", NOT as a wildcard — callers
  // upstream decide whether to invoke this check at all.
  const tokenMatch = (expected, got) => {
    if (!expected || typeof got !== "string" || got.length !== expected.length) return false;
    try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
    catch { return false; }
  };
  app.get("/__tollbooth", (req, res) => {
    if (ADMIN_TOKEN && !tokenMatch(ADMIN_TOKEN, presented(req))) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="tollbooth"');
      return res.status(401).type("text/plain").send("Unauthorized");
    }
    res.type("html").send(dashboardHtml());
  });
  app.get("/__tollbooth/stats", (req, res) => {
    // Either ADMIN_TOKEN or STATS_TOKEN unlocks /stats; either being set turns
    // the endpoint from public to gated, and the presented value must match
    // ONE of the configured tokens.
    const gated = Boolean(ADMIN_TOKEN || STATS_TOKEN);
    if (gated) {
      const got = presented(req);
      if (!tokenMatch(ADMIN_TOKEN, got) && !tokenMatch(STATS_TOKEN, got)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="tollbooth"');
        return res.status(401).type("text/plain").send("Unauthorized");
      }
    }
    res.json(gate.stats());
  });
  app.use(gate);
  if (upstream) {
    app.use(createProxy(upstream));
  } else {
    app.use((_req, res) => res.json({ ok: true, note: "Bare tollbooth gate (no TOLLBOOTH_UPSTREAM set). Clients that reach here paid or solved a proof-of-work." }));
  }
  const server = app.listen(port, () => {
    const paidLabel = x402mw ? `x402 + MPP (${process.env.TOLLBOOTH_ASSET || "USDC"}, settling via ${process.env.TOLLBOOTH_CDP_API_KEY_ID && process.env.TOLLBOOTH_CDP_API_KEY_SECRET ? "Coinbase CDP" : process.env.TOLLBOOTH_FACILITATOR_URL})` : (process.env.TOLLBOOTH_PAYTO ? `x402 quote only (${process.env.TOLLBOOTH_ASSET || "USDC"}, NOT settling - set TOLLBOOTH_FACILITATOR_URL)` : "");
    const rails = [gate.pow ? "proof-of-work" : "", paidLabel].filter(Boolean).join(" + ");
    // The BOUND port, so PORT=0 (let the OS pick) prints something a caller can use.
    const bound = server.address()?.port ?? port;
    console.log(`agent402-tollbooth listening on :${bound} — charging AI bots via ${rails || "proof-of-work"}`);
    if (upstream) console.log(`  proxying → ${upstream}`);
  });
  // Evidence for a process that leaves without being told to. Four times
  // (2026-08-19, 08-22, 08-26, 08-27; CI only, never locally) the CLI printed the
  // banner above and then exited 0 with no signal and no --trace-exit stack: the
  // event loop drained under a LISTENING server, which should be impossible while
  // the handle is ref'd. `beforeExit` is the one hook that fires exactly then;
  // naming the live handles and the server's own state at that instant is the
  // record every earlier occurrence lacked. Costs nothing in a healthy process
  // (it never fires while the server listens).
  server.on("close", () => console.error("[agent402-tollbooth] http server closed"));
  server.on("error", (e) => console.error(`[agent402-tollbooth] http server error: ${e?.code || ""} ${e?.message || e}`));
  process.on("beforeExit", (code) => {
    let active = "?";
    try { active = JSON.stringify(process.getActiveResourcesInfo()); } catch { /* older node */ }
    console.error(`[agent402-tollbooth] event loop drained (exit code ${code}) while listening=${server.listening} address=${JSON.stringify(server.address())} active=${active}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startCli();
