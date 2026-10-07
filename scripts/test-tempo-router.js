// SOR external leg for MPP sellers on Tempo (src/tempo-sellers.js +
// src/tempo-buyer.js + route-execute chain mapping), offline.
//
//   catalog   the verified MPP index -> routable resources: tempo/charge in
//             USDC.e only, static integer prices only, no path templates,
//             unverified sellers dropped, cap-filtered lexical ranking
//   buyer     payTempo against a STUB MPP seller: reads the live 402, pins the
//             asset (USDC.e) and chain, re-checks the cap against the LIVE
//             quote (registry price is a hint), enforces the proven-seller
//             gate (fail closed on RPC error), signs via an injected credential
//             factory, retries with Authorization: Payment, relays the body and
//             the Payment-Receipt reference; refuses before signing on every
//             guard, so no credential is ever minted for a refused seller
//   router    buyerPaymentNetwork reads the tempo gate's marker; the chain map
//             puts MPP/tempo buyers on the Tempo wallet, keeps Base buyers on
//             Base unless SOR_TEMPO_FROM_BASE opts them into Tempo fallthrough
import { createServer } from "node:http";
import { tempoCatalog, rankTempoResources } from "../src/tempo-sellers.js";
import { payTempo, __testResetProofCache, tempoInboundCount, tempoInboundEvidence, tempoEvidenceFromLogs, primeTempoInboundCount, TEMPO_USDC, TEMPO_CAIP2 } from "../src/tempo-buyer.js";
import { sellerDeliveryFailingRecently, sellerDeliveryMemoEntries, __resetSellerDeliveryFailuresForTest, noteSellerDeliveryFailure } from "../src/x402-buyer.js";
import { buyerPaymentNetwork, externalChainsFor, EXTERNAL_CHAIN_BY_NETWORK, buildRouteExecuteTool, EXEC_TIERS } from "../src/tools/route-execute.js";
import { Challenge } from "mppx";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const PATH_USD = "0x20c0000000000000000000000000000000000000";

