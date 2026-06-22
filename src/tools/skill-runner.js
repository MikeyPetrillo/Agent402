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

  // ──────────────────────────────────────────────────────────────────────
  // Still TODO (auto-stubs return statusCode 501 per step):
  //
  // Premium tier (paid-upstream heavy — highest revenue per call):
  //   sec-filings-deep-dive  macro-context  crypto-research  regulatory-watch
  //   search-and-cite        macro-economics
  //
  // Standard tier (network/render):
  //   content-extraction  media-pipeline  document-intel  any-to-markdown
  //   structured-scrape   forecasting-bake-off  fraud-signals  link-preview
  //   api-investigation   email-deliverability  location-intel  dns-network-ops
  //   status-snapshot     schema-evolution
  //
  // Light tier remaining: csv-profile  meeting-scheduler  jwt-forensics
  //   data-interchange  webhook-debug  a11y-audit  trip-planner
  //   loan-comparison   investment-decision  retirement-planning  savings-goal
  // ──────────────────────────────────────────────────────────────────────
};

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
