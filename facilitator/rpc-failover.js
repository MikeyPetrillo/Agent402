// Second (and third) Soroban RPC to fail over to, per request.
//
// Why this exists: the facilitator's recurring failure class is an RPC
// STALL before submission - the configured provider accepts the connection
// and never answers (2026-08-14, 08-19, 08-26). rpc-timeout.js bounds that
// at 10 s per request, which turns a hang into a clean error; this module
// turns the clean error into a second try somewhere else, so one stalled
// provider costs one bounded hop instead of the whole settlement.
//
// Same seam as rpc-timeout.js and rpc-diagnostics.js: @x402/stellar builds
// its own rpc.Server per call from the configured URL (not injectable), so
// the prototype is patched. Install this LAST so it wraps the timeout and
// the diagnostics and observes the errors they produce.
//
// Rules, each pinned in test.js:
//   - Only TRANSPORT failures fail over (timeouts, connection errors, HTTP
//     5xx/429, a body-less response). A JSON-RPC error - a failed
//     simulation, a bad sequence, a rejected transaction - is an answer,
//     not an outage, and is thrown as-is: the same call on another node
//     would get the same answer and re-sending a rejected tx is not free.
//   - A call already running on a fallback instance never fails over again
//     (no recursion); the fallback list is tried in order, once each.
//   - Every attempt inherits the per-request timeout (the timeout patch is
//     on the same prototype), so the worst case is (1 + fallbacks) x bound.
//   - The ORIGINAL (primary) error is what the caller sees when every node
//     failed, with `fallbackErrors` attached for the log.
//   - sendTransaction fails over too: the envelope is already signed, so a
//     second submission of the same bytes yields the same hash and cannot
//     double-charge; the calling side's on-chain confirmation handles the
//     "timed out but landed" case exactly as before.
//   - HEDGED READS (2026-08-28): a primary that ANSWERS, just slowly, never
//     trips the 10 s bound and never fails over - and a settle is a chain of
//     six to ten RPC round-trips before submission plus one per poll, so a
//     node answering in 8 s each burned the whole 60 s settle budget with no
//     error anywhere (paid canary 15:14Z: 60 s timeout, no failover line, no
//     submission, nothing on-chain). With `hedgeMs` > 0, every read that is
//     still silent after hedgeMs is ALSO sent to the first fallback and the
//     first ANSWER wins (a JSON-RPC error is an answer; a transport failure
//     waits for the other side). sendTransaction is never hedged (a second
//     submit is the ordinary failover's job, only on a transport failure).
import { rpc } from "@stellar/stellar-sdk";

let installed = false;
const IS_FALLBACK = Symbol.for("agent402.facilitator.rpcFallbackInstance");
const TRANSPORT_CODES = new Set(["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_NETWORK", "ERR_BAD_RESPONSE", "EPIPE", "RPC_REQUEST_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Public keyless Soroban RPCs. Overridden by FACILITATOR_RPC_FALLBACK_URLS.
 *  Each entry is a different operator's host from the network's primary (the
 *  vendor default on testnet, FACILITATOR_MAINNET_RPC_URL on pubnet): a
 *  fallback equal to the primary is skipped by failover() and disables the
 *  hedge, so it would leave nowhere to go.
 *  Pubnet order (2026-11-01, getVersionInfo): rpc.ankr.com runs RPC 30.0.0
 *  and mainnet.sorobanrpc.com 29.0.1. Protocol 30's mainnet vote is
 *  2026-11-23 17:00 UTC and an RPC must run v30 to follow it, so the v30 node
 *  is first (it also takes the hedged reads); the other stays a later hop. */
export const DEFAULT_FALLBACKS = {
  "stellar:pubnet": ["https://rpc.ankr.com/stellar_soroban", "https://mainnet.sorobanrpc.com"],
  "stellar:testnet": ["https://rpc.ankr.com/stellar_testnet_soroban"],
};

/** Is this failure the NODE's (retry elsewhere) or the TRANSACTION's (an
 *  answer)? Exported for tests. */
export function isTransportFailure(err) {
  if (!err) return false;
  if (typeof err.code === "string" && TRANSPORT_CODES.has(err.code)) return true;
  const status = Number(err?.response?.status ?? err?.status);
  if (Number.isFinite(status) && (status >= 500 || status === 429)) return true;
  const msg = String(err?.message || "");
  if (/timeout of \d+ ?ms exceeded|socket hang up|network error|fetch failed|ECONNRESET|ECONNREFUSED/i.test(msg)) return true;
  // A JSON-RPC error object ({code: -32xxx, message}) is an answer.
  return false;
}

/** Parse the fallback list: env CSV wins; "off" disables; else the network's default. */
export function resolveFallbackUrls(network, envValue) {
  const raw = String(envValue ?? "").trim();
  if (/^(off|none|0|false)$/i.test(raw)) return [];
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : (DEFAULT_FALLBACKS[network] || []);
  const out = [];
  for (const u of list) {
    try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) continue; out.push(p.toString().replace(/\/$/, "")); } catch { /* skip junk */ }
  }
  return [...new Set(out)];
}

