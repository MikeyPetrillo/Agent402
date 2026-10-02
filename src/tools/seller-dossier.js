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

// Bound the input BEFORE any pattern runs, then strip the scheme and the path
// with index arithmetic rather than a regex. `/\/.*$/` is polynomial on a
// value the caller controls (CodeQL js/polynomial-redos, high): a string of
// many slashes backtracks. Same defect and same fix as isSelfSellerQuery in
// host-entry.js on 2026-08-28; it surfaced here when the operator evidence
// route added a second caller-controlled path into this tool, on top of the
// paid tool's own `origin` parameter.
export function hostOf(raw) {
  let v = String(raw || "").trim().slice(0, 300).toLowerCase();
  for (const scheme of ["https://", "http://"]) {
    if (v.startsWith(scheme)) { v = v.slice(scheme.length); break; }
  }
  const slash = v.indexOf("/");
  if (slash >= 0) v = v.slice(0, slash);
  return v.slice(0, 253);
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
    refusals = [], deliveryFailures = [], registration, deliveries, sharedClaims, helpers = {}, thresholds = {}, self = false, loading = null, now = Date.now(),
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
      // `loading` overrides the reason outright: "never crawled" is a claim
      // about the seller and would be false while this boot is still reading.
      ...(loading || {}),
      reason: self
        ? "the local catalog is not a crawled seller; call its tools directly"
        : loading
          ? `not in this server's index YET - it is still ${loading.indexState}, so this is not a finding about ${host}`
          : "not in our index - never crawled, so we hold no evidence either way",
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
  // Describe the MATCH, never a purpose. "instructions aimed at agents" asserts
  // intent we cannot observe from text alone, about a named business; the
  // observable fact is that the listing text matches an imperative-instruction
  // pattern, and that we excluded the rows. Same finding, no imputed motive.
  if (injected) flags.push("listing text matches our imperative-instruction pattern (the shape a prompt injection takes); rows are excluded from routing as a precaution");

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
  // Counted apart, and worded apart: this seller is not misconfigured, we are
  // the ones who do not speak its rail yet.
  const gatewayRail = toolRows.filter((t) => t.dispatch === "gateway_rail_unsupported").length;
  if (gatewayRail) flags.push(`${gatewayRail} route(s) price in Circle Gateway's batched rail rather than a plain EIP-3009 accept; this router's stock signer cannot pay them, and that is a gap on our side, not a defect on the seller's`);
  if (!paidTools.length) flags.push("no priced route is indexed, so nothing here is routable");

  // ----------------------------------------------------------------- wallets
  const payTosByNetwork = detail.payTosByNetwork || {};
  const basePayTo = detail.payToByNetwork?.["eip155:8453"] || null;
  // The binding's payTos are EVERY wallet with evidence, the origin's own
  // advertised wallet included; only the others are inherited.
  const ownWallets = new Set([basePayTo, ...Object.values(payTosByNetwork).flat()].filter((w) => typeof w === "string").map((w) => w.toLowerCase()));
  const inherited = evidenceBinding?.payTos ? [...evidenceBinding.payTos].filter((w) => !ownWallets.has(String(w).toLowerCase())) : [];
  const ownSettled = Number(evidenceBinding?.ownSettled) || 0;
  const ownPayers = evidenceBinding?.ownPayers;
  const claimsFor = basePayTo && sharedClaims ? sharedClaims[String(basePayTo).toLowerCase()] : null;
  // Every figure the router credits this origin with, kept against the wallet
  // it was measured at: the gate asks whether the wallet the live 402 names
  // clears the floor on that wallet's own figures.
  const byWallet = evidenceBinding?.byWallet instanceof Map
    ? [...evidenceBinding.byWallet].map(([wallet, v]) => ({ wallet, settled: Number(v?.settled) || 0, payers: v?.payers === undefined ? null : Number(v.payers), clearsFloor: evidenceBinding.clearing instanceof Set ? evidenceBinding.clearing.has(wallet) : null }))
    : [];
  // The router's Base detail, wherever the dispatch row carries it.
  const baseDetail = dispatch?.routerDispatchDetail || dispatch?.routerDispatchByChain?.base?.detail || null;
  // What the router did NOT count because it was paid with USDC the seller's
  // own wallet had sent the payer earlier: what the scan ACTUALLY netted,
  // summed over this origin's wallets, counts only. Never the figures that
  // would have counted had those payments been genuine (most of those are the
  // payers' own money, and publishing them under this heading would present a
  // seller's whole history as self-funded), and never per wallet or per payer:
  // that detail stays on the operator surface, as delivery failures do.
  const netted = evidenceBinding?.selfFunded?.netted instanceof Map ? [...evidenceBinding.selfFunded.netted.values()] : [];
  const nettedCalls = netted.reduce((a, n) => a + (Number(n?.calls) || 0), 0);
  const nettedUsd = Number(netted.reduce((a, n) => a + (Number(n?.usd) || 0), 0).toFixed(6));
  const mostlySelfFunded = netted.some((n) => n?.circular === true);
  // Payments the seller refunded: removed from the evidence, not self-funding.
  const refundedCalls = netted.reduce((a, n) => a + (Number(n?.refunded) || 0), 0);
  const baseReason = dispatch?.routerDispatchByChain?.base?.reason || dispatch?.routerDispatchReason || null;
  const changesRouterVerdict = baseReason === "settlement_self_funded";
  const wallets = {
    advertisedByNetwork: payTosByNetwork,
    base: {
      advertised: basePayTo,
      ownEvidence: { settled: ownSettled, payers: ownPayers === undefined ? null : ownPayers, note: "chain join on this origin's OWN advertised address" },
      evidenceByWallet: byWallet,
      evidenceByWalletNote: byWallet.length ? "settlement evidence credited to this origin, per wallet it was measured at; the router pays only a wallet whose own figures clear the floor, and only when the live 402 names it" : null,
      // Figures at wallets this host lists as shared settlement contracts:
      // credited to no seller, reported so their absence is never read as zero.
      withheldAtSharedWallets: evidenceBinding?.withheld?.byWallet instanceof Map
        ? [...evidenceBinding.withheld.byWallet].map(([wallet, v]) => ({ wallet, settled: Number(v?.settled) || 0, payers: v?.payers === undefined ? null : Number(v.payers) }))
        : [],
      selfFunded: nettedCalls > 0 || mostlySelfFunded
        ? { nettedCalls, nettedUsd, mostlySelfFunded, changesRouterVerdict, note: "payments the router's scan found paid with USDC this seller's own wallet had sent the payer earlier (a refund of the payer's own earlier payments is not counted here: see refunded); they are not counted as settlement. Summed over the scan window and this origin's wallets" }
        : null,
      refunded: refundedCalls > 0
        ? { calls: refundedCalls, note: "payments the seller refunded to the payer that made them; refunded payments are not counted as settlement, and are not self-funding. Summed over the scan window and this origin's wallets" }
        : null,
      inheritedFrom: inherited.length ? inherited : [],
      inheritedNote: inherited.length ? "evidence counted for this origin came partly from wallets other listings also name; the router requires the live 402 to pay one of them" : null,
      sharedWithOrigins: Array.isArray(claimsFor) ? claimsFor.filter((o) => String(o).toLowerCase() !== String(origin).toLowerCase()) : [],
    },
    routerDispatchDetail: baseDetail,
  };
  if (wallets.base.sharedWithOrigins.length) flags.push(`the advertised Base wallet is also advertised by ${wallets.base.sharedWithOrigins.length} other origin(s); chain evidence for it is withheld from all of them`);
  if (baseDetail === "evidence_payto_mismatch") flags.push("the settlement evidence that clears the floor for this origin was measured at a wallet its live 402 does not pay; the router will not spend on it");
  if (baseDetail === "evidence_payto_unverified") flags.push("the router could not read a live 402 payTo to bind the settlement evidence to");
  // Only when it matters: most of the wallet's dollars were its own, or the
  // payments it paid for itself are what keep it below the floor. A refund
  // netted from an otherwise ordinary history is in the counts above, not a flag.
  if (mostlySelfFunded) flags.push("in a router scan within the last 30 days, most of the dollars this seller's wallet received were paid with USDC that wallet had sent its payers earlier; the router counts only the rest, and not third-party tallies of that wallet (the detail is not published here; ask us)");
  else if (changesRouterVerdict) flags.push("payments made with USDC this seller's wallet had sent its payers earlier are not counted, and without them its settlement history is below the router's floor (the detail is not published here; ask us)");
  if (baseDetail === "evidence_payto_shared" || wallets.base.withheldAtSharedWallets.length) flags.push("settlement history at a wallet this host lists as a settlement contract shared by many sellers is credited to none of them; only settlement measured on this origin's own URLs counts for it");

  // Concentration reads as a sentence here, like every other dossier flag: a
  // buyer deciding whether to route to this seller wants "most of their volume
  // is one wallet", not a number they have to interpret.
  if (leaderboardRow?.concentration) {
    const c = Math.round((leaderboardRow.topPayerCallsShare || 0) * 100);
    const u = Math.round((leaderboardRow.topPayerUsdShare || 0) * 100);
    const w = leaderboardRow.withoutTopPayer;
    flags.push(
      `a single payer is ${c}% of their settlements and ${u}% of their settled USDC in this window` +
      (w ? `; without it the row is ${w.callsSettled} calls, $${(w.totalUsd ?? 0).toFixed(2)}, ${w.uniqueBuyers} buyers` : "")
    );
    if (leaderboardRow.topPayerIsAlsoTopUsd === false) {
      flags.push("a different payer again carries most of their settled USDC, so the dollar share above understates the concentration");
    }
  }
  if ((leaderboardRow?.multiSellerCallsShare || 0) >= 0.5) {
    flags.push(
      `${Math.round(leaderboardRow.multiSellerCallsShare * 100)}% of their settlements come from wallets that also pay other sellers we index` +
      `, which is evaluator traffic rather than buyers who chose them`
    );
  }

  // ------------------------------------------------------- settlement evidence
  const base = leaderboardRow
    ? {
        source: "on-chain leaderboard (Base USDC, ours)",
        callsSettled: leaderboardRow.callsSettled ?? 0,
        uniqueBuyers: leaderboardRow.uniqueBuyers ?? 0,
        totalUsd: typeof leaderboardRow.totalUsd === "number" ? leaderboardRow.totalUsd : null,
        wallets: Array.isArray(leaderboardRow.wallets) ? leaderboardRow.wallets : (leaderboardRow.wallet ? [leaderboardRow.wallet] : []),
        window: leaderboardRow.window || null,
        // Who those settlements actually came FROM. callsSettled and
        // uniqueBuyers read identically for a seller with many customers, a
        // seller with one wallet running a meter, and a seller whose buyers
        // are evaluators paying everyone - and this product exists to answer
        // exactly that question. Shares only; the payer roster is theirs.
        concentration: leaderboardRow.concentration !== undefined
          ? {
              topPayerCallsShare: leaderboardRow.topPayerCallsShare ?? null,
              topPayerUsdShare: leaderboardRow.topPayerUsdShare ?? null,
              topPayerIsAlsoTopUsd: leaderboardRow.topPayerIsAlsoTopUsd ?? null,
              withoutTopPayer: leaderboardRow.withoutTopPayer ?? null,
              flag: leaderboardRow.concentration ?? null,
              multiSellerPayers: leaderboardRow.multiSellerPayers ?? null,
              multiSellerCallsShare: leaderboardRow.multiSellerCallsShare ?? null,
              maxPayerSellerSpan: leaderboardRow.maxPayerSellerSpan ?? null,
              note: "shares of this window's Base USDC settlements; payer addresses are never published",
            }
          : null,
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
  if (router.refusals.length) flags.push(`our router's paid retries to one of this seller's routes were refused on ${router.refusals.map((r) => r.chain).join(", ")}; that route is skipped there until the memo expires`);
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
    // Every line above is an OBSERVATION we made, at generatedAt, by the method
    // named in evidenceSource - not a conclusion about the business, its
    // operators or their conduct. Published about named third parties, so it
    // says so in the payload itself rather than in documentation the reader may
    // never open, and it names a route to have a reading corrected.
    notice: NOTICE,
    generatedAt,
  };
}

