// CDP kit — agent-wallet onboarding tools powered by the Coinbase Developer
// Platform, reusing the same CDP_API_KEY_ID / CDP_API_KEY_SECRET that already
// drive x402 settlement (no new secrets). Env-gated like llm-kit: missing
// keys → 503 at call time, never a boot failure.
//
//   wallet-balances  $0.002  indexed ERC-20 + native balances for any address
//                            (base / ethereum / base-sepolia) — one call, no
//                            per-token contract wrangling
//   testnet-fund     $0.001  base-sepolia faucet (USDC/ETH) — one tenth of a
//                            cent buys 1 full testnet USDC to rehearse the
//                            x402 loop safely (wallet-only: the faucet spends
//                            a shared per-account CDP budget)
//   onramp-link      $0.001  single-use Coinbase Onramp URL that lets a human
//                            fund an agent's wallet with a card / Apple Pay
//   onchain-sql      $0.020  read-only ClickHouse-dialect SQL over Coinbase's
//                            indexed DECODED chain data (Base events/txs/
//                            blocks/user-ops/builder-code attributions,
//                            Solana token instructions) — no indexer to run
//   onchain-sql-schema $0.002 the table/column schema for the above
//
// Auth: CDP REST uses a short-lived JWT (ES256 for PEM EC keys, EdDSA for
// base64 Ed25519 keys) with a per-request `uris` claim. Implemented on
// node:crypto — the @coinbase/cdp-sdk dependency tree (axios/viem/solana-kit)
// is far heavier than the three REST calls we make. Claim structure mirrors
// the SDK's auth/utils/jwt.ts exactly.
import { createPrivateKey, createSign, randomBytes, sign as edSign, createHash } from "node:crypto";
import { redactSecrets } from "./redact.js";
import { partialFields } from "../partial-answer.js";
import { upstreamFetch, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS, currentBudget, isUpstreamFailure, OPTIONAL_READ_FLOOR_MS } from "../upstream-deadline.js";

const CDP_HOST = "api.cdp.coinbase.com";

const keyId = () => (process.env.CDP_API_KEY_ID || "").trim();
const keySecret = () => (process.env.CDP_API_KEY_SECRET || "").trim();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Mint a CDP REST JWT for one request. Exported for the offline unit test.
 *  The uris claim signs the PATHNAME only — query strings are excluded
 *  (mirrors the SDK's url.pathname; signing the query yields HTTP 401). */
export async function mintCdpJwt({ method, path, apiKeyId = keyId(), apiKeySecret = keySecret(), host = CDP_HOST }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: apiKeyId,
    iss: "cdp",
    uris: [`${method} ${host}${path.split("?")[0]}`],
    iat: now,
    nbf: now,
    exp: now + 120,
  };
  let alg, key;
  if (apiKeySecret.includes("-----BEGIN")) {
    alg = "ES256";
    // ES256 is P-256 only: a PEM holding another curve or key type would sign
    // a token CDP refuses, so it is refused here, naming the type, never the key.
    const pk = createPrivateKey(apiKeySecret);
    const curve = pk.asymmetricKeyDetails?.namedCurve;
    if (pk.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
      throw bad(`CDP key secret is a PEM ${pk.asymmetricKeyType}${curve ? ` (${curve})` : ""} key; ES256 needs an EC P-256 key`, 503);
    }
    key = { key: pk, dsaEncoding: "ieee-p1363" };
  } else {
    const decoded = Buffer.from(apiKeySecret, "base64");
    if (decoded.length !== 64) throw bad("CDP key secret is neither a PEM EC key nor a base64 Ed25519 key", 503);
    alg = "EdDSA";
    key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: decoded.subarray(0, 32).toString("base64url"), x: decoded.subarray(32).toString("base64url") },
      format: "jwk",
    });
  }
  const header = { alg, kid: apiKeyId, typ: "JWT", nonce: randomBytes(16).toString("hex") };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = alg === "ES256"
    ? createSign("SHA256").update(signingInput).sign(key)
    : edSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/** One authenticated CDP REST call with repo-standard error attribution.
 *
 * Retries transient failures with backoff and a fresh JWT per attempt: an
 * HTTP 5xx or a network error up to ATTEMPTS times, a 429 at most once
 * (honoring a short Retry-After). A request that may have taken effect (a
 * non-idempotent POST: faucet, onramp session) is never retried after a
 * transport timeout. Client errors fail fast; 401/403 is this server's
 * configuration and answers "not configured"; a final 429 is a 503 with no
 * upstream detail. Every refusal here is >= 400, so the buyer is not charged. */
const RETRY_AFTER_CAP_MS = 2000;
function retryAfterMs(res) {
  const raw = res?.headers?.get?.("retry-after");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(RETRY_AFTER_CAP_MS, n * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - Date.now())) : null;
}

// DEADLINES (src/upstream-deadline.js): each attempt runs under its own cap
// and the handler budget, and a retry (with its backoff) is started only while
// the budget can hold it, so the retry walk answers inside the payment window
// instead of running up to five full caps. An attempt that outlives its cap,
// or a host that cannot be reached, is a 503 naming the upstream and the step,
// attributed upstream, never a 504. Outside a handler (a scheduled read) an
// attempt keeps its own cap.
const CDP_READ_MS = 15_000;
// A 502 or 504 on a SQL query that took this long is the data API's answer
// to a query that ran past its time limit: resending the same query fails
// the same way, so it is answered once, with how to narrow it.
let slowQueryGatewayMs = 8_000;
export function _setSlowQueryGatewayMsForTest(ms) { slowQueryGatewayMs = ms; }
function cdpStep(path) {
  if (/\/faucet$/.test(path)) return "faucet";
  if (/\/token-balances\//.test(path)) return "token balances";
  if (/\/onramp\/sessions$/.test(path)) return "onramp session";
  if (/\/data\/query\/schema$/.test(path)) return "query schema";
  if (/\/data\/query\/run$/.test(path)) return "query";
  return "request";
}

/** An upstream body for a log line, with anything that may echo a buyer's
 *  query literal (quoted strings, hex, long numbers) replaced. */
export function redactLiterals(text) {
  return String(text || "").replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.){24,}"/g, "'…'").replace(/\b0x[0-9a-f]{6,}\b/gi, "0x…").replace(/\b\d{6,}\b/g, "#");
}

/** A query with every string literal's inside and every comment blanked,
 *  the same length as the query, so a keyword check reads only code and a
 *  position in it is a position in the query. One pass, so a quote inside a
 *  comment or a comment marker inside a string is read as what it is. In
 *  this dialect a string is single-quoted; double quotes and backticks quote
 *  identifiers and are kept. */
