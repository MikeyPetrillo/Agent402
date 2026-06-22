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
// ──────────────────────────────────────────────────────────────────────────
// learning-mode v1 TODOs left for the user:
//
//   (1) PACK_STEPS — fill in `mapInput` functions for each of the 39 packs.
//       Two worked examples (security-audit, trend-analysis) and one premium
//       worked example (financial-research) show the patterns. Packs not yet
//       in PACK_STEPS auto-generate from SKILL_PACKS with TODO_MAPINPUT for
//       every step; those steps return {ok: false, error: "mapInput not yet
//       implemented", statusCode: 501} so the envelope is still well-formed.
//
//   (2) INLINE_HANDLERS in src/server.js — wire any inline-bound routes that
//       a pack references (extract, meta, dns, render, pdf, screenshot). The
//       runner looks here before falling back to catalog tool.handler.
// ──────────────────────────────────────────────────────────────────────────

import { SKILL_PACKS } from "../skills.js";

// Sentinel error thrown by stub mapInput functions. The runner converts it to
// a per-step partial-failure {ok:false, statusCode:501} so the rest of the
// pack still runs and the envelope shape stays consistent.
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
export const PACK_PRICES = {
  // Premium (~8x sum-of-tools)
  "financial-research":   1.50,
  "sec-filings-deep-dive": 0.85,
  "macro-context":         0.75,
  "crypto-research":       0.70,
  "regulatory-watch":      0.70,
  "search-and-cite":       0.65,
  "macro-economics":       0.65,
  // Standard (~5x)
  "content-extraction":    0.30,
  "media-pipeline":        0.25,
  "document-intel":        0.20,
  "trend-analysis":        0.20,
  "any-to-markdown":       0.20,
  "structured-scrape":     0.20,
  "forecasting-bake-off":  0.20,
  "fraud-signals":         0.15,
  "security-audit":        0.12,
  "link-preview":          0.12,
  "api-investigation":     0.10,
  "email-deliverability":  0.10,
  "location-intel":        0.10,
  "dns-network-ops":       0.08,
  "status-snapshot":       0.07,
  "schema-evolution":      0.06,
  // Light ($0.05 floor — pure-CPU bundles, PoW-eligible)
  "text-hygiene":          0.05,
  "decode-blob":           0.05,
  "csv-profile":           0.05,
  "meeting-scheduler":     0.05,
  "jwt-forensics":         0.05,
  "user-onboarding":       0.05,
  "data-interchange":      0.05,
  "rag-prep":              0.05,
  "webhook-debug":         0.05,
  "a11y-audit":            0.05,
  "trip-planner":          0.05,
  "identity-mint":         0.05,
  "loan-comparison":       0.05,
  "investment-decision":   0.05,
  "retirement-planning":   0.05,
  "savings-goal":          0.05,
};

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
// THREE WORKED EXAMPLES are populated below. The remaining 36 packs are
// auto-stubbed with TODO_MAPINPUT for every step (see getStepConfig). The
// user fills these in — typically 1–3 lines per step.
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
      // Yahoo bars come back as [{time,open,high,low,close,volume}]; downstream
      // steps pull close[] from .bars (not a top-level .close array).
      { slug: "stock-history", mapInput: (a) => ({ symbol: a.series, range: a.horizon || "1y" }) },
      { slug: "stats-summary",   mapInput: (_a, p) => ({ values: (p["stock-history"]?.bars ?? []).map((b) => b.close) }) },
      { slug: "moving-average",  mapInput: (_a, p) => ({ values: (p["stock-history"]?.bars ?? []).map((b) => b.close), window: 20, which: "both" }) },
      { slug: "linear-regression", mapInput: (_a, p) => {
          const close = (p["stock-history"]?.bars ?? []).map((b) => b.close);
          return { x: close.map((_, i) => i), y: close };
      } },
      { slug: "outliers",        mapInput: (_a, p) => ({ values: (p["stock-history"]?.bars ?? []).map((b) => b.close) }) },
      // Correlation needs two series — self-correlation is a placeholder that
      // returns 1.0; agents will typically pass a benchmark via a follow-up
      // call. Replace with a real benchmark fetch (e.g. SPY) when ready.
      { slug: "correlation",     mapInput: (_a, p) => {
          const close = (p["stock-history"]?.bars ?? []).map((b) => b.close);
          return { x: close, y: close };
      } },
      // forecast-eval requires testSize + method. Default to drift on ~10% of
      // the series (min 5) — a reasonable backtest size; agents can re-call
      // forecast-eval directly to sweep methods if they want a model comparison.
      { slug: "forecast-eval",   mapInput: (_a, p) => {
          const close = (p["stock-history"]?.bars ?? []).map((b) => b.close);
          const testSize = Math.max(5, Math.floor(close.length / 10));
          return { values: close, testSize, method: "drift" };
      } },
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
      // FRED needs an explicit series id — fed funds is the default macro signal.
      { slug: "fred-series",         mapInput: () => ({ series: "FEDFUNDS" }) },
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
      { slug: "html-select", mapInput: (_a, p) => ({
          html: String(p["render"]?.markdown ?? p["extract"]?.markdown ?? ""),
          selector: "h1, h2, .price, [itemprop=\"price\"]",
          limit: 25,
      }) },
      { slug: "html-table",  mapInput: (_a, p) => ({
          html: String(p["render"]?.markdown ?? p["extract"]?.markdown ?? ""),
          format: "json",
      }) },
      { slug: "html-strip",  mapInput: (_a, p) => ({
          html: String(p["render"]?.markdown ?? p["extract"]?.markdown ?? ""),
      }) },
      { slug: "html-links",  mapInput: (_a, p) => ({
          html: String(p["render"]?.markdown ?? p["extract"]?.markdown ?? ""),
          limit: 50,
      }) },
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
          if (!cik) throw Object.assign(new Error("no theme match — empty watchlist"), { statusCode: 422 });
          return { cik, limit: 10 };
      } },
      { slug: "edgar-insider-trades", mapInput: (_a, p) => {
          const cik = p["edgar-search"]?.hits?.[0]?.cik;
          if (!cik) throw Object.assign(new Error("no theme match — empty watchlist"), { statusCode: 422 });
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

  // ──────────────────────────────────────────────────────────────────────
  // Still TODO (auto-stubs return statusCode 501 per step):
  //
  // Standard tier (network/render): media-pipeline, document-intel,
  // forecasting-bake-off — all need either base64 uploads or live equity
  // data threading that doesn't fit the URL/ticker arg shape.
  // ──────────────────────────────────────────────────────────────────────
};

// Pull the first URL out of a comma/newline-separated list for the
// content-extraction pack's single-URL chain.
function firstUrl(urls) {
  if (!urls) return "";
  return String(urls).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)[0] || "";
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
async function runPack(packSlug, args, ctx) {
  const pack = ctx.packIndex.get(packSlug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown pack: ${packSlug}`), { statusCode: 404 });
  }
  const config = getStepConfig(packSlug, ctx.packIndex);
  const prior = {};

  const runStep = async (step) => {
    try {
      const input = step.mapInput(args, prior);
      const handler = lookupHandler(step.slug, ctx);
      if (!handler) {
        throw Object.assign(
          new Error(`No in-process handler for slug "${step.slug}" — wire via INLINE_HANDLERS in server.js`),
          { statusCode: 501 }
        );
      }
      const result = await handler(input);
      prior[step.slug] = result;
      return { slug: step.slug, ok: true, result };
    } catch (err) {
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

  const okCount = steps.filter((s) => s.ok).length;
  return {
    pack: packSlug,
    args,
    steps,
    summary: `${okCount}/${steps.length} steps succeeded`,
  };
}

// Factory — produces the 39 skill tool definitions to splice into ALL_KIT.
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
      price: `$${price.toFixed(price < 0.1 ? 3 : 2)}`,
      description:
        `Bundled execution of the ${pack.title} workflow — ${pack.tagline} ` +
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