// What this report claims, stated in the report itself.
//
// This is the one product that publishes an assessment-shaped read of a NAMED
// third-party business, so the discipline is: every line is an observation we
// made, by a stated method, at a stated time - never a characterisation of the
// company, its operators or their intent. Truth and disclosed method are what
// make a report like this fair; a verdict dressed as a fact is what makes it
// actionable. Flags describe what WE read and what OUR router experienced, in
// the first person, and unobserved is "not observed", never zero.
//
// The notice ships inside the payload rather than in documentation, because the
// payload is what gets quoted, and it names a route to have a reading corrected.
// A seller who thinks a line is wrong should be able to reach us without
// guessing; that path is also the cheapest way for us to find out we are wrong.
export const NOTICE = Object.freeze({
  what: "Automated observations of public data, recorded by Agent402 at generatedAt using the methods named in evidenceSource.",
  notAnAssessment: "This is not an assessment of the business, its operators, their conduct or their creditworthiness, and it is not advice. Flags describe what our crawler read and what our router experienced, not conclusions about the seller.",
  unobserved: "\"Not observed\" means we hold no reading, not that the thing did not happen. Absence of evidence here is absence of OUR evidence.",
  pointInTime: "Every figure is as of generatedAt and may already be stale; re-read before relying on it.",
  corrections: "A seller who believes a line misreads them can write to mike@agent402.tools and we will re-read the origin and correct or withdraw the line.",
});

