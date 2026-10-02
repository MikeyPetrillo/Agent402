// The marketplace activity scanners must report what a wallet actually did,
// not what their own paging bound happened to allow.
//
// The defect this pins, measured on production 2026-09-20: /base?seller=... for
// the busiest seller on the chain reported exactly 10,000 transactions and
// $129.90 of volume. The real figures for that same wallet and window were
// 30,253 transfers and $332.18 - an independent count (Coinbase Bazaar's own
// measurement, 29,296 calls) agreed with the larger number, not ours. Every
// scanner was bounded by `maxPages = 10`, and at a thousand records a page that
// is a hard ceiling of 10,000 that no wallet can ever be reported past. The
// walks were already keyset (each source's own cursor); only the bound was
// wrong, and it sat exactly where a real figure used to be.
//
// A page COUNT is the wrong bound: it is a proxy for cost that drifts with the
// page size a source returns and silently becomes a ceiling on the answer. The
// bound is a wall-clock budget now, so what stops a long walk is what a page
// load can afford, and a walk stopped early says `truncated: true` instead of
// passing a floor off as a total.
//
// Offline: every source is a stub, so this spends nothing and needs no key.
//
//   node scripts/test-scan-cap.js
process.env.ALCHEMY_API_KEY ||= "stub-key-not-a-real-credential";

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const { evmActivity, stellarActivity, algorandActivity, solanaActivity, mergeScanEntries, USDC_ISSUER } = await import("../src/revenue-live.js");

const DAY = 86_400_000;
const realFetch = globalThis.fetch;
let calls = 0;

// ---------------------------------------------------------------------------
// Stub sources. Each serves `total` records inside the window, `pageSize` at a
// time behind its own cursor, then one record past the cutoff so a walk that
// reaches the far edge terminates the way the real source would.
// ---------------------------------------------------------------------------
const PAGE = 1000;

// Block numbers run DOWNWARD with the index, because the scan walks
// newest-first: row 0 is the newest transfer and sits at the highest block.
const blockOf = (i) => 1_000_000 - i;
function evmPage(total, cursor, fromBlock = 0, extraNew = 0) {
  // A NEGATIVE index is a transfer that landed after the prior scan: higher
  // block, own uid, newest-first so it leads the page. Appending at the far
  // end instead would be an OLDER transfer, which is not what "arrived since"
  // means and would let a resume that never advances still pass.
  const first = -extraNew;
  const start = cursor ? Number(cursor) : first;
  const transfers = [];
  for (let i = start; i < Math.min(start + PAGE, total); i++) {
    if (blockOf(i) < fromBlock) break;                    // the source honours fromBlock
    transfers.push({
      value: 0.001,
      uniqueId: `0xhash${i}:log:0`,
      blockNum: "0x" + blockOf(i).toString(16),
      // Math.abs: a NEGATIVE index (a transfer that arrived since) would give a
      // negative modulus and so a FUTURE timestamp, which the bucketer drops -
      // the rows would be fetched and then silently vanish from the totals.
      from: `0x${String(Math.abs(i) % 37).padStart(40, "0")}`,   // 37 distinct buyers
      metadata: { blockTimestamp: new Date(Date.now() - (Math.abs(i) % 20) * DAY).toISOString() },
    });
  }
  const next = start + PAGE;
  if (next >= total) {
    // Past the window: the real source keeps going, the walk must stop here.
    transfers.push({ value: 0.001, from: "0x" + "9".repeat(40), metadata: { blockTimestamp: new Date(Date.now() - 400 * DAY).toISOString() } });
    return { transfers, pageKey: "beyond" };
  }
  return { transfers, pageKey: String(next) };
}

