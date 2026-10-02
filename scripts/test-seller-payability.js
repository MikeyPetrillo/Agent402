#!/usr/bin/env node
// Seller payability check (2026-09-11): buy one call from an x402 seller and
// report the legs. Offline - a stub seller and a stub payer, so this asserts
// the contract, the spend bound and every refusal without spending a cent.
//
// The defect this product exists for is real: a seller advertised the wrong
// EIP-712 domain name on its Base accept and nothing settled for a month while
// every surface it owned read healthy (2026-09-10). The domain leg below is
// that case.
import { buildSellerPayabilityTool, normalizeTarget, readChallenge, domainFindings, payabilityFlags, MAX_SPEND_USD } from "../src/tools/seller-payability-kit.js";
import { LONG_RUNNING_SLUGS } from "../src/composite-spend-guard.js";
import { requiredSecondsFor } from "../src/avm-validity.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const accept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "10000", payTo: "0x" + "11".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over });
const challengeHeader = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
const res402 = (accepts) => ({ status: 402, headers: new Map([["payment-required", challengeHeader(accepts)], ["content-type", "application/json"]]), text: async () => "{}" });
const plain = (status, body = "{}") => ({ status, headers: new Map([["content-type", "application/json"]]), text: async () => body });
for (const r of []) void r;
const hdr = (m) => ({ get: (k) => m.get(k.toLowerCase()) ?? null });
const wrap = (r) => ({ ...r, headers: hdr(r.headers) });

/** Waits `ms` of real time, or rejects the way fetch does when `signal` aborts first. */
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("The operation was aborted due to timeout")); }, { once: true });
});

/** A tool wired to stubs; `spent` records what the guard was asked for. The
 *  unpaid call may take `bareDelayMs` of real time (honouring its abort
 *  signal) and move the tool's clock on by `bareAdvanceMs`. */
function toolWith({ bare, pay, spendOk = true, bareDelayMs = 0, bareAdvanceMs = 0 } = {}) {
  const spent = { may: [], note: [], adjust: [], payOpts: [] };
  let clock = 1_757_000_000_000;
  const tool = buildSellerPayabilityTool({
    pay: pay || (async (u, o) => { spent.payOpts.push(o); return { result: { ok: true }, quote: { usd: 0.01, atomic: "10000" }, receipt: { network: "eip155:8453", payer: "0xpayer", transaction: "0xtx", success: true } }; }),
    fetchImpl: async (u, init) => {
      if (bareDelayMs) await delay(bareDelayMs, init?.signal);
      clock += bareAdvanceMs;
      return wrap(bare || res402([accept()]));
    },
    assertPublicUrl: async () => {},
    maySpend: (p, usd, o) => { spent.may.push({ usd, chain: o?.chain, payer: p }); return spendOk ? { ok: true } : { ok: false, code: "wallet_daily_ceiling" }; },
    noteSpend: (p, usd, o) => { spent.note.push({ usd, chain: o?.chain, payer: p }); return { handle: 1 }; },
    adjustSpend: (h, usd) => spent.adjust.push(usd),
    now: () => clock,
  });
  return { tool, spent };
}

// --- input handling --------------------------------------------------------
{
  ok(normalizeTarget("api.example.com/x") === "https://api.example.com/x", "a bare host is normalised to https");
  const throws = (fn, substr, msg) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(substr), `${msg} (got ${e ? String(e.message).slice(0, 70) : "no throw"})`); };
  throws(() => normalizeTarget("http://api.example.com"), "https", "http is refused: a seller settling real money should not be on http");
  throws(() => normalizeTarget("https://u:p@api.example.com"), "Credentials", "credentials in the URL are refused");
  throws(() => normalizeTarget(""), '"url" is required', "an empty url is refused by name");
  const { tool } = toolWith();
  const rejects = async (input, substr, msg) => { let e = null; try { await tool.handler(input, {}); } catch (x) { e = x; } ok(e && String(e.message).includes(substr), `${msg} (got ${e ? String(e.message).slice(0, 70) : "no throw"})`); return e; };
  await rejects({ url: "https://s.example", method: "DELETE" }, "GET or POST", "a mutating verb is refused: a check never sends one");
  await rejects({ url: "https://s.example", body: "nope" }, '"body" must be', "a non-object body is refused");
  await rejects({ url: "https://s.example", maxUsd: 0 }, "positive", "maxUsd must be positive");
  const over = await rejects({ url: "https://s.example", maxUsd: 1 }, `capped at $${MAX_SPEND_USD}`, "maxUsd above the hard ceiling is refused, naming the ceiling");
  ok(over?.statusCode === 400, "and it is a 400 the caller can act on");
}