const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return String(u); } };

// Module state read at CALL time: the prototype is patched exactly once per
// process; a later install (tests) replaces the list, never wraps again -
// stacked wrappers would consult the FIRST list forever (found by test (c)).
let state = null;
let protoPatched = false;

/** Install the failover on rpc.Server.prototype. `fallbackUrls` in order.
 *  Returns the number of methods patched (0 when nothing to fail over to). */
export function installRpcFailover(fallbackUrls, { log = console.log, allowHttp = false, requestTimeoutMs = null, hedgeMs = 0 } = {}) {
  if (installed) return 0;
  installed = true;
  const urls = (fallbackUrls || []).map((u) => String(u).replace(/\/$/, ""));
  if (!urls.length) { state = null; log("[startup] RPC failover DISABLED (no fallback RPC urls) - a stalled primary is bounded only by the request timeout"); return 0; }
  state = { urls, log, allowHttp, requestTimeoutMs, hedgeMs: Number(hedgeMs) > 0 ? Number(hedgeMs) : 0, instances: new Map() };
  const patched = protoPatched ? countMethods() : patchPrototype();
  protoPatched = true;
  log(`[startup] RPC failover installed: ${urls.map(hostOf).join(", ")} (${patched} rpc.Server methods; transport failures only${state.hedgeMs ? `; reads hedged to ${hostOf(urls[0])} after ${state.hedgeMs}ms of silence` : ""})`);
  return patched;
}

function fallbackFor(url) {
  const st = state;
  if (!st.instances.has(url)) {
    const s = new rpc.Server(url, { allowHttp: st.allowHttp || url.startsWith("http:") });
    s[IS_FALLBACK] = true;
    // Tests bound the hop tighter; production leaves it to rpc-timeout's default.
    if (st.requestTimeoutMs > 0 && s.httpClient?.defaults) s.httpClient.defaults.timeout = st.requestTimeoutMs;
    st.instances.set(url, s);
  }
  return st.instances.get(url);
}

async function failover(self, name, args, primaryErr, original) {
  const st = state;
  const here = String(self?.serverURL || "").replace(/\/$/, "");
  if (!st || self?.[IS_FALLBACK] || st.urls.includes(here) || !isTransportFailure(primaryErr)) throw primaryErr;
  const errors = [];
  for (const url of st.urls) {
    if (url === here) continue;
    st.log(`[rpc-failover] ${name}: ${hostOf(here)} failed (${String(primaryErr?.code || primaryErr?.message || primaryErr).slice(0, 80)}) -> trying ${hostOf(url)}`);
    try {
      const out = await original.apply(fallbackFor(url), args);
      st.log(`[rpc-failover] ${name}: served by ${hostOf(url)}`);
      return out;
    } catch (e) {
      errors.push({ url, error: String(e?.code || e?.message || e).slice(0, 120) });
      if (!isTransportFailure(e)) { try { e.fallbackOf = here; } catch { /* frozen */ } throw e; } // an ANSWER from the fallback node stands
    }
  }
  st.log(`[rpc-failover] ${name}: every fallback failed too (${errors.map((x) => `${hostOf(x.url)}: ${x.error}`).join("; ")})`);
  try { primaryErr.fallbackErrors = errors; } catch { /* frozen error */ }
  throw primaryErr;
}

