// The Solana external-routing leg: accept pinning, the env gate, the pay-time
// proven-seller gate (fail closed), balance status buckets, the chain
// mapping, and an OFFLINE end-to-end buy - a stub seller answers a real
// solana/exact 402 (extra.feePayer + extra.recentBlockhash, as real
// facilitator challenges carry) and a stub Solana RPC serves the USDC mint
// account, so the REAL @x402/svm scheme signs a real transaction with an
// ephemeral keypair and no network leaves the process.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

// ---- 1. accept pinning --------------------------------------------------
{
  const { pickPayableAccept } = await import("../src/x402-buyer.js");
  const good = { network: MAINNET, scheme: "exact", asset: USDC, amount: "5000", payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg" };
  ok(pickPayableAccept([good], "solana") === good, "mainnet solana/exact/USDC accept is pinned");
  ok(pickPayableAccept([{ ...good, network: "solana" }], "solana") !== null, "bare v1 'solana' network label matches");
  ok(pickPayableAccept([{ ...good, network: DEVNET }], "solana") === null, "DEVNET accept never matches - different genesis, unsettleable payment");
  ok(pickPayableAccept([{ ...good, asset: "So11111111111111111111111111111111111111112" }], "solana") === null, "wrong mint (wSOL) is refused - only mainnet USDC is payable");
  ok(pickPayableAccept([{ ...good, scheme: "upto" }], "solana") === null, "non-exact scheme is refused");
  const decoy = { network: MAINNET, scheme: "exact", asset: "FakeMint1111111111111111111111111111111111", amount: "1", payTo: "x" };
  ok(pickPayableAccept([decoy, good], "solana") === good, "a cheap decoy first does not shadow the real USDC accept (F2)");
}

// ---- 2. chain mapping ---------------------------------------------------
{
  const { EXTERNAL_CHAIN_BY_NETWORK, externalChainsFor } = await import("../src/tools/route-execute.js");
  ok(EXTERNAL_CHAIN_BY_NETWORK[MAINNET] === "solana", "mainnet CAIP-2 maps to the solana spending chain");
  ok(!Object.keys(EXTERNAL_CHAIN_BY_NETWORK).some((k) => k.startsWith("solana:") && k !== MAINNET), "no devnet/testnet network ever maps to a spending wallet");
  ok(externalChainsFor(MAINNET, ["base", "solana"]).join(",") === "solana", "a Solana buyer routes to Solana sellers (self-funding, chain-matched)");
  ok(externalChainsFor(MAINNET, ["base"]).length === 0, "with no SVM wallet configured, a Solana buyer gets no external chain (409 upstream, never a cross-chain spend)");
}

// ---- 3. env gate --------------------------------------------------------
{
  delete process.env.SOLANA_UPSTREAM_BUYER_KEY;
  const { svmBuyerConfigured, getUpstreamBuyerSvm, svmBuyerStatus } = await import("../src/solana-buyer.js");
  ok(svmBuyerConfigured() === false, "no key = not configured");
  ok((await svmBuyerStatus()).status === "unconfigured", "status reports unconfigured, never a fabricated balance");
  const err = await getUpstreamBuyerSvm().then(() => null, (e) => e);
  ok(err && err.statusCode === 503 && /SOLANA_UPSTREAM_BUYER_KEY/.test(err.message), "unconfigured spend path 503s naming the env var");
}

// ---- 4. proven-seller gate (fail closed) --------------------------------
{
  const { solanaInboundCount, assertProvenSolanaSeller } = await import("../src/solana-buyer.js");
  const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const now = Math.floor(Date.now() / 1000);
  // A stub that also serves getTransaction: `txs` maps signature -> a
  // {credit, funder} intent, from which we synthesize pre/postTokenBalances.
  // A credit raises the seller's ATA balance; the funder's USDC account is
  // debited. funder === payTo models a SELF-transfer (must NOT count).
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const rpcStub = (answers, txs = {}) => async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getTransaction") {
      const t = txs[params[0]];
      if (!t) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      const pre = [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: String(t.credit ? 0 : 100) } },
                   { accountIndex: 1, mint: USDC, owner: t.funder, uiTokenAmount: { amount: "1000" } }];
      const post = [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: String(t.credit ? 50 : 100) } },
                    { accountIndex: 1, mint: USDC, owner: t.funder, uiTokenAmount: { amount: t.credit ? "950" : "1000" } }];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { meta: { err: null, preTokenBalances: pre, postTokenBalances: post } } }), { status: 200 });
    }
    const result = answers[method];
    if (result instanceof Error) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const noAccount = await solanaInboundCount(payTo, { fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [] } }) });
  ok(noAccount === 0, "a payTo with NO USDC account scores 0 - nobody has ever paid it");
  const sigs = [
    { signature: "a", blockTime: now - 60, err: null },   // credit from funder-1
    { signature: "b", blockTime: now - 120, err: null },  // credit from funder-2
    { signature: "self", blockTime: now - 90, err: null },// SELF-transfer - must not count
    { signature: "out", blockTime: now - 90, err: null }, // outbound (debit) - must not count
    { signature: "c", blockTime: now - 60, err: { InstructionError: [] } }, // failed tx - filtered before read
    { signature: "d", blockTime: now - 40 * 3600, err: null },              // 40h ago: INSIDE the 7d window now (was outside at 15h)
    { signature: "old", blockTime: now - 8 * 24 * 3600, err: null },        // 8 days ago: OUTSIDE the 7d window - a credit here must NOT count
  ];
  const txs = {
    a: { credit: true, funder: "FACILITATORshared1111111111111111111111111" },
    b: { credit: true, funder: "FACILITATORshared1111111111111111111111111" }, // SAME facilitator - must STILL count (2, not 1)
    d: { credit: true, funder: "FUNDERddddddddddddddddddddddddddddddddddd1" }, // 40h ago, inside 7d -> counts (window widened from 15h)
    old: { credit: true, funder: "FUNDERoooooooooooooooooooooooooooooooooo1" }, // 8d ago, outside 7d -> excluded by the window filter
    self: { credit: true, funder: payTo },   // seller funding itself
    out: { credit: false, funder: "FUNDERaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" }, // debit
  };
  const counted = await solanaInboundCount(payTo, {
    fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [{ pubkey: "ATA111" }] }, getSignaturesForAddress: sigs }, txs),
  });
  ok(counted === 3, "counts direction-verified CREDITS inside the 7d window (a, b, d) - self-transfer/outbound excluded, a shared facilitator sender still counts, and the 8-day-old credit is outside the window");
  // 20 self-transfers = the cheap spoof the review flagged; they all have funder === payTo.
  const spoofSigs = Array.from({ length: 20 }, (_, i) => ({ signature: `s${i}`, blockTime: now - 60, err: null }));
  const spoofTxs = Object.fromEntries(spoofSigs.map((x) => [x.signature, { credit: true, funder: payTo }]));
  const spoof = await solanaInboundCount(payTo, {
    fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [{ pubkey: "ATA111" }] }, getSignaturesForAddress: spoofSigs }, spoofTxs),
  });
  ok(spoof === 0, "20 self-transfers do NOT prove a seller - the seller funding its own payTo is excluded, so the cheap spoof scores 0");
  const rpcDead = await solanaInboundCount(payTo, { fetchImpl: rpcStub({}) }).then(() => null, (e) => e);
  ok(rpcDead === null || rpcDead instanceof Error, "an unreadable chain THROWS from the counter");
  const gateDead = await assertProvenSolanaSeller(payTo, { inboundFn: async () => { throw new Error("rpc down"); } }).then(() => null, (e) => e);
  ok(gateDead && gateDead.statusCode === 503 && /refusing to spend/.test(gateDead.message), "gate FAILS CLOSED on an unreadable chain (503, nothing signed)");
  const below = await assertProvenSolanaSeller(payTo, { inboundFn: async () => 3, minCount: 20 }).then(() => null, (e) => e);
  ok(below && below.statusCode === 409 && /floor 20/.test(below.message), "a seller under the credit floor is refused 409 with the floor named");
  ok((await assertProvenSolanaSeller(payTo, { inboundFn: async () => 25, minCount: 20 })) === 25, "a seller at/over the credit floor passes and the count is returned");
  const junk = await solanaInboundCount("not-an-address!!", { fetchImpl: rpcStub({}) }).then(() => null, (e) => e);
  ok(junk instanceof Error, "a junk payTo is refused before any RPC call");
}

