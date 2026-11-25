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
// (paymentHeaderOf), by the fields X402_SCREENED_FIELDS lists: the EIP-3009 `authorization.from` (exact scheme) and the
// Permit2 `permit2Authorization.from` (exact over Permit2, and upto), on any
// EVM network. Both are screened when both are present: a Permit2 payment is
// settled from the Permit2 signer while the `authorization` block beside it is
// not signed, and screening each address the buyer put in its own header
// means neither block can stand in for the other. An unsigned address only
// ever refuses the request that carries it.
//
// PAYMENT CHANNELS (the `batch-settlement` scheme, src/batch-settlement.js)
// carry no authorization block: the payer is `payload.channelConfig.payer`,
// on the deposit that opens or tops up the channel, on every voucher call and
// on a refund request, and the scheme binds the channel id to that config
// before `next` is called. The screen reads it on each of those requests,
// with `channelConfig.payerAuthorizer` (the key a voucher may be signed by in
// the payer's place) and, for a deposit made over Permit2, the funder
// (`deposit.authorization.permit2Authorization.from`). X402_SCREENED_FIELDS
// is the one list of payload fields read, per rail; the conformance cells
// (src/payer-screen-rails.js) name the same fields, and
// scripts/test-payer-screen-rails.js refuses a listed address at each.
//
// AN EVM PAYMENT WITH NO READABLE PAYER (an eip155 network, or the channel
// scheme, and none of the fields above holds an address) is served, since a
// payer that is not listed is never refused, and counted as served
// unscreened, so a payload shape this screen does not read shows up in the
// operator view instead of passing uncounted.
//
// SOLANA, STELLAR AND ALGORAND payments carry a signed transaction, not an
// authorization naming the payer: the signers are read from the transaction
// itself (src/non-evm-payer.js nonEvmScreenAddressesFromRequest; for Solana
// every static transfer authority and every required signer except the fee
// payer, so a transfer authority no single key stands for, such as an SPL
// multisig in a lookup table, still screens the wallets that signed it; a
// transaction that reader cannot walk is screened by the signer list the
// installed @solana/kit decodes) and each is looked up in the payout map (src/tools/sanctions-kit.js, the same list
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
// THE STRICT SCREEN (`noList: "refuse"`, the referral copies under /ref,
// src/server.js). A sale through a third party's marketplace is not served
// unscreened: with no list loaded the payment is refused 503 with
// Retry-After before the handler, nothing charged, counted as
// refusedUnscreened and logged once a minute (the same "missing" word pages).
// It also refuses, 403 before the handler, a payer `blockedPayerOf(payload)`
// names (WALLET_BLOCKLIST, src/payments.js blockedPayerFromPayload); the
// direct routes apply that list at settlement instead.
//
// RECORDS. A refusal is kept in the sanctions events store
// (src/sanctions-events.js, under its write limits) only for a listed address
// the payment's own signature proves (src/x402-signed-payers.js): EIP-3009
// `authorization.from` or Permit2 `permit2Authorization.from` recovered
// locally, and on the direct routes (after verification) a Solana, Stellar or
// Algorand signer. A listed address seen only in a field no signature covers
// (the channel fields, an unsigned block, anything on the strict screen,
// which runs before verification, that the signature does not recover to) is
// refused exactly the same and counted as `refusedUnrecorded`, never recorded.
//
// COST. Decoding the header the middleware already decoded once, and one Set
// lookup per address. No network call; a refusal alone adds local signature
// recoveries (at most five) before its record is written.
import { paymentHeaderOf } from "./payer.js";
import { screenAddresses, maskAddress } from "./sanctions-screen.js";
import { nonEvmScreenAddressesFromRequest } from "./non-evm-payer.js";
import { screenAddressForPayment } from "./tools/sanctions-kit.js";
import { decodePaymentHeader } from "./payment-header.js";
import { recordSanctionsEvent } from "./sanctions-events.js";
import { sanctionsScreenOperatorView } from "./sanctions-screen.js";
import { x402SignedPayers } from "./x402-signed-payers.js";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** The payload fields the EVM screen reads, per screen-table row
 *  (src/payer-screen-rails.js PAYER_SCREEN_RAILS). Every field of every row
 *  is read on every x402 payment, whatever scheme it names. */
export const X402_SCREENED_FIELDS = Object.freeze({
  "x402-evm": Object.freeze(["authorization.from", "permit2Authorization.from"]),
  "x402-gateway-batched": Object.freeze(["authorization.from"]),
  "x402-batch-settlement": Object.freeze(["channelConfig.payer", "channelConfig.payerAuthorizer", "deposit.authorization.permit2Authorization.from"]),
});
const SCREENED_PATHS = [...new Set(Object.values(X402_SCREENED_FIELDS).flat())].map((f) => f.split("."));
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const fieldAt = (obj, path) => {
  let at = obj;
  for (const k of path) {
    if (!at || typeof at !== "object" || !Object.hasOwn(at, k)) return undefined;
    at = at[k];
  }
  return at;
};

