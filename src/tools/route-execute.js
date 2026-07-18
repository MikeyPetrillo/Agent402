// Route-and-execute — the Smart Order Router's first EXECUTING surface.
//
// /api/route and /api/find recommend a tool; this endpoint runs it. The buyer
// pays ONE flat x402 price and describes the task (or names a slug); the
// router resolves the best match from the live catalog and dispatches it
// internally, returning the tool result plus a receipt that itemizes the
// underlying price vs. what was paid.
//
// v1 scope (deliberately): INTERNAL dispatch only — the resolved tool must be
// in this host's own catalog, so there is no counterparty, no server-side
// wallet, and no float. The route/quote/guard/receipt plumbing this validates
// is the same shape a later cross-seller executor needs; only the dispatch
// step changes.
//
// Economics: flat $0.01 covers any underlying tool priced <= $0.005 — the
// spread is the routing fee. Tools above the cap return a self-correcting 409
// that names the tool and its direct route, so the buyer can call it at list
// price instead.
import { createHash } from "node:crypto";
import { findTools } from "../find.js";
import { isIdentityBoundRoute } from "../payments.js";

const EXEC_PRICE_USD = 0.01;
const UNDERLYING_MAX_USD = 0.005;

// Optional recomputable call identity (issue #282): callRef = "sha256:" + hex
// digest over the canonical preimage JSON.stringify({nonce, slug, ts}) — keys
// in that (alphabetical) order, all values strings. The EIP-3009 authorization
// nonce is the high-entropy per-dispatch pseudonym: buyer and seller each hold
// it already (the buyer signed it, the seller read it from X-PAYMENT), so both
// re-derive the same reference offline from the receipt's slug + ts — while
// outsiders cannot brute-force the caller from the hash. Absent (null) when the
// call carried no EVM payment authorization (free mode, non-EIP-3009 rails).
export function callRefFrom(req, slug, ts) {
  try {
    const header = req?.header?.("x-payment") || req?.header?.("payment-signature");
    if (!header) return null;
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const nonce = payload?.payload?.authorization?.nonce;
    if (typeof nonce !== "string" || !nonce) return null;
    return "sha256:" + createHash("sha256").update(JSON.stringify({ nonce, slug, ts })).digest("hex");
  } catch {
    return null;
  }
}

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const toUsd = (price) => Number(String(price ?? "").replace(/[^0-9.]/g, "")) || 0;

// Tools the executor refuses to dispatch regardless of price:
// - identity-bound (memory* AND my-usage): wallet-keyed — the tool reads the
//   SIGNED payment identity off the Express request (payerFromRequest / the
//   memory namespace). The executor invokes handlers as `def.handler(params)`
//   with no request, so the identity is absent: memory would key the wrong
//   namespace and my-usage would 502 on `req.header` — AFTER the buyer already
//   paid for route-execute. Worse, route-execute advertises all eight rails
//   while identity-bound tools are EVM-only, so even threading the request
//   through would break the identity contract. These MUST be called directly.
//   Guarded by isIdentityBoundRoute (the single source of truth in payments.js)
//   so this holds on a raw catalog, independent of server.js's flag mutation.
// - route-execute itself (no recursion).
// - non-JSON bodies (binary/multipart uploads don't fit the {params} envelope).
function dispatchable(def) {
  if (!def || typeof def.handler !== "function") return { ok: false, why: "tool has no internal handler" };
  if (def.slug === "route-execute") return { ok: false, why: "cannot dispatch to itself" };
  if (def.identityBound || isIdentityBoundRoute(def)) {
    return { ok: false, why: "identity-bound tools are wallet-keyed — call them directly so the signed payment identity is preserved" };
  }
  const bodyType = def.discovery?.bodyType;
  if (bodyType && bodyType !== "json") return { ok: false, why: `bodyType "${bodyType}" is not dispatchable through the JSON params envelope` };
  return { ok: true };
}