// ---- catalog + ranking ----
const snap = { sellers: [
  { verified: true, serviceUrl: "https://firecrawl.example", name: "Firecrawl", description: "web scraping and crawling", tags: ["scrape"], categories: ["web"],
    endpoints: [
      { method: "POST", path: "/v1/scrape", description: "Scrape a URL", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "2000" } },
      { method: "POST", path: "/v1/crawl", description: "Crawl a site", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "50000" } },
      { method: "POST", path: "/v1/dynamic", description: "Dynamic priced scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, dynamic: true, amountHint: "$0.01" } },
    ] },
  { verified: true, serviceUrl: "https://rpc.example", name: "RPCCo", description: "json-rpc", endpoints: [
      { method: "POST", path: "/:network/v2", description: "JSON-RPC call", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "100" } } ] },
  { verified: true, serviceUrl: "https://path.example", name: "PathCo", description: "scrape pages", endpoints: [
      { method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: PATH_USD, decimals: 6, amount: "1000" } } ] },
  { verified: true, serviceUrl: "https://stripe.example", name: "StripeCo", description: "scrape pages", endpoints: [
      { method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "stripe", currency: "usd", amount: "1000" } } ] },
  { verified: false, serviceUrl: "https://unverified.example", name: "Ghost", description: "scrape pages", endpoints: [
      { method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } } ] },
  { verified: true, serviceUrl: "http://insecure.example", name: "Plain", description: "scrape pages", endpoints: [
      { method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } } ] },
] };
const cat = tempoCatalog(snap);
ok(cat.length === 3, `catalog keeps routable endpoints incl. the dynamic-priced one (got ${cat.length}: ${cat.map((r) => r.url).join(", ")})`);
ok(cat.every((r) => r.origin === "https://firecrawl.example"), "dropped: path template, non-USDC.e currency, stripe method, unverified seller, non-https origin");
ok(cat[0].priceUsd === 0.002 && cat[0].networks[0] === TEMPO_CAIP2 && cat[0].wire === "mpp" && cat[0].dynamic === false, "resource carries priceUsd from base units, the Tempo CAIP-2, wire=mpp, dynamic=false");
const dyn = cat.find((r) => r.path === "/v1/dynamic");
ok(dyn && dyn.dynamic === true && dyn.priceUsd === null && dyn.priceAtomic === null, "a dynamic-priced endpoint is a candidate with NO up-front price (the resolver prices it from the live 402)");
const ranked = rankTempoResources(cat, "scrape a web page", { capUsd: 0.005 });
ok(ranked.length === 2 && ranked[0].path === "/v1/scrape" && ranked[1].path === "/v1/dynamic", `ranking matches the task, cap-filters fixed prices (crawl at $0.05 is out at $0.005) and ranks the dynamic seller AFTER the fixed-price peer (got ${ranked.map((r) => r.path).join(", ")})`);
ok(rankTempoResources(cat, "dynamic priced scrape", { capUsd: 0.005 })[0].path === "/v1/dynamic", "a dynamic seller still wins on a clearly better lexical match - the resolver's live-price check decides from there");
{
  const { liveTempoPriceUsd } = await import("../src/tempo-sellers.js");
  const parse = async () => [{ method: "evm", intent: "charge", currency: "0xusdc", amount: "5000" }, { method: "tempo", intent: "charge", currency: TEMPO_USDC.toLowerCase(), amount: "3000" }];
  ok(await liveTempoPriceUsd("Payment ...", { parse }) === 0.003, "live price: the tempo/charge USDC.e offer's base-units amount -> USD ($0.003)");
  ok(await liveTempoPriceUsd("x", { parse: async () => [{ method: "tempo", intent: "charge", currency: "0xother", amount: "3000" }] }) === null, "live price: a non-USDC.e tempo offer is not a price we can pay");
  ok(await liveTempoPriceUsd("x", { parse: async () => [{ method: "tempo", intent: "charge", currency: TEMPO_USDC.toLowerCase(), amount: "0.003" }] }) === null && await liveTempoPriceUsd("x", { parse: async () => [] }) === null, "live price: decimal/zero/missing amount -> null (resolver skips the candidate)");
}
ok(rankTempoResources(cat, "scrape", { capUsd: 0.005, excludeOrigin: "https://firecrawl.example" }).length === 0, "excludeOrigin (never route to ourselves) honoured");
ok(rankTempoResources(cat, "", { capUsd: 1 }).length === 0, "empty task ranks nothing");

// ---- up-front leaderboard gate (2026-08-18): with a fresh MPP leaderboard,
// only recipients the chain shows routable are candidates; without one, the
// ranker gates nothing and the pay-time gate alone decides. ----
{
  const R1 = "0x1111111111111111111111111111111111111111", R2 = "0x2222222222222222222222222222222222222222";
  const snap2 = { sellers: [
    { verified: true, serviceUrl: "https://a.example", name: "A", description: "scrape pages", offers: [{ method: "tempo", intent: "charge", recipient: R1, currency: TEMPO_USDC.toLowerCase(), chainId: 4217 }],
      endpoints: [{ method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } }] },
    { verified: true, serviceUrl: "https://b.example", name: "B", description: "scrape pages", offers: [{ method: "tempo", intent: "charge", recipient: R2, currency: TEMPO_USDC.toLowerCase(), chainId: 4217 }],
      endpoints: [{ method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } }] },
    { verified: true, serviceUrl: "https://c.example", name: "C", description: "scrape pages", offers: [],
      endpoints: [{ method: "GET", path: "/scrape", description: "scrape", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } }] },
  ] };
  const cat2 = tempoCatalog(snap2);
  ok(cat2.length === 3 && cat2.find((r) => r.origin === "https://a.example").recipient === R1 && cat2.find((r) => r.origin === "https://c.example").recipient === null, "catalog carries each resource's live tempo/charge recipient (null when the probe captured no offer)");
  const noBoard = rankTempoResources(cat2, "scrape", { capUsd: 0.01 });
  ok(noBoard.length === 3 && noBoard.every((r) => r.settled === 0), "no leaderboard: nothing gated up front (pay-time gate still applies), settled 0");
  const board = new Map([[R1, { transfers: 5, routable: false }], [R2, { transfers: 4000, routable: true }]]);
  const gated = rankTempoResources(cat2, "scrape", { capUsd: 0.01, provenByRecipient: board });
  ok(gated.length === 1 && gated[0].origin === "https://b.example" && gated[0].settled === 4000, "fresh leaderboard: only routable recipients survive (A below floor dropped, C unknown-recipient dropped), settled attached");
  const board2 = new Map([[R1, { transfers: 100, routable: true }], [R2, { transfers: 4000, routable: true }]]);
  const tie = rankTempoResources(cat2, "scrape", { capUsd: 0.01, provenByRecipient: board2 });
  ok(tie.length === 2 && tie[0].origin === "https://b.example", "equal lexical score breaks on settled desc (the more-paid seller first)");
}

