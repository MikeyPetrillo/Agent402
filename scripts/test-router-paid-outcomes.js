#!/usr/bin/env node
// What a paid external purchase leaves behind when it does not deliver: the
// spend hold, the chain wallet's 24 h booking, the fallthrough to another
// seller, and the router's refusal memo. Offline: stub sellers (global fetch,
// or a local socket), a throwaway signing key, and an injected chain reader, so
// nothing is spent and no network is touched.
//
// Three rules, each with the honest path beside it as a control:
//
//   1. A paid request that got NO answer (a timeout, a reset) may have been
//      paid. It keeps its hold and its booking, and the router tries no other
//      seller for that request - unless no byte of it ever left us (a connect-
//      phase error), and the booking is lowered only when the chain shows the
//      credential expired unused.
//   2. A candidate that provably spent nothing (unreachable, a bad 402, over
//      the cap, a refusal the chain proved unpaid) leaves no booking on the
//      chain's day, and one that may have been paid books the amount it
//      signed rather than the tier's cap, so a run of failures cannot pause
//      routing for everyone.
//   3. The router's refusal memo is written only by the router's own purchase
//      turned away by the seller's payment layer (a 402/401 carrying the
//      seller's offer), per route, and it benches that route only on the
//      second strike - never by a check whose URL a caller chose, and never
//      for a 4xx or offer-less 402/401 the caller's own input produced.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "router-paid-outcomes-"));
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

const buyer = await import("../src/x402-buyer.js");
const guard = await import("../src/external-spend-guard.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const { buildSellerPayabilityTool } = await import("../src/tools/seller-payability-kit.js");
const { payTempo } = await import("../src/tempo-buyer.js");

const origFetch = globalThis.fetch;
const origWarn = console.warn; const origLog = console.log;
let pass = 0, fail = 0;
// The payer logs every refusal it meets; those lines are muted below, so the
// verdicts write through the saved console.
const ok = (c, m) => { if (c) { pass++; origLog(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const quiet = () => { console.warn = () => {}; console.log = () => {}; };
const loud = () => { console.warn = origWarn; console.log = origLog; };

// ---------------------------------------------------------------------------
// Stub sellers, keyed by host. Each decides its bare answer and its paid answer.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const accept = (amount = "1000") => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: "0x" + "5e".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const r402 = (amount) => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept(amount)] }), "content-type": "application/json" } });
const receipt = b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" });
const timeoutErr = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const netErr = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
const SELLERS = {
  // answers the bare call, then the paid request never comes back
  "hang.example": { paid: () => { throw timeoutErr(); } },
  // the connection carrying the paid request is reset mid-exchange
  "reset.example": { paid: () => { throw netErr("UND_ERR_SOCKET"); } },
  // the paid request's connection is refused: nothing left us
  "refused-conn.example": { paid: () => { throw netErr("ECONNREFUSED"); } },
  // takes the payment and delivers
  "good.example": { paid: () => new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } }) },
  // refuses the payment itself: the payment layer answers with its offer
  // again (the PAYMENT-REQUIRED header on v2, a WWW-Authenticate: Payment
  // challenge, or the accepts body on v1)
  "refuser.example": { paid: () => new Response(JSON.stringify({ error: "payment_verification_failed" }), { status: 402, headers: { "content-type": "application/json", "payment-required": b64({ x402Version: 2, error: "invalid_exact_evm_payload_signature", accepts: [accept()] }) } }) },
  "unauth.example": { paid: () => new Response("{}", { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Payment id="c1", realm="unauth.example", method="evm", intent="charge"' } }) },
  "refuser-v1.example": { paid: () => new Response(JSON.stringify({ x402Version: 1, error: "invalid_payment", accepts: [{ ...accept(), network: "base", maxAmountRequired: "1000" }] }), { status: 402, headers: { "content-type": "application/json" } }) },
  // the seller's own HANDLER answers 402/401 after the payment verified (it
  // relays the page it fetched, or wants a field the caller left out): no offer
  "handler402.example": { paid: () => new Response(JSON.stringify({ upstreamStatus: 402 }), { status: 402, headers: { "content-type": "application/json" } }) },
  "handler401.example": { paid: () => new Response(JSON.stringify({ error: "apiKey required" }), { status: 401, headers: { "content-type": "application/json" } }) },
  // refuses the payment with its offer, or delivers, as the test sets it
  "flaky.example": { paid: () => (flakyDelivers
    ? new Response(JSON.stringify({ answer: 7 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } })
    : new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": b64({ x402Version: 2, accepts: [accept()] }) } })) },
  // a seller that settles and relays an empty page (a 204) it fetched
  "empty.example": { paid: () => new Response(null, { status: 204, headers: { "payment-response": receipt } }) },
  // judges the REQUEST after verifying payment: the caller's input was wrong
  "picky.example": { paid: () => new Response(JSON.stringify({ error: "url is required" }), { status: 400, headers: { "content-type": "application/json" } }) },
  "picky422.example": { paid: () => new Response(JSON.stringify({ error: "invalid params" }), { status: 422, headers: { "content-type": "application/json" } }) },
  // fails after payment with no receipt
  "broken.example": { paid: () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }) },
  // takes the payment (its own receipt says so) and answers 403
  "charged403.example": { paid: () => new Response("{}", { status: 403, headers: { "content-type": "application/json", "payment-response": receipt } }) },
  // fail BEFORE anything is signed
  "bare500.example": { bare: () => new Response("down", { status: 500 }) },
  "notfound.example": { bare: () => new Response("nope", { status: 404 }) },
  "overcap.example": { bare: () => r402("9000000") },
  // wrong EIP-712 domain on the Base accept: unsignable, refused before signing
  "wrongdomain.example": { bare: () => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, accepts: [{ ...accept(), extra: { name: "USDC", version: "2" } }] }) } }) },
};
let flakyDelivers = false;
const hits = {};
const stubFetch = async (url, init = {}) => {
  const host = new URL(String(url)).host;
  const s = SELLERS[host];
  if (!s) throw netErr("ENOTFOUND");
  const h = init.headers || {};
  const paidReq = !!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"]);
  const k = `${host} ${paidReq ? "paid" : "bare"}`;
  hits[k] = (hits[k] || 0) + 1;
  if (paidReq) return s.paid();
  return s.bare ? s.bare() : r402();
};
const count = (host, leg) => hits[`${host} ${leg}`] || 0;

