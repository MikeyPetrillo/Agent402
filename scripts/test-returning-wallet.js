// The returning-wallet price's rules (src/returning-wallet.js), offline: the
// settings, which routes are never discounted, the price math, the hint and
// its proof (a hint nobody proved is never read and reads the same for every
// wallet; a proof by another key, out of the skew, for another route or
// server, or used again is no proof), the decision on an unpaid and on a paid request (the payment's own signer
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
// Wallets this suite holds the keys of, so it can prove them.
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const A1 = privateKeyToAccount("0x" + "a1".repeat(32)), A2 = privateKeyToAccount("0x" + "b2".repeat(32)), A0 = privateKeyToAccount("0x" + "0c".repeat(32));
const W1 = A1.address.toLowerCase(), W2 = A2.address.toLowerCase(), OURS = A0.address.toLowerCase();
const DEF = { slug: "hash", price: "$0.001", route: "POST /api/hash" };

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
const reqOf = (hint, payment = null, ip = undefined, proof = null) => ({ ip, headers: { ...(hint != null ? { "x-agent402-wallet": hint } : {}), ...(payment ? { "payment-signature": payment } : {}), ...(proof != null ? { "x-agent402-wallet-proof": proof } : {}) }, header(n) { return this.headers[String(n).toLowerCase()]; } });
ok(R.walletHintOf(reqOf(W1.toUpperCase().replace("0X", "0x"))) === W1 && R.walletHintOf(reqOf(` ${W1} `)) === W1, "a hint is an EVM address, read in lowercase");
ok(R.walletHintOf(reqOf("0x1234")) === null && R.walletHintOf(reqOf("")) === null && R.walletHintOf(reqOf(null)) === null && R.walletHintOf({ headers: { "x-agent402-wallet": [W1, W2] } }) === null, "anything else is no hint");

// --- the proof -----------------------------------------------------------------------
// A request proves its hint with the wallet's EIP-191 signature over the five
// lines walletProofMessage builds (this host, the route, the wallet, the time).
const HOST = "agent402.test";
const nowS = () => Math.floor(Date.now() / 1000);
// A signature over the same text is the same signature, and a proof is good
// for one unpaid use: each proof this suite makes names a time of its own,
// a second or more before now, inside the skew.
let proofSeq = 0;
const freshTime = (base = nowS()) => base - (proofSeq++ % 200);
/** The proof header `account` signs for `wallet` (its own address unless named) on `route` at `time`, for `host`. */
const proofOf = async (account, { wallet = account.address, route = DEF.route, host = HOST, time = freshTime() } = {}) =>
  R.walletProofHeader(time, await account.signMessage({ message: R.walletProofMessage({ host, route, wallet, time }) }));
/** A request that names `account`'s wallet and proves it (overrides as in proofOf, plus a payment and an address). */
const proved = async (account, { payment: pay = null, ip = undefined, hint = account.address, ...o } = {}) => reqOf(hint, pay, ip, await proofOf(account, { wallet: hint, ...o }));
/** The decision for a request: the proof checked first, as the gate does. */
const quote = async (req, def = DEF, o = {}) => { await R.proveReturningWallet(req, def, o); return R.returningWalletQuote(req, def, o); };
ok(R.walletProofMessage({ host: "Agent402.Test", route: "POST /api/hash", wallet: W1.toUpperCase().replace("0X", "0x"), time: 1700000000 }) === `Agent402 returning-wallet price\nhost: agent402.test\nroute: POST /api/hash\nwallet: ${W1}\ntime: 1700000000`, "the signed text names the host and wallet in lowercase, the route and the time, one per line");

