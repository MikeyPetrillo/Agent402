// The returning-wallet price's rules (src/returning-wallet.js), offline: the
// settings, which routes are never discounted, the price math, the hint, the
// decision on an unpaid and on a paid request (the payment's own signer
// decides, never the hint), the settle check, the bounded ledger read, and
// the ledger's paid-days and return-rate reads.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";

for (const k of Object.keys(process.env)) if (/^(RETURNING_WALLET_|REFERRAL_SLUGS|NETWORK_PRICE_FLOORS|NETWORK_PREMIUMS|ROBINHOOD_MIN_PRICE_USD)/.test(k)) delete process.env[k];
// One chain with a price floor above the test route's list price (read once, when payments loads).
const FLOORED = "eip155:4663";
process.env.NETWORK_PRICE_FLOORS = `${FLOORED}=0.004`;
const R = await import("../src/returning-wallet.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const W1 = "0x" + "a1".repeat(20), W2 = "0x" + "b2".repeat(20), OURS = "0x" + "0c".repeat(20);
const DEF = { slug: "hash", price: "$0.001" };

// --- settings ---------------------------------------------------------------------
{
  const d = R.returningWalletConfig({});
  ok(d.enabled === false && d.discountBps === 1000 && d.minPaidDays === 3 && d.windowDays === 30, `off by default; 10% after 3 paid days in 30 (${JSON.stringify(d)})`);
  ok(R.returningWalletConfig({ RETURNING_WALLET_PRICE: "ON" }).enabled === true && R.returningWalletConfig({ RETURNING_WALLET_PRICE: "true" }).enabled === false, "only `on` switches it on");
  const bad = R.returningWalletConfig({ RETURNING_WALLET_DISCOUNT_BPS: "9000", RETURNING_WALLET_MIN_PAID_DAYS: "0", RETURNING_WALLET_WINDOW_DAYS: "abc" });
  ok(bad.discountBps === 1000 && bad.minPaidDays === 3 && bad.windowDays === 30, "a malformed or out-of-range value reads as the default, never a deeper discount or a lower bar");
  const set = R.returningWalletConfig({ RETURNING_WALLET_DISCOUNT_BPS: "1500", RETURNING_WALLET_MIN_PAID_DAYS: "5", RETURNING_WALLET_WINDOW_DAYS: "60" });
  ok(set.discountBps === 1500 && set.minPaidDays === 5 && set.windowDays === 60, "each setting is read");
}

// --- the price math ------------------------------------------------------------------
ok(R.discountedPrice("$0.001", 1000) === "$0.0009" && R.discountedPrice("$0.02", 1000) === "$0.018" && R.discountedPrice("$1", 1000) === "$0.9", "10% off in whole micro-dollars");
ok(R.discountedPrice("$0.000005", 1000) === "$0.000005" && R.discountedPrice("$0.000001", 5000) === "$0.000001", "rounded up to a whole micro-dollar, never below one and never above list");
ok(R.discountedPrice("$0.001", 0) === "$0.001" && R.discountedPrice("$0.001", 9000) === "$0.001" && R.discountedPrice("free", 1000) === "free" && R.discountedPrice("$0.001", 12.5) === "$0.001", "an unreadable price or an out-of-range discount changes nothing");

// --- routes never discounted ----------------------------------------------------------
ok(R.returningWalletRouteRefusal(DEF, {}) === null, "CONTROL a flat deterministic route can be discounted");
ok(R.returningWalletRouteRefusal({ slug: "x", price: "$0.01", quote: () => 1 }, {}) === "priced per request" && R.returningWalletRouteRefusal({ slug: "x", price: "$0.01", tierQuote: () => 1 }, {}) === "priced per request", "a route priced per request is not");
ok(R.returningWalletRouteRefusal({ slug: "search", price: "$0.01" }, {}) === "an upstream is paid per call" && R.returningWalletRouteRefusal({ slug: "x", price: "$0.01", modelBacked: true }, {}) === "an upstream is paid per call", "a metered or model-backed route is not");
ok(R.returningWalletRouteRefusal({ slug: "route-execute-mid", price: "$0.12" }, {}) !== null && R.returningWalletRouteRefusal({ slug: "memory-write", price: "$0.001" }, {}) !== null && R.returningWalletRouteRefusal({ slug: "x", price: "$0.01", spendsOwnWallet: true }, {}) === "lasting effect", "a route with a lasting effect or that spends our wallet is not");
ok(R.returningWalletRouteRefusal(DEF, { REFERRAL_SLUGS: " base64 , hash " }) === "sold on the referral routes" && R.returningWalletRouteRefusal(DEF, { REFERRAL_SLUGS: "base64" }) === null, "a route sold on the referral routes is not (the raw setting decides, whatever the referral gate's state)");
ok(R.returningWalletRouteRefusal({ slug: "x", price: "free" }, {}) === "no price" && R.returningWalletRouteRefusal(null, {}) === "no route", "a route with no readable price is not");

// --- the hint ------------------------------------------------------------------------
const reqOf = (hint, payment = null, ip = undefined) => ({ ip, headers: { ...(hint != null ? { "x-agent402-wallet": hint } : {}), ...(payment ? { "payment-signature": payment } : {}) }, header(n) { return this.headers[String(n).toLowerCase()]; } });
ok(R.walletHintOf(reqOf(W1.toUpperCase().replace("0X", "0x"))) === W1 && R.walletHintOf(reqOf(` ${W1} `)) === W1, "a hint is an EVM address, read in lowercase");
ok(R.walletHintOf(reqOf("0x1234")) === null && R.walletHintOf(reqOf("")) === null && R.walletHintOf(reqOf(null)) === null && R.walletHintOf({ headers: { "x-agent402-wallet": [W1, W2] } }) === null, "anything else is no hint");

// --- the decision ----------------------------------------------------------------------
const payment = (from, { scheme = "exact", network = "eip155:8453", permit2 = false } = {}) => Buffer.from(JSON.stringify({
  x402Version: 2, accepted: { scheme, network, amount: "900" },
  payload: permit2 ? { permit2Authorization: { from, permitted: { amount: "900" } } } : { signature: "0x11", authorization: { from, to: "0x" + "dd".repeat(20), value: "900", validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
let reads = 0;
const days = new Map([[W1, 3], [W2, 2], [OURS, 9]]);
R.configureReturningWallet({ paidDays: (w) => { reads++; return days.get(w) ?? 0; }, isOurs: (w) => w === OURS });
ok(R.returningWalletQuote(reqOf(W1), DEF).applied === false && R.returningWalletQuote(reqOf(W1), DEF).why === "off", "switch off: no request is discounted");
process.env.RETURNING_WALLET_PRICE = "on";
R.__resetReturningWallet();
{
  const q = R.returningWalletQuote(reqOf(W1), DEF);
  ok(q.applied === true && q.wallet === W1 && q.price === "$0.0009" && q.bps === 1000 && q.paid === false, `an unpaid request hinting a qualifying wallet is quoted the discount (${JSON.stringify(q)})`);
  ok(R.returningWalletQuote(reqOf(W2), DEF).applied === false && R.returningWalletQuote(reqOf(W2), DEF).why === "not qualified", "a wallet under the bar is quoted list");
  ok(R.returningWalletQuote(reqOf(OURS), DEF).applied === false, "one of our own wallets is never discounted");
  ok(R.returningWalletQuote(reqOf(null), DEF).why === "no hint" && R.returningWalletQuote(reqOf("nope"), DEF).why === "no hint", "no hint, no discount");
  ok(R.returningWalletQuote(reqOf(W1), { slug: "search", price: "$0.01" }).applied === false, "an ineligible route is quoted list whatever the hint");
}
{
  const paid = R.returningWalletQuote(reqOf(W1, payment(W1)), DEF);
  ok(paid.applied === true && paid.paid === true && paid.wallet === W1, "a payment signed from the hinted, qualifying wallet keeps the discount");
  const upper = R.returningWalletQuote(reqOf(W1, payment(W1.toUpperCase().replace("0X", "0x"))), DEF);
  ok(upper.applied === true, "the signer is compared in lowercase");
  const other = R.returningWalletQuote(reqOf(W1, payment(W2)), DEF);
  ok(other.applied === false && other.why === "paid from another wallet", "a payment signed from another wallet is priced at list, whatever the hint says");
  const stranger = R.returningWalletQuote(reqOf(W1, payment("0x" + "ee".repeat(20))), DEF);
  ok(stranger.applied === false, "and so is one from a wallet the ledger has never seen");
  const noHint = R.returningWalletQuote(reqOf(null, payment(W1)), DEF);
  ok(noHint.applied === false && noHint.why === "no hint", "a qualifying payer with no hint is priced at list (the quote it was given was list)");
  ok(R.returningWalletQuote(reqOf(W1, payment(W1, { scheme: "upto" })), DEF).applied === false && R.returningWalletQuote(reqOf(W1, payment(W1, { permit2: true })), DEF).applied === false && R.returningWalletQuote(reqOf(W1, payment(W1, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })), DEF).applied === false && R.returningWalletQuote(reqOf(W1, "not-base64-json"), DEF).applied === false, "another payment shape (upto, Permit2, another chain family, an unreadable header) is priced at list");
  const viaGate = { ...reqOf(W1, payment(W1)), mppCredential: true };
  ok(R.returningWalletQuote(viaGate, DEF).applied === false, "a payment another gate took (the MPP shim, Tempo, card, credits) is priced at list");
  const once = reqOf(W1);
  const a = R.returningWalletQuote(once, DEF);
  days.set(W1, 0);
  ok(R.returningWalletQuote(once, DEF) === a, "one request is decided once: every accept of its 402 reads the same decision");
  days.set(W1, 3);
}

// --- the settle check --------------------------------------------------------------------
{
  const req = reqOf(W1, payment(W1));
  R.returningWalletQuote(req, DEF);
  const ctx = (from) => ({ transportContext: { request: { adapter: { req } } }, paymentPayload: { payload: { authorization: { from } } } });
  ok(R.returningWalletSettleDecision(ctx(W1)) === undefined && R.returningWalletSettleDecision(ctx(W1.toUpperCase().replace("0X", "0x"))) === undefined, "a discounted request settles for the wallet it was quoted for");
  const refused = R.returningWalletSettleDecision(ctx(W2));
  ok(refused?.abort === true && refused.reason === R.RETURNING_WALLET_MISMATCH, "and is refused before the settle for any other payer");
  ok(R.returningWalletSettleDecision(ctx(undefined))?.abort === true, "or for a payment whose payer cannot be read");
  const list = reqOf(W2, payment(W2));
  R.returningWalletQuote(list, DEF);
  ok(R.returningWalletSettleDecision({ transportContext: { request: { adapter: { req: list } } }, paymentPayload: { payload: { authorization: { from: W1 } } } }) === undefined && R.returningWalletSettleDecision({}) === undefined, "CONTROL a list-priced request is never touched by the check");
}

// --- the ledger read: cached per wallet, bounded per minute ---------------------------------
{
  R.__resetReturningWallet();
  reads = 0;
  const t0 = Date.parse("2026-11-21T12:00:00Z");
  for (let i = 0; i < 5; i++) R.walletQualifies(W1, { now: t0 + i });
  ok(reads === 1, `one wallet is read once inside the cache window (${reads})`);
  R.walletQualifies(W1, { now: t0 + R.CACHE_MS + 1 });
  ok(reads === 2, "and again after it");
  R.__resetReturningWallet();
  reads = 0;
  let qualified = 0;
  for (let i = 0; i < R.LOOKUPS_PER_MINUTE + 50; i++) { const w = "0x" + i.toString(16).padStart(40, "0"); days.set(w, 9); if (R.walletQualifies(w, { now: t0 })) qualified++; }
  ok(reads === R.LOOKUPS_PER_MINUTE && qualified === R.LOOKUPS_PER_MINUTE, `past the per-minute bound an unknown wallet is quoted list, not read (${reads} reads, ${qualified} qualified)`);
  ok(R.returningWalletStatus().counts.lookupsHeld === 50 && R.returningWalletStatus().cachedWallets === R.LOOKUPS_PER_MINUTE, "the held reads are counted on the operator view");
  ok(R.walletQualifies("0x" + (R.LOOKUPS_PER_MINUTE + 10).toString(16).padStart(40, "0"), { now: t0 + 60_000 }) === true, "the next minute reads again");
  R.configureReturningWallet({ paidDays: () => { throw new Error("ledger down"); }, isOurs: () => false });
  R.__resetReturningWallet();
  ok(R.walletQualifies(W1, { now: t0 }) === false, "a ledger read that throws quotes list");
  R.configureReturningWallet({ paidDays: () => 9, isOurs: () => { throw new Error("x"); } });
  ok(R.walletQualifies(W1, { now: t0 }) === false, "an own-wallet check that throws quotes list");
}

// --- the offer on the 402 ------------------------------------------------------------------
const offerBytes = (o) => Buffer.byteLength(JSON.stringify(o));
{
  R.configureReturningWallet({ paidDays: (w) => days.get(w) ?? 0, isOurs: (w) => w === OURS });
  R.__resetReturningWallet();
  const o = R.returningWalletOffer(DEF);
  ok(o && o.header === "X-Agent402-Wallet" && o.discountPercent === 10 && o.minPaidDays === 3 && o.windowDays === 30 && o.applied === false && o.why === undefined && o.note === undefined, `the offer names the header and the terms from the settings, in fields (${JSON.stringify(o)})`);
  ok(R.returningWalletOffer({ slug: "search", price: "$0.01" }) === null, "an ineligible route states no offer");
  const req = reqOf(W1);
  R.returningWalletQuote(req, DEF);
  ok(R.returningWalletOffer(DEF, req).applied === true, "and says when this request's quote carries the discount");
  // A named wallet whose quote did not change is told why, in one word.
  const whyOf = (r, def = DEF) => { R.returningWalletQuote(r, def); return R.returningWalletOffer(def, r); };
  const under = whyOf(reqOf(W2)), ours = whyOf(reqOf(OURS));
  ok(under.applied === false && under.why === "unqualified", `a wallet under the bar reads ${under.why}`);
  ok(ours.applied === false && ours.why === "unqualified" && JSON.stringify(ours) === JSON.stringify(under), "one of our own wallets reads the same as any wallet under the bar");
  ok(whyOf(reqOf(W1, payment(W2))).why === "other_payer" && whyOf(reqOf(W1, payment(W1, { scheme: "upto" }))).why === "other_rail", "a payment from another wallet, or of another shape, is named");
  ok(whyOf(reqOf(W1), { slug: "hash", price: "$0.000005" }).why === "min_price", "a price with no room under it is named");
  ok(whyOf(reqOf(null)).why === undefined && whyOf(reqOf("nope")).why === undefined, "a request that names no wallet gets the offer and no reason");
  // The field stays small in every shape, at the widest settings.
  Object.assign(process.env, { RETURNING_WALLET_DISCOUNT_BPS: "1255", RETURNING_WALLET_MIN_PAID_DAYS: "365", RETURNING_WALLET_WINDOW_DAYS: "365" });
  days.set(W1, 365);
  const shapes = [R.returningWalletOffer(DEF), whyOf(reqOf(W2)), whyOf(reqOf(W1, payment(W2))), whyOf(reqOf(W1, payment(W1, { scheme: "upto" }))), whyOf(reqOf(W1))];
  for (let n = 1; n <= 14; n++) {
    const r = reqOf(W1);
    R.returningWalletQuote(r, DEF);
    R.noteReturningWalletAccept?.(r, "eip155:8453", true);
    for (let i = 0; i < n; i++) R.noteReturningWalletAccept?.(r, `eip155:${4663 + i * 1_000_003}`, false);
    const o2 = R.returningWalletOffer(DEF, r);
    shapes.push(o2);
    if (n === 14) ok(o2.applied === true && Array.isArray(o2.atListOn) && o2.atListOn.length >= 1 && o2.atListOn.length + (o2.atListMore || 0) === 14, `many floored chains: the first are named and the rest counted (${JSON.stringify(o2)})`);
  }
  const widest = Math.max(...shapes.map(offerBytes));
  ok(Number.isInteger(R.OFFER_MAX_BYTES) && R.OFFER_MAX_BYTES <= 126 && widest <= R.OFFER_MAX_BYTES, `every shape of the field fits ${R.OFFER_MAX_BYTES} bytes (widest ${widest})`);
  for (const k of ["RETURNING_WALLET_DISCOUNT_BPS", "RETURNING_WALLET_MIN_PAID_DAYS", "RETURNING_WALLET_WINDOW_DAYS"]) delete process.env[k];
  days.set(W1, 3);
  // The prose surfaces say what the gate does.
  const prose = R.returningWalletSentence() + " " + R.returningWalletHeaderParam(DEF).description;
  ok(!/any other payer is quoted list/.test(prose) && /from any other wallet is answered 402 at the list price, and nothing is charged/.test(R.returningWalletSentence()), "the prose says a lower payment from another wallet is answered 402 at list, not that another payer is never charged");
  ok(/premium and price floor still apply/.test(R.returningWalletSentence()) && /premium and price floor still apply/.test(R.returningWalletHeaderParam(DEF).description) && !/\bunder list on\b/.test(prose), "and that a chain's premium and price floor still apply");
  ok(!/\u2014/.test(prose), "no em dash in the prose");
  delete process.env.RETURNING_WALLET_PRICE;
  ok(R.returningWalletOffer(DEF) === null && R.returningWalletSentence() === "" && R.returningWalletHeaderParam(DEF) === null, "switch off: no offer, no sentence, no header parameter");
}

// --- one client address cannot spend everyone's reads -----------------------------------------
{
  process.env.RETURNING_WALLET_PRICE = "on";
  let n = 0;
  R.configureReturningWallet({ paidDays: (w) => { n++; return days.get(w) ?? 0; }, isOurs: () => false });
  R.__resetReturningWallet();
  const t0 = Date.parse("2026-11-21T12:10:00Z");
  const unused = (i) => "0x" + (0xf00000 + i).toString(16).padStart(40, "0");
  // The probe's shape: 600 unpaid requests inside one minute, each naming an unused wallet, from one address.
  let held = 0;
  for (let i = 0; i < 600; i++) {
    const r = reqOf(unused(i), null, "203.0.113.7");
    const q = R.returningWalletQuote(r, DEF, { now: t0 + i * 99 });
    if (q.why === "not read") held++;
  }
  ok(R.LOOKUPS_PER_ADDRESS_PER_MINUTE >= 1 && R.LOOKUPS_PER_ADDRESS_PER_MINUTE < R.LOOKUPS_PER_MINUTE && n === R.LOOKUPS_PER_ADDRESS_PER_MINUTE && held === 600 - n, `one address reads the ledger ${R.LOOKUPS_PER_ADDRESS_PER_MINUTE} times a minute, then is quoted list (${n} reads, ${held} held)`);
  const heldReq = reqOf(unused(9999), null, "203.0.113.7");
  R.returningWalletQuote(heldReq, DEF, { now: t0 + 59_500 });
  ok(R.returningWalletOffer(DEF, heldReq).why === "lookup_busy" && R.returningWalletOffer(DEF, heldReq).applied === false, "its 402 says the wallet was not read this minute");
  const other = R.returningWalletQuote(reqOf(W1, null, "198.51.100.9"), DEF, { now: t0 + 59_900 });
  ok(other.applied === true && other.price === "$0.0009", `a qualifying wallet from another address is still quoted its price in that minute (${JSON.stringify({ applied: other.applied, why: other.why })})`);
  ok(R.returningWalletStatus().counts.lookupsHeldAddress === held + 1 && R.returningWalletStatus().counts.lookupsHeld === 0, "the operator view counts reads held for one address apart from the service-wide bound");
  ok(R.returningWalletQuote(reqOf(unused(10_000), null, "203.0.113.7"), DEF, { now: t0 + 60_000 }).why === "not qualified", "the next minute that address is read again");
  // An IPv6 caller is one address across its /64.
  R.__resetReturningWallet(); n = 0;
  for (let i = 0; i < R.LOOKUPS_PER_ADDRESS_PER_MINUTE + 5; i++) R.returningWalletQuote(reqOf(unused(20_000 + i), null, `2001:db8:1:2::${(i + 1).toString(16)}`), DEF, { now: t0 });
  ok(n === R.LOOKUPS_PER_ADDRESS_PER_MINUTE, `addresses inside one IPv6 /64 share one share (${n})`);
  // The service-wide ceiling still holds across many addresses.
  R.__resetReturningWallet(); n = 0;
  for (let i = 0; i < R.LOOKUPS_PER_MINUTE + 40; i++) R.returningWalletQuote(reqOf(unused(30_000 + i), null, `198.18.${i >> 8}.${i & 255}`), DEF, { now: t0 });
  ok(n === R.LOOKUPS_PER_MINUTE && R.returningWalletStatus().counts.lookupsHeld === 40, `many addresses together stop at the service-wide bound (${n})`);
  // A cached wallet costs no read, so a returning buyer behind a busy address keeps its price.
  R.__resetReturningWallet(); n = 0;
  R.returningWalletQuote(reqOf(W1, null, "203.0.113.7"), DEF, { now: t0 });
  for (let i = 0; i < 100; i++) R.returningWalletQuote(reqOf(unused(40_000 + i), null, "203.0.113.7"), DEF, { now: t0 + 1 });
  ok(R.returningWalletQuote(reqOf(W1, null, "203.0.113.7"), DEF, { now: t0 + 2 }).applied === true, "a wallet already read keeps its price from an address that has used its share");
  // What is kept: the wallet and its count, for the cache window, then dropped.
  R.__resetReturningWallet();
  R.returningWalletQuote(reqOf(W1, null, "203.0.113.7"), DEF, { now: t0 });
  R.returningWalletQuote(reqOf(W2, null, "203.0.113.8"), DEF, { now: t0 + 5 * 60_000 });
  ok(R.returningWalletStatus().cachedWallets === 2, "CONTROL two wallets are held inside the window");
  R.sweepReturningWallet?.(t0 + R.CACHE_MS + 1);
  ok(R.returningWalletStatus().cachedWallets === 1, `a wallet is dropped from memory once its ${R.CACHE_MS / 60_000} minutes are over (${R.returningWalletStatus().cachedWallets} held)`);
  R.sweepReturningWallet?.(t0 + 5 * 60_000 + R.CACHE_MS + 1);
  ok(R.returningWalletStatus().cachedWallets === 0, "and so is the next");
  delete process.env.RETURNING_WALLET_PRICE;
}

// --- the accepts: only the EVM exact accept is priced per request ----------------------------
{
  const { acceptsForItem } = await import("../src/payments.js");
  const rails = { evmCaip2: ["eip155:8453"], svmCaip2: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], stellarCaip2: [], avmCaip2: [], walletAddress: "0x" + "dd".repeat(20), solanaWallet: "So11111111111111111111111111111111111111112", stellarWallet: null, algorandWallet: null };
  const offAccepts = acceptsForItem(DEF, rails);
  ok(offAccepts.length >= 2 && offAccepts.every((a) => typeof a.price === "string"), "switch off: every accept is a fixed price");
  process.env.RETURNING_WALLET_PRICE = "on";
  const onAccepts = acceptsForItem(DEF, rails);
  const evm = onAccepts.filter((a) => a.network === "eip155:8453" && a.scheme === "exact" && !a.extra);
  ok(evm.length === 1 && typeof evm[0].price === "function" && onAccepts.filter((a) => a !== evm[0]).every((a) => typeof a.price === "string"), "switch on: the EVM exact accept is priced per request and every other accept stays fixed");
  const priceAt = (req) => evm[0].price({ adapter: { req } });
  ok(await priceAt(reqOf(W1)) === "$0.0009" && await priceAt(reqOf(W2)) === "$0.001" && await priceAt(reqOf(null)) === "$0.001" && await priceAt(undefined) === "$0.001", "it quotes the discount to a qualifying hint and list to everyone else");
  ok(await priceAt(reqOf(W1, payment(W2))) === "$0.001" && await priceAt(reqOf(W1, payment(W1))) === "$0.0009", "and on a paid request it follows the payment's signer");
  const notEligible = acceptsForItem({ slug: "search", price: "$0.01" }, rails);
  ok(notEligible.every((a) => typeof a.price === "string"), "an ineligible route's accepts stay fixed with the switch on");

  // A chain at its price floor quotes the same amount with or without the discount: the 402 says so.
  const { priceForNetwork } = await import("../src/payments.js");
  const exactOn = (accepts, net) => accepts.find((a) => a.network === net && a.scheme === "exact" && !a.extra);
  const two = acceptsForItem(DEF, { ...rails, evmCaip2: ["eip155:8453", FLOORED] });
  const mixed = reqOf(W1);
  const onBase = await exactOn(two, "eip155:8453").price({ adapter: { req: mixed } });
  const onFloor = await exactOn(two, FLOORED).price({ adapter: { req: mixed } });
  ok(priceForNetwork(DEF.price, FLOORED) === "$0.004" && onFloor === "$0.004" && onBase === "$0.0009", `CONTROL the floored chain quotes its floor to a qualifying wallet, the other chain the lower price (${onFloor} / ${onBase})`);
  const mixedOffer = R.returningWalletOffer(DEF, mixed);
  ok(mixedOffer.applied === true && JSON.stringify(mixedOffer.atListOn) === JSON.stringify([FLOORED]) && mixedOffer.atListMore === undefined, `the 402 names the chain whose quote did not change (${JSON.stringify(mixedOffer)})`);
  await exactOn(two, FLOORED).price({ adapter: { req: mixed } });
  ok(R.returningWalletOffer(DEF, mixed).atListOn.length === 1, "a price asked twice for one chain is named once");
  const onlyFloor = acceptsForItem(DEF, { ...rails, evmCaip2: [FLOORED] });
  const floored = reqOf(W1);
  await exactOn(onlyFloor, FLOORED).price({ adapter: { req: floored } });
  const flooredOffer = R.returningWalletOffer(DEF, floored);
  ok(flooredOffer.applied === false && flooredOffer.why === "price_floor" && flooredOffer.minPaidDays === 3, `where every quote sits at a floor the 402 does not say the discount was applied (${JSON.stringify(flooredOffer)})`);
  const listReq = reqOf(W2);
  await exactOn(two, FLOORED).price({ adapter: { req: listReq } });
  ok(R.returningWalletOffer(DEF, listReq).why === "unqualified", "CONTROL a wallet under the bar reads its own reason on a floored chain");
  // The payment itself on the floored chain: same amount, and it settles for the hinted wallet only.
  const paidFloor = reqOf(W1, payment(W1, { network: FLOORED }));
  ok(await exactOn(two, FLOORED).price({ adapter: { req: paidFloor } }) === "$0.004" && R.returningWalletSettleDecision({ transportContext: { request: { adapter: { req: paidFloor } } }, paymentPayload: { payload: { authorization: { from: W1 } } } }) === undefined, "the hinted wallet's payment on the floored chain is priced at the floor and settles");
  delete process.env.RETURNING_WALLET_PRICE;
}

// --- the ledger: paid days and the return rate -------------------------------------------------
{
  const L = await import("../src/sales-ledger.js");
  await L.salesLedgerReady();
  const day = 86_400_000, now = Date.now();
  const tag = randomBytes(4).toString("hex");
  const P1 = "0x" + tag + "11".repeat(16), P2 = "0x" + tag + "22".repeat(16), P3 = "0x" + tag + "33".repeat(16);
  ok(L.payerPaidDays(P1, now - 30 * day) === 0 && L.payerPaidDays("not-an-address", 0) === 0, "a wallet with no sale has no paid day");
  const sale = (payer, rail = "usdc") => L.recordSale({ slug: "hash", priceUsd: 0.001, rail, network: "eip155:8453", payer, tx: "0x" + randomBytes(32).toString("hex"), synthetic: false, wire: "x402" });
  sale(P1); sale(P1); sale(P2);
  await L.salesLedgerFlush();
  ok(L.payerPaidDays(P1, now - 30 * day) === 1 && L.payerPaidDays(P1.toUpperCase().replace("0X", "0x"), now - 30 * day) === 1, "two sales on one day are one paid day, in any case of the address");
  ok(L.payerPaidDays(P1, now + day) === 0, "a sale before the window does not count");
  sale(P3, "pow");
  await L.salesLedgerFlush();
  ok(L.payerPaidDays(P3, 0) === 0, "a free proof-of-work call is not a paid day");
  const rr = L.externalReturnRate({ days: 60, minPaidDays: 1, now: Date.now() + 1000 });
  ok(rr.payers >= 2 && rr.paidOneDayOnly >= 2 && rr.qualifying >= 2 && rr.paidAgainOnAnotherDay === rr.paidTwoDays + rr.paidThreeOrMoreDays && rr.windowDays === 60, `the return rate counts outside payers by paid days (${JSON.stringify(rr)})`);
  const rrAsync = await L.externalReturnRateAsync({ days: 60, minPaidDays: 1, now: Date.now() + 1000 });
  ok(rrAsync.payers === rr.payers && rrAsync.paidOneDayOnly === rr.paidOneDayOnly, "the paged read answers the same");
}

console.log(`\ntest-returning-wallet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
