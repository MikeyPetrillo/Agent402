// Offline unit test for the /status probe store and its aggregation.
//
// The properties worth pinning are the honesty ones. A status page is easy to
// make look good by accident: count an unmeasured day as green, report 100%
// from two samples, or call a component "operational" on the strength of an
// observation from yesterday. Each of those is asserted against here.
//
// Run: node scripts/test-status-store.js
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-status-"));
process.env.STATUS_DB_PATH = join(dir, "status.db");

const {
  recordProbe, recordProbes, probeRows, latestByComponent, totalObservations, earliestObservation,
  uptimeFrom, dailyFrom, incidentsFrom, stateFrom, _resetForTest,
} = await import("../src/status-store.js");

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 25, 12, 0, 0); // 2026-07-25T12:00:00Z

// ── Pure aggregation ─────────────────────────────────────────────────────────
{
  const u = uptimeFrom([{ ok: 1 }, { ok: 1 }, { ok: 0 }, { ok: 1 }]);
  check("uptime counts up/down and percentage", u.observed === 4 && u.up === 3 && u.down === 1 && Math.abs(u.pct - 75) < 1e-9);
  check("uptime over nothing is null, never 100", uptimeFrom([]).pct === null);
}

// A day we never probed must not render as uptime.
{
  const rows = [{ ts: NOW - 1 * DAY, ok: 1 }, { ts: NOW - 1 * DAY + 1000, ok: 1 }];
  const d = dailyFrom(rows, { days: 4, nowMs: NOW });
  check("daily returns one bucket per requested day", d.length === 4);
  const measured = d.find((x) => x.observed > 0);
  const unmeasured = d.filter((x) => x.observed === 0);
  check("a measured day reports 100% from 2 observations", measured.pct === 100 && measured.observed === 2);
  check("unmeasured days are pct null, NOT 100", unmeasured.length === 3 && unmeasured.every((x) => x.pct === null));
  check("every bucket carries its observation count (denominator visible)", d.every((x) => typeof x.observed === "number"));
}

{
  const rows = [{ ts: NOW - 2000, ok: 1 }, { ts: NOW - 1000, ok: 0 }];
  const d = dailyFrom(rows, { days: 1, nowMs: NOW });
  check("a day with one failure is not 100%", d[0].pct === 50 && d[0].down === 1);
}

// ── Incidents ────────────────────────────────────────────────────────────────
{
  const rows = [
    { ts: NOW - 10 * 3600_000, ok: 1 },
    { ts: NOW - 9 * 3600_000, ok: 0, detail: "/health" },
    { ts: NOW - 9 * 3600_000 + 900_000, ok: 0 },
    { ts: NOW - 8 * 3600_000, ok: 1 },
    { ts: NOW - 1 * 3600_000, ok: 0, detail: "mcp" },
  ];
  const inc = incidentsFrom(rows);
  check("consecutive failures collapse into one incident", inc.length === 2);
  check("incidents are newest first", inc[0].startedAt > inc[1].startedAt);
  check("a grouped incident counts its probes and duration", inc[1].probes === 2 && inc[1].durationMs === 900_000);
  check("a lone failed probe still counts as an incident", inc[0].probes === 1);
  check("incident keeps the failure detail", inc[1].detail === "/health");
  check("all-ok history yields no incidents", incidentsFrom([{ ts: 1, ok: 1 }, { ts: 2, ok: 1 }]).length === 0);
}

// Failures far apart are separate incidents, not one long one.
{
  const rows = [{ ts: NOW - 20 * 3600_000, ok: 0 }, { ts: NOW - 2 * 3600_000, ok: 0 }];
  check("failures separated by more than the gap are distinct incidents", incidentsFrom(rows).length === 2);
}

// ── Current state ────────────────────────────────────────────────────────────
{
  check("no observation ever is 'unknown'", stateFrom(null, { nowMs: NOW }).state === "unknown");
  check("a fresh ok observation is operational", stateFrom({ ts: NOW - 60_000, ok: 1 }, { nowMs: NOW }).state === "operational");
  check("a fresh failed observation is an outage", stateFrom({ ts: NOW - 60_000, ok: 0 }, { nowMs: NOW }).state === "outage");
  const stale = stateFrom({ ts: NOW - 6 * 3600_000, ok: 1 }, { nowMs: NOW });
  check("a STALE ok observation is 'unknown', not 'operational'", stale.state === "unknown" && /recent/.test(stale.reason));
}