// ---- stub MPP seller ----
const RECIPIENT = "0x1111111111111111111111111111111111111111";
let sellerMode = "ok"; let paidHits = 0; let lastAuth = null;
const challengeHeader = ({ currency = TEMPO_USDC, amount = "2000", chainId = 4217, supportedModes } = {}) => Challenge.serialize(Challenge.from({
  realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
  request: { amount, currency, recipient: RECIPIENT, methodDetails: { chainId, feePayer: true, ...(supportedModes ? { supportedModes } : {}) } }, secretKey: "seller-secret",
}));
const seller = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const auth = req.headers.authorization;
    if (auth && /^Payment /.test(auth)) {
      paidHits++; lastAuth = auth;
      if (sellerMode === "reject-paid") { res.writeHead(402, { "www-authenticate": challengeHeader() }); return res.end("{}"); }
      const rcpt = Buffer.from(JSON.stringify({ method: "tempo", status: "success", reference: "0xbeef", timestamp: new Date().toISOString() })).toString("base64url");
      if (sellerMode === "fail-500") { res.writeHead(500, { "content-type": "text/plain" }); return res.end("boom"); }
      if (sellerMode === "fail-400") { res.writeHead(400, { "content-type": "application/json" }); return res.end("{}"); }
      // A paid 200 whose body breaks off mid-read.
      if (sellerMode === "broken-body") { res.writeHead(200, { "content-type": "application/json", "content-length": "5000" }); res.write('{"partial":'); return setTimeout(() => res.destroy(), 20); }
      // Charge-first, the stock mppx shape: the receipt rides on every status.
      const charged = /^fail-(\d{3})-receipt$/.exec(sellerMode);
      if (charged) { res.writeHead(Number(charged[1]), { "content-type": "application/json", "payment-receipt": rcpt }); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json", "payment-receipt": Buffer.from(JSON.stringify({ method: "tempo", status: "success", reference: "0xfeed", timestamp: new Date().toISOString() })).toString("base64url") });
      return res.end(JSON.stringify({ scraped: true, echo: body ? JSON.parse(body) : null }));
    }
    const opts = sellerMode === "pathusd" ? { currency: PATH_USD } : sellerMode === "expensive" ? { amount: "900000" } : sellerMode === "wrong-chain" ? { chainId: 42431 }
      : sellerMode === "push-only" ? { supportedModes: ["push"] } : sellerMode === "pull-push" ? { supportedModes: ["pull", "push"] } : {};
    res.writeHead(402, { "www-authenticate": challengeHeader(opts) });
    res.end("{}");
  });
});
await new Promise((r) => seller.listen(0, r));
const URL_ = `http://127.0.0.1:${seller.address().port}/v1/scrape`;
let minted = 0;
const mint = async (res402) => { minted++; const www = res402.headers.get("WWW-Authenticate"); ok(/method="tempo"/.test(www), "credential factory receives the seller's tempo challenge"); return "Payment ZmFrZQ"; };
const proofOk = async () => 4000;
const proofLow = async () => 3;
const proofDown = async () => { throw new Error("rpc down"); };
const cap = BigInt(5000); // $0.005