// --- the money bound -------------------------------------------------------
{
  const price = Number("0.10");
  ok(MAX_SPEND_USD <= price * 0.7, `the hard spend ceiling is inside the margin rule on the $${price} price`);
  const { tool, spent } = toolWith();
  await tool.handler({ url: "https://s.example" }, {});
  ok(spent.may[0]?.chain === "base" && spent.may[0].usd === 0.01, "every check asks the Base wallet's daily ceiling BEFORE any call, for the cap");
  ok(spent.note[0]?.usd === 0.01, "and books the cap against that ceiling up front");
  ok(spent.adjust[0] === 0.01, "then corrects the booking down to what payX402 actually SIGNED (out.quote.usd)");
  const blocked = toolWith({ spendOk: false });
  let e = null; try { await blocked.tool.handler({ url: "https://s.example" }, {}); } catch (x) { e = x; }
  ok(e?.statusCode === 429 && /daily ceiling/.test(e.message), "a wallet at its daily ceiling refuses 429 before spending, and says so");
  ok(blocked.spent.note.length === 0, "and books nothing");
}

// --- a healthy seller ------------------------------------------------------
{
  const { tool } = toolWith();
  const r = await tool.handler({ url: "https://s.example", body: { q: "hi" } }, {});
  ok(r.payable === true, "a seller that 402s, accepts the signed payment and settles reads payable:true");
  ok(r.unpaidCall.status === 402 && r.challenge.readable && r.challenge.priceUsd === 0.01, "the unpaid leg and the decoded quote are reported");
  ok(r.payment.attempted && r.payment.settled === true && r.payment.receipt.transaction === "0xtx", "the settle receipt and transaction are carried through");
  ok(r.flags.length === 1 && /nothing to fix/.test(r.flags[0]), `a clean seller gets one flag saying so (got ${JSON.stringify(r.flags)})`);
  ok(r.untrustedContent === true, "the seller's own text is marked untrusted");
  ok(typeof r.responseSlice === "string" && r.responseSlice.length <= 2000, "the response body is bounded");
}

// --- the wrong-domain seller: the case this product exists for -------------
{
  const { tool } = toolWith({ bare: res402([accept({ extra: { name: "USDC", version: "2" } })]) });
  const r = await tool.handler({ url: "https://s.example" }, {});
  const f = r.domainFindings[0];
  ok(f?.verdict === "wrong_domain" && f.advertisedName === "USDC" && f.expectedName === "USD Coin", "a Base accept naming \"USDC\" is reported wrong_domain with both names");
  ok(r.flags.some((x) => /extra\.name/.test(x) && /USD Coin/.test(x)), "and the flag tells the seller which field to change");
  const clean = toolWith();
  const rc = await clean.tool.handler({ url: "https://s.example" }, {});
  ok(rc.domainFindings[0]?.verdict === "matches" && !rc.flags.some((x) => /extra\.name/.test(x)), "a correct accept reports matches and raises no domain flag");
  ok(domainFindings([{ network: "eip155:1", asset: BASE_USDC, domainName: "USDC" }]).length === 0, "a chain we hold no truth for is silent, never guessed");
}

