// `maxUpstreamUsd` must be ENFORCED, not merely declared.
//
// It was a declared bound in 8 of the 10 report kits: only research-deep and
// ticker-pack read their own field at runtime, so everywhere else the number
// was a comment nothing checked. That is how it drifted below measured cost and
// how three products ended up priced under their own worst case.
//
// Every report kit already reports through recordCompositeUsage, so that is
// where the check lives - one place, no per-kit wiring to forget.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  recordCompositeUsage, compositeUsageSnapshot, _compositeGuardReset, _compositeUsageSettled,
} from "../src/composite-spend-guard.js";
import { REPORT_TIERS, capUsdFor, priceUsdFor } from "../src/report-tiers.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// 1. The registry has to actually cover the kits, or every check below is
//    vacuous in the quietest possible way.
const slugs = Object.keys(REPORT_TIERS);
ok(slugs.length >= 15, `the tier registry covers ${slugs.length} report tiers`);
for (const s of ["research", "research-max", "dossier", "fund-report", "domain-audit", "recall-report", "insider-report", "token-risk", "token-brief", "filing-report", "ticker-pack", "market-brief"]) {
  ok(capUsdFor(s) != null && priceUsdFor(s) != null, `${s} resolves both a cap ($${capUsdFor(s)}) and a price ($${priceUsdFor(s)})`);
}
ok(capUsdFor("uuid") === null && capUsdFor("") === null && capUsdFor(undefined) === null,
  "a slug that is not a report resolves no cap, so ordinary tools are never flagged");

// 2. Under the cap: counted, never flagged.
_compositeGuardReset();
recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.10, ok: true, priceUsd: 0.60 });
await _compositeUsageSettled();
let snap = compositeUsageSnapshot();
ok(snap.runs === 1 && snap.overCap === 0 && !snap.lastOverCap, "a run inside its cap is counted and not flagged");

// 3. Over the cap: flagged, with the numbers kept for a human.
recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.90, ok: true, priceUsd: 0.60 });
await _compositeUsageSettled();
snap = compositeUsageSnapshot();
ok(snap.overCap === 1, "a run OVER its cap is flagged");
ok(snap.lastOverCap?.slug === "recall-report" && snap.lastOverCap.capUsd === capUsdFor("recall-report") && snap.lastOverCap.upstreamUsd === 0.9,
  "the breach records what was spent AND the ceiling it broke, so the next reader does not have to reconstruct it");
ok(snap.bySlug["recall-report"].overCap === 1, "breaches are attributed per slug, so drift in one product is visible on its own");

// 4. Exactly at the cap is not a breach: the cap is a ceiling, not a limit to
//    stay under, and an off-by-one here would cry wolf on every well-priced run.
_compositeGuardReset();
recordCompositeUsage({ slug: "recall-report", upstreamUsd: capUsdFor("recall-report"), ok: true, priceUsd: 0.60 });
await _compositeUsageSettled();
ok(compositeUsageSnapshot().overCap === 0, "spend exactly AT the cap is not a breach");

// 5. A non-report slug can never be flagged however much it spends.
_compositeGuardReset();
recordCompositeUsage({ slug: "uuid", upstreamUsd: 99, ok: true, priceUsd: 0.001 });
await _compositeUsageSettled();
ok(compositeUsageSnapshot().overCap === 0, "a non-report slug is never flagged, whatever it reports");

// 6. Telemetry must never be able to break billing: this runs after the buyer
//    has already been served and the money already spent.
_compositeGuardReset();
let threw = null;
try { recordCompositeUsage({ slug: "recall-report", upstreamUsd: Number.NaN, ok: true, priceUsd: null }); }
catch (e) { threw = e; }
await _compositeUsageSettled();
ok(!threw, "a malformed usage report does not throw: this runs after the buyer was served, so it must never break the response");

_compositeGuardReset();
console.log(`\n${pass} passed, 0 failed`);
