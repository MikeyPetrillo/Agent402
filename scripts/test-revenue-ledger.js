// All-time revenue ledger — offline unit tests. Uses a throwaway DB via
// REVENUE_LEDGER_DB (set BEFORE the module loads), no network: exercises
// recordTransfer idempotency, external/internal accounting in
// ledgerSummary, per-chain splits, and the "don't start in CI" gate.
//
//   node scripts/test-revenue-ledger.js
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-ledger-"));
process.env.REVENUE_LEDGER_DB = join(dir, "test-revenue.db");
// The ledger folds Tempo settlements in from the sales ledger; isolate it.
process.env.SALES_LEDGER_DB = join(dir, "test-sales.db");

const { recordTransfer, ledgerSummary, startRevenueLedger, ledgerDaily, ledgerNewestOwn } = await import("../src/revenue-ledger.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const W = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const SW = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
const wallets = { walletAddress: W, solanaWallet: SW };

// --- empty ledger ------------------------------------------------------------
let s = ledgerSummary(wallets);
ok(s.allTimeExternalUsd === 0 && s.allTimeExternalCount === 0, "empty ledger sums to zero");
ok(s.perChain.base && s.perChain.solana && s.perChain.robinhood, "summary covers every rail incl. solana");
ok(s.syncing === true, "no cursors yet → reported as syncing");

// --- external vs internal accounting ----------------------------------------
recordTransfer({ chain: "base", wallet: W, txid: "0xaaa:1", tx_hash: "0xaaa", block: 100, payer: "0x1111111111111111111111111111111111111111", usd: 0.01, asset: "USDC", external: true });
recordTransfer({ chain: "base", wallet: W, txid: "0xbbb:0", tx_hash: "0xbbb", block: 101, payer: "0xfeda7403aabe9a492ed70e810b396d8548a4a022", usd: 0.001, asset: "USDC", external: false });
recordTransfer({ chain: "base", wallet: W, txid: "0xccc:0", tx_hash: "0xccc", block: 102, payer: "0x2222222222222222222222222222222222222222", usd: 25, asset: "USDC", external: false }); // funding, over ceiling
recordTransfer({ chain: "robinhood", wallet: W, txid: "0xddd:0", tx_hash: "0xddd", block: 50, payer: "0xfeda7403aabe9a492ed70e810b396d8548a4a022", usd: 0.001, asset: "USDG", external: false });
recordTransfer({ chain: "solana", wallet: SW, txid: "sig1", tx_hash: "sig1", block: 999, when_ts: 1780000000, payer: "SomeExternalBuyer1111111111111111111111111111", usd: 0.05, asset: "USDC", external: true });

s = ledgerSummary(wallets);
ok(Math.abs(s.allTimeExternalUsd - 0.06) < 1e-9, `external total counts only external rows (got $${s.allTimeExternalUsd})`);
ok(s.allTimeExternalCount === 2, `external count is 2 (got ${s.allTimeExternalCount})`);
ok(Math.abs(s.perChain.base.inboundUsd - 25.011) < 1e-9, "base inbound includes internal + funding rows");
ok(s.perChain.base.externalUsd === 0.01 && s.perChain.base.externalCount === 1, "base external split correct");
ok(s.perChain.robinhood.externalUsd === 0 && s.perChain.robinhood.inboundCount === 1, "robinhood canary buy stays internal");
ok(s.perChain.solana.externalUsd === 0.05, "solana external tracked");

// --- our own newest settle: internal, call-sized, never a buyer or funding ----
{
  const own = ledgerNewestOwn("base", W);
  ok(own && own.txHash === "0xbbb" && own.usd === 0.001, `newest own settle is the canary row, not the newer $25 funding row or a buyer (got ${own?.txHash})`);
  ok(ledgerNewestOwn("solana", SW) === null, "a rail with only outside payments has no own settle");
  ok(ledgerNewestOwn("base", W.toUpperCase().replace("0X", "0x")) ?.txHash === "0xbbb", "EVM wallet case is folded like ledgerRecent");
}

// --- idempotency: replaying the same rows must not double-count ---------------
recordTransfer({ chain: "base", wallet: W, txid: "0xaaa:1", tx_hash: "0xaaa", block: 100, payer: "0x1111111111111111111111111111111111111111", usd: 0.01, asset: "USDC", external: true });
recordTransfer({ chain: "solana", wallet: SW, txid: "sig1", tx_hash: "sig1", block: 999, payer: "SomeExternalBuyer1111111111111111111111111111", usd: 0.05, asset: "USDC", external: true });
s = ledgerSummary(wallets);
ok(Math.abs(s.allTimeExternalUsd - 0.06) < 1e-9 && s.allTimeExternalCount === 2, "re-recording the same txids is a no-op (rescan-safe)");

// --- same tx hash, different log index = two real transfers -------------------
recordTransfer({ chain: "base", wallet: W, txid: "0xaaa:2", tx_hash: "0xaaa", block: 100, payer: "0x1111111111111111111111111111111111111111", usd: 0.02, asset: "USDC", external: true });
s = ledgerSummary(wallets);
ok(Math.abs(s.perChain.base.externalUsd - 0.03) < 1e-9, "distinct log index in the same tx counts separately");

// --- wallet scoping ------------------------------------------------------------
const other = ledgerSummary({ walletAddress: "0x9999999999999999999999999999999999999999", solanaWallet: null });
ok(other.allTimeExternalUsd === 0, "summary is scoped to the requested wallet");

// --- CI gate: loop must refuse to start without /data or the env force --------
delete process.env.REVENUE_LEDGER;
if (!existsSync("/data")) {
  ok(startRevenueLedger(wallets) === false, "sync loop self-gates off without /data or REVENUE_LEDGER=true");
} else {
  console.log("(/data exists on this machine — gate check skipped)");
}

// --- settled-to (SOR) split in the daily series ------------------------------
// Rows received by the spending wallet (baseExtraWallets) must land in the
// extSor/intSor fields AS A SUBSET of ext/int - the /revenue SOR filter's
// All === SOR + Direct identity depends on it.
{
  const SORW = "0x77065d81e18ad403bcd6e9a0616b288e16744121";
  recordTransfer({ chain: "base", wallet: SORW, txid: "0xeee:0", tx_hash: "0xeee", block: 103, when_ts: 1781956800, payer: "0x3333333333333333333333333333333333333333", usd: 0.05, asset: "USDC", external: true });
  recordTransfer({ chain: "base", wallet: W, txid: "0xfff:0", tx_hash: "0xfff", block: 104, when_ts: 1781956800, payer: "0x4444444444444444444444444444444444444444", usd: 0.01, asset: "USDC", external: true });
  const daily = ledgerDaily({ ...wallets, baseExtraWallets: [SORW] });
  const day = daily.find((d) => d.chain === "base" && d.day === "2026-06-20");
  ok(!!day, "seeded base day appears in the daily series");
  ok(day && Math.abs(day.extSorUsd - 0.05) < 1e-9 && day.extSorTx === 1, "spending-wallet inbound lands in the SOR fields");
  ok(day && day.extUsd >= day.extSorUsd && day.extTx >= day.extSorTx, "SOR is a subset of external, never a separate count");
  const treasuryOnly = ledgerDaily(wallets);
  ok(treasuryOnly.every((d) => !(d.extSorUsd > 0 || d.intSorUsd > 0)), "no extra wallets configured -> SOR fields stay zero");

  // Algorand chain-matched self-funding: the AVM spending wallet's inbound
  // joins the SOR lane WITHOUT case-folding (folding a base58-family address
  // merges distinct wallets - same rule as src/payer.js).
  const AVMW = "W4GZHN36X35LGSJTTLNZNFPGSSBLMJKFLCMZK4NBLQGUS6PYPPCDB67UOE";
  recordTransfer({ chain: "algorand", wallet: AVMW, txid: "ALGOTX1", tx_hash: "ALGOTX1", block: 200, when_ts: 1781956800, payer: "SOMEALGOBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", usd: 0.02, asset: "USDC", external: true });
  const withAvm = ledgerDaily({ ...wallets, algorandWallet: "ALGOTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", algorandExtraWallets: [AVMW] });
  const algoDay = withAvm.find((d) => d.chain === "algorand" && d.day === "2026-06-20");
  ok(!!algoDay && Math.abs(algoDay.extSorUsd - 0.02) < 1e-9, "AVM spending-wallet inbound lands in the SOR fields, address never case-folded");
}

// --- getLogs chunk sizing honors the per-chain RPC range cap -------------------
// Sei's RPCs reject ranges over ~2,000 blocks; ignoring chunkBlocks here made
// every Sei sync tick fail and the cursor never advance (zero rows ever
// despite daily canary settles, found 2026-07-30).
{
  const { ledgerChunkBlocks } = await import("../src/revenue-ledger.js");
  const { EVM } = await import("../src/revenue-live.js");
  ok(ledgerChunkBlocks(EVM.sei) === 1900, `sei chunks at its declared 1,900-block RPC cap (got ${ledgerChunkBlocks(EVM.sei)})`);
  ok(ledgerChunkBlocks(EVM.sei) <= (EVM.sei.chunkBlocks || 9000), "sei chunk never exceeds the declared cap");
  ok(ledgerChunkBlocks(EVM.robinhood) === 9000, `chains without a declared cap keep the 9,000 ceiling (got ${ledgerChunkBlocks(EVM.robinhood)})`);
  ok(ledgerChunkBlocks(EVM.optimism) === Math.ceil(EVM.optimism.span / 4), "short-span chains still chunk at span/4");
  for (const [name, c] of Object.entries(EVM)) {
    ok(ledgerChunkBlocks(c) <= (c.chunkBlocks || 9000), `${name} ledger chunk respects its RPC range cap`);
  }
}

// --- an EMPTY page must record "caught up" (2026-09-09) -----------------------
// Every scanner exited on an empty page BEFORE its cursor write, so a wallet
// whose last non-empty page was full kept caught_up=0 and a stale updated_ts
// until something new landed: /revenue read Algorand "still syncing" for ten
// hours with the scan complete. Seed the stale row, answer one empty page,
// and require the verdict + timestamp to move while the cursor itself stays.
{
  const { syncStellar, syncAlgorand, ledgerSyncState } = await import("../src/revenue-ledger.js");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.REVENUE_LEDGER_DB);
  const STW = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
  const ALW = "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE";
  const stale = 1700000000;
  db.prepare("INSERT OR REPLACE INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES (?,?,?,?,?,?,?)")
    .run("stellar", STW, null, "12345-1", 1, 0, stale);
  db.prepare("INSERT OR REPLACE INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES (?,?,?,?,?,?,?)")
    .run("algorand", ALW, 55000000, null, 1, 0, stale);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url); seen.push(u);
    if (/horizon/.test(u)) return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ transactions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const rs = await syncStellar(STW);
    const ra = await syncAlgorand(ALW);
    ok(rs.caughtUp === true && ra.caughtUp === true, "an empty page reports caught up from both scanners");
    const rows = Object.fromEntries(ledgerSyncState().map((r) => [r.chain, r]));
    ok(rows.stellar?.caughtUp === true && rows.stellar.staleSeconds < 60, `stellar: the cursor row now says caught up with a fresh timestamp (was stale caught_up=0)`);
    ok(rows.algorand?.caughtUp === true && rows.algorand.staleSeconds < 60, `algorand: the cursor row now says caught up with a fresh timestamp`);
    ok(rows.algorand?.nextBlock === 55000000, "the algorand cursor itself did not move on an empty page");
    ok(db.prepare("SELECT newest_sig FROM cursors WHERE chain='stellar'").get().newest_sig === "12345-1", "the stellar paging token did not move on an empty page");
    ok(seen.some((u) => /horizon/.test(u)) && seen.some((u) => /asset-id=31566704/.test(u)), "both scanners actually asked their upstream");
  } finally { globalThis.fetch = realFetch; db.close(); }
}