function installStub({ total, delayMs = 0, extraNew = 0 }) {
  calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;

    if (body?.method === "alchemy_getAssetTransfers") {
      const p = body.params[0];
      return json({ jsonrpc: "2.0", id: 1, result: evmPage(total, p.pageKey, Number.parseInt(p.fromBlock, 16) || 0, extraNew) });
    }
    if (u.includes("horizon")) {                                  // Stellar
      const m = /cursor=(\d+)/.exec(u);
      const start = m ? Number(m[1]) : 0;
      const records = [];
      for (let i = start; i < Math.min(start + PAGE, total); i++) {
        records.push({ type: "payment", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.001",
          from: `G${String(i % 37).padStart(55, "A")}`, to: "GWALLET", transaction_hash: `h${i}`,
          created_at: new Date(Date.now() - (i % 20) * DAY).toISOString() });
      }
      const next = start + PAGE;
      if (next >= total) records.push({ type: "payment", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.001",
        from: "GOLD", to: "GWALLET", transaction_hash: "hold", created_at: new Date(Date.now() - 400 * DAY).toISOString() });
      return json({ _embedded: { records }, _links: { next: { href: `https://horizon.stellar.org/next?cursor=${next}` } } });
    }
    if (u.includes("/transactions?")) {                            // Algorand indexer
      const m = /[?&]next=(\d+)/.exec(u);
      const start = m ? Number(m[1]) : 0;
      const transactions = [];
      for (let i = start; i < Math.min(start + PAGE, total); i++) {
        transactions.push({ id: `t${i}`, sender: `SENDER${i % 37}`, "round-time": Math.floor((Date.now() - (i % 20) * DAY) / 1000),
          "asset-transfer-transaction": { "asset-id": 31566704, receiver: "AWALLET", amount: 1000 } });
      }
      const next = start + PAGE;
      return json(next >= total ? { transactions } : { transactions, "next-token": String(next) });
    }
    if (body?.method === "getTokenAccountsByOwner") return json({ jsonrpc: "2.0", id: 1, result: { value: [{ pubkey: "TOKENACCT" }] } });
    if (body?.method === "getSignaturesForAddress") {
      // One page of signatures, newest first, then one past the cutoff so the
      // walk terminates at the window edge the way the real source would.
      const before = body.params[1]?.before;
      const start = before ? Number(String(before).replace("sig", "")) + 1 : 0;
      const value = [];
      for (let i = start; i < Math.min(start + PAGE, total); i++) {
        value.push({ signature: `sig${i}`, blockTime: Math.floor((Date.now() - (i % 20) * DAY) / 1000), err: null });
      }
      if (start + PAGE >= total) value.push({ signature: "sigold", blockTime: Math.floor((Date.now() - 400 * DAY) / 1000), err: null });
      return json({ jsonrpc: "2.0", id: 1, result: value });
    }
    if (body?.method === "getTransaction") {
      const i = Number(String(body.params[0]).replace("sig", "")) || 0;
      return json({ jsonrpc: "2.0", id: 1, result: {
        blockTime: Math.floor((Date.now() - (i % 20) * DAY) / 1000),
        meta: {
          preTokenBalances: [{ owner: "SWALLET", mint: USDC_SOL_MINT, uiTokenAmount: { uiAmount: 0 } },
                             { owner: `BUYER${i % 37}`, mint: USDC_SOL_MINT, uiTokenAmount: { uiAmount: 1 } }],
          postTokenBalances: [{ owner: "SWALLET", mint: USDC_SOL_MINT, uiTokenAmount: { uiAmount: 0.001 } },
                              { owner: `BUYER${i % 37}`, mint: USDC_SOL_MINT, uiTokenAmount: { uiAmount: 0.999 } }],
        },
      } });
    }
    return json({});
  };
}
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const restore = () => { globalThis.fetch = realFetch; };

// ---------------------------------------------------------------------------
// CONTROL FIRST. A clean sweep below is only believable once the harness has
// been shown to catch the real defect, so reproduce it: hold the walker to the
// old ten-page bound and require the stub's 25,000 records to come back as
// exactly 10,000. If this ever stops reporting 10,000 the stub is not paging
// and every assertion after it is measuring nothing.
// ---------------------------------------------------------------------------
const TOTAL = 25_000;
installStub({ total: TOTAL });

const old = await evmActivity("base", "0xwallet", { maxPages: 10, budgetMs: 60_000 });
ok(old.totals.tx === 10_000, `control: the old ten-page bound reports exactly 10,000 of ${TOTAL.toLocaleString()} (got ${old.totals.tx}) - the harness can see the defect`);
ok(old.truncated === true, `control: that capped walk admits truncated:true (got ${old.truncated})`);
ok(calls >= 10, `control: the stub actually paged (${calls} fetches)`);