// Chain readers the payer consults after a refusal or an unanswered request.
const CHAIN = {
  unused: async () => ({ debited: false, observed: 1, expired: true }),
  consumed: async () => ({ debited: true, observed: 1 }),
  live: async () => ({ debited: false, observed: 1, expired: false }),
  unreadable: async () => { throw new Error("RPC 429"); },
};
let chainReader = CHAIN.consumed;
let chainAsked = null;
const notDebited = async (q) => { chainAsked = q; return chainReader(q); };
const buy = (host, opts = {}, path = "/x") => buyer.payX402(`https://${host}${path}`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited, ...opts }).then((r) => ({ r }), (e) => ({ e }));

globalThis.fetch = stubFetch;
quiet();

// ===========================================================================
// 1. A PAID REQUEST THAT GOT NO ANSWER
// ===========================================================================
{
  // Pure classifier: only errors that prove no byte left us are "never sent".
  const { neverLeftUs } = buyer;
  ok(typeof neverLeftUs === "function", "the payer exports its never-sent classifier");
  if (typeof neverLeftUs === "function") {
    ok(neverLeftUs(netErr("ECONNREFUSED")) && neverLeftUs(netErr("ENOTFOUND")) && neverLeftUs(netErr("UND_ERR_CONNECT_TIMEOUT")) && neverLeftUs(netErr("ESSRFBLOCKED")),
      "refused, unresolvable, connect-timeout and SSRF-blocked connections are never-sent");
    ok(!neverLeftUs(timeoutErr()) && !neverLeftUs(netErr("UND_ERR_SOCKET")) && !neverLeftUs(netErr("ECONNRESET")) && !neverLeftUs(new Error("boom")),
      "a timeout, a reset, a socket closed mid-exchange and an unknown error may have delivered the header");
    const agg = (codes) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError(codes.map((c) => Object.assign(new Error(c), { code: c }))), { code: codes[0] }) });
    ok(neverLeftUs(agg(["ECONNREFUSED", "ECONNREFUSED"])) && !neverLeftUs(agg(["ECONNREFUSED", "ECONNRESET"])), "an aggregate counts as never-sent only when every attempt was");
  }

  // RULE: the paid request times out. The seller may already hold our signed
  // authorization, so the attempt is committed and the hold stands.
  for (const [label, reader] of [["the chain shows the nonce consumed", CHAIN.consumed], ["the chain is unreadable", CHAIN.unreadable], ["the credential is still live", CHAIN.live]]) {
    chainReader = reader; chainAsked = null;
    const held = buyer._spentThisWindow();
    const { e } = await buy("hang.example");
    ok(e && e.committed === true && e.paidUnanswered === true, `timeout on the paid request, ${label} -> committed + paidUnanswered (got committed=${e?.committed}, paidUnanswered=${e?.paidUnanswered})`);
    ok(buyer._spentThisWindow() === held + 1000n, `timeout, ${label} -> the spend hold STANDS (held ${buyer._spentThisWindow() - held} of 1000)`);
    ok(e && e.statusCode === 502 && /may have settled/.test(e.message), `timeout, ${label} -> 502 saying the payment may have settled`);
    ok(e && e.signedUsd === 0.001, `timeout, ${label} -> the error carries the amount signed ($${e?.signedUsd}), the most that credential can move`);
    ok(e && !/other seller/.test(e.message), "the payer's own words are the same for any caller: what happens next is the caller's to say");
  }
  ok(chainAsked && /^0x[0-9a-f]{64}$/i.test(chainAsked.nonce || "") && Number.isFinite(chainAsked.untilUnix) && chainAsked.chain === "base",
    "the unanswered path asks the chain about the nonce we signed, until its expiry (the refusal path's own reader)");

  // The chain proves the credential expired unused: the hold is released,
  // the error says nothing was charged - and still carries paidUnanswered.
  chainReader = CHAIN.unused;
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("hang.example");
    ok(e && e.committed === false && e.paidUnanswered === true && buyer._spentThisWindow() === held, "timeout + the chain shows the credential expired unused -> hold released, uncommitted, still flagged unanswered");
    ok(e && /expired unused, nothing charged/.test(e.message), "and the error says nothing was charged");
  }
  // A reset mid-exchange is treated like a timeout.
  chainReader = CHAIN.consumed;
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("reset.example");
    ok(e && e.committed === true && e.paidUnanswered === true && buyer._spentThisWindow() === held + 1000n, "a socket reset on the paid request -> committed, hold stands");
  }
  // CONTROL: a connect-phase failure sent nothing - hold released, no stamp,
  // exactly as before.
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("refused-conn.example");
    ok(e && e.committed !== true && e.paidUnanswered !== true && buyer._spentThisWindow() === held, "CONTROL: a refused connection on the paid leg sent nothing -> no stamp, hold released");
  }
  // A paid leg that did not deliver is recorded in the outbound ledger for
  // every caller, not only the router (the memo stays the router's own).
  {
    const rows = () => (existsSync(process.env.OUTBOUND_LEDGER_FILE) ? readFileSync(process.env.OUTBOUND_LEDGER_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    for (const host of ["broken.example", "charged403.example"]) {
      const before = rows().filter((r) => r.origin === host && r.result === "undelivered").length;
      const { e } = await buy(host);
      const after = rows().filter((r) => r.origin === host && r.result === "undelivered").length;
      ok(e && after === before + 1, `${host} without the router's memo flag: the undelivered payment is still recorded (${before} -> ${after})`);
      ok(!buyer.sellerDeliveryMemoEntries().some((m) => String(m.origin || m.key || "").includes(host)), `${host} without the router's memo flag: no steering memo written`);
    }
  }
  // CONTROL: a delivered purchase is unchanged.
  {
    const { r, e } = await buy("good.example");
    ok(r && r.result?.answer === 42 && r.receipt?.transaction, `CONTROL: a delivered purchase returns the result and receipt${e ? ` (threw ${e.message})` : ""}`);
  }

  // A REAL SOCKET: the seller accepts the paid request and never answers.
  // undici's own timeout error must take the same path.
  loud(); globalThis.fetch = origFetch; quiet();
  const sockets = new Set();
  let paidSeen = 0;
  const srv = createServer((req, res) => {
    const paid = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!paid) {
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [accept()] }), "content-type": "application/json" });
      return res.end("{}");
    }
    paidSeen++; // read the request, never answer
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  chainReader = CHAIN.consumed;
  const held = buyer._spentThisWindow();
  let e = null;
  try { await buyer.payX402(`http://127.0.0.1:${srv.address().port}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", timeoutMs: 400, notDebited }); } catch (x) { e = x; }
  ok(paidSeen === 1, "real socket: the seller received the paid request");
  ok(e && e.committed === true && e.paidUnanswered === true && e.cause?.name === "TimeoutError", `real socket: undici's timeout is committed + paidUnanswered (cause ${e?.cause?.name})`);
  ok(buyer._spentThisWindow() === held + 1000n, "real socket: the hold stands");

  // The same rule on the payer's second transport: a seller edge whose framing
  // fetch() rejects is retried once over undici.request with the SAME payment
  // header, so an unanswered retry is committed too. fetch() is made to reject
  // the paid leg that way; the retry reaches the real socket and hangs.
  paidSeen = 0;
  globalThis.fetch = async (url, init = {}) => {
    const h = init.headers || {};
    if (h["PAYMENT-SIGNATURE"] || h["X-PAYMENT"]) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("invalid content-length header") });
    return origFetch(url, init);
  };
  const held2 = buyer._spentThisWindow();
  let e2 = null;
  try { await buyer.payX402(`http://127.0.0.1:${srv.address().port}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", timeoutMs: 400, notDebited }); } catch (x) { e2 = x; }
  ok(paidSeen === 1, "fallback transport: the retry reached the seller with the payment header");
  ok(e2 && e2.committed === true && e2.paidUnanswered === true && buyer._spentThisWindow() === held2 + 1000n, `fallback transport: an unanswered retry is committed and keeps the hold (committed=${e2?.committed})`);
  for (const s of sockets) s.destroy();
  srv.close();

  // The first attempt got response headers back, so the credential reached
  // the seller: a connect-phase error on the retry proves nothing, and the
  // leg stays committed.
  {
    const srv2 = createServer((req, res) => {
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [accept()] }), "content-type": "application/json" });
      res.end("{}");
    });
    const socks2 = new Set();
    srv2.on("connection", (s) => { socks2.add(s); s.on("close", () => socks2.delete(s)); });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    const port2 = srv2.address().port;
    globalThis.fetch = async (url, init = {}) => {
      const h = init.headers || {};
      if (h["PAYMENT-SIGNATURE"] || h["X-PAYMENT"]) {
        // The seller goes away between the two attempts: the retry is refused.
        for (const s of socks2) s.destroy();
        await new Promise((r) => srv2.close(r));
        throw Object.assign(new TypeError("fetch failed"), { cause: new Error("invalid content-length header") });
      }
      return origFetch(url, init);
    };
    chainReader = CHAIN.consumed;
    const held3 = buyer._spentThisWindow();
    let e3 = null;
    try { await buyer.payX402(`http://127.0.0.1:${port2}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", timeoutMs: 2000, notDebited }); } catch (x) { e3 = x; }
    ok(e3 && e3.cause && buyer.neverLeftUs(e3.cause), `fallback refused at connect: the retry's own error is connect-phase (${e3?.cause?.code || e3?.cause?.cause?.code || e3?.message})`);
    ok(e3 && e3.committed === true && e3.paidUnanswered === true && buyer._spentThisWindow() === held3 + 1000n, `fallback refused at connect after the first attempt saw headers: committed, hold stands (committed=${e3?.committed}, held ${buyer._spentThisWindow() - held3})`);
  }
  globalThis.fetch = stubFetch;

  // The payability check reports an unanswered paid request in the payer's
  // own words, with no claim about other sellers (it tries none).
  chainReader = CHAIN.live;
  const tool = buildSellerPayabilityTool({
    pay: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, notDebited }),
    fetchImpl: (url, init) => stubFetch(url, init),
    assertPublicUrl: async () => {},
  });
  const out = await tool.handler({ url: "https://hang.example/x", body: {} }, { ip: "192.0.2.10" });
  ok(out?.payment?.status === null && out.payment.error === "Seller did not answer the paid request; the payment may have settled",
    `payability: an unanswered paid request reads "${out?.payment?.error}" (no status, nothing about other sellers)`);
}