// --- Algorand: a descending indexer is walked to completion (2026-09-09) ------
// The indexer serves newest-first with no order parameter. The old loop bumped
// min-round past each page's newest round, so a full page skipped every older
// row between the cursor and that page - prod lost exactly 1,000 of 7,220
// inbound transfers. A fake indexer with the real semantics (min-round filter,
// newest-first, next-token) must yield every row, resume a walk cut by
// maxPages, and read only the tail on the next tick.
{
  const { syncAlgorand, ledgerSyncState, runLedgerMigrations } = await import("../src/revenue-ledger.js");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.REVENUE_LEDGER_DB);
  const ALW = "WALKTESTWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const PAYER = "SOMEALGOBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  let chain = []; // ascending rounds
  const addRows = (from, to) => { for (let r = from; r <= to; r++) chain.push({ id: `ALGOWALK${r}`, sender: PAYER, "confirmed-round": r, "round-time": 1790000000 + r, "asset-transfer-transaction": { "asset-id": 31566704, receiver: ALW, amount: 1000 } }); };
  addRows(1, 2300);
  const pagesServed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const minRound = Number(u.searchParams.get("min-round") || 0);
    const next = u.searchParams.get("next");
    const limit = Number(u.searchParams.get("limit") || 1000);
    const desc = chain.filter((x) => x["confirmed-round"] >= minRound).sort((a, b) => b["confirmed-round"] - a["confirmed-round"]);
    const start = next ? Number(next.replace("tok-", "")) : 0;
    const page = desc.slice(start, start + limit);
    pagesServed.push({ minRound, next, n: page.length });
    const body = { transactions: page };
    if (start + limit < desc.length) body["next-token"] = `tok-${start + limit}`;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE chain='algorand' AND wallet=?").get(ALW).n;
  const cursor = () => db.prepare("SELECT * FROM cursors WHERE chain='algorand' AND wallet=?").get(ALW);
  try {
    // A walk cut by maxPages persists its token and does not move the cursor.
    let r = await syncAlgorand(ALW, { maxPages: 1 });
    ok(r.caughtUp === false && count() === 1000, `a one-page walk holds 1,000 rows and is not caught up (got ${count()})`);
    ok(cursor().next_block === 0 && /tok-1000/.test(cursor().newest_sig || ""), "the cut walk keeps min-round and remembers its next-token");
    // The next tick resumes from the token and completes the walk.
    r = await syncAlgorand(ALW, { maxPages: 5 });
    ok(r.caughtUp === true && count() === 2300, `the resumed walk yields every row (got ${count()} of 2300)`);
    ok(cursor().next_block === 2301 && cursor().newest_sig === null && cursor().caught_up === 1, "a completed walk moves the cursor past the newest round and clears the token");
    ok(pagesServed.every((p) => p.minRound === 0), "min-round stays pinned for the whole walk");
    // New rows land; the next tick reads only the tail.
    addRows(2301, 2305);
    const before = pagesServed.length;
    r = await syncAlgorand(ALW);
    ok(r.caughtUp === true && count() === 2305, `the tail tick picks up the five new rows (got ${count()})`);
    ok(pagesServed.slice(before).every((p) => p.minRound === 2301) && pagesServed.slice(before)[0].n === 5, "the tail tick asks from the cursor and gets only the new rows");
    // The one-shot rescan migration resets the cursor once, then never again.
    db.prepare("DELETE FROM ledger_meta WHERE key = 'algorand-rescan-2026-09-09'").run();
    const applied = runLedgerMigrations();
    ok(applied.length === 1 && cursor().next_block === 0 && cursor().caught_up === 0, "the rescan migration resets the algorand cursor to round 0");
    ok(runLedgerMigrations().length === 0 && cursor().next_block === 0, "the migration is keyed and does not run twice");
    r = await syncAlgorand(ALW, { maxPages: 5 });
    ok(r.caughtUp === true && count() === 2305 && cursor().next_block === 2306, "the rescan re-walks the account and the primary key dedupes every row already held");
    const st = ledgerSyncState().find((x) => x.chain === "algorand" && x.wallet === ALW.slice(0, 10));
    ok(st?.caughtUp === true, "ledgerSyncState reads the completed walk as caught up");
  } finally { globalThis.fetch = realFetch; db.close(); }
}

