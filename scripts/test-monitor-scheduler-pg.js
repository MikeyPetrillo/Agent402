// The monitor scheduler (src/monitor-scheduler.js) on the state database,
// with two containers. A paid run is claimed on the subscription's record in
// the row before the report is generated, so a container whose tick lease
// lapsed mid-run is never joined by a second paid run of the same
// subscription; and every save merges the subscriptions it touched into the
// row, so one container's save never erases the other's record. The
// subscription list is reloaded under the lease when the source offers it.
// Requires STATE_DATABASE_URL (CI fails without it; locally it skips).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-monitor-scheduler-pg" });
const sdb = await import("../src/state-db.js");
const { createMonitorScheduler } = await import("../src/monitor-scheduler.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "monitor-pg-"));
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sdb.stateDb();
  const recs = ["one", "two"].map((t) => ({ subId: `sub_${t}`, product: "domain-monitor", target: `${t}.example`, status: "active", email: `${t}@example.com` }));
  const runs = [], mails = [];
  let reloads = 0;
  let release; const gate = new Promise((r) => { release = r; });
  const mk = (owner, gen) => createMonitorScheduler({
    subs: { listActive: () => recs, reload: async () => { reloads++; } },
    storePath: join(DIR, owner, "monitor-runs.json"), ownerId: owner, generate: gen,
    probeDomain: async () => ({ signals: { grade: "A" }, fingerprint: "fp" }), normDomain: (d) => d,
    latestFiling: async () => null, resolveManager: async () => null,
    notify: async (m) => { mails.push(`${owner}:${m.to}`); return true; },
    baseUrl: "https://t.example", log: quiet, sleep: async () => {},
  });
  // A's first paid run (sub_one) stalls; B runs whatever A has not claimed.
  const A = mk("A", async (_k, _s, input) => { runs.push(`A:${input}`); if (input === "one.example") await gate; return { report: `rA ${input}`, title: "t" }; });
  const B = mk("B", async (_k, _s, input) => { runs.push(`B:${input}`); return { report: `rB ${input}`, title: "t" }; });
  await A.ready(); await B.ready();

  const ta = A.tick();
  while (!runs.length) await sleep(20);
  ok(reloads === 1, `the subscription list is reloaded under the lease before the tick runs (${reloads})`);
  // A's lease lapses while its paid run is in flight (a stalled container).
  await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.leases SET expires_at = now() - interval '1 second' WHERE name = 'monitor-scheduler'`);
  const tb = await B.tick();
  release();
  const ra = await ta;
  await A.flush(); await B.flush();
  const row = (await sdb.documents.get("monitor-runs.json"))?.body;
  ok(runs.filter((r) => r.endsWith("one.example")).length === 1, `one paid run of a subscription whose run was in flight on the other container (${JSON.stringify(runs)}; A ${JSON.stringify(ra)}; B ${JSON.stringify(tb)})`);
  ok(mails.filter((m) => m.endsWith("one@example.com")).length === 1, `one report email for it (${JSON.stringify(mails)})`);
  const oneRuns = row?.subs?.sub_one?.runs || [], twoRuns = row?.subs?.sub_two?.runs || [];
  ok(oneRuns.length === 1 && row?.reports?.[oneRuns[0].reportId]?.report === "rA one.example", "the in-flight run's record and report land in the row");
  ok(twoRuns.length === 1 && row?.reports?.[twoRuns[0].reportId]?.report === "rB two.example", "the other container's run of another subscription survives the first container's save");
  ok(!row?.subs?.sub_one?.runClaim && !row?.subs?.sub_two?.runClaim, "no run claim is left in the row");

  // A later tick on either container does not pay for either run again.
  const before = runs.length;
  await A.tick(); await B.tick();
  ok(runs.length === before, `neither container runs them again (${runs.length - before} more)`);
  ok(reloads === 4, `each tick reloads the list (${reloads})`);

  // A live claim from the other container (a run in flight there) is never joined.
  const recs3 = { subId: "sub_three", product: "domain-monitor", target: "three.example", status: "active" };
  recs.push(recs3);
  const body = (await sdb.documents.get("monitor-runs.json")).body;
  body.subs.sub_three = { failures: 0, runs: [], runClaim: { by: "Z", token: "t", until: Date.now() + 60 * 60_000 } };
  await sdb.documents.put("monitor-runs.json", body);
  const r3 = await B.tick();
  ok(!runs.some((r) => r.endsWith("three.example")), `a subscription claimed by another container is not run here (${JSON.stringify(r3)})`);
  const after3 = (await sdb.documents.get("monitor-runs.json")).body.subs.sub_three;
  ok(after3?.runClaim?.by === "Z" && !(after3.failures > 0), "its claim stands and no failure is counted");
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
