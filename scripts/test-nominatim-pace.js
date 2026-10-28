// Nominatim allows one request per second per application. nominatimSlot()
// holds that across the service: through the shared store when one is
// configured, else one second per replica in this process. A call that cannot
// get a slot within the wait budget is refused (the geo kit then answers from
// Photon). Offline: an in-memory stand-in for the Redis commands it uses.
import { __setTestClient } from "../src/shared-limit.js";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

process.env.NOMINATIM_PACE_WAIT_MS = "2500";

// ---- shared store (child process: the store mode is read at import) ----
if (process.argv[2] === "shared") {
  // Two "replicas" share one fake store: SET NX PX and PTTL, as Redis answers them.
  const store = new Map();
  const live = (k) => { const e = store.get(k); if (e && e.until <= Date.now()) store.delete(k); return store.get(k); };
  __setTestClient({
    isReady: true,
    async set(k, v, o) { if (o?.NX && live(k)) return null; store.set(k, { v, until: Date.now() + (o?.PX || 0) }); return "OK"; },
    async pTTL(k) { const e = live(k); return e ? e.until - Date.now() : -2; },
  });
  process.env.RATE_LIMIT_REPLICAS = "2";
  const pace = await import("../src/tools/nominatim-pace.js");
  const t0 = Date.now();
  const starts = [];
  await Promise.all([0, 1, 2].map(async () => { const got = await pace.nominatimSlot(); starts.push([got, Date.now() - t0]); }));
  starts.sort((a, b) => a[1] - b[1]);
  ok(starts.every(([g]) => g), "shared: three calls inside the budget all get a slot");
  ok(starts[1][1] >= 950 && starts[2][1] >= 1950 && starts[2][1] < 2600, `shared: one call per second across the service, not one per replica (${starts.map((s) => s[1]).join(", ")} ms)`);
  ok(pace.nominatimPaceCounts().shared === 3 && pace.nominatimPaceCounts().local === 0, "shared: every slot came from the shared store");
  process.env.NOMINATIM_PACE_WAIT_MS = "300";
  await pace.nominatimSlot();
  ok((await pace.nominatimSlot()) === false, "shared: a call that cannot get the second within the budget is refused");
  __setTestClient({ isReady: true, async set() { throw new Error("down"); }, async pTTL() { throw new Error("down"); } });
  process.env.NOMINATIM_PACE_WAIT_MS = "2500";
  ok((await pace.nominatimSlot()) === true && pace.nominatimPaceCounts().local === 1, "shared: a store error falls back to this process's spacing");
  console.log(failed ? `${failed} failed` : "shared part passed");
  process.exit(failed ? 1 : 0);
}
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "shared"], {
    env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS: "" }, encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  ok(r.status === 0, "shared-store part passed in its own process");
}

// ---- local spacing (no shared store) ----
delete process.env.REDIS_URL;
process.env.SHARED_LIMITS = "off";
process.env.RATE_LIMIT_REPLICAS = "1";
const pace = await import("../src/tools/nominatim-pace.js");
{
  pace._resetNominatimPace();
  const t0 = Date.now();
  const starts = [];
  await Promise.all([0, 1, 2].map(async () => { const got = await pace.nominatimSlot(); starts.push([got, Date.now() - t0]); }));
  starts.sort((a, b) => a[1] - b[1]);
  ok(starts.every(([g]) => g), "local: three calls inside the budget all get a slot");
  ok(starts[1][1] >= 950 && starts[2][1] >= 1950, `local: calls start a second apart (${starts.map((s) => s[1]).join(", ")} ms)`);
}
{
  pace._resetNominatimPace();
  process.env.NOMINATIM_PACE_WAIT_MS = "500";
  const results = await Promise.all([0, 1].map(() => pace.nominatimSlot()));
  ok(results[0] === true && results[1] === false, "local: a call whose slot starts past the budget is refused, not queued");
  ok(pace.nominatimPaceCounts().refused === 1, "local: the refusal is counted");
  process.env.NOMINATIM_PACE_WAIT_MS = "2500";
}
{
  pace._resetNominatimPace();
  process.env.RATE_LIMIT_REPLICAS = "2";
  const t0 = Date.now();
  await pace.nominatimSlot();
  await pace.nominatimSlot();
  ok(Date.now() - t0 >= 1950, "local: two replicas space each process at two seconds");
  process.env.RATE_LIMIT_REPLICAS = "1";
}

console.log(failed ? `${failed} failed` : "all passed");
__setTestClient(null);
process.exit(failed ? 1 : 0);