/** Should this call be hedged? Reads only, never on a fallback instance,
 *  never when the primary IS a fallback url. Exported for tests. */
export function shouldHedge(name, self) {
  const st = state;
  if (!st || !(st.hedgeMs > 0) || !st.urls.length) return false;
  if (name === "sendTransaction" || self?.[IS_FALLBACK]) return false;
  const here = String(self?.serverURL || "").replace(/\/$/, "");
  return !st.urls.includes(here);
}

// First ANSWER wins. A transport failure from one side waits for the other;
// a transport failure from the primary BEFORE the hedge fired takes the
// ordinary failover path (fallbacks in order); both sides failing rejects
// with the primary's error (fallback error attached), as failover() does.
function hedged(self, name, args, primary, original) {
  const st = state;
  const here = String(self?.serverURL || "").replace(/\/$/, "");
  const url = st.urls[0];
  return new Promise((resolve, reject) => {
    let done = false, hedgeStarted = false, hedgeErr = null, primaryErr = null;
    let timer = null;
    const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(v); };
    timer = setTimeout(() => {
      if (done) return;
      hedgeStarted = true;
      st.log(`[rpc-hedge] ${name}: ${hostOf(here)} silent for ${st.hedgeMs}ms -> also asking ${hostOf(url)}`);
      Promise.resolve().then(() => original.apply(fallbackFor(url), args)).then(
        (v) => { st.log(`[rpc-hedge] ${name}: served by ${hostOf(url)}`); finish(resolve, v); },
        (e) => {
          if (!isTransportFailure(e)) return finish(reject, e); // an answer from the fallback stands
          hedgeErr = e;
          if (primaryErr) { try { primaryErr.fallbackErrors = [{ url, error: String(e?.code || e?.message || e).slice(0, 120) }]; } catch { /* frozen */ } finish(reject, primaryErr); }
        },
      );
    }, st.hedgeMs);
    primary.then(
      (v) => finish(resolve, v),
      (e) => {
        if (done) return;
        if (!isTransportFailure(e)) return finish(reject, e);
        if (!hedgeStarted) { done = true; clearTimeout(timer); failover(self, name, args, e, original).then(resolve, reject); return; }
        primaryErr = e;
        if (hedgeErr) { try { e.fallbackErrors = [{ url, error: String(hedgeErr?.code || hedgeErr?.message || hedgeErr).slice(0, 120) }]; } catch { /* frozen */ } finish(reject, e); }
      },
    );
  });
}

function countMethods() {
  return Object.getOwnPropertyNames(rpc.Server.prototype).filter((n) => n !== "constructor" && typeof Object.getOwnPropertyDescriptor(rpc.Server.prototype, n)?.value === "function").length;
}

function patchPrototype() {
  const proto = rpc.Server.prototype;
  let patched = 0;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== "function" || !d.writable) continue;
    const original = d.value;
    Object.defineProperty(proto, name, {
      ...d,
      value: function rpcWithFailover(...args) {
        // Preserve synchronous returns (the SDK has a couple of non-async
        // methods); only a rejected promise is examined for failover.
        let r;
        try { r = original.apply(this, args); } catch (e) { return failover(this, name, args, e, original); }
        if (!r || typeof r.then !== "function") return r;
        if (shouldHedge(name, this)) return hedged(this, name, args, r, original);
        return r.catch((e) => failover(this, name, args, e, original));
      },
    });
    patched++;
  }
  return patched;
}

