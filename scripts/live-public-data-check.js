#!/usr/bin/env node
// The live public-data checks of deploy.yml's "Exercise tools against live
// sites" step: each tool is called on a server booted with
// scripts/lib/upstream-failure-log-preload.js and must answer its check. A
// failure passes (with a warning naming the evidence) only when it is a
// keyless public upstream's outage by scripts/lib/upstream-outage.js: our
// upstream-error answer, a failed request to a host the tool's definition
// names recorded during the call, and the runner's own direct read of that
// request failing too. Any other failure, ours, fails the step.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/live-public-data-check.js
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { upstreamOutageVerdict } from "./lib/upstream-outage.js";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

export const CHECKS = [
  { slug: "weather-alerts", path: "/api/weather-alerts?area=CA", what: "an alerts list", pass: (b) => Array.isArray(b?.alerts), show: (b) => ({ count: b.count, top: b.alerts?.[0]?.event ?? null }) },
  { slug: "earthquakes", path: "/api/earthquakes?minMag=2.5&period=day", what: "at least one quake", pass: (b) => Number(b?.count) >= 1, show: (b) => ({ count: b.count, top: b.quakes?.[0]?.place ?? null }) },
];

async function call(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${TARGET}${path}`, { signal: AbortSignal.timeout(60_000) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body, t0, t1: Date.now() };
  } catch (e) {
    return { status: 0, body: { error: String(e?.message || e) }, t0, t1: Date.now() };
  }
}

/** One check's outcome: "pass", "upstream" (excused, with evidence) or "fail". */
export async function runCheck(check, { callTool = call, verdict = upstreamOutageVerdict } = {}) {
  let r = await callTool(check.path);
  if (r.status === 200 && check.pass(r.body)) return { outcome: "pass", r };
  // One retry a few seconds on, as the sweeps give a blip.
  await new Promise((res) => setTimeout(res, Number(process.env.LIVE_CHECK_RETRY_MS ?? 3000)));
  r = await callTool(check.path);
  if (r.status === 200 && check.pass(r.body)) return { outcome: "pass", r };
  const v = await verdict({ slug: check.slug, status: r.status, body: r.body, t0: r.t0, t1: r.t1 });
  return v.verdict === "upstream" ? { outcome: "upstream", r, evidence: v.evidence } : { outcome: "fail", r, reason: v.reason };
}

async function main() {
  let failed = 0;
  for (const check of CHECKS) {
    const { outcome, r, evidence, reason } = await runCheck(check);
    if (outcome === "pass") {
      console.log(`${check.slug}: OK ${JSON.stringify(check.show(r.body))}`);
    } else if (outcome === "upstream") {
      console.log(`::warning::${check.slug}: upstream outage, not failing the step: ${evidence}`);
    } else {
      failed++;
      console.log(`::error::${check.slug}: expected ${check.what}, got HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)} (${reason})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
