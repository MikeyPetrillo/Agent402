// Payability check: buy ONE call from an x402 seller and report what happened.
//
// WHY (2026-09-11). Three sellers wrote to us in one week because their
// endpoints looked healthy and nobody was paying them, and in each case the
// answer was only visible from OUTSIDE: one advertised the wrong EIP-712
// domain name on its Base accept, so every stock buyer's signature recovered
// to nobody and nothing had settled for a month; one had a live 402 that
// disagreed with its own manifest; one was fine and had simply never been
// tried. We answered each by hand with scripts/external-seller-probe.js - a
// dispatch-only script that pays one call from the spending wallet and prints
// the raw legs. This is that script as a product: the seller-facing twin of
// seller-dossier, which reports what we already KNOW. This one goes and finds
// out, right now, with real money.
//
// WHAT IT RETURNS: the bare 402 decoded (accepts, payTo, asset, price, and the
// chain-truth verdict on the accept's EIP-712 domain name), whether the signed
// payment was accepted, the settle receipt and transaction, a bounded slice of
// the response body, and the wall time of each leg - then sentence FLAGS, no
// score. Every field is something we observed in this call; nothing is
// inferred from the index.
//
// MONEY. The upstream is the seller's own price, capped by `maxUsd` (default
// $0.01, hard ceiling MAX_SPEND_USD) and re-checked by payX402 against the
// accept it actually signs, so a seller cannot quote one price and charge
// another. WE PAY NO GAS: the EIP-3009 transfer is broadcast by the SELLER's
// facilitator, not by us (an earlier draft of this comment said "plus Base
// gas" and was wrong). So $0.10 a check against at most $0.02 of upstream,
// and the margin holds at the 70% bound.
//
// WHY A CALLER CANNOT FARM US - stated with its precondition, because the
// first version of this paragraph quietly assumed the part that can fail.
// Pointing the tool at your own endpoint to collect our payment loses money
// for the attacker ONLY IF our own $0.10 settles: they pay $0.10 to receive at
// most $0.02. The state worth naming is the one where it does NOT settle -
// @x402/express runs this handler and settles afterwards, so a buyer whose
// payment verifies and then fails to settle gets each check free. Four things
// bound that, and the 2026-09-11 review exists because three of them were
// named here before they were actually bound:
//   - the settle-failure breaker runs BEFORE this handler for every
//     wallet-only slug and refuses at 3 failures per 15 min, so ~$0.06;
//   - the Base wallet's rolling daily ceiling bounds a caller who rotates
//     wallets or IPs, which is what defeats every per-payer guard;
//   - the per-call cap is enforced against the accept actually SIGNED, not
//     against the probe's 402 (they can differ - the seller writes both);
//   - the handler is EVM-exact only and deadline-bounded, so it cannot outlive
//     the buyer's own authorization and turn a slow seller into a free check.
// The target must also pass the SSRF guard and answer a real 402. The seller's
// response body is third-party text, so it is truncated and marked untrusted.
import { markUntrusted } from "./provenance.js";
import { maySpend as realMaySpend, noteSpend as realNoteSpend, adjustSpend as realAdjustSpend } from "../external-spend-guard.js";
import { usdcDomainVerdict, usdcDomainMismatchDetail } from "../evm-usdc-domain.js";
import { payerFromRequest } from "../payer.js";
import { acceptsFromLive402, quoteFromAccepts } from "../x402-live-quote.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** Hard ceiling on what one check may spend upstream, whatever `maxUsd` asks
 *  for. The price is $0.10; this keeps the worst case inside the margin rule
 *  even when a caller asks for the maximum. */
export const MAX_SPEND_USD = 0.02;
const DEFAULT_MAX_USD = 0.01;
const BODY_SLICE = 2000;
const PROBE_TIMEOUT_MS = 15_000;
const PAY_TIMEOUT_MS = 45_000;
// The whole handler's budget, threaded into the payer as both its per-fetch
// timeout and its refusal wait (2026-09-11 review).
//
// Where the worst case actually comes from, measured rather than assumed: NOT
// the refusal wait. On Base that wait is already capped near 35 s, because
// capEvmValidity caps the signed validBefore at SOR_REFUSAL_WINDOW_S and the
// check polls to that absolute deadline; the 90 s SOR_REFUSAL_MAX_WAIT_MS
// default is only live on Solana, and this route is Base-pinned. The ~150 s
// comes from payX402 running THREE sequential 45 s fetches (the bare 402, the
// paid retry, the X-PAYMENT-by-name resend) after our own 15 s probe. Passing
// the remaining budget bounds all of them.
//
// Why it matters: settlement runs AFTER the handler, so a handler that outlives
// the buyer's authorization means we paid the seller and nobody paid us. The
// realistic case is not an attacker, it is a SLOW HONEST SELLER answering 200
// at 30 to 60 s - the same shape as the 69 s scrape that cost us a Tempo leg
// and forced SOR_TEMPO_BUDGET_MS. The structural half of the fix is the
// LONG_RUNNING_SLUGS entry, which stops the paywall advertising rails that
// cannot settle a run this long.
const DEADLINE_MS = 55_000;