// --- the seller shapes that are NOT payable --------------------------------
{
  const notPaywalled = toolWith({ bare: plain(200, '{"data":1}') });
  const r200 = await notPaywalled.tool.handler({ url: "https://s.example" }, {});
  ok(r200.payable === false && r200.payment.attempted === false, "a 200 to an unpaid call is not payable and no payment is attempted");
  ok(r200.flags.some((f) => /not paywalled/.test(f)), "and the flag says the endpoint is not paywalled");
  ok(notPaywalled.spent.adjust[0] === 0, "nothing is spent, so the day's booking is RELEASED, not left holding the cap for the window");

  const wrongStatus = toolWith({ bare: plain(404) });
  const r404 = await wrongStatus.tool.handler({ url: "https://s.example" }, {});
  ok(r404.flags.some((f) => /404/.test(f) && /not 402/.test(f)), "a non-402 status is reported with what a buyer's client does next");

  const junk402 = toolWith({ bare: { status: 402, headers: new Map([["content-type", "text/html"]]), text: async () => "<html>pay me</html>" } });
  const rj = await junk402.tool.handler({ url: "https://s.example" }, {});
  ok(rj.challenge.readable === false && rj.payment.attempted === false && rj.flags.some((f) => /could not be parsed/.test(f)), "a 402 with no parseable accepts is reported and never paid");

  const refuses = toolWith({ pay: async () => { throw Object.assign(new Error("Seller refused the payment (HTTP 402); the credential expired unused, nothing charged"), { statusCode: 502, refused: true }); } });
  const rr = await refuses.tool.handler({ url: "https://s.example" }, {});
  ok(rr.payable === false && rr.payment.status === 402 && rr.payment.settled === false, "a seller that refuses our signed payment is reported as refused, not as our error");
  ok(rr.flags.some((f) => /stock client produces/.test(f)), "and the flag names the thing the seller has to fix");

  const overCap = toolWith({ bare: res402([accept({ amount: "500000" })]) });
  const ro = await overCap.tool.handler({ url: "https://s.example" }, {});
  ok(ro.payment.attempted === false && ro.flags[0].includes("above the $0.01 cap"), "a quote above the cap is reported, not paid");
  ok(overCap.spent.adjust[0] === 0, "and releases the booking, because an over-cap quote spends nothing");

  const unreachable = buildSellerPayabilityTool({
    pay: async () => { throw new Error("unused"); },
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    assertPublicUrl: async () => {}, maySpend: () => ({ ok: true }), noteSpend: () => ({}), adjustSpend: () => {},
  });
  const ru = await unreachable.handler({ url: "https://gone.example" }, {});
  ok(ru.unpaidCall.error && ru.payable === false && ru.payment.attempted === false, "an unreachable seller is reported with the error, never paid");

  const priv = buildSellerPayabilityTool({
    pay: async () => ({}), fetchImpl: async () => plain(200), assertPublicUrl: async () => { throw new Error("private"); },
    maySpend: () => ({ ok: true }), noteSpend: () => ({}), adjustSpend: () => {},
  });
  let e = null; try { await priv.handler({ url: "https://internal.example" }, {}); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && /private or blocked/.test(e.message), "a private target is refused before the spend guard is even asked (SSRF)");
}

