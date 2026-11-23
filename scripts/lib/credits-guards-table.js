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
  const minute = 60_000, hour = 60 * minute;
  const buyerPerHour = n(1, 30), sourcePerHour = n(2, 30), sendsPerEmail = n(60, 300), pendingPerAddress = n(2, 30);
  return {
    purchase: { buyerPerHour, buyerPerDay: buyerPerHour + n(1, 60), sourcePerHour, sourcePerDay: sourcePerHour + n(1, 60), failedMax: n(1, 30), failedWindowMs: n(1, 600) * minute, failedHoldMs: n(1, 72) * hour },
    flagged: { outcomeTypes: [tag("type"), tag("type")], riskLevels: [tag("risk")] },
    efw: { warningRefundDayMaxUsd: n(15, 500) },
    badKey: { failedMax: n(2, 60), windowMs: n(1, 60) * minute },
    mcpOAuth: { emailCodeTries: n(2, 20), sendsPerEmail, sendsPerIp: sendsPerEmail + n(1, 300), failsPerEmail: n(2, 30), lockoutMs: n(1, 600) * minute, tokenPerIp: n(25, 300), authorizePerIp: n(40, 400), registerPerIp: n(4, 60), windowMs: n(1, 600) * minute, badTokenMax: n(3, 100), pendingMax: n(200, 4000), documentMaxBytes: n(2, 64) * 1024 * 1024, pendingPerAddress, pendingPerClient: n(10, 200), pendingPerNetwork: pendingPerAddress + n(1, 200), sendsGlobalPerHour: n(2000, 20000), sendsPerEmailDay: sendsPerEmail + n(1, 600), unusedClientIdleMs: n(1, 48) * hour },
    account: { sendsGlobalPerHour: n(2000, 20000), sendsPerNetHour: n(40, 400) },
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