/** Accept the shapes a buyer actually types. Returns a validated https URL. */
export function normalizeTarget(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw bad('"url" is required - the seller endpoint to check, e.g. https://api.example.com/tool');
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw bad(`"${s.slice(0, 80)}" is not a URL`); }
  if (u.protocol !== "https:") throw bad("Only https endpoints are checked - an x402 seller that settles real money should not be served over http");
  if (u.username || u.password) throw bad("Credentials in the URL are not accepted");
  return u.toString();
}

/** The decoded 402, or a reason it could not be read. Never throws. */
export function readChallenge({ header, body }) {
  const accepts = acceptsFromLive402({ header, body }) || [];
  if (!accepts.length) return { readable: false, reason: "the 402 carried no accepts we could parse (neither the PAYMENT-REQUIRED header nor the body)", accepts: [] };
  const quote = quoteFromAccepts(accepts) || {};
  return {
    readable: true,
    networks: [...new Set(accepts.map((a) => a?.network).filter((n) => typeof n === "string"))].slice(0, 16),
    priceUsd: quote.price ?? null,
    payTo: typeof quote.payTo === "string" ? quote.payTo.slice(0, 80) : null,
    asset: typeof quote.asset === "string" ? quote.asset.slice(0, 80) : null,
    pricedFrom: quote.network ?? null,
    accepts: accepts.slice(0, 16).map((a) => ({
      scheme: typeof a?.scheme === "string" ? a.scheme.slice(0, 24) : null,
      network: typeof a?.network === "string" ? a.network.slice(0, 60) : null,
      asset: typeof a?.asset === "string" ? a.asset.slice(0, 80) : null,
      payTo: typeof a?.payTo === "string" ? a.payTo.slice(0, 80) : null,
      amount: a?.amount ?? a?.maxAmountRequired ?? null,
      domainName: typeof a?.extra?.name === "string" ? a.extra.name.slice(0, 40) : null,
      // Kept beside the name because the pair, not the name alone, is what
      // separates Circle's Gateway rail from a mistyped token domain.
      verifyingContract: typeof a?.extra?.verifyingContract === "string" ? a.extra.verifyingContract.slice(0, 42) : null,
      maxTimeoutSeconds: Number.isFinite(Number(a?.maxTimeoutSeconds)) ? Number(a.maxTimeoutSeconds) : null,
    })),
  };
}

/** The EIP-712 domain verdict for every EVM accept we could judge. A wrong
 *  name is the defect that made a whole catalog unpayable for a month, and it
 *  is readable from the accept alone - see src/evm-usdc-domain.js. */
export function domainFindings(accepts) {
  const out = [];
  for (const a of accepts || []) {
    const v = usdcDomainVerdict({ asset: a.asset, name: a.domainName, verifyingContract: a.verifyingContract }, a.network);
    if (v.verdict === "unknown") continue;
    out.push({ network: a.network, verdict: v.verdict, advertisedName: v.advertisedName ?? a.domainName, expectedName: v.expectedName, chain: v.chain, ...(v.verifyingContract ? { verifyingContract: v.verifyingContract } : {}) });
  }
  return out;
}

/** Sentence flags, in the order a seller should act on them. No score: a
 *  number reads as a verdict we did not measure (the dossier's own rule). */
