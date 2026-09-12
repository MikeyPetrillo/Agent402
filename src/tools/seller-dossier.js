// Seller dossier — everything Agent402 already knows about ONE external x402
// seller origin, assembled into a single paid read: identity and crawl history,
// the catalog with the provenance of every price, the wallets it advertises
// against the wallets that have been PAID, settlement evidence per chain and
// per source, the router's own dispatch verdict with its reason, what happened
// the times our router actually paid it, and a list of plain-English flags.
//
// Why it exists (2026-09-08): the ecosystem-data line (bestsellers, demand-
// radar, x402-trending) has more distinct buyers than anything else we sell,
// and the question outside sellers and trust-index vendors keep emailing us -
// "what do you know about this seller" - is answered here from our own crawl,
// probes, ledger and chain joins. Nobody else holds these inputs together.
//
// DETERMINISTIC AND OFFLINE BY CONSTRUCTION, like seller-trust: it never
// fetches the seller at call time. Every input is injected by server.js from
// singletons that refresh on their own schedules, so the answer is what the
// evidence says, not what the seller's uptime says this second. "Unknown" is a
// first-class value throughout: an origin we never crawled is listed:false
// with the reason, never a low grade; a payTo with no chain evidence is
// "not observed", never "zero"; and there is no score, because a number would
// be read as a verdict we did not measure. Flags are sentences.

const PLAIN = (v) => (v === undefined ? null : v);

function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function hostOf(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 253);
}

const TOOL_ROWS_MAX = 50;

/**
 * Pure. Assemble the dossier from injected evidence. Every argument may be
 * null/undefined and is reported as absent when it is.
 *
 * @param {object} a
 * @param {string} a.host            lowercased bare host the caller asked about
 * @param {object|null} a.detail     sellerDetail(host) projection (null = never crawled)
 * @param {object|null} a.entry      raw crawl cache entry (tools carry quote provenance)
 * @param {object|null} a.dispatch   withDispatchFields(detail) row (routerDispatch* fields)
 * @param {object|null} a.evidenceBinding  { payTos:Set, ownSettled, ownPayers } for the origin
 * @param {object|null} a.leaderboardRow   Base hourly leaderboard row (callsSettled, uniqueBuyers, totalUsd, wallets)
 * @param {object|null} a.bazaar     bazaarQualityFor(origin): { calls30d, payers30d, lastCalledAt, payTos }
 * @param {object|null} a.solana     { credits, payers } from solanaEvidenceByOrigin
 * @param {object|null} a.mpp        { verified, lastProbeOk, offers, recipients:[{recipient, transfers, payers, proven, routable}] }
 * @param {object[]} a.refusals      [{ chain, at, status }] from sellerRefusedRecently per configured chain
 * @param {object[]} a.deliveryFailures  [{ chain, at }] per configured chain: the chains where our router paid this
 *                                seller and got nothing back. The status and latency behind it are NOT surfaced here -
 *                                see the note at the projection below.
 * @param {object|null} a.registration  { first_seen, last_routable_seen, last_settled_seen } from the registrations table
 * @param {Map|object} a.deliveries  key "METHOD route" -> deliveryObservation row
 * @param {object|null} a.sharedClaims  { payTo -> [origins] } for a payTo this origin claims that others claim too
 * @param {object} a.helpers         { quoteIsStale, priceDisagreesWithOrigin, networksNeedLiveVerify, looksLikeListingInjection }
 * @param {object} a.thresholds      { sorThreshold, sorPayers, sorCap }
 * @param {boolean} a.self
 * @param {number} a.now
 */