// ---- 5. configured wallet: status buckets + OFFLINE e2e buy --------------
{
  const kit = await import("@solana/kit");
  const keypairBytes = new Uint8Array(64);
  const gen = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", gen.privateKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", gen.publicKey));
  keypairBytes.set(pkcs8.slice(pkcs8.length - 32), 0); // seed
  keypairBytes.set(rawPub, 32);
  process.env.SOLANA_UPSTREAM_BUYER_KEY = JSON.stringify([...keypairBytes]);

  // Stub Solana RPC: serves the USDC mint account (SPL mint layout, decimals
  // 6, owned by the token program) so the real scheme's fetchMint works with
  // zero real network. getLatestBlockhash is deliberately ABSENT: the accept
  // carries extra.recentBlockhash, so signing must not need it.
  const mintData = Buffer.alloc(82);
  mintData.writeUInt8(6, 44); // decimals
  mintData.writeUInt8(1, 45); // isInitialized
  const rpcSrv = createServer((req, res) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      const { method, id } = JSON.parse(buf);
      const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
      if (method === "getAccountInfo") {
        reply({ context: { slot: 1 }, value: { data: [mintData.toString("base64"), "base64"], executable: false, lamports: 1000000, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82 } });
      } else if (method === "getTokenAccountsByOwner") {
        reply({ value: [{ pubkey: "ATA111", account: { data: { parsed: { info: { tokenAmount: { uiAmount: 4.2 } } } } } }] });
      } else {
        res.statusCode = 500; res.end("{}");
      }
    });
  });
  await new Promise((r) => rpcSrv.listen(0, "127.0.0.1", r));
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpcSrv.address().port}`;

  const { svmBuyerStatus, getUpstreamBuyerSvm } = await import("../src/solana-buyer.js");
  const { address } = await getUpstreamBuyerSvm();
  ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address), `spending wallet derives a plausible address (${address.slice(0, 8)}…)`);
  ok((await svmBuyerStatus()).status === "ok", "status 'ok' when the USDC balance clears the low-water mark");
  process.env.SOLANA_UPSTREAM_BUYER_LOW_USD = "10";
  ok((await svmBuyerStatus()).status === "low", "status 'low' under the low-water mark");
  delete process.env.SOLANA_UPSTREAM_BUYER_LOW_USD;

  // Stub seller: bare request -> 402 with a real solana/exact accept; a
  // request carrying a payment header -> 200 + the header captured.
  const sellerPayTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  let seenPayment = null, seenHeaderNames = null;
  const seller = createServer((req, res) => {
    const pay = req.headers["payment-signature"] || req.headers["x-payment"];
    if (pay) seenHeaderNames = { sig: "payment-signature" in req.headers, xp: "x-payment" in req.headers };
    if (!pay) {
      const accepts = [{
        scheme: "exact", network: MAINNET, asset: USDC, amount: "5000",
        payTo: sellerPayTo, maxTimeoutSeconds: 60, resource: "http://stub/thing",
        description: "stub", mimeType: "application/json",
        extra: { feePayer: "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe", recentBlockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: "250000000" },
      }];
      res.statusCode = 402;
      // v2 wire shape: the challenge rides the PAYMENT-REQUIRED header
      // (base64 JSON), body {} - the same shape our own paywall serves.
      res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, error: "payment required", accepts })).toString("base64"));
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    seenPayment = String(pay);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ okFromSeller: true }));
  });
  await new Promise((r) => seller.listen(0, "127.0.0.1", r));
  const sellerUrl = `http://127.0.0.1:${seller.address().port}/thing`;

  const { payX402 } = await import("../src/x402-buyer.js");
  let proofChecked = null;
  const out = await payX402(sellerUrl, {
    maxAtomic: "10000", chain: "solana", trusted: true,
    sellerProof: async (payTo) => { proofChecked = payTo; return 25; },
  });
  ok(out?.result?.okFromSeller === true, "OFFLINE e2e: the real @x402/svm scheme signed and the seller served the paid request");
  ok(proofChecked === sellerPayTo, "the proven-seller gate ran against the accept's OWN payTo before signing");
  ok(out.quote?.usd === 0.005 && out.quote?.network === MAINNET, "receipt quote carries the atomic amount and mainnet network");
  ok(seenHeaderNames && seenHeaderNames.sig === true && seenHeaderNames.xp === false,
    "a v2 challenge is paid with PAYMENT-SIGNATURE ONLY - no X-PAYMENT mirror (a seller reading X-PAYMENT first takes its v1 path; xfuel's has no Solana branch, 2026-09-02)");
  {
    const decoded = JSON.parse(Buffer.from(seenPayment, "base64").toString("utf8"));
    const txB64 = decoded?.payload?.transaction;
    ok(typeof txB64 === "string" && Buffer.from(txB64, "base64").length > 200, "payment header carries a real signed wire transaction");
  }

  // A seller failing the proof gate gets NOTHING signed.
  seenPayment = null;
  const refused = await payX402(sellerUrl, {
    maxAtomic: "10000", chain: "solana", trusted: true,
    sellerProof: async () => { const e = new Error("Seller payTo has 0 recent inbound USDC transfers on Solana (floor 20) - not routable yet"); e.statusCode = 409; throw e; },
  }).then(() => null, (e) => e);
  ok(refused && refused.statusCode === 409 && seenPayment === null, "an unproven seller is refused BEFORE signing - no payment header ever leaves");

  seller.close(); rpcSrv.close();
}