// ── Persistence ──────────────────────────────────────────────────────────────
{
  recordProbe({ ts: NOW - 3000, source: "heartbeat", component: "api", ok: true });
  recordProbe({ ts: NOW - 2000, source: "heartbeat", component: "api", ok: false, detail: "/health", url: "https://example.test/run/1" });
  check("rows persist and read back in time order", probeRows("api", 0).length === 2 && probeRows("api", 0)[0].ts < probeRows("api", 0)[1].ts);

  // Idempotency is what makes re-running the backfill safe.
  const before = totalObservations();
  recordProbe({ ts: NOW - 3000, source: "heartbeat", component: "api", ok: true });
  check("duplicate (source, component, ts) is ignored", totalObservations() === before);

  const written = recordProbes([
    { ts: NOW - 5000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 4000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 5000, source: "backfill", component: "api", ok: true }, // dup within the batch
  ]);
  check("batch insert reports only genuinely new rows", written === 2);

  check("earliest observation is the oldest ts", earliestObservation() === NOW - 5000);
  check("sinceMs filter excludes older rows", probeRows("api", NOW - 2500).length === 1);

  recordProbe({ ts: NOW - 1000, source: "heartbeat", component: "mcp", ok: true });
  const latest = latestByComponent();
  check("latestByComponent returns one row per component", latest.length === 2 && latest.some((r) => r.component === "mcp"));
  const api = latest.find((r) => r.component === "api");
  check("latest row is the newest for that component", api.ts === NOW - 2000 && api.ok === 0);
  check("failure detail round-trips through storage", api.detail === "/health");
}

// ── Per-component staleness (src/status.js) ──────────────────────────────────
// The paid canary runs once a day. Judging it by the heartbeat's 45-minute
// threshold would leave settlement reading "unknown" for 23 hours out of 24 and
// drag the whole page to "degraded" — a cadence mismatch dressed up as an
// incident. Each component carries the threshold that matches its observer.
{
  const { COMPONENTS } = await import("../src/status.js");
  const byKey = Object.fromEntries(COMPONENTS.map((c) => [c.key, c]));
  check("every component declares a staleness threshold", COMPONENTS.every((c) => Number.isFinite(c.staleAfterMs)));
  check("heartbeat-fed components use a ~45 min threshold", byKey.api.staleAfterMs === 45 * 60_000);
  check("the daily canary component tolerates over 24h", byKey.settlement.staleAfterMs > 24 * 3600_000);

  const dayOld = { ts: NOW - 20 * 3600_000, ok: 1 };
  check("a 20h-old canary result is still operational under its own threshold",
    stateFrom(dayOld, { nowMs: NOW, staleAfterMs: byKey.settlement.staleAfterMs }).state === "operational");
  check("the same 20h-old result WOULD be unknown under the heartbeat threshold",
    stateFrom(dayOld, { nowMs: NOW, staleAfterMs: byKey.api.staleAfterMs }).state === "unknown");
  check("a canary result older than its threshold is still unknown",
    stateFrom({ ts: NOW - 30 * 3600_000, ok: 1 }, { nowMs: NOW, staleAfterMs: byKey.settlement.staleAfterMs }).state === "unknown");
}

// ── Overall rollup (src/status.js) ───────────────────────────────────────────
{
  const { overallState } = await import("../src/status.js");
  // Rollup is key-aware: only core serving components can force overall outage.
  const c = (key, state, observed = 10) => ({ key, observed, current: { state } });
  check("all operational rolls up to operational", overallState([c("api", "operational"), c("settlement", "operational")]) === "operational");
  check("a core outage dominates everything else", overallState([c("api", "outage"), c("settlement", "operational")]) === "outage");
  check("settlement-only outage rolls up to degraded (not Active outage)", overallState([c("api", "operational"), c("settlement", "outage")]) === "degraded");
  check("rails-only outage rolls up to degraded", overallState([c("mcp", "operational"), c("rails", "outage")]) === "degraded");
  check("a mix of fresh and stale is degraded", overallState([c("api", "operational"), c("settlement", "unknown")]) === "degraded");
  check("ALL stale is 'unknown', not 'degraded' (we don't know, vs we know it's bad)", overallState([c("api", "unknown"), c("settlement", "unknown")]) === "unknown");
  check("never-observed components do not vote", overallState([c("api", "operational"), c("settlement", "outage", 0)]) === "operational");
  check("nothing observed at all is unknown", overallState([c("api", "unknown", 0)]) === "unknown");

  // railComponents (per-chain: rail_monad, rail_stellar, ...) — added
  // 2026-08-17. Before this, a rail dropping out of the live 402 accepts was
  // correctly recorded and shown as "Outage" on its own card, but never
  // moved `overall` off "operational" — the paid canary could name a dead
  // rail and the headline would still read "All systems operational".
  const core = [c("api", "operational"), c("catalog", "operational"), c("mcp", "operational"), c("paywall", "operational"), c("paid-call", "operational")];
  check("a single rail outage rolls the headline up to degraded",
    overallState(core, [c("rail_monad", "outage")]) === "degraded");
  check("a rail outage never forces Active outage, even with several core components fresh",
    overallState(core, [c("rail_monad", "outage"), c("rail_stellar", "unknown")]) === "degraded");
  check("a core outage still wins over a healthy rail set",
    overallState([c("api", "outage"), c("catalog", "operational")], [c("rail_monad", "operational")]) === "outage");
  check("all rails operational plus all core operational is operational",
    overallState(core, [c("rail_monad", "operational"), c("rail_base", "operational")]) === "operational");
  check("a never-observed rail does not vote",
    overallState(core, [c("rail_monad", "outage", 0)]) === "operational");
  check("core all-unknown but a rail has a real outage is degraded, not unknown",
    overallState([c("api", "unknown")], [c("rail_monad", "outage")]) === "degraded");
  check("core all-unknown and rails all-unknown too is unknown",
    overallState([c("api", "unknown")], [c("rail_monad", "unknown")]) === "unknown");
  check("no core components at all, one bad rail, is degraded",
    overallState([], [c("rail_monad", "outage")]) === "degraded");
  check("omitting railComponents entirely keeps old behavior (backward compatible)",
    overallState([c("api", "operational")]) === "operational");
}