export function composeSellerDossier(a) {
  const {
    host, detail, entry, dispatch, evidenceBinding, leaderboardRow, bazaar, solana, mpp,
    refusals = [], deliveryFailures = [], registration, deliveries, sharedClaims, helpers = {}, thresholds = {}, self = false, now = Date.now(),
  } = a;
  const generatedAt = new Date(now).toISOString();
  const origin = detail?.origin || `https://${host}`;
  const caveats = [
    "every count here is a floor: it is what our crawl, probes and chain reads have observed, never the seller's total",
    "advertised wallets and networks are what the seller publishes; only the evidence blocks say what was actually paid",
    "no liveness probe is performed at call time - lastCrawledAt and paywall say when we last looked",
    "there is no score on purpose: read the flags, each one names the evidence behind it",
  ];

  if (!detail) {
    return {
      origin,
      listed: false,
      ...(self ? { self: true, note: "this is the local catalog - our router never routes to itself; the host's own external figures are at /api/index?seller=<host>" } : {}),
      reason: self ? "the local catalog is not a crawled seller; call its tools directly" : "not in our index - never crawled, so we hold no evidence either way",
      settlementEvidence: {
        base: leaderboardRow
          ? { source: "on-chain leaderboard", callsSettled: leaderboardRow.callsSettled ?? 0, uniqueBuyers: leaderboardRow.uniqueBuyers ?? 0 }
          : { source: "on-chain leaderboard", observed: false },
        bazaar: bazaar ? { source: "Coinbase Bazaar (their measurement)", calls30d: bazaar.calls30d ?? 0, payers30d: bazaar.payers30d ?? 0 } : { source: "Coinbase Bazaar", observed: false },
      },
      howToList: "POST /api/index/register with {\"origin\":\"https://<host>\"} (free, self-serve)",
      flags: ["origin is not indexed: no crawl, no catalog, no router verdict"],
      caveats,
      evidenceSource: "x402 seller crawl + on-chain settlement + Bazaar + MPP index + our own paid calls",
      generatedAt,
    };
  }

  const rawTools = Array.isArray(entry?.tools) ? entry.tools : [];
  const rawByKey = new Map(rawTools.map((t) => [`${String(t.method || "GET").toUpperCase()} ${t.route || t.path || ""}`, t]));
  const flags = [];

  // ---------------------------------------------------------------- identity
  const listingText = [detail.displayName, entry?.manifest?.description, ...(detail.tools || []).map((t) => `${t.name || ""} ${t.description || ""}`)].join(" \n ");
  const injected = typeof helpers.looksLikeListingInjection === "function" ? Boolean(helpers.looksLikeListingInjection(listingText)) : false;
  const identity = {
    displayName: PLAIN(detail.displayName),
    homepage: PLAIN(detail.homepage),
    discoveryPath: PLAIN(detail.discoveryPath),
    mppDualStack: detail.mpp === true,
    originResponded: detail.originResponded !== false,
    crawlError: detail.error || null,
    robotsBlocked: entry?.robotsBlocked === true,
    lastCrawledAt: iso(detail.fetchedAt),
    firstRegisteredAt: iso(registration?.first_seen),
    lastRoutableSeenAt: iso(registration?.last_routable_seen),
    lastSettledSeenAt: iso(registration?.last_settled_seen),
    listingTextLooksInjected: injected,
  };
  if (detail.error) flags.push(`last crawl failed: ${String(detail.error).slice(0, 120)}`);
  if (entry?.robotsBlocked) flags.push("the seller's robots.txt blocks our crawler; the catalog below may be stale");
  if (detail.originResponded === false) flags.push("the origin did not respond on the last crawl");
  if (injected) flags.push("listing text contains instructions aimed at agents (prompt-injection shape); rows are excluded from routing");

  // ------------------------------------------------------------------ health
  const paywall = detail.paywall || null;
  const health = {
    crawlHealthScore: typeof detail.health === "number" ? detail.health : null,
    routable: detail.routable === true,
    paywallProbe: paywall
      ? { ok: paywall.ok === true, status: paywall.status ?? null, url: paywall.url || null, at: PLAIN(paywall.at), mpp: paywall.mpp === true, error: paywall.error || null }
      : { probed: false },
    note: "crawlHealthScore says the manifest parsed on recent crawls; paywallProbe says a paid route answered a real 402. Read both.",
  };
  if (paywall && paywall.ok === false) flags.push(`the last paywall probe failed (${paywall.error || `HTTP ${paywall.status}`}): paid routes may not be answering 402s`);
  if (!paywall) flags.push("no paywall probe on record yet");
  if (typeof detail.health === "number" && detail.health < 0.5) flags.push(`crawl health ${detail.health.toFixed(2)}: the manifest failed to parse on most recent crawls`);

  // ----------------------------------------------------------------- catalog
  const tools = (detail.tools || []).slice(0, 500);
  const paidTools = tools.filter((t) => t.paid !== false && Number(t.price) > 0);
  const prices = paidTools.map((t) => Number(t.price)).filter((p) => p > 0).sort((x, y) => x - y);
  const networks = [...new Set(tools.flatMap((t) => t.networks || []))];
  let stale = 0, carried = 0, disagree = 0, inferredMethod = 0, correctedMethod = 0, templates = 0, verifyDue = 0, unpriced = 0;
  const toolRows = tools.slice(0, TOOL_ROWS_MAX).map((t) => {
    const key = `${String(t.method || "GET").toUpperCase()} ${t.route || ""}`;
    const raw = rawByKey.get(key) || {};
    const isStale = typeof helpers.quoteIsStale === "function" ? helpers.quoteIsStale(raw, now) : false;
    const disagrees = typeof helpers.priceDisagreesWithOrigin === "function" ? helpers.priceDisagreesWithOrigin(raw) : false;
    const needsVerify = typeof helpers.networksNeedLiveVerify === "function" ? helpers.networksNeedLiveVerify(raw, now) : false;
    if (isStale) stale++;
    if (raw.quoteCarriedForward) carried++;
    if (disagrees) disagree++;
    if (raw.methodInferred) inferredMethod++;
    if (raw.methodCorrectedFrom) correctedMethod++;
    if (t.urlTemplate) templates++;
    if (needsVerify) verifyDue++;
    if (t.paid !== false && !(Number(t.price) > 0)) unpriced++;
    const delivery = deliveries && typeof deliveries.get === "function" ? deliveries.get(key) : (deliveries ? deliveries[key] : null);
    return {
      method: String(t.method || "GET").toUpperCase(),
      route: t.route,
      name: PLAIN(t.name),
      priceUsd: Number(t.price) > 0 ? Number(t.price) : null,
      networks: Array.isArray(t.networks) ? t.networks : [],
      price: {
        source: raw.quoteSource || (raw.priceResolvedFrom ? `origin (${raw.priceResolvedFrom})` : (Number(t.price) > 0 ? "manifest" : null)),
        observedAt: iso(raw.quoteObservedAt),
        carriedForward: raw.quoteCarriedForward === true,
        stale: isStale,
        originDeclaredUsd: Number(raw.originDeclaredPrice) > 0 ? Number(raw.originDeclaredPrice) : null,
        disagreesWithOrigin: disagrees,
        conflict: t.priceConflict || null,
      },
      method_provenance: {
        inferred: raw.methodInferred === true,
        correctedFrom: raw.methodCorrectedFrom || null,
      },
      networksVerifiedAt: iso(raw.networksVerifiedAt),
      networksVerificationDue: needsVerify,
      urlTemplate: t.urlTemplate || null,
      dispatch: t.routerDispatchReason || null,
      ourPaidCalls: delivery || null,
    };
  });
  const catalog = {
    toolCount: detail.toolCount ?? tools.length,
    paidToolCount: paidTools.length,
    priceRangeUsd: prices.length ? { min: prices[0], max: prices[prices.length - 1] } : null,
    networksAdvertised: networks,
    tools: toolRows,
    toolsTruncated: tools.length > TOOL_ROWS_MAX,
    priceProvenance: { stale, carriedForward: carried, disagreeWithOrigin: disagree, unpriced, urlTemplates: templates, methodInferred: inferredMethod, methodCorrected: correctedMethod, networksVerificationDue: verifyDue },
  };
  if (!networks.length) flags.push("no payment network is known for any route; the router cannot pick a wallet to pay from");
  if (stale) flags.push(`${stale} learned price(s) are past the 7-day quote age and due a re-read`);
  if (disagree) flags.push(`${disagree} route(s) hold a price that disagrees 2x or more with the seller's own declaration`);
  if (carried) flags.push(`${carried} price(s) were carried forward from an earlier crawl rather than read this cycle`);
  if (correctedMethod) flags.push(`${correctedMethod} route(s) answer a different HTTP method than the seller declared`);
  if (templates) flags.push(`${templates} route(s) carry a URL template the router cannot fill`);
  const wrongDomain = toolRows.filter((t) => t.dispatch === "usdc_domain_mismatch").length;
  if (wrongDomain) flags.push(`${wrongDomain} route(s) advertise a Base USDC accept under the wrong EIP-712 domain name; no stock x402 buyer can pay them until the seller's accept names the token's own domain`);
  if (!paidTools.length) flags.push("no priced route is indexed, so nothing here is routable");

  // ----------------------------------------------------------------- wallets
  const payTosByNetwork = detail.payTosByNetwork || {};
  const basePayTo = detail.payToByNetwork?.["eip155:8453"] || null;
  const inherited = evidenceBinding?.payTos ? [...evidenceBinding.payTos] : [];
  const ownSettled = Number(evidenceBinding?.ownSettled) || 0;
  const ownPayers = evidenceBinding?.ownPayers;
  const claimsFor = basePayTo && sharedClaims ? sharedClaims[String(basePayTo).toLowerCase()] : null;
  const wallets = {
    advertisedByNetwork: payTosByNetwork,
    base: {
      advertised: basePayTo,
      ownEvidence: { settled: ownSettled, payers: ownPayers === undefined ? null : ownPayers, note: "chain join on this origin's OWN advertised address, plus any committed seed" },
      inheritedFrom: inherited.length ? inherited : [],
      inheritedNote: inherited.length ? "evidence counted for this origin came partly from wallets other listings also name; the router requires the live 402 to pay one of them" : null,
      sharedWithOrigins: Array.isArray(claimsFor) ? claimsFor.filter((o) => String(o).toLowerCase() !== String(origin).toLowerCase()) : [],
    },
    routerDispatchDetail: dispatch?.routerDispatchDetail || null,
  };
  if (wallets.base.sharedWithOrigins.length) flags.push(`the advertised Base wallet is also advertised by ${wallets.base.sharedWithOrigins.length} other origin(s); chain evidence for it is withheld from all of them`);
  if (dispatch?.routerDispatchDetail === "evidence_payto_mismatch") flags.push("the settlement evidence behind this origin belongs to a wallet its live 402 does not pay; the router will not spend on it");
  if (dispatch?.routerDispatchDetail === "evidence_payto_unverified") flags.push("the router could not read a live 402 payTo to bind the inherited evidence to");

  // ------------------------------------------------------- settlement evidence
  const base = leaderboardRow
    ? {
        source: "on-chain leaderboard (Base USDC, ours)",
        callsSettled: leaderboardRow.callsSettled ?? 0,
        uniqueBuyers: leaderboardRow.uniqueBuyers ?? 0,
        totalUsd: typeof leaderboardRow.totalUsd === "number" ? leaderboardRow.totalUsd : null,
        wallets: Array.isArray(leaderboardRow.wallets) ? leaderboardRow.wallets : (leaderboardRow.wallet ? [leaderboardRow.wallet] : []),
        window: leaderboardRow.window || null,
      }
    : { source: "on-chain leaderboard (Base USDC, ours)", observed: false };
  const bazaarBlock = bazaar
    ? { source: "Coinbase Bazaar, last 30 days (their measurement, not ours)", calls30d: bazaar.calls30d ?? 0, payers30d: bazaar.payers30d ?? 0, lastCalledAt: PLAIN(bazaar.lastCalledAt), payTos: Array.isArray(bazaar.payTos) ? bazaar.payTos : [] }
    : { source: "Coinbase Bazaar", observed: false };
  const solanaBlock = solana
    ? { source: "Solana SPL leaderboard (USDC credits, ours)", credits: solana.credits ?? 0, payers: solana.payers ?? 0, note: "read at pay time by the router; never folded into the Base gate" }
    : { source: "Solana SPL leaderboard", observed: false };
  const mppBlock = mpp
    ? {
        source: "MPP index + Tempo transfer feed (ours)",
        verified: mpp.verified === true,
        lastProbeOk: mpp.lastProbeOk === true,
        offers: Array.isArray(mpp.offers) ? mpp.offers.map((o) => ({ method: o.method || null, intent: o.intent || null, recipient: o.recipient || null, currency: o.currency || null, chainId: o.chainId ?? null, amount: o.amount ?? null })) : [],
        recipients: Array.isArray(mpp.recipients) ? mpp.recipients.map((r) => ({ recipient: r.recipient, transfers: r.transfers ?? 0, payers: r.payers ?? 0, proven: r.proven === true, routable: r.routable === true })) : [],
      }
    : { source: "MPP index", observed: false };
  const settlementEvidence = { base, bazaar: bazaarBlock, solana: solanaBlock, mpp: mppBlock };
  const anyEvidence = (base.callsSettled || 0) > 0 || (bazaarBlock.calls30d || 0) > 0 || (solanaBlock.credits || 0) > 0 || (mppBlock.recipients || []).some((r) => r.transfers > 0);
  if (!anyEvidence) flags.push("no settlement to this seller has been observed by any source we read");
  if (base.callsSettled > 0 && base.uniqueBuyers > 0 && base.callsSettled / base.uniqueBuyers > 200) flags.push(`Base volume is concentrated: ${base.callsSettled} settlements from ${base.uniqueBuyers} buyer(s)`);

  // ------------------------------------------------------------------- router
  const router = {
    eligible: self ? false : dispatch?.routerDispatchEligible === true,
    reason: self ? "self" : (dispatch?.routerDispatchReason || null),
    byChain: dispatch?.routerDispatchByChain || null,
    executeVia: dispatch?.executeVia || dispatch?.executeViaWhenEligible || null,
    executeViaCallableNow: dispatch?.executeViaCallableNow === true,
    gate: {
      settlementThreshold: thresholds.sorThreshold ?? null,
      distinctPayersThreshold: thresholds.sorPayers ?? null,
      underlyingCapUsd: thresholds.sorCap ?? null,
      cheapestPaidToolUsd: prices.length ? prices[0] : null,
    },
    refusals: (refusals || []).map((r) => ({ chain: r.chain, at: iso(r.at), status: r.status ?? null })),
    // A refusal is the seller declining our payment (nobody charged). This is
    // the other outcome: the payment went out and nothing came back.
    //
    // CHAIN AND DATE ONLY (the operator, 2026-09-11). This tool is sold to
    // anyone for $0.05, so it is a public surface wearing a price tag. "We
    // paid them and stopped routing there" is our own routing decision and is
    // fair to publish; "they answered HTTP 500 after 120 seconds" is a
    // specific adverse claim about a named company's engineering, and nothing
    // else in this dossier is in that category - every other figure is a
    // count, a gate verdict, or something the seller advertises about itself.
    // The evidence reads back through /__operator/router-delivery.json.
    //
    // Deliberately NOT applied to `refusals` above, which keeps its status:
    // a 402 or 401 on a paid retry is frequently OUR end (a credential our
    // side built wrong, the EIP-712 domain case), so the status there informs
    // rather than accuses, and dropping it would make a seller's own row less
    // useful to them for no gain.
    deliveryFailures: (deliveryFailures || []).map((r) => ({ chain: r.chain, at: iso(r.at) })),
  };
  if (router.refusals.length) flags.push(`our router's last paid retry was refused on ${router.refusals.map((r) => r.chain).join(", ")}; those chains are skipped until the memo expires`);
  for (const f of router.deliveryFailures) flags.push(`our router paid this seller on ${f.chain} and the call did not deliver, so that chain is skipped until the memo expires or a call succeeds (what we observed is not published here; ask us)`);
  if (!self && dispatch && dispatch.routerDispatchEligible !== true && dispatch.routerDispatchReason) flags.push(`router verdict: ${dispatch.routerDispatchReason}`);
  if (prices.length && thresholds.sorCap != null && prices[0] > thresholds.sorCap) flags.push(`the cheapest priced route ($${prices[0]}) is above the router's $${thresholds.sorCap} underlying cap for the cheapest tier`);

  // -------------------------------------------------------- our paid calls
  const observed = toolRows.filter((t) => t.ourPaidCalls).map((t) => ({ method: t.method, route: t.route, ...t.ourPaidCalls }));
  const delivery = {
    source: "route-and-execute paid calls (ours)",
    routesObserved: observed.length,
    calls: observed.reduce((n, o) => n + (o.calls || 0), 0),
    kept: observed.reduce((n, o) => n + (o.kept || 0), 0),
    rows: observed,
  };
  const lowKeep = observed.filter((o) => o.calls >= 3 && o.keptRate < 0.8);
  if (lowKeep.length) flags.push(`${lowKeep.length} route(s) we paid delivered less than 80% of the time (${lowKeep.map((o) => o.route).join(", ")})`);

  return {
    origin,
    listed: true,
    ...(self ? { self: true, note: "this is the local catalog - our router never routes to itself" } : {}),
    identity,
    health,
    catalog,
    wallets,
    settlementEvidence,
    router,
    delivery,
    flags,
    caveats,
    evidenceSource: "x402 seller crawl + on-chain settlement + Bazaar + MPP index + our own paid calls",
    generatedAt,
  };
}