// ---------------------------------------------------------------------------
// Route-execute on top: fallthrough and the chain's 24 h booking.
const PRO = EXEC_TIERS.find((t) => t.slug === "route-execute-pro");
const cand = (host, price = "$0.001") => ({ seller: `https://${host}`, slug: host.split(".")[0], url: `https://${host}/x`, method: "POST", price, networks: ["eip155:8453"] });
const routeTool = (list) => buildRouteExecuteTool({
  getCatalog: () => ({}), tier: PRO,
  resolveExternal: async () => list,
  // Wired the way server.js wires the router: memoizeDelivery on.
  payExternal: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, memoizeDelivery: true, notDebited }),
  externalEnabled: () => true, externalChains: () => ["base"],
});
let ipSeq = 0;
const route = async (list, params = {}) => {
  const req = { ip: `198.51.100.${++ipSeq}` };
  try { return { r: await routeTool(list).handler({ task: "t", include: "external", params }, req), payer: `ip:${req.ip}` }; }
  catch (e) { return { e, payer: `ip:${req.ip}` }; }
};
const baseDay = () => guard.walletDailySpentUsd("base");
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ===========================================================================
// 1b. ROUTE-EXECUTE: NO SECOND SELLER AFTER AN UNANSWERED PAID REQUEST
// ===========================================================================
{
  for (const [label, reader] of [["possibly paid", CHAIN.consumed], ["chain unreadable", CHAIN.unreadable]]) {
    guard.__reset(); chainReader = reader;
    const before = count("good.example", "paid");
    const { e, payer } = await route([cand("hang.example"), cand("good.example")]);
    ok(e && e.statusCode === 502 && count("good.example", "paid") === before, `RULE (${label}): a timed-out paid request is not followed by a second seller in the same request (good.example paid ${count("good.example", "paid") - before}x)`);
    ok(near(baseDay(), 0.001) && near(guard.payerExposureUsd(payer), 0.001), `RULE (${label}): the booking stands at the amount signed, on the chain day and the payer ($${baseDay()}, not the $${PRO.underlyingMaxUsd} tier cap)`);
    ok(e && /no other seller is tried for this request/.test(e.message), "route-execute's own error says no other seller is tried for this request");
  }
  // The chain proves the credential expired unused: the booking goes, the
  // fallthrough still does not happen in this request.
  guard.__reset(); chainReader = CHAIN.unused;
  {
    const before = count("good.example", "paid");
    const { e, payer } = await route([cand("hang.example"), cand("good.example")]);
    ok(e && count("good.example", "paid") === before, "timed out + chain proves unused -> still no second seller in this request");
    ok(near(baseDay(), 0) && near(guard.payerExposureUsd(payer), 0), `timed out + chain proves unused -> nothing stays booked ($${baseDay()})`);
  }
  // CONTROL: a connection refused on the paid leg sent nothing; the router
  // moves on and the next seller serves, as before.
  guard.__reset(); chainReader = CHAIN.consumed;
  {
    const { r, e } = await route([cand("refused-conn.example"), cand("good.example")]);
    ok(r && r.result?.answer === 42 && r.receipt?.seller === "https://good.example", `CONTROL: a never-sent paid leg still falls through to the next seller${e ? ` (threw ${e.message})` : ""}`);
    ok(near(baseDay(), 0.001), `CONTROL: only the delivered purchase stays booked ($${baseDay()})`);
  }
  // CONTROL: a refusal the chain proves unpaid still falls through.
  guard.__reset(); chainReader = CHAIN.unused;
  {
    const { r } = await route([cand("refuser.example"), cand("good.example")]);
    ok(r && r.receipt?.seller === "https://good.example" && near(baseDay(), 0.001), `CONTROL: a chain-proven refusal falls through and leaves only the delivered purchase booked ($${baseDay()})`);
  }
}

