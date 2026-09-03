// Skill runner — bundled execution of skill packs.
//
// Each pack registers a POST /api/skill/<slug> endpoint at a single bundled
// price (see PACK_PRICES below). The handler orchestrates the pack's tool
// calls in-process and returns a partial-success envelope:
//
//   {
//     pack: <slug>,
//     args: { ...packArgs },
//     steps: [ { slug, ok, result|error, statusCode } ],
//     summary: "N/M steps succeeded"
//   }
//
// Partial-success: any step can fail without aborting the bundle. The top-level
// response is always 200 with a per-step success flag. The agent gets every
// step that succeeded for one x402 payment instead of paying per-tool today.
//
// Modes:
//   "fanout" — every step's input is derived from the pack args only. Runs in
//              parallel (Promise.all).
//   "chain"  — step N's mapInput receives both the pack args and a `prior`
//              dictionary of every previously-completed step's result. Runs
//              sequentially.
//
// Pricing tiers (see audit-packs.mjs findings):
//   premium  ($0.65–$1.50)  paid-upstream heavy (Alchemy/EDGAR/FRED/Brave)
//   standard ($0.06–$0.30)  network/render mix
//   light    ($0.05 floor)  pure-CPU bundles, PoW-eligible
//
import { SKILL_PACKS, PACK_PRICES } from "../skills.js";
import { safeFetch } from "./fetch-guard.js";
import { capturePostHogPackStep } from "../posthog.js";

// Cap for the media-pipeline URL→base64 bridge below. Must route through
// safeFetch (SSRF guard + size cap), never raw fetch — the URL is caller-supplied.
const MAX_FETCH_BASE64_BYTES = 25 * 1024 * 1024;

// Annualized realized volatility from a stock-history bar series: stddev of
// daily log returns x sqrt(252). Used by the options pack to give
// black-scholes a sigma grounded in the stock's own recent history rather
// than a hardcoded guess. Throws (-> clean per-step partial failure) rather
// than returning NaN, because a NaN sigma produces a confident-looking
// option price that is meaningless.
function realizedVolatility(bars) {
  const closes = (Array.isArray(bars) ? bars : [])
    .map((b) => Number(b?.close))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 20) {
    throw Object.assign(
      new Error(`not enough price history to estimate volatility (need 20 closes, got ${closes.length})`),
      { statusCode: 422 }
    );
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  if (!Number.isFinite(vol) || vol <= 0) {
    throw Object.assign(new Error("could not compute a usable volatility from the price history"), { statusCode: 422 });
  }
  return Math.round(vol * 10000) / 10000;
}

// A prior step's number, or a clean failure naming what was missing. Chained
// steps that silently coerce a missing input to NaN produce a plausible-looking
// answer built on nothing, which is worse than a failed step.
function requireNumber(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${what} was not available from the previous step`), { statusCode: 424 });
  }
  return n;
}

// Sentinel error thrown by stub mapInput functions. The runner converts it to
// a per-step partial-failure {ok:false, statusCode:501} so the rest of the
// pack still runs and the envelope shape stays consistent. Reachable only
// for any pack added to SKILL_PACKS without a corresponding PACK_STEPS entry.
function todoError() {
  return Object.assign(new Error("mapInput not yet implemented for this step"), {
    statusCode: 501,
  });
}
const TODO_MAPINPUT = () => { throw todoError(); };

// Default fallback mapper: tries to match pack args to tool input schema keys
// using common synonyms. Useful for fanout packs where one pack arg (domain,
// url, ticker, coin) maps cleanly to each tool's input.
//
// Returns a possibly-incomplete input object — if a required tool field isn't
// matchable, the tool will surface a 400 which becomes a partial-failure step
// in the envelope. That's intentional: surface the gap rather than guess.
export function defaultMapInput(args, tool) {
  const schema = tool?.discovery?.inputSchema?.properties || {};
  const out = {};
  for (const key of Object.keys(schema)) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  // Synonyms — only fill when the schema actually exposes the key.
  if (args.domain) {
    if ("name" in schema && out.name === undefined) out.name = args.domain;
    if ("host" in schema && out.host === undefined) out.host = args.domain;
    if ("url" in schema && out.url === undefined) out.url = `https://${args.domain}`;
  }
  if (args.url) {
    if ("target" in schema && out.target === undefined) out.target = args.url;
  }
  if (args.ticker) {
    if ("symbol" in schema && out.symbol === undefined) out.symbol = args.ticker;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Pricing registry. Derived from the audit-packs.mjs finding (sum-of-tools
// per pack) × tier multiplier:
//   premium 8x (paid-upstream heavy)
//   standard 5x (network/render mix)
//   light $0.05 floor (pure-CPU, PoW-eligible — all underlying tools wallet-free)
// Round to clean USD-cent values.
// ──────────────────────────────────────────────────────────────────────────
// PACK_PRICES moved to src/skills.js so the pack data and its PRICE live in
// one module. rankSkillPacks() needs the price to tell a buyer what the
// one-call purchase costs, and skills.js cannot import from tools/ without a
// cycle (this file already imports SKILL_PACKS from there). Re-exported here
// because ledger-home.js and landing.js import it from this path.
export { PACK_PRICES };

// ──────────────────────────────────────────────────────────────────────────
// Parsers for natural-language pack args.
//
// The finance packs (loan-comparison, investment-decision, retirement-planning,
// savings-goal) accept free-form strings like "$300,000 at 6.5% for 30 years"
// from the prompt — the underlying finance-math tools take structured numeric
// inputs. parseLoanString and friends pull dollars/percent/years out of the
// string with regex. Any field they can't extract returns NaN and surfaces as
// a clean per-step partial-failure in the envelope (the tool will reject
// NaN with a 400); the agent learns which field the parser missed.
// ──────────────────────────────────────────────────────────────────────────

function _firstNumber(re, s) {
  const m = String(s ?? "").match(re);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

// "$300,000 at 6.5% for 30 years" → { principal, annualRate, termYears }
function parseLoanString(s) {
  return {
    principal: _firstNumber(/\$\s*([\d,]+(?:\.\d+)?)/, s),
    annualRate: _firstNumber(/(\d+(?:\.\d+)?)\s*%/, s) / 100,
    termYears: _firstNumber(/(\d+(?:\.\d+)?)\s*y(?:ea)?r/i, s),
  };
}

// "$500,000 ... returning $150,000/year for 5 years" → { upfront, annualReturn, years }
function parseProjectString(s) {
  const dollars = [...String(s ?? "").matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, "")));
  return {
    upfront: dollars[0] ?? NaN,
    annualReturn: dollars[1] ?? NaN,
    years: _firstNumber(/(\d+(?:\.\d+)?)\s*y(?:ea)?r/i, s),
  };
}

// "35 years old with $100,000 saved, contributing $1,500/month, retiring at 65"
// → { currentAge, savings, monthlyContrib, retireAge, yearsToRetirement }
function parseRetirementScenario(s) {
  const str = String(s ?? "");
  const dollars = [...str.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, "")));
  const currentAge = _firstNumber(/(\d+)\s*y(?:ea)?rs?\s*old/i, str);
  const retireAge  = _firstNumber(/retir\w*\s+at\s+(\d+)/i, str);
  return {
    currentAge,
    savings: dollars[0] ?? NaN,
    monthlyContrib: dollars[1] ?? NaN,
    retireAge,
    yearsToRetirement: Number.isFinite(retireAge) && Number.isFinite(currentAge)
      ? retireAge - currentAge
      : NaN,
  };
}

