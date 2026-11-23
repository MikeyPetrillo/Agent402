// A private credits table for test suites (src/credits-guards.js): every
// count and window drawn at random on each run and every review signal a
// random name, so no suite states a production value and a check that only
// passes for one number fails on some run. A suite reads its limits back
// from the table it was given (guardsTable()), never from a literal.
//
// Imported by scripts/lib/offline-stores.js, so every offline suite and the
// servers it boots get a complete table; a suite that tests the table's
// absence deletes CREDITS_GUARDS_JSON and CREDITS_GUARDS_FILE itself.
import { randomBytes, randomInt } from "node:crypto";

const n = (lo, hi) => randomInt(lo, hi + 1);
const tag = (p) => `${p}-${randomBytes(4).toString("hex")}`;

/** A complete table with random values. */
export function makeGuardsTable() {
  const minute = 60_000;
  return {
    purchase: { buyerPerHour: n(2, 4), buyerPerDay: n(5, 8), sourcePerHour: n(2, 4), sourcePerDay: n(5, 8), failedMax: n(2, 4), failedWindowMs: n(30, 90) * minute, failedHoldMs: n(3, 9) * 60 * minute },
    flagged: { outcomeTypes: [tag("type"), tag("type")], riskLevels: [tag("risk")] },
    efw: { warningRefundDayMaxUsd: n(20, 80) },
    badKey: { failedMax: n(5, 25), windowMs: n(5, 20) * minute },
    mcpOAuth: { emailCodeTries: n(3, 5), sendsPerEmail: n(30, 40), sendsPerIp: n(40, 60), failsPerEmail: n(4, 7), lockoutMs: n(30, 90) * minute, tokenPerIp: n(25, 40), authorizePerIp: n(40, 60), registerPerIp: n(6, 10), windowMs: n(30, 90) * minute, badTokenMax: n(5, 10), pendingMax: n(200, 400), documentMaxBytes: n(4, 8) * 1024 * 1024, pendingPerAddress: n(3, 8), pendingPerClient: n(10, 20), sendsGlobalPerHour: n(500, 2000), sendsPerEmailDay: n(50, 90), unusedClientIdleMs: n(2, 6) * 60 * minute },
  };
}

/** The table this process runs with (parsed from the variable). */
export const guardsTable = () => JSON.parse(process.env.CREDITS_GUARDS_JSON);

/** Sets a table (a random one by default) on this process and its children. */
export function useGuardsTable(table = makeGuardsTable()) {
  process.env.CREDITS_GUARDS_JSON = JSON.stringify(table);
  delete process.env.CREDITS_GUARDS_FILE;
  return table;
}

if (!process.env.CREDITS_GUARDS_JSON && !process.env.CREDITS_GUARDS_FILE) useGuardsTable();
