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
import { paymentHeaderOf, payerFromRequest } from "../payer.js";
import { maySpend, noteSpend, adjustSpend, resolveSpend } from "../external-spend-guard.js";
import { findTools } from "../find.js";
import { observeDelivery } from "../response-observation.js";
import { isIdentityBoundRoute } from "../payments.js";

// Two execution tiers, both from buildRouteExecuteTool. The tier a buyer needs
// is quoted by /api/route (routeExecuteHint below), so there's no guessing:
//   route-execute      $0.01  — internal + external tools ≤ $0.005 (the cheap
//                               path; unchanged for existing callers).
//   route-execute-max  $0.55  — internal + external tools ≤ $0.50, the tier
//                               that reaches the valuable external catalog.
// External dispatch is the marketable half: run the task on OUR tool if we have
// one, else pay the best EXTERNAL seller over x402 and relay — one call either
// way. Spend is bounded (external only when we lack the tool) and gated on
// SOR_EXTERNAL_ENABLED until a real external buy proves it.
export const EXEC_TIERS = [
  { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.005 },
  // Proportional middle tier (2026-07-29 leaderboard review): the curve had
  // exactly two points - $0.01 covering <=$0.005 and $0.55 covering <=$0.50 -
  // so a $0.02 flight search or a $0.01 Nansen call could only ride the max
  // tier at a 27x markup. $0.05 covering <=$0.04 keeps the fee proportional
  // (25% margin at the cap, more below it) and unlocks the mid-priced
  // external inventory the seller review identified as routable demand.
  { slug: "route-execute-plus", execPriceUsd: 0.05, underlyingMaxUsd: 0.04 },
  { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
  // 2026-08-07: the $0.50 underlying ceiling excluded every indexed tool priced
  // above it, so the router could only answer those with a 409 pointing at the
  // seller's own direct route. Same 10% spread as the max tier, so the fee
  // curve stays proportional rather than punishing size.
  //
  // This tier is only safe because of the per-payer debt ceiling in
  // external-spend-guard.js. Settlement runs AFTER the handler, so raising the
  // cap raises exactly one exposure: what a buyer whose payment verifies and
  // then fails to settle can make us spend before we stop them. Keep
  // EXTERNAL_MAX_UNSETTLED_USD sized against THIS number, not the old $0.50.
  { slug: "route-execute-pro", execPriceUsd: 3.3, underlyingMaxUsd: 3.0 },
];
const EXEC_SLUGS = new Set(EXEC_TIERS.map((t) => t.slug));
/** Which execution tier (if any) can run a tool at `underlyingUsd`, and the
 *  price to pay it. Used by /api/route to quote the buyer the exact tier. */
export function routeExecuteHint(underlyingUsd) {
  const tier = EXEC_TIERS.find((t) => underlyingUsd <= t.underlyingMaxUsd);
  return tier ? { tool: tier.slug, price: `$${tier.execPriceUsd}`, underlyingPriceUsd: underlyingUsd, routingFeeUsd: Number((tier.execPriceUsd - underlyingUsd).toFixed(6)) } : null;
}

// Optional recomputable call identity (issue #282): callRef = "sha256:" + hex
// digest over the canonical preimage JSON.stringify({nonce, slug, ts}) — keys
// in that (alphabetical) order, all values strings. The EIP-3009 authorization
// nonce is the high-entropy per-dispatch pseudonym: buyer and seller each hold
// it already (the buyer signed it, the seller read it from X-PAYMENT), so both
// re-derive the same reference offline from the receipt's slug + ts — while
// outsiders cannot brute-force the caller from the hash. Absent (null) when the
// call carried no EVM payment authorization (free mode, non-EIP-3009 rails).
// The CAIP-2 network the buyer signed their payment for (from the X-PAYMENT
// authorization), or null when unreadable (free/PoW mode, malformed header).
// Used to CHAIN-MATCH external routing (pay the seller on the chain the buyer paid us on). Never throws.
export function buyerPaymentNetwork(req) {
  try {
    // An MPP/tempo credential is validated by the tempo gate (src/mpp-tempo.js)
    // and carries no x402 header at all; the gate marks the request instead.
    if (req?.mppTempoCredential) return "eip155:4217";
    const header = paymentHeaderOf(req);   // the header settlement reads — see src/payer.js
    if (!header) return null;
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    // v1 payloads carry `network` top-level; v2 payloads carry the CHOSEN
    // accept under `accepted` (shape: {x402Version:2, accepted, payload}) with
    // the network inside it. Reading only the v1 spot 409'd every v2 Base
    // buyer out of external routing (found by the first paid demo after the
    // fail-closed check shipped — the canary's route-exec leg is internal-only
    // and never walked this path).
    if (typeof p?.network === "string") return p.network;
    if (typeof p?.accepted?.network === "string") return p.accepted.network;
    return null;
  } catch { return null; }
}

export function callRefFrom(req, slug, ts) {
  try {
    const header = paymentHeaderOf(req);   // the header settlement reads — see src/payer.js
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
  // ANY execution tier, not just the base slug: before 2026-07-29 the max
  // tier could dispatch route-execute itself (nested routing fees on one
  // payment) because only the literal base slug was blocked.
  if (EXEC_SLUGS.has(def.slug)) return { ok: false, why: "cannot dispatch to another route-execute tier" };
  if (def.identityBound || isIdentityBoundRoute(def)) {
    return { ok: false, why: "identity-bound tools are wallet-keyed - call them directly so the signed payment identity is preserved" };
  }
  const bodyType = def.discovery?.bodyType;
  if (bodyType && bodyType !== "json") return { ok: false, why: `bodyType "${bodyType}" is not dispatchable through the JSON params envelope` };
  // Per-request-priced tools (the metered gateway routes): their price is a
  // quote of the body, which no flat routing fee can cover, and the executor
  // invokes handlers with no request, so the quote/belt never run (review
  // 2026-08-27: $0.01 bought an uncapped Opus call through here).
  if (typeof def.quote === "function") return { ok: false, why: "per-request-priced tools are quoted from the body - call them directly so the 402 carries their real price" };
  return { ok: true };
}

// Buyer payment network (CAIP-2) -> the external settlement chain it can fund.
// External routing is SELF-FUNDING per chain: the buyer's settlement lands on
// our payTo for that chain, and we pay the seller from the SAME chain's
// spending wallet — so the chain the buyer paid on decides where we spend.
export const EXTERNAL_CHAIN_BY_NETWORK = {
  "eip155:8453": "base",
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "algorand",
  // Solana buyers fund the SVM spending wallet, which pays Solana sellers
  // (src/solana-buyer.js). Mainnet genesis only - devnet never maps.
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  // MPP/tempo buyers (Authorization: Payment, tempo/charge) fund the Tempo
  // spending wallet, which pays MPP sellers on Tempo (src/tempo-buyer.js).
  "eip155:4217": "tempo",
};
// Which external chains a buyer on `payNet` may be routed to, in order. The
// buyer's own chain first (self-funding). Base buyers may ALSO fall through
// to Tempo/MPP sellers when the operator opts in (SOR_TEMPO_FROM_BASE=true):
// that spends the Tempo wallet against Base revenue, so it is a treasury
// float decision, not a default.
export function externalChainsFor(payNet, supported, { tempoFromBase = process.env.SOR_TEMPO_FROM_BASE === "true" } = {}) {
  const own = EXTERNAL_CHAIN_BY_NETWORK[payNet];
  const chains = [];
  if (own && supported.includes(own)) chains.push(own);
  if (own === "base" && tempoFromBase && supported.includes("tempo")) chains.push("tempo");
  return chains;
}
const EXTERNAL_CHAIN_CAIP2 = Object.fromEntries(Object.entries(EXTERNAL_CHAIN_BY_NETWORK).map(([k, v]) => [v, k]));

export function buildRouteExecuteTool({ getCatalog, baseUrl = "", tier = EXEC_TIERS[0], resolveExternal = null, payExternal = null, externalEnabled = () => false, externalChains = () => ["base"] }) {
  const EXEC_PRICE_USD = tier.execPriceUsd;
  const UNDERLYING_MAX_USD = tier.underlyingMaxUsd;
  const routeSuffix = tier.slug.replace("route-execute", "");
  return {
    route: `POST /api/route/execute${routeSuffix}`,
    name: routeSuffix ? `Route and execute (${routeSuffix.slice(1)} tier)` : "Route and execute",
    slug: tier.slug,
    category: "agent",
    price: `$${EXEC_PRICE_USD}`,
    description:
      `Describe a task (or name a slug) and the Smart Order Router resolves the best-matching tool and RUNS it in the same call - flat $${EXEC_PRICE_USD} covering any tool listed at $${UNDERLYING_MAX_USD} or less, from THIS host's catalog or any external seller in the open index - x402 sellers, or MPP sellers on Tempo (paid on your behalf over x402 or MPP, result relayed). One payment, one request, result + receipt. /api/route quotes which tier a task needs; pricier tools return a self-correcting 409 with their direct route.`,
    // Tags are the discoverability surface: a tag hit scores +3 in the ranker
    // (vs +1 for a description substring), and an audit on 2026-07-28 found
    // the natural phrasings agents actually use - "buy a tool from another
    // seller", "pay an external api on my behalf" - resolved to unrelated
    // tools because none of those words were tags. Each word below is a term
    // a buyer would type for THIS capability, not a synonym grab.
    tags: ["router", "sor", "execute", "dispatch", "meta", "agent", "x402",
      "buy", "purchase", "seller", "external", "behalf", "broker", "delegate",
      "outsource", "marketplace", "cross-seller",
      ...(routeSuffix ? [`${routeSuffix.slice(1)}-tier`] : [])],
    discovery: {
      bodyType: "json",
      input: { slug: "hash", params: { text: "agent402", algo: "sha256" } },
      inputSchema: {
        properties: {
          task: { type: "string", description: "Plain-language task, e.g. \"sha256 hash of a string\" - resolved via the same ranker as /api/find. Provide task OR slug." },
          slug: { type: "string", description: "Exact tool slug to execute (skips ranking). Provide task OR slug." },
          params: { type: "object", description: "Input for the resolved tool, matching its inputSchema (default {})" },
          include: { type: "string", description: 'Where to route: default runs a tool from THIS host\'s catalog; "external" routes to the best-matching x402 seller in the OPEN index and pays it on your behalf (result relayed, marked untrustedContent). Requires task (not slug).' },
          maxUsd: { type: "number", description: `Refuse tools listed above this underlying price (default and ceiling: $${UNDERLYING_MAX_USD})` },
        },
      },
      output: {
        example: {
          receipt: { slug: "hash", route: "POST /api/hash", underlyingPriceUsd: 0.001, paidUsd: EXEC_PRICE_USD, routingFeeUsd: 0.009, seller: "internal", resolvedBy: "slug", ts: "2026-07-10T00:00:00.000Z", callRef: "sha256:…  (recomputable: sha256 of {\"nonce\":<payment authorization nonce>,\"slug\":…,\"ts\":…} - null on nonce-less calls)" },
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
        if (!def) throw bad(`Unknown slug "${String(input.slug).slice(0, 80)}" - resolve one with /api/find?q=<task>`, 404);
        const d = dispatchable(def);
        if (!d.ok) throw bad(`Tool "${def.slug}" is not dispatchable here: ${d.why}`, 409);
        if (toUsd(def.price) > cap) {
          const up = routeExecuteHint(toUsd(def.price));
          throw bad(`Tool "${def.slug}" is listed at $${toUsd(def.price)} - above this endpoint's $${cap} underlying cap.${up && up.tool !== tier.slug ? ` Use ${up.tool} (${up.price}) to run it through the router, or call` : " Call"} it directly: ${def.route}${baseUrl ? ` on ${baseUrl}` : ""}`, 409);
        }
      } else if (typeof input.task === "string" && input.task.trim()) {
        resolvedBy = "task";

        // EXPLICIT external routing (include:"external") — the marketable path:
        // "run this on a tool from the OPEN x402 ecosystem, not our catalog."
        // First-class, not a fallback: with 500+ internal tools a loose ranker
        // always matches SOMETHING, so external must be a deliberate buyer
        // choice to fire reliably. We resolve the best external Base-payable
        // seller, pay it on the buyer's behalf via x402, and relay the result.
        // Spend stays bounded to when the buyer asked for it. Gated on
        // SOR_EXTERNAL_ENABLED until a real external buy proves it live.
        if (input.include === "external") {
          if (!externalEnabled() || !resolveExternal) throw bad("External routing is not enabled on this host", 409);
          // CHAIN-MATCHED external settlement: we pay the seller from the same
          // chain the buyer paid US on, so external routing funds itself per
          // chain (buyer settles to our payTo on chain X, we spend from the
          // chain-X spending wallet). Refuse chains without a configured
          // spending wallet (a 4xx cancels the buyer's settlement — they are
          // not charged). Internal routing stays available on every chain.
          // Fail CLOSED for a PAID request: if a payment header is present but
          // its network doesn't map to a supported chain, refuse (a genuine
          // buyer always has a readable network; an unreadable one on a paying
          // request is the only residual bypass of the chain-match rule). No
          // payment header at all (free/PoW mode) defaults to the Base path —
          // external can't run there without a wallet anyway.
          const supported = externalChains();
          const payNet = buyerPaymentNetwork(req);
          const hasPayment = !!paymentHeaderOf(req) || !!req?.mppTempoCredential;
          const chains = hasPayment ? externalChainsFor(payNet, supported) : (supported.includes("base") ? ["base"] : []);
          if (!chains.length) {
            const offer = supported.map((c) => `${c} (${EXTERNAL_CHAIN_CAIP2[c]})`).join(" or ");
            throw bad(`External routing settles on ${offer} - this request paid on ${payNet || "an unreadable network"}. Pay on a supported chain for include:"external", or use internal routing (works on every chain).`, 409);
          }
          // First chain that resolves a candidate wins: the buyer's own chain,
          // then (opt-in) Tempo/MPP sellers for Base buyers.
          // TEMPO TIME BUDGET. A Tempo buyer's credential is a signed tx the
          // CLIENT bounded in time (mppx signs validBefore = now + ~25s), and
          // our settlement broadcasts AFTER the handler. An external buy that
          // outlives that window is work done and an upstream seller paid,
          // then a refused settle: the buyer sees 402 and we ate the seller's
          // price (measured 2026-08-27: a 69s Firecrawl scrape, $0.002 gone,
          // vs a 23s one that settled). So on Tempo the external leg runs
          // under a budget: refuse BEFORE spending when resolution ate it,
          // and hand the seller call a timeout that keeps the whole handler
          // inside the window. A 504 cancels settlement; the only loss is the
          // bounded seller price on a seller that answered too slowly.
          const tempoBudgetMs = req?.mppTempoCredential ? (Number(process.env.SOR_TEMPO_BUDGET_MS) || 16000) : null;
          const startedAt = Date.now();
          const remainingMs = () => (tempoBudgetMs == null ? null : tempoBudgetMs - (Date.now() - startedAt));
          // FALLTHROUGH ON A SELLER 5xx. Resolve up to SOR_MAX_CANDIDATES live
          // sellers (ranked, settled-desc) for the first chain that has any, so
          // a seller whose OWN upstream is down (sol.blockrun's Pyth feed,
          // 2026-09-01) does not fail a route another seller can serve. Only a
          // 5xx from the PAID leg advances - a 4xx cancels settlement and means
          // our request is wrong, and a receipt means we already paid.
          const MAX_CANDIDATES = Math.max(1, Number(process.env.SOR_MAX_CANDIDATES || "3"));
          // The requested model rides into resolution so a chat seller that
          // publishes a model list without it is skipped before anything is
          // probed or paid (a seller can charge on the 400 it answers).
          const wantModel = typeof input.params?.model === "string" && input.params.model.trim() ? input.params.model.trim() : null;
          let candidateList = []; let chain = chains[0];
          for (const c of chains) {
            const found = await resolveExternal(input.task, { cap, baseUrl, chain: c, limit: MAX_CANDIDATES, wantModel });
            const list = Array.isArray(found) ? found : (found ? [found] : []);
            if (list.length) { candidateList = list; chain = c; break; }
          }
          if (tempoBudgetMs != null && remainingMs() < 4000) {
            throw bad(`Resolving an external seller used the Tempo time budget (${tempoBudgetMs}ms); nothing was spent and nothing is charged. Tempo credentials expire about 25s after signing, so retry with a fresh credential or pay this route over an EVM rail.`, 504);
          }
          const chainCaip2 = EXTERNAL_CHAIN_CAIP2[chain];
          if (!candidateList.length) throw bad(`No external ${chains.includes("tempo") && chains.length > 1 ? "x402 or MPP" : chains[0] === "tempo" ? "MPP" : "x402"} seller matched that task${chains[0] !== "base" || chains.length > 1 ? ` on ${chains.join("/")}` : ""}. Explore /api/route?q=<task>&include=external.`, 404);
          // Try candidates in order; keep the last error so an all-fail run
          // reports something real. A 5xx from a seller's paid leg -> next
          // candidate; anything else stops (return on success, throw otherwise).
          let lastErr = null;
          for (let __i = 0; __i < candidateList.length; __i++) {
          const ext = candidateList[__i];
          const hasNext = __i < candidateList.length - 1;
          const extUsd = toUsd(ext.price);
          if (!(extUsd > 0 && extUsd <= cap)) {
            const up = routeExecuteHint(extUsd);
            lastErr = bad(`Best external match "${ext.slug}" is ${ext.price} - over this tier's $${cap} cap.${up && up.tool !== tier.slug ? ` Use ${up.tool} (${up.price}).` : " No tier covers that price - call the seller directly."}`, 409);
            if (hasNext) continue; throw lastErr;
          }
          if (!(ext.url && Array.isArray(ext.networks) && ext.networks.includes(chainCaip2))) {
            lastErr = bad(`External seller "${ext.seller}" does not offer ${chain} settlement - cannot pay it from the ${chain} spending wallet.`, 409);
            if (hasNext) continue; throw lastErr;
          }
          const extWire = ext.wire || "x402";
          // GET sellers take their input as query params — an HTTP GET cannot
          // carry a body (undici refuses it outright). Only primitives can ride
          // a query string; a nested param against a GET seller is the caller's
          // input mismatch, said plainly instead of a wire error.
          const extMethod = (ext.method || "POST").toUpperCase();
          let extUrl = ext.url;
          let extBody = params;
          if (extMethod === "GET" || extMethod === "HEAD") {
            const qp = new URLSearchParams();
            for (const [k, v] of Object.entries(params || {})) {
              if (v == null) continue;
              if (typeof v === "object") throw bad(`External tool "${ext.slug}" is a ${extMethod} endpoint - param "${k}" must be a string, number, or boolean`, 400);
              qp.set(k, String(v));
            }
            const qs = qp.toString();
            extUrl = qs ? `${ext.url}${ext.url.includes("?") ? "&" : "?"}${qs}` : ext.url;
            extBody = undefined;
          }
          // PER-PAYER DEBT CEILING. Everything above bounds WHAT we pay (the
          // canonical-USDC asset pin, this tier's cap re-checked against the
          // live 402, the 50-settlement reliability floor). Nothing bounds
          // WHETHER WE GET PAID: settlement runs AFTER this handler, so a
          // payment that verifies and then fails to settle leaves us having
          // spent real USDC upstream for a buyer who is charged nothing.
          // Self-dealt - one wallet listing the seller and buying from it -
          // every drained dollar returns to the attacker, bounded per call only
          // by `cap`. A 4xx here cancels the buyer's settlement, so refusing
          // costs an honest buyer nothing.
          // Keyed like the composite guard (server.js): the signed x402 payer
          // first, else the Tempo credential's payer (the tempo gate strips
          // the x402 headers on acceptance, so payerFromRequest is null for an
          // MPP/Tempo buyer and an unkeyed payer was exempt from the ceiling -
          // found in the 2026-08-27 review, the first day the Tempo leg
          // resolved anything), else the client IP so nobody is unkeyed.
          const spendPayer = payerFromRequest(req)
            || (req?.mppTempoPayer ? `tempo:${req.mppTempoPayer}` : null)
            || (req?.ip ? `ip:${req.ip}` : null);
          // Book the WORST CASE this call could cost, not the seller's declared
          // price. `cap` is what payExternal will refuse to exceed, so it is the
          // real exposure; the declared price is one seller-controlled document
          // and would otherwise let them set our own debt ceiling (see
          // adjustSpend). Corrected down to the actual quote below.
          const allowed = maySpend(spendPayer, cap);
          if (!allowed.ok) throw bad(`External routing is paused for this wallet: ${allowed.reason}`, 429);
          const spendHandle = noteSpend(spendPayer, cap);
          // Handed to server.js on the REQUEST, because a tool handler is called
          // as handler(input, req) and never receives `res`. The first draft
          // registered res.on("finish") here, where `res` is undefined - a guard
          // that installs nothing and reports no error, which is the exact shape
          // of defect this session keeps finding. server.js resolves it on the
          // FINAL response (post-settlement), never on handler success.
          if (spendHandle && req && typeof req === "object") req.__externalSpend = spendHandle;
          let paid;
          try {
            // provenPayTo: the address this seller's reliability evidence was
            // computed FROM. The resolver already refused a probe whose 402
            // named a different one, but the spend below is a SECOND request
            // and the seller answers both, so the check has to happen again
            // against the accept actually signed. Null = no chain-derived
            // address on record, which is not a failure - see provenPayToMatches.
            if (ext.unproven) console.warn(`[sor] paying UNPROVEN ${chain} seller ${ext.seller} (${ext.price}) - every proven candidate was exhausted; loss bounded by the unproven allowance`);
            paid = await payExternal(extUrl, { method: extMethod, body: extBody, maxAtomic: BigInt(Math.round(cap * 1e6)), chain, provenPayTo: ext.provenPayTo || null, allowUnproven: ext.unproven === true, ...(tempoBudgetMs != null ? { timeoutMs: Math.max(3000, remainingMs()) } : {}) });
          } catch (e) {
            // The exposure DELIBERATELY stands. It is tempting to clear it here
            // ("the buy failed, so we never spent"), but payExternal can throw
            // after signing and broadcasting - a network error on the response,
            // a timeout - and clearing on those is exactly the case that lets a
            // spend disappear from the ledger. It ages out on its own within
            // the stale window, so an honest buyer caught by a seller outage
            // waits, while a spend we cannot account for keeps counting.
            const sc = e?.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 502;
            lastErr = bad(`External seller "${ext.seller}" failed: ${String(e?.message || e).slice(0, 200)}`, sc);
            // FALL THROUGH TO THE NEXT SELLER only on a 5xx (their own upstream
            // or gateway failed), and only when the error carries NO settle
            // receipt - a payExternal throw that includes a receipt means the
            // authorization went out and we may have paid, so retrying another
            // seller would be a second, uncorrelated spend. A 4xx never falls
            // through: it cancels the buyer's settlement and means our request
            // was wrong, which the next seller would reject the same way. Tempo
            // buyers never fall through (their credential is single-use and
            // time-boxed - a second seller needs a fresh one).
            // FALL THROUGH ONLY WHEN THE AUTHORIZATION WAS NEVER SENT.
            // payX402 stamps `committed:true` on every throw AFTER it has
            // signed and sent the payment header - at which point we cannot
            // prove we were not charged, so retrying another seller would risk
            // a second, uncorrelated spend. A PRE-commit failure (seller
            // unreachable, unparseable 402, no payable accept, quote over cap)
            // provably spent nothing, so it is safe to try the next candidate.
            // The seller's HTTP status is NOT a safe signal here: a seller can
            // settle our transfer and THEN return 5xx, so "5xx = not charged"
            // is a false assumption the seller controls. `committed` is set by
            // OUR buyer code from whether the header was sent, which the seller
            // cannot influence. Tempo never falls through either way (single-
            // use, time-boxed credential).
            const spentMaybe = e?.committed === true;
            if (hasNext && !spentMaybe && chain !== "tempo") {
              console.warn(e?.refused
                ? `[sor] seller ${ext.seller} refused the payment and the chain shows no debit - trying next candidate, nothing spent`
                : `[sor] seller ${ext.seller} failed pre-payment (${sc}) - trying next candidate, nothing spent`);
              continue;
            }
            throw lastErr;
          }
          const ts = new Date().toISOString();
          // RUNTIME VERIFICATION. The seller's OpenAPI told us what a success
          // guarantees; this is the only moment anyone finds out whether that
          // was true, because we just paid for the answer. Records the verdict
          // only - never the payload, which is what the buyer paid for.
          // Never throws, and runs after the money has moved either way.
          if (ext.guaranteedPaths?.length && ext.route) {
            observeDelivery({
              // The SAME (origin, method, route) triple the index projects on,
              // taken from the resolver's own row. Keying this by slug instead
              // would record observations nothing could ever read back, since
              // every reader has the route.
              origin: ext.seller,
              method: ext.method || "POST",
              route: ext.route,
              guaranteedPaths: ext.guaranteedPaths,
              body: paid.result,
            });
          }
          const underlyingUsd = paid.quote ? paid.quote.usd : extUsd;
          // Now the real figure is known, so the ceiling stops counting the
          // worst case against this payer.
          adjustSpend(spendHandle, underlyingUsd);
          return {
            receipt: {
              slug: ext.slug,
              route: `${ext.method || "POST"} ${ext.url}`,
              underlyingPriceUsd: underlyingUsd,
              paidUsd: EXEC_PRICE_USD,
              routingFeeUsd: Number((EXEC_PRICE_USD - underlyingUsd).toFixed(6)),
              seller: ext.seller,
              external: true,
              settleTx: paid.receipt?.transaction || null,
              settleNetwork: chainCaip2,
              wire: extWire,
              resolvedBy: "task-external",
              // A buyer should know when the seller that served them had no
              // settlement history on this chain when we paid it.
              ...(ext.unproven ? { sellerProof: "unproven" } : {}),
              ts,
              ...(callRefFrom(req, ext.slug, ts) ? { callRef: callRefFrom(req, ext.slug, ts) } : {}),
            },
            // External result is attacker-influenceable content — mark it.
            result: (paid.result && typeof paid.result === "object" && !Array.isArray(paid.result)) ? { ...paid.result, untrustedContent: true } : paid.result,
          };
          } // end candidate loop
          // Every candidate failed with a fall-through-eligible error.
          throw lastErr || bad("No external seller could serve that task.", 502);
        }

        // Default: resolve the best in-budget tool from THIS host's catalog.
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
          const hasExternal = externalEnabled() && !!resolveExternal;
          throw bad(
            results.length
              ? `No dispatchable match under $${cap} for that task (top hit: "${results[0].slug}" at ${results[0].price}).${hasExternal ? ' Retry with include:"external" to route to an outside x402 seller,' : ""} or call it directly / raise maxUsd.`
              : `No internal tool matched that task.${hasExternal ? ' Retry with include:"external" to route to the open x402 ecosystem, or' : ""} try /api/find?q=<task>.`,
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
        // Never relay an inner handler's meter sentinel (non-enumerable now,
        // but belt and braces: this object is nested into our own response).
        if (result && typeof result === "object") { try { delete result.__meterUpstreamUsd; } catch { /* frozen */ } }
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