// A string that is never closed runs to the end (linear; a backtracking
// pattern was quadratic on an unclosed string of escaped quotes). An
// identifier in double quotes or backticks is one token, so a quote or a
// comment marker inside it is neither a string nor a comment.
const SQL_TOKENS = /('(?:[^'\\]|\\.)*(?:'|$))|("(?:[^"\\]|\\.)*(?:"|$)|`(?:[^`\\]|\\.)*(?:`|$))|(\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|#[^\n]*)/g;
export function sqlCode(sql) {
  return String(sql || "").replace(SQL_TOKENS, (m, str, ident) => (str ? "'" + "_".repeat(Math.max(0, m.length - 2)) + m[m.length - 1].replace(/[^']/, "'") : ident ? m : m.replace(/[^\n]/g, " ")));
}
/** sqlCode with identifier quotes removed, for keyword and table checks
 *  (`solana`.`instructions` and "block_time" read as the plain names). */
export function sqlNorm(sql) {
  return sqlCode(sql).replace(/[`"]/g, "");
}
/** The query with comments blanked and strings kept, for reading values. */
function sqlNoComments(sql) {
  return String(sql || "").replace(SQL_TOKENS, (m, str, ident) => (str || ident ? m : m.replace(/[^\n]/g, " ")));
}

/** A query's shape for a log line: length, tables, clauses. No literals. */
export function sqlShape(sql) {
  const s = sqlNorm(sql);
  const tables = [...new Set([...s.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()))].slice(0, 6);
  const has = (re) => (re.test(s) ? 1 : 0);
  return `len=${s.length},tables=${tables.join("+") || "-"},where=${has(/\bwhere\b/i)},limit=${has(/\blimit\b/i)},groupby=${has(/\bgroup\s+by\b/i)},orderby=${has(/\border\s+by\b/i)},joins=${(s.match(/\bjoin\b/gi) || []).length},timefilter=${has(/\bblock_(?:timestamp|number|time|slot)\b[^;]*?(?:>|<|between)/i)}`;
}

// The failure monitor skips a fetch carrying this key (src/tool-failure-monitor.js).
const NO_OUTCOME = Symbol.for("agent402.noOutcome");

// Whether the query service answers a known-good query, read only when a
// buyer's query fails slowly (at most once per HEALTH_TTL_MS), so a query
// too heavy for the service is told apart from an outage of the service.
// The known-good query reads the table the buyer's query read, so a table
// that fails on its own is not read as the buyer's fault.
export const QUERY_HEALTH_SQL = Object.freeze({
  solana: "SELECT block_slot FROM solana.instructions LIMIT 1",
  base: "SELECT block_number FROM base.blocks LIMIT 1",
});
export const HEALTH_TTL_MS = 5 * 60_000;
export const HEALTH_TIMEOUT_MS = 5_000;
let healthTimeoutMs = HEALTH_TIMEOUT_MS;
const queryHealth = new Map(); // table -> { ok, at }
const healthInflight = new Map(); // table -> promise
function healthTableOf(sql) { return /\bsolana\s*\.\s*instructions\b/i.test(sqlNorm(sql)) ? "solana" : "base"; }
async function queryServiceHealthy(sql = "", now = Date.now()) {
  const table = healthTableOf(sql);
  const known = queryHealth.get(table);
  if (known && now - known.at < HEALTH_TTL_MS) return known.ok;
  if (!healthInflight.has(table)) {
    healthInflight.set(table, (async () => {
      let ok = false;
      try {
        const path = "/platform/v2/data/query/run";
        const jwt = await mintCdpJwt({ method: "POST", path });
        // Its own budget and timeout: it runs on an error path, after the
        // buyer's call, and must not outlive a short wait.
        const r = await upstreamFetch(`https://${CDP_HOST}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sql: QUERY_HEALTH_SQL[table] }),
        }, { label: "Coinbase Developer Platform", step: "query health", timeoutMs: healthTimeoutMs, tag: "[cdp]", budget: null });
        ok = r.ok;
        await r.text().catch(() => "");
      } catch { ok = false; }
      queryHealth.set(table, { ok, at: Date.now() });
      return ok;
    })().finally(() => { healthInflight.delete(table); }));
  }
  return healthInflight.get(table);
}
export function _setQueryHealthForTest(ok, table = null) {
  const tables = table ? [table] : Object.keys(QUERY_HEALTH_SQL);
  for (const t of tables) { if (ok === null) queryHealth.delete(t); else queryHealth.set(t, { ok, at: Date.now() }); }
}
export function _setHealthTimeoutMsForTest(ms) { healthTimeoutMs = ms || HEALTH_TIMEOUT_MS; }

// Buyer queries in flight at once: the query service rate-limits the
// project, whose keys also sign facilitator calls, so a burst of heavy
// queries must not hold it. Past the cap a query is refused at once (429,
// never charged) and told when to retry.
export const BUYER_QUERY_INFLIGHT_MAX = 2;
let buyerQueriesInflight = 0;
export function _buyerQueriesInflightForTest() { return buyerQueriesInflight; }

// One [cdp] 5xx line per status and query shape a minute: a buyer resending
// the same failing query does not repeat it.
const loggedAt = new Map();
function logOnce(key, now = Date.now()) {
  const last = loggedAt.get(key);
  if (last && now - last < 60_000) return false;
  if (loggedAt.size > 500) loggedAt.clear();
  loggedAt.set(key, now);
  return true;
}
export function _resetCdpLogThrottleForTest() { loggedAt.clear(); }