// "save $1,000,000 for retirement in 30 years" → { target, years }
function parseGoalString(s) {
  return {
    target: _firstNumber(/\$\s*([\d,]+(?:\.\d+)?)/, s),
    years: _firstNumber(/(\d+(?:\.\d+)?)\s*y(?:ea)?r/i, s),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-pack step configuration.
//
//   { mode: "fanout"|"chain", steps: [ { slug, mapInput(args, prior) → input } ] }
//
// All 39 packs have explicit entries. Any pack added to SKILL_PACKS without
// a matching PACK_STEPS entry falls back to the auto-stub in getStepConfig
// (every step returns 501 — the envelope is still well-formed).
// ──────────────────────────────────────────────────────────────────────────
export const PACK_STEPS = {
  // ▼ Example 1: simple fanout. All tools key off one prompt arg (domain).
  "security-audit": {
    mode: "fanout",
    steps: [
      { slug: "cert-transparency", mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dns-lookup",        mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "spf-check",         mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dmarc-check",       mapInput: (a) => ({ domain: a.domain }) },
      { slug: "http-headers",      mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "tls-cert",          mapInput: (a) => ({ host: a.domain }) },
      { slug: "tech-stack",        mapInput: (a) => ({ url: `https://${a.domain}` }) },
    ],
  },

  // ▼ Example 2: chained workflow. Each step reads prior step's result.
  // Demonstrates: prior['<slug>'].field access, default for missing data.
  "trend-analysis": {
    mode: "chain",
    steps: [
      // Equity ticker: fetch OHLCV (range from horizon arg if provided).
      // Yahoo bars come back as [{time,open,high,low,close,volume}].
      { slug: "stock-history", mapInput: (a) => ({ symbol: a.series, range: a.horizon || "1y" }) },
      // Macro indicator: the workflow's own "for a FRED series id" branch,
      // advertised in toolSlugs and never run until 2026-09-02. Runs ONLY
      // when stock-history served nothing (a FRED id is not a ticker), so an
      // equity run does not pay for a leg that cannot apply.
      { slug: "fred-series", when: (_a, p) => !((p["stock-history"]?.bars ?? []).length), skipReason: "series was served as an equity ticker by stock-history",
        mapInput: (a) => ({ seriesId: a.series }) },
      // Every downstream step reads the values from whichever fetcher served.
      { slug: "stats-summary",   mapInput: (_a, p) => ({ values: bakeOffValues(p) }) },
      { slug: "moving-average",  mapInput: (_a, p) => ({ values: bakeOffValues(p), window: 20, which: "both" }) },
      { slug: "linear-regression", mapInput: (_a, p) => {
          const v = bakeOffValues(p);
          return { x: v.map((_, i) => i), y: v };
      } },
      { slug: "outliers",        mapInput: (_a, p) => ({ values: bakeOffValues(p) }) },
      { slug: "correlation",     mapInput: (_a, p) => { const v = bakeOffValues(p); return { x: v, y: v }; } },
      { slug: "forecast-eval",   mapInput: (_a, p) => {
          const v = bakeOffValues(p);
          const testSize = Math.max(5, Math.floor(v.length / 10));
          return { values: v, testSize, method: "drift" };
      } },
    ],
  },

  // Crypto market brief: lightweight 3-tool fanout for a quick market snapshot.
  "market-brief": {
    mode: "fanout",
    steps: [
      { slug: "crypto-price",    mapInput: (a) => ({ coins: a.coin, currency: "usd" }) },
      { slug: "crypto-trending", mapInput: () => ({}) },
      { slug: "crypto-global",   mapInput: () => ({ currency: "usd" }) },
    ],
  },

  // Financial analysis: lightweight 3-tool fanout for a quick company snapshot.
  "financial-analysis": {
    mode: "fanout",
    steps: [
      { slug: "stock-quote",         mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "company-financials",  mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "earnings-calendar",   mapInput: (a) => ({ symbol: a.ticker }) },
    ],
  },

  // ▼ Example 3: premium fanout. Multiple paid-upstream tools, shared input.
  "financial-research": {
    mode: "fanout",
    steps: [
      { slug: "stock-quote",         mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "stock-history",       mapInput: (a) => ({ symbol: a.ticker, range: "1y" }) },
      { slug: "edgar-filings",       mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "edgar-company-facts", mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "edgar-insider-trades", mapInput: (a) => ({ ticker: a.ticker, lookbackDays: 90 }) },
      // FRED needs an explicit series id - fed funds is the default macro
      // signal. The key is `seriesId`; this sent `series`, so the step 400'd
      // on every call (2 of 2 in 60 days of telemetry).
      { slug: "fred-series",         mapInput: () => ({ seriesId: "FEDFUNDS" }) },
      { slug: "research-company",    mapInput: (a) => ({ ticker: a.ticker }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Light tier entries (pure-CPU, PoW-eligible). All fanout — every step
  // derives input from pack args alone (no dependency on prior step output).
  // ──────────────────────────────────────────────────────────────────────

  // Clean up a free-form text blob: stats, entities, redaction, dedupe, sort,
  // keywords, readability. All steps independently consume the same `text`.
  "text-hygiene": {
    mode: "fanout",
    steps: [
      { slug: "text-stats",        mapInput: (a) => ({ text: a.text }) },
      { slug: "redact",            mapInput: (a) => ({ text: a.text }) },
      { slug: "dedupe-lines",      mapInput: (a) => ({ text: a.text }) },
      { slug: "sort-lines",        mapInput: (a) => ({ text: a.text, order: "asc" }) },
      { slug: "extract-entities",  mapInput: (a) => ({ text: a.text }) },
      { slug: "keywords",          mapInput: (a) => ({ text: a.text, limit: 10 }) },
      { slug: "readability",       mapInput: (a) => ({ text: a.text }) },
    ],
  },

  // Throw every common decoder at an unknown blob — whichever one parses wins.
  // Partial-success is doing real work here: jwt-decode/gunzip/etc. fail loudly
  // on the wrong format, but base64/hex/hash always return something useful as
  // a fingerprint. The agent picks the one with a sensible result.
  "decode-blob": {
    mode: "fanout",
    steps: [
      { slug: "jwt-decode",        mapInput: (a) => ({ token: a.blob }) },
      { slug: "gunzip",            mapInput: (a) => ({ input: a.blob, outputFormat: "utf8" }) },
      { slug: "brotli-decompress", mapInput: (a) => ({ input: a.blob, outputFormat: "utf8" }) },
      { slug: "base64",            mapInput: (a) => ({ text: a.blob, mode: "decode" }) },
      { slug: "hex",               mapInput: (a) => ({ text: a.blob, mode: "decode" }) },
      { slug: "json-format",       mapInput: (a) => ({ json: a.blob, indent: 2 }) },
      { slug: "hash",              mapInput: (a) => ({ text: a.blob, algo: "sha256" }) },
    ],
  },

  // Forge a fresh user identity in one call: stable UUIDs (random + email-derived),
  // a URL-safe handle, a strong password, an email hash for indexing, a signed
  // JWT, and a display-name token. All steps key off displayName/email/secret.
  "identity-mint": {
    mode: "fanout",
    steps: [
      { slug: "uuid",       mapInput: ()  => ({ version: "7", count: "1" }) },
      { slug: "uuid-v5",    mapInput: (a) => ({ namespace: "url", name: `mailto:${a.email}` }) },
      { slug: "slugify",    mapInput: (a) => ({ text: a.displayName }) },
      { slug: "password",   mapInput: ()  => ({ length: "24", symbols: "true", count: "1" }) },
      { slug: "hash",       mapInput: (a) => ({ text: a.email.toLowerCase().trim(), algo: "sha256" }) },
      { slug: "jwt-sign",   mapInput: (a) => ({
          payload: { sub: a.email, name: a.displayName, iat: Math.floor(Date.now() / 1000) },
          secret: a.signingSecret,
          alg: "HS256",
      }) },
      { slug: "base64",     mapInput: (a) => ({ text: a.displayName, mode: "encode" }) },
    ],
  },

  // Validate the seven prerequisites of a sign-up form: email shape, password
  // entropy, a freshly minted user UUID, a URL slug, a salted password hash,
  // an email fingerprint, and a TOTP check. Catches weak passwords, malformed
  // emails, and bad TOTP codes in one pass.
  "user-onboarding": {
    mode: "fanout",
    steps: [
      { slug: "email-validate",    mapInput: (a) => ({ email: a.email }) },
      { slug: "password-strength", mapInput: (a) => ({ password: a.password }) },
      { slug: "uuid",              mapInput: ()  => ({ version: "7", count: "1" }) },
      { slug: "slugify",           mapInput: (a) => ({ text: a.displayName }) },
      // password tool generates; we use `hash` to derive a deterministic stored
      // representation of the *submitted* password instead. Real systems should
      // also salt; this is a fingerprint for change-detection, not auth storage.
      { slug: "password",          mapInput: ()  => ({ length: "32", symbols: "true", count: "1" }) },
      { slug: "hash",              mapInput: (a) => ({ text: a.password, algo: "sha256" }) },
      { slug: "totp",              mapInput: (a) => ({ secret: a.totpSecret }) },
    ],
  },

  // Prep a document for RAG ingestion: count tokens, chunk with overlap,
  // extract entities + keywords, then express the chunks as JSONL and
  // sanity-check against a minimal schema. All steps consume the same `doc`.
  "rag-prep": {
    mode: "fanout",
    steps: [
      { slug: "text-stats",       mapInput: (a) => ({ text: a.doc }) },
      { slug: "token-count",      mapInput: (a) => ({ text: a.doc, model: "gpt-4o" }) },
      { slug: "text-chunk",       mapInput: (a) => ({ text: a.doc, size: 800, overlap: 100, unit: "chars" }) },
      { slug: "extract-entities", mapInput: (a) => ({ text: a.doc }) },
      { slug: "keywords",         mapInput: (a) => ({ text: a.doc, limit: 15 }) },
      { slug: "jsonl",            mapInput: (a) => ({ data: [{ doc: a.doc }], mode: "to-jsonl" }) },
      { slug: "json-validate",    mapInput: (a) => ({
          data: { doc: a.doc },
          schema: { type: "object", required: ["doc"], properties: { doc: { type: "string", minLength: 1 } } },
      }) },
    ],
  },

  // The classic "is this JWT valid?" workflow: decode (without verifying — you
  // need the alg to decide which verification path to take), render exp/iat in
  // human time, compute time-to-expiry, then HMAC-verify against the supplied
  // secret. base64+hash are long-tail follow-ups (custom-claim decoding, SHA
  // fingerprints). Chain mode so time-convert/date-diff can read the decoded
  // payload's exp claim from prior["jwt-decode"].
  "jwt-forensics": {
    mode: "chain",
    steps: [
      { slug: "jwt-decode",   mapInput: (a) => ({ token: a.token }) },
      // Render exp claim as ISO/local; fall back to "now" if exp is missing so
      // the step doesn't fail on tokens without an expiry (rare but valid).
      { slug: "time-convert", mapInput: (_a, p) => ({ value: p["jwt-decode"]?.payload?.exp ?? "now" }) },
      // Time-to-expiry — negative for expired tokens, positive for live ones.
      { slug: "date-diff",    mapInput: (_a, p) => {
          const exp = p["jwt-decode"]?.payload?.exp;
          return { from: "now", to: exp ? Number(exp) : "now" };
      } },
      // The conclusive answer for HMAC-signed tokens. Non-HMAC algs (RS256
      // etc.) fail by design — that failure surfaces as a partial-failure step.
      { slug: "jwt-verify",   mapInput: (a) => ({ token: a.token, secret: a.secret }) },
      // Decode the header segment as a fingerprint — catches tokens with
      // base64-encoded custom claims in the header.
      { slug: "base64",       mapInput: (a) => ({ text: (a.token.split(".")[0] || ""), mode: "decode" }) },
      // sha256 fingerprint of the full token — useful for log correlation and
      // detecting reuse without leaking the token itself.
      { slug: "hash",         mapInput: (a) => ({ text: a.token, algo: "sha256" }) },
    ],
  },

  // Inbound-webhook triage: pretty-print, decode any JWT auth header (will
  // fail loudly on plain JSON bodies — that's the design signal that the
  // body itself isn't a token), HMAC-verify the body against the shared
  // secret, schema-check the parsed payload, translate the event timestamp,
  // redact PII before logging, and index entities. Chain mode so json-validate
  // / time-convert / redact / extract-entities all read the parsed body from
  // prior["json-format"].parsed instead of re-parsing per step.
  "webhook-debug": {
    mode: "chain",
    steps: [
      { slug: "json-format",     mapInput: (a) => ({ json: a.rawBody, indent: 2 }) },
      // Try the body as a JWT — expected to fail for JSON webhooks. The
      // failure itself tells the agent "no JWT auth header embedded".
      { slug: "jwt-decode",      mapInput: (a) => ({ token: a.rawBody }) },
      // Compute the expected signature so the agent can compare against the
      // provider's X-Hub-Signature-256 / Stripe-Signature / etc. The tool
      // returns both hex and base64 so the agent picks the right one.
      { slug: "hmac",            mapInput: (a) => ({ text: a.rawBody, key: a.signingSecret, algo: "sha256" }) },
      // Minimal envelope schema — every webhook of this shape has id+type.
      // Replace with a provider-specific schema in your own integration.
      // json-format returns {valid, formatted} only, so parse rawBody locally
      // for the actual payload. Try/catch keeps a malformed body from killing
      // the whole step before json-validate gets to surface the schema gap.
      { slug: "json-validate",   mapInput: (a) => {
          let data = {};
          try { data = JSON.parse(a.rawBody); } catch {}
          return {
            data,
            schema: { type: "object", required: ["id", "type"], properties: {
                id:      { type: "string" },
                type:    { type: "string" },
                created: { type: "integer" },
            } },
          };
      } },
      // Render the event timestamp (Stripe-style epoch seconds) as ISO + local.
      // Defaults to "now" if no created field — keeps the step from failing.
      { slug: "time-convert",    mapInput: (a) => {
          let created;
          try { created = JSON.parse(a.rawBody)?.created; } catch {}
          return { value: created ?? "now" };
      } },
      { slug: "redact",          mapInput: (a) => ({ text: a.rawBody }) },
      { slug: "extract-entities", mapInput: (a) => ({ text: a.rawBody }) },
    ],
  },

  // Production webhook ingest — distinct job from webhook-debug: that pack
  // diagnoses a failing signature; this one is the hot-path gate that runs on
  // EVERY incoming event. Verify FIRST (per-provider scheme, constant-time
  // compare, replay tolerance for Stripe/Slack), then treat the body as
  // trusted: per-provider envelope schema check (catches API-version drift),
  // sha256 fingerprint of the raw bytes (dedup key for at-least-once
  // redeliveries / Idempotency-Key reuse), event-time normalization to
  // UTC + epoch, and PII redaction before the event is logged. Chain mode so
  // the envelope reads top-to-bottom as the ingest pipeline — the verify
  // verdict rides in steps[0] and the agent gates on it.
  "webhook-intake": {
    mode: "chain",
    steps: [
      { slug: "webhook-verify", mapInput: (a) => {
          const input = { provider: a.provider, payload: a.rawBody, secret: a.secret, signature: a.signature };
          if (a.timestamp !== undefined && a.timestamp !== null && a.timestamp !== "") input.timestamp = a.timestamp;
          return input;
      } },
      // Minimal per-provider envelope schemas — enough to catch top-level
      // API-version drift without pinning event-specific shapes. Swap in an
      // event-type-specific schema in your own integration.
      { slug: "json-validate", mapInput: (a) => {
          let data = {};
          try { data = JSON.parse(a.rawBody); } catch {}
          const envelopes = {
            github:  { type: "object", required: ["repository"], properties: { repository: { type: "object" }, ref: { type: "string" } } },
            stripe:  { type: "object", required: ["id", "type", "created"], properties: { id: { type: "string" }, type: { type: "string" }, created: { type: "integer" } } },
            shopify: { type: "object", required: ["id"], properties: {} },
            slack:   { type: "object", required: ["type"], properties: { type: { type: "string" }, event_time: { type: "integer" } } },
          };
          const schema = envelopes[String(a.provider || "").trim().toLowerCase()] || { type: "object" };
          return { data, schema };
      } },
      // sha256 of the RAW bytes = the event's content fingerprint. Providers
      // redeliver on timeout (at-least-once delivery) — dedup on this hash or
      // reuse it as the Idempotency-Key for downstream calls. Safe to log even
      // for rejected events: it reveals nothing about the payload.
      { slug: "hash", mapInput: (a) => ({ text: a.rawBody, algo: "sha256" }) },
      // Normalize the event timestamp. Field name varies by provider: Stripe
      // created / Slack event_time (epoch s), Shopify created_at (RFC 3339),
      // GitHub head_commit.timestamp (ISO). Falls back to "now" so a payload
      // without a recognizable clock field doesn't fail the step.
      { slug: "time-convert", mapInput: (a) => {
          let b = {};
          try { b = JSON.parse(a.rawBody) || {}; } catch {}
          const when = b.created ?? b.event_time ?? b.created_at ?? b.head_commit?.timestamp ?? "now";
          return { value: when };
      } },
      // Redact-before-log: the redacted string is the only version that may
      // touch the log pipeline.
      { slug: "redact", mapInput: (a) => ({ text: a.rawBody }) },
    ],
  },

  // Deterministic WCAG 2.x first-pass: meta (title + lang), strip-to-text,
  // link enumeration, heading order, color contrast on the supplied brand
  // pair, reading grade, and final shape stats. Chain mode so readability and
  // text-stats reuse the stripped text from prior["html-strip"] instead of
  // re-stripping. color-contrast keys off the user-supplied fg/bg pair (we
  // don't try to compute CSS from a plain HTML string).
  "a11y-audit": {
    mode: "chain",
    steps: [
      { slug: "html-meta",   mapInput: (a) => ({ html: a.html }) },
      { slug: "html-strip",  mapInput: (a) => ({ html: a.html }) },
      { slug: "html-links",  mapInput: (a) => ({ html: a.html }) },
      { slug: "html-select", mapInput: (a) => ({ html: a.html, selector: "h1, h2, h3, h4, h5, h6" }) },
      { slug: "color-contrast", mapInput: (a) => ({ foreground: a.foreground, background: a.background }) },
      { slug: "readability", mapInput: (_a, p) => ({ text: p["html-strip"]?.text ?? "" }) },
      { slug: "text-stats",  mapInput: (_a, p) => ({ text: p["html-strip"]?.text ?? "" }) },
    ],
  },

  // Universal format bridge: YAML → JSON → deep-merge with overrides →
  // diff (so you can prove which keys changed) → flatten (dot-path for
  // env-var injection) → emit CSV (audit trail) and YAML (canonical config).
  // Chain mode is essential — every step except the YAML parse reads the
  // previous step's parsed JSON. overridesJson arrives as a JSON string;
  // json-merge accepts a JSON string under either input so we pass it raw.
  "data-interchange": {
    mode: "chain",
    steps: [
      { slug: "yaml-to-json",  mapInput: (a) => ({ yaml: a.baseYaml }) },
      { slug: "json-merge",    mapInput: (a, p) => ({
          a: p["yaml-to-json"]?.json ?? {},
          b: a.overridesJson,
      }) },
      // Diff base vs merged — produces the rollout audit trail.
      { slug: "json-diff",     mapInput: (_a, p) => ({
          a: p["yaml-to-json"]?.json ?? {},
          b: p["json-merge"]?.result ?? {},
      }) },
      // Flatten the merged config — gives you the env-var key=value envelope.
      { slug: "json-flatten",  mapInput: (_a, p) => ({
          json: p["json-merge"]?.result ?? {},
          mode: "flatten",
      }) },
      // CSV needs a non-empty array of objects — wrap the flat dot-path
      // object as a single row so every key becomes a column.
      { slug: "json-to-csv",   mapInput: (_a, p) => ({
          json: [p["json-flatten"]?.result ?? {}],
      }) },
      // YAML emission — the canonical config-system / git-commit output.
      { slug: "json-to-yaml",  mapInput: (_a, p) => ({ json: p["json-merge"]?.result ?? {} }) },
    ],
  },

  // Standard data-profiling workup over a CSV: load rows, sanity-check column
  // access, then run four stats-kit tools (descriptive → outliers → pairwise
  // correlation → linear regression) over the two named numeric columns. The
  // stats steps extract the columns directly from prior["csv-to-json"].rows in
  // JS — json-query supports indexed paths only, not column wildcards, so we
  // use it as a discovery primitive (first-row value) and do the column-pull
  // in mapInput where the agent can see what was extracted.
  "csv-profile": {
    mode: "chain",
    steps: [
      { slug: "csv-to-json", mapInput: (a) => ({ csv: a.csv }) },
      // Discovery / sanity-check: confirm the named column exists by pulling
      // the first row's value. Fails cleanly if columnA isn't a header.
      { slug: "json-query",  mapInput: (a, p) => ({
          json: p["csv-to-json"]?.rows ?? [],
          path: `[0].${a.columnA}`,
      }) },
      { slug: "stats-summary", mapInput: (a, p) => ({
          values: (p["csv-to-json"]?.rows ?? []).map((r) => Number(r[a.columnA])).filter((n) => Number.isFinite(n)),
      }) },
      { slug: "outliers",     mapInput: (a, p) => ({
          values: (p["csv-to-json"]?.rows ?? []).map((r) => Number(r[a.columnA])).filter((n) => Number.isFinite(n)),
      }) },
      // Pairwise correlation between the two named columns — drops any row
      // where either value isn't numeric so the series stay aligned.
      { slug: "correlation",  mapInput: (a, p) => {
          const rows = p["csv-to-json"]?.rows ?? [];
          const pairs = rows
            .map((r) => [Number(r[a.columnA]), Number(r[a.columnB])])
            .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
          return { x: pairs.map((p) => p[0]), y: pairs.map((p) => p[1]) };
      } },
      // Baseline OLS of columnB on columnA — if this can't fit, no model can.
      { slug: "linear-regression", mapInput: (a, p) => {
          const rows = p["csv-to-json"]?.rows ?? [];
          const pairs = rows
            .map((r) => [Number(r[a.columnA]), Number(r[a.columnB])])
            .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
          return { x: pairs.map((p) => p[0]), y: pairs.map((p) => p[1]) };
      } },
    ],
  },

  // Cross-TZ scheduling: anchor → translate → validate → project → narrate → recur → confirm.
  // attendeeTzs is comma-separated; first TZ is canonical, the agent re-calls the
  // pack with a different first TZ to see another attendee's perspective.
  "meeting-scheduler": {
    mode: "chain",
    steps: [
      { slug: "time",          mapInput: (a) => ({ tz: String(a.attendeeTzs ?? "").split(",")[0]?.trim() || "UTC" }) },
      { slug: "time-convert",  mapInput: (a) => ({ value: a.proposedTime, tz: String(a.attendeeTzs ?? "").split(",")[0]?.trim() || "UTC" }) },
      { slug: "business-days", mapInput: (a) => ({ from: new Date().toISOString().slice(0, 10), to: String(a.proposedTime ?? "").slice(0, 10) }) },
      { slug: "add-time",      mapInput: (a) => ({ date: a.proposedTime, duration: a.durationStr || "1h" }) },
      { slug: "relative-time", mapInput: (a) => ({ time: a.proposedTime }) },
      // Default recurrence proxy: "every Monday 14:00 UTC" preview. Agents that
      // know the actual recurrence rule will re-call cron-next directly.
      { slug: "cron-next",     mapInput: (a) => ({ expr: "0 14 * * 1", count: 5, from: a.proposedTime }) },
      { slug: "date-diff",     mapInput: (a) => ({ from: new Date().toISOString(), to: a.proposedTime }) },
    ],
  },

  // Multi-stop trip skeleton: stops is comma-separated. Pack runs the canonical
  // leg (first two stops) end-to-end — geocode → distance → ETA → business-days
  // → local-time → weather — and the agent re-calls with shifted stops for the
  // full route. Two egress tools (geocode, weather-forecast); rest pure-CPU.
  "trip-planner": {
    mode: "chain",
    steps: [
      { slug: "geocode",       mapInput: (a) => ({ q: String(a.stops ?? "").split(",")[0]?.trim() || "", limit: 1 }) },
      // Geocode the second stop inline so geo-distance has both coords. Use the
      // first geocode result for `from`, and a quick second geocode for `to`
      // via a chained step would double the egress — instead, geo-distance
      // takes the SAME coords twice as a placeholder (returns 0 km) and the
      // agent re-calls with the real pair. Keeps the pack's egress to one geocode.
      { slug: "geo-distance",  mapInput: (_a, p) => {
          const hit = p["geocode"]?.results?.[0];
          const coord = hit ? { lat: hit.lat, lng: hit.lon } : { lat: 0, lng: 0 };
          return { from: coord, to: coord };
      } },
      // ETA = startIso + (km × 1.3 driving factor / 80 kph) hours + 0.5h buffer.
      // With a self-pair leg this is just the buffer; agents pass the real
      // distance when re-running.
      { slug: "add-time",      mapInput: (a, p) => {
          const km = Number(p["geo-distance"]?.km) || 0;
          const hours = (km * 1.3) / 80 + 0.5;
          const h = Math.floor(hours);
          const m = Math.round((hours - h) * 60);
          return { date: a.startIso, duration: `${h}h ${m}m` };
      } },
      { slug: "business-days", mapInput: (a) => ({ from: new Date().toISOString().slice(0, 10), to: String(a.startIso ?? "").slice(0, 10) }) },
      // Render arrival in America/New_York by default; agent re-calls per stop.
      { slug: "time-convert",  mapInput: (_a, p) => ({ value: p["add-time"]?.result || "now", tz: "America/New_York" }) },
      { slug: "weather-forecast", mapInput: (_a, p) => {
          const hit = p["geocode"]?.results?.[0];
          return { lat: hit?.lat ?? 40.71, lon: hit?.lon ?? -74.01 };
      } },
    ],
  },

  // Loan comparison: runs the full workup on loanA only — the comparison
  // emerges when the agent re-calls the pack with loanB in slot A.
  // Parses "$300,000 at 6.5% for 30 years" → {principal, annualRate, termYears}.
  "loan-comparison": {
    mode: "chain",
    steps: [
      { slug: "loan-payment",      mapInput: (a) => parseLoanString(a.loanA) },
      { slug: "amortization",      mapInput: (a) => ({ ...parseLoanString(a.loanA), maxRows: 12 }) },
      // Opportunity cost: if you invested loanA's principal at 7% over the term
      // instead of paying interest, where would you end up? Grounds the
      // comparison against the passive-investing alternative.
      { slug: "compound-interest", mapInput: (a) => {
          const { principal, termYears } = parseLoanString(a.loanA);
          return { principal, annualRate: 0.07, years: termYears, compoundingPerYear: 12 };
      } },
      // NPV of the full payment stream at a 5% personal discount rate.
      { slug: "npv",               mapInput: (a, p) => {
          const { principal, termYears } = parseLoanString(a.loanA);
          const payment = Number(p["loan-payment"]?.payment) || 0;
          const periods = Math.round((termYears || 0) * 12);
          const cashflows = [principal];
          for (let i = 0; i < periods; i++) cashflows.push(-payment);
          return { cashflows, discountRate: 0.05 };
      } },
      // IRR of the same stream — equals the stated rate for plain fixed loans
      // (sanity check), surfaces effective rate for any with points/fees.
      { slug: "irr",               mapInput: (a, p) => {
          const { principal, termYears } = parseLoanString(a.loanA);
          const payment = Number(p["loan-payment"]?.payment) || 0;
          const periods = Math.round((termYears || 0) * 12);
          const cashflows = [principal];
          for (let i = 0; i < periods; i++) cashflows.push(-payment);
          return { cashflows };
      } },
    ],
  },

  // Capital-budgeting decision: NPV at hurdle → IRR → passive alternative →
  // levered case. Parses "$500,000 ... returning $150,000/year for 5 years".
  "investment-decision": {
    mode: "chain",
    steps: [
      { slug: "npv",               mapInput: (a) => {
          const { upfront, annualReturn, years } = parseProjectString(a.project);
          const rate = Number(a.hurdleRate ?? 0.10) || 0.10;
          const cashflows = [-upfront];
          for (let i = 0; i < years; i++) cashflows.push(annualReturn);
          return { cashflows, discountRate: rate };
      } },
      { slug: "irr",               mapInput: (a) => {
          const { upfront, annualReturn, years } = parseProjectString(a.project);
          const cashflows = [-upfront];
          for (let i = 0; i < years; i++) cashflows.push(annualReturn);
          return { cashflows };
      } },
      // Passive alternative: what does the upfront capital earn at a 7%
      // benchmark return over the same horizon? If the project's NPV doesn't
      // beat passive, the hurdle rate is unrealistically low.
      { slug: "compound-interest", mapInput: (a) => {
          const { upfront, years } = parseProjectString(a.project);
          return { principal: upfront, annualRate: 0.07, years, compoundingPerYear: 1 };
      } },
      // Levered case: assume 80% debt at 8% over the project horizon.
      { slug: "loan-payment",      mapInput: (a) => {
          const { upfront, years } = parseProjectString(a.project);
          return { principal: upfront * 0.8, annualRate: 0.08, termYears: years };
      } },
      { slug: "amortization",      mapInput: (a) => {
          const { upfront, years } = parseProjectString(a.project);
          return { principal: upfront * 0.8, annualRate: 0.08, termYears: years, maxRows: 12 };
      } },
    ],
  },

  // Retirement plan: accumulation (compound-interest, npv) → drawdown
  // (loan-payment, amortization). Parses scenario string for currentAge,
  // savings, monthlyContrib, retireAge.
  "retirement-planning": {
    mode: "chain",
    steps: [
      // Project current balance forward to retirement.
      { slug: "compound-interest", mapInput: (a) => {
          const { savings, yearsToRetirement } = parseRetirementScenario(a.scenario);
          const rate = Number(a.expectedReturn ?? 0.07) || 0.07;
          return { principal: savings, annualRate: rate, years: yearsToRetirement, compoundingPerYear: 12 };
      } },
      // Target nest egg from expected spending: 30 years at $48k/yr drawdown
      // discounted at 5%. The |NPV| is the lump sum needed at retirement.
      { slug: "npv",               mapInput: () => {
          const cashflows = [0];
          for (let i = 0; i < 30; i++) cashflows.push(-48000);
          return { cashflows, discountRate: 0.05 };
      } },
      // Back-solve required return if monthly contribution is fixed: cashflow
      // stream is [-savings, -annualContrib×N, +nestEgg].
      { slug: "irr",               mapInput: (a, p) => {
          const { savings, monthlyContrib, yearsToRetirement } = parseRetirementScenario(a.scenario);
          const projected = Number(p["compound-interest"]?.futureValue) || 0;
          const cashflows = [-savings];
          for (let i = 0; i < yearsToRetirement; i++) cashflows.push(-monthlyContrib * 12);
          cashflows.push(projected);
          return { cashflows };
      } },
      // Drawdown: sustainable monthly withdrawal = PMT(nest egg, 5%, 30y, m12).
      { slug: "loan-payment",      mapInput: (_a, p) => {
          const projected = Number(p["compound-interest"]?.futureValue) || 0;
          return { principal: projected, annualRate: 0.05, termYears: 30, paymentsPerYear: 12 };
      } },
      // Year-by-year retirement portfolio balance.
      { slug: "amortization",      mapInput: (_a, p) => {
          const projected = Number(p["compound-interest"]?.futureValue) || 0;
          return { principal: projected, annualRate: 0.05, termYears: 30, maxRows: 30 };
      } },
    ],
  },

  // Savings goal: project no-contrib baseline → solve required PMT via the
  // PV-discount trick → real-dollar target (3% inflation) → back-solved return.
  "savings-goal": {
    mode: "chain",
    steps: [
      // Per-dollar future-value multiplier: project $1 forward at the expected
      // return for the horizon. Result.futureValue is the multiplier — the
      // agent multiplies by actual starting savings to get the no-contrib
      // baseline, then subtracts from target to get the gap.
      { slug: "compound-interest", mapInput: (a) => {
          const { years } = parseGoalString(a.goal);
          const rate = Number(a.expectedReturn ?? 0.07) || 0.07;
          return { principal: 1, annualRate: rate, years, compoundingPerYear: 12 };
      } },
      // Required monthly contribution via PV-discount trick: PV_of_target /
      // (1+r)^n is the principal that, paid as PMT, accumulates to target.
      { slug: "loan-payment",      mapInput: (a) => {
          const { target, years } = parseGoalString(a.goal);
          const rate = Number(a.expectedReturn ?? 0.07) || 0.07;
          const pv = target / Math.pow(1 + rate, years);
          return { principal: pv, annualRate: rate, termYears: years, paymentsPerYear: 12 };
      } },
      // Real-dollar target: discount at 3% inflation to surface today's-dollar value.
      { slug: "npv",               mapInput: (a) => {
          const { target, years } = parseGoalString(a.goal);
          const cashflows = [0];
          for (let i = 1; i < years; i++) cashflows.push(0);
          cashflows.push(target);
          return { cashflows, discountRate: 0.03 };
      } },
      // Back-solve required return: with a $500/mo contribution, what rate
      // hits the target? IRR of [-monthly×12 × N years, +target].
      { slug: "irr",               mapInput: (a) => {
          const { target, years } = parseGoalString(a.goal);
          const cashflows = [];
          for (let i = 0; i < years; i++) cashflows.push(-500 * 12);
          cashflows.push(target);
          return { cashflows };
      } },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Standard-tier network/render packs — all egress-heavy, wallet-only.
  // ──────────────────────────────────────────────────────────────────────

  // End-to-end DNS health: records, multi-resolver propagation, ASN, WHOIS,
  // HTTP reachability, robots policy. Keyed off a bare domain.
  "dns-network-ops": {
    mode: "chain",
    steps: [
      { slug: "dns-lookup",       mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "dns-propagation",  mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "asn-info",         mapInput: (a) => ({ host: a.domain }) },
      { slug: "whois",            mapInput: (a) => ({ domain: a.domain }) },
      { slug: "http-check",       mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "robots-check",     mapInput: (a) => ({ url: `https://${a.domain}`, userAgent: "*" }) },
    ],
  },

  // Fraud reputation workup: domain age (whois) → cert history (CT) → live
  // cert → hosting (ASN) → DNS topology (MX) → tech-stack fingerprint →
  // page-content red-flag scan.
  "fraud-signals": {
    mode: "chain",
    steps: [
      { slug: "whois",             mapInput: (a) => ({ domain: a.domain }) },
      { slug: "cert-transparency", mapInput: (a) => ({ domain: a.domain }) },
      { slug: "tls-cert",          mapInput: (a) => ({ host: a.domain }) },
      { slug: "asn-info",          mapInput: (a) => ({ host: a.domain }) },
      // MX records — "business" with no MX is a fraud signal.
      { slug: "dns-lookup",        mapInput: (a) => ({ host: a.domain, type: "MX" }) },
      { slug: "tech-stack",        mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "extract",           mapInput: (a) => ({ url: `https://${a.domain}` }) },
    ],
  },

  // API recon-before-code: decompose URL → liveness → headers (auth + rate
  // limits) → docs page → spec discovery → JSON inspection. extract returns
  // markdown (not HTML) so html-links scans markdown (count:0 expected; agent
  // re-calls with real HTML). json-format/query use a placeholder so the
  // schema-navigation primitives are exercised on the example.
  "api-investigation": {
    mode: "chain",
    steps: [
      { slug: "url-parse",    mapInput: (a) => ({ url: a.endpoint }) },
      { slug: "http-check",   mapInput: (a) => ({ url: a.endpoint }) },
      { slug: "http-headers", mapInput: (a) => ({ url: a.endpoint }) },
      // Try the canonical docs path: scheme://host/docs.
      { slug: "extract",      mapInput: (a, p) => {
          const u = p["url-parse"];
          const base = u ? `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}` : a.endpoint;
          return { url: `${base}/docs` };
      } },
      // Scan the docs markdown for openapi/swagger hrefs. Markdown bodies
      // don't have <a href> tags so count is usually 0 — agent re-calls
      // html-links with raw HTML from a separate fetch. Still surfaces the
      // empty-result envelope so the agent knows the step ran.
      { slug: "html-links",   mapInput: (_a, p) => ({
          html: String(p["extract"]?.markdown ?? ""),
          filter: "openapi|swagger|schema|\\.json$|\\.yaml$",
          limit: 20,
      }) },
      // Placeholder sample response — the agent passes a real one in a follow-up.
      { slug: "json-format",  mapInput: () => ({ json: '{"data":[],"meta":{"next_cursor":null}}', indent: 2 }) },
      { slug: "json-query",   mapInput: () => ({ json: { data: [], meta: { next_cursor: null } }, path: "meta.next_cursor" }) },
    ],
  },

  // Address situational brief: geocode → reverse-geocode (canonical form) →
  // nearby POIs → weather → US hazards → recent seismic activity. geocode
  // returns `lon` (NWS); place-search/weather/earthquakes also use `lon`.
  "location-intel": {
    mode: "chain",
    steps: [
      { slug: "geocode",          mapInput: (a) => ({ q: a.address, limit: 1 }) },
      { slug: "reverse-geocode",  mapInput: (_a, p) => {
          const hit = p["geocode"]?.results?.[0];
          return { lat: hit?.lat ?? 38.8977, lon: hit?.lon ?? -77.0365 };
      } },
      // Nearby food/services — generic "restaurant" query around the resolved point.
      { slug: "place-search",     mapInput: (_a, p) => {
          const hit = p["geocode"]?.results?.[0];
          const bb = hit?.boundingBox;
          const viewbox = bb ? `${bb.west},${bb.north},${bb.east},${bb.south}` : "";
          return { q: "restaurant", limit: 5, ...(viewbox ? { viewbox, bounded: "1" } : {}) };
      } },
      { slug: "weather-forecast", mapInput: (_a, p) => {
          const hit = p["geocode"]?.results?.[0];
          return { lat: hit?.lat ?? 38.8977, lon: hit?.lon ?? -77.0365 };
      } },
      // US-only — pull state code from reverse-geocode; default to DC for the
      // example, agents re-call with the actual state for non-DC addresses.
      { slug: "weather-alerts",   mapInput: (_a, p) => {
          const state = p["reverse-geocode"]?.address?.state || "";
          // Map full state name → two-letter code is handled server-side; pass through.
          return { area: state || "DC" };
      } },
      { slug: "earthquakes",      mapInput: () => ({ period: "week", minMag: "2.5" }) },
    ],
  },

  // URL → card-shaped preview: metadata + readable body + normalized image
  // variants + entity discovery. image-resize/thumbnail take base64 bytes
  // (not URLs) so the chain runs them against a 1×1 placeholder PNG — agents
  // re-call with the real og:image bytes for the actual card.
  "link-preview": {
    mode: "chain",
    steps: [
      { slug: "meta",              mapInput: (a) => ({ url: a.url }) },
      { slug: "extract",           mapInput: (a) => ({ url: a.url }) },
      // 8×8 placeholder PNG (jimp-decodable) — exercises the resize codepath;
      // final card requires fetching og:image bytes and re-calling.
      { slug: "image-resize",      mapInput: () => ({
          image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==",
          width: 1200,
          height: 630,
          format: "png",
      }) },
      { slug: "image-thumbnail",   mapInput: () => ({
          image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==",
          size: 400,
          format: "png",
      }) },
      { slug: "extract-entities", mapInput: (_a, p) => ({ text: String(p["extract"]?.markdown ?? "") }) },
    ],
  },

  // Site pre-flight: DNS → reachability → security headers → cert expiry →
  // robots policy. All keyed off the URL; host derived inline.
  "status-snapshot": {
    mode: "chain",
    steps: [
      { slug: "dns-lookup",   mapInput: (a) => {
          let host = a.url;
          try { host = new URL(a.url).hostname; } catch {}
          return { host, type: "A" };
      } },
      { slug: "http-check",   mapInput: (a) => ({ url: a.url }) },
      { slug: "http-headers", mapInput: (a) => ({ url: a.url }) },
      { slug: "tls-cert",     mapInput: (a) => {
          let host = a.url;
          try { host = new URL(a.url).hostname; } catch {}
          return { host };
      } },
      { slug: "robots-check", mapInput: (a) => ({ url: a.url, userAgent: "*" }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Standard-tier content/extraction packs.
  // ──────────────────────────────────────────────────────────────────────

  // Email auth posture: end-to-end deliverability + per-mechanism detail.
  // dkim-lookup needs a selector — read the first found-selector out of
  // the email-deliverability report, or fall back to a common default.
  "email-deliverability": {
    mode: "chain",
    steps: [
      { slug: "spf-check",            mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dmarc-check",          mapInput: (a) => ({ domain: a.domain }) },
      { slug: "email-deliverability", mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dkim-lookup",          mapInput: (a, p) => {
          const sel = p["email-deliverability"]?.dkim?.found?.[0]?.selector || "default";
          return { domain: a.domain, selector: sel };
      } },
      { slug: "email-validate",       mapInput: (a) => ({ email: `postmaster@${a.domain}` }) },
      { slug: "dns-lookup",           mapInput: (a) => ({ host: a.domain, type: "MX" }) },
    ],
  },

  // RAG corpus ingest: take the first URL from the comma/newline list and
  // fanout to extract, meta, pdf-to-markdown, pdf-extract-pages, render, OCR.
  // Tools that don't match the content-type fail cleanly (partial-success).
  "content-extraction": {
    mode: "chain",
    steps: [
      { slug: "extract",          mapInput: (a) => ({ url: firstUrl(a.urls) }) },
      { slug: "meta",             mapInput: (a) => ({ url: firstUrl(a.urls) }) },
      { slug: "pdf-to-markdown",  mapInput: (a) => ({ url: firstUrl(a.urls) }) },
      { slug: "pdf-extract-pages",mapInput: (a) => ({ url: firstUrl(a.urls), pages: "1" }) },
      { slug: "render",           mapInput: (a) => ({ url: firstUrl(a.urls) }) },
      { slug: "image-ocr",        mapInput: (a) => ({ url: firstUrl(a.urls) }) },
    ],
  },

  // URL → clean markdown decision tree. http-headers triages; the right
  // extractor runs, the others fail cleanly. text-stats reads whichever
  // body landed (extract → pdf-to-markdown → image-ocr in priority order).
  "any-to-markdown": {
    mode: "chain",
    steps: [
      { slug: "http-headers",    mapInput: (a) => ({ url: a.url }) },
      { slug: "extract",         mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-to-markdown", mapInput: (a) => ({ url: a.url }) },
      { slug: "image-ocr",       mapInput: (a) => ({ url: a.url }) },
      { slug: "html-to-markdown",mapInput: (_a, p) => ({ html: String(p["extract"]?.markdown ?? "") }) },
      { slug: "text-stats",      mapInput: (_a, p) => ({
          text: String(
            p["extract"]?.markdown ??
            p["pdf-to-markdown"]?.markdown ??
            p["image-ocr"]?.text ??
            "",
          ),
      }) },
    ],
  },

  // Scrape a page deterministically. extract → render covers the prose
  // happy path; the html-* tools run against the rendered/extracted body
  // when it's HTML-shaped. Markdown bodies will return empty hits — the
  // agent re-calls html-* against raw HTML it fetches separately.
  "structured-scrape": {
    mode: "chain",
    steps: [
      { slug: "extract",     mapInput: (a) => ({ url: a.url }) },
      { slug: "render",      mapInput: (a) => ({ url: a.url }) },
      { slug: "html-select", mapInput: async (a) => ({
          html: await fetchPageHtml(a.url),
          selector: "h1, h2, .price, [itemprop=\"price\"]",
          limit: 25,
      }) },
      { slug: "html-table",  mapInput: async (a) => ({
          html: await fetchPageHtml(a.url),
          format: "json",
      }) },
      { slug: "html-strip",  mapInput: async (a) => ({
          html: await fetchPageHtml(a.url),
      }) },
      { slug: "html-links",  mapInput: (_a, p) => ({
          html: String(p["render"]?.markdown ?? p["extract"]?.markdown ?? ""),
          limit: 50,
      }) },
      // Advertised in toolSlugs and never run until 2026-09-02.
      { slug: "html-meta",   mapInput: async (a) => ({ html: await fetchPageHtml(a.url) }) },
    ],
  },

  // OpenAPI drift diagnosis. Two specs in, structural diff + lint + surface
  // inventory + required-params + payload validation + security delta out.
  // All pure-CPU openapi-* tools; no egress to the actual API.
  "schema-evolution": {
    mode: "chain",
    steps: [
      { slug: "openapi-diff",             mapInput: (a) => ({ before: a.oldSpec, after: a.newSpec }) },
      { slug: "openapi-lint",             mapInput: (a) => ({ spec: a.newSpec }) },
      { slug: "openapi-extract",          mapInput: (a) => ({ spec: a.newSpec }) },
      { slug: "openapi-required-params",  mapInput: (a, p) => {
          const first = p["openapi-extract"]?.endpoints?.[0];
          return first?.operationId
            ? { spec: a.newSpec, operationId: first.operationId }
            : { spec: a.newSpec, method: first?.method || "get", path: first?.path || "/" };
      } },
      { slug: "openapi-validate-payload", mapInput: (a, p) => {
          const first = p["openapi-extract"]?.endpoints?.[0];
          return {
            spec: a.newSpec,
            payload: {},
            ...(first?.operationId
              ? { operationId: first.operationId }
              : { method: first?.method || "get", path: first?.path || "/" }),
            part: "request",
          };
      } },
      { slug: "openapi-security-summary", mapInput: (a) => ({ spec: a.newSpec }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Premium tier — paid-upstream heavy. All chain-mode so downstream steps
  // can thread off the resolver step (ticker→CIK, theme→first-match CIK,
  // question→first-citation URL).
  // ──────────────────────────────────────────────────────────────────────

  // Canonical US macro dataset. Pure fanout — all 7 tools take {} args.
  // No prompt args; the as-of date is implicit in each tool's response.
  "macro-economics": {
    mode: "fanout",
    steps: [
      { slug: "treasury-yield-curve",  mapInput: () => ({}) },
      { slug: "yield-curve-spread",    mapInput: () => ({}) },
      { slug: "cpi-yoy",               mapInput: () => ({}) },
      { slug: "unemployment-rate",     mapInput: () => ({ months: 12 }) },
      { slug: "fed-funds",             mapInput: () => ({ days: 30 }) },
      { slug: "sahm-rule",             mapInput: () => ({}) },
      { slug: "fred-release-calendar", mapInput: () => ({ days: 14 }) },
    ],
  },

  // Crypto one-pager. Chain so the final extract step can read a URL out
  // of search-news. crypto-history days=90 picks the deep-dive window the
  // claudePrompt hard-codes; agents can re-call with a different range.
  "crypto-research": {
    mode: "chain",
    steps: [
      { slug: "crypto-price",    mapInput: (a) => ({ coins: a.coin, currency: "usd" }) },
      { slug: "crypto-market",   mapInput: () => ({ limit: 10, currency: "usd" }) },
      { slug: "crypto-history",  mapInput: (a) => ({ coin: a.coin, days: "90", currency: "usd" }) },
      { slug: "crypto-trending", mapInput: () => ({}) },
      { slug: "crypto-global",   mapInput: () => ({ currency: "usd" }) },
      { slug: "search-news",     mapInput: (a) => ({ q: `${a.coin} crypto`, count: 5, freshness: "pw" }) },
      { slug: "extract",         mapInput: (_a, p) => {
          const url = p["search-news"]?.results?.[0]?.url;
          if (!url) throw Object.assign(new Error("no news URL to extract"), { statusCode: 422 });
          return { url };
      } },
    ],
  },

  // The observed-demand basket (see PACK_PRICES note): 14 keyless reads, pure fanout,
  // no step depends on another. NO metered-dollar upstream anywhere in this
  // pack - nothing Brave/E2B/OpenAI-backed - so it introduces no CI-spend
  // surface (test-brave-leak derives reachability from toolSlugs and will
  // fail the build if that ever changes).
  "macro-dashboard": {
    mode: "fanout",
    steps: [
      { slug: "fred-release-calendar",  mapInput: () => ({ days: 14 }) },
      { slug: "fed-funds",              mapInput: () => ({ days: 30 }) },
      { slug: "cpi-yoy",                mapInput: () => ({}) },
      { slug: "unemployment-rate",      mapInput: () => ({ months: 12 }) },
      { slug: "sahm-rule",              mapInput: () => ({}) },
      { slug: "yield-curve-spread",     mapInput: () => ({}) },
      { slug: "treasury-yield-curve",   mapInput: () => ({}) },
      { slug: "treasury-yield-history", mapInput: () => ({ days: 90 }) },
      { slug: "treasury-debt",          mapInput: () => ({}) },
      { slug: "treasury-avg-rates",     mapInput: () => ({}) },
      { slug: "crypto-market",          mapInput: () => ({ limit: 10, currency: "usd" }) },
      { slug: "crypto-trending",        mapInput: () => ({}) },
      { slug: "crypto-global",          mapInput: () => ({ currency: "usd" }) },
      { slug: "gas-estimate",           mapInput: () => ({ network: "base" }) },
    ],
  },

  // Analyst's EDGAR workflow. Chain: ticker→CIK is the resolver, every
  // step downstream uses the original ticker (most edgar tools accept it
  // directly so we don't have to thread CIK manually). The 13F step uses
  // Berkshire's CIK (1067983) per the claudePrompt's "known manager" recipe.
  "sec-filings-deep-dive": {
    mode: "chain",
    steps: [
      { slug: "edgar-company-lookup",  mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "edgar-filings",         mapInput: (a) => ({ ticker: a.ticker, limit: 25 }) },
      { slug: "edgar-company-facts",   mapInput: (a) => ({ ticker: a.ticker, tags: "Revenues,NetIncomeLoss,Assets" }) },
      { slug: "edgar-company-concept", mapInput: (a) => ({ ticker: a.ticker, taxonomy: "us-gaap", tag: "Revenues" }) },
      { slug: "edgar-insider-trades",  mapInput: (a) => ({ ticker: a.ticker, days: 90, limit: 25 }) },
      { slug: "edgar-search",          mapInput: (a) => ({ q: "going concern", ticker: a.ticker, limit: 5 }) },
      { slug: "edgar-13f-holdings",    mapInput: () => ({ cik: "1067983", limit: 10 }) },
    ],
  },

  // Macro backdrop. Same tools as macro-economics plus fx-dashboard;
  // fanout because none of them depend on each other and the as-of-date
  // arg is captured by the envelope, not the tool inputs.
  "macro-context": {
    mode: "fanout",
    steps: [
      { slug: "cpi-yoy",               mapInput: () => ({}) },
      { slug: "unemployment-rate",     mapInput: () => ({ months: 6 }) },
      { slug: "fed-funds",             mapInput: () => ({ days: 365 }) },
      { slug: "treasury-yield-curve",  mapInput: () => ({}) },
      { slug: "yield-curve-spread",    mapInput: () => ({}) },
      { slug: "sahm-rule",             mapInput: () => ({}) },
      { slug: "fx-dashboard",          mapInput: () => ({}) },
      { slug: "fred-release-calendar", mapInput: () => ({ days: 14 }) },
    ],
  },

  // Theme-monitoring radar. Chain: edgar-search seeds the watchlist, the
  // first hit's CIK threads through the next 3 calls. Insider/13F/filings
  // run against the top match — agents loop over the rest of `hits` to
  // expand the radar; that's outside the chain envelope.
  "regulatory-watch": {
    mode: "chain",
    steps: [
      { slug: "edgar-search",         mapInput: (a) => ({
          q: a.theme,
          days: parseInt(a.lookbackDays, 10) || 30,
          limit: 25,
      }) },
      { slug: "edgar-filings",        mapInput: (_a, p) => {
          const cik = p["edgar-search"]?.hits?.[0]?.cik;
          if (!cik) throw Object.assign(new Error("no theme match - empty watchlist"), { statusCode: 422 });
          return { cik, limit: 10 };
      } },
      { slug: "edgar-insider-trades", mapInput: (_a, p) => {
          const cik = p["edgar-search"]?.hits?.[0]?.cik;
          if (!cik) throw Object.assign(new Error("no theme match - empty watchlist"), { statusCode: 422 });
          return { cik, days: 90, limit: 25 };
      } },
      { slug: "edgar-13f-holdings",   mapInput: () => ({ cik: "1067983", limit: 10 }) },
      { slug: "edgar-recent-ipos",    mapInput: (a) => ({
          days: parseInt(a.lookbackDays, 10) || 30,
          form: "S-1",
          limit: 25,
      }) },
    ],
  },

  // Cited-answer workflow. Chain: answer hypothesizes, search/search-news
  // give the SERP + freshness check, extract verifies the first citation
  // body, extract-entities feeds the agent's claim-attribution audit.
  "search-and-cite": {
    mode: "chain",
    steps: [
      { slug: "answer",           mapInput: (a) => ({ q: a.question }) },
      { slug: "search",           mapInput: (a) => ({ q: a.question, count: 10 }) },
      { slug: "search-news",      mapInput: (a) => ({ q: a.question, count: 5, freshness: "pm" }) },
      { slug: "extract",          mapInput: (_a, p) => {
          const url =
            p["answer"]?.citations?.[0]?.url ||
            p["search"]?.results?.[0]?.url;
          if (!url) throw Object.assign(new Error("no citation URL to verify"), { statusCode: 422 });
          return { url };
      } },
      { slug: "extract-entities", mapInput: (_a, p) => ({
          text: String(p["extract"]?.markdown ?? ""),
      }) },
    ],
  },

  // The "user uploaded a thing, normalize it before storing" workflow. The
  // pack takes a URL (the upload's public location); media-info + audio-normalize
  // consume URLs directly, while barcode-decode and the image-* tools need
  // base64 bytes — fetchAsBase64 bridges the gap. Async mapInputs are now
  // awaited by runStep so the inline fetch is safe. image-convert reads the
  // resize step's Buffer output from `prior` and re-encodes it; if the file
  // isn't an image the resize step fails and convert short-circuits with 422.
  "media-pipeline": {
    mode: "chain",
    steps: [
      { slug: "media-info",      mapInput: (a) => ({ url: a.uploadPath }) },
      { slug: "barcode-decode",  mapInput: async (a) => ({ image: await fetchAsBase64(a.uploadPath) }) },
      { slug: "image-resize",    mapInput: async (a) => ({
          image: await fetchAsBase64(a.uploadPath),
          width: 2000,
          format: "png",
      }) },
      { slug: "image-thumbnail", mapInput: async (a) => ({
          image: await fetchAsBase64(a.uploadPath),
          size: 200,
          format: "png",
      }) },
      { slug: "image-convert",   mapInput: (_a, p) => {
          // image-resize / -thumbnail / -convert all return { __binary: Buffer, contentType }.
          const buf = p["image-resize"]?.__binary;
          if (!Buffer.isBuffer(buf) || buf.length === 0) {
            throw Object.assign(new Error("no resized image to convert"), { statusCode: 422 });
          }
          return { image: buf.toString("base64"), format: "jpeg", quality: 82 };
      } },
      { slug: "audio-normalize", mapInput: (a) => ({ url: a.uploadPath, targetLufs: -16 }) },
    ],
  },

  // PDF or image URL → structured data. The chain doesn't branch explicitly;
  // each step fires unconditionally and non-applicable ones produce clean
  // partial-failures (e.g., image-ocr 422s on a PDF URL, pdf-info 422s on an
  // image URL). pdf-merge requires ≥2 URLs, so we pass [url, url] to exercise
  // the merge handler on the same source — useful for re-pagination or as a
  // dedup self-check. images-to-pdf accepts a single image URL.
  "document-intel": {
    mode: "chain",
    steps: [
      { slug: "pdf-info",          mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-to-markdown",   mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-extract-pages", mapInput: (a) => ({ url: a.url, pages: "1" }) },
      { slug: "image-ocr",         mapInput: (a) => ({ url: a.url }) },
      { slug: "barcode-decode",    mapInput: async (a) => ({ image: await fetchAsBase64(a.url) }) },
      { slug: "pdf-merge",         mapInput: (a) => ({ urls: [a.url, a.url] }) },
      { slug: "images-to-pdf",     mapInput: (a) => ({ urls: [a.url] }) },
    ],
  },

  // Three independent views of the same PDF, all deriving input from the
  // single `url` arg - fanout, no step depends on another's result.
  "document-brief": {
    mode: "fanout",
    steps: [
      { slug: "pdf-info",          mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-summarize",     mapInput: (a) => ({ url: a.url, maxWords: a.maxWords || 150 }) },
      { slug: "pdf-extract-pages", mapInput: (a) => ({ url: a.url, pages: a.previewPages || "1-2" }) },
    ],
  },

  // Bake-off: backtest 4 methods, then forecast forward with all 4. Both
  // fetchers fire — stock-history wins for tickers, fred-series wins for
  // FRED series ids; the loser fails cleanly. forecast-eval is called 4×
  // (one per method); the envelope preserves all 4 RMSE/MAPE rows for the
  // agent to rank. Then all 4 forward forecasts run, so the agent has the
  // full menu without a second round-trip. The slug-collision on the 4
  // forecast-eval entries is intentional and harmless: nothing downstream
  // reads prior["forecast-eval"] — the steps[] array is what matters.
  "forecasting-bake-off": {
    mode: "chain",
    steps: [
      { slug: "stock-history", mapInput: (a) => ({ symbol: a.series, range: "2y" }) },
      { slug: "fred-series",   mapInput: (a) => ({ seriesId: a.series }) },
      // Helper: closes from whichever fetcher succeeded.
      ...["naive", "ses", "holt", "holt-winters"].map((method) => ({
        slug: "forecast-eval",
        mapInput: (_a, p) => {
          const values = bakeOffValues(p);
          if (values.length < 6) {
            throw Object.assign(new Error(`need ≥6 observations for backtest, got ${values.length}`), { statusCode: 422 });
          }
          const testSize = Math.max(2, Math.round(values.length * 0.2));
          // forecast-eval REQUIRES an explicit period for holt-winters (the
          // standalone forecast-holt-winters auto-detects, the backtest does
          // not), so this leg failed on every run: "backtest failed: period
          // required for method holt-winters". 5 = a trading week, the only
          // seasonality a daily price series plausibly carries.
          const period = method === "holt-winters" ? 5 : undefined;
          return period ? { values, testSize, method, period } : { values, testSize, method };
        },
      })),
      { slug: "forecast-naive",        mapInput: (a, p) => ({
          values: bakeOffValues(p),
          horizon: parseInt(a.horizon, 10) || 30,
          method: "drift",
      }) },
      { slug: "forecast-ses",          mapInput: (a, p) => ({
          values: bakeOffValues(p),
          horizon: parseInt(a.horizon, 10) || 30,
      }) },
      { slug: "forecast-holt",         mapInput: (a, p) => ({
          values: bakeOffValues(p),
          horizon: parseInt(a.horizon, 10) || 30,
      }) },
      { slug: "forecast-holt-winters", mapInput: (a, p) => ({
          values: bakeOffValues(p),
          horizon: parseInt(a.horizon, 10) || 30,
          // Auto-detection finds no ACF lag above 0.3 on daily price
          // differences, so this leg failed on every run. 5 = a trading week.
          period: 5,
      }) },
    ],
  },

  // Agent-wallet preflight: balances on both major rails (the second
  // wallet-balances step is the Solana read — a missing solanaAddress arg
  // fails just that step with a 400, partial-success by design), gas
  // context, and a funding link a human can open. All independent → fanout.
  "wallet-readiness": {
    mode: "fanout",
    steps: [
      { slug: "wallet-balances", mapInput: (a) => ({ address: a.address, network: "base" }) },
      { slug: "wallet-balances", mapInput: (a) => ({ address: a.solanaAddress, network: "solana" }) },
      { slug: "gas-snapshot",    mapInput: () => ({ network: "base" }) },
      { slug: "onramp-link",     mapInput: (a) => ({ address: a.address, network: "base", amount: "10" }) },
    ],
  },

  // SQL over Base with the schema in the same envelope — the follow-up
  // query can be authored without a second discovery call. Chained so the
  // final step can profile the result set: stats-summary runs over the
  // first numeric column of the query rows (a distribution picture for
  // time series; for a single-row aggregate it degenerates harmlessly).
  "onchain-analyst": {
    mode: "chain",
    steps: [
      { slug: "onchain-sql-schema", mapInput: () => ({}) },
      { slug: "onchain-sql",        mapInput: (a) => ({ sql: a.sql, cacheSeconds: 300 }) },
      { slug: "stats-summary",      mapInput: (_a, p) => {
          const rows = p["onchain-sql"]?.rows ?? [];
          const numericKey = Object.keys(rows[0] ?? {}).find((k) => Number.isFinite(Number(rows[0][k])));
          const values = numericKey ? rows.map((r) => Number(r[numericKey])).filter(Number.isFinite) : [];
          if (!values.length) {
            throw Object.assign(new Error("query returned no numeric column to profile"), { statusCode: 422 });
          }
          return { values: values.slice(0, 10000) };
      } },
    ],
  },

  // Technical indexability: all six checks key off the one page URL.
  // robots-check runs as Googlebot (the workflow tells agents to re-run
  // with GPTBot/ClaudeBot for answer-engine policy); sitemap probes the
  // conventional /sitemap.xml at the page's origin.
  "seo-audit": {
    mode: "fanout",
    steps: [
      { slug: "http-check",   mapInput: (a) => ({ url: a.url }) },
      { slug: "tls-cert",     mapInput: (a) => ({ host: new URL(a.url).hostname }) },
      { slug: "robots-check", mapInput: (a) => ({ url: a.url, userAgent: "Googlebot" }) },
      { slug: "sitemap",      mapInput: (a) => ({ url: `${new URL(a.url).origin}/sitemap.xml` }) },
      { slug: "meta",         mapInput: (a) => ({ url: a.url }) },
      { slug: "http-headers", mapInput: (a) => ({ url: a.url }) },
    ],
  },

  // Cross-chain gas shopping for real onchain actions (x402 buys are
  // gasless — this is for everything else). ETH spot converts gwei to
  // dollars. All reads are independent → fanout; gas-snapshot reads Base
  // (the default settlement home) regardless of the comparison winner —
  // the agent re-calls it for a different chain if the comparison says so.
  "cheapest-rail": {
    mode: "fanout",
    steps: [
      { slug: "l2-gas-comparison", mapInput: (a) => ({
          networks: String(a.networks || "ethereum,base,arbitrum,optimism,polygon").split(/[\s,]+/).filter(Boolean),
      }) },
      { slug: "gas-snapshot",  mapInput: () => ({ network: "base" }) },
      { slug: "gas-estimate",  mapInput: () => ({ network: "base" }) },
      { slug: "crypto-price",  mapInput: () => ({ coins: "ETH", currency: "usd" }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Premium dossier packs (2026-07): high-value "solve the whole job" bundles.
  // ──────────────────────────────────────────────────────────────────────

  // Company dossier: all 5 data calls in parallel (fanout), no extract step.
  // Chain mode exceeded Railway's 30s response timeout (6 sequential API calls
  // each 3-10s = 30-60s total). Fanout runs in max(individual) ≈ 10s.
  // Removed extract: marginal value (one article) not worth the timeout risk.
  "company-dossier": {
    mode: "fanout",
    steps: [
      { slug: "stock-quote",          mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "company-financials",   mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "edgar-filings",        mapInput: (a) => ({ ticker: a.ticker, limit: 5 }) },
      { slug: "edgar-insider-trades", mapInput: (a) => ({ ticker: a.ticker, lookbackDays: 90 }) },
      { slug: "search",               mapInput: (a) => ({ q: `${a.ticker} company news`, count: 5, freshness: "pm" }) },
    ],
  },

  // Domain intel: full external footprint in parallel — no step depends on another.
  // cert-transparency (crt.sh) excluded: free public service with no SLA, times out
  // frequently. Available as a standalone tool for agents that want it.
  "domain-intel": {
    mode: "fanout",
    steps: [
      { slug: "whois",              mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dns-lookup",         mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "tls-cert",           mapInput: (a) => ({ host: a.domain }) },
      { slug: "http-headers",       mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "tech-stack",         mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "robots-check",       mapInput: (a) => ({ url: `https://${a.domain}` }) },
    ],
  },

  // Crypto dossier: price → history → trending → global → news search →
  // extract top article. Chain so the extract step can read the first search
  // result URL from prior.
  "crypto-dossier": {
    mode: "chain",
    steps: [
      { slug: "crypto-price",    mapInput: (a) => ({ coins: a.coin, currency: "usd" }) },
      { slug: "crypto-history",  mapInput: (a) => ({ coin: a.coin, days: "90", currency: "usd" }) },
      { slug: "crypto-trending", mapInput: () => ({}) },
      { slug: "crypto-global",   mapInput: () => ({ currency: "usd" }) },
      { slug: "search",          mapInput: (a) => ({ q: `${a.coin} cryptocurrency news`, count: 5, freshness: "pw" }) },
      // Publishers that block scrapers are common enough that picking one URL
      // lost this step 43.5% of the time. Offer the ranked results in order and
      // fall back to the coin's own page, which we know is readable.
      { slug: "extract",         mapInputs: (a, p) => {
          const results = p["search"]?.results || [];
          // No hardcoded fallback: the coin's own CoinGecko page answers 403
          // to our fetcher (measured), so appending it added a guaranteed-dead
          // last candidate rather than a safety net. Walk more real results
          // instead, and if every one of them blocks us, say so honestly.
          const urls = results.map((r) => r?.url).filter((u) => typeof u === "string" && u);
          return [...new Set(urls)].slice(0, 6).map((url) => ({ url }));
      } },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Four packs that were listed and PRICED in SKILL_PACKS with no entry here,
  // so every step hit todoError() and every buyer got HTTP 200 with 0/N steps
  // succeeded - deterministically, from 2026-07-08 until 2026-08-31. The
  // partial-success envelope is why nothing caught it: the shape is valid
  // whatever the steps did, so the "answers its own example" check passed,
  // and three of the four are additionally skipped there to avoid live Brave
  // spend. Implemented below from each pack's own declared workflow and
  // toolSlugs; the missing-entry class is now pinned by
  // scripts/test-skill-pack-steps.js.
  // ──────────────────────────────────────────────────────────────────────

  // Earnings deep-dive: date, fundamentals, filings, quote, narrative. Every
  // read is independent of the others, so fan out.
  "earnings-deep-dive": {
    mode: "fanout",
    steps: [
      { slug: "earnings-calendar",  mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "company-financials", mapInput: (a) => ({ ticker: a.ticker }) },
      { slug: "edgar-filings",      mapInput: (a) => ({ ticker: a.ticker, limit: 10 }) },
      { slug: "stock-quote",        mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "search",             mapInput: (a) => ({ q: `${a.ticker} earnings analyst expectations`, count: 5 }) },
    ],
  },

  // Options analytics: chain, because the whole point of the pack is that
  // black-scholes gets a LIVE spot and a volatility measured from this
  // stock's own history instead of textbook inputs.
  "options-analytics": {
    mode: "chain",
    steps: [
      { slug: "stock-quote",   mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "stock-history", mapInput: (a) => ({ symbol: a.ticker, range: "3mo" }) },
      { slug: "black-scholes", mapInput: (a, p) => {
          const spot = requireNumber(p["stock-quote"]?.price, "the live spot price");
          const volatility = realizedVolatility(p["stock-history"]?.bars);
          // At-the-money by default, rounded to a strike that would actually be
          // listed; the caller may name one instead.
          const step = spot >= 200 ? 10 : spot >= 50 ? 5 : 1;
          const strike = Number(a.strike) > 0 ? Number(a.strike) : Math.round(spot / step) * step;
          const days = Number(a.daysToExpiry) > 0 ? Number(a.daysToExpiry) : 30;
          return {
            type: a.type === "put" ? "put" : "call",
            spot,
            strike,
            timeToExpiryYears: days / 365,
            riskFreeRate: Number(a.riskFreeRate) >= 0 ? Number(a.riskFreeRate) : 0.05,
            volatility,
            dividendYield: 0,
          };
      } },
      { slug: "search", mapInput: (a) => ({ q: `${a.ticker} stock catalyst earnings guidance`, count: 5 }) },
    ],
  },

  // Fixed-income desk: chain, because the bond is priced at the CURVE's own
  // 10Y yield and then re-inverted from that price to confirm it.
  "fixed-income-desk": {
    mode: "chain",
    steps: [
      { slug: "treasury-yield-curve", mapInput: () => ({}) },
      { slug: "yield-curve-spread",   mapInput: () => ({}) },
      { slug: "cpi-yoy",              mapInput: () => ({}) },
      { slug: "bond-price", mapInput: (a, p) => {
          // The curve reports percent (yr10: 4.51); the bond tools take a decimal.
          const yr10 = requireNumber(p["treasury-yield-curve"]?.yr10, "the 10Y Treasury yield");
          return {
            faceValue: 1000,
            couponRate: Number(a.couponRate) > 0 ? Number(a.couponRate) : 0.05,
            yieldToMaturity: yr10 / 100,
            years: 10,
            periodsPerYear: 2,
          };
      } },
      { slug: "bond-ytm", mapInput: (a, p) => ({
          price: requireNumber(p["bond-price"]?.price, "the bond price from the previous step"),
          faceValue: 1000,
          couponRate: Number(a.couponRate) > 0 ? Number(a.couponRate) : 0.05,
          years: 10,
          periodsPerYear: 2,
      }) },
    ],
  },

  // DeFi protocol scanner: price, market scale, real usage (TVL), news.
  // Independent reads, so fan out.
  "defi-protocol-scanner": {
    mode: "fanout",
    steps: [
      { slug: "crypto-price",  mapInput: (a) => ({ coins: a.protocol, currency: "usd" }) },
      { slug: "crypto-market", mapInput: () => ({ limit: 10, currency: "usd" }) },
      { slug: "defi-tvl",      mapInput: (a) => ({ protocol: a.protocol }) },
      { slug: "search",        mapInput: (a) => ({ q: `${a.protocol} defi protocol audit security incident`, count: 5 }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Premium skill packs (2026-07): high-value multi-tool fanout bundles.
  // ──────────────────────────────────────────────────────────────────────

  // Earnings watch: is a report coming, what's the quote, what are analysts saying?
  "earnings-watch": {
    mode: "fanout",
    steps: [
      { slug: "earnings-calendar", mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "stock-quote",       mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "search",            mapInput: (a) => ({ q: `${a.ticker} earnings`, count: 5 }) },
    ],
  },

  // Insider alert: Form 4 activity + quote + recent filings.
  "insider-alert": {
    mode: "fanout",
    steps: [
      { slug: "edgar-insider-trades", mapInput: (a) => ({ ticker: a.ticker, lookbackDays: 30 }) },
      { slug: "stock-quote",          mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "edgar-filings",        mapInput: (a) => ({ ticker: a.ticker, limit: 3 }) },
    ],
  },

  // IPO watch: recent S-1 filings + web search for IPO news.
  "ipo-watch": {
    mode: "fanout",
    steps: [
      { slug: "edgar-recent-ipos", mapInput: () => ({ days: 14 }) },
      { slug: "search",            mapInput: () => ({ q: "recent IPO filings SEC", count: 5 }) },
      // Advertised and never run until 2026-09-02: the workflow's own third step.
      { slug: "search-news",       mapInput: () => ({ q: "IPO pricing debut S-1 filing", count: 5, freshness: "pw" }) },
    ],
  },

  // Yield dashboard: full curve + spreads + average rates.
  "yield-dashboard": {
    mode: "fanout",
    steps: [
      { slug: "treasury-yield-curve", mapInput: () => ({}) },
      { slug: "yield-curve-spread",   mapInput: () => ({}) },
      { slug: "treasury-avg-rates",   mapInput: () => ({}) },
    ],
  },

  // Inflation check: the four recession indicators.
  "inflation-check": {
    mode: "fanout",
    steps: [
      { slug: "cpi-yoy",           mapInput: () => ({}) },
      { slug: "fed-funds",         mapInput: () => ({}) },
      { slug: "unemployment-rate", mapInput: () => ({}) },
      { slug: "sahm-rule",         mapInput: () => ({}) },
    ],
  },

  // FX monitor: three major crosses + full dashboard.
  "fx-monitor": {
    mode: "fanout",
    steps: [
      { slug: "fx-rate",      mapInput: () => ({ from: "EUR", to: "USD" }) },
      { slug: "fx-rate",      mapInput: () => ({ from: "GBP", to: "USD" }) },
      { slug: "fx-rate",      mapInput: () => ({ from: "JPY", to: "USD" }) },
      { slug: "fx-dashboard", mapInput: () => ({}) },
      // Advertised and never run until 2026-09-02: EUR/USD a week back, the
      // reference the workflow says a spot rate must be read against.
      { slug: "fx-historical", mapInput: () => ({ from: "EUR", to: "USD", date: new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10) }) },
    ],
  },

  // DeFi dashboard: TVL + ETH price + Base gas + global stats.
  // defi-tvl requires a protocol slug — "aave" as the default reference protocol.
  "defi-dashboard": {
    mode: "fanout",
    steps: [
      { slug: "defi-tvl",      mapInput: () => ({ protocol: "aave" }) },
      { slug: "crypto-price",  mapInput: () => ({ coins: "ETH", currency: "usd" }) },
      { slug: "gas-snapshot",  mapInput: () => ({ network: "base" }) },
      { slug: "crypto-global", mapInput: () => ({ currency: "usd" }) },
    ],
  },

  // NFT portfolio: holdings + wallet balance + ETH price.
  "nft-portfolio": {
    mode: "fanout",
    steps: [
      { slug: "nft-holdings",   mapInput: (a) => ({ address: a.address, network: "base" }) },
      { slug: "wallet-balance", mapInput: (a) => ({ address: a.address, network: "base" }) },
      { slug: "crypto-price",   mapInput: () => ({ coins: "ETH", currency: "usd" }) },
    ],
  },

  // Wallet audit: balance + transactions + token metadata.
  "wallet-audit": {
    mode: "fanout",
    steps: [
      { slug: "wallet-balance",      mapInput: (a) => ({ address: a.address, network: "base" }) },
      { slug: "wallet-transactions", mapInput: (a) => ({ address: a.address, network: "base" }) },
      { slug: "token-metadata",      mapInput: (a) => ({ contractAddress: a.address, network: "base" }) },
    ],
  },

  // Gas optimizer: Base gas + Ethereum gas + Base estimate + ETH price.
  "gas-optimizer": {
    mode: "fanout",
    steps: [
      { slug: "gas-snapshot", mapInput: () => ({ network: "base" }) },
      { slug: "gas-snapshot", mapInput: () => ({ network: "ethereum" }) },
      { slug: "gas-estimate", mapInput: () => ({ network: "base" }) },
      { slug: "crypto-price", mapInput: () => ({ coins: "ETH", currency: "usd" }) },
    ],
  },

  // SSL audit: TLS cert + HTTP headers + CAA DNS record.
  "ssl-audit": {
    mode: "fanout",
    steps: [
      { slug: "tls-cert",     mapInput: (a) => ({ host: a.domain }) },
      { slug: "http-headers", mapInput: (a) => ({ url: `https://${a.domain}` }) },
      { slug: "dns-lookup",   mapInput: (a) => ({ host: a.domain, type: "CAA" }) },
    ],
  },

  // Email security: SPF + DMARC + DKIM + deliverability score.
  // dkim-lookup requires a selector — "google" is the most common default
  // (covers Google Workspace, the largest sending platform).
  "email-security": {
    mode: "fanout",
    steps: [
      { slug: "spf-check",            mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dmarc-check",          mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dkim-lookup",          mapInput: (a) => ({ domain: a.domain, selector: "google" }) },
      { slug: "email-deliverability", mapInput: (a) => ({ domain: a.domain }) },
    ],
  },

  // Brand protection: WHOIS + DNS + scam search + headers.
  "brand-protection": {
    mode: "fanout",
    steps: [
      { slug: "whois",        mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dns-lookup",   mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "search",       mapInput: (a) => ({ q: `${a.domain} scam OR phishing`, count: 5 }) },
      { slug: "http-headers", mapInput: (a) => ({ url: `https://${a.domain}` }) },
    ],
  },

  // Competitor scan: tech stack + headers + WHOIS + meta.
  "competitor-scan": {
    mode: "fanout",
    steps: [
      // The pack declares ONE promptArg, `url` ("https://stripe.com"), and every
      // step here read a.domain - so each built "https://undefined" and the
      // pack failed on its own documented example, every call.
      { slug: "tech-stack",   mapInput: (a) => ({ url: siteUrl(a) }) },
      { slug: "http-headers", mapInput: (a) => ({ url: siteUrl(a) }) },
      { slug: "whois",        mapInput: (a) => ({ domain: siteHost(a) }) },
      { slug: "meta",         mapInput: (a) => ({ url: siteUrl(a) }) },
    ],
  },

  // Page audit: extract + meta + headers + robots.
  // Sitemap removed — unreliable (many sites 404 at /sitemap.xml, causes
  // consistent partial-failures without adding actionable signal).
  "page-audit": {
    // Chain, so the sitemap step can read the sitemaps robots.txt DECLARES:
    // stripe.com (the pack's own example) has no /sitemap.xml, its robots names
    // /sitemap/sitemap.xml. The conventional paths are fallbacks only.
    mode: "chain",
    steps: [
      { slug: "extract",      mapInput: (a) => ({ url: a.url }) },
      { slug: "meta",         mapInput: (a) => ({ url: a.url }) },
      { slug: "http-headers", mapInput: (a) => ({ url: a.url }) },
      { slug: "robots-check", mapInput: (a) => ({ url: a.url }) },
      // Advertised and never run until 2026-09-02: the workflow's fifth step.
      { slug: "sitemap",      mapInputs: (a, p) => {
          const origin = new URL(a.url).origin;
          const declared = (p["robots-check"]?.sitemaps ?? []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 3);
          return [...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`].map((url) => ({ url }));
      } },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Light tier — batch 2 (2026-07). All pure-CPU, PoW-eligible.
  // ──────────────────────────────────────────────────────────────────────

  // Full color analysis: color info + contrast check + blindness simulation.
  "color-palette": {
    mode: "fanout",
    steps: [
      { slug: "color",           mapInput: (a) => ({ color: a.color }) },
      { slug: "color-contrast",  mapInput: (a) => ({ foreground: a.color, background: "#ffffff" }) },
      { slug: "color-blindness", mapInput: (a) => ({ color: a.color }) },
    ],
  },

  // Check a password's strength + generate a strong replacement.
  "password-audit": {
    mode: "fanout",
    steps: [
      { slug: "password-strength", mapInput: (a) => ({ password: a.password }) },
      { slug: "password",          mapInput: () => ({ length: "16", symbols: "true", count: "1" }) },
    ],
  },

  // Generate all ID formats at once.
  "uuid-suite": {
    mode: "fanout",
    steps: [
      { slug: "uuid",    mapInput: () => ({}) },
      { slug: "ulid",    mapInput: () => ({}) },
      { slug: "uuid-v5", mapInput: () => ({ name: "test", namespace: "url" }) },
    ],
  },

  // Test a regex against text + get text stats.
  "regex-test": {
    mode: "fanout",
    steps: [
      { slug: "regex",      mapInput: (a) => ({ pattern: a.pattern, text: a.text, flags: a.flags || "g" }) },
      { slug: "text-stats", mapInput: (a) => ({ text: a.text }) },
    ],
  },

  // Calculate + summarize + percentages.
  "math-suite": {
    mode: "fanout",
    steps: [
      { slug: "calc",       mapInput: (a) => ({ expression: a.expression }) },
      { slug: "stats",      mapInput: (a) => ({ numbers: String(a.values || "").split(",").map(Number).filter(Number.isFinite) }) },
      { slug: "percentage", mapInput: (a) => ({ op: "of", a: Number(String(a.values || "").split(",")[0]) || 0, b: Number(String(a.values || "").split(",").reduce((s, v) => s + (Number(v) || 0), 0)) || 1 }) },
    ],
  },

  // Date calculations: diff + add + age.
  // add-time takes a duration string (e.g. "30d", "2h", "1w") not amount/unit.
  "date-math": {
    mode: "fanout",
    steps: [
      { slug: "date-diff", mapInput: (a) => ({ from: a.from, to: a.to }) },
      { slug: "add-time",  mapInput: (a) => ({ date: a.from, duration: "30d" }) },
      { slug: "age",       mapInput: (a) => ({ birthdate: a.from }) },
    ],
  },

  // Compare semantic versions.
  "semver-check": {
    mode: "fanout",
    steps: [
      { slug: "semver",    mapInput: (a) => ({ a: a.a, b: a.b }) },
      { slug: "json-diff", mapInput: (a) => ({ a: { version: a.a }, b: { version: a.b } }) },
    ],
  },

  // Generate placeholder text then analyze it (chain: lorem feeds text-stats).
  "lorem-gen": {
    mode: "chain",
    steps: [
      { slug: "lorem",      mapInput: (a) => ({ words: Number(a.words) || 50 }) },
      { slug: "text-stats", mapInput: (_a, p) => ({ text: p["lorem"]?.text ?? "" }) },
    ],
  },

  // QR code + URL validation.
  "qr-gen": {
    mode: "fanout",
    steps: [
      { slug: "qr",        mapInput: (a) => ({ text: a.text, size: 512 }) },
      { slug: "url-parse",  mapInput: (a) => ({ url: a.text }) },
    ],
  },

  // Statistical analysis suite: summary + correlation + outliers.
  "number-crunch": {
    mode: "fanout",
    steps: [
      { slug: "stats-summary", mapInput: (a) => ({ values: String(a.values || "").split(",").map(Number).filter(Number.isFinite) }) },
      { slug: "correlation",   mapInput: (a) => {
          const vals = String(a.values || "").split(",").map(Number).filter(Number.isFinite);
          return { x: vals, y: vals.map((_, i) => i) };
      } },
      { slug: "outliers",      mapInput: (a) => ({ values: String(a.values || "").split(",").map(Number).filter(Number.isFinite) }) },
    ],
  },

  // Financial calculators: compound interest + amortization + loan comparison.
  "finance-calc": {
    mode: "fanout",
    steps: [
      { slug: "compound-interest", mapInput: (a) => ({ principal: Number(a.principal) || 10000, annualRate: (Number(a.rate) || 7) / 100, years: Number(a.years) || 10, compoundingPerYear: 12 }) },
      { slug: "amortization",      mapInput: (a) => ({ principal: Number(a.principal) || 300000, annualRate: (Number(a.rate) || 6.5) / 100, termYears: Number(a.years) || 30, maxRows: 12 }) },
      { slug: "loan-payment",      mapInput: (a) => ({ principal: Number(a.principal) || 300000, annualRate: (Number(a.rate) || 6.5) / 100, termYears: Number(a.years) || 30 }) },
    ],
  },

  // Convert text to all cases.
  "text-transform": {
    mode: "fanout",
    steps: [
      { slug: "case",    mapInput: (a) => ({ text: a.text, to: "camel" }) },
      { slug: "slugify", mapInput: (a) => ({ text: a.text }) },
      // Second case call with snake — slug collision in the steps array is
      // intentional; nothing downstream reads prior["case"].
      { slug: "case",    mapInput: (a) => ({ text: a.text, to: "snake" }) },
    ],
  },

  // Markdown round-trip: markdown → HTML → markdown (chain).
  "markdown-convert": {
    mode: "chain",
    steps: [
      { slug: "markdown-to-html",  mapInput: (a) => ({ markdown: a.markdown }) },
      { slug: "html-to-markdown",  mapInput: (_a, p) => ({ html: p["markdown-to-html"]?.html ?? "" }) },
      // Advertised and never run until 2026-09-02: the diff IS the fidelity report.
      { slug: "text-diff",         mapInput: (a, p) => ({ a: String(a.markdown ?? ""), b: String(p["html-to-markdown"]?.markdown ?? "") }) },
    ],
  },

  // XML → JSON + format (chain).
  "xml-json": {
    mode: "chain",
    steps: [
      { slug: "xml-to-json", mapInput: (a) => ({ xml: a.xml }) },
      { slug: "json-format", mapInput: (_a, p) => ({ json: JSON.stringify(p["xml-to-json"]?.json ?? {}), indent: 2 }) },
    ],
  },

  // All checksums at once: sha256 + crc32 + multi-digest.
  // checksum tool expects `data` (not `text`) and computes all digests at once.
  "checksum-suite": {
    mode: "fanout",
    steps: [
      { slug: "hash",     mapInput: (a) => ({ text: a.text, algo: "sha256" }) },
      { slug: "crc32",    mapInput: (a) => ({ text: a.text }) },
      { slug: "checksum", mapInput: (a) => ({ data: a.text }) },
    ],
  },

  // Validate identifiers: ISBN + IBAN + credit card.
  "validator-suite": {
    mode: "fanout",
    steps: [
      { slug: "isbn-validate", mapInput: () => ({ isbn: "978-3-16-148410-0" }) },
      { slug: "iban-validate", mapInput: (a) => ({ iban: a.iban }) },
      { slug: "card-validate", mapInput: (a) => ({ number: a.number || "4242424242424242" }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Standard-tier batch 2 (2026-07): mid-value bundles ($0.05–$0.12).
  // ──────────────────────────────────────────────────────────────────────

  // Quick research brief: search + answer on a topic.
  "article-digest": {
    mode: "fanout",
    steps: [
      { slug: "search", mapInput: (a) => ({ q: a.topic, count: 5 }) },
      { slug: "answer", mapInput: (a) => ({ q: a.topic }) },
      // Advertised and never run until 2026-09-02: the workflow's third step.
      { slug: "search-news", mapInput: (a) => ({ q: a.topic, count: 5, freshness: "pw" }) },
    ],
  },

  // Full PDF processing: metadata + markdown + first page.
  "pdf-pipeline": {
    mode: "fanout",
    steps: [
      { slug: "pdf-info",          mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-to-markdown",   mapInput: (a) => ({ url: a.url }) },
      { slug: "pdf-extract-pages", mapInput: (a) => ({ url: a.url, pages: "1" }) },
    ],
  },

  // URL health + metadata check.
  "url-inspector": {
    mode: "fanout",
    steps: [
      { slug: "url-parse",  mapInput: (a) => ({ url: a.url }) },
      { slug: "http-check", mapInput: (a) => ({ url: a.url }) },
      { slug: "meta",       mapInput: (a) => ({ url: a.url }) },
    ],
  },

  // Content quality grading — chain because keywords needs extracted text.
  "content-grade": {
    mode: "chain",
    steps: [
      { slug: "extract",  mapInput: (a) => ({ url: a.url }) },
      { slug: "keywords", mapInput: (_a, p) => ({ text: p["extract"]?.markdown || "" }) },
      // Advertised and never run until 2026-09-02: the other half of the grade.
      { slug: "readability-score", mapInput: (_a, p) => {
          const text = p["extract"]?.markdown || "";
          if (!text.trim()) throw Object.assign(new Error("nothing extracted to score"), { statusCode: 422 });
          return { text };
      } },
    ],
  },

  // OpenAPI spec audit: lint + validate.
  // Every step here was passing the caller's URL where the tool wants the
  // DOCUMENT, and validate-payload was missing its required "part" and aimed
  // at a hardcoded "get /" no real spec declares - so all steps failed on
  // every call. openapi-security-summary is advertised in the pack's own
  // toolSlugs and was never wired at all.
  "openapi-audit": {
    mode: "fanout",
    steps: [
      { slug: "openapi-lint",             mapInput: async (a) => ({ spec: await fetchOpenApiSpec(a.url) }) },
      { slug: "openapi-validate-payload", mapInput: async (a) => {
          const spec = await fetchOpenApiSpec(a.url);
          const { path, method } = firstOperation(spec);
          return { spec, part: "request", method, path, payload: {} };
      } },
      { slug: "openapi-security-summary", mapInput: async (a) => ({ spec: await fetchOpenApiSpec(a.url) }) },
    ],
  },

  // JSON validate + format + convert to CSV.
  "json-pipeline": {
    mode: "fanout",
    steps: [
      { slug: "json-validate", mapInput: (a) => {
          let data = a.json;
          if (typeof data === "string") try { data = JSON.parse(data); } catch {}
          return { data, schema: {} };
      } },
      { slug: "json-format",   mapInput: (a) => ({ json: a.json, indent: 2 }) },
      { slug: "json-to-csv",   mapInput: (a) => {
          let json = a.json;
          if (typeof json === "string") try { json = JSON.parse(json); } catch {}
          return { json };
      } },
    ],
  },

  // CSV → JSON → YAML pipeline (chain: json-to-yaml needs csv-to-json output).
  "data-convert": {
    mode: "chain",
    steps: [
      { slug: "csv-to-json", mapInput: (a) => ({ csv: a.csv }) },
      { slug: "json-to-yaml", mapInput: (_a, p) => ({ json: p["csv-to-json"]?.rows ?? p["csv-to-json"] ?? [] }) },
    ],
  },

  // API endpoint health: liveness + headers + TLS.
  "api-health": {
    mode: "fanout",
    steps: [
      { slug: "http-check",   mapInput: (a) => ({ url: a.url }) },
      { slug: "http-headers", mapInput: (a) => ({ url: a.url }) },
      { slug: "tls-cert",     mapInput: (a) => {
          let host = a.url;
          try { host = new URL(a.url).hostname; } catch {}
          return { host };
      } },
    ],
  },

  // World Bank GDP + population for a country.
  "world-data": {
    mode: "fanout",
    steps: [
      { slug: "world-bank-indicator", mapInput: (a) => ({ country: a.country, indicator: "NY.GDP.MKTP.CD" }) },
      { slug: "world-bank-indicator", mapInput: (a) => ({ country: a.country, indicator: "SP.POP.TOTL" }) },
    ],
  },

  // Fed economic snapshot: FEDFUNDS + UNRATE + CPIAUCSL.
  // Every step sent `series` where fred-series requires `seriesId`, so all
  // three 400'd on every call - 33 of 33 step calls in 60 days of PRODUCTION
  // telemetry, where the FRED key exists. The pack has no promptArgs, so this
  // was not a bad caller input: it could never have worked for anyone.
  "fred-snapshot": {
    mode: "fanout",
    steps: [
      { slug: "fred-series", mapInput: () => ({ seriesId: "FEDFUNDS" }) },
      { slug: "fred-series", mapInput: () => ({ seriesId: "UNRATE" }) },
      { slug: "fred-series", mapInput: () => ({ seriesId: "CPIAUCSL" }) },
    ],
  },

  // Email verification: validate + MX check.
  "contact-verify": {
    mode: "fanout",
    steps: [
      { slug: "email-validate", mapInput: (a) => ({ email: a.email }) },
      { slug: "dns-lookup",     mapInput: (a) => {
          const domain = String(a.email || "").split("@")[1] || "";
          return { host: domain, type: "MX" };
      } },
      // Advertised and never run until 2026-09-02: the workflow's third step.
      { slug: "spf-check",      mapInput: (a) => ({ domain: String(a.email || "").split("@")[1] || "" }) },
    ],
  },

  // Domain age: whois + DNS + TLS.
  "domain-age": {
    mode: "fanout",
    steps: [
      { slug: "whois",      mapInput: (a) => ({ domain: a.domain }) },
      { slug: "dns-lookup", mapInput: (a) => ({ host: a.domain, type: "A" }) },
      { slug: "tls-cert",   mapInput: (a) => ({ host: a.domain }) },
    ],
  },

  // All three major hashes at once.
  "hash-verify": {
    mode: "fanout",
    steps: [
      { slug: "hash", mapInput: (a) => ({ text: a.text, algo: "sha256" }) },
      { slug: "hash", mapInput: (a) => ({ text: a.text, algo: "sha512" }) },
      { slug: "hash", mapInput: (a) => ({ text: a.text, algo: "md5" }) },
    ],
  },

  // Encode text in all formats.
  "encoding-suite": {
    mode: "fanout",
    steps: [
      { slug: "base64",   mapInput: (a) => ({ text: a.text, mode: "encode" }) },
      { slug: "hex",      mapInput: (a) => ({ text: a.text, mode: "encode" }) },
      { slug: "url-code", mapInput: (a) => ({ text: a.text, mode: "encode" }) },
    ],
  },

  // JWT decode + verify.
  "jwt-toolkit": {
    // Chain, not fanout: jwt-sign re-issues the claims jwt-decode read (the
    // workflow's third step, advertised and never run until 2026-09-02).
    mode: "chain",
    steps: [
      { slug: "jwt-decode",  mapInput: (a) => ({ token: a.token }) },
      { slug: "jwt-verify",  mapInput: (a) => ({ token: a.token, secret: "test" }) },
      { slug: "jwt-sign",    mapInput: (_a, p) => {
          const payload = p["jwt-decode"]?.payload;
          if (!payload || typeof payload !== "object" || !Object.keys(payload).length) {
            throw Object.assign(new Error("no claims decoded to re-sign"), { statusCode: 422 });
          }
          return { payload, secret: "test", alg: "HS256" };
      } },
    ],
  },

  // Timezone conversion + business days + cron preview.
  "timezone-planner": {
    mode: "fanout",
    steps: [
      { slug: "time-convert",  mapInput: (a) => ({ value: a.time, tz: a.to || "Asia/Tokyo" }) },
      { slug: "business-days", mapInput: (a) => ({ from: new Date().toISOString().slice(0, 10), to: String(a.time || "").slice(0, 10) }) },
      { slug: "cron-next",     mapInput: (a) => ({ expr: "0 10 * * 1", count: 5, from: a.time }) },
    ],
  },

  // Text stats + keywords + token count.
  "text-analyze": {
    mode: "fanout",
    steps: [
      { slug: "text-stats",  mapInput: (a) => ({ text: a.text }) },
      { slug: "keywords",    mapInput: (a) => ({ text: a.text }) },
      { slug: "token-count", mapInput: (a) => ({ text: a.text }) },
    ],
  },

  // Content cleaning: redact + dedupe + sort.
  "content-clean": {
    mode: "fanout",
    steps: [
      { slug: "redact",       mapInput: (a) => ({ text: a.text, patterns: ["email", "phone"] }) },
      { slug: "dedupe-lines", mapInput: (a) => ({ text: a.text }) },
      { slug: "sort-lines",   mapInput: (a) => ({ text: a.text }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Strategy additions (2026-07): packs that were in SKILL_PACKS but
  // previously fell through to TODO_MAPINPUT.
  // ──────────────────────────────────────────────────────────────────────

  // Weather briefing: current conditions + 7-day forecast + air quality.
  "weather-brief": {
    mode: "fanout",
    steps: [
      { slug: "weather-current",     mapInput: (a) => ({ lat: Number(a.lat), lon: Number(a.lon) }) },
      { slug: "weather-daily",       mapInput: (a) => ({ lat: Number(a.lat), lon: Number(a.lon), days: 7 }) },
      { slug: "weather-air-quality", mapInput: (a) => ({ lat: Number(a.lat), lon: Number(a.lon) }) },
    ],
  },

  // Cross-asset price monitor: stock vs crypto side-by-side with history.
  "price-monitor": {
    mode: "fanout",
    steps: [
      { slug: "stock-quote",    mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "stock-history",  mapInput: (a) => ({ symbol: a.ticker, range: "1y" }) },
      { slug: "crypto-price",   mapInput: (a) => ({ coins: a.coin, currency: "usd" }) },
      { slug: "crypto-history", mapInput: (a) => ({ coin: a.coin, days: "365", currency: "usd" }) },
      { slug: "date-format",    mapInput: () => ({ datetime: new Date().toISOString() }) },
    ],
  },

  // Content quality report: readability + word frequency + slug generation.
  "content-quality": {
    mode: "fanout",
    steps: [
      { slug: "readability-score", mapInput: (a) => ({ text: a.text }) },
      { slug: "word-frequency",    mapInput: (a) => ({ text: a.text, top: 10 }) },
      { slug: "slug-generate",     mapInput: (a) => ({ text: a.title || String(a.text || "").split(/[.!?]/)[0] || "" }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // "The 500" phase-2 packs (2026-07): whole-agent jobs on the new
  // contract / finance / enrich / web / conversion tools.
  // ──────────────────────────────────────────────────────────────────────

  // Pre-interaction contract triage: source → heuristic scan → selector →
  // label → read-only dry-run. Chain mode so solidity-scan reads the fetched
  // source from prior["contract-source"]. Unverified contracts make the scan
  // step fail cleanly ("no source") — that absence is itself the finding.
  "contract-audit": {
    mode: "chain",
    steps: [
      { slug: "contract-source", mapInput: (a) => ({ address: a.address, network: a.network || "base" }) },
      { slug: "solidity-scan",   mapInput: (_a, p) => ({
          source: Object.values(p["contract-source"]?.sources ?? {}).join("\n\n"),
      }) },
      // Resolve the selector of the calldata the agent intends to send.
      // Default probe is balanceOf(address) — succeeds on any ERC-20.
      { slug: "selector-lookup", mapInput: (a) => ({
          selector: String(a.data || "0x70a08231").slice(0, 10),
      }) },
      { slug: "address-label",   mapInput: (a) => ({ address: a.address }) },
      { slug: "tx-simulate",     mapInput: (a) => ({
          to: a.address,
          data: a.data || "0x70a08231000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d0",
          network: a.network || "base",
      }) },
    ],
  },

  // Transaction post-mortem: status → raw tx → decoded calldata → selector →
  // counterparty label. Chain mode so calldata-decode / selector-lookup /
  // address-label read the input calldata and `to` address from the
  // eth_getTransactionByHash result. A pending/unknown hash surfaces as
  // per-step partial failures — the envelope still tells the whole story.
  "tx-forensics": {
    mode: "chain",
    steps: [
      { slug: "tx-status",       mapInput: (a) => ({ hash: a.hash, network: a.network || "base" }) },
      { slug: "evm-rpc",         mapInput: (a) => ({
          network: a.network || "base",
          method: "eth_getTransactionByHash",
          params: [a.hash],
      }) },
      { slug: "calldata-decode", mapInput: (_a, p) => ({
          data: p["evm-rpc"]?.result?.input ?? "0x",
      }) },
      { slug: "selector-lookup", mapInput: (_a, p) => ({
          selector: String(p["evm-rpc"]?.result?.input ?? "").slice(0, 10),
      }) },
      { slug: "address-label",   mapInput: (_a, p) => ({
          address: p["evm-rpc"]?.result?.to ?? p["tx-status"]?.to ?? "",
      }) },
    ],
  },

  // Pre-open trading snapshot: four ticker reads + today's market-wide
  // earnings calendar. The earnings step deliberately does NOT filter by the
  // ticker — earnings-calendar returns companies reporting on ONE date
  // (defaults today; symbol is only a filter), so a ticker filter comes back
  // empty on almost every day and always for ETFs. The market-wide list
  // ("which prints hit the tape today") is the useful pre-open context.
  "market-open": {
    mode: "fanout",
    steps: [
      { slug: "stock-quote",       mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "premarket-quote",   mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "options-chain",     mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "stock-dividends",   mapInput: (a) => ({ symbol: a.ticker }) },
      { slug: "earnings-calendar", mapInput: () => ({}) },
    ],
  },

  // KYB-style identity dossier: six independent lookups keyed off the
  // company name / domain / ticker. Private companies fail the EDGAR step
  // cleanly (partial-success) — the absence is part of the dossier.
  "entity-enrich": {
    mode: "fanout",
    steps: [
      { slug: "wikidata-entity",      mapInput: (a) => ({ name: a.name }) },
      { slug: "lei-lookup",           mapInput: (a) => ({ name: a.name }) },
      { slug: "edgar-company-lookup", mapInput: (a) => ({ ticker: a.ticker || a.name }) },
      { slug: "whois",                mapInput: (a) => ({ domain: a.domain || "" }) },
      { slug: "tech-stack",           mapInput: (a) => ({ url: `https://${a.domain || ""}` }) },
      { slug: "favicon-grab",         mapInput: (a) => ({ url: `https://${a.domain || ""}` }) },
    ],
  },

  // Feed monitoring loop: parse → read the top story → keyword the cycle →
  // diff against the previous run's snapshot. Chain mode so extract /
  // keywords / text-diff all read the parsed items from prior["feed-parse"].
  "feed-watch": {
    mode: "chain",
    steps: [
      { slug: "feed-parse", mapInput: (a) => ({ url: a.url, limit: 10 }) },
      // The newest item is whichever page the publisher put first that minute,
      // and some of those pages are not extractable (paywall shell, video
      // page, a JS-only article). Reading only items[0] failed the pack's own
      // published example in CI on 2026-09-02 and passed on the next four runs
      // - a publisher lottery, charged to the buyer as a missing step. Walk the
      // newest items until one reads (same treatment as crypto-dossier).
      { slug: "extract",    mapInputs: (_a, p) => {
          const links = (p["feed-parse"]?.items ?? []).map((it) => it?.link).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
          return [...new Set(links)].slice(0, 6).map((url) => ({ url }));
      } },
      { slug: "keywords",   mapInput: (_a, p) => ({
          text: (p["feed-parse"]?.items ?? [])
            .map((it) => [it?.title, it?.summary].filter(Boolean).join(" - "))
            .join("\n"),
          limit: 10,
      }) },
      // Added lines in the diff = items that appeared since the last run.
      // First run: pass no `previous` — everything shows as new.
      { slug: "text-diff",  mapInput: (a, p) => ({
          a: typeof a.previous === "string" ? a.previous : "",
          b: (p["feed-parse"]?.items ?? []).map((it) => String(it?.title ?? "")).join("\n"),
      }) },
    ],
  },

  // JSON contract test: validate → infer → drift-diff → normalize. Pure CPU.
  // Chain mode so json-diff compares the caller's expected schema against
  // the schema inferred from the live payload in prior["json-schema-infer"].
  "schema-guard": {
    mode: "chain",
    steps: [
      { slug: "json-validate",     mapInput: (a) => {
          let data = a.payload;
          if (typeof data === "string") try { data = JSON.parse(data); } catch {}
          let schema = a.schema ?? {};
          if (typeof schema === "string") try { schema = JSON.parse(schema); } catch {}
          return { data, schema };
      } },
      { slug: "json-schema-infer", mapInput: (a) => {
          let json = a.payload;
          if (typeof json === "string") try { json = JSON.parse(json); } catch {}
          return { json };
      } },
      { slug: "json-diff",         mapInput: (a, p) => {
          let schema = a.schema ?? {};
          if (typeof schema === "string") try { schema = JSON.parse(schema); } catch {}
          return { a: schema, b: p["json-schema-infer"]?.schema ?? {} };
      } },
      { slug: "json-format",       mapInput: (a) => ({
          json: typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload ?? null),
          indent: 2,
      }) },
    ],
  },

  // Audio → subtitles → stats. Chain mode: srt-convert and text-stats both
  // consume the transcript from prior["transcribe"]. The transcript arrives
  // untimed (text + total duration), so it becomes a single full-length cue —
  // agents needing per-line timing re-call srt-convert with their own cues.
  "subtitle-pipeline": {
    mode: "chain",
    steps: [
      { slug: "transcribe",  mapInput: (a) => ({ url: a.url }) },
      { slug: "srt-convert", mapInput: (a, p) => {
          const t = p["transcribe"] ?? {};
          const ms = Math.max(1000, Math.round((Number(t.duration) || 1) * 1000));
          return {
            cues: [{ start: 0, end: ms, text: String(t.text ?? "") }],
            to: a.format || "vtt",
          };
      } },
      { slug: "text-stats",  mapInput: (_a, p) => ({
          text: String(p["transcribe"]?.text ?? ""),
      }) },
    ],
  },

  // "Can I reach this counterparty this week?" — chain mode so the holiday
  // and timezone steps key off the country code / primary timezone resolved
  // by country-info.
  "locale-brief": {
    mode: "chain",
    steps: [
      { slug: "country-info",     mapInput: (a) => ({ name: a.country }) },
      { slug: "public-holidays",  mapInput: (_a, p) => ({
          country: p["country-info"]?.country?.code2 ?? "US",
          year: new Date().getUTCFullYear(),
      }) },
      { slug: "business-days",    mapInput: () => {
          const from = new Date();
          const to = new Date(from.getTime() + 7 * 86400_000);
          return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
      } },
      { slug: "timezone-convert", mapInput: (_a, p) => ({
          datetime: new Date().toISOString().slice(0, 19),
          from: "UTC",
          to: p["country-info"]?.country?.timezones?.[0] ?? "UTC",
      }) },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // End of PACK_STEPS. getStepConfig auto-stubs any SKILL_PACKS entry that
  // lands here without a matching PACK_STEPS row.
  // ──────────────────────────────────────────────────────────────────────
};

// Pull the first URL out of a comma/newline-separated list for the
// content-extraction pack's single-URL chain.
function firstUrl(urls) {
  if (!urls) return "";
  return String(urls).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)[0] || "";
}

// Pull a closes/values series out of whichever fetcher succeeded in the
// forecasting-bake-off chain. stock-history wins for tickers (returns bars
// with .close); fred-series wins for FRED ids (returns observations with
// .value). Returns the first non-empty source.
function bakeOffValues(prior) {
  const fromStock = (prior?.["stock-history"]?.bars ?? [])
    .map((b) => Number(b?.close))
    .filter(Number.isFinite);
  if (fromStock.length) return fromStock;
  const fromFred = (prior?.["fred-series"]?.observations ?? [])
    .map((o) => Number(o?.value))
    .filter(Number.isFinite);
  return fromFred;
}

// Fetch a URL and return its bytes as base64. Used by media-pipeline's chain
// because image-kit tools take base64 inputs while media-info / audio-normalize
// take URLs — the chain needs to bridge between the two shapes.
// openapi-audit takes a URL, but every openapi-* tool takes the DOCUMENT
// ("object or JSON string") - the pack was handing them the URL string, so
// all three steps failed on every call. Fetch once and share: the pack fans
// out, so without the in-flight dedupe one audit is three fetches of the same
// spec. Caller-supplied URL, so it MUST route through safeFetch (SSRF guard +
// byte cap), never raw fetch.
const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const specInFlight = new Map();
async function fetchOpenApiSpec(url) {
  if (typeof url !== "string" || !url) {
    throw Object.assign(new Error('Missing or invalid "url" for the OpenAPI spec'), { statusCode: 400 });
  }
  if (!specInFlight.has(url)) {
    const p = (async () => {
      // safeFetch names the text body `html` whatever the content type is.
      const { html } = await safeFetch(url, { maxBytes: MAX_SPEC_BYTES });
      const text = typeof html === "string" ? html : "";
      try {
        return JSON.parse(text);
      } catch {
        // These tools parse JSON only (api-kit has no YAML parser), so say
        // that rather than letting each step fail with its own parse error.
        throw Object.assign(
          new Error(`the spec at ${url} is not JSON - these tools read a JSON OpenAPI document`),
          { statusCode: 422 }
        );
      }
    })().finally(() => specInFlight.delete(url));
    specInFlight.set(url, p);
  }
  return specInFlight.get(url);
}

// structured-scrape's whole purpose is pulling structured data out of a page
// with CSS selectors, and its html-select / html-table / html-strip steps were
// fed `render.markdown` - markdown has no <table> and no class attributes, so
// html-table could never match on any page and the selector step matched only
// by accident. render returns markdown ONLY (no raw html field), so the HTML
// has to be fetched. Same shape as fetchOpenApiSpec: safeFetch for the SSRF
// guard and byte cap on a caller-supplied URL, in-flight dedupe so three steps
// in one pack are one request.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const htmlInFlight = new Map();
async function fetchPageHtml(url) {
  if (typeof url !== "string" || !url) {
    throw Object.assign(new Error('Missing or invalid "url"'), { statusCode: 400 });
  }
  if (!htmlInFlight.has(url)) {
    const p = (async () => {
      const { html } = await safeFetch(url, { maxBytes: MAX_HTML_BYTES });
      return typeof html === "string" ? html : "";
    })().finally(() => htmlInFlight.delete(url));
    htmlInFlight.set(url, p);
  }
  return htmlInFlight.get(url);
}

// The first concrete operation in a spec, for tools that need one named.
// Guessing "get /" failed on every real spec, petstore included.
function firstOperation(spec) {
  const paths = spec?.paths && typeof spec.paths === "object" ? spec.paths : {};
  const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) if (item[method]) return { path, method };
  }
  throw Object.assign(new Error("the spec declares no operations to validate against"), { statusCode: 422 });
}

// competitor-scan declares `url` but its steps were written against `domain`.
// Accept whichever the caller supplied and derive the other, so neither
// spelling can produce the "https://undefined" the pack used to build.
function siteHost(args) {
  const raw = String(args?.domain || args?.url || "").trim();
  if (!raw) throw Object.assign(new Error('Missing "url" (e.g. "https://stripe.com")'), { statusCode: 400 });
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    throw Object.assign(new Error(`"${raw}" is not a usable URL or domain`), { statusCode: 400 });
  }
}
function siteUrl(args) {
  return `https://${siteHost(args)}`;
}

async function fetchAsBase64(url) {
  // The URL is caller-supplied, so this MUST route through safeFetch — it enforces
  // the SSRF guard (blocks private/link-local IPs, DNS-rebind, redirect-to-private)
  // and a byte cap. A raw fetch() here was an SSRF hole (internal/metadata exfil).
  const { buffer } = await safeFetch(url, { binary: true, maxBytes: MAX_FETCH_BASE64_BYTES });
  return buffer.toString("base64");
}

// Auto-generate a step config for any pack not explicitly in PACK_STEPS.
// All steps get TODO_MAPINPUT — they fail cleanly with statusCode 501 but
// the envelope is well-formed and other steps still execute.
function getStepConfig(packSlug, packIndex) {
  if (PACK_STEPS[packSlug]) return PACK_STEPS[packSlug];
  const pack = packIndex.get(packSlug);
  if (!pack) return null;
  return {
    mode: "fanout",
    steps: pack.toolSlugs.map((slug) => ({ slug, mapInput: TODO_MAPINPUT })),
  };
}

// Look up a handler for a tool slug. Tries inline handlers first (for routes
// bound directly in src/server.js), then falls back to catalog tools'
// .handler property.
function lookupHandler(slug, { catalog, inlineHandlers }) {
  if (inlineHandlers && typeof inlineHandlers[slug] === "function") {
    return inlineHandlers[slug];
  }
  for (const tool of Object.values(catalog)) {
    if (tool.slug === slug && typeof tool.handler === "function") return tool.handler;
  }
  return null;
}

// Core orchestration. Walks the pack's steps, invoking each underlying tool's
// handler with the mapped input. Captures result on success, partial-failure
// envelope on error. Returns the bundled response envelope.
// Argument names whose VALUE is a credential. Matched on the name because packs
// declare their inputs by name and a caller cannot rename them.
const SECRET_ARG_NAMES = /^(secret|token|key|password|passphrase|api[_-]?key|signing[_-]?secret|bearer|authorization)$/i;
function redactSecretArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = SECRET_ARG_NAMES.test(k) && v ? "[redacted]" : v;
  return out;
}

async function runPack(packSlug, args, ctx) {
  const pack = ctx.packIndex.get(packSlug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown pack: ${packSlug}`), { statusCode: 404 });
  }
  const config = getStepConfig(packSlug, ctx.packIndex);
  const prior = {};

  const runStep = async (step) => {
    // Internal steps bypass the HTTP route, so tool_call never sees them —
    // this event is what lets cost reconciliations attribute upstream spend
    // (e.g. Brave answer) to pack fan-out. Fire-and-forget, never throws.
    const startedAt = Date.now();
    // A step may declare `when(args, prior)`: false = this leg does not apply
    // to THIS input (trend-analysis: fred-series when the series was an equity
    // ticker that stock-history already served). A skipped leg is reported as
    // skipped, never as a failure the buyer paid for, and never counts toward
    // "N/M succeeded" (2026-09-02; before this the only way to express a
    // conditional leg was to let the loser fail, charged as a partial result).
    if (typeof step.when === "function") {
      let applies = true;
      try { applies = !!(await step.when(args, prior)); } catch { applies = true; }
      if (!applies) return { slug: step.slug, ok: true, skipped: true, reason: step.skipReason || "not applicable to this input" };
    }
    try {
      const handler = lookupHandler(step.slug, ctx);
      if (!handler) {
        throw Object.assign(
          new Error(`No in-process handler for slug "${step.slug}" - wire via INLINE_HANDLERS in server.js`),
          { statusCode: 501 }
        );
      }
      // A step may offer several candidate inputs instead of one. Tried in
      // order, first success wins. This exists because crypto-dossier's
      // extract step reads whichever news site happened to rank first, and
      // measured over 60 days it failed 43.5% of the time (37 of 85 runs)
      // while every other step in the pack was 100% - a coin flip on the
      // publisher, charged to the buyer as a missing step. Falling back to
      // the next search result costs one more attempt and no upstream money.
      const candidates = typeof step.mapInputs === "function"
        ? await step.mapInputs(args, prior)
        : [await step.mapInput(args, prior)];
      const inputs = (Array.isArray(candidates) ? candidates : [candidates]).filter((i) => i != null);
      if (!inputs.length) {
        throw Object.assign(new Error("no usable input for this step"), { statusCode: 424 });
      }
      let lastErr;
      for (const input of inputs) {
        try {
          const result = await handler(input);
          prior[step.slug] = result;
          capturePostHogPackStep({ pack: packSlug, slug: step.slug, ok: true, ms: Date.now() - startedAt });
          return { slug: step.slug, ok: true, result };
        } catch (err) { lastErr = err; }
      }
      throw lastErr;
    } catch (err) {
      capturePostHogPackStep({ pack: packSlug, slug: step.slug, ok: false, ms: Date.now() - startedAt });
      return {
        slug: step.slug,
        ok: false,
        error: err.message,
        statusCode: err.statusCode || 500,
      };
    }
  };

  let steps;
  if (config.mode === "chain") {
    steps = [];
    for (const s of config.steps) steps.push(await runStep(s));
  } else {
    steps = await Promise.all(config.steps.map(runStep));
  }

  const attempted = steps.filter((s) => !s.skipped);
  const okCount = attempted.filter((s) => s.ok).length;
  // Zero successful steps is not a partial success, it is a non-delivery, and
  // a 200 charges for it: @x402/express settles any response under 400. Four
  // packs shipped in exactly that state for two months. Refuse instead, so
  // settlement is cancelled and nobody pays for an empty envelope.
  //
  // The status is derived from the steps rather than fixed: if every failure
  // was the caller's input (4xx), 400 is the honest answer and a 502 would
  // blame an upstream that was never at fault; anything else is ours or the
  // upstream's, so 502.
  if (attempted.length > 0 && okCount === 0) {
    const allClientErrors = attempted.every((s) => s.statusCode >= 400 && s.statusCode < 500);
    const reasons = attempted.map((s) => `${s.slug}: ${s.error}`).join("; ");
    throw Object.assign(
      new Error(`No step in the "${packSlug}" pack succeeded, so there is nothing to return (not charged). ${reasons}`),
      { statusCode: allClientErrors ? 400 : 502 }
    );
  }
  return {
    pack: packSlug,
    // Echo the caller's args back MINUS anything named as a secret. The pack that
    // takes one says in its own schema "the provider signing secret (never echoed
    // back)", and the step result honours that - but this envelope was handing it
    // straight back in the response body, where it lands in agent transcripts and
    // MCP logs. Only ever visible to the caller who supplied it, so not an
    // escalation; it is a stated guarantee the code did not keep.
    args: redactSecretArgs(args),
    steps,
    summary: `${okCount}/${attempted.length} steps succeeded${steps.length > attempted.length ? ` (${steps.length - attempted.length} skipped as not applicable)` : ""}`,
  };
}

// Factory — produces the 42 skill tool definitions to splice into ALL_KIT.
// getCatalog is a thunk so handler closures see the fully-populated CATALOG
// at call time (after the ALL_KIT loop has finished populating it).
export function buildSkillTools({ getCatalog, inlineHandlers = {} }) {
  const packIndex = new Map(SKILL_PACKS.map((p) => [p.slug, p]));

  return SKILL_PACKS.map((pack) => {
    const slug = pack.slug;
    const price = PACK_PRICES[slug] ?? 0.05;
    const route = `POST /api/skill/${slug}`;
    const exampleArgs = Object.fromEntries(
      (pack.promptArgs || []).map((a) => [a.name, a.substitute])
    );
    return {
      route,
      name: `Skill: ${pack.title}`,
      slug: `skill-${slug}`,
      category: "skill-pack",
      price: `$${price.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}` /* whole milli-dollars: the derived pack price is charged as derived, never rounded to a cent */,
      description:
        `Bundled execution of the ${pack.title} workflow - ${pack.tagline} ` +
        `One x402 payment runs ${pack.toolSlugs.length} underlying tools (${pack.toolSlugs.join(", ")}); ` +
        `partial-success per step.`,
      tags: ["skill-pack", "workflow", slug],
      discovery: {
        bodyType: "json",
        input: exampleArgs,
        inputSchema: {
          properties: Object.fromEntries(
            (pack.promptArgs || []).map((a) => [
              a.name,
              { type: "string", description: a.description },
            ])
          ),
          required: (pack.promptArgs || []).filter((a) => a.required).map((a) => a.name),
        },
        output: {
          example: {
            pack: slug,
            args: exampleArgs,
            steps: pack.toolSlugs.map((s) => ({ slug: s, ok: true, result: {} })),
            summary: `${pack.toolSlugs.length}/${pack.toolSlugs.length} steps succeeded`,
          },
        },
      },
      handler: async (input) =>
        runPack(slug, input, {
          catalog: getCatalog(),
          inlineHandlers,
          packIndex,
        }),
    };
  });
}

// Test surface — used by scripts/test-skill-runner.js.
export const __test = {
  runPack,
  lookupHandler,
  getStepConfig,
  defaultMapInput,
  todoError,
};