// ---- paid-call is judged per observer, not newest-row-wins (2026-09-28) ----
// The two observers of paid-call walk DIFFERENT proof-of-work challenges: the
// GitHub heartbeat walks the one a buyer is issued, the Cloudflare Worker a
// low-difficulty probe challenge with its own token and verify branch. With
// newest-row-wins, the Worker's "ok" every 5 minutes overwrote a failure only
// the buyer's path had, so /status read operational while the heartbeat was
// failing. A failure from either observer must stand until THAT observer sees
// the path work again or its own reading goes stale.
{
  const { stateFromSources, latestBySource } = await import("../src/status-store.js");
  const { COMPONENTS, PAID_CALL_SOURCES, statusSnapshot } = await import("../src/status.js");
  const HB = PAID_CALL_SOURCES.heartbeat, CF = PAID_CALL_SOURCES.worker;
  const paid = COMPONENTS.find((c) => c.key === "paid-call");
  const opts = { nowMs: NOW, staleAfterMs: paid.staleAfterMs, sourceStaleAfterMs: paid.sourceStaleAfterMs };
  const row = (source, agoMs, ok, detail = null) => ({ source, ts: NOW - agoMs, ok: ok ? 1 : 0, detail });

  check("paid-call is judged per source", paid.perSource === true);
  const hbFailWorkerOk = stateFromSources([row(HB, 60_000, false, "pow-paid-call"), row(CF, 1000, true)], opts);
  check("a heartbeat failure is NOT cleared by a newer Worker success", hbFailWorkerOk.state === "outage");
  check("the outage names the observer that saw it and its detail", hbFailWorkerOk.source === HB && hbFailWorkerOk.detail === "pow-paid-call");
  check("each observer's own reading is published beside the verdict",
    hbFailWorkerOk.sources.length === 2 && hbFailWorkerOk.sources.some((s) => s.source === CF && s.state === "operational"));
  check("a Worker failure is NOT cleared by a newer heartbeat success",
    stateFromSources([row(CF, 60_000, false), row(HB, 1000, true)], opts).state === "outage");
  check("a 2h-old heartbeat failure still stands against a 1-minute-old Worker success (heartbeat bound is 3h)",
    stateFromSources([row(HB, 2 * 3600_000, false), row(CF, 60_000, true)], opts).state === "outage");
  check("a heartbeat failure past its own bound no longer votes; the fresh Worker decides",
    stateFromSources([row(HB, 4 * 3600_000, false), row(CF, 60_000, true)], opts).state === "operational");
  check("a Worker failure ages out on the Worker's cadence (45 min), not the heartbeat's 3h",
    stateFromSources([row(CF, 50 * 60_000, false), row(HB, 2 * 3600_000, true)], opts).state === "operational");
  check("both observers operational is operational", stateFromSources([row(HB, 3600_000, true), row(CF, 60_000, true)], opts).state === "operational");
  check("every reading stale is unknown, not operational",
    stateFromSources([row(HB, 4 * 3600_000, true), row(CF, 50 * 60_000, true)], opts).state === "unknown");
  check("never observed is unknown", stateFromSources([], opts).state === "unknown");
  check("an observer with no bound of its own falls back to the component's",
    stateFromSources([row("backfill", 2 * 3600_000, false)], opts).state === "outage");

  // End to end through the store and the snapshot /api/status serves.
  recordProbe({ ts: NOW - 60_000, source: HB, component: "paid-call", ok: false, detail: "pow-paid-call" });
  recordProbe({ ts: NOW - 1000, source: CF, component: "paid-call", ok: true });
  check("latestBySource returns one row per observer", latestBySource("paid-call").length === 2);
  let snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW });
  const pc = () => snap.components.find((c) => c.key === "paid-call");
  check("the snapshot does not read paid-call operational over a live heartbeat failure", pc().current.state === "outage");
  // The heartbeat recovering on its OWN path is what clears it.
  recordProbe({ ts: NOW - 500, source: HB, component: "paid-call", ok: true });
  snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW });
  check("the heartbeat's own later success clears its failure", pc().current.state === "operational");

  // Scoped: every other component still reads newest-row-wins, because both
  // observers check the same thing there and a newer success IS recovery.
  recordProbe({ ts: NOW - 60_000, source: HB, component: "catalog", ok: false, detail: "catalog(1)" });
  recordProbe({ ts: NOW - 1000, source: CF, component: "catalog", ok: true });
  snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW });
  check("a component whose observers walk the same path still reads its newest row",
    snap.components.find((c) => c.key === "catalog").current.state === "operational");

  // The source names are the observers' own; a rename on either side would
  // silently drop that observer onto the component-wide bound.
  const { readFileSync } = await import("node:fs");
  const hbScript = readFileSync(new URL("./heartbeat-probe.sh", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  check(`the heartbeat records under "${HB}"`, hbScript.includes(`source:"${HB}"`));
  check(`the Worker records under "${CF}"`, worker.includes(`source: "${CF}"`));
}

// ---- the strip window and the footer figure must agree (2026-09-18) ----
// The per-component footer reads windows[`${STRIP_DAYS}d`]. That key is only
// present because 30d happens to be one of the WINDOWS rows; set STRIP_DAYS to
// a value with no matching window (45, say) and `w` is undefined and the page
// throws on render. Nothing else would catch that, and /status is the page that
// is supposed to be up when everything else is not.
{
  const { STRIP_DAYS, statusSnapshot } = await import("../src/status.js");
  const snap = statusSnapshot({ baseUrl: "https://example.test" });
  check(`STRIP_DAYS (${STRIP_DAYS}) has a matching window key, so the footer figure exists`,
    snap.components.every((c) => c.windows && c.windows[`${STRIP_DAYS}d`] && typeof c.windows[`${STRIP_DAYS}d`].observed === "number"));
  check(`the strip renders exactly STRIP_DAYS bars (${STRIP_DAYS})`,
    snap.components.every((c) => Array.isArray(c.daily) && c.daily.length === STRIP_DAYS));
}

// ---- each window counts its own span (2026-10-02) ----
// The rows read for a component reach back STRIP_DAYS only, and every window
// was filtered from them, so the 90-day figure carried the 30-day count.
{
  const { statusSnapshot } = await import("../src/status.js");
  const T = Date.UTC(2026, 9, 2, 12, 0, 0);
  const K = "api";
  // 10 probes 60 days ago (one failed), 5 probes 2 days ago.
  recordProbes([
    ...Array.from({ length: 10 }, (_, i) => ({ ts: T - 60 * DAY + i * 60000, source: "w-test", component: K, ok: i !== 0 })),
    ...Array.from({ length: 5 }, (_, i) => ({ ts: T - 2 * DAY + i * 60000, source: "w-test", component: K, ok: true })),
  ]);
  const before = probeRows(K, T - 90 * DAY).length;
  const snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: T });
  const c = snap.components.find((x) => x.key === K);
  const in90 = probeRows(K, T - 90 * DAY), in30 = probeRows(K, T - 30 * DAY);
  check(`the 90-day window counts every probe in 90 days (${c.windows["90d"].observed} of ${in90.length})`, c.windows["90d"].observed === in90.length && before === in90.length);
  check(`the 30-day window counts its own span (${c.windows["30d"].observed} of ${in30.length})`, c.windows["30d"].observed === in30.length);
  check("the 90-day and 30-day denominators differ when probes predate the strip", c.windows["90d"].observed > c.windows["30d"].observed);
  check("the 90-day pass count excludes the failed probe", c.windows["90d"].down === in90.filter((r) => !r.ok).length);
}

_resetForTest();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
check("scratch DB cleaned up", !existsSync(join(dir, "status.db")));

console.log(`\ntest-status-store: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