// happy path
const r1 = await payTempo(URL_, { method: "POST", body: { url: "https://x" }, maxAtomic: cap, trusted: true, createCredential: mint, proof: proofOk });
ok(r1.result?.scraped === true && r1.result.echo?.url === "https://x", "paid retry relayed the seller's JSON body (request body forwarded)");
ok(r1.quote.usd === 0.002 && r1.quote.network === TEMPO_CAIP2, "quote reflects the LIVE 402 amount in USD on Tempo");
ok(r1.receipt.transaction === "0xfeed" && r1.receipt.wire === "mpp", "receipt carries the Payment-Receipt reference and wire=mpp");
ok(lastAuth === "Payment ZmFrZQ" && paidHits === 1 && minted === 1, "exactly one credential minted and sent as Authorization: Payment");

// guards - each must refuse BEFORE minting
const refuse = async (mode, opts, re, label) => {
  sellerMode = mode; const before = minted; let err = null;
  try { await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, ...opts }); } catch (e) { err = e; }
  ok(err && re.test(err.message), `${label} -> refused (${err?.statusCode}: ${String(err?.message).slice(0, 70)})`);
  ok(minted === before, `${label} -> no credential minted`);
};
await refuse("pathusd", { proof: proofOk }, /pays only USDC\.e/, "seller quotes PathUSD (asset pin)");
await refuse("expensive", { proof: proofOk }, /exceeds this call's ceiling/, "live quote above the cap (registry price was a hint)");
await refuse("wrong-chain", { proof: proofOk }, /not Tempo mainnet/, "challenge targets another chain");
await refuse("ok", { proof: proofLow }, /not routable yet/, "seller below the proven-settlement floor");
await refuse("ok", { proof: proofDown }, /refusing to spend/, "proof RPC down (fail closed)");
sellerMode = "reject-paid";
let rej = null; try { await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: proofOk }); } catch (e) { rej = e; }
ok(rej && /rejected the paid retry/.test(rej.message) && rej.statusCode === 502, "seller 402 after payment -> 502 (buyer's settlement cancels; our exposure is bounded by cap)");

// ---- one deadline for the whole purchase ----
{
  // A settlement-history read that never answers is cut at the deadline.
  sellerMode = "ok";
  const before = minted;
  const t0 = Date.now();
  const hang = new Promise(() => {});
  const guard = new Promise((r) => setTimeout(() => r("test guard fired"), 8000));
  const out = await Promise.race([payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: () => hang, timeoutMs: 4000 }).then(() => "paid", (e) => e), guard]);
  ok(out instanceof Error && out.statusCode === 503 && /deadline/.test(out.message) && minted === before && Date.now() - t0 < 6000, `a hanging settlement-history read ends at the deadline, nothing minted (${out instanceof Error ? out.statusCode : out})`);
  // Too little time left after the read: refused before minting.
  const slow = async () => { await new Promise((r) => setTimeout(r, 1500)); return 4000; };
  let e = null; try { await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: slow, timeoutMs: 4000 }); } catch (x) { e = x; }
  ok(e && e.statusCode === 504 && minted === before && e.committed !== true, `under 3 s left before minting -> 504, nothing signed (${e?.statusCode}: ${String(e?.message).slice(0, 60)})`);
  // Signing that uses up the budget: the credential is not sent.
  const slowMint = async (resp) => { await new Promise((r) => setTimeout(r, 1500)); return mint(resp); };
  let late = null; try { await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: slowMint, proof: proofOk, timeoutMs: 4000 }); } catch (x) { late = x; }
  ok(late && late.statusCode === 504 && /not sent/.test(late.message) && late.committed !== true, `under 3 s left after signing -> 504, the payment is not sent (${late?.statusCode}: ${String(late?.message).slice(0, 60)})`);
  const mintedBeforeControl = minted;
  const r = await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: proofOk, timeoutMs: 4000 });
  ok(r.result?.scraped === true && minted === mintedBeforeControl + 1, "CONTROL: a quick purchase inside the same budget pays as before");
}