// ---- 6. resolve-time gate: skip, never abort --------------------------
{
  const { passesSolanaResolveGate } = await import("../src/solana-buyer.js");
  const mk = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const solAccept = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo };
  const proven = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => 50 });
  ok(proven.ok === true && proven.payTo === payTo, "a proven candidate passes the resolve-time gate with its payTo named");
  const thin = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => 2, minCount: 20 });
  ok(thin.ok === false && /floor 20/.test(thin.reason), "an unproven candidate is SKIPPED with the count in the reason - never an abort");
  const dead = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => { throw new Error("rpc down"); } });
  ok(dead.ok === false && /chain unreadable/.test(dead.reason), "an unreadable chain skips the candidate (fail closed at resolve time too)");
  const noSol = await passesSolanaResolveGate({ header: mk([{ network: "eip155:8453", payTo: "0xabc" }]), inboundFn: async () => 99 });
  ok(noSol.ok === false && /no readable solana accept/.test(noSol.reason), "a 402 with no solana accept is not a candidate");
  const junkHdr = await passesSolanaResolveGate({ header: "!!!not-base64!!!", inboundFn: async () => 99 });
  ok(junkHdr.ok === false, "an unreadable challenge is skipped, never thrown");
  const v1Body = await passesSolanaResolveGate({ header: null, body: JSON.stringify({ accepts: [solAccept] }), inboundFn: async () => 50 });
  ok(v1Body.ok === true, "a v1 body-carried challenge parses too");
}