// ===========================================================================
// 2. PROVABLY UNPAID CANDIDATES LEAVE NO BOOKING ON THE CHAIN'S DAY
// ===========================================================================
{
  guard.__reset(); chainReader = CHAIN.consumed;
  const failing = [cand("bare500.example"), cand("overcap.example"), cand("notfound.example")];
  // RULE: route-execute-pro calls whose candidates all fail before anything
  // is signed, from a fresh payer each time (every call is refused, so none is
  // ever charged), leave nothing on the chain's day: more of them than the
  // day's ceiling could hold at the tier cap still leave routing open.
  const outcomes = [];
  for (let i = 0; i < 6; i++) outcomes.push(await route(failing));
  ok(near(baseDay(), 0), `RULE: six all-failing pro calls leave $0 booked on the Base day (got $${baseDay()})`);
  ok(outcomes.every(({ e }) => e && !/paused for everyone/.test(e.message)), `RULE: no call is refused as "paused for everyone" (${outcomes.map(({ e }) => e?.statusCode).join(",")})`);
  ok(guard.maySpend("ip:203.0.113.9", PRO.underlyingMaxUsd, { chain: "base" }).ok, "RULE: a new buyer can still book a pro call on Base afterwards");
  ok(count("notfound.example", "bare") >= 6, `each call reaches every candidate: a pre-signature miss no longer uses up the payer's ceiling (third candidate tried ${count("notfound.example", "bare")}x)`);

  // RULE: a candidate that MAY have been paid keeps a booking - of what its
  // credential can move (the signed quote), not the tier's cap.
  guard.__reset();
  {
    const { e, payer } = await route([cand("broken.example")]);
    ok(e && near(baseDay(), 0.001) && near(guard.payerExposureUsd(payer), 0.001), `RULE: a paid leg answering 500 with no receipt books the $0.001 it signed on the chain day and the payer, not the $${PRO.underlyingMaxUsd} cap ($${baseDay()})`);
  }
  // RULE: a caller whose params make an honest seller settle and then answer
  // something other than 200 (a relayed empty page) from many payers leaves
  // only what was signed on the chain's day, and the next buyer is served.
  guard.__reset();
  {
    const outcomes = [];
    for (let i = 0; i < 8; i++) outcomes.push(await route([cand("empty.example")], { url: "https://caller.example/empty" }));
    ok(outcomes.every(({ e }) => e && e.statusCode === 502), `RULE: each post-payment failure is a 502 to its caller (${outcomes.map(({ e }) => e?.statusCode).join(",")})`);
    ok(near(baseDay(), 0.008), `RULE: eight committed $0.001 failures book $0.008 on the Base day, not 8 x $${PRO.underlyingMaxUsd} (got $${baseDay()})`);
    const { r, e } = await route([cand("good.example")]);
    ok(r && r.result?.answer === 42, `RULE: the next honest pro call is served, not paused${e ? ` (threw ${e.statusCode} ${e.message})` : ""}`);
  }
  // CONTROL: a committed failure that names no signed amount keeps the tier
  // cap - the booking never assumes less than may have left.
  guard.__reset();
  {
    const tool = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: PRO,
      resolveExternal: async () => [cand("opaque.example")],
      payExternal: async () => { throw Object.assign(new Error("seller failed after payment"), { statusCode: 502, committed: true }); },
      externalEnabled: () => true, externalChains: () => ["base"],
    });
    let e = null;
    try { await tool.handler({ task: "t", include: "external" }, { ip: "198.51.100.250" }); } catch (x) { e = x; }
    ok(e && near(baseDay(), PRO.underlyingMaxUsd), `CONTROL: a committed failure with no signed amount on it keeps the $${PRO.underlyingMaxUsd} cap ($${baseDay()})`);
  }
  // CONTROL: a delivered purchase books what the seller quoted.
  guard.__reset();
  {
    const { r } = await route([cand("good.example")]);
    ok(r && near(baseDay(), 0.001), `CONTROL: a delivered purchase books the quote ($${baseDay()})`);
  }
  // CONTROL: the day's ceiling still refuses when real spend fills it.
  guard.__reset();
  {
    guard.noteSpend("ip:192.0.2.1", 24.5, { chain: "base" });
    const { e } = await route([cand("good.example")]);
    ok(e && e.statusCode === 429 && /paused for everyone/.test(e.message), "CONTROL: spend that really left the wallet still pauses the chain at its ceiling");
  }

  // Tempo: every failure after the credential is handed over is stamped
  // committed (nothing on that rail proves otherwise), so route-execute keeps
  // its booking; a refusal before minting carries no stamp.
  loud(); globalThis.fetch = origFetch; quiet();
  const { Challenge } = await import("mppx");
  const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
  const tempoChallenge = (amount = "2000") => Challenge.serialize(Challenge.from({
    realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
    request: { amount, currency: TEMPO_USDC, recipient: "0x" + "11".repeat(20), methodDetails: { chainId: 4217, feePayer: true } }, secretKey: "seller-secret",
  }));
  let tempoMode = "reject";
  const tsrv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^Payment /.test(req.headers.authorization || "")) {
        if (tempoMode === "hang") return; // never answers
        res.writeHead(tempoMode === "reject" ? 402 : 500, { "www-authenticate": tempoChallenge() });
        return res.end("{}");
      }
      res.writeHead(402, { "www-authenticate": tempoChallenge(tempoMode === "expensive" ? "900000" : "2000") });
      res.end("{}");
    });
  });
  const tsock = new Set();
  tsrv.on("connection", (s) => { tsock.add(s); s.on("close", () => tsock.delete(s)); });
  await new Promise((r) => tsrv.listen(0, "127.0.0.1", r));
  const tempoBuy = () => payTempo(`http://127.0.0.1:${tsrv.address().port}/v1/scrape`, { method: "POST", body: {}, maxAtomic: 5000n, trusted: true, timeoutMs: 3500, createCredential: async () => "Payment ZmFrZQ", proof: async () => 4000 }).then(() => null, (e) => e);
  for (const mode of ["reject", "fail", "hang"]) {
    tempoMode = mode;
    const e = await tempoBuy();
    ok(e && e.committed === true, `Tempo: a paid request answered ${mode === "reject" ? "402" : mode === "fail" ? "500" : "with nothing"} is committed (the booking stays)`);
    ok(e && e.signedUsd === 0.002, `Tempo: ...and carries the $0.002 its credential names as the amount to keep booked (got ${e?.signedUsd})`);
  }
  tempoMode = "expensive";
  {
    const e = await tempoBuy();
    ok(e && e.committed !== true && e.signedUsd === undefined && /exceeds this call's ceiling/.test(e.message), "Tempo CONTROL: an over-cap quote refused before minting carries no stamp (nothing spent)");
  }

  // The payability check books what was signed too: a committed failure keeps
  // the signed amount, an uncommitted one gives it all back, and one that names
  // no amount keeps its booking whole.
  for (const [label, thrown, expect] of [
    ["committed, signed $0.001", { committed: true, signedUsd: 0.001 }, [0.001]],
    ["not committed", { committed: false, signedUsd: 0.001 }, [0]],
    ["committed, no amount named", { committed: true }, []],
  ]) {
    const lowered = [];
    const tool = buildSellerPayabilityTool({
      pay: async () => { throw Object.assign(new Error("seller failed after payment"), { statusCode: 502, ...thrown }); },
      fetchImpl: async () => r402(),
      assertPublicUrl: async () => {},
      maySpend: () => ({ ok: true }), noteSpend: () => ({ id: 1 }), adjustSpend: (_h, usd) => lowered.push(usd),
    });
    await tool.handler({ url: "https://seller.example/x" }, { ip: "192.0.2.60" });
    ok(JSON.stringify(lowered) === JSON.stringify(expect), `payability, ${label}: the booking is lowered to ${expect.length ? `$${expect[0]}` : "nothing (kept whole)"} (got ${JSON.stringify(lowered)})`);
  }
  for (const s of tsock) s.destroy();
  tsrv.close();
  globalThis.fetch = stubFetch;
}

