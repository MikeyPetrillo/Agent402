// The two lanes our router can pay an external seller through, summarised for
// one origin from the per-route dispatch verdicts the router itself acts on.
//
//   proven    a Base route whose verdict is `eligible` (the settlement floor,
//             breadth, wallet binding, EIP-712 domain and delivery memo all
//             clear), at or under the cap this summary is asked about.
//   unproven  a Base route whose verdict carries `unprovenTier`: below the
//             floor with nothing else wrong, priced within the unproven
//             ceiling (src/base-unproven.js). Tried after every proven
//             candidate, at the wallet the seller's own live 402 names, and
//             flagged unproven on the receipt.
//
// This module decides NOTHING about eligibility. Every boolean below is read
// off a verdict that dispatchEligibility produced for the route (the server's
// withDispatchFields, the same call /api/index?seller= and /api/route publish
// and the resolver's Base gate runs), so a seller tool cannot disagree with
// the router about a route. Pure; no state.
import { DISPATCH_REASONS, DISPATCH_DETAILS, UNPROVEN_LANE_TERMS } from "./dispatch-eligibility.js";
import { priceUsdOf, isPricedAboveZero } from "./price-usd.js";

const reasonLine = (reason, detail) => {
  const base = DISPATCH_REASONS[reason] ? `${reason}: ${DISPATCH_REASONS[reason]}` : String(reason || "no verdict");
  return detail && Object.hasOwn(DISPATCH_DETAILS, detail) ? `${base} (${detail}: ${DISPATCH_DETAILS[detail]})` : base;
};

/**
 * @param {object[]} o.toolVerdicts  the seller's tool rows, each carrying its own
 *                                   routerDispatchByChain / routerDispatchReason
 *                                   (rowLevel verdicts, priced per route)
 * @param {number} o.unprovenMaxUsd  the unproven ceiling in force (0 = switched off)
 * @param {number|null} [o.provenCapUsd]  the underlying cap the proven lane is
 *                                   reported against (null = no cap)
 */
export function routerLanes({ toolVerdicts = [], unprovenMaxUsd = 0, provenCapUsd = null } = {}) {
  const ceiling = Number(unprovenMaxUsd) > 0 ? Number(unprovenMaxUsd) : 0;
  const paid = (Array.isArray(toolVerdicts) ? toolVerdicts : [])
    .filter((t) => t && t.paid !== false && isPricedAboveZero(t.price))
    .map((t) => ({ usd: priceUsdOf(t.price), base: t.routerDispatchByChain?.base || null, reason: t.routerDispatchReason || null }));
  const onBase = paid.filter((t) => t.base);
  const cheapest = (rows) => (rows.length ? Math.min(...rows.map((t) => t.usd)) : null);

  // ---- proven
  const provenAny = onBase.filter((t) => t.base.eligible === true);
  const provenTools = provenAny.filter((t) => provenCapUsd == null || t.usd <= provenCapUsd);
  const provenBlockers = [];
  if (!provenTools.length) {
    if (!paid.length) provenBlockers.push("no paid resource is indexed for this origin");
    else if (!onBase.length) provenBlockers.push(reasonLine(paid.find((t) => t.reason)?.reason || "no_supported_route"));
    else if (provenAny.length) provenBlockers.push(`its proven Base routes are all priced above the $${provenCapUsd} underlying cap`);
    else for (const line of new Set(onBase.map((t) => reasonLine(t.base.reason, t.base.detail)))) provenBlockers.push(line);
  }
  const proven = {
    eligible: provenTools.length > 0,
    chain: "base",
    toolCount: provenTools.length,
    cheapestUsd: cheapest(provenTools),
    ...(provenCapUsd != null ? { underlyingCapUsd: provenCapUsd } : {}),
    blockers: provenBlockers,
  };

  // ---- unproven
  const tiered = onBase.filter((t) => t.base.unprovenTier === true);
  const floorOnly = onBase.filter((t) => t.base.reason === "settlement_required" && !Object.hasOwn(DISPATCH_DETAILS, t.base.detail || ""));
  let reason = null;
  if (!ceiling) reason = "the Base unproven ceiling is switched off on this host, so no seller below the settlement floor is tried";
  else if (tiered.length) reason = null;
  else if (proven.eligible || provenAny.length) reason = "this seller clears the settlement floor, so the router pays it as a proven seller; the unproven lane is only for sellers below the floor";
  else if (!paid.length) reason = "no paid resource is indexed for this origin";
  else if (!onBase.length) reason = "the unproven lane is Base only, and this seller has no Base route the router can pay";
  else if (floorOnly.length) reason = `every Base route held back only by the floor is priced above the $${ceiling} unproven ceiling (cheapest $${cheapest(floorOnly)})`;
  else reason = `every Base route is held back by something other than the settlement floor: ${[...new Set(onBase.map((t) => reasonLine(t.base.reason, t.base.detail)))].join("; ")}`;
  const unproven = {
    eligible: Boolean(ceiling) && tiered.length > 0,
    chain: "base",
    maxUsd: ceiling,
    toolCount: ceiling ? tiered.length : 0,
    cheapestUsd: ceiling ? cheapest(tiered) : null,
    note: `${UNPROVEN_LANE_TERMS[0].toUpperCase()}${UNPROVEN_LANE_TERMS.slice(1)}${ceiling ? ` ($${ceiling} per call)` : ""}.`,
    ...(reason ? { reason } : {}),
  };
  return { proven, unproven };
}
