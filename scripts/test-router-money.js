// The router's money invariants, driven through the real payers against
// stubbed sellers (a stubbed fetch or a 127.0.0.1 stub on port 0), a stubbed
// chain and throwaway keys. Nothing is sent to a seller, an RPC or a
// facilitator, and nothing is paid.
//
//   1. One deadline per purchase: every seller request takes what is left of
//      it, and nothing is signed or sent once too little remains.
//   2. A Solana hold is released only on proof the credential cannot land:
//      the finalized chain past the blockhash's last valid height, read
//      from our own RPC; an unknown answer is pending.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "router-money-test-"));
process.env.OUTBOUND_LEDGER_FILE = join(dir, "outbound-spend.ndjson");
process.env.MEMORY_DB_FILE = join(dir, "memory.db");
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily.json");
process.env.SOR_ROUTER_PURCHASES_FILE = join(dir, "router-purchases.json");
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
delete process.env.SOR_SPEND_CAP_ATOMIC;
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const buyer = await import("../src/x402-buyer.js");
const { PAY_X402_TIMEOUT_MS, PAY_X402_MIN_LEG_MS } = await import("../src/buyer-timeouts.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const guard = await import("../src/external-spend-guard.js");
buyer.__setBuyerAddressGuardForTest(false); // this suite's sellers are stubs

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const origFetch = globalThis.fetch;
const origTimeout = AbortSignal.timeout;

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0x" + "ef".repeat(20);
const baseAccept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });
const challengeHeader = (accept) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
const paidHeaderOf = (init) => init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["X-PAYMENT"] || null;
const bare402 = (h) => ({ status: 402, headers: { get: (k) => (k.toLowerCase() === "payment-required" ? h : null) }, json: async () => ({}), text: async () => "{}" });
const json200 = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

// --- 1. One deadline per purchase --------------------------------------------
// The clock is the test's own: a stubbed seller "takes" time by moving it, so
// no assertion rests on how long this machine took. The timeout each request
// was started with is read from AbortSignal.timeout itself.
{
  const run = async ({ deadlineMs, legMs, opts = {}, paidAnswer = json200 }) => {
    let clock = 1_000_000;
    const startedAt = clock;
    const legs = [], asked = [];
    AbortSignal.timeout = (ms) => { asked.push(ms); return origTimeout.call(AbortSignal, 600_000); };
    const h = challengeHeader(baseAccept());
    globalThis.fetch = async (_url, init) => {
      const paid = !!paidHeaderOf(init);
      legs.push({ paid, startedAtMs: clock - startedAt, both: !!(init?.headers?.["PAYMENT-SIGNATURE"] && init?.headers?.["X-PAYMENT"]) });
      clock += legMs; // the seller answers legMs later
      return paid ? paidAnswer() : bare402(h);
    };
    const held = buyer._spentThisWindow();
    const out = await buyer.payX402("https://slow.example/x", { maxAtomic: 5000n, method: "POST", body: {}, chain: "base", refusalMaxWaitMs: 0, notDebited: async () => ({ debited: false, observed: 0, expired: false }), now: () => clock, ...(deadlineMs != null ? { deadlineMs } : {}), ...opts })
      .then((r) => ({ paid: true, usd: r.quote?.usd }), (e) => ({ paid: false, status: e.statusCode, committed: e.committed === true, message: e.message }));
    AbortSignal.timeout = origTimeout;
    return { out, legs, asked, heldDelta: buyer._spentThisWindow() - held, endedAtMs: clock - startedAt };
  };

  // Both requests slow, as the review ran it: a 5 s budget, 2.7 s per request.
  const slow = await run({ deadlineMs: 5000, legMs: 2700 });
  ok(slow.out.paid === false && slow.out.status === 504 && /Nothing was signed/.test(slow.out.message || ""), `a seller slow on the unpaid request is refused 504 before signing (${slow.out.status} ${slow.out.message})`);
  ok(slow.legs.length === 1 && slow.legs.every((l) => !l.paid), `no request carried a payment after the budget ran short (${JSON.stringify(slow.legs)})`);
  ok(slow.out.committed === false && slow.heldDelta === 0n, `nothing is held for a payment that was never signed (held ${slow.heldDelta})`);
  // CONTROL: the same seller with room for both requests is paid, and its paid
  // request is started with what was left, not with a whole timeout again.
  const roomy = await run({ deadlineMs: 10_000, legMs: 2700 });
  ok(roomy.out.paid === true && roomy.legs.filter((l) => l.paid).length === 1, `CONTROL: with room for both requests the seller is paid (${JSON.stringify(roomy.out)})`);
  ok(roomy.asked.length === 2 && roomy.asked[0] === 10_000 && roomy.asked[1] === 7300, `each request takes what is left of the one deadline (${JSON.stringify(roomy.asked)})`);
  ok(roomy.legs.every((l) => l.startedAtMs <= 10_000), "every request started inside the deadline");
  // A per-request timeout shorter than what is left still applies.
  const capped = await run({ deadlineMs: 60_000, legMs: 100, opts: { timeoutMs: 4000 } });
  ok(capped.out.paid === true && capped.asked.every((ms) => ms === 4000), `a request never gets more than timeoutMs (${JSON.stringify(capped.asked)})`);
  // CONTROL: a caller with no deadline keeps a whole timeout per request.
  const none = await run({ deadlineMs: null, legMs: 2700 });
  ok(none.out.paid === true && none.asked.length === 2 && none.asked.every((ms) => ms === PAY_X402_TIMEOUT_MS), `CONTROL: with no deadline each request gets timeoutMs, as before (${JSON.stringify(none.asked)})`);
  // The budget already spent when the call starts: the seller is not contacted.
  const spent = await run({ deadlineMs: 1000, legMs: 10 });
  ok(spent.out.status === 504 && spent.legs.length === 0 && spent.heldDelta === 0n, `under the floor at the start, no request is made at all (${spent.legs.length} requests)`);
  ok(PAY_X402_MIN_LEG_MS >= 1000, "the floor is at least a second");
  // The same credential is not sent a second time once too little is left.
  const byName = () => new Response("X-PAYMENT header required", { status: 402 });
  const resendLate = await run({ deadlineMs: 6500, legMs: 2700, paidAnswer: byName });
  ok(resendLate.legs.filter((l) => l.paid).length === 1, `a credential is not resent with under the floor left (${resendLate.legs.filter((l) => l.paid).length} paid sends)`);
  ok(resendLate.out.committed === true && resendLate.heldDelta === 1000n, "the one payment that left stays held");
  const resendEarly = await run({ deadlineMs: 25_000, legMs: 2700, paidAnswer: byName });
  ok(resendEarly.legs.filter((l) => l.paid).length === 2 && resendEarly.legs[2]?.both === true, "CONTROL: with time left the credential is resent once under both header names");
  ok(resendEarly.asked[2] === 25_000 - 5400, `the resend takes what is left too (${resendEarly.asked[2]})`);
  buyer.releaseSpend(2000n, { window: -1 });
}