// The text of a buyer's query the query service could not answer, in the
// operational log (operator-only) so the exact query can be run again by
// hand: the shape alone does not say what in it reads past the service's
// limits. Once per distinct query a minute; the owner approved this on
// 2026-11-03, and /privacy names it.
function logFailedBuyerQuery(status, tookMs, sql) {
  const text = String(sql || "");
  if (!text) return;
  const key = `sql|${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  if (!logOnce(key)) return;
  console.warn(`[cdp] failed buyer query (HTTP ${status} after ${tookMs}ms): ${JSON.stringify(text)}`);
}
export function _cdpLogThrottleSizeForTest() { return loggedAt.size; }
export function _cdpLogOnceForTest(key, now) { return logOnce(key, now); }

// A buyer's SQL query (onchain-sql): the query service answers a 5xx when a
// result is too large to return (an instant 500; a wide table's slow 502),
// and the same query fails the same way, so it is tried twice at most, a
// slow 502/504 once, and the answer says how to narrow it.
const QUERY_ATTEMPTS = 2;
// A slow 502/504 while the service answers a known-good query is this query
// running past the service's time window: the caller's to narrow, answered
// 422 so one buyer's heavy query is a buyer outcome, not a tool failure. With
// the known-good query failing too, or an instant 500 (twice), it stays a
// 502, so an outage of the service still reads as one.
function narrowQueryError(status, tookMs, sql = "", answerStatus = 502) {
  const solana = /\bsolana\./i.test(sql);
  const days = solana ? blockTimeRangeDays(sql) : null;
  const span = days === null ? null : days < 1 ? `${Math.max(1, Math.round(days * 24))} hours` : `${Math.round(days)} days`;
  const covered = span ? ` This query covers about ${span} of solana.instructions; what it reads depends on its columns and filters (measured: a day answers in seconds, a week does for some filters and not others).` : "";
  const range = solana ? "a shorter block_time range (start at a day, e.g. WHERE block_time > now() - INTERVAL 1 DAY, and cover a longer period in steps)" : "a block_number range or an address filter";
  const e = bad(`CDP's query service could not return this result (HTTP ${status} after ${(tookMs / 1000).toFixed(1)} s). It answers this way when a query runs past its answer window of about 10 s, reads more than its 100 GB per-query limit, or returns a result too large to send.${covered} Narrow it: select fewer columns, add ${range}, or lower the LIMIT; resending it unchanged fails the same way. Nothing was charged.`, answerStatus);
  e.hint = "narrow-query";
  return e;
}

// The query service answers an instant 500 (its generic internal error)
// when a result is too large to send: measured 2026-11-03 on a buyer's
// query whose rows were about 40 KB each: 50 rows and more failed every
// time, 25 rows (about 1 MB) answered about three runs in four, 10 to 20
// rows (0.4 to 0.8 MB) nearly always; the same query counted in 0.3 s. So
// the edge is about 1 MB with some noise under it: the capped re-run asks
// for 10 rows, gets two attempts, and the LIMIT it suggests keeps an answer
// under about 500 KB. Resending the query unchanged fails the same way.
export const SQL_RECOVER_ROWS = 10;
export const SQL_RECOVER_ATTEMPTS = 2;
export const SQL_SEND_LIMIT_BYTES = 500_000;
function resultTooLargeError(status, tookMs) {
  const e = bad(`CDP's query service failed inside this query (HTTP ${status}, its internal error), which it answers when a result is too large to send (an answer under about ${Math.round(SQL_SEND_LIMIT_BYTES / 1e3)} KB is usually sent): lower the LIMIT or select fewer or narrower columns. Nothing was charged.`, 502);
  e.hint = "narrow-query"; e.resultTooLarge = true; e.cdpStatus = status; e.tookMs = tookMs;
  return e;
}

async function cdpFetch(method, path, body, { idempotent = method === "GET", buyerQuery = false, attempts = null } = {}) {
  if (!keyId() || !keySecret()) {
    throw bad("This tool is temporarily unavailable: the operator has not configured Coinbase Developer Platform credentials (CDP_API_KEY_ID / CDP_API_KEY_SECRET).", 503);
  }
  // Ride out a transient CDP-side blip (a 5xx from their indexer, a timeout)
  // rather than surfacing it to the caller: up to 5 attempts with exponential +
  // jittered backoff (~0.4s, 0.8s, 1.6s, 3.2s, capped 4s).
  const ATTEMPTS = attempts || (buyerQuery ? QUERY_ATTEMPTS : 5);
  let lastErr;
  let rateLimited = 0;
  let waitMs = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = waitMs ?? (Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      waitMs = null;
      // A retry is started only while the handler budget can hold the wait
      // and a read after it; otherwise the last failure is the answer.
      const budget = currentBudget();
      if (budget && budget.remaining() - backoff < OPTIONAL_READ_FLOOR_MS) throw lastErr;
      await new Promise((r) => setTimeout(r, backoff));
    }
    const jwt = await mintCdpJwt({ method, path });
    const started = Date.now();
    let res;
    try {
      res = await upstreamFetch(`https://${CDP_HOST}${path}`, {
        method,
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        // Whether a buyer's query answers depends on the query, so it is
        // not counted in the upstream's health lane; the health probe below
        // and the service's own reads are.
        ...(buyerQuery ? { [NO_OUTCOME]: true } : {}),
      }, { label: "Coinbase Developer Platform", step: cdpStep(path), timeoutMs: CDP_READ_MS, tag: "[cdp]" });
    } catch (e) {
      lastErr = e;
      // The request may have reached CDP and taken effect: never resend it.
      if (!idempotent) throw lastErr;
      continue; // network error / timeout: retry while the budget holds
    }
    const text = await res.text().catch(() => "");
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* a gateway's HTML page */ }
    if (res.ok) return json;
    // A 5xx is logged with what identifies it on both sides: the attempt's
    // time, CDP's request id, the start of its body, and the query's shape
    // (tables and clauses, never its literals).
    if (res.status >= 500 && logOnce(`${res.status}|${body?.sql ? sqlShape(body.sql) : path}`)) {
      const rid = res.headers.get("x-request-id") || res.headers.get("x-correlation-id") || res.headers.get("cf-ray") || "-";
      console.warn(`[cdp] ${cdpStep(path)} HTTP ${res.status} after ${Date.now() - started}ms (attempt ${attempt + 1}/${ATTEMPTS}) rid=${rid} body=${JSON.stringify(redactLiterals(redactSecrets(text).slice(0, 4000).replace(/\s+/g, " ")).slice(0, 160))}${body?.sql ? ` sql=${sqlShape(body.sql)}` : ""}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw bad("This tool is temporarily unavailable: Coinbase Developer Platform access is not configured on this deployment.", 503);
    }
    if (res.status === 429) {
      lastErr = bad("Coinbase Developer Platform is busy right now - retry shortly. Nothing was charged.", 503);
      if (++rateLimited > 1) throw lastErr;
      waitMs = retryAfterMs(res);
      continue;
    }
    // Redact any configured secret from the upstream error text before echoing
    // it — the request's JWT carries CDP_API_KEY_ID as its issuer/subject, so a
    // "key <id> not found"-style upstream message could otherwise reflect it.
    const detail = redactSecrets(String(json?.errorMessage || json?.message || json?.errorType || res.statusText)).slice(0, 200);
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      if (buyerQuery) logFailedBuyerQuery(res.status, Date.now() - started, body?.sql);
      throw bad(`CDP rejected the request: ${detail}`, 422);
    }
    const tookMs = Date.now() - started;
    if (buyerQuery && res.status >= 500) {
      if ((res.status === 502 || res.status === 504) && tookMs >= slowQueryGatewayMs) {
        logFailedBuyerQuery(res.status, tookMs, body?.sql);
        // The query, or the service? Only a service that answers a
        // known-good query makes this the buyer's to narrow.
        if (await queryServiceHealthy(body?.sql)) throw narrowQueryError(res.status, tookMs, body?.sql, 422);
        throw bad(`CDP's query service is failing (HTTP ${res.status} after ${(tookMs / 1000).toFixed(1)} s, and a known-good query failed too); retry later. Nothing was charged.`, 502);
      }
      // An instant 500 is the result too large to send: never resent as is
      // (the handler re-runs it with a small row cap instead).
      if (res.status === 500) { logFailedBuyerQuery(res.status, tookMs, body?.sql); throw resultTooLargeError(res.status, tookMs); }
      // A 503 is the service being unavailable, not the query: retried, and
      // answered as an upstream error to retry, never "narrow it".
      lastErr = res.status === 503
        ? bad(`CDP upstream error (HTTP 503): the query service is unavailable; retry shortly. Nothing was charged.`, 502)
        : narrowQueryError(res.status, tookMs, body?.sql);
      if (attempt + 1 >= ATTEMPTS) { logFailedBuyerQuery(res.status, tookMs, body?.sql); throw lastErr; }
      continue;
    }
    lastErr = bad(`CDP upstream error (HTTP ${res.status}): ${detail}`, 502);
    if (res.status < 500) throw lastErr; // other non-5xx - not retryable
    // 5xx — fall through to retry
  }
  throw lastErr;
}

