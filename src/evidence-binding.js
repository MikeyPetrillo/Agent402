// Settlement evidence, bound to the WALLET it was measured at (2026-09-03,
// per wallet since 2026-09-28).
//
// The router's Base gate reads these kinds of evidence per origin:
//   - the chain join on the origin's OWN advertised Base address
//     (provenByChain), kept against that address;
//   - the x402 leaderboard, whose rows are keyed by operator and carry the
//     WALLETS they were paid at and every origin whose listing names one, with
//     the scan's per-wallet evidence beside them (getLeaderboardWalletEvidence);
//   - the Bazaar's per-resource quality counts, measured on the origin's own
//     URLs and split by the Base payTo each resource declares.
// NOT evidence: the committed seed (src/sor-seed-sellers.json). It is a list
// of origin NAMES with counts attributable to no wallet, so it could clear the
// floor with no binding and no payer figure at all (2026-09-28). The
// leaderboard warm-starts from the volume, so no measured history is lost.
// SELF-FUNDED payments are not evidence (2026-09-28): a payment into wallet W
// made with USDC that W had sent its payer is the seller's own money coming
// home. The leaderboard's per-wallet figures arrive already netted of those
// (src/seller-funding.js). The Bazaar's and the chain join's figures at W count
// the same payments, so they are reduced by what W's own scan netted: the
// payments paid with its money, the payments it refunded (not revenue
// either), the payers that only ever paid with its money, and the payers
// whose every payment it refunded,
// over the Bazaar's 30 days for the Bazaar and over the scan window for the
// chain join (both measured over those same days). The chain join is a
// WALLET-wide figure, so it loses the whole netted count. The Bazaar's figure
// is one origin's SHARE of the wallet's calls, and its payer count a MAX over
// that origin's resources, so a wallet-wide deduction is not all attributable
// to it (bazaarNet): an origin loses only the netted calls the wallet's other
// origins cannot hold, and its payers the wallet's self-funded payers (which
// resource they paid is unknowable), but it never falls below the genuine
// calls and payers the wallet's own scan measured (those are exact, and the
// money goes to the same wallet). Without the reduction, a seller
// paying cheap calls from wallets it funded kept that share of the dollars
// small enough never to be judged circular, and the third-party count of the
// same calls cleared the floor on its own. When MOST of the dollars a wallet
// received were self-funded (a "circular" wallet), its Bazaar and chain-join
// figures are disregarded outright; the netted leaderboard figures, the
// genuine part, still count. What was not credited is kept as `selfFunded`
// (the figures that would have counted, for the label's wording) and what was
// netted as `selfFunded.netted` (counts only).
// A wallet the operator LISTS as shared (a split or settlement contract many
// sellers are paid through, src/shared-paytos.js) credits nobody with its
// leaderboard or chain-join history: those figures count payments forwarded
// to every seller behind it. An origin paid there keeps only the Bazaar
// evidence measured on its own URLs. What is not credited is reported as
// withheld, never as absent.
// Every figure is kept against the wallet it was measured at, and a wallet's
// figures count only for that wallet. The gate asks ONE question of the address
// the origin's live 402 asks to be paid at: does THAT wallet's own evidence
// clear the floor?
//
// Why per wallet and not "any wallet the origin was credited with": the
// 2026-09-03 form kept one UNION of wallets beside a MAX of counts, so an
// origin credited with a busy wallet W's history that also listed a resource
// at its own wallet V (one Bazaar call was enough to put V in the union)
// cleared the floor on W's history and was paid at V. A MAX taken per figure
// across wallets had the same shape one level down: W's call count and V's
// payer count could clear together although neither wallet cleared alone.
//
// A listing naming W can still be credited with W's evidence, and that is
// deliberate: the evidence then counts only where W is paid, so the money goes
// to W. The payer re-checks the accept it signs against the same wallets
// (payX402 `evidenceWallets`), so the probe's 402 and the payment's 402 cannot
// disagree about where the money goes.
//
// This is the ONE evidence builder: the settled and payers maps the gate reads
// are projections of what it returns. Pure functions over plain inputs, so the
// shape can be tested with a fake leaderboard row and a fake 402.
import { dispatchEligibility, evidencePayToVerdict } from "./dispatch-eligibility.js";
import { payToFromLive402, meetsRouterGate } from "./settlement-proof.js";