// ---- pull mode only: a push-only seller is refused before any broadcast ----
{
  const savedKey = process.env.TEMPO_UPSTREAM_BUYER_KEY;
  process.env.TEMPO_UPSTREAM_BUYER_KEY = "0x" + "42".repeat(32);
  const realFetch = globalThis.fetch;
  const outside = [];
  globalThis.fetch = async (u, init) => {
    const href = String(u?.url || u);
    if (!href.startsWith("http://127.0.0.1")) { outside.push(href); throw new Error("offline test: no chain RPC"); }
    return realFetch(u, init);
  };
  try {
    for (const [mode, label] of [["push-only", "push-only"], ["pull-push", "pull or push"]]) {
      sellerMode = mode; outside.length = 0;
      const hitsBefore = paidHits;
      let e = null; try { await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, proof: proofOk }); } catch (x) { e = x; }
      ok(e && e.committed !== true && paidHits === hitsBefore, `${label} challenge with the real credential factory: no paid request sent (${e?.statusCode}: ${String(e?.message).slice(0, 80)})`);
      if (mode === "push-only") ok(e?.statusCode === 409 && /push-mode/.test(e.message) && outside.length === 0, `push-only seller refused 409 before any chain call (chain calls: ${outside.length})`);
      else ok(e?.statusCode === 502 && /nothing was sent/.test(e.message) && outside.length > 0, "CONTROL: a pull-capable challenge reaches the pull credential's own preparation");
    }
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TEMPO_UPSTREAM_BUYER_KEY; else process.env.TEMPO_UPSTREAM_BUYER_KEY = savedKey;
  }
}

// ---- a paid 200 whose body cannot be read is relayed, never a 502 ----
{
  sellerMode = "broken-body";
  let e = null, r = null;
  try { r = await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: proofOk }); } catch (x) { e = x; }
  ok(!e && r && r.result?.relayError === "upstream body unreadable" && r.quote?.usd === 0.002, `paid 200 with a broken body -> relayed with relayError (${e ? `threw ${e.statusCode}` : JSON.stringify(r?.result)})`);
  sellerMode = "ok";
}

// ---- the distinct-payer floor at pay time (2026-09-28) ----
// The count alone was cheap to reach from wallets the seller holds. A proof
// naming payers is held to the Base floor's rule; a bare count is judged as before.
sellerMode = "ok";
await refuse("ok", { proof: async () => ({ count: 4000, payers: 2 }) }, /distinct recent payers on Tempo \(floor 3\)/, "4,000 transfers from TWO payers is below the payer floor");
{
  const before = minted;
  const r = await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: async () => ({ count: 4000, payers: 3 }) });
  ok(r.result?.scraped === true && minted === before + 1, "control: the same count from three payers is paid");
  const r2 = await payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: async () => ({ count: 4000, payers: undefined }) });
  ok(r2.result?.scraped === true, "control: a proof with no payer figure (an older primed count) is judged on the count, as before");
}
{
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const tp = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const OURS = "0x" + "0e".repeat(20);
  const P = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "a3".repeat(20)];
  const logs = [
    ...Array.from({ length: 10 }, () => ({ topics: [T, tp(RECIPIENT), tp(RECIPIENT)] })),   // itself
    ...Array.from({ length: 10 }, () => ({ topics: [T, tp(OURS), tp(RECIPIENT)] })),        // our spending wallet
    ...Array.from({ length: 6 }, (_, i) => ({ topics: [T, tp(P[i % 3]), tp(RECIPIENT)] })), // three outside payers
    {},                                                                                      // no readable sender
  ];
  const ev = tempoEvidenceFromLogs(RECIPIENT, logs, new Set([OURS]));
  ok(ev.count === 7 && ev.payers === 3, `a recipient's own transfers and ours are not evidence; an unreadable sender counts and names no payer (got ${ev.count}/${ev.payers})`);
  __testResetProofCache();
  const rpcFn = async (m) => (m === "eth_blockNumber" ? "0x" + (200000).toString(16) : logs);
  const ev2 = await tempoInboundEvidence(RECIPIENT, { rpcFn, ourWallets: new Set([OURS]) });
  ok(ev2.count === 7 && ev2.payers === 3, "the chain read applies the same exclusions and caches both figures");
  __testResetProofCache();
  primeTempoInboundCount(RECIPIENT, 50, Date.now(), 2);
  ok((await tempoInboundEvidence(RECIPIENT, { rpcFn: async () => { throw new Error("must not be called"); } })).payers === 2, "a primed read carries its payer figure to the pay-time gate");
  __testResetProofCache();
}

