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
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: "ignore",
});

const post = (path, body, raw = false) =>
  fetch(`${B}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  }).then((r) => r.status).catch(() => 0);

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

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
  const parserAt = src.indexOf('app.use(express.json({ limit: "100kb" }))');
  ok(guardAt > 0 && parserAt > 0 && guardAt < parserAt,
    "the rate check is mounted BEFORE the global body parser - otherwise a malformed body is never counted");
  const inRoute = src.match(/if \(!req\.__checkoutRateChecked && checkoutLimiter\.check/g) || [];
  ok(inRoute.length >= 4, `every in-route check is guarded by __checkoutRateChecked, so one request spends one token (${inRoute.length} sites)`);
  ok(!/if \(checkoutLimiter\.check\(clientIp\(req\)\)\.limited\) return res\.status\(429\)[\s\S]{0,40}\n\s*const product/.test(src),
    "no unguarded in-route check remains on a covered path");

  // --- the list actually covers every Stripe-session endpoint ---
  const paths = (src.match(/const CHECKOUT_RATE_PATHS = \[(.*?)\]/s) || [])[1] || "";
  for (const p of ["/api/buy", "/api/subscribe", "/api/credits/checkout", "/api/mpp/monitors/subscribe"]) {
    ok(paths.includes(`"${p}"`), `${p} is covered by the pre-parser rate check`);
  }

  // --- a GET is not consumed by the POST-only guard ---
  const before = await fetch(`${B}/reports`).then((r) => r.status).catch(() => 0);
  ok(before === 200, "the storefront page itself is untouched by the checkout limiter");

  console.log(`\nPASS - ${pass} checks (checkout rate limiter)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
