// The wish board's intent judgment: what it must and must not be able to do.
//
// The valuable assertions here are the NEGATIVE ones. This is the first paid
// third-party model wired into anything in this tree, and the board it reads
// feeds a qualification rule that decides which demand signals get acted on.
// So what is pinned is mostly the blast radius: no key means no feature, a
// failing upstream changes nothing, and no judgment can move a count or flip
// `qualified`.
//
//   node scripts/test-wish-classify.js
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const KEY = "ts_test_key";
const mod = await import("../src/wish-classify.js");
const { classifyWishes, verdictOf, wishClassifyEnabled, __resetCache, CONFIDENT } = mod;

const stub = (answers, { status = 200, throws = false } = {}) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (throws) throw new Error("socket hang up");
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  f.calls = calls;
  return f;
};
// VERBATIM from a live api.typesafe.ai response, not invented. The first cut
// of this file guessed {probability: n}; the real wire is {type, noul: n}, so
// the parser returned null for every real answer while all 27 assertions here
// passed against the fixture built from the same guess. A stub can only ever
// prove the code agrees with the stub. Captured shape, 2026-09-21:
//   {"model":"jev-1.13.0","answers":{"advertises":{"type":"noul","noul":0.44}},...}
const noul = (n) => ({ type: "noul", noul: n });
const AD = { advertises: noul(0.97) };
const REQ = { advertises: noul(0.04) };

// --- no key, no feature -----------------------------------------------------
delete process.env.TYPESAFE_API_KEY;
__resetCache();
ok(wishClassifyEnabled() === false, "control: with no key the feature reports itself off");
{
  const f = stub(AD);
  const rows = [{ text: "buy my endpoint $1 usdc", count: 3, callers: 2, qualified: false }];
  const out = await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 0, "no key means NOT ONE upstream call is made");
  ok(!("intent" in out[0]), "and rows come back exactly as they arrived");
}

process.env.TYPESAFE_API_KEY = KEY;
__resetCache();
ok(wishClassifyEnabled() === true, "control: with a key the feature is on");

// --- it annotates, and only annotates ---------------------------------------
{
  __resetCache();
  const f = stub(AD);
  const row = { text: "rigo falsifier micro: $1 usdc base x402 get https://example.com/api", count: 9, callers: 4, qualified: true };
  const before = JSON.stringify({ count: row.count, callers: row.callers, qualified: row.qualified });
  await classifyWishes([row], { fetchImpl: f });
  ok(row.intent?.kind === "advertisement", `an advert is judged as one (got ${row.intent?.kind})`);
  ok(JSON.stringify({ count: row.count, callers: row.callers, qualified: row.qualified }) === before,
    "count, callers and qualified are UNTOUCHED - a judgment can never promote or demote a cluster");
  ok(f.calls[0].url.includes("typesafe"), "it called the configured endpoint");
  ok(f.calls[0].body.model && f.calls[0].body.questions.advertises.type === "noul",
    "the request carries a model and asks a noul, per the API contract");
  // ONE question, measured. A second noul asking "is this a request?" read 0.32
  // to 0.53 on obviously-a-request rows because it asks something the text does
  // not contain: whether the author could not FIND the thing. Pinned so it is not
  // re-added on the assumption that more questions mean more signal.
  ok(Object.keys(f.calls[0].body.questions).length === 1, "exactly ONE question is asked per row");
}

// --- the unconfident band says so -------------------------------------------
ok(verdictOf({ advertises: 0.97 }).kind === "advertisement", "confident advert");
ok(verdictOf({ advertises: 0.04 }).kind === "not-advertising",
  "the other side is not-advertising, NEVER request: that was never measured");
ok(verdictOf({ advertises: 0.55 }).kind === "unclear", "the middle band says unclear rather than rounding to a side");
ok(verdictOf({ advertises: null }) === null, "an unreadable probability yields no verdict at all");
// Live separation measured 2026-09-21: adverts 0.84-0.95, plain wishes 0.03-0.53.
for (const p of [0.84, 0.87, 0.91, 0.95]) ok(verdictOf({ advertises: p }).kind === "advertisement", `measured advert p=${p} is caught`);
for (const p of [0.03, 0.35, 0.52, 0.53]) ok(verdictOf({ advertises: p }).kind !== "advertisement", `measured plain wish p=${p} is not called an advert`);
ok(CONFIDENT > 0.5 && CONFIDENT <= 1, `the confidence bar is above a coin flip (${CONFIDENT})`);

