// /revenue showed new settlements only on the SECOND refresh: the per-rail
// recent-transfer rows were read inside the hourly revenue snapshot, which is
// served stale while it rebuilds in the background. withFreshRecent re-reads
// those rows from the ledger on every request; only the balances stay cached.
import { readFileSync } from "node:fs";
import { withFreshRecent, EVM } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const W = "0x" + "ab".repeat(20);
const base = EVM.base;
const oldRow = { usd: 0.001, from: "0x" + "11".repeat(20), txHash: "0x" + "aa".repeat(32), block: 100, external: true };
const newRow = { usd: 0.05, from: "0x" + "22".repeat(20), txHash: "0x" + "bb".repeat(32), block: 200, external: true };
const snap = Object.freeze({
  asOf: "2026-09-28T22:00:00Z",
  rails: Object.freeze([
    Object.freeze({ rail: base.label, wallet: W, balance: 5, recentSource: "ledger", recent: [oldRow], externalUsd: 0.001 }),
    Object.freeze({ rail: "Solana", wallet: "So1ana", recentSource: undefined, recent: [{ usd: 1 }] }),
    Object.freeze({ rail: EVM.polygon.label, wallet: W, recentSource: "chain-scan", recent: [oldRow] }),
  ]),
});
const calls = [];
const ledger = (chain, wallet, opts) => { calls.push([chain, wallet, opts?.limit]); return chain === (base.ledgerChain || "base") ? [newRow, oldRow] : []; };

const out = withFreshRecent(snap, ledger);
const b = out.rails[0];
ok(b.recent.length === 2 && b.recent[0].txHash === newRow.txHash, "a settlement the ledger recorded after the snapshot was built shows on the first read");
ok(b.recent[0].tx === base.tx(newRow.txHash), "each fresh row carries its explorer link");
ok(b.externalUsd === 0.051, `the rail's outside total is recomputed from the fresh rows (${b.externalUsd})`);
ok(b.balance === 5, "balances stay those of the cached snapshot");
ok(out.rails[1] === snap.rails[1] && out.rails[2] === snap.rails[2], "rails not read from the ledger (Solana, a chain-scan fallback) are passed through untouched");
ok(calls.length === 1 && calls[0][2] === 8, "one ledger read, for the ledger-backed rail only, limit 8 as in the snapshot");
ok(snap.rails[0].recent.length === 1, "the cached snapshot is not mutated");
ok(withFreshRecent(snap, () => []) === snap, "an empty ledger read keeps the snapshot's rows (a cold ledger never blanks the list)");
ok(withFreshRecent(snap, () => { throw new Error("db closed"); }).rails[0].recent[0].txHash === oldRow.txHash, "a failing ledger read keeps the snapshot's rows");
ok(withFreshRecent(null, ledger) === null && withFreshRecent(snap, null) === snap, "no snapshot or no reader passes through");

// The proof row: on a busy rail the capped page holds only outside buyers, so
// our own newest settle comes from the ledger lookup, never from a buyer row.
{
  const ownTx = "0x" + "cc".repeat(32);
  const own = (chain) => (chain === (base.ledgerChain || "base") ? { usd: 0.001, txHash: ownTx, block: 150, when: "2026-10-02T14:00:00.000Z" } : null);
  const b2 = withFreshRecent(snap, ledger, own).rails[0];
  ok(b2.lastInbound && b2.lastInbound.internal === true && b2.lastInbound.tx === base.tx(ownTx), "with only outside rows in the page, the proof row is our own newest settle from the ledger");
  ok(!withFreshRecent(snap, ledger, () => null).rails[0].lastInbound, "no own settle recorded: no proof row (never an outside buyer's)");
  const withPrev = Object.freeze({ ...snap, rails: [{ ...snap.rails[0], lastInbound: { when: "2026-10-02T15:00:00.000Z", tx: "x", usd: 0.001, internal: true } }] });
  ok(withFreshRecent(withPrev, ledger, own).rails[0].lastInbound.when === "2026-10-02T15:00:00.000Z", "a newer own settle already on the snapshot is kept");
}
// The rail table's dollar cells use the page's money format, not raw ledger floats.
{
  const live = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
  ok(!/\$\$\{c \? esc\(String\(c\.externalUsd\)\)/.test(live) && /usdCell\(c\.externalUsd\)/.test(live), "External $ renders through usdCell (two decimals from $1, three below)");
}
// Wiring: every surface that renders the recent rows re-reads them.
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const route = (p) => src.slice(src.indexOf(`app.get("${p}", async`), src.indexOf(`app.get("${p}", async`) + 600);
ok(/withFreshRecent\(await revenueSnapshot\(revenueWallets\(\)\), ledgerRecent, ledgerNewestOwn\)/.test(route("/revenue")), "/revenue re-reads the recent rows and our newest settle");
const revenueHandler = (() => { const i = src.indexOf('app.get("/revenue", async'); return src.slice(i, src.indexOf("\n});", i)); })();
ok(/"Cache-Control", "no-cache"/.test(revenueHandler) && !/max-age/.test(revenueHandler), "/revenue tells the browser to revalidate, so one refresh shows the new reading");
ok(/withFreshRecent\(await revenueSnapshot\(revenueWallets\(\)\), ledgerRecent, ledgerNewestOwn\)/.test(route("/api/revenue")), "/api/revenue re-reads the recent rows and our newest settle");
ok(/revenueSnapshot\(revenueWallets\(\)\)\.then\(\(snap\) => withFreshRecent\(snap, ledgerRecent, ledgerNewestOwn\)\)/.test(src), "the chain pages re-read their rail's recent rows and our newest settle");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
