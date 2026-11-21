// The returning-wallet price's rules (src/returning-wallet.js), offline: the
// settings, which routes are never discounted, the price math, the hint, the
// decision on an unpaid and on a paid request (the payment's own signer
// decides, never the hint), the settle check, the bounded ledger read, and
// the ledger's paid-days and return-rate reads.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";

for (const k of Object.keys(process.env)) if (/^(RETURNING_WALLET_|REFERRAL_SLUGS)/.test(k)) delete process.env[k];
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
const reqOf = (hint, payment = null) => ({ headers: { ...(hint != null ? { "x-agent402-wallet": hint } : {}), ...(payment ? { "payment-signature": payment } : {}) }, header(n) { return this.headers[String(n).toLowerCase()]; } });
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
{
  R.configureReturningWallet({ paidDays: (w) => days.get(w) ?? 0, isOurs: () => false });
  R.__resetReturningWallet();
  const o = R.returningWalletOffer(DEF);
  ok(o && o.header === "X-Agent402-Wallet" && o.discountPercent === 10 && o.minPaidDays === 3 && o.windowDays === 30 && o.applied === false && /signed from that wallet/.test(o.note), `the offer names the header and the terms from the settings (${JSON.stringify({ ...o, note: undefined })})`);
  ok(R.returningWalletOffer({ slug: "search", price: "$0.01" }) === null, "an ineligible route states no offer");
  const req = reqOf(W1);
  R.returningWalletQuote(req, DEF);
  ok(R.returningWalletOffer(DEF, req).applied === true, "and says when this request's quote carries the discount");
  delete process.env.RETURNING_WALLET_PRICE;
  ok(R.returningWalletOffer(DEF) === null, "switch off: no offer");
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