const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);

/** What wallet `w`'s own scan netted as self-funded, or null (no funding
 *  read, or the operator cleared the wallet: its evidence then reads gross).
 *  `calls`/`payers` over the scan window, `calls30d`/`payers30d` over the
 *  Bazaar's 30 days; `payers` are payers that paid only with the wallet's
 *  money. `refunded`/`refunded30d`: payments the wallet refunded, which are
 *  not revenue either, so third-party counts of it lose them too. */
export function nettedAtWallet(walletEvidence, w) {
  if (!walletEvidence) return null;
  const e = walletEvidence instanceof Map ? walletEvidence.get(w) : walletEvidence[w];
  if (!e || typeof e !== "object" || e.selfFundingCleared || e.grossCallsSettled === undefined) return null;
  const n = (x) => Math.max(0, Number(x) || 0);
  const calls = n(e.selfFundedCalls), payers = n(e.selfFundedPayers), refunded = n(e.refundedCalls);
  // Payers whose every payment was refunded (disjoint from the self-funded
  // ones: a payer is counted in one bucket). The scan window's figure stands
  // in for the 30 days, as the self-funded payers' did before a 30-day read.
  const refundedPayers = n(e.refundedPayers);
  return { calls, payers, usd: n(e.selfFundedUsd), calls30d: Math.max(calls, n(e.selfFundedCalls30d)), payers30d: Math.max(payers, n(e.selfFundedPayers30d)), refunded, refunded30d: Math.max(refunded, n(e.refundedCalls30d)), refundedPayers, refundedPayers30d: Math.max(refundedPayers, n(e.refundedPayers30d)) };
}

/** Fold one observation of wallet `w` into `map`: the larger count and the larger payer figure. */
function put(map, w, settled, payers) {
  if (!(Number(settled) > 0) && !(Number(payers) > 0)) return;
  const cur = map.get(w) || { settled: 0, payers: undefined };
  cur.settled = Math.max(cur.settled, Number(settled) || 0);
  if (Number(payers) > 0) cur.payers = Math.max(Number(cur.payers ?? 0), Number(payers));
  map.set(w, cur);
}

/** The per-wallet Bazaar split an origin's folded quality carries (x402-index foldBazaarQuality). */
export function bazaarByPayTo(q) {
  const split = q && typeof q === "object" ? q.byPayTo : null;
  if (split && typeof split === "object") return Object.entries(split);
  // No split (a quality object built before it existed, or by hand): the
  // counts can be attributed only when the resources declared ONE wallet.
  const payTos = (Array.isArray(q?.payTos) ? q.payTos : []).map(evmKey).filter(Boolean);
  return payTos.length === 1 ? [[payTos[0], { calls: q.calls30d, payers: q.payers30d }]] : [];
}

/** The per-wallet figures a leaderboard row contributes: the scan's per-wallet
 *  evidence when it has any of the row's wallets, else the row's totals when
 *  the row has exactly ONE wallet (they are then that wallet's), else nothing -
 *  a multi-wallet row's totals cannot be split between its wallets. */