export function buildSellerDossierTool({
  getSellerDetail, getSellerEntry, getDispatchRow, getEvidenceBinding, getLeaderboardRow, getBazaarQuality,
  getSolanaEvidence, getMpp, getRefusals, getDeliveryFailures, getRegistration, getDelivery, getSharedClaims, helpers = {},
  sorThreshold = 50, sorPayers = 3, sorCap = 0.005, selfHost = "", now = () => Date.now(),
}) {
  return {
    route: "POST /api/seller-dossier",
    name: "x402 seller dossier",
    slug: "seller-dossier",
    category: "x402",
    price: "$0.05",
    description:
      "Everything Agent402 knows about one x402 seller origin, in one read: identity and crawl history, the catalog with the provenance of every price (live-402 or manifest, when it was read, whether it is stale or disagrees with the seller's own declaration), advertised wallets against the wallets that were actually paid (own chain evidence, inherited wallets, shared claims), settlement evidence per source (our Base leaderboard, Coinbase Bazaar, Solana SPL credits, MPP transfers), the router's own dispatch verdict per chain with its reason and any recent refusal, and what happened the times our router paid it. Ends in plain-English flags, never a score. Deterministic and offline: assembled from our crawl, probes, ledger and chain reads, never a live fetch of the seller. Priced above the list endpoints because it is the assembled record, not a listing.",
    tags: ["x402", "seller", "dossier", "due-diligence", "trust", "reputation", "counterparty", "verify", "price-drift",
      "wallet", "settlement", "evidence", "router", "discovery", "check a seller before paying", "is this seller real",
      "who has paid this seller", "seller background check"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Seller origin or bare host, e.g. https://example.com or example.com" },
        },
        required: ["origin"],
      },
      input: { origin: "agent402.tools" },
      example: { origin: "agent402.tools" },
      output: {
        example: {
          origin: "https://seller.example",
          listed: true,
          identity: { displayName: "Example Seller", homepage: "https://seller.example", discoveryPath: "/.well-known/x402", mppDualStack: false, originResponded: true, crawlError: null, robotsBlocked: false, lastCrawledAt: "2026-09-08T01:00:00.000Z", firstRegisteredAt: "2026-08-01T00:00:00.000Z", lastRoutableSeenAt: "2026-09-08T01:00:00.000Z", lastSettledSeenAt: null, listingTextLooksInjected: false },
          health: { crawlHealthScore: 1, routable: true, paywallProbe: { ok: true, status: 402, url: "https://seller.example/api/x", at: "2026-09-08T01:00:00.000Z", mpp: false, error: null }, note: "crawlHealthScore says the manifest parsed on recent crawls; paywallProbe says a paid route answered a real 402. Read both." },
          catalog: { toolCount: 2, paidToolCount: 2, priceRangeUsd: { min: 0.01, max: 0.04 }, networksAdvertised: ["eip155:8453"], tools: [{ method: "POST", route: "/api/x", name: "X", priceUsd: 0.01, networks: ["eip155:8453"], price: { source: "live-402", observedAt: "2026-09-08T01:00:00.000Z", carriedForward: false, stale: false, originDeclaredUsd: 0.01, disagreesWithOrigin: false, conflict: null }, method_provenance: { inferred: false, correctedFrom: null }, networksVerifiedAt: null, networksVerificationDue: false, urlTemplate: null, dispatch: "settlement_required", ourPaidCalls: null }], toolsTruncated: false, priceProvenance: { stale: 0, carriedForward: 0, disagreeWithOrigin: 0, unpriced: 0, urlTemplates: 0, methodInferred: 0, methodCorrected: 0, networksVerificationDue: 0 } },
          wallets: { advertisedByNetwork: { "eip155:8453": ["0x1111111111111111111111111111111111111111"] }, base: { advertised: "0x1111111111111111111111111111111111111111", ownEvidence: { settled: 12, payers: 4, note: "chain join on this origin's OWN advertised address, plus any committed seed" }, inheritedFrom: [], inheritedNote: null, sharedWithOrigins: [] }, routerDispatchDetail: null },
          settlementEvidence: { base: { source: "on-chain leaderboard (Base USDC, ours)", callsSettled: 12, uniqueBuyers: 4, totalUsd: 0.18, wallets: ["0x1111111111111111111111111111111111111111"], window: null }, bazaar: { source: "Coinbase Bazaar, last 30 days (their measurement, not ours)", calls30d: 30, payers30d: 5, lastCalledAt: "2026-09-07T20:00:00.000Z", payTos: ["0x1111111111111111111111111111111111111111"] }, solana: { source: "Solana SPL leaderboard", observed: false }, mpp: { source: "MPP index", observed: false } },
          router: { eligible: false, reason: "settlement_required", byChain: { base: { eligible: false, reason: "settlement_required" } }, executeVia: null, executeViaCallableNow: false, gate: { settlementThreshold: 50, distinctPayersThreshold: 3, underlyingCapUsd: 0.005, cheapestPaidToolUsd: 0.01 }, refusals: [], deliveryFailures: [] },
          delivery: { source: "route-and-execute paid calls (ours)", routesObserved: 0, calls: 0, kept: 0, rows: [] },
          flags: ["router verdict: settlement_required", "the cheapest priced route ($0.01) is above the router's $0.005 underlying cap for the cheapest tier"],
          caveats: ["every count here is a floor: it is what our crawl, probes and chain reads have observed, never the seller's total"],
          evidenceSource: "x402 seller crawl + on-chain settlement + Bazaar + MPP index + our own paid calls",
          generatedAt: "2026-09-08T02:00:00.000Z",
        },
      },
    },
    handler(input) {
      const raw = String(input?.origin || input?.host || input?.seller || "").trim();
      if (!raw) { const e = new Error("`origin` is required - pass a seller origin or bare host, e.g. example.com"); e.statusCode = 400; throw e; }
      const host = hostOf(raw);
      if (!host.includes(".")) { const e = new Error("`origin` must be a public host, e.g. example.com"); e.statusCode = 400; throw e; }
      const t = now();
      const detail = getSellerDetail(host) || null;
      const origin = detail?.origin || `https://${host}`;
      const self = Boolean(selfHost) && host === String(selfHost).toLowerCase();
      const entry = detail && typeof getSellerEntry === "function" ? (getSellerEntry(host) || null) : null;
      const dispatch = detail && typeof getDispatchRow === "function" ? (getDispatchRow(detail) || null) : null;
      const rows = detail ? (detail.tools || []).slice(0, TOOL_ROWS_MAX) : [];
      const deliveries = new Map();
      if (typeof getDelivery === "function") {
        for (const r of rows) {
          const key = `${String(r.method || "GET").toUpperCase()} ${r.route || ""}`;
          const d = getDelivery(origin, r.method, r.route);
          if (d) deliveries.set(key, d);
        }
      }
      return composeSellerDossier({
        host, detail, entry, dispatch,
        evidenceBinding: typeof getEvidenceBinding === "function" ? getEvidenceBinding(origin) : null,
        leaderboardRow: typeof getLeaderboardRow === "function" ? getLeaderboardRow(origin, host) : null,
        bazaar: typeof getBazaarQuality === "function" ? getBazaarQuality(origin) : null,
        solana: typeof getSolanaEvidence === "function" ? getSolanaEvidence(origin) : null,
        mpp: typeof getMpp === "function" ? getMpp(origin, host) : null,
        refusals: typeof getRefusals === "function" ? getRefusals(origin) : [],
        deliveryFailures: typeof getDeliveryFailures === "function" ? getDeliveryFailures(origin) : [],
        registration: typeof getRegistration === "function" ? getRegistration(origin) : null,
        deliveries,
        sharedClaims: typeof getSharedClaims === "function" ? getSharedClaims() : null,
        helpers, thresholds: { sorThreshold, sorPayers, sorCap }, self, now: t,
      });
    },
  };
}