export function buildRouteExecuteTool({ getCatalog, baseUrl = "" }) {
  return {
    route: "POST /api/route/execute",
    name: "Route and execute",
    slug: "route-execute",
    category: "agent",
    price: `$${EXEC_PRICE_USD}`,
    description:
      `Describe a task (or name a slug) and the Smart Order Router resolves the best-matching tool and RUNS it in the same call — one flat $${EXEC_PRICE_USD} price covering any tool listed at $${UNDERLYING_MAX_USD} or less, receipt included. Skips the find-then-call round trip: one payment, one request, result + receipt. Pricier tools return a self-correcting 409 pointing at their direct route.`,
    tags: ["router", "sor", "execute", "dispatch", "meta", "agent", "x402"],
    discovery: {
      bodyType: "json",
      input: { slug: "hash", params: { text: "agent402", algo: "sha256" } },
      inputSchema: {
        properties: {
          task: { type: "string", description: "Plain-language task, e.g. \"sha256 hash of a string\" — resolved via the same ranker as /api/find. Provide task OR slug." },
          slug: { type: "string", description: "Exact tool slug to execute (skips ranking). Provide task OR slug." },
          params: { type: "object", description: "Input for the resolved tool, matching its inputSchema (default {})" },
          maxUsd: { type: "number", description: `Refuse tools listed above this underlying price (default and ceiling: $${UNDERLYING_MAX_USD})` },
        },
      },
      output: {
        example: {
          receipt: { slug: "hash", route: "POST /api/hash", underlyingPriceUsd: 0.001, paidUsd: EXEC_PRICE_USD, routingFeeUsd: 0.009, seller: "internal", resolvedBy: "slug", ts: "2026-07-10T00:00:00.000Z", callRef: "sha256:…  (recomputable: sha256 of {\"nonce\":<payment authorization nonce>,\"slug\":…,\"ts\":…} — null on nonce-less calls)" },
          result: { algo: "sha256", hex: "…", base64: "…" },
        },
      },
    },
    handler: async (input, req) => {
      if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
      const catalog = getCatalog();
      const params = input.params != null ? input.params : {};
      if (typeof params !== "object" || Array.isArray(params)) throw bad('"params" must be an object matching the resolved tool\'s inputSchema');
      const cap = Math.min(Number(input.maxUsd) > 0 ? Number(input.maxUsd) : UNDERLYING_MAX_USD, UNDERLYING_MAX_USD);

      // Resolve: explicit slug wins; otherwise rank the task with the same
      // lexical ranker behind /api/find and walk down until a dispatchable,
      // in-budget tool is found (the top hit may be excluded or over-cap).
      let def = null;
      let resolvedBy;
      const bySlug = new Map(Object.values(catalog).map((d) => [d.slug, d]));
      if (input.slug != null) {
        resolvedBy = "slug";
        def = bySlug.get(String(input.slug)) || null;
        if (!def) throw bad(`Unknown slug "${String(input.slug).slice(0, 80)}" — resolve one with /api/find?q=<task>`, 404);
        const d = dispatchable(def);
        if (!d.ok) throw bad(`Tool "${def.slug}" is not dispatchable here: ${d.why}`, 409);
        if (toUsd(def.price) > cap) {
          throw bad(`Tool "${def.slug}" is listed at $${toUsd(def.price)} — above this endpoint's $${cap} underlying cap. Call it directly: ${def.route}${baseUrl ? ` on ${baseUrl}` : ""}`, 409);
        }
      } else if (typeof input.task === "string" && input.task.trim()) {
        resolvedBy = "task";
        const { results } = findTools(catalog, input.task, { k: 10, baseUrl });
        for (const r of results) {
          const candidate = bySlug.get(r.slug);
          if (!candidate) continue;
          if (!dispatchable(candidate).ok) continue;
          if (toUsd(candidate.price) > cap) continue;
          def = candidate;
          break;
        }
        if (!def) {
          throw bad(
            results.length
              ? `No dispatchable match under $${cap} for that task (top hit: "${results[0].slug}" at ${results[0].price}). Call it directly or raise maxUsd.`
              : "No tool matched that task — try /api/find?q=<task> to explore.",
            404
          );
        }
      } else {
        throw bad('Provide "task" (plain language) or "slug" (exact tool)');
      }

      const underlying = toUsd(def.price);
      let result;
      try {
        result = await def.handler(params);
      } catch (e) {
        // Surface the underlying tool's own error semantics — the buyer paid
        // for a routed execution, and the tool's 4xx is the honest answer.
        const sc = e?.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 502;
        throw bad(`Routed tool "${def.slug}" failed: ${String(e?.message || e).slice(0, 200)}`, sc);
      }
      const ts = new Date().toISOString();
      const callRef = callRefFrom(req, def.slug, ts);
      return {
        receipt: {
          slug: def.slug,
          route: def.route,
          underlyingPriceUsd: underlying,
          paidUsd: EXEC_PRICE_USD,
          routingFeeUsd: Number((EXEC_PRICE_USD - underlying).toFixed(6)),
          seller: "internal",
          resolvedBy,
          ts,
          ...(callRef ? { callRef } : {}),
        },
        result,
      };
    },
  };
}
