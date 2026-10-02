// Proven-ness from OUR OWN chain observation, not from registry membership.
//
// The router refuses to spend a buyer's money on a seller that has not been
// observed settling (SOR_MIN_SETTLED_TX). That gate was only ever as wide as
// its evidence, and its evidence came from the Bazaar-derived leaderboard — so
// "has settled" actually meant "is listed in a registry we crawl". A seller who
// registers nowhere had a settled count of 0 no matter how much they settled.
//
// That is not hypothetical. The #2 merchant on Base by settlement count —
// ~198k settlements in seven days, 11.3% of all x402 settlement COUNT on the
// chain — is in no registry at all: absent from our 2,258-origin index and from
// all 15,517 Bazaar resources. Our router could never select it, and nothing
// anywhere said so. The gate reported "unproven" when the truth was "unlooked".
//
// The join below fixes the class, not the instance. We already crawl each
// origin's advertised payTo (`payToByNetwork`), and we already scan Base for
// settlements grouped by receiving address. Joining those two gives a settled
// count for ANY origin we have crawled, whether or not a registry lists it —
// evidence we gathered ourselves, about money that actually moved.
//
// What it cannot do is invent an origin. A settlement carries no URL, so
// address → origin is not derivable from the chain; an unregistered seller we
// have never crawled stays invisible until something tells us its URL. That
// residue is exactly what `unattributedMerchants` measures, so the part we
// cannot see is reported rather than silently counted as zero.

/** EVM addresses are case-insensitive; base58/Stellar are NOT (see src/payer.js). */
// Case-insensitive on the 0x prefix too: an address arriving as "0XABC…" is the
// same wallet, and rejecting it would silently drop that seller's evidence
// rather than fail loudly.
const isEvmAddress = (a) => typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a);
const evmKey = (a) => (isEvmAddress(a) ? a.toLowerCase() : null);

/** The Base-mainnet payTo an origin advertises, or null. EVM only, by design. */
export function baseNetworkPayTo(seller, network = "eip155:8453") {
  const addr = seller?.payToByNetwork?.[network];
  return evmKey(addr);
}

/**
 * Index on-chain merchants by receiving address.
 * @param {Array<{merchant:string, payments:number, payers:number, volumeUsd:number}>} merchants
 */
export function merchantsByAddress(merchants) {
  const m = new Map();
  for (const row of Array.isArray(merchants) ? merchants : []) {
    const k = evmKey(row?.merchant);
    if (!k) continue; // non-EVM merchant rows are out of scope, never case-folded
    const prev = m.get(k);
    // Same address can appear once per query shape; keep the strongest evidence.
    if (!prev || Number(row.payments || 0) > prev.payments) {
      m.set(k, {
        payments: Number(row.payments || 0),
        payers: Number(row.payers || 0),
        volumeUsd: Number(row.volumeUsd || 0),
      });
    }
  }
  return m;
}

/**
 * origin -> observed settled-call count, joined by advertised Base payTo.
 * Registry membership is irrelevant here: the only inputs are an origin we
 * crawled and money we watched arrive.
 */
export function provenByChain({ sellers, merchants, network = "eip155:8453" } = {}) {
  const byAddr = merchantsByAddress(merchants);

  // How many DISTINCT origins claim each address?
  //
  // A settlement count is evidence that an ADDRESS received money. It says
  // nothing about which origin delivered the service. When several origins
  // advertise the same payTo, crediting each with the full count asserts a
  // thing we did not observe: that every one of them earned all of it.
  //
  // This is not a corner case. Measured on our own index 2026-07-31: 858 of
  // 2,008 payTo-bearing origins shared an address with at least one other, and
  // ONE address was claimed by 144 origins. Under the old rule each of those
  // 144 inherited the whole platform's settlement history - including origins
  // that never delivered a paid call - and each then cleared the router's
  // spend gate on the strength of it.
  //
  // Dividing the count would be inventing an attribution we cannot make. So a
  // shared address yields NO chain-derived proof, and says why. Absence of
  // attribution reported as absence, the same rule the discovery gap and
  // /status follow. Sellers on a shared address are not blocked - they simply
  // have to earn proven-ness through a source that CAN attribute delivery.
  const claimants = new Map(); // addr -> Set(origin)
  const normOrigin = (s) => (typeof s?.origin === "string" ? s.origin.replace(/\/+$/, "").toLowerCase() : "");
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const origin = normOrigin(s);
    const payTo = origin ? baseNetworkPayTo(s, network) : null;
    if (!payTo) continue;
    if (!claimants.has(payTo)) claimants.set(payTo, new Set());
    claimants.get(payTo).add(origin);
  }

  const out = new Map();
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const origin = normOrigin(s);
    if (!origin) continue;
    const payTo = baseNetworkPayTo(s, network);
    if (!payTo) continue;
    const hit = byAddr.get(payTo);
    if (!hit) continue;
    const sharedBy = claimants.get(payTo)?.size || 1;
    if (sharedBy > 1) continue; // unattributable — see above
    const prev = out.get(origin);
    if (!prev || hit.payments > prev.settled) {
      out.set(origin, { settled: hit.payments, payers: hit.payers, volumeUsd: hit.volumeUsd, payTo, source: "chain" });
    }
  }
  return out;
}