// --- a REFUSED payment falls through on chain truth (2026-09-02) -----------
// A seller that answers 402 to the paid retry is refusing the payment. Its
// status line is its own, so the buyer kept the hold and never tried another
// seller - and api.xfuel.app refused the reference @x402/svm client the same
// way, so every "chat completions" on Solana died on it. The wallet's own
// USDC account answers the real question; the seller cannot influence it.
{
  const { payX402, sellerRefusedRecently, noteSellerRefusal, __resetSellerRefusalsForTest, _spentThisWindow } = await import("../src/x402-buyer.js");
  const { confirmSvmNotDebited } = await import("../src/solana-buyer.js");
  __resetSellerRefusalsForTest();
  // Stub seller that REFUSES every paid retry the way xfuel does.
  let refuserPaidAttempts = 0;
  const refuser = createServer((req, res) => {
    const pay = req.headers["payment-signature"] || req.headers["x-payment"];
    res.setHeader("content-type", "application/json");
    if (pay) refuserPaidAttempts++;
    if (!pay) {
      const accepts = [{ scheme: "exact", network: MAINNET, asset: USDC, amount: "5000", payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", maxTimeoutSeconds: 60,
        extra: { feePayer: "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe", recentBlockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: "250000000" } }];
      res.statusCode = 402;
      res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, error: "payment required", accepts })).toString("base64"));
      res.end("{}"); return;
    }
    res.statusCode = 402;
    res.end(JSON.stringify({ error: { message: "Payment could not be settled: payment_payload_invalid", code: "payment_payload_invalid" } }));
  });
  await new Promise((r) => refuser.listen(0, "127.0.0.1", r));
  const refuserUrl = `http://127.0.0.1:${refuser.address().port}/v1/chat/completions`;
  const refuserOrigin = `http://127.0.0.1:${refuser.address().port}`;
  const buy = (notDebited) => payX402(refuserUrl, { maxAtomic: "10000", chain: "solana", trusted: true, sellerProof: async () => 25, notDebited }).then(() => null, (e) => e);

  let asked = null;
  const heldBefore = _spentThisWindow();
  const e1 = await buy(async (q) => { asked = q; return { debited: false, observed: 0 }; });
  ok(e1 && e1.statusCode === 502 && e1.committed === false && e1.refused === true, "refused + chain shows NO debit -> the error is uncommitted (safe to try the next seller) and flagged refused");
  ok(_spentThisWindow() === heldBefore, "and the spend hold was RELEASED (the window budget is back where it was)");
  ok(refuserPaidAttempts === 1, "a 402 that does NOT name X-PAYMENT (payment_payload_invalid) gets no header-name resend - one paid attempt");
  ok(asked && typeof asked.wallet === "string" && Number.isInteger(asked.sinceUnix) && asked.sinceUnix <= Math.floor(Date.now() / 1000), "the chain check is asked about OUR wallet since the moment the header went out");
  ok(sellerRefusedRecently(refuserOrigin, "solana") && sellerRefusedRecently(refuserOrigin, "solana").status === 402, "the refusing seller is memoized for this chain");
  ok(!sellerRefusedRecently(refuserOrigin, "base"), "the memo is per chain - the same seller on Base is untouched");
  __resetSellerRefusalsForTest();
  const heldBefore2 = _spentThisWindow();
  const e2 = await buy(async () => ({ debited: true, signature: "abc" }));
  ok(e2 && e2.committed === true && !e2.refused, "refused but the chain shows a DEBIT -> post-commit stance kept (we may have paid; no second spend)");
  ok(_spentThisWindow() === heldBefore2 + 5000n, "and the hold STANDS (5000 atomic still counted against the window)");
  ok(!sellerRefusedRecently(refuserOrigin, "solana"), "a debited refusal is not memoized as a refusal");
  const e3 = await buy(async () => { throw new Error("RPC 429"); });
  ok(e3 && e3.committed === true, "unreadable chain -> post-commit stance kept (fail closed)");
  ok(!sellerRefusedRecently(refuserOrigin, "solana"), "and nothing memoized on an unreadable chain");
  // Memo TTL: a seller that fixes its rail is retried after the window.
  noteSellerRefusal("https://fixed.example", "solana", 402);
  ok(sellerRefusedRecently("https://fixed.example", "solana") !== null, "a fresh memo is visible");
  ok(sellerRefusedRecently("https://fixed.example", "solana", Date.now() + 7 * 3600 * 1000) === null, "and gone after the TTL (6 h default)");
  refuser.close();

  // confirmSvmNotDebited against a stub RPC, all four outcomes.
  const W = "5xVcvJQ6jLe5tYv7aYQ4gCXoR1yzz9Vc3Nc7qF2wD1Zd";
  const mkRpc = (sigs, txs, fail) => async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (fail) return new Response("{}", { status: 429 });
    if (method === "getTokenAccountsByOwner") return reply({ value: [{ pubkey: "ATA" }] });
    if (method === "getSignaturesForAddress") return reply(sigs);
    if (method === "getTransaction") return reply(txs[params[0]] || null);
    return reply(null);
  };
  const nowS = Math.floor(Date.now() / 1000);
  const bal = (owner, amt) => ({ mint: USDC, owner, uiTokenAmount: { amount: String(amt) } });
  const debitTx = { meta: { err: null, preTokenBalances: [bal(W, 1000000)], postTokenBalances: [bal(W, 995000)] } };
  const creditTx = { meta: { err: null, preTokenBalances: [bal(W, 1000000)], postTokenBalances: [bal(W, 1005000)] } };
  const fast = { wallet: W, sinceUnix: nowS - 10, graceMs: 0, pollMs: 0 };
  ok((await confirmSvmNotDebited({ ...fast, fetchImpl: mkRpc([], {}) })).debited === false, "no signatures since the mark -> not debited");
  ok((await confirmSvmNotDebited({ ...fast, fetchImpl: mkRpc([{ signature: "s1", blockTime: nowS }], { s1: debitTx }) })).debited === true, "a recent transaction that LOWERED our USDC -> debited");
  ok((await confirmSvmNotDebited({ ...fast, fetchImpl: mkRpc([{ signature: "s2", blockTime: nowS }], { s2: creditTx }) })).debited === false, "a recent INBOUND transfer is not a debit");
  ok((await confirmSvmNotDebited({ ...fast, fetchImpl: mkRpc([{ signature: "s3", blockTime: nowS - 3600 }], { s3: debitTx }) })).debited === false, "a debit from BEFORE the mark does not count");
  let threw = null; try { await confirmSvmNotDebited({ ...fast, fetchImpl: mkRpc([], {}, true) }); } catch (e) { threw = e; }
  ok(threw, "an unreadable RPC throws - never 'not debited' by default");
}