// --- pure helpers ----------------------------------------------------------
{
  ok(readChallenge({ header: challengeHeader([accept()]) }).priceUsd === 0.01, "readChallenge prices a Base USDC accept");
  ok(readChallenge({ header: "not-base64", body: "nope" }).readable === false, "an unreadable challenge says so rather than throwing");
  const f = payabilityFlags({ bare: { status: 402 }, challenge: { readable: true, priceUsd: 0.01 }, domains: [], paid: { status: 200 }, settled: true });
  ok(f.length === 1 && /nothing to fix/.test(f[0]), "flags: a clean run says so and nothing else");
  const f2 = payabilityFlags({ bare: { status: 200 }, challenge: {}, domains: [], paid: null, settled: null });
  ok(f2.some((x) => /not paywalled/.test(x)) && !f2.some((x) => /nothing to fix/.test(x)), "flags: a 200 never reads as clean");
}
// --- the three money-safety guards, from the 2026-09-11 review --------------
//
// Each mutation these kill is INVISIBLE to every other assertion in this file:
// the tool still answers correctly, the seller is still diagnosed, the buyer
// still gets the same JSON. Only the accounting and the advertised rails move.
{
  // 1. THE DAY'S BOOKING FOLLOWS WHAT WE SIGNED, NEVER WHAT THE PROBE SAW.
  //    payX402 makes its OWN bare request and signs whatever THAT 402 names,
  //    and the seller writes both responses. Booking the probe's number let a
  //    seller quote $0.000001 to the probe and the full cap to the paying leg,
  //    so the wallet's daily ceiling never grew while the money left.
  const attack = toolWith({
    bare: res402([accept({ amount: "1" })]),                       // probe: $0.000001
    pay: async () => ({ result: { ok: true }, quote: { usd: 0.01, atomic: "10000" }, receipt: { success: true, transaction: "0xtx" } }),
  });
  await attack.tool.handler({ url: "https://s.example" }, {});
  ok(attack.spent.adjust[0] === 0.01,
    `a seller quoting cheap to the probe and dear to the paying leg is booked at the SIGNED $0.01, not the probed $0.000001 (got ${attack.spent.adjust[0]})`);

  // 2. THE BUYER IS KEYED IN. A null payer takes the guard's "not
  //    attributable" branch, so the per-payer ceiling is skipped and the spend
  //    carries no operator attribution. Scope, stated honestly: the settle
  //    breaker (3 per 15 min, pre-handler) and the $25/day chain ceiling were
  //    already the real bounds; the per-payer ceiling is $6 against a $0.02
  //    cap and would not refuse until call 301. This is consistency with
  //    route-execute and defence in depth, not a closed exploit.
  const keyed = toolWith();
  await keyed.tool.handler({ url: "https://s.example" }, { ip: "203.0.113.9" });
  ok(keyed.spent.may[0]?.payer === "ip:203.0.113.9" && keyed.spent.note[0]?.payer === "ip:203.0.113.9",
    `the spend is keyed to the buyer so the per-payer ceiling applies (got ${keyed.spent.may[0]?.payer})`);
  const tempo = toolWith();
  await tempo.tool.handler({ url: "https://s.example" }, { mppTempoSender: "0xabc", mppTempoPayer: "0xhint", ip: "203.0.113.9" });
  ok(tempo.spent.note[0]?.payer === "tempo:0xabc", "a Tempo buyer is keyed by the sender recovered from its transaction, not by the IP (the gate strips the x402 header)");
  const hintOnly = toolWith();
  await hintOnly.tool.handler({ url: "https://s.example" }, { mppTempoPayer: "0xhint", ip: "203.0.113.9" });
  ok(hintOnly.spent.note[0]?.payer === "ip:203.0.113.9", "the client-supplied source hint alone is never the key: the IP is");
  const req = {};
  const handled = toolWith();
  await handled.tool.handler({ url: "https://s.example" }, req);
  ok(req.__externalSpend, "the handle rides on the request so server.js resolves it after settlement");

  // 3. THE REFUSAL WAIT CANNOT OUTLIVE THE REQUEST. Unbounded it defaults to
  //    90 s, which with the probe and paid legs put the worst case past any
  //    short-lived rail's validity window - and settlement runs AFTER us.
  const bounded = toolWith();
  await bounded.tool.handler({ url: "https://s.example" }, {});
  const rw = bounded.spent.payOpts[0]?.refusalMaxWaitMs;
  ok(Number.isFinite(rw) && rw > 0 && rw <= 55_000, `the payer is handed the request's remaining deadline, never the 90 s default (got ${rw})`);

  // 4. THE CHECK RUNS INSIDE THE BUYER'S OWN AUTHORIZATION. Settlement runs
  //    after this handler, so a check that outlives the buyer's validBefore
  //    (less the facilitator's 6 s rule) paid a seller for a payment that can
  //    no longer settle. A short window gets a shorter check; too short a
  //    window pays nobody (504, uncharged); a stock window is unchanged.
  const NOW_S = 1_757_000_000;
  const evmReq = (validBefore) => ({ ip: "203.0.113.9", header: (n) => (String(n).toLowerCase() === "payment-signature" ? Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300 }, payload: { signature: "0x11", authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "100000", validAfter: "0", validBefore: String(validBefore), nonce: "0x01" } } })).toString("base64") : undefined) });
  const stockW = toolWith();
  await stockW.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 299));
  ok(stockW.spent.payOpts[0]?.timeoutMs === 45_000 && stockW.spent.payOpts[0]?.refusalMaxWaitMs === 55_000, `control: a stock 300 s authorization keeps the full check (timeout ${stockW.spent.payOpts[0]?.timeoutMs}, wait ${stockW.spent.payOpts[0]?.refusalMaxWaitMs})`);
  const noHdr = toolWith();
  await noHdr.tool.handler({ url: "https://s.example" }, {});
  ok(noHdr.spent.payOpts[0]?.timeoutMs === 45_000 && noHdr.spent.payOpts[0]?.refusalMaxWaitMs === 55_000, "control: a request with no EVM authorization keeps the full check");
  const shortW = toolWith();
  const rShort = await shortW.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 30));
  ok(rShort.payable === true && shortW.spent.payOpts[0]?.timeoutMs === 20_000 && shortW.spent.payOpts[0]?.refusalMaxWaitMs === 20_000, `a 30 s authorization: the paid leg and its wait end inside it, and a fast seller is still checked in full (timeout ${shortW.spent.payOpts[0]?.timeoutMs}, wait ${shortW.spent.payOpts[0]?.refusalMaxWaitMs})`);
  const cut = toolWith({ pay: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { statusCode: 504 }); } });
  const rCut = await cut.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 30));
  ok(rCut.flags.some((f) => /remaining life/.test(f) && /300 s/.test(f)), "a paid leg that fails inside a shortened check says the buyer's window shortened it");
  const rCutStock = await toolWith({ pay: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { statusCode: 504 }); } }).tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 299));
  ok(!rCutStock.flags.some((f) => /remaining life/.test(f)), "control: the same failure under a stock window carries no such flag");
  const tiny = toolWith();
  let eTiny = null; try { await tiny.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 8)); } catch (x) { eTiny = x; }
  ok(eTiny?.statusCode === 504 && /Nothing was spent/.test(eTiny.message) && tiny.spent.payOpts.length === 0 && tiny.spent.adjust.at(-1) === 0, `an 8 s authorization: no seller is paid, the day's booking is given back, 504 uncharged (${eTiny?.statusCode})`);
  // Only the PAID leg is bounded by the buyer's authorization. The unpaid
  // call spends nothing, so it keeps its own timeout: a seller that takes 3 s
  // to answer it under a 16 s window is checked in full, and the paid leg
  // still ends inside the window and must be signed by its sign-by moment.
  const slowProbe = toolWith({ bareDelayMs: 3_000 });
  const rSlow = await slowProbe.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 16));
  ok(rSlow.unpaidCall.status === 402 && !rSlow.unpaidCall.error && rSlow.payable === true && slowProbe.spent.payOpts[0]?.timeoutMs === 6_000 && slowProbe.spent.payOpts[0]?.signBy === (NOW_S + 16 - 6) * 1000 - 8_000, `a 16 s authorization and a seller that answers the unpaid call in 3 s: checked in full, the paid leg bounded by the window (unpaid ${rSlow.unpaidCall.status ?? rSlow.unpaidCall.error}, payable ${rSlow.payable}, paid timeout ${slowProbe.spent.payOpts[0]?.timeoutMs}, signBy ${slowProbe.spent.payOpts[0]?.signBy})`);
  // Control: an unpaid call that uses up the window still pays nobody.
  const spentProbe = toolWith({ bareAdvanceMs: 5_000 });
  let eSpent = null; try { await spentProbe.tool.handler({ url: "https://s.example" }, evmReq(NOW_S + 12)); } catch (x) { eSpent = x; }
  ok(eSpent?.statusCode === 504 && spentProbe.spent.payOpts.length === 0 && spentProbe.spent.adjust.at(-1) === 0, `control: a 12 s authorization whose unpaid call took 5 s pays no seller, 504 uncharged, booking given back (${eSpent?.statusCode})`);

  ok(LONG_RUNNING_SLUGS.has("seller-payability"),
    "and the slug is long-running, so the paywall offers EVM exact only - the short-lived rails cannot settle a 55 s handler that already paid a seller");
  ok(requiredSecondsFor("seller-payability") >= 55,
    `the AVM guard demands a window that outlives the handler, so a HAND-BUILT Algorand payment is refused before the spend, not after (got ${requiredSecondsFor("seller-payability")}s)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