// ---- the delivery memo on the Tempo rail (2026-09-28) ----
// payTempo wrote nothing when a seller took the credential and failed, so the
// resolver kept sending buyers there. Same rules as payX402: opt-in, two
// strikes, a settled delivery clears it.
{
  const ORIGIN = new URL(URL_).origin;
  const buy = (mode, memoizeDelivery = true) => { sellerMode = mode; return payTempo(URL_, { method: "POST", body: {}, maxAtomic: cap, trusted: true, createCredential: mint, proof: proofOk, memoizeDelivery }).then((r) => r, (e) => e); };
  __resetSellerDeliveryFailuresForTest();
  const e1 = await buy("fail-500");
  ok(e1 instanceof Error && e1.committed === true, "control: a 500 after the credential went out is still a committed 502");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo") === null, "one strike changes no routing decision");
  await buy("fail-500");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo")?.strikes === 2, "a second 5xx with no receipt makes the Tempo seller actionable for the resolver");
  await buy("ok");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo") === null, "a 200 carrying a Payment-Receipt reference clears it");
  __resetSellerDeliveryFailuresForTest();
  await buy("fail-404-receipt"); await buy("fail-404-receipt");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo")?.status === 404, "a charged 4xx no buyer input selects (404 on the indexed route) is a delivery failure");
  __resetSellerDeliveryFailuresForTest();
  await buy("fail-500-receipt"); await buy("fail-500-receipt");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo")?.strikes === 2, "control: a charged 5xx still strikes");
  await buy("ok");
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo") === null, "control: a settled 200 clears it");
  // THE ATTACK (2026-09-28 review): a charge-first seller answers a malformed
  // body 400 with its receipt attached, and route-execute forwards the
  // caller's params as that body. Two bad bodies must not bench it.
  for (const st of [400, 413, 415, 422]) {
    __resetSellerDeliveryFailuresForTest();
    const e = await buy(`fail-${st}-receipt`); await buy(`fail-${st}-receipt`);
    ok(e instanceof Error && e.committed === true, `control: a charged ${st} is still a committed 502 (the money left)`);
    ok(sellerDeliveryMemoEntries().length === 0, `two malformed bodies answered ${st} with a receipt do NOT bench the seller (the buyer controls that input)`);
  }
  __resetSellerDeliveryFailuresForTest();
  __resetSellerDeliveryFailuresForTest();
  await buy("fail-400"); await buy("fail-400"); await buy("reject-paid"); await buy("reject-paid");
  ok(sellerDeliveryMemoEntries().length === 0, "control: a 4xx or 402 with no receipt is the seller answering the request, and records nothing");
  await buy("fail-500", false); await buy("fail-500", false);
  ok(sellerDeliveryMemoEntries().length === 0, "a caller that does not opt in writes nothing (the default is false)");
  noteSellerDeliveryFailure(ORIGIN, "tempo", { status: 500 }); noteSellerDeliveryFailure(ORIGIN, "tempo", { status: 500 });
  await buy("ok", false);
  ok(sellerDeliveryFailingRecently(ORIGIN, "tempo"), "...and cannot clear the memo either");
  __resetSellerDeliveryFailuresForTest();
  sellerMode = "ok";
}
seller.close();