// --- the decision ----------------------------------------------------------------------
const payment = (from, { scheme = "exact", network = "eip155:8453", permit2 = false } = {}) => Buffer.from(JSON.stringify({
  x402Version: 2, accepted: { scheme, network, amount: "900" },
  payload: permit2 ? { permit2Authorization: { from, permitted: { amount: "900" } } } : { signature: "0x11", authorization: { from, to: "0x" + "dd".repeat(20), value: "900", validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
let reads = 0;
const days = new Map([[W1, 3], [W2, 2], [OURS, 9]]);
R.configureReturningWallet({ paidDays: (w) => { reads++; return days.get(w) ?? 0; }, isOurs: (w) => w === OURS, host: HOST });
ok(R.returningWalletQuote(reqOf(W1), DEF).applied === false && R.returningWalletQuote(reqOf(W1), DEF).why === "off", "switch off: no request is discounted");
process.env.RETURNING_WALLET_PRICE = "on";
R.__resetReturningWallet();
{
  const q = await quote(await proved(A1));
  ok(q.applied === true && q.wallet === W1 && q.price === "$0.0009" && q.bps === 1000 && q.paid === false, `an unpaid request that names and proves a qualifying wallet is quoted the discount (${JSON.stringify(q)})`);
  const w2 = await quote(await proved(A2));
  ok(w2.applied === false && w2.why === "not qualified", "a proven wallet under the bar is quoted list");
  ok((await quote(await proved(A0))).applied === false, "one of our own wallets is never discounted");
  ok((await quote(reqOf(null))).why === "no hint" && (await quote(reqOf("nope"))).why === "no hint", "no hint, no discount");
  const SEARCH = { slug: "search", price: "$0.01", route: "POST /api/search" };
  ok((await quote(await proved(A1, { route: SEARCH.route }), SEARCH)).applied === false, "an ineligible route is quoted list whatever the hint");
}
// A hint nobody proved: nothing is read and nothing is said about the wallet.
{
  R.__resetReturningWallet(); reads = 0;
  const bare1 = reqOf(W1), bare2 = reqOf(W2);
  const q1 = await quote(bare1), q2 = await quote(bare2);
  ok(q1.applied === false && q1.why === "unproven" && q2.why === "unproven" && reads === 0, `a hint without a proof is quoted list and the ledger is not read for it (${q1.why}/${q2.why}, ${reads} reads)`);
  ok(JSON.stringify(R.returningWalletOffer(DEF, bare1)) === JSON.stringify(R.returningWalletOffer(DEF, bare2)), "the 402 field for an unproven qualifying wallet and an unproven wallet under the bar is the same, byte for byte");
  const t = nowS();
  const refusedBy = async (label, req) => { const q = await quote(req); ok(q.applied === false && q.why === "unproven", `${label} is no proof: quoted list, nothing said (${q.why})`); return q; };
  await refusedBy("a proof signed by another key", reqOf(W1, null, undefined, await proofOf(A2, { wallet: W1 })));
  await refusedBy("a proof older than the allowed skew", await proved(A1, { time: t - R.PROOF_SKEW_SECONDS - 5 }));
  await refusedBy("a proof dated past the allowed skew", await proved(A1, { time: t + R.PROOF_SKEW_SECONDS + 5 }));
  await refusedBy("a proof for another route", await proved(A1, { route: "POST /api/base64" }));
  await refusedBy("a proof for another server", await proved(A1, { host: "other.example" }));
  const relayed = await proved(A1, { host: "other.example" });
  relayed.headers.host = "other.example";
  await refusedBy("a proof for another server sent with that server's Host header", relayed);
  {
    // A request proven for one route is not proven for another route it is priced on.
    const BASE64 = { slug: "base64", price: "$0.001", route: "POST /api/base64" };
    const r = await proved(A1);
    await R.proveReturningWallet(r, DEF);
    const q = await quote(r, BASE64);
    ok(q.applied === false && q.why === "unproven", `a proof checked for one route does not prove the hint on another (${q.why})`);
  }
  await refusedBy("a malformed proof",reqOf(W1, null, undefined, "1700000000.0x1234"));
  await refusedBy("a proof whose header time differs from the signed time", reqOf(W1, null, undefined, (await proofOf(A1, { time: t })).replace(/^\d+/, String(t - 1))));
  ok(reads === 0, `no refused proof read the ledger (${reads})`);
  const near = await quote(await proved(A1, { time: t - R.PROOF_SKEW_SECONDS + 5 }));
  ok(near.applied === true, "CONTROL a proof inside the skew holds");
  // One proof: one request without a payment and one with (the quote and its signed retry); never more.
  const header = await proofOf(A1);
  ok((await quote(reqOf(W1, null, undefined, header))).applied === true, "CONTROL a fresh proof quotes the discount");
  await refusedBy("the same proof sent again without a payment (a replay)", reqOf(W1, null, undefined, header));
  ok((await quote(reqOf(W1, payment(W1), undefined, header))).applied === true, "the same proof on the signed retry keeps the discount");
  await refusedBy("the same proof sent again with a payment (a replay)", reqOf(W1, payment(W1), undefined, header));
  ok(R.returningWalletStatus().counts.unproven >= 10, "the unproven hints are counted on the operator view");
  // With no host configured no proof holds.
  R.configureReturningWallet({ paidDays: (w) => { reads++; return days.get(w) ?? 0; }, isOurs: (w) => w === OURS, host: null });
  await refusedBy("any proof while the server's host name is unknown", await proved(A1));
  R.configureReturningWallet({ paidDays: (w) => { reads++; return days.get(w) ?? 0; }, isOurs: (w) => w === OURS, host: HOST });
}
{
  const paid = await quote(await proved(A1, { payment: payment(W1) }));
  ok(paid.applied === true && paid.paid === true && paid.wallet === W1, "a payment signed from the proven, qualifying wallet keeps the discount");
  const upper = await quote(await proved(A1, { payment: payment(W1.toUpperCase().replace("0X", "0x")) }));
  ok(upper.applied === true, "the signer is compared in lowercase");
  const other = await quote(await proved(A1, { payment: payment(W2) }));
  ok(other.applied === false && other.why === "paid from another wallet", "a payment signed from another wallet is priced at list, whatever the hint says");
  const stranger = await quote(await proved(A1, { payment: payment("0x" + "ee".repeat(20)) }));
  ok(stranger.applied === false, "and so is one from a wallet the ledger has never seen");
  const noHint = await quote(reqOf(null, payment(W1)));
  ok(noHint.applied === false && noHint.why === "no hint", "a qualifying payer with no hint is priced at list (the quote it was given was list)");
  const noProof = await quote(reqOf(W1, payment(W1)));
  ok(noProof.applied === false && noProof.why === "unproven", "a payment from the hinted wallet with no proof is priced at list: the payment's own signer is not checked before the gate prices it");
  ok((await quote(await proved(A1, { payment: payment(W1, { scheme: "upto" }) }))).applied === false && (await quote(await proved(A1, { payment: payment(W1, { permit2: true }) }))).applied === false && (await quote(await proved(A1, { payment: payment(W1, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }) }))).applied === false && (await quote(await proved(A1, { payment: "not-base64-json" }))).applied === false, "another payment shape (upto, Permit2, another chain family, an unreadable header) is priced at list");
  const viaGate = { ...(await proved(A1, { payment: payment(W1) })), mppCredential: true };
  ok((await quote(viaGate)).applied === false, "a payment another gate took (the MPP shim, Tempo, card, credits) is priced at list");
  const once = await proved(A1);
  const a = await quote(once);
  days.set(W1, 0);
  ok(await quote(once) === a, "one request is decided once: every accept of its 402 reads the same decision");
  days.set(W1, 3);
}

// --- the settle check --------------------------------------------------------------------
{
  const req = await proved(A1, { payment: payment(W1) });
  await quote(req);
  const ctx = (from) => ({ transportContext: { request: { adapter: { req } } }, paymentPayload: { payload: { authorization: { from } } } });
  ok(R.returningWalletSettleDecision(ctx(W1)) === undefined && R.returningWalletSettleDecision(ctx(W1.toUpperCase().replace("0X", "0x"))) === undefined, "a discounted request settles for the wallet it was quoted for");
  const refused = R.returningWalletSettleDecision(ctx(W2));
  ok(refused?.abort === true && refused.reason === R.RETURNING_WALLET_MISMATCH, "and is refused before the settle for any other payer");
  ok(R.returningWalletSettleDecision(ctx(undefined))?.abort === true, "or for a payment whose payer cannot be read");
  const list = await proved(A2, { payment: payment(W2) });
  await quote(list);
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
  R.configureReturningWallet({ paidDays: (w) => days.get(w) ?? 0, isOurs: (w) => w === OURS, host: HOST });
  R.__resetReturningWallet();
  const o = R.returningWalletOffer(DEF);
  ok(o && o.header === "X-Agent402-Wallet" && o.discountPercent === 10 && o.minPaidDays === 3 && o.windowDays === 30 && o.applied === false && o.why === undefined && o.note === undefined, `the offer names the header and the terms from the settings, in fields (${JSON.stringify(o)})`);
  ok(R.returningWalletOffer({ slug: "search", price: "$0.01" }) === null, "an ineligible route states no offer");
  const req = await proved(A1);
  await quote(req);
  ok(R.returningWalletOffer(DEF, req).applied === true, "and says when this request's quote carries the discount");
  // A named wallet whose quote did not change is told why, in one word.
  const whyOf = async (r, def = DEF) => { await quote(r, def); return R.returningWalletOffer(def, r); };
  const under = await whyOf(await proved(A2)), ours = await whyOf(await proved(A0));
  ok(under.applied === false && under.why === "unqualified", `a wallet under the bar reads ${under.why}`);
  ok(ours.applied === false && ours.why === "unqualified" && JSON.stringify(ours) === JSON.stringify(under), "one of our own wallets reads the same as any wallet under the bar");
  ok((await whyOf(await proved(A1, { payment: payment(W2) }))).why === "other_payer" && (await whyOf(await proved(A1, { payment: payment(W1, { scheme: "upto" }) }))).why === "other_rail", "a payment from another wallet, or of another shape, is named");
  ok((await whyOf(await proved(A1), { ...DEF, price: "$0.000005" })).why === "min_price", "a price with no room under it is named");
  ok((await whyOf(reqOf(null))).why === undefined && (await whyOf(reqOf("nope"))).why === undefined, "a request that names no wallet gets the offer and no reason");
  ok((await whyOf(reqOf(W1))).why === "unproven" && (await whyOf(reqOf(W2))).why === "unproven", "a named wallet with no proof reads unproven, whatever its history");
  // The field stays small in every shape, at the widest settings.
  Object.assign(process.env, { RETURNING_WALLET_DISCOUNT_BPS: "1255", RETURNING_WALLET_MIN_PAID_DAYS: "365", RETURNING_WALLET_WINDOW_DAYS: "365" });
  days.set(W1, 365);
  const shapes = [R.returningWalletOffer(DEF), await whyOf(await proved(A2)), await whyOf(await proved(A1, { payment: payment(W2) })), await whyOf(await proved(A1, { payment: payment(W1, { scheme: "upto" }) })), await whyOf(await proved(A1)), await whyOf(reqOf(W1))];
  for (let n = 1; n <= 14; n++) {
    const r = await proved(A1);
    await quote(r);
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
  const prose = R.returningWalletSentence() + " " + R.returningWalletHeaderParams(DEF).map((p) => p.description).join(" ");
  ok(!/any other payer is quoted list/.test(prose) && /from any other wallet is answered 402 at the list price, and nothing is charged/.test(R.returningWalletSentence()), "the prose says a lower payment from another wallet is answered 402 at list, not that another payer is never charged");
  ok(/premium and price floor still apply/.test(R.returningWalletSentence()) && /premium and price floor still apply/.test(R.returningWalletHeaderParams(DEF)[0].description) && !/\bunder list on\b/.test(prose), "and that a chain's premium and price floor still apply");
  ok(!/\u2014/.test(prose), "no em dash in the prose");
  ok(R.returningWalletHeaderParams(DEF).map((p) => p.name).join() === "X-Agent402-Wallet,X-Agent402-Wallet-Proof" && /X-Agent402-Wallet-Proof/.test(R.returningWalletSentence()) && /EIP-191/.test(prose) && /`time: <the same seconds>`/.test(prose) && /within 5 minutes/.test(prose) && /one request without a payment and one with a payment/.test(prose) && /`unproven`/.test(prose), "the prose and the OpenAPI parameters name the proof header, its exact message, the skew and the reuse rule");
  delete process.env.RETURNING_WALLET_PRICE;
  ok(R.returningWalletOffer(DEF) === null && R.returningWalletSentence() === "" && R.returningWalletHeaderParams(DEF).length === 0, "switch off: no offer, no sentence, no header parameter");
}

// --- one client address cannot spend everyone's reads -----------------------------------------
{
  process.env.RETURNING_WALLET_PRICE = "on";
  let n = 0;
  R.configureReturningWallet({ paidDays: (w) => { n++; return days.get(w) ?? 0; }, isOurs: () => false, host: HOST });
  R.__resetReturningWallet();
  const t0 = Date.parse("2026-11-21T12:10:00Z");
  const T0 = Math.floor(t0 / 1000);
  // Each probe names a wallet the prober holds (it proves it), so each is a fresh ledger read.
  const unusedKeys = new Map();
  const unusedAccount = (i) => { if (!unusedKeys.has(i)) unusedKeys.set(i, privateKeyToAccount(generatePrivateKey())); return unusedKeys.get(i); };
  const unusedReq = async (i, ip, time = freshTime(T0)) => proved(unusedAccount(i), { ip, time });
  // The probe's shape: 600 unpaid requests inside one minute, each naming an unused wallet, from one address.
  let held = 0;
  for (let i = 0; i < 600; i++) {
    const r = await unusedReq(i, "203.0.113.7");
    const q = await quote(r, DEF, { now: t0 + i * 99 });
    if (q.why === "not read") held++;
  }
  ok(R.LOOKUPS_PER_ADDRESS_PER_MINUTE >= 1 && R.LOOKUPS_PER_ADDRESS_PER_MINUTE < R.LOOKUPS_PER_MINUTE && n === R.LOOKUPS_PER_ADDRESS_PER_MINUTE && held === 600 - n, `one address reads the ledger ${R.LOOKUPS_PER_ADDRESS_PER_MINUTE} times a minute, then is quoted list (${n} reads, ${held} held)`);
  const heldReq = await unusedReq(9999, "203.0.113.7");
  await quote(heldReq, DEF, { now: t0 + 59_500 });
  ok(R.returningWalletOffer(DEF, heldReq).why === "lookup_busy" && R.returningWalletOffer(DEF, heldReq).applied === false, "its 402 says the wallet was not read this minute");
  const other = await quote(await proved(A1, { ip: "198.51.100.9", time: freshTime(T0) }), DEF, { now: t0 + 59_900 });
  ok(other.applied === true && other.price === "$0.0009", `a qualifying wallet from another address is still quoted its price in that minute (${JSON.stringify({ applied: other.applied, why: other.why })})`);
  ok(R.returningWalletStatus().counts.lookupsHeldAddress === held + 1 && R.returningWalletStatus().counts.lookupsHeld === 0, "the operator view counts reads held for one address apart from the service-wide bound");
  ok((await quote(await unusedReq(10_000, "203.0.113.7"), DEF, { now: t0 + 60_000 })).why === "not qualified", "the next minute that address is read again");
  ok((await quote(reqOf(unusedAccount(10_001).address.toLowerCase(), null, "203.0.113.7"), DEF, { now: t0 + 60_000 })).why === "unproven" && R.returningWalletStatus().counts.lookupsHeldAddress === held + 1, "a hint with no proof spends no read of that address's share");
  // An IPv6 caller is one address across its /64.
  R.__resetReturningWallet(); n = 0;
  for (let i = 0; i < R.LOOKUPS_PER_ADDRESS_PER_MINUTE + 5; i++) await quote(await unusedReq(20_000 + i, `2001:db8:1:2::${(i + 1).toString(16)}`), DEF, { now: t0 });
  ok(n === R.LOOKUPS_PER_ADDRESS_PER_MINUTE, `addresses inside one IPv6 /64 share one share (${n})`);
  // The service-wide ceiling still holds across many addresses.
  R.__resetReturningWallet(); n = 0;
  for (let i = 0; i < R.LOOKUPS_PER_MINUTE + 40; i++) await quote(await unusedReq(30_000 + i, `198.18.${i >> 8}.${i & 255}`), DEF, { now: t0 });
  ok(n === R.LOOKUPS_PER_MINUTE && R.returningWalletStatus().counts.lookupsHeld === 40, `many addresses together stop at the service-wide bound (${n})`);
  // A cached wallet costs no read, so a returning buyer behind a busy address keeps its price.
  R.__resetReturningWallet(); n = 0;
  await quote(await proved(A1, { ip: "203.0.113.7", time: freshTime(T0) }), DEF, { now: t0 });
  for (let i = 0; i < 100; i++) await quote(await unusedReq(40_000 + i, "203.0.113.7"), DEF, { now: t0 + 1 });
  ok((await quote(await proved(A1, { ip: "203.0.113.7", time: freshTime(T0) }), DEF, { now: t0 + 2 })).applied === true, "a wallet already read keeps its price from an address that has used its share");
  // What is kept: the wallet and its count, for the cache window, then dropped.
  R.__resetReturningWallet();
  await quote(await proved(A1, { ip: "203.0.113.7", time: freshTime(T0) }), DEF, { now: t0 });
  await quote(await proved(A2, { ip: "203.0.113.8", time: freshTime(T0 + 300) }), DEF, { now: t0 + 5 * 60_000 });
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
  ok(await priceAt(await proved(A1)) === "$0.0009" && await priceAt(await proved(A2)) === "$0.001" && await priceAt(reqOf(null)) === "$0.001" && await priceAt(undefined) === "$0.001", "it quotes the discount to a proven qualifying hint and list to everyone else");
  ok(await priceAt(reqOf(W1)) === "$0.001", "the gate checks the proof itself: a qualifying hint with no proof is quoted list");
  ok(await priceAt(await proved(A1, { payment: payment(W2) })) === "$0.001" && await priceAt(await proved(A1, { payment: payment(W1) })) === "$0.0009", "and on a paid request it follows the payment's signer");
  const notEligible = acceptsForItem({ slug: "search", price: "$0.01" }, rails);
  ok(notEligible.every((a) => typeof a.price === "string"), "an ineligible route's accepts stay fixed with the switch on");

  // A chain at its price floor quotes the same amount with or without the discount: the 402 says so.
  const { priceForNetwork } = await import("../src/payments.js");
  const exactOn = (accepts, net) => accepts.find((a) => a.network === net && a.scheme === "exact" && !a.extra);
  const two = acceptsForItem(DEF, { ...rails, evmCaip2: ["eip155:8453", FLOORED] });
  const mixed = await proved(A1);
  const onBase = await exactOn(two, "eip155:8453").price({ adapter: { req: mixed } });
  const onFloor = await exactOn(two, FLOORED).price({ adapter: { req: mixed } });
  ok(priceForNetwork(DEF.price, FLOORED) === "$0.004" && onFloor === "$0.004" && onBase === "$0.0009", `CONTROL the floored chain quotes its floor to a qualifying wallet, the other chain the lower price (${onFloor} / ${onBase})`);
  const mixedOffer = R.returningWalletOffer(DEF, mixed);
  ok(mixedOffer.applied === true && JSON.stringify(mixedOffer.atListOn) === JSON.stringify([FLOORED]) && mixedOffer.atListMore === undefined, `the 402 names the chain whose quote did not change (${JSON.stringify(mixedOffer)})`);
  await exactOn(two, FLOORED).price({ adapter: { req: mixed } });
  ok(R.returningWalletOffer(DEF, mixed).atListOn.length === 1, "a price asked twice for one chain is named once");
  const onlyFloor = acceptsForItem(DEF, { ...rails, evmCaip2: [FLOORED] });
  const floored = await proved(A1);
  await exactOn(onlyFloor, FLOORED).price({ adapter: { req: floored } });
  const flooredOffer = R.returningWalletOffer(DEF, floored);
  ok(flooredOffer.applied === false && flooredOffer.why === "price_floor" && flooredOffer.minPaidDays === 3, `where every quote sits at a floor the 402 does not say the discount was applied (${JSON.stringify(flooredOffer)})`);
  const listReq = await proved(A2);
  await exactOn(two, FLOORED).price({ adapter: { req: listReq } });
  ok(R.returningWalletOffer(DEF, listReq).why === "unqualified", "CONTROL a wallet under the bar reads its own reason on a floored chain");
  // The payment itself on the floored chain: same amount, and it settles for the hinted wallet only.
  const paidFloor = await proved(A1, { payment: payment(W1, { network: FLOORED }) });
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
