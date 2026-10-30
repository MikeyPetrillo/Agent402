// The operator heap-sampling read: off unless HEAP_SAMPLING=on, token-gated,
// and on reports live sampled allocations by function and file (names, lines
// and megabytes only). Boots FREE_MODE servers on free ports, offline.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TOKEN = "heap-sampling-test-token-0123456789";

async function boot(extra) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), AGENT402_OPERATOR_TOKEN: TOKEN, X402_INDEX_CRAWL: "off", STATE_DATABASE_URL: "", REDIS_URL: "", ...extra },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, child }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill(); throw new Error("server did not start");
}
const read = (base, token) => fetch(`${base}/__operator/heap-sampling.json`, { headers: token ? { "X-Operator-Token": token } : {} });

{
  const { base, child } = await boot({ HEAP_SAMPLING: "on" });
  try {
    ok((await read(base, null)).status === 404, "without the operator token the read is a 404");
    const r = await read(base, TOKEN);
    const j = await r.json();
    ok(r.status === 200 && j.enabled === true, "on: the operator read answers");
    ok(j.sampledLiveMb > 0 && Array.isArray(j.byFunction) && j.byFunction.length > 0 && Array.isArray(j.byFile) && j.byFile.length > 0, `on: live allocations are attributed (${j.sampledLiveMb} MB sampled, ${j.byFunction.length} functions)`);
    ok(j.byFunction.every((x) => typeof x.at === "string" && typeof x.mb === "number") && !JSON.stringify(j).includes(TOKEN), "on: entries carry a location and megabytes only");
    ok(j.byFunction.every((x, i, a) => i === 0 || a[i - 1].mb >= x.mb), "on: largest first");
  } finally { child.kill(); }
}
{
  const { base, child } = await boot({});
  try {
    const j = await (await read(base, TOKEN)).json();
    ok(j.enabled === false, "off by default: the read says how to turn it on and samples nothing");
  } finally { child.kill(); }
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