/** True when CDP credentials are configured (cdpSql/cdpFetch can run). Cheap
 *  pre-check so hot paths can fall back without triggering cdpFetch's 503 throw. */
export function cdpConfigured() { return !!(keyId() && keySecret()); }

/** Run a read-only ClickHouse SELECT over Coinbase's indexed, decoded chain data
 *  (base.events, base.transactions, …) and return the result rows as an array.
 *  Reuses cdpFetch (JWT + retry). Throws a 503 (via cdpFetch) when creds are unset
 *  and surfaces CDP's own 4xx on a bad query — callers in latency-sensitive paths
 *  should cdpConfigured()-gate and/or catch to fall back. `cacheSeconds` (≤900)
 *  sets CDP's server-side result cache. */
export async function cdpSql(sql, { cacheSeconds } = {}) {
  const body = { sql: String(sql) };
  if (Number.isFinite(cacheSeconds) && cacheSeconds > 0) {
    body.cache = { maxAgeMs: Math.min(Math.floor(cacheSeconds), 900) * 1000 };
  }
  const res = await cdpFetch("POST", "/platform/v2/data/query/run", body, { idempotent: true });
  const rows = res?.result ?? res?.rows ?? res?.data ?? res;
  return Array.isArray(rows) ? rows : [];
}