// ===========================================================================
// 3. THE REFUSAL MEMO: THE ROUTER'S OWN PURCHASE, THE SELLER'S PAYMENT LAYER,
//    ONE ROUTE, TWO STRIKES
// ===========================================================================
{
  // Every negative case below is driven THREE times, past the two strikes the
  // memo needs, so a missing gate cannot hide behind the strike count.
  const memo = (host) => buyer.sellerRefusedRecently(`https://${host}`, "base");
  const routeMemo = (host, path = "/x") => buyer.sellerRouteRefusedRecently(`https://${host}${path}`, "base");
  const thrice = async (fn) => { let last; for (let i = 0; i < 3; i++) last = await fn(); return last; };
  chainReader = CHAIN.unused;
  // RULE: a check whose URL and body the caller chose (no memoizeDelivery)
  // writes nothing, whatever the seller answers.
  buyer.__resetSellerRefusalsForTest();
  for (const host of ["picky.example", "refuser.example", "wrongdomain.example"]) await thrice(() => buy(host));
  ok(!memo("picky.example") && !memo("refuser.example") && !memo("wrongdomain.example"), "RULE: a caller-directed purchase (no memoizeDelivery) benches nothing - a 400, a 402 or an unsignable accept alike");

  // RULE: the router's own purchase answered 400/422 - the seller judging the
  // caller's input - is not a refusal of our payment.
  buyer.__resetSellerRefusalsForTest();
  for (const host of ["picky.example", "picky422.example"]) {
    const { e } = await thrice(() => buy(host, { memoizeDelivery: true }));
    ok(!memo(host), `RULE: the router's purchase answered ${host === "picky.example" ? 400 : 422} (the caller's input) writes no refusal memo`);
    ok(e && e.committed === false, `...and the chain's proof still releases the hold (${host})`);
  }
  // RULE: a 402 or 401 with no offer on it is the seller's HANDLER answering
  // the request (a relayed page, a missing field), not its payment layer
  // refusing our credential: no memo, however often it happens. The chain's
  // proof still releases the hold and lets the router try the next seller.
  for (const [host, st] of [["handler402.example", 402], ["handler401.example", 401]]) {
    const { e } = await thrice(() => buy(host, { memoizeDelivery: true }));
    ok(!memo(host) && !routeMemo(host), `RULE: the router's purchase answered ${st} by the seller's handler (no offer) writes no memo, three times over`);
    ok(e && e.committed === false && e.refused === true, `...and the chain's proof still releases the hold and falls through (${host})`);
  }
  // Through route-execute with the caller's params producing those answers.
  guard.__reset();
  {
    await thrice(() => route([cand("picky.example")], { wrong: "params" }));
    await thrice(() => route([cand("handler402.example")], { url: "https://caller.example/paywalled" }));
    await thrice(() => route([cand("handler401.example")], { q: "no key" }));
    ok(!memo("picky.example") && !memo("handler402.example") && !memo("handler401.example"), "RULE: a route-execute caller's params bench no seller - a 400, or a handler's 402/401");
  }
  // Through the seller-payability tool, wired as server.js wires it (the payer
  // with the caller's options passed through unchanged).
  {
    const tool = buildSellerPayabilityTool({
      pay: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, notDebited }),
      fetchImpl: (url, init) => stubFetch(url, init),
      assertPublicUrl: async () => {},
    });
    for (const host of ["refuser.example", "picky.example"]) {
      const out = await thrice(() => tool.handler({ url: `https://${host}/x`, body: { any: "thing" } }, { ip: "192.0.2.50" }));
      ok(out && out.payment?.attempted === true && !memo(host), `RULE: $0.10 payability checks against ${host} bench nothing in the router`);
    }
  }

  // CONTROL: the router's own purchase refused by the payment layer, the
  // chain proving it unpaid: one refusal is recorded and changes nothing, the
  // second benches the route - for each form the offer takes.
  buyer.__resetSellerRefusalsForTest();
  for (const [host, st, form] of [["refuser.example", 402, "a PAYMENT-REQUIRED header"], ["unauth.example", 401, "a WWW-Authenticate: Payment challenge"], ["refuser-v1.example", 402, "a v1 accepts body"]]) {
    const first = await buy(host, { memoizeDelivery: true });
    ok(first.e?.refused === true && first.e?.committed === false && !memo(host) && !routeMemo(host), `CONTROL (${form}): one refusal falls through as before and benches nothing yet`);
    const second = await buy(host, { memoizeDelivery: true });
    ok(second.e?.refused === true && routeMemo(host)?.status === st && routeMemo(host)?.strikes === 2, `CONTROL (${form}): the second refusal benches the route (HTTP ${st}, 2 strikes)`);
    ok(memo(host)?.status === st, `CONTROL (${form}): the seller's record shows the benched route`);
  }
  // RULE: the bench is one route. The seller's other routes stay routable,
  // and the query string is not part of the route.
  ok(!routeMemo("refuser.example", "/other") && routeMemo("refuser.example", "/x/") && buyer.sellerRouteRefusedRecently("https://refuser.example/x?q=1", "base"),
    "RULE: a benched route leaves the seller's other routes routable (trailing slash and query are the same route)");
  ok(!buyer.sellerRouteRefusedRecently("https://refuser.example/x", "solana"), "the bench is per chain");
  // RULE: a settled delivery from the route forgets its strikes.
  buyer.__resetSellerRefusalsForTest();
  flakyDelivers = false;
  await buy("flaky.example", { memoizeDelivery: true });
  await buy("flaky.example", { memoizeDelivery: true });
  ok(routeMemo("flaky.example"), "two refusals bench the flaky route");
  flakyDelivers = true;
  ok((await buy("flaky.example", { memoizeDelivery: true })).r?.result?.answer === 7, "it delivers when called directly");
  ok(!routeMemo("flaky.example") && !memo("flaky.example"), "RULE: a settled 200 from the route clears its strikes");
  flakyDelivers = false;
  await buy("flaky.example", { memoizeDelivery: true });
  ok(!routeMemo("flaky.example"), "...so the next refusal counts as a first strike again");
  // ...but a diagnostic's settled 200 clears nothing the router learned.
  await buy("flaky.example", { memoizeDelivery: true });
  flakyDelivers = true;
  await buy("flaky.example");
  ok(routeMemo("flaky.example"), "a settled 200 through a caller-directed check (no memoizeDelivery) leaves the router's bench in place");
  flakyDelivers = false;
  // CONTROL: an unsignable accept met by the router twice benches that route.
  buyer.__resetSellerRefusalsForTest();
  {
    const one = await buy("wrongdomain.example", { memoizeDelivery: true });
    ok(one.e?.refused === true && !memo("wrongdomain.example"), "CONTROL: the router meeting an unsignable Base accept once refuses before signing and benches nothing yet");
    const two = await buy("wrongdomain.example", { memoizeDelivery: true });
    ok(two.e?.refused === true && routeMemo("wrongdomain.example")?.status === 402, "CONTROL: meeting it a second time benches that route");
  }
  // CONTROL: a refusal the chain has not proven is still never memoized.
  buyer.__resetSellerRefusalsForTest();
  chainReader = CHAIN.live;
  {
    const { e } = await thrice(() => buy("refuser.example", { memoizeDelivery: true }));
    ok(!memo("refuser.example") && e?.committed === true, "CONTROL: a refusal with the credential still live is neither memoized nor released");
  }
  // The delivery memo is the router's too: a caller-directed purchase the
  // chain proves unpaid does not erase it; the router's own does, as before.
  chainReader = CHAIN.unused;
  buyer.__resetSellerDeliveryFailuresForTest();
  buyer.noteSellerDeliveryFailure("https://refuser.example", "base", { status: 500 });
  buyer.noteSellerDeliveryFailure("https://refuser.example", "base", { status: 500 });
  await buy("refuser.example");
  ok(buyer.sellerDeliveryFailingRecently("https://refuser.example", "base"), "RULE: a caller-directed purchase refused and proven unpaid leaves the router's delivery memo in place");
  await buy("refuser.example", { memoizeDelivery: true });
  ok(!buyer.sellerDeliveryFailingRecently("https://refuser.example", "base"), "CONTROL: the router's own purchase refused and proven unpaid retracts it, as before");
  buyer.__resetSellerRefusalsForTest(); buyer.__resetSellerDeliveryFailuresForTest();
  // The pure detector the memo rests on.
  const H = (m) => ({ get: (n) => m[String(n).toLowerCase()] ?? null });
  const { paidRefusalCarriesChallenge: carries } = buyer;
  ok(carries(H({ "payment-required": "eyJ4IjoxfQ==" }), "") && carries(H({ "x-payment-required": "abc" }), "") && carries(H({ "www-authenticate": 'Bearer realm="a", Payment id="x"' }), "")
    && carries(H({}), JSON.stringify({ x402Version: 1, error: "invalid", accepts: [{ scheme: "exact" }] })),
    "the payment layer's offer is recognised in each of its forms");
  ok(!carries(H({}), JSON.stringify({ upstreamStatus: 402 })) && !carries(H({}), JSON.stringify({ x402Version: 1, accepts: [] })) && !carries(H({ "www-authenticate": 'Bearer realm="api"' }), "{}") && !carries(H({}), "not json"),
    "a handler's own 402/401 body, an empty accepts list and a non-payment auth challenge are not offers");
}

