// Offline test for refresh-bazaar's feed read: the Bazaar feed indexes with a
// lag and one walk can come back partially populated, so missing mode reads it
// in full passes until two agree (a third on disagreement) and treats a route
// as missing only when every pass lacks it.
//
// A stub fetch serves /api/pricing, /openapi.json and the discovery feed, with
// a different partial feed on each pass and pages shorter than the limit asked
// for. Every run is DRY_RUN=1 or refused by the estimate, so nothing pays.
//
// Run: node scripts/test-bazaar-twopass.js
const TARGET = "http://catalog.test";
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}${detail ? `\n  ${detail}` : ""}`); }
};

const CATALOG = [
  { slug: "a", path: "/api/a", price: "$0.01" },
  { slug: "b", path: "/api/b", price: "$0.10" },
  { slug: "c", path: "/api/c", price: "$0.20" },
  { slug: "d", path: "/api/d", price: "$0.03" },
  { slug: "e", path: "/api/e", price: "$0.04" },
].map((t) => ({ ...t, method: "POST" }));

const ours = (p) => ({ resource: `${TARGET}${p}`, serviceName: "x", accepts: [{ network: "eip155:8453" }] });
const other = (n) => ({ resource: `https://other.test/${n}`, serviceName: "y", accepts: [] });

// Stub state: `passes` is the feed each successive walk sees (the last one
// repeats); `pageCap` is the most rows any one page returns, whatever limit
// was asked for; `emptyAt` serves an empty page at that offset.
let feedPasses = [];
let pageCap = 2;
let emptyAt = null;
let walks = 0;
let offsetsSeen = [];

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (`${u.origin}${u.pathname}` === BAZAAR) {
    const offset = Number(u.searchParams.get("offset") || 0);
    const limit = Number(u.searchParams.get("limit") || 20);
    if (offset === 0) walks++;
    offsetsSeen.push({ walk: walks, offset, limit });
    const rows = feedPasses[Math.min(walks, feedPasses.length) - 1];
    const items = emptyAt != null && offset >= emptyAt ? [] : rows.slice(offset, offset + Math.min(limit, pageCap));
    return json({ items, pagination: { limit, offset, total: rows.length }, x402Version: 2 });
  }
  if (u.origin === TARGET && u.pathname === "/api/pricing") return json({ endpoints: CATALOG, payment: { networks: ["base"] } });
  if (u.origin === TARGET && u.pathname === "/openapi.json") return json({ paths: {} });
  throw new Error(`unexpected fetch ${url}`);
};

let importN = 0;
async function run({ maxSpend, feeds, cap = 2, empty = null }) {
  feedPasses = feeds; pageCap = cap; emptyAt = empty; walks = 0; offsetsSeen = [];
  process.env.TARGET_URL = TARGET;
  process.env.MODE = "missing";
  process.env.DRY_RUN = "1";
  process.env.MAX_SPEND_USD = String(maxSpend);
  const mod = await import(`./refresh-bazaar.js?run=${++importN}`);
  const out = [];
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = (...a) => out.push(a.join(" "));
  let code, thrown = null;
  try { code = await mod.runMissingMode(); } catch (e) { thrown = e; } finally { console.log = log; console.error = err; console.warn = warn; }
  return { code, thrown, out: out.join("\n"), walks };
}

// Three partial feeds that disagree. Pass 1 holds a and b (b only on its
// second page, behind a short first page); pass 2 holds a and c; pass 3 holds
// only a. Absent from every pass: d and e.
const PASS1 = [other(1), ours("/api/a"), other(2), ours("/api/b"), other(3)];
const PASS2 = [other(1), ours("/api/a"), other(2), ours("/api/c"), other(3)];
const PASS3 = [other(1), ours("/api/a"), other(2), other(3)];
const DISAGREE = [PASS1, PASS2, PASS3];

{
  const r = await run({ maxSpend: 0.1, feeds: DISAGREE });
  check("disagreeing passes: the run completes in DRY_RUN", r.code === 0 && !r.thrown, r.thrown?.message || r.out);
  check("disagreeing passes take a third walk", r.walks === 3, `walks=${r.walks}`);
  check("missing count is the routes absent from every pass", /missing: 2\b/.test(r.out), r.out);
  check("d and e are listed for purchase", /POST \/api\/d /.test(r.out) && /POST \/api\/e /.test(r.out), r.out);
  check("b (pass 1 only) is not bought", !/POST \/api\/b /.test(r.out), r.out);
  check("c (pass 2 only) is not bought", !/POST \/api\/c /.test(r.out), r.out);
  check("a (every pass) is not bought", !/POST \/api\/a /.test(r.out), r.out);
  check("the estimate is the agreed set's ($0.070)", /\$0\.070\b/.test(r.out), r.out);
  check("each pass's total and our-row count are printed", /5 rows \/ 2 ours, 5 rows \/ 2 ours, 4 rows \/ 1 ours/.test(r.out), r.out);
  check("the disagreement is said out loud", /passes disagree/.test(r.out), r.out);
  const pass1Offsets = offsetsSeen.filter((o) => o.walk === 1).map((o) => o.offset);
  check("a short page does not end the walk while pagination.total says more", JSON.stringify(pass1Offsets) === "[0,2,4]", JSON.stringify(pass1Offsets));
}

{
  // The agreed set costs $0.070. Pass 1 alone would have read c, d, e missing
  // ($0.270) and pass 2 alone b, d, e ($0.170); the refusal must quote the
  // agreed figure, not either single pass.
  const r = await run({ maxSpend: 0.05, feeds: DISAGREE });
  check("the refusal fires on the agreed estimate", r.code === 2, r.out);
  check("the refusal quotes $0.070, not a single pass's figure", /\$0\.070\b/.test(r.out) && !/\$0\.270|\$0\.170/.test(r.out), r.out);
  const ok = await run({ maxSpend: 0.08, feeds: DISAGREE });
  check("a ceiling the agreed set fits under is not refused", ok.code === 0 && !/Refusing/.test(ok.out), ok.out);
}

{
  const r = await run({ maxSpend: 1, feeds: [PASS1, PASS1, PASS2] });
  check("two agreeing passes stop at two walks", r.walks === 2, `walks=${r.walks}`);
  check("agreeing passes report agreement", /the last two agree/.test(r.out), r.out);
  check("agreeing passes: c, d and e are missing", /missing: 3\b/.test(r.out), r.out);
}

{
  // An empty page before pagination.total is a transport fault: the read
  // fails, so nothing is planned or bought from a short walk.
  const r = await run({ maxSpend: 1, feeds: [PASS1], empty: 2 });
  check("an empty page before the total fails the read instead of acting", !!r.thrown && /stopped short/.test(r.thrown.message), r.thrown?.message || r.out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