export function payabilityFlags({ bare, challenge, domains, paid, receipt, settled }) {
  const flags = [];
  if (bare?.status === 200) flags.push("the endpoint answered 200 to an unpaid call: it is not paywalled, so an x402 buyer never pays for it");
  else if (bare?.status !== 402) flags.push(`an unpaid call answered HTTP ${bare?.status ?? "nothing"}, not 402: a buyer's client sees no payment challenge and stops here`);
  if (bare?.status === 402 && !challenge?.readable) flags.push(`the 402 could not be parsed: ${challenge?.reason}`);
  for (const d of domains || []) {
    if (d.verdict === "wrong_domain") flags.push(`${usdcDomainMismatchDetail(d)} - fix extra.name on the ${d.network} accept`);
    // Not a flag against the seller: a dossier that tells a Gateway seller to
    // "fix" a rail Circle ships would be wrong, and the seller would be right
    // to ignore the whole report after reading it.
    else if (d.verdict === "gateway_batched") flags.push(`${usdcDomainMismatchDetail(d)} - a stock-buyer router (this one included) will skip the ${d.network} accept until it speaks the rail; offering one plain EIP-3009 accept beside it makes you payable by both`);
  }
  if (challenge?.readable && challenge.priceUsd == null) flags.push("the accepts carry no amount we could price: a buyer that checks the quote before paying cannot");
  if (paid && paid.status === 402) flags.push("the signed payment was refused and the route answered 402 again: the credential your gate rejected is the one a stock client produces");
  else if (paid && paid.status >= 400) flags.push(`the paid call answered HTTP ${paid.status}: the payment was accepted or not, but the buyer got no result`);
  if (settled === false && paid?.status === 200) flags.push("the call answered 200 with no settlement receipt: the buyer was served for free, which is money you are not collecting");
  if (settled && paid?.status === 200 && !flags.length) flags.push("a stock buyer can pay this endpoint and get a result: nothing to fix");
  return flags;
}

/** Deps are injectable so the whole flow is testable offline with a stub
 *  seller; the defaults are the real spend guard, the real payer and the real
 *  SSRF-guarded fetch. */