// --- failure changes nothing ------------------------------------------------
for (const [label, opts] of [["a refused key (401)", { status: 401 }], ["a 500", { status: 500 }], ["a thrown socket error", { throws: true }]]) {
  __resetCache();
  const rows = [{ text: "something", count: 5, callers: 3, qualified: true }];
  const out = await classifyWishes(rows, { fetchImpl: stub(AD, opts) });
  ok(!("intent" in out[0]), `${label}: the row is returned unannotated, not broken`);
  ok(out[0].qualified === true && out[0].count === 5, `${label}: the board's own data survives untouched`);
}

// --- spend is bounded -------------------------------------------------------
{
  __resetCache();
  const f = stub(REQ);
  const rows = Array.from({ length: 40 }, (_, i) => ({ text: `wish number ${i}`, count: 1, callers: 1 }));
  await classifyWishes(rows, { fetchImpl: f, max: 5 });
  ok(f.calls.length === 5, `the per-run cap holds (${f.calls.length} calls for 40 rows)`);
  ok(rows.filter((r) => r.intent).length === 5, "and the rows past the cap are simply unannotated");
}
{
  __resetCache();
  const f = stub(REQ);
  const rows = [{ text: "same text", count: 1 }, { text: "same text", count: 1 }, { text: "same text", count: 1 }];
  await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 1, "an identical wish is judged ONCE and served from cache after");
  ok(rows.every((r) => r.intent?.kind === "not-advertising"), "every duplicate still gets the verdict");
}
{
  // A failing row must not be retried for every row in the same run, or one
  // dead upstream costs a full run's budget in timeouts.
  __resetCache();
  const f = stub(AD, { throws: true });
  const rows = [{ text: "x" }, { text: "x" }, { text: "x" }];
  await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 1, "a failure is remembered for the run rather than retried per row");
}

// --- the write path is not involved -----------------------------------------
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/wish.js", import.meta.url), "utf8");
  ok(!/wish-classify/.test(src),
    "src/wish.js does NOT import the classifier: recording a wish stays deterministic, free and synchronous");
}


// --- the operator wiring ------------------------------------------------------
// This is a PAID third-party call on a request path. Operator auth bounds WHO
// can spend, never how often - the rule the settlement-reconciliation route
// states two blocks above it in server.js. So the pass must be opt-in, rate
// limited, and absent by default. Pinned from source because the tempting
// simplification is to "just run it" on every board load.
{
  const { readFileSync } = await import("node:fs");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const seg = srv.slice(srv.indexOf("const wishIntentLimiter"), srv.indexOf('app.get("/__operator/wishes.json"') + 600);
  ok(seg.length > 200, "control: the wiring was located in server.js");

  ok(/wantsIntent\(req\)/.test(seg), "the pass runs only when the request asks for it");
  ok(/\?intent=1|query\?\.intent/.test(seg), "and the opt-in is an explicit query flag");
  ok(/wishIntentLimiter\.check/.test(seg), "a rate limiter bounds how often it can be asked for");
  ok(/createRateLimiter\("wish-intent"/.test(srv), "with its own bucket, not one shared with a different surface");
  ok(/!wishClassifyEnabled\(\)/.test(seg), "and it is skipped outright when no key is configured");
  ok(/try \{ await classifyWishes/.test(seg), "a failing pass cannot take the board down with it");

  // Both routes must go through the same seam, or one of them grows its own rules.
  const htmlRoute = srv.slice(srv.indexOf('app.get("/__operator/wishes"'), srv.indexOf('app.get("/__operator/wishes"') + 420);
  const jsonRoute = srv.slice(srv.indexOf('app.get("/__operator/wishes.json"'), srv.indexOf('app.get("/__operator/wishes.json"') + 420);
  ok(/withIntent\(req, agg\)/.test(htmlRoute), "the HTML board routes through the shared seam");
  ok(/withIntent\(req, agg\)/.test(jsonRoute), "and so does the JSON feed");

  // The renderer must keep the judgment OUT of the verdict that opens issues.
  const page = readFileSync(new URL("../src/operator-wishes.js", import.meta.url), "utf8");
  // Bound the slice at verdict()'s OWN end, not at the next export: intentCell
  // now sits between the two, so the wider slice swept it in and the assertion
  // failed against correct code.
  const vStart = page.indexOf("function verdict(c, threshold)");
  const vEnd = page.indexOf("\n}", page.indexOf('return { label: "held"', vStart));
  const verdictFn = page.slice(vStart, vEnd);
  ok(vStart > 0 && vEnd > vStart, "control: verdict() was located and bounded");
  ok(!/intent/i.test(verdictFn),
    "verdict() never reads intent: a model opinion cannot reach what opens a GitHub issue");
  ok(/function intentCell/.test(page), "the judgment renders in its own column instead");
}

console.log(`\n${pass} passed`);
