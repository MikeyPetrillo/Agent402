// POST /api/index/register is bounded in time. Registering an origin whose
// discovery lists slow third-party resources (a cold-starting host) used to
// hold the request for minutes: every listed route was probed in turn, each
// with its own 8 s limit. Now the whole registration answers by its deadline
// (INDEX_REGISTER_DEADLINE_MS): when the verification is still running the
// answer is `pending` (the route answers 202) and the listing completes in
// the background or on the next crawl, and the per-route probing stops
// starting new probes once the registration's deadline has passed.
// Offline: the stub origin is an injected crawler and a stubbed fetch.
process.env.X402_INDEX_CRAWL = "off";
process.env.STATE_DATABASE_URL = "";
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const DIR = mkdtempSync(join(tmpdir(), "index-register-deadline-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");
process.env.SUBMITTED_SEEDS_FILE = join(DIR, "submitted-seeds.json");
const xi = await import("../src/x402-index.js");

// A registration that never answers leaves the top-level await unsettled, and
// Node exits 13: name it as the failure it is.
process.on("exit", (c) => { if (c === 13) console.error("FAIL - a registration never answered (the call hung)"); });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
xi.__testResetSubmitted();
xi.loadRemovedOrigins();

try {
  // ---- a registration whose verification outlasts the deadline -------------
  {
    const origin = "https://slow-seller.example";
    let calls = 0;
    let finish;
    const crawl = async () => { calls++; await new Promise((r) => { finish = r; }); return { manifest: { name: "Slow" }, tools: [{ slug: "s", route: "/v1/s", price: "0.01" }], error: null, history: [true] }; };
    const t0 = Date.now();
    const r = await xi.registerOrigin(origin, { crawl, deadlineMs: 300 });
    const took = Date.now() - t0;
    ok(took < 1500, `the registration answers by its deadline (${took} ms)`);
    ok(r?.pending === true && r.listed === false && r.origin === origin, `the answer says the verification is still running (${JSON.stringify(r)})`);
    ok(/next crawl|background/.test(String(r?.note || "")), "the answer says the listing completes later");
    // A second call for the same origin joins the running verification.
    const r2 = await xi.registerOrigin(origin, { crawl, deadlineMs: 200 });
    ok(r2?.pending === true && calls === 1, `a second registration while the first runs joins it (crawls ${calls})`);
    finish();
    await sleep(50);
    ok(Boolean(xi.sellerEntry(origin)), "the listing completes in the background once the verification finishes");
  }

  // ---- a registration that finishes in time is answered as before ------------
  {
    const origin = "https://quick-seller.example";
    const crawl = async () => ({ manifest: { name: "Quick" }, tools: [{ slug: "q", route: "/v1/q", price: "0.01" }], error: null, history: [true] });
    const r = await xi.registerOrigin(origin, { crawl, deadlineMs: 2000 });
    ok(r?.listed === true && !r.pending, `a quick registration is listed in the same answer (${JSON.stringify(r?.listed)})`);
  }

  // ---- per-route probing stops starting new probes past the deadline ---------
  {
    const origin = "https://93.184.215.14"; // a public literal: no DNS; fetch is stubbed below
    const tools = Array.from({ length: 8 }, (_, i) => ({ slug: `r${i}`, route: `/r${i}`, method: "GET", seller: origin, price: null, networks: [] }));
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async (_url, opts = {}) => {
      fetches++;
      // A cold-starting resource: no answer for 400 ms, then a 503.
      await sleep(400);
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("", { status: 503 });
    };
    try {
      const t0 = Date.now();
      await xi.enrichLiveQuotes(tools, origin, { ignoreBudget: true, deadlineAt: Date.now() + 600 });
      const took = Date.now() - t0;
      ok(took < 2500, `probing ends shortly after the deadline (${took} ms for ${fetches} probe request(s))`);
      ok(fetches < 8, `no new probe starts after the deadline (${fetches} of at least 8 requests)`);
    } finally { globalThis.fetch = realFetch; }
  }
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-register-deadline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