// Rows a buyer's query returns at most. The query service fails a result of
// a few megabytes (measured 2026-11-03: 2,000 solana.instructions rows, about
// 2 MB, returned; 5,000 failed; base.transactions failed from 5,000 to 10,000
// rows), so a plain SELECT is wrapped with an outer LIMIT one past the cap,
// which also says whether the result was cut.
export const SQL_MAX_ROWS = 1000;
// solana.instructions is pruned by block_time only: a query that filters,
// groups, orders or aggregates it without a block_time bound scans its whole
// history and never finishes inside the query service's ~10 s window
// (measured 2026-11-03: every such query, filtered to a single signer or
// account, to one block_slot, to a slot range or to one tx_id, a 502 at 10 s
// or the service's own scan-limit refusal; the same query over one day,
// seconds). It is refused before the call with what to add.
export function solanaRangeRefusal(sql) {
  const s = sqlNorm(sql);
  if (!/\bsolana\s*\.\s*instructions\b/i.test(s)) return null;
  // A clause that makes it scan, or an aggregate call other than a bare
  // count (answered from metadata at once, measured 0.2 s); countIf and the
  // other -If combinators read rows.
  const clause = /\b(where|prewhere|group\s+by|order\s+by|having|join|distinct|sample|limit\s+\d+\s+by)\b/i.test(s);
  const aggregate = /\b(?:countif|(?:sum|avg|min|max|uniq\w*|any\w*|arg(?:min|max)\w*|group\w*array\w*|quantile\w*|median\w*|top_?k\w*|stddev\w*|var(?:pop|samp)\w*|corr\w*|covar\w*)(?:if)?)\s*\(/i.test(s);
  if (!clause && !aggregate) return null;
  // A range is block_time in a comparison or BETWEEN, not the column named
  // elsewhere (selected, ordered by, or an alias).
  if (/\bblock_time\s*(?:>=?|<=?|=|between\b)|(?:>=?|<=?|=)\s*block_time\b/i.test(s)) return null;
  return 'A query on solana.instructions that filters, groups, orders or aggregates needs a block_time range: add, for example, WHERE block_time > now() - INTERVAL 1 DAY (a day answers in seconds; the full history does not finish within the query service\'s limit). Nothing was charged.';
}

// The query service reads at most 100 GB per query (its documented limit;
// its own refusal names about 93 GiB). What a solana.instructions query
// reads depends on its columns and filters, not its range alone (measured
// 2026-11-03: a week answered for an executing_account filter and was
// refused for a tx_signer filter; 14 and 30 days were refused; a day
// answered in seconds every time). So a ranged query is sent and judged by
// the service, and the answer to a refusal names the days it covered and a
// day as the range to start from.
const UNIT_DAYS = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, quarter: 91, year: 365 };
const RANGE_DAY_MS = 86_400_000;
// One side of a block_time comparison, as a time in ms, or null when it is a
// form this reader does not know (then no range is read: the safe direction).
function timeBoundMs(expr, now) {
  let e = String(expr || "").trim();
  // Drop only an outer pair of parentheses that wraps the whole expression.
  while (e.startsWith("(") && e.endsWith(")")) {
    let depth = 0, wraps = true;
    for (let i = 0; i < e.length - 1; i++) { if (e[i] === "(") depth++; else if (e[i] === ")") depth--; if (depth === 0) { wraps = false; break; } }
    if (!wraps) break;
    e = e.slice(1, -1).trim();
  }
  let m;
  if ((m = /^(?:now|today)\s*\(\s*\)$/i.exec(e))) return now;
  if ((m = /^(?:now|today)\s*\(\s*\)\s*-\s*interval\s+'?(\d+)'?\s*(second|minute|hour|day|week|month|quarter|year)s?$/i.exec(e))) return now - Number(m[1]) * UNIT_DAYS[m[2].toLowerCase()] * RANGE_DAY_MS;
  if ((m = /^today\s*\(\s*\)\s*-\s*(\d+)$/i.exec(e))) return now - Number(m[1]) * RANGE_DAY_MS;
  if ((m = /^subtract(seconds|minutes|hours|days|weeks|months|quarters|years)\s*\(\s*(?:now|today)\s*\(\s*\)\s*,\s*(\d+)\s*\)$/i.exec(e))) return now - Number(m[2]) * UNIT_DAYS[m[1].toLowerCase().replace(/s$/, "")] * RANGE_DAY_MS;
  if ((m = /^(?:to(?:date|datetime|datetime64)\s*\(\s*)?'(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?'/i.exec(e))) { const t = Date.parse(`${m[1]}T00:00:00Z`); return Number.isFinite(t) ? t : null; }
  return null;
}
/** The block_time span a query covers in days (named in a refusal), read from its block_time
 *  comparisons only (an INTERVAL elsewhere, a subquery on another table or a
 *  value in a comment is not a range), or null when it cannot be read. */
export function blockTimeRangeDays(sql, now = Date.now()) {
  const q = sqlNoComments(sql).replace(/[`"]/g, "");
  if (!/\bblock_time\b/i.test(q)) return null;
  // Any OR in the query: a bound may not narrow it, so no range is read.
  if (/\bor\b/i.test(sqlCode(sql))) return null;
  // Each piece is bounded in length, so the reads stay linear on a 10 KB query.
  const OPERAND = String.raw`('(?:[^'\\]|\\.){0,80}'|[^'()\s,]{1,60}(?:\s*\(\s*\)\s*-\s*interval\s+'?\d{1,9}'?\s*[a-z]{1,10}|\s{0,8}\((?:[^()]|\([^()]{0,80}\)){0,120}\))?(?:\s*-\s*\d{1,9})?|\((?:[^()]|\([^()]{0,80}\)){0,160}\))`;
  let lo = null, hi = null;
  const take = (which, v) => { if (v === null) return; if (which === "lo") lo = lo === null ? v : Math.max(lo, v); else hi = hi === null ? v : Math.min(hi, v); };
  // An operand must end where the expression ends: a longer expression this
  // reader does not know (now() - toIntervalDay(7)), or a lower bound
  // followed by OR (which does not narrow), is no bound at all.
  const END = String.raw`(?=\s*(?:$|\)|;|\b(?:and|group|order|limit|having|union|settings|format|prewhere)\b))`;
  for (const m of q.matchAll(new RegExp(String.raw`\bblock_time\s*(>=|<=|>|<)\s*` + OPERAND + "(?:" + END + "|(?<tail>))", "gi"))) {
    if (m.groups?.tail !== undefined) { if (m[1].startsWith(">")) return null; continue; }
    take(m[1].startsWith(">") ? "lo" : "hi", timeBoundMs(m[2], now));
  }
  for (const m of q.matchAll(new RegExp(OPERAND + String.raw`\s*(>=|<=|>|<)\s*block_time\b`, "gi"))) take(m[2].startsWith(">") ? "hi" : "lo", timeBoundMs(m[1], now));
  for (const m of q.matchAll(new RegExp(String.raw`\bblock_time\s+between\s+` + OPERAND + String.raw`\s+and\s+` + OPERAND, "gi"))) { take("lo", timeBoundMs(m[1], now)); take("hi", timeBoundMs(m[2], now)); }
  if (lo === null) return null;
  const days = ((hi === null ? now : hi) - lo) / RANGE_DAY_MS;
  return days >= 0 ? days : null; // reversed bounds: no readable range
}

/** Whether a query orders its own result: an ORDER BY outside every
 *  parenthesis (one inside a subquery orders only that subquery). */
export function hasOuterOrderBy(sql) {
  const s = sqlNorm(sql);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[oO]/.test(c) && /^order\s+by\b/i.test(s.slice(i, i + 12)) && (i === 0 || /\W/.test(s[i - 1]))) return true;
  }
  return false;
}

/** The query sent upstream: a plain SELECT wrapped with the row cap. A query
 *  opening with WITH, or carrying SETTINGS or FORMAT, cannot sit inside a
 *  subquery there and is sent as written. */
export function cappedSql(sql) {
  // A final `;` and any comments after it are dropped; the query sits on its
  // own lines inside the wrapper, so a trailing line comment ends before ")".
  const raw = String(sql || "").trim();
  // Read on the masked query (a `;` inside a string is not the end).
  const tail = /;[\s;]*$/.exec(sqlCode(raw));
  const s = (tail ? raw.slice(0, tail.index) : raw).trim();
  const code = sqlNorm(s);
  if (/^\s*with\b/i.test(code) || /\b(settings|format)\b/i.test(code)) return { sql: s, capped: false, inner: s };
  return { sql: `SELECT * FROM (\n${s}\n) LIMIT ${SQL_MAX_ROWS + 1}`, capped: true, inner: s };
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BALANCE_NETWORKS = new Set(["base", "ethereum", "base-sepolia", "solana", "solana-devnet"]);
const FAUCET_NETWORKS = new Set(["base-sepolia", "solana-devnet"]);
const FAUCET_TOKENS = { "base-sepolia": new Set(["usdc", "eth"]), "solana-devnet": new Set(["usdc", "sol"]) };
const ONRAMP_NETWORKS = new Set(["base", "ethereum", "polygon", "arbitrum", "optimism", "solana"]);

// Local faucet gate on top of CDP's own rolling-24h caps (1 USDC/request,
// 10 USDC/day per address AND per CDP account — the account cap is shared by
// everyone using this endpoint, so we spread it: 2 requests/address/day, 8
// total/day). In-memory on purpose: worst case a restart resets the local
// count and CDP's server-side caps still hold the line.
const faucetLog = { byAddress: new Map(), all: [] };
const DAY_MS = 24 * 60 * 60 * 1000;
export function faucetGate(address, now = Date.now()) {
  const prune = (arr) => arr.filter((t) => now - t < DAY_MS);
  faucetLog.all = prune(faucetLog.all);
  const forAddr = prune(faucetLog.byAddress.get(address) || []);
  faucetLog.byAddress.set(address, forAddr);
  if (forAddr.length >= 2) return { ok: false, reason: "This address already received 2 faucet drips in the last 24h. CDP also enforces its own per-address caps - try again tomorrow." };
  if (faucetLog.all.length >= 8) return { ok: false, reason: "The shared faucet budget for this service is exhausted for the next 24h (CDP caps faucet volume per account). Try again later." };
  forAddr.push(now);
  faucetLog.all.push(now);
  // A drip that did not happen gives its slot back.
  const release = () => {
    const a = faucetLog.byAddress.get(address);
    const i = a ? a.lastIndexOf(now) : -1;
    if (i >= 0) a.splice(i, 1);
    const j = faucetLog.all.lastIndexOf(now);
    if (j >= 0) faucetLog.all.splice(j, 1);
  };
  return { ok: true, release };
}

const SHARED_TAGS = ["wallet", "onboarding", "x402", "agent-wallet"];

export const CDP_TOOLS = [
  {
    route: "GET /api/wallet-balances",
    name: "Wallet token balances (indexed)",
    slug: "wallet-balances",
    category: "wallet",
    price: "$0.002",
    description:
      "All token balances for any address in one call, from an indexed chain-data API - ERC-20 + native on EVM, SPL on Solana; no per-token contract calls, no RPC wrangling. Networks: base, ethereum, base-sepolia, solana, solana-devnet. Symbols/decimals populated for whitelisted tokens (USDC always included).",
    tags: [...SHARED_TAGS, "balances", "erc-20", "spl", "base", "ethereum", "solana", "portfolio"],
    discovery: {
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Wallet address - EVM 0x… or Solana base58, matching the network" },
          network: { type: "string", description: "base (default) | ethereum | base-sepolia | solana | solana-devnet" },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
          network: "base",
          balances: [{ symbol: "USDC", name: "USD Coin", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "8.655", raw: "8655000", decimals: 6 }],
          count: 1,
        },
      },
    },
    handler: async (input) => {
      const address = String(input?.address || "").trim();
      const network = String(input?.network || "base").trim().toLowerCase();
      if (!BALANCE_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...BALANCE_NETWORKS].join(", ")}`);
      const isSolana = network.startsWith("solana");
      if (isSolana ? !SOL_ADDR_RE.test(address) : !EVM_ADDR_RE.test(address)) {
        throw bad(isSolana ? '"address" must be a Solana address (base58)' : '"address" must be an EVM address (0x + 40 hex chars)');
      }
      const res = await cdpFetch("GET", `/platform/v2/${isSolana ? "solana" : "evm"}/token-balances/${network}/${address}?pageSize=100`);
      const balances = (res?.balances || []).map((b) => {
        const decimals = b?.amount?.decimals;
        const raw = String(b?.amount?.amount ?? "0");
        const amount = Number.isFinite(decimals) ? (Number(raw) / 10 ** decimals).toString() : null;
        return {
          symbol: b?.token?.symbol ?? null,
          name: b?.token?.name ?? null,
          contract: b?.token?.contractAddress ?? b?.token?.mintAddress ?? null,
          amount, raw, decimals: decimals ?? null,
        };
      });
      return { address, network, balances, count: balances.length, ...(res?.nextPageToken ? { truncated: true } : {}) };
    },
  },
  {
    route: "POST /api/testnet-fund",
    name: "Testnet faucet (try x402 free)",
    slug: "testnet-fund",
    category: "wallet",
    price: "$0.001",
    description:
      "Fund any address with testnet money from a testnet faucet - USDC (1) or ETH (0.0001) on Base Sepolia, USDC (1) or SOL on Solana devnet - everything an agent needs to rehearse the complete x402 payment loop safely before moving real money. A tenth of a cent buys a full testnet dollar. Limits: 2 drips per address per day; the faucet enforces its own rolling caps on top.",
    tags: [...SHARED_TAGS, "faucet", "testnet", "base-sepolia", "solana-devnet", "getting-started"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", token: "usdc" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Address to fund - EVM 0x… or Solana base58, matching the network" },
          network: { type: "string", description: "base-sepolia (default) | solana-devnet" },
          token: { type: "string", description: "usdc (default, 1 USDC) | eth (0.0001, base-sepolia) | sol (solana-devnet)" },
        },
        required: ["address"],
      },
      output: {
        example: { funded: true, network: "base-sepolia", token: "usdc", transactionHash: "0xabc123…", explorer: "https://sepolia.basescan.org/tx/0xabc123…" },
      },
    },
    handler: async (input) => {
      const network = String(input?.network || "base-sepolia").trim().toLowerCase();
      if (!FAUCET_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...FAUCET_NETWORKS].join(", ")}`);
      const isSolana = network === "solana-devnet";
      const address = String(input?.address || "").trim();
      if (isSolana ? !SOL_ADDR_RE.test(address) : !EVM_ADDR_RE.test(address)) {
        throw bad(isSolana ? '"address" must be a Solana address (base58)' : '"address" must be an EVM address (0x + 40 hex chars)');
      }
      const token = String(input?.token || "usdc").trim().toLowerCase();
      if (!FAUCET_TOKENS[network].has(token)) throw bad(`"token" must be one of: ${[...FAUCET_TOKENS[network]].join(", ")} on ${network}`);
      const gate = faucetGate(isSolana ? address : address.toLowerCase());
      if (!gate.ok) throw bad(gate.reason, 429);
      let res;
      try {
        res = isSolana
          ? await cdpFetch("POST", "/platform/v2/solana/faucet", { address, token })
          : await cdpFetch("POST", "/platform/v2/evm/faucet", { address, network, token });
      } catch (e) {
        // A read that ended without an answer (its deadline, or a transport
        // failure after the request may have left) may still have dripped:
        // keep the slot. Any failure with an answer did not.
        if (!isUpstreamFailure(e)) gate.release();
        throw e;
      }
      const tx = res?.transactionHash || res?.transactionSignature || null;
      if (!tx) {
        gate.release();
        throw bad("The faucet did not return a transaction - retry shortly. Nothing was charged.", 502);
      }
      return {
        funded: true,
        network,
        token,
        transactionHash: tx,
        explorer: tx ? (isSolana ? `https://solscan.io/tx/${tx}?cluster=devnet` : `https://sepolia.basescan.org/tx/${tx}`) : null,
        note: isSolana
          ? "Devnet funds on Solana. Point your x402 SVM client at a solana-devnet seller (or run the open-source Agent402 server locally with a devnet config) to rehearse the payment loop."
          : "Testnet funds on Base Sepolia. Point your x402 client at a base-sepolia seller (or run the open-source Agent402 server locally with NETWORK=base-sepolia) to rehearse the full payment loop.",
      };
    },
  },
  {
    route: "POST /api/onramp-link",
    name: "Onramp link (fund a wallet with a card)",
    slug: "onramp-link",
    category: "wallet",
    price: "$0.001",
    description:
      "Generate a single-use hosted onramp URL that lets a human fund any wallet with a card or Apple Pay - the fastest way to put real USDC into an agent's wallet. Returns the ready-to-open URL, and a fee-inclusive quote when the onramp provides one. Networks: base, ethereum, polygon, arbitrum, optimism, solana.",
    tags: [...SHARED_TAGS, "onramp", "fiat", "usdc", "fund-wallet", "apple-pay"],
    discovery: {
      bodyType: "json",
      input: { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base", amount: "10" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Destination wallet address (EVM 0x… or Solana base58, matching the network)" },
          network: { type: "string", description: "base (default) | ethereum | polygon | arbitrum | optimism | solana" },
          asset: { type: "string", description: "Ticker to purchase (default USDC)" },
          amount: { type: "string", description: "Crypto amount the wallet should receive (default 10)" },
          country: { type: "string", description: "Buyer's ISO 3166-1 country code (default US)" },
          subdivision: { type: "string", description: "US state code (e.g. NY) - required for US buyers by some payment methods" },
          redirectUrl: { type: "string", description: "Optional URL to send the buyer to after checkout" },
        },
        required: ["address"],
      },
      output: {
        example: {
          onrampUrl: "https://pay.coinbase.com/…single-use…",
          singleUse: true,
          note: "Open the URL in a browser to complete the purchase - it is single-use and expires after first visit.",
        },
        // `quote` ({paymentTotal, paymentSubtotal, paymentCurrency, purchaseAmount,
        // purchaseCurrency, destinationNetwork, exchangeRate}) rides alongside
        // WHEN Coinbase returns one. It is deliberately not in the example: it
        // is not always there, and an example is read as a promise.
      },
    },
    handler: async (input) => {
      const address = String(input?.address || "").trim();
      if (!address || address.length < 26 || address.length > 64) throw bad('"address" must be a wallet address on the chosen network');
      const network = String(input?.network || "base").trim().toLowerCase();
      if (!ONRAMP_NETWORKS.has(network)) throw bad(`"network" must be one of: ${[...ONRAMP_NETWORKS].join(", ")}`);
      if (network !== "solana" && !EVM_ADDR_RE.test(address)) throw bad(`"address" must be an EVM address (0x + 40 hex) for network ${network}`);
      const asset = String(input?.asset || "USDC").trim().toUpperCase().slice(0, 12);
      const amount = String(input?.amount || "10").trim();
      if (!/^\d{1,7}(\.\d{1,6})?$/.test(amount)) throw bad('"amount" must be a positive decimal string (e.g. "10")');
      const country = String(input?.country || "US").trim().toUpperCase().slice(0, 2);
      const body = {
        purchaseCurrency: asset,
        destinationNetwork: network,
        destinationAddress: address,
        purchaseAmount: amount,
        country,
      };
      if (input?.subdivision) body.subdivision = String(input.subdivision).trim().toUpperCase().slice(0, 2);
      if (input?.redirectUrl) {
        const r = String(input.redirectUrl).trim();
        if (!/^https:\/\/[^\s]{1,300}$/.test(r)) throw bad('"redirectUrl" must be an https URL');
        body.redirectUrl = r;
      }
      const res = await cdpFetch("POST", "/platform/v2/onramp/sessions", body);
      const url = res?.session?.onrampUrl || null;
      if (!url) throw bad("CDP did not return an onramp URL", 502);
      return {
        onrampUrl: url,
        singleUse: true,
        ...(res?.quote ? { quote: {
          paymentTotal: res.quote.paymentTotal,
          paymentSubtotal: res.quote.paymentSubtotal,
          paymentCurrency: res.quote.paymentCurrency,
          purchaseAmount: res.quote.purchaseAmount,
          purchaseCurrency: res.quote.purchaseCurrency,
          destinationNetwork: res.quote.destinationNetwork,
          exchangeRate: res.quote.exchangeRate,
        } } : {}),
        note: "Open the URL in a browser to complete the purchase - it is single-use and expires after first visit.",
      };
    },
  },
  {
    route: "POST /api/onchain-sql",
    name: "Onchain SQL (query Base with SQL)",
    slug: "onchain-sql",
    category: "wallet",
    price: "$0.020",
    description:
      "Run read-only SQL against indexed, DECODED blockchain data - base.events (decoded logs with parameters), base.transactions, base.blocks, base.decoded_user_operations, base.transaction_attributions (builder codes), plus solana.instructions (filter it by block_time). ClickHouse-dialect SELECTs, server-side grammar validation, up to 1,000 rows per call (a larger result is cut at 1,000 and says so). Ask Base anything - token flows, event analytics, gas studies - in one call, no indexer to run.",
    tags: [...SHARED_TAGS, "sql", "analytics", "onchain-data", "base", "events", "clickhouse", "data-science"],
    discovery: {
      bodyType: "json",
      input: { sql: "SELECT COUNT(*) AS txs FROM base.transactions WHERE block_number > 0 LIMIT 1" },
      inputSchema: {
        properties: {
          sql: { type: "string", description: "Read-only SELECT (ClickHouse dialect, max 10,000 chars). Tables: base.events, base.transactions, base.blocks, base.encoded_logs, base.decoded_user_operations, base.transaction_attributions, base_sepolia.*, solana.instructions (a query that filters, groups or aggregates it needs a block_time range; a day answers in seconds, and a longer range may read past the query service's 100 GB per-query limit). Returns up to 1,000 rows; a larger result is cut and marked truncated." },
          cacheSeconds: { type: "number", description: "Accept cached results up to this old (max 900). Cheaper + faster for repeated analytics." },
        },
        required: ["sql"],
      },
      output: {
        example: { rows: [{ txs: 123456 }], rowCount: 1, maxRows: 1000, returned: 1, matched: 1, complete: true, truncated: false },
      },
    },
    handler: async (input) => {
      const sql = String(input?.sql || "").trim();
      if (!sql) throw bad('"sql" is required');
      if (sql.length > 10_000) throw bad(`"sql" too long (${sql.length} chars, max 10,000)`);
      if (!/^\s*(select|with)\b/i.test(sqlNorm(sql))) throw bad('"sql" must be a read-only SELECT (or WITH … SELECT) statement');
      const unbounded = solanaRangeRefusal(sql);
      if (unbounded) { const e = bad(unbounded); e.hint = "add-block-time"; throw e; }
      const body = { sql };
      const cacheSeconds = Number(input?.cacheSeconds);
      if (Number.isFinite(cacheSeconds) && cacheSeconds > 0) {
        body.cache = { maxAgeMs: Math.min(Math.floor(cacheSeconds), 900) * 1000 };
      }
      const capped = cappedSql(sql);
      body.sql = capped.sql;
      if (buyerQueriesInflight >= BUYER_QUERY_INFLIGHT_MAX) {
        const e = bad(`The query service is answering ${BUYER_QUERY_INFLIGHT_MAX} queries from this server already; retry in a few seconds. Nothing was charged.`, 429);
        e.retryAfter = 5; e.hint = "busy"; e.shed = true; // a capacity refusal, not a tool failure
        throw e;
      }
      buyerQueriesInflight++;
      let res;
      try {
        try { res = await cdpFetch("POST", "/platform/v2/data/query/run", body, { idempotent: true, buyerQuery: true }); }
        catch (e) {
          if (!(e?.resultTooLarge && capped.capped)) throw e;
          // The result was too large to send: the same query again with a
          // small outer row cap (two attempts, since a small result of this
          // kind still fails now and then), served marked truncated, with
          // the row size measured so the caller can pick a LIMIT.
          const small = { ...body, sql: `SELECT * FROM (\n${capped.inner}\n) LIMIT ${SQL_RECOVER_ROWS}` };
          let res2 = null;
          for (let tryN = 1; tryN <= SQL_RECOVER_ATTEMPTS; tryN++) {
            try { res2 = await cdpFetch("POST", "/platform/v2/data/query/run", small, { idempotent: true, buyerQuery: true, attempts: 1 }); break; }
            catch (e2) {
              if (!e2?.resultTooLarge) throw e2;
              if (tryN < SQL_RECOVER_ATTEMPTS) continue;
              const text = `Even ${SQL_RECOVER_ROWS} rows of this query could not be sent by the query service, ${SQL_RECOVER_ATTEMPTS} times (it answers its internal error, HTTP ${e2.cdpStatus}; an answer under about ${Math.round(SQL_SEND_LIMIT_BYTES / 1e3)} KB is usually sent): select fewer or narrower columns (map and array columns are the usual cause). Nothing was charged.`;
              if (await queryServiceHealthy(sql)) { const e3 = bad(text, 422); e3.hint = "narrow-query"; throw e3; }
              throw bad(`CDP's query service is failing (HTTP ${e2.cdpStatus} on this query and on a known-good query); retry later. Nothing was charged.`, 502);
            }
          }
          const got = res2?.result ?? res2?.rows ?? res2?.data ?? res2;
          if (!Array.isArray(got)) throw bad("CDP upstream error: the query service answered without a result list. Nothing was charged.", 502);
          // Fewer rows than the cap: that is the whole result, so the 500 was
          // not its size; served as a complete answer.
          if (got.length < SQL_RECOVER_ROWS) { res = res2; }
          else {
            const list = got;
            const rowBytes = Math.round(Buffer.byteLength(JSON.stringify(list), "utf8") / list.length);
            // Rows this small cannot have made the whole result too large:
            // the 500 was a one-off, so the original is sent once more.
            if (rowBytes * (SQL_MAX_ROWS + 1) < SQL_SEND_LIMIT_BYTES / 2) {
              try { res = await cdpFetch("POST", "/platform/v2/data/query/run", body, { idempotent: true, buyerQuery: true, attempts: 1 }); }
              catch (e3) { if (!e3?.resultTooLarge) throw e3; res = null; }
            }
            if (!res) {
              const fits = Math.max(1, Math.floor(SQL_SEND_LIMIT_BYTES / rowBytes));
              const ordered = hasOuterOrderBy(capped.inner);
              return {
                rows: list, rowCount: list.length, maxRows: SQL_RECOVER_ROWS, recovered: "result-size", rowBytes,
                ...partialFields(list.length, list.length), complete: false, truncated: true, matchedIsLowerBound: true,
                note: `The full result was too large for the query service to send (it answers its internal error; an answer under about ${Math.round(SQL_SEND_LIMIT_BYTES / 1e3)} KB is usually sent), so the query was run again with LIMIT ${SQL_RECOVER_ROWS} and these are ${ordered ? "its first" : "an arbitrary"} ${list.length} rows${ordered ? "" : " (it has no ORDER BY)"}. A row of this result is about ${Math.max(1, Math.round(rowBytes / 1024))} KB, so a LIMIT of ${Math.min(fits, SQL_MAX_ROWS)} usually keeps an answer under about ${Math.round(SQL_SEND_LIMIT_BYTES / 1e3)} KB: set that, or select fewer or narrower columns, and page with an ORDER BY and OFFSET.`,
              };
            }
          }
        }
      } finally { buyerQueriesInflight--; }
      const rows = res?.result ?? res?.rows ?? res?.data ?? res;
      const all = Array.isArray(rows) ? rows : [];
      const list = all.length > SQL_MAX_ROWS ? all.slice(0, SQL_MAX_ROWS) : all;
      const cut = all.length > list.length;
      return {
        rows: list, rowCount: list.length, maxRows: SQL_MAX_ROWS,
        ...partialFields(all.length, list.length),
        ...(cut ? { ...(capped.capped ? { matchedIsLowerBound: true } : {}), note: `More than ${SQL_MAX_ROWS} rows matched; the first ${SQL_MAX_ROWS} are returned. Add ORDER BY with a LIMIT, a block_number range or an aggregate to get the rows you need.` } : {}),
        ...(capped.capped ? {} : { rowCapApplied: false }),
        ...(Array.isArray(rows) ? {} : { raw: res }),
      };
    },
  },
  {
    route: "GET /api/onchain-sql-schema",
    name: "Onchain SQL schema",
    slug: "onchain-sql-schema",
    category: "wallet",
    price: "$0.002",
    description:
      "The table + column schema for the onchain-sql tool - every queryable table (base.events, base.transactions, base.blocks, base.decoded_user_operations, base.transaction_attributions, solana.instructions, …) with its columns and types. Fetch once, then write SQL with confidence.",
    tags: [...SHARED_TAGS, "sql", "schema", "onchain-data", "reference"],
    discovery: {
      input: {},
      inputSchema: { properties: {}, required: [] },
      output: { example: { schema: { "base.events": [{ name: "block_number", type: "UInt64" }] } } },
    },
    handler: async () => {
      const res = await cdpFetch("GET", "/platform/v2/data/query/schema");
      return { schema: res };
    },
  },
];

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(CDP_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