// ---------------------------------------------------------------------------
// The regression itself.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL });
const full = await evmActivity("base", "0xwallet", { budgetMs: 60_000 });
ok(full.totals.tx === TOTAL, `evm: a wallet with ${TOTAL.toLocaleString()} transfers in the window reports all of them (got ${full.totals.tx})`);
ok(full.totals.tx > 10_000, `evm: the reported total is past the old 10,000 ceiling (got ${full.totals.tx})`);
ok(full.truncated === false, `evm: a walk that reached the window edge is NOT truncated (got ${full.truncated})`);
ok(full.totals.buyers === 37, `evm: distinct buyers counted across every page, not just the first ten (got ${full.totals.buyers})`);
ok(Math.abs(full.totals.usd - TOTAL * 0.001) < 0.01, `evm: volume is the whole window too (got $${full.totals.usd.toFixed(2)})`);

// The walk must stop at the window edge rather than run to the page backstop.
ok(calls <= TOTAL / PAGE + 2, `evm: stopped at the cutoff, not at the backstop (${calls} fetches for ${TOTAL / PAGE} pages of data)`);

// ---------------------------------------------------------------------------
// The bound is the clock, and a walk it stops says so.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL, delayMs: 30 });
const starved = await evmActivity("base", "0xwallet", { budgetMs: 120 });
ok(starved.truncated === true, `evm: a walk the budget stops reports truncated:true (got ${starved.truncated})`);
ok(starved.totals.tx > 0 && starved.totals.tx < TOTAL, `evm: and returns an honest partial floor, never zero and never the total (got ${starved.totals.tx})`);

// A budget large enough for the whole walk must not truncate just because it
// was generous - truncation tracks a pending cursor, not elapsed time.
installStub({ total: 2000 });
const small = await evmActivity("base", "0xwallet", { budgetMs: 60_000 });
ok(small.totals.tx === 2000 && small.truncated === false, `evm: a wallet inside one budget is complete and unflagged (got ${small.totals.tx}, truncated=${small.truncated})`);

// ---------------------------------------------------------------------------
// Same class, same bound: the other two paged walkers shared `maxPages = 10`.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL });
const alg = await algorandActivity("AWALLET", { budgetMs: 60_000 });
ok(!alg.error, `algorand: stub scan succeeded (${alg.error || "no error"})`);
ok(alg.totals.tx === TOTAL, `algorand: reports all ${TOTAL.toLocaleString()} transfers, not 10,000 (got ${alg.totals.tx})`);
ok(alg.truncated === false, `algorand: a completed walk is not truncated (got ${alg.truncated})`);

installStub({ total: TOTAL, delayMs: 30 });
const algStarved = await algorandActivity("AWALLET", { budgetMs: 120 });
ok(algStarved.truncated === true, `algorand: a budget-stopped walk reports truncated:true (got ${algStarved.truncated})`);

installStub({ total: 5000 });
const stl = await stellarActivity("GWALLET", { budgetMs: 60_000 });
ok(!stl.error, `stellar: stub scan succeeded (${stl.error || "no error"})`);
ok(stl.totals.tx === 5000, `stellar: reports all 5,000 payments, past the old 10-page x 200 = 2,000 ceiling (got ${stl.totals.tx})`);
ok(stl.truncated === false, `stellar: a completed walk is not truncated (got ${stl.truncated})`);

installStub({ total: 5000, delayMs: 30 });
const stlStarved = await stellarActivity("GWALLET", { budgetMs: 120 });
ok(stlStarved.truncated === true, `stellar: a budget-stopped walk reports truncated:true (got ${stlStarved.truncated})`);

// ---------------------------------------------------------------------------
// Incremental resume. The scan used to re-walk the window from block 0 on
// every refresh, so a busy wallet re-paid for thirty days of history every ten
// minutes. Measured on the real busiest Base wallet: 31 calls / 7.1s cold,
// 1 call / 98ms resumed, identical totals.
// ---------------------------------------------------------------------------
installStub({ total: 5000 });
const cold = await evmActivity("base", "0xwallet", { budgetMs: 60_000 });
const coldCalls = calls;
ok(cold.resumed === false, "a scan with no prior state is a full scan");
ok(coldCalls >= 5, `control: the cold scan really paged (${coldCalls} calls)`);
ok(!!cold.__scanState, "a completed scan publishes the state its successor resumes from");
ok(Object.keys(cold).indexOf("__scanState") === -1 && !JSON.stringify(cold).includes("__scanState"),
  "that state is non-enumerable: it never reaches a response body, a cache file or a log");