export function rowWalletFigures(row, walletEvidence = null) {
  const wallets = [...new Set((Array.isArray(row?.wallets) && row.wallets.length ? row.wallets : [row?.wallet]).map(evmKey).filter(Boolean))];
  const evOf = (w) => {
    if (!walletEvidence) return null;
    const e = walletEvidence instanceof Map ? walletEvidence.get(w) : walletEvidence[w];
    if (!e || typeof e !== "object") return null;
    // The scan nets seller-funded payments out of callsSettled/uniqueBuyers
    // and keeps the gross figures beside them (src/leaderboard.js).
    const gross = e.grossCallsSettled !== undefined ? { settled: Number(e.grossCallsSettled) || 0, payers: Number(e.grossUniqueBuyers) || 0 } : null;
    return { settled: Number(e.callsSettled) || 0, payers: Number(e.uniqueBuyers) || 0, ...(gross ? { gross } : {}) };
  };
  const perWallet = wallets.map((w) => [w, evOf(w)]).filter(([, e]) => e);
  if (perWallet.length) return perWallet;
  if (wallets.length === 1) return [[wallets[0], { settled: Number(row?.callsSettled) || 0, payers: Number(row?.uniqueBuyers) || 0 }]];
  return [];
}

/**
 * origin -> {
 *   byWallet     Map(wallet -> { settled, payers })  evidence, per wallet it was measured at
 *   clearing     Set(wallet)  the wallets whose OWN evidence clears the floor
 *   settled, payers           the best wallet (clearing first, then most calls, then
 *                             most payers): the projection every pre-probe filter
 *                             and label reads
 *   payTos       Set(wallet)  every wallet with evidence
 *   ownSettled, ownPayers    the chain join alone (evidence on the origin's own
 *                             advertised address), for reporting
 *   withheld     { byWallet, payTos }  leaderboard / chain-join figures at wallets
 *                             the operator lists as shared: credited to nobody
 *   selfFunded   { byWallet, payTos, netted }  what was NOT credited because
 *                             it was self-funded. byWallet: the figures that
 *                             WOULD have been credited at a wallet had those
 *                             payments counted (the gross leaderboard figures,
 *                             the Bazaar / chain-join figures before netting or
 *                             at a circular wallet) - for the label's wording
 *                             only, never a claim that they were self-funded.
 *                             netted: wallet -> { calls, payers, usd, calls30d,
 *                             payers30d, circular }, what the wallet's own scan
 *                             actually found paid with its money
 * }
 *
 * `sharedWallets`, `circularWallets`: anything with has(wallet), or null.
 */