// --- the UNPROVEN allowance (2026-09-02) -----------------------------------
// Two Solana sellers with zero on-chain history each settled a stock payment
// and delivered; the one proven seller for the same task refused every
// payment. The floor stays the default; a small quote to a thin seller is a
// bounded loss the operator chose to accept, and only after proven sellers.
{
  const { assertProvenSolanaSeller, passesSolanaResolveGate, svmUnprovenAllowanceAtomic } = await import("../src/solana-buyer.js");
  const thin = async () => 0;
  const outcome = (opts) => assertProvenSolanaSeller("J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", { inboundFn: thin, ...opts }).then(() => "paid", (e) => e.statusCode);
  ok((await outcome({})) === 409, "no allowance: a thin seller is refused 409 as before");
  ok((await outcome({ allowUnprovenUpToAtomic: 10000n, quotedAtomic: "1000" })) === "paid", "allowance $0.01, quote $0.001 -> the thin seller is paid");
  ok((await outcome({ allowUnprovenUpToAtomic: 10000n, quotedAtomic: "10000" })) === "paid", "quote exactly AT the allowance is paid");
  ok((await outcome({ allowUnprovenUpToAtomic: 10000n, quotedAtomic: "10001" })) === 409, "one atomic over the allowance -> 409");
  ok((await outcome({ allowUnprovenUpToAtomic: 10000n, quotedAtomic: null })) === 409, "no quote to bound -> 409");
  ok((await outcome({ allowUnprovenUpToAtomic: 0n, quotedAtomic: "1" })) === 409, "allowance 0 -> the hard floor");
  const dead = async () => { throw new Error("RPC 429"); };
  ok((await assertProvenSolanaSeller("J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", { inboundFn: dead, allowUnprovenUpToAtomic: 10000n, quotedAtomic: "1" }).then(() => "paid", (e) => e.statusCode)) === 503,
    "an UNREADABLE chain is still refused 503 even under the allowance - unproven is not unverifiable");
  const saved = process.env.SOR_SVM_UNPROVEN_MAX_USD;
  delete process.env.SOR_SVM_UNPROVEN_MAX_USD;
  ok(svmUnprovenAllowanceAtomic() === 10000n, "default allowance is $0.01");
  process.env.SOR_SVM_UNPROVEN_MAX_USD = "off"; ok(svmUnprovenAllowanceAtomic() === 0n, "'off' disables the tier");
  process.env.SOR_SVM_UNPROVEN_MAX_USD = "0"; ok(svmUnprovenAllowanceAtomic() === 0n, "'0' disables the tier");
  process.env.SOR_SVM_UNPROVEN_MAX_USD = "abc"; ok(svmUnprovenAllowanceAtomic() === 0n, "a malformed value disables rather than widens");
  process.env.SOR_SVM_UNPROVEN_MAX_USD = "0.002"; ok(svmUnprovenAllowanceAtomic() === 2000n, "a custom allowance is honoured");
  if (saved === undefined) delete process.env.SOR_SVM_UNPROVEN_MAX_USD; else process.env.SOR_SVM_UNPROVEN_MAX_USD = saved;
  const hdr = Buffer.from(JSON.stringify({ accepts: [{ network: MAINNET, payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg" }] })).toString("base64");
  const g = await passesSolanaResolveGate({ header: hdr, inboundFn: async () => 3 });
  ok(g.ok === false && g.inbound === 3, "the resolve gate reports the COUNT on a short-history refusal, so the resolver can tell 'thin' from 'unreadable'");
  const gu = await passesSolanaResolveGate({ header: hdr, inboundFn: dead });
  ok(gu.ok === false && gu.inbound === undefined, "and reports no count when the chain was unreadable");
}

// --- header names follow the challenge version; X-PAYMENT resend by evidence --
{
  const { payX402 } = await import("../src/x402-buyer.js");
  let v1Headers = null;
  const v1 = createServer((req, res) => {
    const pay = req.headers["payment-signature"] || req.headers["x-payment"];
    res.setHeader("content-type", "application/json");
    if (!pay) {
      res.statusCode = 402;
      res.end(JSON.stringify({ x402Version: 1, error: "X-PAYMENT header required", accepts: [{ scheme: "exact", network: MAINNET, asset: USDC, maxAmountRequired: "5000", payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", maxTimeoutSeconds: 60, resource: "http://stub/v1", description: "stub", mimeType: "application/json",
        extra: { feePayer: "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe", recentBlockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: "250000000" } }] }));
      return;
    }
    v1Headers = { sig: "payment-signature" in req.headers, xp: "x-payment" in req.headers };
    res.end(JSON.stringify({ okFromV1: true }));
  });
  await new Promise((r) => v1.listen(0, "127.0.0.1", r));
  const out = await payX402(`http://127.0.0.1:${v1.address().port}/v1`, { maxAtomic: "10000", chain: "solana", trusted: true, sellerProof: async () => 25 }).catch((e) => ({ err: e }));
  ok(out?.result?.okFromV1 === true, "a v1 (body) challenge is still payable");
  ok(v1Headers && v1Headers.xp === true && v1Headers.sig === false, "and a v1 challenge is paid under X-PAYMENT alone - the v1 header name @x402/core emits");
  v1.close();
  // Stelar shape: a v2 challenge from a seller that reads ONLY X-PAYMENT and
  // says so. First paid attempt (spec header) -> 402 naming X-PAYMENT; the
  // buyer resends the SAME credential under both names once -> 200.
  let attempts = [];
  const stelar = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const sig = req.headers["payment-signature"], xp = req.headers["x-payment"];
    if (!sig && !xp) {
      const accepts = [{ scheme: "exact", network: MAINNET, asset: USDC, amount: "5000", payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", maxTimeoutSeconds: 60,
        extra: { feePayer: "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe", recentBlockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: "250000000" } }];
      res.statusCode = 402;
      res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, error: "payment required", accepts })).toString("base64"));
      res.end("{}"); return;
    }
    attempts.push({ sig: !!sig, xp: !!xp, same: !!sig && !!xp && sig === xp });
    if (!xp) { res.statusCode = 402; res.end(JSON.stringify({ error: "X-PAYMENT header required" })); return; }
    res.end(JSON.stringify({ okFromStelar: true }));
  });
  await new Promise((r) => stelar.listen(0, "127.0.0.1", r));
  const st = await payX402(`http://127.0.0.1:${stelar.address().port}/thing`, { maxAtomic: "10000", chain: "solana", trusted: true, sellerProof: async () => 25 }).catch((e) => ({ err: e }));
  ok(st?.result?.okFromStelar === true, "a v2 seller that names X-PAYMENT in its 402 is paid on the resend");
  ok(attempts.length === 2 && attempts[0].sig && !attempts[0].xp && attempts[1].sig && attempts[1].xp && attempts[1].same,
    "exactly two paid attempts: spec header alone, then the IDENTICAL credential under both names");
  stelar.close();
}