/** What the screen reads of this request's x402 payment: `addresses` (every
 *  EVM-format paying address, lowercased, de-duplicated) and `evm` (true when
 *  the payment is on an EVM network or names the channel scheme, so a payer
 *  is expected). Null with no header or one that does not decode. Pure. */
export function x402ScreenedPaymentOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  let payload;
  try { payload = decodePaymentHeader(header); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  return screenedOfPayload(payload);
}
function screenedOfPayload(payload) {
  const inner = payload.payload;
  const out = new Set();
  if (inner && typeof inner === "object") {
    for (const path of SCREENED_PATHS) {
      const from = fieldAt(inner, path);
      // The zero address is the scheme's "no separate authorizer", not a party.
      if (typeof from === "string" && EVM_RE.test(from) && from.toLowerCase() !== ZERO_ADDRESS) out.add(from.toLowerCase());
    }
  }
  const str = (v) => (typeof v === "string" ? v.toLowerCase() : "");
  const network = str(payload.accepted?.network) || str(payload.network);
  const scheme = str(payload.accepted?.scheme) || str(payload.scheme);
  return { addresses: [...out], evm: network.startsWith("eip155:") || scheme === "batch-settlement", payload };
}

/** The buyer-facing refusal. Neutral: no list contents, no internals. */
export const X402_PAYER_REFUSED_TEXT = "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request.";
/** The strict screen's refusals: no list loaded, and a blocked wallet. */
export const X402_PAYER_UNSCREENED_TEXT = "The payment could not be checked right now. Nothing ran and nothing was charged. Retry shortly.";
export const X402_PAYER_BLOCKED_TEXT = "This server does not accept payments from this wallet. Nothing ran and nothing was charged for this request.";

/** Every EVM-format paying address in the x402 payment header this request
 *  will settle from, lowercased and de-duplicated. [] when there is no
 *  header, it will not decode, or it names no EVM authorization (Solana,
 *  Stellar and Algorand payloads). Pure; never throws. */
export function x402ScreenedAddressesOf(req) {
  return x402ScreenedPaymentOf(req)?.addresses || [];
}

const counts = { screened: 0, refused: 0, refusedUnrecorded: 0, servedUnscreened: 0, unreadablePayer: 0, refusedUnscreened: 0, blocked: 0, lastRefusedAt: 0, lastUnscreenedAt: 0 };

/** The listed address a refusal may RECORD, or null. An EVM payment: a listed
 *  address among those its own signature proves (src/x402-signed-payers.js).
 *  A Solana, Stellar or Algorand payment: its signers are read from the signed
 *  transaction, recorded only where the screen runs after the facilitator
 *  verified that transaction (not the strict screen, which runs before). */
async function recordableListedOf(v, payload, { strict }) {
  if (v.nonEvm) return strict ? null : v.address;
  const signed = await x402SignedPayers(payload);
  if (!signed.length) return null;
  let w;
  try { w = screenAddresses(signed); } catch { return null; }
  return w && w.ok === false && w.reason === "listed" ? w.address : null;
}
let unscreenedLoggedAt = 0;
let unreadableLoggedAt = 0;
let strictLoggedAt = 0;

/** Counts for the operator view of /api/gateway-status; never an address. */
export function x402PayerScreenView() {
  return {
    screened: counts.screened,
    refused: counts.refused,
    // Of those, refused on an address the payment's signature does not prove:
    // refused all the same, not recorded in the sanctions events store.
    refusedUnrecorded: counts.refusedUnrecorded,
    servedUnscreened: counts.servedUnscreened,
    // Of those, EVM payments none of whose payer fields could be read.
    unreadablePayer: counts.unreadablePayer,
    // The strict screen (/ref): payments refused with no list loaded, and
    // payers refused for WALLET_BLOCKLIST.
    refusedUnscreened: counts.refusedUnscreened,
    blocked: counts.blocked,
    lastRefusedAt: counts.lastRefusedAt ? new Date(counts.lastRefusedAt).toISOString() : null,
    lastUnscreenedAt: counts.lastUnscreenedAt ? new Date(counts.lastUnscreenedAt).toISOString() : null,
  };
}

/** The non-EVM signers' verdict in the EVM screen's shape: { ok } clean,
 *  { ok:false, reason:"unavailable" } no list, { ok:false, reason:"listed",
 *  address } when ANY address is listed. Null when no address is readable
 *  (the request passes, as an unreadable signer always has). Pure over the
 *  payout map; never throws. */
async function screenNonEvmPayer(req, addressesOf) {
  let list = null;
  try { list = await addressesOf(req); } catch { list = null; }
  const addresses = [...new Set((Array.isArray(list) ? list : []).filter((a) => typeof a === "string" && a).map((a) => a.replace(/^(svm|avm|stellar):/, "")))].slice(0, 64);
  let screened = 0, unavailable = false;
  for (const address of addresses) {
    try {
      const hit = await screenAddressForPayment(address);
      if (hit) return { ok: false, reason: "listed", address, nonEvm: true };
      screened++;
    } catch (e) {
      if (!/unreadable address/.test(String(e?.message || e))) unavailable = true;
    }
  }
  if (unavailable) return { ok: false, reason: "unavailable" };
  return screened ? { ok: true } : null;
}

