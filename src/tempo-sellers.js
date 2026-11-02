// Tempo/MPP seller catalog for the Smart Order Router's external leg - the
// MPP counterpart of algorand-sellers.js. Candidates come from OUR OWN MPP
// index (src/mpp-index.js): sellers we have live-verified with an unpaid
// probe that returned a genuine WWW-Authenticate: Payment challenge, carrying
// the mpp.dev registry's per-endpoint payment metadata (method, currency,
// amount in base units). Same shape out as the other legs: url/method/price/
// networks, ranked lexically against the task, cap-filtered.
//
// What is deliberately NOT routable here:
//   - path templates (`/:network/v2`) - nothing to fill them with;
//   - anything not tempo/charge in USDC.e - the spending wallet's asset pin.
// Dynamic pricing (`payment.dynamic` / no integer amount - ~185 registry
// endpoints, ~17%) IS routable since 2026-08-19, ranked AFTER every in-cap
// fixed-price candidate of equal score: the resolver live-probes each
// candidate's 402 anyway, so it reads the dynamic seller's tempo/charge
// amount from the real challenge, prices it there, and skips it when the
// live amount exceeds the tier cap (src/server.js resolveExternalSeller;
// payTempo re-checks the same cap before signing). A task therefore resolves
// to a dynamic seller only when no fixed-price seller matches, and never at
// a price the buyer did not agree to.
// Proven-ness (recent inbound USDC.e transfers to the challenge's recipient)
// is checked at PAY time in tempo-buyer.js against the LIVE 402's recipient -
// that stays. Since 2026-08-18 the index also records each seller's live
// offers (recipient included) and the MPP leaderboard (src/mpp-leaderboard.js)
// counts inbound transfers per recipient, so the ranker can additionally gate
// UP FRONT: with a fresh board, only `routable` recipients are candidates
// (else the first lexical hit could be an unproven seller, payTempo 409s, and
// the router never tried the proven one ranked second). Same shape as the
// Base leg's leaderboard gate. Without a board (cold boot, RPC down) the
// ranker keeps prior behaviour and the pay-time gate alone decides.
import { mppIndexSnapshot, parseOffers } from "./mpp-index.js";
import { TEMPO_USDC, TEMPO_CAIP2 } from "./tempo-buyer.js";

const USDC_LC = TEMPO_USDC.toLowerCase();
const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Flatten the verified MPP index into routable resources. Pure; injectable
 *  snapshot for tests. */
export function tempoCatalog(snapshot = mppIndexSnapshot()) {
  const out = [];
  for (const s of snapshot?.sellers || []) {
    if (!s?.verified) continue;
    const origin = String(s.serviceUrl || s.origin || "").replace(/\/$/, "");
    if (!/^https:\/\//.test(origin)) continue;
    for (const e of s.endpoints || []) {
      const p = e?.payment;
      if (!p || p.method !== "tempo" || (p.intent && p.intent !== "charge")) continue;
      if (String(p.currency || "").toLowerCase() !== USDC_LC) continue;
      if (typeof e.path !== "string" || !e.path.startsWith("/") || /[:{*]/.test(e.path)) continue;
      const amount = String(p.amount || "");
      const fixed = !p.dynamic && /^\d+$/.test(amount) && amount !== "0";
      if (!fixed && amount && /^\d+$/.test(amount) && amount === "0") continue; // a literal zero is not a price
      const decimals = Number.isInteger(p.decimals) ? p.decimals : 6;
      const priceUsd = fixed ? Number(amount) / 10 ** decimals : null;
      const recipient = (s.offers || []).find((o) => o?.method === "tempo" && (o.intent || "charge") === "charge" && o.recipient && String(o.currency || "").toLowerCase() === USDC_LC)?.recipient || null;
      out.push({
        origin, seller: s.name || origin.replace(/^https:\/\//, ""),
        recipient,
        path: e.path, method: String(e.method || "GET").toUpperCase(),
        url: origin + e.path,
        description: [e.description, s.description].filter(Boolean).join(" - "),
        tags: [...(s.tags || []), ...(s.categories || [])],
        priceUsd, priceAtomic: fixed ? amount : null, dynamic: !fixed,
        networks: [TEMPO_CAIP2],
        wire: "mpp",
        // Key shapes of the seller's documented request example, when its
        // llms.txt has one (src/mpp-input-examples.js); route-execute reads it.
        ...(e.inputExample && e.inputExample.keys && typeof e.inputExample.keys === "object" ? { inputExample: e.inputExample } : {}),
      });
    }
  }
  return out;
}

/** Rank routable resources against a task - same lexical scoring as the
 *  Algorand leg (task tokens vs description/path/tags), cap-filtered.
 *  `provenByRecipient` (Map recipientLc -> {transfers, routable}, from the MPP
 *  leaderboard) is optional: when given, resources whose recipient is unknown
 *  or not routable are dropped and `settled` rides out; ties then break on
 *  settled desc. When absent, no gate here (pay-time gate still applies). */
export function rankTempoResources(resources, task, { capUsd, excludeOrigin = "", provenByRecipient = null } = {}) {
  const want = [...new Set(tokenize(task))];
  if (!want.length) return [];
  const scored = [];
  for (const r of resources) {
    // Fixed price must fit the cap here; a dynamic price is checked against
    // the LIVE 402 by the resolver (and again by payTempo) - admit it, rank it
    // below fixed-price peers.
    if (!r.dynamic && !(r.priceUsd > 0 && r.priceUsd <= capUsd)) continue;
    if (excludeOrigin && r.origin === excludeOrigin) continue;
    let settled = 0;
    if (provenByRecipient) {
      const ev = r.recipient ? provenByRecipient.get(String(r.recipient).toLowerCase()) : null;
      if (!ev?.routable) continue;
      settled = ev.transfers || 0;
    }
    const have = new Set([...tokenize(r.description), ...tokenize((r.tags || []).join(" ")), ...tokenize(r.seller)]);
    const pathTokens = tokenize(r.path);
    let score = 0;
    for (const t of want) {
      if (have.has(t) || pathTokens.includes(t)) score += 1;
      else if (t.length > 3 && pathTokens.some((p) => p.includes(t))) score += 1;
    }
    if (score > 0) scored.push({ ...r, score, settled });
  }
  // score desc; fixed price before dynamic at equal score (a known price the
  // buyer already agreed to beats one we still have to read); then settled
  // desc; then cheaper first.
  return scored.sort((a, b) => b.score - a.score || (a.dynamic ? 1 : 0) - (b.dynamic ? 1 : 0) || b.settled - a.settled || (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity));
}

/** Price of a dynamic-priced seller, read from its LIVE 402: the first
 *  tempo/charge offer in USDC.e with an integer base-units amount, in USD
 *  (6 decimals). null when the challenge carries no such offer - the
 *  resolver then skips the candidate. Injectable parser for tests. */
export async function liveTempoPriceUsd(wwwAuth, { parse = parseOffers } = {}) {
  const offers = await parse(String(wwwAuth || ""));
  const offer = (offers || []).find((o) => o && o.method === "tempo" && (o.intent || "charge") === "charge" && String(o.currency || "").toLowerCase() === USDC_LC && /^\d+$/.test(String(o.amount || "")) && String(o.amount) !== "0");
  if (!offer) return null;
  const usd = Number(offer.amount) / 1e6;
  return usd > 0 ? usd : null;
}
