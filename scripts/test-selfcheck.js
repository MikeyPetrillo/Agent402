// Self-check unit test — offline, deterministic. Locks the behavior that makes
// the prod tool-failure alarm trustworthy: a tool is only reported failing if it
// fails TWICE (single transient blips are filtered), a tool that fails-then-
// recovers is flagged `flaky` but NOT reported failing, and a timeout counts as
// a failure. Uses a synthetic catalog of fake handlers — no network.
import { runSelfCheck, selfcheckSlugs, SELFCHECK_SLUGS } from "../src/selfcheck.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- key-gated curation: monitor expiry only when the key is configured -------
delete process.env.FRED_API_KEY;
delete process.env.BRAVE_API_KEY;
ok(!selfcheckSlugs().includes("cpi-yoy") && !selfcheckSlugs().includes("search"),
  "keyed tools are SKIPPED when their key is unset (no false-page on a fork / disabled feature)");
ok(selfcheckSlugs().length === SELFCHECK_SLUGS.length, "unset keys leave the keyless list unchanged");
process.env.FRED_API_KEY = "test-key";
ok(selfcheckSlugs().includes("cpi-yoy") && !selfcheckSlugs().includes("search"),
  "a keyed tool is ADDED once its key is set (catches expiry), others stay skipped");
delete process.env.FRED_API_KEY;

// A catalog is route->def; runSelfCheck maps by def.slug. Build fakes whose
// handlers behave as named. `attempts` counts calls so we can model flakiness.
const attempts = {};
const def = (slug, handler) => ({ [`GET /api/${slug}`]: { slug, discovery: { input: {} }, handler } });
const catalog = {
  ...def("always-ok", async () => ({ ok: 1 })),
  ...def("always-fail", async () => { throw Object.assign(new Error("boom"), { statusCode: 502 }); }),
  ...def("flaky", async () => { attempts.flaky = (attempts.flaky || 0) + 1; if (attempts.flaky === 1) throw Object.assign(new Error("blip"), { statusCode: 504 }); return { ok: 1 }; }),
  ...def("slow", async () => { await new Promise((r) => setTimeout(r, 5000)); return { ok: 1 }; }),
};

// timeoutMs small so the "slow" tool times out fast in the test.
const r = await runSelfCheck(catalog, ["always-ok", "always-fail", "flaky", "slow", "ghost"], { timeoutMs: 200 });
const bySlug = Object.fromEntries(r.results.map((x) => [x.slug, x]));

ok(bySlug["always-ok"].ok === true, "a healthy tool passes");
ok(bySlug["always-fail"].ok === false && bySlug["always-fail"].status === 502, "a tool that fails twice is reported failing (status preserved)");
ok(bySlug["flaky"].ok === true && bySlug["flaky"].flaky === true, "a fail-then-recover tool passes but is flagged flaky (transient filtered)");
ok(bySlug["slow"].ok === false && bySlug["slow"].status === 504, "a tool exceeding the timeout is a 504 failure");
ok(bySlug["ghost"].ok === false && /not in catalog/.test(bySlug["ghost"].error), "an unknown slug is reported, not silently skipped");
ok(r.ok === false && r.failing.sort().join(",") === "always-fail,ghost,slow", `top-level failing list is exactly the real failures (got ${JSON.stringify(r.failing)})`);
ok(r.checked === 5, "checked count matches requested slugs");