export function buildSellerDossierTool({
  getSellerDetail, getSellerEntry, getDispatchRow, getEvidenceBinding, getLeaderboardRow, getBazaarQuality,
  getSolanaEvidence, getMpp, getRefusals, getDeliveryFailures, getRegistration, getDelivery, getSharedClaims, helpers = {},
  getIndexReadiness = null,
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
    // `ctx` is a SECOND argument, which the HTTP dispatcher never passes: the
    // operator flag must not be reachable from a request body, or a buyer
    // could set it and pay $0.05 for the hollow answer this refusal exists to
    // stop them being sold. Only an in-process caller can set it.
    handler(input, ctx = {}) {
      const operator = ctx?.operator === true;
      const raw = String(input?.origin || input?.host || input?.seller || "").trim();
      if (!raw) { const e = new Error("`origin` is required - pass a seller origin or bare host, e.g. example.com"); e.statusCode = 400; throw e; }
      const host = hostOf(raw);
      if (!host.includes(".")) { const e = new Error("`origin` must be a public host, e.g. example.com"); e.statusCode = 400; throw e; }
      const t = now();
      const detail = getSellerDetail(host) || null;
      // "WE HOLD NOTHING" IS ONLY WORTH $0.05 IF IT IS A FACT ABOUT THE SELLER.
      // The no-detail branch below says "not in our index - never crawled, so we
      // hold no evidence either way", which is a strong claim about a third
      // party, and it was made from a cache that can simply be mid-load: the
      // warm-start reads the volume for ~2 s after every boot, and a volume with
      // no cache waits minutes for its first crawl. A buyer paying for the
      // assembled record would have been sold "never crawled" about a seller we
      // crawl every 30 minutes. A >= 400 cancels settlement, so refusing here
      // costs the buyer nothing and is the only honest answer while loading.
      //
      // THE OPERATOR IS NOT A BUYER. /__operator/seller-evidence.json shares
      // this handler, pays nothing, and is the surface used to diagnose a
      // seller DURING the minutes a boot is still crawling - refusing it takes
      // the tool away exactly when it is wanted. So the operator gets the
      // record we hold plus the caveat as a FIELD (`indexLoading`), which is
      // what this whole class asks for: state the scope, do not withhold the
      // answer. Only the paid path refuses, because only the paid path charges.
      const readiness = !detail && typeof getIndexReadiness === "function" ? (getIndexReadiness() || {}) : {};
      if (readiness.ready === false && !operator) {
        const e = new Error(`the seller index is still loading on this server (${readiness.state || "loading"}), so "we hold nothing for ${host}" would be a fact about us, not about that seller - not charged, retry in ${readiness.retryAfterSeconds || 30}s`);
        e.statusCode = 503;
        e.retryAfter = Number(readiness.retryAfterSeconds) || 30;
        throw e;
      }
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
      const loading = readiness.ready === false
        ? { indexLoading: true, indexState: readiness.state || "loading", retryAfterSeconds: Number(readiness.retryAfterSeconds) || 30,
            indexLoadingNote: `the seller index is still loading on this server (${readiness.state || "loading"}), so an absence below is a fact about this boot, not about ${host}` }
        : null;
      return composeSellerDossier({
        loading,
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