// ---- RPC version check (startup only, never on a settle) -------------------
// An RPC whose software major is below the network's protocol cannot follow
// that ledger, and one below the next scheduled protocol stops at its vote.
// Read once after listen with plain JSON-RPC POSTs (not rpc.Server, so none of
// the patches above run and nothing is hedged); the answer is a log line.
/** The protocol every RPC should already run: the next scheduled upgrade.
 *  FACILITATOR_RPC_MIN_VERSION overrides it; "off" skips the check. */
export const EXPECTED_RPC_MAJOR = 30;

export function resolveMinRpcMajor(envValue) {
  const raw = String(envValue ?? "").trim();
  if (/^(off|none|false)$/i.test(raw)) return null;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : EXPECTED_RPC_MAJOR;
}

/** One RPC's verdict from its getVersionInfo and getNetwork answers. */
export function rpcVersionVerdict(versionInfo, network, minMajor) {
  const version = String(versionInfo?.version || "");
  const major = Number.parseInt(version, 10);
  const networkProtocol = Number(network?.protocolVersion ?? versionInfo?.protocolVersion);
  if (!Number.isFinite(major)) return { version: version || null, major: null, networkProtocol: Number.isFinite(networkProtocol) ? networkProtocol : null, behind: null };
  const floor = Math.max(Number.isFinite(networkProtocol) ? networkProtocol : 0, Number.isFinite(minMajor) ? minMajor : 0);
  return { version, major, networkProtocol: Number.isFinite(networkProtocol) ? networkProtocol : null, behind: major < floor, floor };
}

async function jsonRpc(url, method, { timeoutMs, fetchImpl }) {
  const res = await fetchImpl(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j?.error) throw new Error(`JSON-RPC ${j.error.code ?? "error"}`);
  return j?.result;
}

/** Reads every URL's version and logs a warning for one that is behind.
 *  Resolves with the per-host rows; never throws. */
export async function checkRpcVersions(urls, { minMajor = EXPECTED_RPC_MAJOR, timeoutMs = 5_000, log = console.log, warn = console.warn, fetchImpl = globalThis.fetch } = {}) {
  const rows = await Promise.all([...new Set((urls || []).filter(Boolean).map((u) => String(u).replace(/\/$/, "")))].map(async (url) => {
    const host = hostOf(url);
    try {
      const [info, network] = await Promise.all([
        jsonRpc(url, "getVersionInfo", { timeoutMs, fetchImpl }),
        jsonRpc(url, "getNetwork", { timeoutMs, fetchImpl }).catch(() => null),
      ]);
      return { host, ...rpcVersionVerdict(info, network, minMajor) };
    } catch (err) {
      return { host, version: null, major: null, networkProtocol: null, behind: null, error: String(err?.message || err).slice(0, 120) };
    }
  }));
  for (const r of rows) {
    if (r.behind) {
      const when = r.networkProtocol !== null && r.major < r.networkProtocol ? "it cannot follow the current ledger" : `it stops following the ledger when protocol ${r.floor} activates`;
      warn(`[startup] RPC ${r.host} runs ${r.version}, below protocol ${r.floor} (network at ${r.networkProtocol ?? "unknown"}); ${when} - move it later in FACILITATOR_RPC_FALLBACK_URLS or replace it`);
    }
    else if (r.major === null) warn(`[startup] RPC ${r.host} version unread (${r.error || "no version in getVersionInfo"})`);
    else log(`[startup] RPC ${r.host} runs ${r.version} (network protocol ${r.networkProtocol ?? "unknown"})`);
  }
  return rows;
}

/** Test seam: forget the installed state (the prototype stays patched). */
export function _resetForTest() { installed = false; }