export function buildSellerPayabilityTool({
  pay, spendChain = "base", fetchImpl, assertPublicUrl, now = () => Date.now(),
  maySpend = realMaySpend, noteSpend = realNoteSpend, adjustSpend = realAdjustSpend,
} = {}) {
  async function handler(input, req) {
    const url = normalizeTarget(input?.url);
    const method = String(input?.method ?? "POST").toUpperCase();
    if (!["GET", "POST"].includes(method)) throw bad('"method" must be GET or POST - a payability check never sends a verb that could mutate the seller');
    let body;
    if (input?.body !== undefined) {
      if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) throw bad('"body" must be a JSON object (the input the seller\'s route expects)');
      body = input.body;
    }
    const asked = input?.maxUsd === undefined ? DEFAULT_MAX_USD : Number(input.maxUsd);
    if (!Number.isFinite(asked) || asked <= 0) throw bad('"maxUsd" must be a positive number of dollars');
    if (asked > MAX_SPEND_USD) throw bad(`"maxUsd" is capped at $${MAX_SPEND_USD} per check - a seller quoting above that is not checked here (the check costs $0.10 and cannot carry more)`);
    const maxUsd = asked;

    // SSRF before anything: paying an arbitrary URL is egress abuse with a
    // wallet attached, so resolve and refuse a private target up front. The
    // payer re-guards and pins the connection before it signs.
    try { await assertPublicUrl(url); } catch { throw bad("That URL resolves to a private or blocked address", 400); }

    // The wallet's daily ceiling, the same guard route-execute books against.
    // Keyed on the chain, so this tool cannot walk past the day's bound even
    // if every caller asks at once.
    // Key the buyer in, exactly as route-execute does. A null payer takes the
    // guard's "not attributable" branch (external-spend-guard.js), so the
    // per-payer unsettled ceiling is skipped entirely and the spend carries no
    // operator attribution.
    //
    // HONEST SCOPE, from the 2026-09-11 review: this is consistency and
    // attribution, NOT a money hole, and the first draft of this comment
    // overstated it. The real bounds on an uncharged spend here were already
    // in place and still are - the settle-failure breaker runs BEFORE this
    // handler for every wallet-only slug and refuses at 3 failures per 15 min
    // (so at most ~$0.06), and the Base wallet's $25/day chain ceiling is what
    // actually bounds a caller rotating wallets or IPs. The per-payer ceiling
    // is $6 against a $0.02 cap, so it would not have refused until call 301.
    // Keep it anyway: it costs three lines, it puts this route in
    // exposureSnapshot() beside route-execute, and it is the bound that starts
    // mattering the moment the cap is raised or the breaker is retuned.
    //
    // Tempo buyers have no x402 header (the gate strips it), hence the
    // fallback chain; the IP last so nobody is unkeyed.
    const spendPayer = payerFromRequest(req)
      || (req?.mppTempoPayer ? `tempo:${req.mppTempoPayer}` : null)
      || (req?.ip ? `ip:${req.ip}` : null);
    const allowed = maySpend(spendPayer, maxUsd, { chain: spendChain });
    if (!allowed?.ok) {
      throw bad(allowed?.code === "wallet_daily_ceiling"
        ? "The Base spending wallet has reached its daily ceiling; payability checks resume tomorrow (nobody was charged)"
        : "Upstream spend is paused right now; try again shortly (nobody was charged)", 429);
    }
    const spendHandle = noteSpend(spendPayer, maxUsd, { chain: spendChain });
    // server.js resolves this on the post-settlement finish hook; without it
    // the worst-case booking stands for the whole window whatever happened.
    if (spendHandle && req && typeof req === "object") req.__externalSpend = spendHandle;

    const t0 = now();
    // LEG 1: the bare call. What a buyer's client sees before it pays.
    let bare = { status: null, error: null };
    let challenge = { readable: false, reason: "no 402 was returned" };
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      bare = { status: res.status, contentType: (res.headers.get("content-type") || "").slice(0, 80) || null, error: null };
      if (res.status === 402) challenge = readChallenge({ header: res.headers.get("payment-required"), body: text.slice(0, 64_000) });
      bare.bodySlice = text.slice(0, 400);
    } catch (e) {
      bare = { status: null, error: String(e?.message || e).slice(0, 120) };
    }
    const bareMs = now() - t0;

    const domains = challenge.readable ? domainFindings(challenge.accepts) : [];

    // LEG 2: pay it, but only when the first leg says a payment is possible
    // and the quote is inside the cap. A 200 or an unreadable challenge means
    // there is nothing to buy, and we never spend to learn that twice.
    let paid = null, receipt = null, settled = null, result = null, payError = null, payMs = null;
    const quoted = challenge.readable ? challenge.priceUsd : null;
    const payable = bare.status === 402 && challenge.readable;
    const overCap = payable && quoted != null && quoted > maxUsd;
    if (payable && !overCap) {
      const t1 = now();
      try {
        const out = await pay(url, {
          maxAtomic: BigInt(Math.round(maxUsd * 1e6)),
          method,
          ...(method === "POST" ? { body: body ?? {} } : {}),
          chain: spendChain,
          // Both bounds carry the request's REMAINING budget, so no leg of the
          // payer can push the handler past DEADLINE_MS.
          timeoutMs: Math.max(1_000, Math.min(PAY_TIMEOUT_MS, DEADLINE_MS - (now() - t0))),
          refusalMaxWaitMs: Math.max(0, DEADLINE_MS - (now() - t0)),
        });
        paid = { status: 200 };
        receipt = out?.receipt ?? null;
        settled = !!(receipt && (receipt.success === true || receipt.transaction || receipt.tx));
        result = typeof out?.result === "string" ? out.result.slice(0, BODY_SLICE) : JSON.stringify(out?.result ?? null).slice(0, BODY_SLICE);
        // Correct the day's booking down to what we ACTUALLY SIGNED, which is
        // `out.quote.usd` - never `quoted`, which came from LEG 1's 402.
        // payX402 issues its own bare request and signs whatever THAT 402
        // names, and the seller writes both responses: a cheap probe quote
        // beside an expensive paying quote would have booked ~nothing against
        // the wallet's daily ceiling while the real money left. That is the
        // ratchet adjustSpend's own docstring warns about - one
        // seller-controlled document setting our debt ceiling - and it is
        // worse here than the route-execute case it was written for, because
        // the number came from a DIFFERENT response than the one paid.
        const signedUsd = Number(out?.quote?.usd);
        if (Number.isFinite(signedUsd)) adjustSpend(spendHandle, signedUsd);
      } catch (e) {
        // payX402's own refusals carry a statusCode; a 402 means the seller
        // rejected the credential a stock client produces, which is the
        // single most useful thing this check can tell a seller.
        payError = String(e?.message || e).slice(0, 300);
        paid = { status: e?.statusCode === 402 || /refused the payment/i.test(payError) ? 402 : (e?.statusCode ?? null) };
        settled = false;
        // Nothing was signed unless the payer says it committed, so give the
        // day's budget back rather than holding the worst case for the window.
        if (e?.committed !== true) adjustSpend(spendHandle, 0);
      }
      payMs = now() - t1;
    } else {
      // No payment was attempted at all - a 200, a non-402, an unreadable
      // challenge or an over-cap quote. This is the COMMON outcome for a tool
      // whose job is diagnosing sellers, and the worst-case booking would
      // otherwise hold $0.02 of the chain's day for the full window on every
      // such check, quietly starving route-execute and the supply-chain buys.
      adjustSpend(spendHandle, 0);
    }

    const flags = payabilityFlags({ bare, challenge, domains, paid, receipt, settled });
    if (overCap) flags.unshift(`the seller quotes $${quoted}, above the $${maxUsd} cap this check was asked to spend, so no payment was attempted - raise maxUsd (up to $${MAX_SPEND_USD}) to buy it`);

    return markUntrusted({
      url,
      method,
      checkedAt: new Date(now()).toISOString(),
      payable: paid?.status === 200 && settled === true,
      unpaidCall: { status: bare.status, contentType: bare.contentType ?? null, error: bare.error, ms: bareMs, bodySlice: bare.bodySlice ?? null },
      challenge,
      domainFindings: domains,
      payment: paid
        ? { attempted: true, status: paid.status, settled, error: payError, ms: payMs, receipt: receipt ? { network: receipt.network ?? null, payer: receipt.payer ?? null, transaction: receipt.transaction ?? receipt.tx ?? null, success: receipt.success ?? null } : null }
        : { attempted: false, reason: overCap ? "quote above the cap" : bare.status === 402 ? "the 402 could not be parsed" : "the endpoint did not answer 402", settled: null },
      responseSlice: result,
      flags,
    });
  }

  return {
    route: "POST /api/seller-payability",
    name: "x402 seller payability check",
    slug: "seller-payability",
    aliases: ["payability-check", "can-i-pay-this", "seller-payment-check", "x402-payability"],
    category: "x402",
    price: "$0.10",
    description:
      "Buy one call from an x402 seller endpoint right now and report exactly what happened: the unpaid call's status, the 402 decoded (accepts, chains, payTo, asset, price), whether the accept's EIP-712 domain name matches the token it names (the defect that silently makes a whole catalog unpayable), whether a stock client's signed payment was accepted, the settlement receipt and transaction, a slice of the response body, and the time each leg took. Ends in plain-English flags, never a score. This is the live counterpart to seller-dossier, which reports what we already know: this one spends real USDC from our own wallet to find out. Point it at your own endpoint before you launch, or at a seller you are about to route money to. Up to $0.02 of the seller's price per check.",
    tags: ["x402", "seller", "payability", "payment", "402", "check", "verify", "settlement", "debug", "pre-launch",
      "is my endpoint payable", "why is nobody paying me", "test my x402 endpoint", "can an agent pay this", "eip-712", "domain"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The seller endpoint to check (https), e.g. https://api.example.com/tools/summarize" },
          method: { type: "string", description: "GET or POST (default POST) - never a verb that could mutate the seller" },
          body: { type: "object", description: "Optional JSON body the seller's route expects (POST only)" },
          maxUsd: { type: "number", description: `Most to spend on the seller's own price, default ${DEFAULT_MAX_USD}, capped at ${MAX_SPEND_USD}` },
        },
        required: ["url"],
      },
      // The documented example points at a route on THIS host, and that is
      // deliberate twice over. A placeholder host answers no 402, so the tool
      // refused its own example 400 before any payment - the one tool in the
      // catalog that could not demonstrate itself (found 2026-09-11 when a
      // registration sweep tried to buy it). And the standing rule keeps
      // third-party hostnames out of committed text, so the only live seller
      // this file may name is us. /api/hash is $0.001, pure CPU and always up,
      // so the example is a HEALTHY seller end to end: a real 402 decoded, a
      // real signature, a real settlement, and flags that say nothing to fix.
      input: { url: "https://agent402.tools/api/hash", method: "POST", body: { text: "hello" } },
      output: {
        example: {
          url: "https://agent402.tools/api/hash",
          method: "POST",
          checkedAt: "2026-09-11T02:00:00.000Z",
          payable: true,
          unpaidCall: { status: 402, contentType: "application/json", error: null, ms: 180, bodySlice: "{}" },
          challenge: { readable: true, networks: ["eip155:8453"], priceUsd: 0.01, payTo: "0x…", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", pricedFrom: "eip155:8453", accepts: [] },
          domainFindings: [{ network: "eip155:8453", verdict: "matches", advertisedName: "USD Coin", expectedName: "USD Coin", chain: "Base" }],
          payment: { attempted: true, status: 200, settled: true, error: null, ms: 2400, receipt: { network: "eip155:8453", payer: "0x…", transaction: "0x…", success: true } },
          responseSlice: "{\"summary\":\"…\"}",
          flags: ["a stock buyer can pay this endpoint and get a result: nothing to fix"],
        },
      },
    },
    handler,
  };
}
