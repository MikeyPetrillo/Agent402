// composite_usage telemetry carries the DOOR and the PRICE a report sold for.
//
// Kits report the agent-tier price; the card door and monitor scheduler run
// the same handler, so until 2026-08-27 a $5 card report was booked as $2
// with no way to tell which door it came through. withCompositeContext()
// sets rail + price around the handler call and recordCompositeUsage reads
// it (async-local, so it survives however deep the kit calls).
//
//   node scripts/test-composite-context.js
process.env.POSTHOG_TEST_CAPTURE = "1";
const { recordCompositeUsage, withCompositeContext, _compositeGuardReset, _compositeUsageSettled } = await import("../src/composite-spend-guard.js");
const { _testEventsForTest } = await import("../src/posthog.js");
const { capUsdFor } = await import("../src/report-tiers.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const events = _testEventsForTest();
const take = () => events.splice(0, events.length).filter((e) => e.event === "composite_usage");

// 1. No context: agent rail, the kit's own price.
_compositeGuardReset();
recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.1, ok: true, priceUsd: 0.6 });
await _compositeUsageSettled();
let got = take();
ok(got.length === 1 && got[0].properties.rail === "agent" && got[0].properties.priceUsd === 0.6 && got[0].properties.marginUsd === 0.5,
  "outside any context a run is booked on the agent rail at the kit's price");
ok(got[0].properties.capUsd === capUsdFor("recall-report") && got[0].properties.overCap === false,
  "the event carries the cap it was judged against and the verdict");

// 2. Card context: rail + card price override the kit's agent price, through an await chain.
await withCompositeContext({ rail: "card", priceUsd: 2 }, async () => {
  await new Promise((r) => setTimeout(r, 5));
  await (async () => { recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.1, ok: true, priceUsd: 0.6 }); })();
});
await _compositeUsageSettled();
got = take();
ok(got.length === 1 && got[0].properties.rail === "card" && got[0].properties.priceUsd === 2 && got[0].properties.marginUsd === 1.9,
  "inside the card door's context the same kit call books rail=card at the card price");

// 3. Monitor context without a usable price keeps the kit's price.
await withCompositeContext({ rail: "monitor", priceUsd: undefined }, async () => {
  recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.1, ok: true, priceUsd: 0.6 });
});
await _compositeUsageSettled();
got = take();
ok(got.length === 1 && got[0].properties.rail === "monitor" && got[0].properties.priceUsd === 0.6,
  "a context with no price keeps the kit's price and still names the door");

// 4. Context does not leak past its scope.
recordCompositeUsage({ slug: "recall-report", upstreamUsd: 0.1, ok: true, priceUsd: 0.6 });
await _compositeUsageSettled();
got = take();
ok(got.length === 1 && got[0].properties.rail === "agent" && got[0].properties.priceUsd === 0.6, "the context ends with its scope");

// 5. Over-cap verdict rides the event.
recordCompositeUsage({ slug: "recall-report", upstreamUsd: capUsdFor("recall-report") + 0.5, ok: true, priceUsd: 0.6 });
await _compositeUsageSettled();
got = take();
ok(got.length === 1 && got[0].properties.overCap === true, "a cap breach is flagged on the event itself");

console.log(`\nAll ${pass} assertions passed`);