installStub({ total: 5000 });
const warm = await evmActivity("base", "0xwallet", { budgetMs: 60_000, prior: cold.__scanState });
ok(warm.resumed === true, "a scan with complete prior state resumes");
ok(calls < coldCalls, `a resumed scan costs fewer calls than the cold one (${calls} vs ${coldCalls})`);
ok(calls <= 2, `a resumed scan with nothing new costs about one call (got ${calls})`);
ok(warm.totals.tx === cold.totals.tx, `resuming reports the same transactions as a full scan (${warm.totals.tx} vs ${cold.totals.tx})`);
ok(warm.totals.buyers === cold.totals.buyers, "resuming reports the same distinct buyers");
ok(Math.abs(warm.totals.usd - cold.totals.usd) < 1e-6, "resuming reports the same volume - the overlap is deduplicated, not double-counted");

installStub({ total: 5000, extraNew: 200 });
const grown = await evmActivity("base", "0xwallet", { budgetMs: 60_000, prior: cold.__scanState });
ok(grown.totals.tx === cold.totals.tx + 200, `a resumed scan picks up the transfers that arrived since (${grown.totals.tx} = ${cold.totals.tx} + 200)`);
ok(grown.resumed === true, "and it still resumed rather than silently rescanning to find them");

// A TRUNCATED prior never held the far end of the window, so resuming from it
// would freeze that gap in place forever. It must force a full rescan.
installStub({ total: TOTAL, delayMs: 30 });
const partial = await evmActivity("base", "0xwallet", { budgetMs: 120 });
ok(partial.truncated === true, "control: that prior really is truncated");
installStub({ total: TOTAL });
const afterPartial = await evmActivity("base", "0xwallet", { budgetMs: 60_000, prior: partial.__scanState });
ok(afterPartial.resumed === false, "a truncated prior is never resumed - the gap would never be filled");
ok(afterPartial.totals.tx === TOTAL, `the forced rescan covers the whole window (${afterPartial.totals.tx})`);

installStub({ total: 5000 });
const stale = await evmActivity("base", "0xwallet", { budgetMs: 60_000, prior: { ...cold.__scanState, at: Date.now() - 400 * DAY } });
ok(stale.resumed === false, "a prior older than the window is discarded rather than resumed");

// mergeScanEntries is where a wrong merge would double-count silently.
const cut = Date.now() - 30 * DAY;
const row = (uid, ageDays, usd = 1) => ({ uid, usd, from: "0xa", when: new Date(Date.now() - ageDays * DAY).toISOString() });
ok(mergeScanEntries([row("a", 1)], [row("a", 1)], cut).length === 1, "merge: the same uid from both sides counts once");
ok(mergeScanEntries([row("a", 1)], [row("b", 2)], cut).length === 2, "merge: distinct uids are both kept");
ok(mergeScanEntries([], [row("old", 90)], cut).length === 0, "merge: a prior row now past the window is dropped");
ok(mergeScanEntries([row("n", 1)], [row("o", 400)], cut).map((e) => e.uid).join() === "n", "merge: pruning keeps the fresh row and drops the expired one");
ok(mergeScanEntries([{ usd: 1, when: new Date().toISOString() }], [], cut).length === 1, "merge: a row with no uid is kept rather than dropped");
ok(mergeScanEntries([row("x", 1)], [row("y", 1)], cut)[0].uid === "x", "merge: fresh rows lead, so the newest data wins on any tie");

// Solana is bounded per TRANSACTION rather than per page, so its old ceiling
// was a far tighter sixty records - the same class of defect, a different
// number. The clock is the bound there now and maxTx is only a backstop.
installStub({ total: 400 });
const sol = await solanaActivity("SWALLET", { budgetMs: 60_000 });
ok(!sol.error, `solana: stub scan succeeded (${sol.error || "no error"})`);
ok(sol.totals.tx === 400, `solana: reports all 400 transfers, past the old hard 60-transaction cap (got ${sol.totals.tx})`);
ok(sol.totals.tx > 60, `solana: the reported total is past the old ceiling (got ${sol.totals.tx})`);
ok(sol.truncated === false, `solana: a completed walk is not truncated (got ${sol.truncated})`);

installStub({ total: 400, delayMs: 20 });
const solStarved = await solanaActivity("SWALLET", { budgetMs: 150 });
ok(solStarved.truncated === true, `solana: a budget-stopped walk reports truncated:true (got ${solStarved.truncated})`);
ok(solStarved.totals.tx < 400, `solana: and returns an honest partial floor (got ${solStarved.totals.tx})`);

restore();
console.log(`\n${pass} passed`);