// --- a broken metered tool must not bill us on every poll --------------------
//
// Keyed successes were cached for 6h but FAILURES were deliberately not cached,
// so a real key problem re-tested on every 30-minute poll - with a retry, that
// is ~96 billed Brave requests a day, and it bills hardest exactly when the
// thing is already broken. The outage pays for itself twice.
//
// Failures are now cached on a short TTL. The property that must NOT change:
// caching a failure cannot hide it. The cached result is still ok:false, so the
// endpoint still reports it and tool-alert.yml still pages.
{
  const { runSelfCheck } = await import("../src/selfcheck.js");
  const prevKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";
  let upstream = 0;
  const catalog = {
    "GET /api/search": { slug: "search", discovery: { input: {} },
      handler: async () => { upstream++; throw new Error("brave down"); } },
  };

  const r1 = await runSelfCheck(catalog, ["search"], { timeoutMs: 2000 });
  const afterFirst = upstream;
  const r2 = await runSelfCheck(catalog, ["search"], { timeoutMs: 2000 });
  const r3 = await runSelfCheck(catalog, ["search"], { timeoutMs: 2000 });

  ok(afterFirst > 0, `the first run really calls the tool (${afterFirst} upstream calls: attempt + retry)`);
  ok(upstream === afterFirst,
    `repeat polls do NOT re-call a metered upstream that is already known broken (still ${upstream})`);
  ok(r1.ok === false && r2.ok === false && r3.ok === false,
    "every run still reports NOT ok - caching a failure must never hide it");
  ok(r2.failing.includes("search") && r3.failing.includes("search"),
    "the failing tool stays in `failing` on cached runs, so the alarm keeps paging");

  if (prevKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = prevKey;
}


// --- the free HTTP surface cannot be used to drive metered upstreams ---------
//
// /api/selfcheck is unauthenticated and a fresh run calls CoinGecko (Demo key,
// monthly quota), billed Databento queries and public RPCs. With a 5-minute
// cache an outside poller could force ~288 runs a day. A public caller must now
// get at most one run per 30 minutes; the operator may force a fresher one with
// ?fresh=1, but not more than once per 5 minutes.
{
  const { createSelfCheckRoute, SELFCHECK_PUBLIC_TTL_MS } = await import("../src/selfcheck.js");
  let t = 1_000_000;
  let runs = 0;
  const route = createSelfCheckRoute({
    run: async () => { runs++; return { ok: true, checked: 1, failing: [], results: [] }; },
    isOperator: (req) => req.headers?.authorization === "Bearer op",
    now: () => t,
  });
  const call = async (req) => {
    let body = null, status = 200;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    await route({ query: {}, headers: {}, ...req }, res);
    return { status, body };
  };
  const pub = (q = {}) => call({ query: q });
  const op = (q = {}) => call({ query: q, headers: { authorization: "Bearer op" } });

  const first = await pub();
  ok(runs === 1 && first.body.cached === false && first.body.ok === true, "control: the first public call runs the check and reports it");
  ok(SELFCHECK_PUBLIC_TTL_MS >= 30 * 60 * 1000, "public cache is at least 30 minutes (the tool-alert.yml cadence)");
  for (let i = 0; i < 12; i++) { t += 5 * 60 * 1000 / 2; await pub(); } // every 2.5 min for 30 min
  ok(runs === 1 || runs === 2, `a public poller every 2.5 minutes for 30 minutes causes at most one more run (runs=${runs})`);
  const before = runs;
  t += 6 * 60 * 1000; // past the operator floor, inside the public window
  await pub({ fresh: "1" });
  ok(runs === before, "?fresh=1 from an unauthenticated caller is ignored (served from cache)");
  const c = await pub();
  ok(c.body.cached === true && typeof c.body.cacheTtlSeconds === "number" && typeof c.body.ageSeconds === "number",
    "a cached answer says so, with its age and the cache window");

  // Operator: may force a fresh run, but only past the 5-minute floor.
  t += 6 * 60 * 1000;
  const r1 = runs;
  const f1 = await op({ fresh: "1" });
  ok(runs === r1 + 1 && f1.body.cached === false, "control: the operator's ?fresh=1 runs a new check once the cache is 5+ minutes old");
  t += 60 * 1000;
  await op({ fresh: "1" });
  ok(runs === r1 + 1, "the operator cannot force runs more often than once per 5 minutes");
  const f2 = await op();
  ok(runs === r1 + 1 && f2.body.cached === true, "an operator call without ?fresh=1 is served from cache like anyone else");

  // Single flight: a burst of callers on a cold cache shares one run.
  let slowRuns = 0;
  const slow = createSelfCheckRoute({ run: async () => { slowRuns++; await new Promise((r) => setTimeout(r, 50)); return { ok: true }; } });
  const mk = () => ({ status() { return this; }, json() { return this; } });
  await Promise.all(Array.from({ length: 20 }, () => slow({ query: {}, headers: {} }, mk())));
  ok(slowRuns === 1, `20 concurrent callers on a cold cache share one run (runs=${slowRuns})`);
}


// The route in server.js must be the tested one, not a private cache of its own.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const m = src.match(/app\.get\("\/api\/selfcheck",\s*createSelfCheckRoute\(/);
  ok(!!m, "server.js mounts /api/selfcheck through createSelfCheckRoute");
  ok(!/SELFCHECK_TTL_MS\s*=/.test(src), "server.js keeps no second self-check cache window of its own");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
