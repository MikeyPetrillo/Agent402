// /api/revenue is unauthenticated, and its rail rows carry an `error` string
// straight from whatever upstream failed. Eleven of the RPC endpoints those
// scanners walk carry ALCHEMY_API_KEY in the URL PATH, and an upstream can
// echo its own request back inside an error body - which is precisely how the
// key reached the public /api/leaderboard body in the 2026-08-18 leak.
//
// leaderboard.js, mpp-leaderboard.js, solana-leaderboard.js and
// tempo-transfers.js were all fixed then and pinned by
// scripts/test-leaderboard-redaction.js. revenue-live.js was not, and stayed
// the one public error surface in the tree producing raw upstream text. This
// pins that it redacts, and - the durable half - that a scanner added later
// cannot reintroduce the raw form.
//
//   node scripts/test-revenue-redaction.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const FAKE_KEY = "alch_REVENUELEAKCANARY_0123456789abcdef";
process.env.ALCHEMY_API_KEY = FAKE_KEY;
const { pubErr, describeError, rpcCall, getJsonAcross } = await import("../src/revenue-live.js");

// ---------------------------------------------------------------------------
// CONTROL FIRST. A redaction test that never sees an unredacted string cannot
// tell "the code redacts" from "nothing ever carried the secret". So prove the
// harness catches a leak before believing any clean result below.
// ---------------------------------------------------------------------------
const rawLeak = `rate limited for https://base-mainnet.g.alchemy.com/v2/${FAKE_KEY}`;
ok(rawLeak.includes(FAKE_KEY), "control: the planted message really does carry the key");
ok(!pubErr(new Error(rawLeak)).includes(FAKE_KEY), "pubErr strips a key an upstream echoed back");
// Short enough that describeError's own 90-char slice cannot remove the key
// for us: a long message would make this assertion pass whether the code
// redacts or not, which is how the first draft of this test passed against an
// unredacted describeError.
const shortLeak = `boom ${FAKE_KEY}`;
ok(shortLeak.length < 90, "control: the message survives describeError's slice intact, so only redaction can remove the key");
ok(!describeError(new Error(shortLeak)).includes(FAKE_KEY), "describeError strips it too (the rpcCall funnel)");
ok(pubErr(new Error(rawLeak)).includes("[redacted]"), "the replacement is visible, not a silent truncation");

// Redact-then-truncate, not the reverse: slicing first can cut a secret in
// half and leave a matchable prefix the redactor no longer recognises.
// The key must START inside the budget and END outside it. Redact-first
// removes the whole thing; truncate-first leaves a matchable prefix behind.
const straddle = "x".repeat(110) + FAKE_KEY;
ok(straddle.slice(0, 120).includes(FAKE_KEY.slice(0, 10)) && !straddle.slice(0, 120).includes(FAKE_KEY),
  "control: at this length a plain 120-char slice really does leave a key prefix behind");
ok(!pubErr(new Error(straddle), 120).includes(FAKE_KEY.slice(0, 10)),
  "a key straddling the truncation point is redacted before the slice, not bisected by it");

// ---------------------------------------------------------------------------
// End to end, through the two real transports, against stubs that echo the URL.
// ---------------------------------------------------------------------------
const echoRpc = createServer((req, res) => {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: `rate limited for ${req.url}` } }));
});
const echoGet = createServer((req, res) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `upstream said: ${req.url}` }));
});
await Promise.all([new Promise((r) => echoRpc.listen(0, r)), new Promise((r) => echoGet.listen(0, r))]);

let thrown = "";
try {
  await rpcCall([`http://127.0.0.1:${echoRpc.address().port}/v2/${FAKE_KEY}`], "eth_blockNumber", []);
} catch (e) { thrown = pubErr(e, 400); }
ok(thrown.length > 0, "rpcCall against a refusing lane throws");
ok(!thrown.includes(FAKE_KEY), `rpcCall's thrown text carries no key (got: ${thrown.slice(0, 90)})`);

// getJsonAcross reports a non-2xx as `HTTP <status>` and only a THROWN failure
// as upstream text, so the leak path here is the throw. A dead port gives one.
const across = await getJsonAcross([`http://127.0.0.1:1/v2/${FAKE_KEY}`], "/x", { timeoutMs: 800 });
ok(across.ok === false, "getJsonAcross reports failure for a dead lane");
ok(!String(across.error).includes(FAKE_KEY), `getJsonAcross's error carries no key (got: ${String(across.error).slice(0, 90)})`);

echoRpc.close(); echoGet.close();

// ---------------------------------------------------------------------------
// SOURCE PIN - the half that outlives these cases. Every public `error` string
// in this module must go through pubErr(). A scanner added next month will
// copy the line above it, so the line above it has to be the safe one.
// ---------------------------------------------------------------------------
const src = readFileSync(join(ROOT, "src", "revenue-live.js"), "utf8");
ok(/import \{ redactSecrets \} from "\.\/tools\/redact\.js"/.test(src), "revenue-live imports redactSecrets");

const rawAssignments = src.split("\n")
  .map((line, i) => [i + 1, line])
  .filter(([, l]) => /\berror\s*[:=]\s*String\(/.test(l));
ok(rawAssignments.length === 0,
  `no public error is built with a raw String(...) (found: ${rawAssignments.map(([n]) => n).join(", ") || "none"})`);

const pubErrSites = (src.match(/pubErr\(/g) || []).length;
ok(pubErrSites >= 13, `every scanner routes its error through pubErr (${pubErrSites} call sites)`);

console.log(`\n${pass} passed`);

// ---------------------------------------------------------------------------
// The scraping bound on the same surface. Source-pinned rather than driven:
// booting the whole server to spend 60 requests proves less than pinning that
// the middleware is mounted on every path and BEFORE the handlers, which is
// the property that actually decides whether it runs.
// ---------------------------------------------------------------------------
const srv = readFileSync(join(ROOT, "src", "server.js"), "utf8");
const mountAt = srv.indexOf("app.use(REVENUE_READ_PATHS");
ok(mountAt > 0, "the revenue read limiter is mounted");

const PROTECTED = ["/revenue", "/api/revenue", "/api/revenue/daily", "/api/revenue/mpp", "/api/revenue/tempo-daily", "/api/calls/daily"];
const pathsDecl = /const REVENUE_READ_PATHS = \[([^\]]*)\]/.exec(srv);
ok(!!pathsDecl, "REVENUE_READ_PATHS is declared");
for (const p of PROTECTED) {
  ok(pathsDecl[1].includes(`"${p}"`), `${p} is inside the bound`);
  // Express runs middleware in mount order, so a limiter declared after the
  // route it guards never runs for it.
  const handlerAt = srv.indexOf(`app.get("${p}"`);
  if (handlerAt > 0) ok(mountAt < handlerAt, `the limiter is mounted BEFORE the ${p} handler`);
}
ok(/createRateLimiter\("revenue-read"/.test(srv), "it has its own bucket, not one shared with a tighter surface");
const perMin = /createRateLimiter\("revenue-read", \{ perMin: (\d+)/.exec(srv);
ok(perMin && Number(perMin[1]) >= 30,
  `the bound stays generous enough for honest polling (perMin=${perMin?.[1]}); these responses are cached 30-300s and a page load fires four`);
ok(/Retry-After/.test(srv.slice(mountAt, mountAt + 1200)), "a refusal carries Retry-After, so a crawler backs off instead of dropping the page");

console.log(`${pass} passed (including the scraping bound)`);