export function buildEvidenceBinding({ leaderboardRows = [], walletEvidence = null, bazaarQuality = [], chainProven = null, sharedWallets = null, circularWallets = null, minSettled = 50, minPayers = 3 } = {}) {
  const m = new Map();
  const ent = (o) => {
    const k = norm(o);
    if (!m.has(k)) m.set(k, { byWallet: new Map(), heldByWallet: new Map(), selfByWallet: new Map(), nettedByWallet: new Map(), ownSettled: 0, ownPayers: undefined });
    return m.get(k);
  };
  const isShared = (w) => !!(sharedWallets && typeof sharedWallets.has === "function" && sharedWallets.has(w));
  const isCircular = (w) => !!(circularWallets && typeof circularWallets.has === "function" && circularWallets.has(w));
  // What each wallet's own scan netted, recorded on every origin credited
  // with (or refused) figures measured at it.
  const noteNetted = (e, w) => {
    if (e.nettedByWallet.has(w)) return;
    const n = nettedAtWallet(walletEvidence, w);
    const circular = isCircular(w);
    if (circular || (n && (n.calls > 0 || n.payers > 0 || n.calls30d > 0 || n.payers30d > 0 || n.refunded > 0 || n.refunded30d > 0 || n.refundedPayers > 0))) e.nettedByWallet.set(w, { ...(n || { calls: 0, payers: 0, usd: 0, calls30d: 0, payers30d: 0, refunded: 0, refunded30d: 0, refundedPayers: 0, refundedPayers30d: 0 }), circular });
  };
  // The chain join's WALLET-wide figure at w over the scan window, reduced by
  // everything w's own scan netted over the same window.
  const netOf = (w, settled, payers) => {
    const n = nettedAtWallet(walletEvidence, w);
    const c = Number(settled) || 0;
    const dc = n ? n.calls + n.refunded : 0;
    const dp = n ? n.payers + n.refundedPayers : 0;
    if (!n || (!(dc > 0) && !(dp > 0))) return { settled: c, payers, reduced: false };
    const p = payers === undefined || payers === null ? payers : Math.max(0, (Number(payers) || 0) - dp);
    return { settled: Math.max(0, c - dc), payers: p, reduced: true };
  };
  // Every origin's Bazaar calls at each wallet, summed: the netted payments
  // at a wallet fit inside that total, whichever origin's URLs they hit.
  const bazaarTotal = new Map();
  for (const [o, q] of Array.isArray(bazaarQuality) ? bazaarQuality : []) {
    if (!o || !q) continue;
    for (const [w0, v] of bazaarByPayTo(q)) {
      const w = evmKey(w0);
      if (w && Number(v?.calls) > 0) bazaarTotal.set(w, (bazaarTotal.get(w) || 0) + Number(v.calls));
    }
  }
  const scanGenuine = (w) => {
    const e = walletEvidence instanceof Map ? walletEvidence.get(w) : walletEvidence?.[w];
    return { calls: Math.max(0, Number(e?.callsSettled) || 0), payers: Math.max(0, Number(e?.uniqueBuyers) || 0) };
  };
  // One origin's Bazaar figures at wallet w, reduced by what can be
  // attributed to it of what w's own scan netted over the 30 days.
  const bazaarNet = (w, calls, payers) => {
    const n = nettedAtWallet(walletEvidence, w);
    const c = Number(calls) || 0;
    const dc = n ? n.calls30d + n.refunded30d : 0;
    // Payers that were never buyers: paid only with the wallet's money, or
    // had every payment refunded.
    const dp = n ? n.payers30d + n.refundedPayers30d : 0;
    if (!n || (!(dc > 0) && !(dp > 0))) return { settled: c, payers, reduced: false };
    const g = scanGenuine(w);
    // Calls: the netted payments this origin must hold are those the other
    // origins' calls at w cannot; never below the scan's own genuine count.
    const total = Math.max(c, bazaarTotal.get(w) || 0);
    const settled = Math.max(Math.min(c, Math.max(0, total - dc)), Math.min(c, g.calls));
    // Payers: a MAX over this origin's resources, so which resource the
    // self-funded payers paid is unknowable and the worst case is deducted;
    // but never below the genuine payers the wallet's own scan measured.
    let p = payers;
    if (payers !== undefined && payers !== null) {
      const pv = Number(payers) || 0;
      p = Math.max(pv - dp, Math.min(pv, g.payers), 0);
    }
    return { settled, payers: p, reduced: settled < c || (p !== payers && Number(p) < Number(payers)) };
  };
  for (const row of Array.isArray(leaderboardRows) ? leaderboardRows : []) {
    const origins = Array.isArray(row?.origins) ? row.origins : (row?.homepage ? [row.homepage] : []);
    const figures = rowWalletFigures(row, walletEvidence);
    if (!figures.length) continue;
    for (const o of origins) {
      if (!o) continue;
      const e = ent(o);
      for (const [w, v] of figures) {
        if (isShared(w)) { put(e.heldByWallet, w, v.gross?.settled ?? v.settled, v.gross?.payers ?? v.payers); continue; }
        put(e.byWallet, w, v.settled, v.payers);
        noteNetted(e, w);
        if (v.gross && (v.gross.settled > v.settled || v.gross.payers > v.payers)) put(e.selfByWallet, w, v.gross.settled, v.gross.payers);
      }
    }
  }
  for (const [o, q] of Array.isArray(bazaarQuality) ? bazaarQuality : []) {
    if (!o || !q) continue;
    for (const [w0, v] of bazaarByPayTo(q)) {
      const w = evmKey(w0);
      if (!w || !(Number(v?.calls) > 0)) continue;
      const e = ent(o);
      noteNetted(e, w);
      if (isCircular(w)) { put(e.selfByWallet, w, v.calls, v.payers); continue; }
      const net = bazaarNet(w, v.calls, v.payers);
      put(e.byWallet, w, net.settled, net.payers);
      if (net.reduced) put(e.selfByWallet, w, v.calls, v.payers);
    }
  }
  if (chainProven instanceof Map) {
    for (const [o, ev] of chainProven) {
      const w = evmKey(ev?.payTo);
      if (!o || !ev || !w) continue;
      const e = ent(o);
      if (isShared(w)) { put(e.heldByWallet, w, ev.settled, ev.payers); continue; }
      noteNetted(e, w);
      if (isCircular(w)) { put(e.selfByWallet, w, ev.settled, ev.payers); continue; }
      const net = netOf(w, ev.settled, ev.payers);
      put(e.byWallet, w, net.settled, net.payers);
      if (net.reduced) put(e.selfByWallet, w, ev.settled, ev.payers);
      e.ownSettled = Math.max(e.ownSettled, net.settled);
      if (net.payers != null) e.ownPayers = Math.max(Number(e.ownPayers ?? 0), Number(net.payers) || 0);
    }
  }
  const out = new Map();
  for (const [o, e] of m) {
    const clearing = new Set();
    let best = null, bestClears = false;
    for (const [w, v] of e.byWallet) {
      const clears = meetsRouterGate({ settled: v.settled, payers: v.payers, minSettled, minPayers }).ok;
      if (clears) clearing.add(w);
      if (!best || (clears && !bestClears) || (clears === bestClears && (v.settled > best.settled || (v.settled === best.settled && Number(v.payers ?? 0) > Number(best.payers ?? 0))))) {
        best = v; bestClears = clears;
      }
    }
    out.set(o, {
      byWallet: e.byWallet,
      clearing,
      settled: best ? best.settled : 0,
      payers: best ? best.payers : undefined,
      payTos: new Set(e.byWallet.keys()),
      ownSettled: e.ownSettled,
      ownPayers: e.ownPayers,
      withheld: { byWallet: e.heldByWallet, payTos: new Set(e.heldByWallet.keys()) },
      selfFunded: { byWallet: e.selfByWallet, payTos: new Set(e.selfByWallet.keys()), netted: e.nettedByWallet },
    });
  }
  return out;
}

