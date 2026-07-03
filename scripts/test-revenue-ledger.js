// All-time revenue ledger — offline unit tests. Uses a throwaway DB via
// REVENUE_LEDGER_DB (set BEFORE the module loads), no network: exercises
// recordTransfer idempotency, external/internal accounting in
// ledgerSummary, per-chain splits, and the "don't start in CI" gate.
//
//   node scripts/test-revenue-ledger.js
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-ledger-"));
process.env.REVENUE_LEDGER_DB = join(dir, "test-revenue.db");

const { recordTransfer, ledgerSummary, startRevenueLedger } = await import("../src/revenue-ledger.js");

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

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
