// Find-miss shapes a catalog tool answers (scripts/fixtures/find-misses.json,
// neutral rewordings): each must rank its tool first AND read as served, by the same condition
// /api/find uses before it records a find-miss wish (no rows, a top score
// under the weak floor, or a top hit that misses the query's rarest word).
// A booted free-mode server with the real catalog; port 0, its own stores.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { cases } = JSON.parse(readFileSync(join(ROOT, "scripts", "fixtures", "find-misses.json"), "utf8"));
// The weak floor /api/find reads (FIND_WEAK_SCORE in src/server.js), read from
// the answer's own field when it carries one.
const FIND_WEAK_SCORE = 3;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

ok(Array.isArray(cases) && cases.length >= 50, `fixture has cases (${cases?.length})`);
const seen = new Set();
for (const c of cases) {
  const tops = [].concat(c.top);
  ok(typeof c.q === "string" && c.q.trim() && tops.length && tops.every((t) => typeof t === "string" && t), `case is { q, top }: ${JSON.stringify(c).slice(0, 80)}`);
  ok(!seen.has(c.q), `case "${c.q}" is listed once`);
  seen.add(c.q);
}

const srv = await bootServer({ stores: "find-misses", env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
try {
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const live = new Set((pricing.endpoints || []).map((e) => e.slug));
  for (const c of cases) {
    const tops = [].concat(c.top);
    ok(tops.every((t) => live.has(t)), `${tops.join(", ")} are live catalog tools`);
    const r = await fetch(`${srv.url}/api/find?q=${encodeURIComponent(c.q)}&k=3`);
    const j = await r.json();
    const top = j.results?.[0];
    const floor = Number.isFinite(j.weakScore) ? j.weakScore : FIND_WEAK_SCORE;
    ok(r.status === 200 && tops.includes(top?.slug), `"${c.q}" ranks ${tops.join(" or ")} first (got ${(j.results || []).map((x) => x.slug).join(",") || "none"})`);
    // A multi-step task answered by a plan sketch is not recorded as a miss
    // (computeFind returns the sketch first), the same reading here.
    const miss = !j.plan && (!j.count || (top?.score ?? 0) < floor || j.rarestTermCovered === false);
    ok(!miss && !j.weakMatches, `"${c.q}" reads as served (count ${j.count}, score ${Math.round(top?.score ?? 0)}, rarest ${j.rarestTerm} covered ${j.rarestTermCovered})`);
  }
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
