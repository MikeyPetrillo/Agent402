// Data-kit tests (run in CI, which has network egress). Strict on our own
// validation logic (deterministic); tolerant of any single flaky upstream —
// fails only if a validation assertion breaks or if EVERY live call fails
// (which would mean our integration, not one upstream, is broken).
import { DATA_TOOLS } from "../src/tools/data-kit.js";

const h = (slug) => DATA_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
for (const [slug, args, label] of [
  ["fx-rate", { from: "US", to: "EUR" }, "fx-rate rejects bad currency code"],
  ["barcode-lookup", { code: "abc" }, "barcode-lookup rejects non-numeric code"],
  ["weather-forecast", { lat: 999, lon: 0 }, "weather-forecast rejects bad coordinates"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of upstream flake) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 120)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 200)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

await live("fx-rate", { from: "USD", to: "EUR", amount: 100 }, (r) => typeof r.result === "number" && r.result > 0 && r.date, "fx-rate USD→EUR");
await live("barcode-lookup", { code: "3017620422003" }, (r) => r.code === "3017620422003" && "found" in r, "barcode-lookup Nutella");
await live("weather-forecast", { lat: 40.71, lon: -74.01 }, (r) => Array.isArray(r.periods) && r.periods.length > 0, "weather-forecast NYC");

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
// Fail on a real bug (assertion) or if NOT A SINGLE live call worked.
if (assertFail > 0 || liveOk === 0) { console.error("data-kit: FAILED"); process.exit(1); }
console.log("data-kit: OK");