// ---------------------------------------------------------------------------
// Call-site pins: the rules above are inert unless the callers use them.
{
  const { readFileSync } = await import("node:fs");
  const re = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  const katch = re.slice(re.indexOf("} catch (e) {", re.indexOf("paid = await payExternal(")), re.indexOf("const ts = new Date().toISOString();", re.indexOf("paid = await payExternal(")));
  ok(/adjustSpend\(spendHandle, spentMaybe \? \(e\?\.signedUsd != null && Number\.isFinite\(signedUsd\) && signedUsd >= 0 \? signedUsd : cap\) : 0\)/.test(katch),
    "route-execute books a committed candidate at the amount it signed (the cap only when none is named), an uncommitted one at $0");
  ok(/e\?\.paidUnanswered === true \? "; no other seller is tried for this request" : ""/.test(katch), "route-execute's own error names the no-second-seller rule for an unanswered paid request");
  ok(/!spentMaybe && !unanswered && chain !== "tempo"/.test(katch), "route-execute falls through only when the attempt is neither committed nor unanswered");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/payExternal: \(url, opts\) => \{ const o = \{ \.\.\.opts, memoizeDelivery: true \}; return opts\?\.chain === "tempo" \? payTempo\(url, o\) : payX402\(url, o\); \}/.test(server),
    "only the router's own purchases opt into the memos, on both rails (server.js payExternal)");
  const pay = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  ok(/if \(memoizeDelivery\) noteSellerRefusal\(url, chain, 402\)/.test(pay) && /const memoize = memoizeDelivery && \(paid\.status === 402 \|\| paid\.status === 401\) && paidRefusalCarriesChallenge\(paid\.headers, refusalText\);\n\s*if \(memoize\) noteSellerRefusal\(url, chain, paid\.status\)/.test(pay),
    "both refusal-memo writes in the payer are gated on the router's opt-in and keyed by the route; the paid-retry one also on a 402/401 carrying the seller's offer");
  ok(/if \(memoizeDelivery\) clearSellerDeliveryFailure\(sellerOrigin, chain\);/.test(pay) && !/^\s*clearSellerDeliveryFailure\(sellerOrigin, chain\);/m.test(pay),
    "the chain-proven refusal clears the delivery memo only on the router's opt-in");
  ok((pay.match(/noteSellerRefusal\(/g) || []).length === 3, "no other refusal-memo write exists in the payer (definition + two gated calls)");
}

loud();
globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