// --- the payload carries `accepted` (2026-09-01) ---------------------------
// A hand-built SVM payload MUST echo back the requirement it satisfies as
// `accepted`; without it the seller's facilitator throws `unexpected_verify_error`
// (the scheme client always includes it). Verify-critical, so pin it. No RPC:
// the builder reads extra.recentBlockhash and signs offline.
{
  const { createSvmPaymentPayload } = await import("../src/solana-buyer.js");
  const kit = await import("@solana/kit");
  const signer = await kit.generateKeyPairSigner();
  const req = {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: 1000,
    payTo: "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA",
    maxTimeoutSeconds: 300,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", recentBlockhash: "EeS7HKiDAu8hmSDrcNXa3nnCVEgDG9hygkFByy1E6Aon", lastValidBlockHeight: "421572519" },
  };
  const p = await createSvmPaymentPayload(signer, { x402Version: 2, accepts: [req] });
  ok(p.accepted && p.accepted.network === req.network && String(p.accepted.amount) === "1000" && p.accepted.payTo === req.payTo && p.accepted.asset === req.asset,
    "the payload echoes `accepted` (network/amount/payTo/asset) - the field the facilitator matches against");
  ok(p.accepted.extra && p.accepted.extra.feePayer === req.extra.feePayer,
    "`accepted.extra` carries the feePayer/blockhash the facilitator needs");
  ok(p.payload && typeof p.payload.transaction === "string" && p.payload.transaction.length > 0,
    "the payload still carries the signed base64 wire transaction");
  // The v2 wrap must match the STOCK client's: `resource` + `extensions` from
  // the 402 ride beside `accepted`. blockrun's stock middleware tolerated
  // their absence; xfuel's own verifier answered payment_payload_invalid to an
  // otherwise identical transaction (2026-09-02).
  const resource = { url: "https://seller.example/v1/chat/completions", description: "chat", mimeType: "application/json" };
  const extensions = { bazaar: { info: { input: { type: "http" } } } };
  const wrapped = await createSvmPaymentPayload(signer, { x402Version: 2, resource, extensions, accepts: [req] });
  ok(wrapped.resource && wrapped.resource.url === resource.url && wrapped.resource.mimeType === resource.mimeType,
    "the payload carries the 402's `resource` like the stock client's wrap does");
  ok(wrapped.extensions && wrapped.extensions.bazaar && wrapped.extensions.bazaar.info.input.type === "http",
    "and echoes the 402's `extensions` (the stock client merges them in)");
  ok(!("resource" in p) && !("extensions" in p),
    "a 402 that carries neither gets neither - nothing is invented");
  ok(JSON.stringify(Object.keys(wrapped).sort()) === JSON.stringify(["accepted", "extensions", "payload", "resource", "x402Version"]),
    "and the wrap has exactly the stock field set, nothing extra for a strict verifier to trip on");
}