// ---- proof cache + count parsing (injected rpc) ----
__testResetProofCache();
let rpcCalls = 0;
const fakeRpc = async (m) => { rpcCalls++; if (m === "eth_blockNumber") return "0x" + (200000).toString(16); return new Array(57).fill({}); };
ok(await tempoInboundCount(RECIPIENT, { rpcFn: fakeRpc }) === 57 && await tempoInboundCount(RECIPIENT, { rpcFn: fakeRpc }) === 57 && rpcCalls === 2, "inbound count reads eth_getLogs once and caches per recipient");

// ---- router chain mapping ----
ok(EXTERNAL_CHAIN_BY_NETWORK["eip155:4217"] === "tempo", "eip155:4217 maps to the tempo spending wallet");
ok(buyerPaymentNetwork({ mppTempoCredential: true, headers: {} }) === "eip155:4217", "a request the tempo gate marked reads as paid on Tempo");
ok(buyerPaymentNetwork({ headers: {} }) === null, "no payment -> null (unchanged)");
const supported = ["base", "algorand", "tempo"];
ok(JSON.stringify(externalChainsFor("eip155:4217", supported)) === '["tempo"]', "tempo buyer -> tempo sellers only (chain-matched)");
ok(JSON.stringify(externalChainsFor("eip155:8453", supported, { tempoFromBase: false })) === '["base"]', "base buyer -> base only by default");
ok(JSON.stringify(externalChainsFor("eip155:8453", supported, { tempoFromBase: true })) === '["base","tempo"]', "SOR_TEMPO_FROM_BASE=true -> base first, then MPP/tempo fallthrough");
ok(JSON.stringify(externalChainsFor("eip155:4217", ["base"])) === "[]", "tempo buyer with no Tempo wallet configured -> no chain (409 upstream)");
ok(JSON.stringify(externalChainsFor("eip155:137", supported)) === "[]", "unsupported inbound chain -> none");


// ---- Tempo time budget on the external leg ----
// A Tempo buyer's credential expires ~25s after the client signs it and we
// settle AFTER the handler; an external buy that outlives the window is a
// paid seller and a refused settle (measured live 2026-08-27: a 69s external
// scrape was paid, buyer 402). The leg runs under a budget on Tempo.
{
  const tempoReq = () => ({ mppTempoCredential: true, headers: {}, header: () => undefined, ip: "127.0.0.1" });
  const seller = { seller: "https://firecrawl.example", slug: "v1/scrape", url: "https://firecrawl.example/v1/scrape", method: "POST", price: "$0.002", priceUsd: 0.002, networks: [TEMPO_CAIP2], wire: "mpp" };
  let payOpts = null;
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => seller,
    payExternal: async (_url, opts) => { payOpts = opts; return { result: { ok: 1 }, quote: { usd: 0.002 }, receipt: { transaction: "0x" + "ab".repeat(32) } }; },
    externalEnabled: () => true, externalChains: () => ["base", "tempo"],
  });
  const r = await tool.handler({ task: "scrape a url", include: "external", params: { url: "https://example.com" } }, tempoReq());
  ok(r.receipt.wire === "mpp" && r.receipt.settleNetwork === TEMPO_CAIP2, "tempo buyer -> receipt says wire mpp on eip155:4217");
  ok(Number.isFinite(payOpts?.timeoutMs) && payOpts.timeoutMs <= 16000 && payOpts.timeoutMs >= 3000, `the seller call carries the remaining Tempo budget as its timeout (got ${payOpts?.timeoutMs})`);
  // Resolution that eats the budget refuses BEFORE any spend (504, nothing paid).
  const prev = process.env.SOR_TEMPO_BUDGET_MS; process.env.SOR_TEMPO_BUDGET_MS = "120";
  let paid = false, threw = null;
  const slow = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => { await new Promise((res) => setTimeout(res, 150)); return seller; },
    payExternal: async () => { paid = true; return { result: { ok: 1 } }; },
    externalEnabled: () => true, externalChains: () => ["base", "tempo"],
  });
  try { await slow.handler({ task: "scrape a url", include: "external" }, tempoReq()); } catch (e) { threw = e; }
  process.env.SOR_TEMPO_BUDGET_MS = prev ?? "";
  if (prev == null) delete process.env.SOR_TEMPO_BUDGET_MS;
  ok(threw?.statusCode === 504 && /time budget/.test(threw.message) && paid === false, "resolution past the Tempo budget -> 504 before any spend");
  // A Base buyer gets no budget (x402 credentials carry their own validity and settle server-side).
  payOpts = null;
  const baseReq = { headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: {} })).toString("base64") }, header: (n) => (n.toLowerCase() === "payment-signature" ? baseReq.headers["payment-signature"] : undefined), ip: "127.0.0.1" };
  const baseTool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => ({ ...seller, networks: ["eip155:8453"], wire: "x402" }),
    payExternal: async (_url, opts) => { payOpts = opts; return { result: { ok: 1 }, quote: { usd: 0.002 }, receipt: { transaction: "0x" + "cd".repeat(32) } }; },
    externalEnabled: () => true, externalChains: () => ["base", "tempo"],
  });
  await baseTool.handler({ task: "scrape a url", include: "external" }, baseReq);
  ok(payOpts && !("timeoutMs" in payOpts), "a Base buyer's external call carries no Tempo budget");
}