/**
 * Addresses claimed by more than one indexed origin, with the origins claiming
 * them. Exported so the operator surface can show what chain evidence was
 * withheld and why, rather than the exclusion being silent.
 */
export function sharedPayToClaims({ sellers, network = "eip155:8453" } = {}) {
  const claimants = new Map();
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const origin = typeof s?.origin === "string" ? s.origin.replace(/\/+$/, "").toLowerCase() : "";
    const payTo = origin ? baseNetworkPayTo(s, network) : null;
    if (!payTo) continue;
    if (!claimants.has(payTo)) claimants.set(payTo, new Set());
    claimants.get(payTo).add(origin);
  }
  return [...claimants.entries()]
    .filter(([, origins]) => origins.size > 1)
    .map(([payTo, origins]) => ({ payTo, claimedBy: origins.size, origins: [...origins].sort() }))
    .sort((a, b) => b.claimedBy - a.claimedBy);
}

/**
 * Merchants moving real money that we cannot attribute to any crawled origin —
 * the measured blind spot. `ourAddresses` are excluded: our own treasury is not
 * a discovery gap.
 *
 * Returns null when there is no usable merchant data. That distinction is the
 * whole point: an empty scan and a scan showing nothing unattributed look
 * identical in a bare number, and reporting "0 unattributed" for a scan that
 * never ran is the failure this codebase keeps rediscovering.
 */
export function unattributedMerchants({ sellers, merchants, ourAddresses = [], minPayments = 50, network = "eip155:8453", knownPayToOrigins = null } = {}) {
  if (!Array.isArray(merchants) || merchants.length === 0) return null; // no data ≠ no gap
  const routable = new Set();
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const p = baseNetworkPayTo(s, network);
    if (p) routable.add(p);
  }
  // Attribution is wider than routability: any origin that advertised the
  // address (crawled or registry-listed, routable or not) attributes it.
  const attributed = new Map(); // addr -> origins[]
  if (knownPayToOrigins instanceof Map) {
    for (const [addr, origins] of knownPayToOrigins) {
      const k = evmKey(addr);
      if (k) attributed.set(k, [...(origins instanceof Set ? origins : origins || [])].slice(0, 5));
    }
  }
  const known = new Set([...routable, ...attributed.keys()]);
  for (const a of ourAddresses) { const k = evmKey(a); if (k) known.add(k); }

  const rows = [];
  // Known origin, but the router cannot reach it (probe failed / registry-only):
  // a different finding from "no idea who this is", reported separately.
  const unroutable = [];
  for (const [addr, ev] of merchantsByAddress(merchants)) {
    if (ev.payments < minPayments) continue;
    if (routable.has(addr) || ourAddresses.some((a) => evmKey(a) === addr)) continue;
    if (attributed.has(addr)) { unroutable.push({ merchant: addr, origins: attributed.get(addr), payments: ev.payments, payers: ev.payers, volumeUsd: ev.volumeUsd }); continue; }
    rows.push({ merchant: addr, payments: ev.payments, payers: ev.payers, volumeUsd: ev.volumeUsd });
  }
  rows.sort((a, b) => b.payments - a.payments);
  unroutable.sort((a, b) => b.payments - a.payments);

  const scanned = merchantsByAddress(merchants).size;
  const totalPayments = [...merchantsByAddress(merchants).values()].reduce((s, r) => s + r.payments, 0);
  const unattributedPayments = rows.reduce((s, r) => s + r.payments, 0);
  return {
    merchantsScanned: scanned,
    originsWithKnownPayTo: known.size,
    unattributed: rows,
    unattributedCount: rows.length,
    // Attributed to an origin we know but cannot route to today.
    attributedUnroutable: unroutable,
    attributedUnroutableCount: unroutable.length,
    unattributedPayments,
    // How much of the settlement activity we can see is happening at addresses
    // we cannot route to. This is the number that was previously unobservable.
    unattributedShareOfPayments: totalPayments > 0 ? Number((unattributedPayments / totalPayments).toFixed(4)) : null,
    minPayments,
    note: "Merchants observed settling on Base whose address matches no origin in our crawl. A settlement carries no URL, so these cannot be resolved to a seller from chain data alone — they need an origin from somewhere before the router can ever consider them.",
  };
}

/**
 * Is there any on-chain evidence for the address a seller ADVERTISES?
 *
 * A seller publishes a payTo in its manifest; that is a claim, not a receipt.
 * We separately observe which addresses actually receive USDC on Base. When a
 * seller advertises an address that has received nothing we have ever seen,
 * that is worth saying plainly — one live case advertised one address while
 * every settlement we traced went to a different one.
 *
 * Deliberately NOT framed as fraud detection. "No settlements observed at the
 * advertised address" has innocent explanations: a fresh seller, a rail we do
 * not scan, or a merchant list we truncate. So it reports what was looked for
 * and what was found, and says when it cannot tell — the same rule /status
 * follows for uptime gaps.
 */
