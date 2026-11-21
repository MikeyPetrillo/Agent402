// The Stripe-session endpoints are rate-limited BEFORE the body parser.
//
// Measured 2026-08-29: an Acunetix-class scanner (one IP, spoofed Chrome UA)
// put ~170 requests into POST /api/buy in about 25 seconds. Every payload was
// refused - the product field is an allowlist key lookup, so traversal, LFI,
// SSTI and ESI have nothing to land on - but 86 of them were answered 400
// before the old 20/min ceiling bit, and PostHog recorded only 43 refusals.
// The missing half is the finding: express.json() is mounted globally BEFORE
// these routes, so a request with an unparseable body 400s at the parser and
// never reaches an in-route rate check. Those requests were counted against
// nothing at all.
//
// So the check moved ahead of the parser, keyed per IP, and the ceiling came
// down to 6/min (a real buyer clicks Buy once, a few times if comparing).
// Locks both halves: the unparseable-body path is now counted, and one request
// still consumes exactly one token (the in-route checks must not double-count).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";

let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Port 0, read back from the listening line (scripts/lib/boot-server.js); its own stores.
const srv = await bootServer({ stores: "checkout-limiter", env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" } });
proc = srv.child;
const B = srv.url;

const post = (path, body, raw = false) =>
  fetch(`${B}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  }).then((r) => r.status).catch(() => 0);

try {

  // --- the path that used to bypass the limiter entirely ---
  const unparseable = [];
  for (let i = 0; i < 12; i++) unparseable.push(await post("/api/buy", '{not json', true));
  const blocked = unparseable.filter((s) => s === 429).length;
  ok(blocked > 0, `an unparseable body is rate-limited (${12 - blocked} served, ${blocked} refused 429)`);
  ok(unparseable.slice(0, 3).every((s) => s !== 429), "the first few still get a real answer - this is a ceiling, not a wall");
  ok(unparseable.at(-1) === 429, "a sustained burst ends in 429");
  ok(blocked >= 4, `the ceiling is tight enough to matter against a scanner (${blocked}/12 refused)`);

  // --- one request must consume exactly one token ---
  // The in-route checks still exist for any path the early guard does not
  // cover; on a covered path they must not fire a second time.
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const guardAt = src.indexOf("app.use(CHECKOUT_RATE_PATHS");
  // The global parser may be wrapped (unlessBodyUnread), so match either form.
  const parserAt = src.search(/app\.use\((?:unlessBodyUnread\()?express\.json\(\{ limit: "100kb" \}\)/);
  ok(guardAt > 0 && parserAt > 0 && guardAt < parserAt,
    "the rate check is mounted BEFORE the global body parser - otherwise a malformed body is never counted");
  // The wallet subscribe route lives in its own module (src/mpp-subscribe-route.js), its limiter passed in.
  const subscribeSrc = await (await import("node:fs/promises")).readFile(new URL("../src/mpp-subscribe-route.js", import.meta.url), "utf8");
  const inRoute = [...(src.match(/if \(!req\.__checkoutRateChecked && checkoutLimiter\.check/g) || []), ...(subscribeSrc.match(/if \(!req\.__checkoutRateChecked && rateLimited\(req\)\)/g) || [])];
  ok(/rateLimited: \(req\) => checkoutLimiter\.check\(clientIp\(req\)\)\.limited/.test(src), "the wallet subscribe route is handed the checkout limiter");
  ok(inRoute.length >= 4, `every in-route check is guarded by __checkoutRateChecked, so one request spends one token (${inRoute.length} sites)`);
  ok(!/if \(checkoutLimiter\.check\(clientIp\(req\)\)\.limited\) return res\.status\(429\)[\s\S]{0,40}\n\s*const product/.test(src),
    "no unguarded in-route check remains on a covered path");

  // --- the guard covers every Stripe-session endpoint, read from the server's answers ---
  // This address has spent its allowance on /api/buy above. The allowance is
  // one per address across the covered paths, so each of them now refuses an
  // unparseable body with 429 before any parser reads it; a POST route the
  // guard does not cover still gets its own answer.
  for (const p of ["/api/buy", "/api/subscribe", "/api/credits/checkout", "/api/mpp/monitors/subscribe"]) {
    const status = await post(p, "{not json", true);
    ok(status === 429, `${p} is covered by the pre-parser rate check (${status})`);
  }
  const uncovered = await post("/api/alerts", "{not json", true);
  ok(uncovered !== 429 && uncovered >= 400 && uncovered < 500, `control: a POST route outside the guard is not refused by it (${uncovered})`);

  // --- a GET is not consumed by the POST-only guard ---
  const before = await fetch(`${B}/reports`).then((r) => r.status).catch(() => 0);
  ok(before === 200, "the storefront page itself is untouched by the checkout limiter");

  console.log(`\nPASS - ${pass} checks (checkout rate limiter)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