// ---- External spend ceiling is keyed for Tempo buyers ----
// The tempo gate strips the x402 payment headers on acceptance, so
// payerFromRequest() is null for an MPP/Tempo buyer and the per-payer
// unsettled-spend ceiling (external-spend-guard) saw "payer not attributable"
// = always allowed. Keyed on the credential's payer now, like the composite
// guard; a request with no payer at all falls back to the client IP.
{
  const { __reset, noteSpend, payerExposureUsd, __config } = await import("../src/external-spend-guard.js");
  __reset();
  const tempoReq = () => ({ mppTempoCredential: true, mppTempoSender: "0xTempoBuyer", mppTempoPayer: "0xSpoofedHint", headers: {}, header: () => undefined, ip: "203.0.113.9" });
  const seller = { seller: "https://firecrawl.example", slug: "v1/scrape", url: "https://firecrawl.example/v1/scrape", method: "POST", price: "$0.002", priceUsd: 0.002, networks: [TEMPO_CAIP2], wire: "mpp" };
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => seller,
    payExternal: async () => ({ result: { ok: 1 }, quote: { usd: 0.002 }, receipt: { transaction: "0x" + "ef".repeat(32) } }),
    externalEnabled: () => true, externalChains: () => ["base", "tempo"],
  });
  await tool.handler({ task: "scrape a url", include: "external" }, tempoReq());
  ok(payerExposureUsd("tempo:0xTempoBuyer") > 0 && payerExposureUsd("tempo:0xSpoofedHint") === 0, "a Tempo buyer's external spend is recorded under the sender recovered from its transaction, never the client-supplied source hint");
  noteSpend("tempo:0xTempoBuyer", __config.DEFAULT_MAX_UNSETTLED_USD);
  let threw = null, paid = false;
  const tool2 = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => seller,
    payExternal: async () => { paid = true; return { result: { ok: 1 } }; },
    externalEnabled: () => true, externalChains: () => ["base", "tempo"],
  });
  try { await tool2.handler({ task: "scrape a url", include: "external" }, tempoReq()); } catch (e) { threw = e; }
  ok(threw?.statusCode === 429 && /paused/.test(threw.message) && paid === false, "a Tempo buyer over the unsettled ceiling is refused before any spend (429)");
  __reset();
  const noPayer = { mppTempoCredential: true, mppTempoPayer: "0xOnlyAHint", headers: {}, header: () => undefined, ip: "203.0.113.9" };
  await tool.handler({ task: "scrape a url", include: "external" }, noPayer);
  ok(payerExposureUsd("ip:203.0.113.9") > 0, "with no readable payer the spend is keyed on the client IP (nobody is unkeyed)");
  __reset();
}

console.log(`\nAll ${pass} assertions passed`);
