// /revenue after a restart: the saved last-good reading is served while the
// multi-chain scan runs, and every rail is bounded as a whole, so one slow rail
// cannot keep the scan from finishing (2026-10-01: every cold visit waited
// out the 25 s deadline and /api/revenue answered 500).
import { readFileSync } from "node:fs";
import { lastGoodSnapshot } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const lg = { asOf: "2026-10-01T20:00:00.000Z", rails: [{ rail: "Base", balance: 12.5, balanceAsOf: "2026-10-01T19:59:00.000Z", recent: [] }, { rail: "Solana", balance: 3, recent: [] }] };
const snap = lastGoodSnapshot(lg);
ok(snap.stale === true && snap.rails.every((r) => r.staleBalance === true) && snap.totalUsd === 15.5, "the saved reading is served, every balance marked stale, totals recomputed");
ok(snap.rails[1].balanceAsOf === lg.asOf && snap.rails[0].balanceAsOf === "2026-10-01T19:59:00.000Z", "each balance keeps the time it was read");

const src = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("export async function revenueSnapshot"), src.indexOf("export function lastGoodSnapshot"));
ok(fn.indexOf("if (diskLastGood?.rails?.length) return lastGoodSnapshot(diskLastGood);") > fn.indexOf("if (cached) return cached;") && fn.indexOf("return lastGoodSnapshot(diskLastGood)") < fn.indexOf("Promise.race"), "a cold snapshot serves the saved reading before it would wait on the scan");
const refresh = src.slice(src.indexOf("async function refreshSnapshot"));
ok((refresh.match(/\bevm\("/g) || []).length === 9 && /bounded\("Solana", solanaRail/.test(refresh) && /bounded\("Stellar", stellarRail/.test(refresh) && /bounded\("Algorand", algorandRail/.test(refresh), "every one of the twelve rails is bounded as a whole");

console.log(`\ntest-revenue-cold: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