// --- every wallet the summary folds is a wallet the tick scans (2026-09-09) -
// ledgerSummary() ANDs caught_up across the chain's wallets, so a wallet in the
// summary with no cursor row reads "not caught up" forever. The Algorand
// spending wallet was folded in and never scanned: /revenue showed Algorand
// "still syncing" with the treasury scan complete. Pin the tick's wallet set
// against the summary's from source, so the next extra wallet cannot repeat it.
{
  const src = readFileSync(new URL("../src/revenue-ledger.js", import.meta.url), "utf8");
  const tick = src.slice(src.indexOf("export function startRevenueLedger("), src.indexOf("revenue-ledger: sync loop started"));
  ok(/algorandExtraWallets\s*=\s*\[\]/.test(tick) && /for \(const w of algorandExtraWallets/.test(tick) && /syncAlgorand\(w\)/.test(tick), "the tick scans every algorandExtraWallets entry with syncAlgorand");
  ok(/for \(const w of baseExtraWallets/.test(tick) && /syncEvmChain\("base", w/.test(tick), "the tick scans every baseExtraWallets entry on base");
  const pairs = src.slice(src.indexOf("function walletPairs("), src.indexOf("}", src.indexOf("function walletPairs(")) + 1);
  for (const key of ["baseExtraWallets", "algorandExtraWallets"]) ok(pairs.includes(key) && tick.includes(key), `${key}: folded by the summary AND scanned by the tick`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