/**
 * The resolver's post-probe Base verdict for one candidate, ONE implementation
 * shared with the test: the same dispatchEligibility call the pre-probe filter
 * ran, now with the origin's binding and the address its live 402 named.
 *
 *   { ok: true, livePayTo, evidenceWallets }      - pay it; when the binding decided it,
 *                                                   the payer must sign only to one of
 *                                                   evidenceWallets (the wallets whose OWN
 *                                                   evidence clears); null only when no
 *                                                   binding was passed
 *   { ok: false, detail, livePayTo, payTos }      - skip it, and why
 *
 * `livePayTo` may be passed decoded, or read from the probe's `header` / `body`.
 */
export function baseLiveGate({ networks, settled, payers, priceUsd, urlTemplate = false, minSettled, minPayers, binding, livePayTo, header, body, usdcDomain = null } = {}) {
  const live = livePayTo !== undefined ? livePayTo : payToFromLive402({ header, body });
  const v = dispatchEligibility({
    routable: true, networks, settled, payers, priceUsd, urlTemplate: !!urlTemplate,
    spendChains: ["base"], minSettled, minPayers, usdcDomain,
    ...(binding ? { evidence: binding, livePayTo: live } : {}),
  });
  const base = v.chains?.base || {};
  const verdict = binding ? evidencePayToVerdict({ evidence: binding, livePayTo: live, minSettled, minPayers }) : null;
  if (base.eligible === true) return { ok: true, livePayTo: live, evidenceWallets: verdict?.bound ? [...verdict.payTos] : null };
  return { ok: false, detail: base.detail || base.reason || v.reason, livePayTo: live, payTos: verdict ? [...(verdict.payTos || [])] : [] };
}