// ---- 9. resolve-time model-list check ------------------------------------
// An LLM task names a model; the namespace is the seller's own. On Solana,
// "chat completions" + gpt-4o-mini resolved to a seller that settled the
// $0.01 and then answered 400 model_not_found, keeping the money. Every
// OpenAI-shaped seller publishes GET .../models for free, so the resolver
// reads it and skips a seller whose readable list lacks the model. Only
// "not-served" decides; a missing/empty list or a non-chat route is unknown.
{
  const { modelsUrlFor, modelListed, sellerServesModel, __resetModelListsForTest } = await import("../src/x402-buyer.js");
  ok(modelsUrlFor("https://s.example/v1/chat/completions") === "https://s.example/v1/models", "chat/completions -> /v1/models");
  ok(modelsUrlFor("https://s.example/api/v1/chat/completions?x=1") === "https://s.example/api/v1/models", "prefixed route keeps its prefix, query dropped");
  ok(modelsUrlFor("https://s.example/v1/messages") === "https://s.example/v1/models" && modelsUrlFor("https://s.example/v1/responses") === "https://s.example/v1/models", "messages + responses wires too");
  ok(modelsUrlFor("https://s.example/api/v1/exa/search") === null && modelsUrlFor("not a url") === null, "a non-chat route (or garbage) has no model list");
  ok(modelListed(["openai/gpt-4o-mini"], "gpt-4o-mini") && modelListed(["gpt-4o-mini"], "openai/gpt-4o-mini") && modelListed(["GPT-4o-mini"], "gpt-4o-mini"), "provider prefix and case are tolerated both ways");
  ok(!modelListed(["xfuel/auto", "theta/glm_5_3"], "gpt-4o-mini") && !modelListed(["gpt-4o-mini-2024"], "gpt-4o-mini"), "a different id is not a match (no substring matching)");
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "xfuel/auto" }, { id: "theta/glm_5_3" }] })); return; }
    if (req.url === "/wide/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini" }] })); return; }
    if (req.url === "/empty/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [] })); return; }
    if (req.url === "/html/v1/models") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); return; }
    res.writeHead(404); res.end("no");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  __resetModelListsForTest();
  const t = { trusted: true };
  ok((await sellerServesModel(`${base}/v1/chat/completions`, "gpt-4o-mini", t)).verdict === "not-served", "a readable list without the model -> not-served (the xfuel shape)");
  ok((await sellerServesModel(`${base}/v1/chat/completions`, "theta/glm_5_3", t)).verdict === "served", "a listed model -> served");
  ok(hits === 1, "the list was read ONCE for both verdicts (cached per list URL)");
  ok((await sellerServesModel(`${base}/wide/v1/chat/completions`, "gpt-4o-mini", t)).verdict === "served", "prefix-listed model -> served (the blockrun shape)");
  ok((await sellerServesModel(`${base}/empty/v1/chat/completions`, "gpt-4o-mini", t)).verdict === "unknown", "an EMPTY list is unknown, never a refusal");
  ok((await sellerServesModel(`${base}/html/v1/chat/completions`, "gpt-4o-mini", t)).verdict === "unknown", "an unparseable list is unknown");
  ok((await sellerServesModel(`${base}/nolist/v1/chat/completions`, "gpt-4o-mini", t)).verdict === "unknown", "a 404 list is unknown (fail open)");
  ok((await sellerServesModel(`${base}/v1/chat/completions`, "", t)).verdict === "unknown" && (await sellerServesModel(`${base}/v1/chat/completions`, null, t)).verdict === "unknown", "no model requested -> unknown, nothing fetched");
  ok((await sellerServesModel(`${base}/api/v1/exa/search`, "gpt-4o-mini", t)).verdict === "unknown", "a non-chat route is unknown (a model param on a search tool is not our call)");
  const before = hits;
  await sellerServesModel(`${base}/v1/chat/completions`, "gpt-4o-mini", { ...t, now: Date.now() + 11 * 60 * 1000 });
  ok(hits === before + 1, "the cache expires after 10 minutes and the list is re-read");
  srv.close();
}

console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `OK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
