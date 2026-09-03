// The upstream-spend meter and the operator margin view's inputs.
//
// Why this exists: gateway/composite upstream costs were PostHog-only, and a
// keyless boot (local audit, FREE_MODE CI) recorded NOTHING - the shape that
// let an $11.04 OpenRouter day read as $0.0276. The meter now writes to the
// stats DB inside the same capture funnels, BEFORE the PostHog active() gate,
// so cost is recorded whenever the process serves. These tests pin that
// ordering by running with NO PostHog key at all.
import { strict as assert } from "node:assert";

process.env.FREE_MODE = "true";           // stats DB allowed ephemeral
delete process.env.POSTHOG_API_KEY;       // telemetry OFF - the critical case

const { recordUpstreamSpend, getDailyUpstreamSpend } = await import("../src/stats.js");
const { capturePostHogGatewayUsage, capturePostHogCompositeUsage } = await import("../src/posthog.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const today = new Date().toISOString().slice(0, 10);
const sumFor = (source) => getDailyUpstreamSpend()
  .filter((r) => r.day === today && r.source === source)
  .reduce((t, r) => t + r.usd_micro, 0);

// --- the primitive -----------------------------------------------------
const base = sumFor("test-src");
recordUpstreamSpend("test-src", 0.0123);
recordUpstreamSpend("test-src", 0.0007);
ok(sumFor("test-src") - base === 13000, "two records sum exactly in integer micro-dollars (0.0123 + 0.0007 = 13000 micro)");

const before = sumFor("test-src");
recordUpstreamSpend("test-src", 0);
recordUpstreamSpend("test-src", -5);
recordUpstreamSpend("test-src", NaN);
recordUpstreamSpend("test-src", "garbage");
ok(sumFor("test-src") === before, "zero, negative, NaN and non-numeric spend record nothing");

// --- the funnels meter with PostHog OFF --------------------------------
const g0 = sumFor("gateway");
capturePostHogGatewayUsage({ tier: "v1-chat", model: "m", priceUsd: 0.02, upstreamUsd: 0.004 });
await new Promise((r) => setTimeout(r, 50)); // first meterSpend call resolves its lazy stats import
ok(sumFor("gateway") - g0 === 4000, "capturePostHogGatewayUsage meters spend with NO PostHog key (recorded before the active() gate)");

const g1 = sumFor("gateway");
capturePostHogGatewayUsage({ tier: "v1-chat", model: "m", priceUsd: 0.02, upstreamUsd: null });
ok(sumFor("gateway") === g1, "a gateway call with no reported upstream cost records nothing (never invented)");

const c0 = sumFor("composite");
capturePostHogCompositeUsage({ slug: "research", upstreamUsd: 0.11, ok: true, priceUsd: 0.6 });
ok(sumFor("composite") - c0 === 110000, "capturePostHogCompositeUsage meters spend with NO PostHog key");

// --- external daily revenue helper -------------------------------------
const { externalDailyRevenue } = await import("../src/sales-ledger.js");
const rows = externalDailyRevenue({ days: 3 });
ok(Array.isArray(rows) && rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && Number.isFinite(r.revenueUsd) && Number.isInteger(r.sales)), "externalDailyRevenue returns well-formed day rows");

console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `OK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