// --- 1b. route-execute hands the payer the request's own deadline ------------
{
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const cand = (net) => ({ seller: "https://s.example", slug: "x", url: "https://s.example/x", method: "POST", price: "$0.002", networks: [net] });
  const run = async ({ network, chains, reqExtra = {}, env = {} }) => {
    guard.__reset();
    const prev = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    let seen = null;
    const exec = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: EXEC_TIERS[0],
      resolveExternal: async () => [cand(network)],
      payExternal: async (_u, opts) => { seen = { timeoutMs: opts.timeoutMs, deadlineMs: opts.deadlineMs }; return { result: { ok: 1 }, quote: { usd: 0.002 }, receipt: { transaction: "0xab" } }; },
      externalEnabled: () => true, externalChains: () => chains, spendingWalletStatus: () => null, recordPurchase: () => true,
    });
    const req = { ip: "198.51.100.3", header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ network, payload: {} })).toString("base64") : undefined), ...reqExtra };
    const out = await exec.handler({ task: "t", include: "external" }, req).then((r) => ({ status: 200, sellerPaid: r.receipt.sellerPaid !== false }), (e) => ({ status: e.statusCode, message: e.message }));
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return { out, seen, booked: req.__externalSpend ? 1 : 0 };
  };
  const sol = await run({ network: SOL, chains: ["solana"], env: { SOR_SVM_BUDGET_MS: "40000" } });
  ok(sol.out.status === 200 && Number.isFinite(sol.seen?.deadlineMs) && sol.seen.deadlineMs > 0 && sol.seen.deadlineMs <= 40_000, `a Solana buyer's purchase carries one deadline inside its budget (${JSON.stringify(sol.seen)})`);
  const avm = await run({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", chains: ["algorand"], env: { SOR_AVM_BUDGET_MS: "16000" } });
  ok(avm.out.status === 200 && avm.seen?.deadlineMs > 0 && avm.seen.deadlineMs <= 16_000, `an Algorand buyer's purchase carries one deadline inside its budget (${JSON.stringify(avm.seen)})`);
  const evm = await run({ network: "eip155:8453", chains: ["base"] });
  ok(evm.out.status === 200 && evm.seen && evm.seen.deadlineMs === undefined && evm.seen.timeoutMs === undefined, `CONTROL: an EVM buyer off the proxy keeps the payer's own per-request timeout (${JSON.stringify(evm.seen)})`);
  // Through the proxy: 5 s of the answer window is kept for the answer itself.
  const cdnSpent = await run({ network: "eip155:8453", chains: ["base"], reqExtra: { cdnSyncDeadlineMs: Date.now() + 5500 } });
  ok(cdnSpent.out.status === 504 && cdnSpent.seen === null && /nothing was spent/i.test(cdnSpent.out.message || ""), `with the proxy's answer window spent the seller is not paid: 504 before the payer runs (${cdnSpent.out.status}, payer ${JSON.stringify(cdnSpent.seen)})`);
  ok(cdnSpent.booked === 0, "and nothing was booked against the buyer or the wallet");
  const cdnOpen = await run({ network: "eip155:8453", chains: ["base"], reqExtra: { cdnSyncDeadlineMs: Date.now() + 60_000 } });
  ok(cdnOpen.out.status === 200 && cdnOpen.seen?.deadlineMs > PAY_X402_MIN_LEG_MS && cdnOpen.seen.deadlineMs <= 55_000, `CONTROL: with the window open the seller is paid under one deadline inside it (${JSON.stringify(cdnOpen.seen)})`);
  guard.__reset();
}

// --- 2. A Solana hold is released only on proof the credential cannot land ---
// The chain is a stub the test scripts: what our RPC says about the blockhash,
// and the confirmed and finalized heights it reports.
{
  const sol = await import("../src/solana-buyer.js");
  const { confirmSvmNotDebited, createSvmPaymentPayload, SVM_BLOCKHASH_LIFE_BLOCKS: LIFE, SVM_EXPIRY_MARGIN_BLOCKS: MARGIN } = sol;
  const kit = await import("@solana/kit");
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const W = "5xVcvJQ6jLe5tYv7aYQ4gCXoR1yzz9Vc3Nc7qF2wD1Zd";
  const nowS = Math.floor(Date.now() / 1000);
  const balRow = (amt) => ({ mint: SOL_USDC, owner: W, uiTokenAmount: { amount: String(amt) } });
  const debitTx = { meta: { err: null, preTokenBalances: [balRow(1000000)], postTokenBalances: [balRow(995000)] } };
  // script(poll) -> { valid, confirmed: { slot, height }, finalized: { slot, height }, sigs?, epoch? }
  const chain = (script) => {
    const calls = [];
    let poll = 0, validReads = 0;
    const state = () => script(poll);
    const rpc = async (_u, init) => {
      const { method, params } = JSON.parse(init.body);
      calls.push({ method, opts: params?.[1] ?? params?.[0] ?? null });
      const st = state();
      const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "getTokenAccountsByOwner") return reply({ value: [{ pubkey: "ATA" }] });
      if (method === "isBlockhashValid") { validReads++; return reply({ context: { slot: params[1]?.commitment === "finalized" ? st.finalized.slot : st.confirmed.slot }, value: st.valid }); }
      if (method === "getEpochInfo") { if (st.epoch !== undefined) return reply(st.epoch); const c = params[0]?.commitment === "finalized" ? st.finalized : st.confirmed; return reply({ absoluteSlot: c.slot, blockHeight: c.height }); }
      if (method === "getSignaturesForAddress") { poll++; return reply(st.sigs || []); }
      if (method === "getTransaction") return reply(debitTx);
      return reply(null);
    };
    return { rpc, calls, polls: () => poll, validReads: () => validReads };
  };
  let t = 0;
  const base = { wallet: W, sinceUnix: nowS - 10, blockhash: "SELLERHASH", pollMs: 0, now: () => (t += 1000), sleep: async () => {}, maxWaitMs: 30_000 };
  const run = async (script, extra = {}) => { t = 0; const c = chain(script); const verdict = await confirmSvmNotDebited({ ...base, ...extra, fetchImpl: c.rpc }).then((v) => v, (e) => ({ threw: e.message })); return { verdict, ...c }; };
  const H = 250_000_000;

  // The review's case: a blockhash our RPC has not reached reads invalid at once.
  const unseen = await run(() => ({ valid: false, confirmed: { slot: 900, height: H }, finalized: { slot: 870, height: H - 30 } }));
  ok(unseen.verdict.debited === false && unseen.verdict.expired === false, `a blockhash our RPC never reported valid is pending at the bound, never expired (${JSON.stringify(unseen.verdict)})`);
  ok(unseen.validReads() > 1, `it was read again on every poll (${unseen.validReads()} reads), not taken on the first answer`);
  // Seen valid, then invalid on a node that is behind: the height has not passed.
  const flip = await run((p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: { slot: 870 + p, height: H - 30 + p } }));
  ok(flip.verdict.expired === false, `invalid readings while the finalized height is inside the blockhash's life are pending (${JSON.stringify(flip.verdict)})`);
  // CONTROL: seen valid, then the finalized chain passes the bound with margin.
  const proven = await run((p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: p < 3 ? { slot: 870, height: H - 30 } : { slot: 1200, height: H + LIFE + MARGIN + 1 } }));
  ok(proven.verdict.debited === false && proven.verdict.expired === true, `CONTROL: seen valid, then finalized past its last valid height plus the margin, nothing debited: expired (${JSON.stringify(proven.verdict)})`);
  const lastScan = proven.calls.filter((c) => c.method === "getSignaturesForAddress").pop();
  ok(lastScan?.opts?.minContextSlot === 1200 && lastScan.opts.commitment === "finalized", `the scan a release rests on is no older than the expiry reading (${JSON.stringify(lastScan?.opts)})`);
  const boundRead = proven.calls.find((c) => c.method === "getEpochInfo" && c.opts?.commitment === "confirmed");
  ok(boundRead?.opts?.minContextSlot === 900, `the bound is read at or after the slot the blockhash was seen valid at (${JSON.stringify(boundRead?.opts)})`);
  // Exactly at the margin is not past it.
  const edge = await run((p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: { slot: 1200, height: H + LIFE + MARGIN } }));
  ok(edge.verdict.expired === false, "a finalized height at the margin, not past it, is pending");
  // Our RPC still calls the blockhash valid at the finalized slot: pending.
  const stillValid = await run(() => ({ valid: true, confirmed: { slot: 900, height: H }, finalized: { slot: 1200, height: H + LIFE + MARGIN + 50 } }));
  ok(stillValid.verdict.expired === false, "a blockhash our RPC still reports valid is pending whatever the height reads");
  // A transfer that landed in the last valid blocks is in the final scan.
  const late = await run((p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: p < 2 ? { slot: 870, height: H - 30 } : { slot: 1200, height: H + LIFE + MARGIN + 1 }, sigs: p >= 2 ? [{ signature: "s9", blockTime: nowS }] : [] }));
  ok(late.verdict.debited === true && late.verdict.expired === undefined, `a debit in the scan taken at the expiry reading is charged, not expired (${JSON.stringify(late.verdict)})`);
  // An unreadable height is unknown, and unknown never releases.
  const unreadable = await run((p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: { slot: 1200, height: H + 500 }, epoch: p === 0 ? undefined : { absoluteSlot: "x" } }));
  ok(/getEpochInfo unreadable/.test(unreadable.verdict.threw || ""), `an unreadable height throws, so the caller keeps the hold (${JSON.stringify(unreadable.verdict)})`);
  // A blockhash our own RPC issued carries its exact last valid height.
  const own = await run((p) => ({ valid: false, confirmed: { slot: 900, height: H }, finalized: p < 2 ? { slot: 870, height: H + 100 } : { slot: 1300, height: H + 100 + MARGIN + 1 } }), { lastValidBlockHeight: H + 100 });
  ok(own.verdict.expired === true && own.polls() === 3, `our own blockhash expires on its own last valid height plus the margin (${JSON.stringify(own.verdict)}, ${own.polls()} polls)`);

  // What the signer records: our own RPC's height, never the seller's figure.
  const signer = await kit.generateKeyPairSigner();
  const facilitator = await kit.generateKeyPairSigner();
  const sellerWallet = await kit.generateKeyPairSigner();
  const sellerHash = kit.getBase58Decoder().decode(randomBytes(32));
  const ownHash = kit.getBase58Decoder().decode(randomBytes(32));
  const accept = (extra) => ({ scheme: "exact", network: sol.SOLANA_CAIP2, asset: SOL_USDC, amount: "3000", payTo: sellerWallet.address, maxTimeoutSeconds: 300, extra: { feePayer: facilitator.address, ...extra } });
  globalThis.fetch = async (_u, init) => {
    const { method } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "getLatestBlockhash" ? { context: { slot: 900 }, value: { blockhash: ownHash, lastValidBlockHeight: H + 150 } } : null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const theirs = await createSvmPaymentPayload(signer, { x402Version: 2, accepts: [accept({ recentBlockhash: sellerHash, lastValidBlockHeight: "1" })] });
  ok(theirs.recentBlockhash === sellerHash && theirs.lastValidBlockHeight === null, `a seller's blockhash carries no last valid height of the seller's (${theirs.lastValidBlockHeight})`);
  const ours = await createSvmPaymentPayload(signer, { x402Version: 2, accepts: [accept({ lastValidBlockHeight: "1" })] });
  ok(ours.recentBlockhash === ownHash && ours.lastValidBlockHeight === H + 150 && !Object.keys(ours).includes("lastValidBlockHeight"), `our own blockhash carries our RPC's last valid height, off the wire (${ours.lastValidBlockHeight})`);

  // THROUGH THE PAYER: the seller hands a blockhash, takes the paid request,
  // answers 400 at once, and our RPC says "invalid". Every hold stands.
  const { createServer } = await import("node:http");
  const keypair = new Uint8Array(64);
  const gen = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", gen.privateKey));
  keypair.set(pkcs8.slice(pkcs8.length - 32), 0);
  keypair.set(new Uint8Array(await crypto.subtle.exportKey("raw", gen.publicKey)), 32);
  process.env.SOLANA_UPSTREAM_BUYER_KEY = JSON.stringify([...keypair]);
  let rpcScript = () => ({});
  let rpcPoll = 0;
  const rpcSrv = createServer((req, res) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      const { method, params, id } = JSON.parse(buf);
      const st = rpcScript(rpcPoll);
      const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
      if (method === "getTokenAccountsByOwner") return reply({ value: [{ pubkey: "ATA" }] });
      if (method === "isBlockhashValid") return reply({ context: { slot: params[1]?.commitment === "finalized" ? st.finalized.slot : st.confirmed.slot }, value: st.valid });
      if (method === "getEpochInfo") { const c = params[0]?.commitment === "finalized" ? st.finalized : st.confirmed; return reply({ absoluteSlot: c.slot, blockHeight: c.height }); }
      if (method === "getSignaturesForAddress") { rpcPoll++; return reply([]); }
      return reply(null);
    });
  });
  await new Promise((r) => rpcSrv.listen(0, "127.0.0.1", r));
  const prevRpc = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpcSrv.address().port}`;
  const ch = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept({ recentBlockhash: sellerHash, lastValidBlockHeight: "1" })] })).toString("base64");
  let paidSends = 0;
  const seller = createServer((req, res) => {
    req.resume();
    const pay = req.headers["payment-signature"] || req.headers["x-payment"];
    res.setHeader("content-type", "application/json");
    if (!pay) { res.statusCode = 402; res.setHeader("payment-required", ch); res.end("{}"); return; }
    paidSends++; res.statusCode = 400; res.end(JSON.stringify({ error: "bad request" }));
  });
  await new Promise((r) => seller.listen(0, "127.0.0.1", r));
  globalThis.fetch = origFetch;
  const buy = (refusalMaxWaitMs) => buyer.payX402(`http://127.0.0.1:${seller.address().port}/x`, { maxAtomic: 5000n, method: "POST", body: {}, chain: "solana", sellerProof: async () => 25, refusalMaxWaitMs }).then(() => null, (e) => e);
  rpcScript = () => ({ valid: false, confirmed: { slot: 900, height: H }, finalized: { slot: 870, height: H - 30 } });
  let held = buyer._spentThisWindow();
  const attack = await buy(50);
  ok(paidSends === 1 && attack && attack.committed === true && attack.refused !== true, `through the payer: "invalid" right after signing keeps the payment committed (committed ${attack?.committed}, refused ${attack?.refused}, ${attack?.message})`);
  ok(buyer._spentThisWindow() === held + 3000n, `and the hold stands (${buyer._spentThisWindow() - held} atomic held)`);
  // CONTROL, same seller: once our RPC has seen the blockhash valid and the
  // finalized chain is past its life, the same refusal releases the hold.
  rpcPoll = 0;
  rpcScript = (p) => ({ valid: p === 0, confirmed: { slot: 900, height: H }, finalized: p === 0 ? { slot: 870, height: H - 30 } : { slot: 1200, height: H + LIFE + MARGIN + 1 } });
  held = buyer._spentThisWindow();
  const honest = await buy(30_000);
  ok(honest && honest.committed === false && honest.refused === true, `CONTROL: proof of expiry releases it (committed ${honest?.committed}, refused ${honest?.refused})`);
  ok(buyer._spentThisWindow() === held, "and that hold is given back");
  seller.close(); rpcSrv.close();
  if (prevRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = prevRpc;
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