/** The middleware. Mounted as the x402 middleware's `next` (see above).
 *  `noList`: "serve" (the default, the direct routes) or "refuse" (the
 *  strict screen). `blockedPayerOf(payload)`: the blocked address a decoded
 *  payment names, or null (the strict screen only). */
export function createX402PayerScreen({ log = console.warn, nonEvmAddressesOf = nonEvmScreenAddressesFromRequest, noList = "serve", blockedPayerOf = null } = {}) {
  const strict = noList === "refuse";
  const decide = (req, res, next, v) => {
    if (v.ok) { counts.screened++; return next(); }
    if (v.reason !== "listed" && strict) {
      // No list loaded: the strict screen refuses (fail closed), counted.
      counts.refusedUnscreened++;
      counts.lastUnscreenedAt = Date.now();
      if (Date.now() - strictLoggedAt >= 60_000) {
        strictLoggedAt = Date.now();
        log(`[sanctions-screen] x402 payer screen: no list loaded, refusing payments on the strict screen (${req.method} ${req.path})`);
      }
      res.status(503);
      res.setHeader("Retry-After", "60");
      res.setHeader("Cache-Control", "no-store");
      return res.json({ error: X402_PAYER_UNSCREENED_TEXT, reason: "payer-screen-unavailable", charged: false });
    }
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
    // The rejected transaction, in full, for the records rule and its report
    // (src/sanctions-events.js), only for an address the payment's own
    // signature proves (recordableListedOf); one the request merely names is
    // refused above and counted, never recorded. Never awaited: the refusal
    // does not wait on it.
    try {
      const payload = x402ScreenedPaymentOf(req)?.payload;
      const acc = payload?.accepted || payload || {};
      const route = `${req.method} ${req.path}`, ip = req.ip;
      recordableListedOf(v, payload, { strict }).then((address) => {
        if (!address) { counts.refusedUnrecorded++; return; }
        let listDate = null;
        try { listDate = sanctionsScreenOperatorView().publishDate || null; } catch { /* no list view */ }
        return recordSanctionsEvent({ kind: "screen-hit", address, rail: "x402", network: acc.network ?? null, amount: acc.amount ?? acc.maxAmountRequired ?? null, asset: acc.asset ?? null, route, ip, listPublishDate: listDate });
      }).catch(() => {});
    } catch { /* recording never breaks the refusal */ }
    res.status(403);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ error: X402_PAYER_REFUSED_TEXT, reason: "payer-not-accepted", charged: false });
  };
  return function x402PayerScreen(req, res, next) {
    const payment = x402ScreenedPaymentOf(req);
    if (strict && typeof blockedPayerOf === "function" && payment?.payload) {
      let hit = null;
      try { hit = blockedPayerOf(payment.payload); } catch { hit = "unreadable"; }
      if (hit) {
        counts.blocked++;
        log(`[payments] blocked wallet ${hit === "unreadable" ? "(the list could not be read)" : maskAddress(String(hit))} refused before the handler (${req.method} ${req.path}); nothing settles`);
        res.status(hit === "unreadable" ? 503 : 403);
        if (hit === "unreadable") res.setHeader("Retry-After", "60");
        res.setHeader("Cache-Control", "no-store");
        return res.json(hit === "unreadable" ? { error: X402_PAYER_UNSCREENED_TEXT, reason: "payer-screen-unavailable", charged: false } : { error: X402_PAYER_BLOCKED_TEXT, reason: "wallet_blocked", charged: false });
      }
    }
    const addresses = payment?.addresses || [];
    if (addresses.length) return decide(req, res, next, screenAddresses(addresses));
    if (!paymentHeaderOf(req)) return next();
    // An EVM payment none of whose payer fields reads: served, and counted.
    if (payment?.evm) {
      counts.servedUnscreened++;
      counts.unreadablePayer++;
      counts.lastUnscreenedAt = Date.now();
      if (Date.now() - unreadableLoggedAt >= 60_000) {
        unreadableLoggedAt = Date.now();
        log(`[sanctions-screen] x402 payer screen: an EVM payment named no payer this screen reads (${req.method} ${req.path}); served unscreened`);
      }
      return next();
    }
    // A non-EVM payment: the transaction's signers, read asynchronously.
    screenNonEvmPayer(req, nonEvmAddressesOf)
      .then((v) => (v ? decide(req, res, next, v) : next()))
      .catch(() => next());
  };
}

/** Test seam. */
export function __resetX402PayerScreenForTests() {
  counts.screened = 0; counts.refused = 0; counts.refusedUnrecorded = 0; counts.servedUnscreened = 0; counts.unreadablePayer = 0; counts.refusedUnscreened = 0; counts.blocked = 0; counts.lastRefusedAt = 0; counts.lastUnscreenedAt = 0;
  unscreenedLoggedAt = 0; unreadableLoggedAt = 0; strictLoggedAt = 0;
}