export function advertisedPayToEvidence({ seller, merchants, network = "eip155:8453" } = {}) {
  const advertised = baseNetworkPayTo(seller, network);
  if (!advertised) return { advertisedPayTo: null, checked: false, reason: "seller advertises no payTo on this network" };
  if (!Array.isArray(merchants) || merchants.length === 0) {
    // No scan is not "no evidence against them" — it is no scan.
    return { advertisedPayTo: advertised, checked: false, reason: "no on-chain merchant scan available" };
  }
  const hit = merchantsByAddress(merchants).get(advertised);
  return {
    advertisedPayTo: advertised,
    checked: true,
    settlementsObserved: hit ? hit.payments : 0,
    observedAtAdvertisedAddress: Boolean(hit),
    note: hit
      ? "the address this seller advertises is one we have observed receiving settlements"
      : "we have observed no settlements at the address this seller advertises; the merchant scan covers the busiest receivers on Base only, so this is not proof of anything by itself",
  };
}

/**
 * Decode the payTo a live 402 actually asks us to pay, for one network.
 *
 * x402 v2 carries the quote in a base64 `payment-required` HEADER with an empty
 * body; older/other sellers put it in the JSON body. Try both, return null when
 * neither parses — an unreadable quote is "unknown", never "matches".
 */
export function payToFromLive402({ header, body, network = "eip155:8453" } = {}) {
  const pick = (obj) => {
    const accepts = Array.isArray(obj?.accepts) ? obj.accepts : [];
    const hit = accepts.find((a) => String(a?.network) === network && a?.payTo);
    return hit ? String(hit.payTo) : null;
  };
  if (typeof header === "string" && header) {
    try {
      const got = pick(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
      if (got) return got;
    } catch { /* fall through to the body */ }
  }
  if (typeof body === "string" && body) {
    try {
      const got = pick(JSON.parse(body));
      if (got) return got;
    } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Does the address that EARNED a seller's proven-ness match the one its live
 * 402 asks us to pay?
 *
 * The reliability gate says "this address has been observed receiving money".
 * Nothing previously required the seller to then ask for payment AT that
 * address — so a seller could earn trust with one address and be paid at
 * another, and the evidence would be about a wallet with no connection to
 * where our money went.
 *
 * Three outcomes, and the middle one matters: match, mismatch, and UNKNOWN.
 * Unknown (no proven address on record, or an unreadable quote) is not a pass
 * and not a failure — the caller decides, and the reason travels with it.
 */
export function provenPayToMatches({ provenPayTo, livePayTo, family = "evm" } = {}) {
  // `family` picks the address shape, because the two chains that use this
  // carry different ones and one of them must never be case-folded. An EVM
  // address is hex and folds; an Algorand address is uppercase base32 with a
  // checksum, so folding it would compare two strings that are not addresses
  // (the base58/strkey rule from src/payer.js, one chain over). Anything that
  // is not the family's shape norms to null and reads UNKNOWN, which blocks
  // nothing - only a positive MISMATCH does.
  const norm = family === "algorand"
    ? (a) => (typeof a === "string" && /^[A-Z2-7]{58}$/.test(a) ? a : null)
    : (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);
  const proven = norm(provenPayTo);
  const live = norm(livePayTo);
  if (!proven) return { verdict: "unknown", reason: "no chain-derived address on record for this origin" };
  if (!live) return { verdict: "unknown", reason: "could not read a payTo for this network from the live 402" };
  return proven === live
    ? { verdict: "match", provenPayTo: proven, livePayTo: live }
    : { verdict: "mismatch", provenPayTo: proven, livePayTo: live,
        reason: "the address that earned this seller's proven-ness is not the address its live 402 asks us to pay" };
}

/**
 * The router's reliability gate, as ONE implementation.
 *
 * Previously the rule lived in server.js and its test re-implemented it, so a
 * test could pass while the router had drifted — the same "fixture is fiction"
 * failure this module's own header warns about. Both now call this.
 *
 * Two floors:
 *  - `settled`: settlements observed. A COUNT is manufacturable (one wallet
 *    settling N times), so it is necessary but not sufficient.
 *  - `payers`: distinct payers, which cost a funded wallet each. Enforced ONLY
 *    when known: `undefined` means we hold no breadth evidence, which is not
 *    the same as zero, and refusing there would punish a seller for a gap in
 *    OUR data.
 *
 * Honest about scope: this defeats the single-wallet loop, the cheap attack. A
 * fleet the seller funds directly from the wallet it is paid at is netted out of
 * the counts before they get here (src/seller-funding.js, one hop); a fleet
 * funded from another wallet or through an intermediary is not.
 */
export function meetsRouterGate({ settled, payers, minSettled = 50, minPayers = 3 } = {}) {
  const n = Number(settled || 0);
  if (!(n >= minSettled)) return { ok: false, reason: "below the settlement floor" };
  if (payers !== undefined && payers !== null && Number(payers) < minPayers) {
    return { ok: false, reason: `only ${Number(payers)} distinct payer(s) observed; a count one wallet can manufacture is not proof` };
  }
  return { ok: true };
}
