// x402 payer screen: the paying address of an x402 payment, checked against
// the OFAC SDN EVM address set src/sanctions-screen.js holds (the same set,
// load, refresh and status the Tempo direct-mode screen uses; nothing is
// downloaded here).
//
// WHERE IT RUNS. As the `next` that the x402 middleware calls (src/server.js,
// the dispatcher that ends in x402mw). @x402/express calls next() only after
// the payment verified, or for a route with no price. So the screen runs
// after verification and before any paid handler, and a refusal here is a
// 403 from inside the middleware's buffered response: it cancels settlement
// on any status >= 400, so the payer is not charged and the handler never
// runs. One mount covers every route the x402 middleware guards, and every
// rail that is x402 underneath (the MPP evm shim). A loopback replay of a
// paid call (async jobs, the MCP connector's paid replay) is a new request
// through the same middleware, so it is screened again.
//
// WHICH ADDRESSES. Read from the header the middleware settles from
// (paymentHeaderOf): the EIP-3009 `authorization.from` (exact scheme) and the
// Permit2 `permit2Authorization.from` (exact over Permit2, and upto), on any
// EVM network. Both are screened when both are present: a Permit2 payment is
// settled from the Permit2 signer while the `authorization` block beside it is
// not signed, and screening each address the buyer put in its own header
// means neither block can stand in for the other. An unsigned address only
// ever refuses the request that carries it.
//
// SOLANA, STELLAR AND ALGORAND payments carry a signed transaction, not an
// authorization naming the payer: the signer is read from the transaction
// itself (src/non-evm-payer.js, the reader the identity-bound routes use)
// and looked up in the payout map (src/tools/sanctions-kit.js, the same list
// the router screens a payee against, which holds every address OFAC lists,
// not only EVM ones). The same verdicts as the EVM path: listed refuses 403
// before the handler, no list loaded serves unscreened and counts it, an
// unreadable signer passes.
//
// NO LIST LOADED (status missing). The request is served: the screen fails
// open, logs one line per minute, counts it for the operator view, and
// /api/gateway-status reports sanctionsScreen "missing" so the heartbeat
// pages. A stale list keeps screening against the last good set.
//
// COST. Decoding the header the middleware already decoded once, and one Set
// lookup per address. No network call.
import { paymentHeaderOf } from "./payer.js";
import { screenAddresses, maskAddress } from "./sanctions-screen.js";
import { nonEvmPayerFromRequest } from "./non-evm-payer.js";
import { screenAddressForPayment } from "./tools/sanctions-kit.js";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** The buyer-facing refusal. Neutral: no list contents, no internals. */
export const X402_PAYER_REFUSED_TEXT = "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request.";

/** Every EVM-format paying address in the x402 payment header this request
 *  will settle from, lowercased and de-duplicated. [] when there is no
 *  header, it will not decode, or it names no EVM authorization (Solana,
 *  Stellar and Algorand payloads). Pure; never throws. */
export function x402ScreenedAddressesOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return [];
  let payload;
  try { payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf-8")); } catch { return []; }
  const inner = payload?.payload;
  if (!inner || typeof inner !== "object") return [];
  const out = new Set();
  for (const from of [inner.authorization?.from, inner.permit2Authorization?.from]) {
    if (typeof from === "string" && EVM_RE.test(from)) out.add(from.toLowerCase());
  }
  return [...out];
}

const counts = { screened: 0, refused: 0, servedUnscreened: 0, lastRefusedAt: 0, lastUnscreenedAt: 0 };
let unscreenedLoggedAt = 0;

/** Counts for the operator view of /api/gateway-status; never an address. */
export function x402PayerScreenView() {
  return {
    screened: counts.screened,
    refused: counts.refused,
    servedUnscreened: counts.servedUnscreened,
    lastRefusedAt: counts.lastRefusedAt ? new Date(counts.lastRefusedAt).toISOString() : null,
    lastUnscreenedAt: counts.lastUnscreenedAt ? new Date(counts.lastUnscreenedAt).toISOString() : null,
  };
}

/** The non-EVM signer's verdict in the EVM screen's shape: { ok } clean,
 *  { ok:false, reason:"unavailable" } no list, { ok:false, reason:"listed",
 *  address }. Pure over the payout map; never throws. */
async function screenNonEvmPayer(req, payerOf) {
  let key = null;
  try { key = await payerOf(req); } catch { key = null; }
  const address = typeof key === "string" ? key.replace(/^(svm|avm|stellar):/, "") : "";
  if (!address) return null;
  try {
    const hit = await screenAddressForPayment(address);
    return hit ? { ok: false, reason: "listed", address } : { ok: true };
  } catch (e) {
    return /unreadable address/.test(String(e?.message || e)) ? null : { ok: false, reason: "unavailable" };
  }
}

/** The middleware. Mounted as the x402 middleware's `next` (see above). */
export function createX402PayerScreen({ log = console.warn, nonEvmPayerOf = nonEvmPayerFromRequest } = {}) {
  const decide = (req, res, next, v) => {
    if (v.ok) { counts.screened++; return next(); }
    if (v.reason !== "listed") {
      // No list loaded: served unscreened (fail open), surfaced as status missing.
      counts.servedUnscreened++;
      counts.lastUnscreenedAt = Date.now();
      if (Date.now() - unscreenedLoggedAt >= 60_000) {
        unscreenedLoggedAt = Date.now();
        log("[sanctions-screen] x402 payer screen: no list loaded, serving x402 payments unscreened");
      }
      return next();
    }
    counts.screened++;
    counts.refused++;
    counts.lastRefusedAt = Date.now();
    log(`[sanctions-screen] x402 payer ${maskAddress(v.address)} refused before the handler (${req.method} ${req.path}); nothing settles`);
    res.status(403);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ error: X402_PAYER_REFUSED_TEXT, reason: "payer-not-accepted", charged: false });
  };
  return function x402PayerScreen(req, res, next) {
    const addresses = x402ScreenedAddressesOf(req);
    if (addresses.length) return decide(req, res, next, screenAddresses(addresses));
    if (!paymentHeaderOf(req)) return next();
    // A non-EVM payment: the transaction's signer, read asynchronously.
    screenNonEvmPayer(req, nonEvmPayerOf)
      .then((v) => (v ? decide(req, res, next, v) : next()))
      .catch(() => next());
  };
}

/** Test seam. */
export function __resetX402PayerScreenForTests() {
  counts.screened = 0; counts.refused = 0; counts.servedUnscreened = 0; counts.lastRefusedAt = 0; counts.lastUnscreenedAt = 0;
  unscreenedLoggedAt = 0;
}
