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
  // The store answers "held" once, then fails while this call waits: the local
  // fallback must not start inside the second another call still holds.
  pace._resetNominatimPace();
  let calls = 0;
  __setTestClient({
    isReady: true,
    async set() { if (calls++ === 0) return null; throw new Error("down"); },
    async pTTL() { return 400; },
  });
  const t1 = Date.now();
  ok((await pace.nominatimSlot()) === true && Date.now() - t1 >= 1350, `shared: a store failure mid-wait starts locally one slot after the held second (${Date.now() - t1} ms)`);
  console.log(failed ? `${failed} failed` : "shared part passed");
  process.exit(failed ? 1 : 0);
}
if (process.argv[2] !== "geo") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "shared"], {
    env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS: "" }, encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  ok(r.status === 0, "shared-store part passed in its own process");
}

// ---- caller path: the geo kit's three Nominatim sites (child process) ----
if (process.argv[2] === "geo") {
  process.env.SHARED_LIMITS = "off";
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(new URL(String(url)).host);
    const body = String(url).includes("photon") ? { features: [{ geometry: { coordinates: [2.29, 48.85] }, properties: { name: "P", countrycode: "FR" } }] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const pace = await import("../src/tools/nominatim-pace.js");
  const geo = await import("../src/tools/geo-kit.js");
  const tools = Object.values(geo).find(Array.isArray);
  const h = (r) => tools.find((t) => t.route === r).handler;
  await pace.nominatimSlot(); // this process's second is taken
  process.env.NOMINATIM_PACE_WAIT_MS = "0";
  for (const [route, input] of [["GET /api/geocode", { q: "Eiffel Tower" }], ["GET /api/reverse-geocode", { lat: 48.85, lon: 2.29 }], ["GET /api/place-search", { q: "cafe" }]]) {
    seen.length = 0;
    const out = await h(route)(input).catch((e) => ({ error: e.message }));
    ok(String(out.source || "").startsWith("photon") && !seen.includes("nominatim.openstreetmap.org"), `${route}: no slot -> answered by the fallback geocoder, Nominatim not called`);
  }
  console.log(failed ? `${failed} failed` : "geo part passed");
  process.exit(failed ? 1 : 0);
}
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "geo"], { env: { ...process.env, REDIS_URL: "" }, encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr.split("\n").filter((l) => !l.startsWith("[geo]")).join("\n"));
  ok(r.status === 0, "geo caller-path part passed in its own process");
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
