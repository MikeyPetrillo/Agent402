// GET /api/r/:sessionId answers a read failure with a fixed message, never
// the error's own text (the database driver's words); the detail goes to the
// server log. Boots the real server with card checkout on, its state
// database behind a relay the test cuts, and every payment-API connection
// refused locally (a preload), so nothing leaves the machine.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { createServer } from "node:net";
import { bootServer } from "./lib/boot-server.js";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0, srv = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = mkdtempSync(join(tmpdir(), "session-read-"));
const serverLog = () => (srv?.log() || "").split("\n").filter((l) => l.trim()).map((l) => l.slice(0, 400));
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog().slice(-25)) console.error("  server:", l); srv?.child.kill("SIGKILL"); process.exit(1); }, 120_000).unref();

const { url: DIRECT, schema } = requireTestPg({ label: "test-session-read-error-pg" });
const relay = await startPgRelay(DIRECT);
// The payment API's sockets go to a local listener on port 0 that drops every
// connection, held open for the whole run so no other socket can take its port.
const dead = createServer((s) => s.destroy());
await new Promise((r) => dead.listen(0, "127.0.0.1", r));
const DEAD = dead.address().port;
const preload = join(TMP, "refuse-stripe.mjs");
writeFileSync(preload, `
import https from "node:https";
const DEAD = ${DEAD};
const realReq = https.request;
https.request = function (opts, ...rest) {
  const host = typeof opts === "string" ? new URL(opts).host : opts instanceof URL ? opts.host : (opts?.host || opts?.hostname || "");
  if (String(host).includes("stripe.com") && opts && typeof opts === "object" && !(opts instanceof URL)) return realReq.call(this, { ...opts, host: "127.0.0.1", hostname: "127.0.0.1", port: DEAD }, ...rest);
  return realReq.call(this, opts, ...rest);
};
const realFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  let host = ""; try { host = typeof url === "string" ? new URL(url).hostname : ""; } catch { /* not a URL */ }
  if (host === "stripe.com" || host.endsWith(".stripe.com")) return Promise.reject(new Error("refused by the test preload"));
  return realFetch.call(this, input, init);
};
`);
srv = await bootServer({
  stores: false,
  args: ["--import", preload],
  timeoutMs: 80_000,
  env: { TRUST_PROXY_HOPS: "1", FREE_MODE: "true", STRIPE_SECRET_KEY: "sk_test_never_used_offline", STRIPE_WEBHOOK_SECRET: "", POSTHOG_API_KEY: "",
    STATE_DATABASE_URL: relay.url, STATE_DB_SCHEMA: schema, STATE_DB_CONNECT_TIMEOUT_MS: "1000", STATE_DB_QUERY_TIMEOUT_MS: "2000", REDIS_URL: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    HUMAN_CHECKOUT_DIR: TMP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db") },
});
const B = srv.url;
try {
  relay.cut();
  const r = await fetch(`${B}/api/r/cs_test_session_read_error_${Date.now()}`, { headers: { "x-forwarded-for": "10.7.0.1" } });
  const body = await r.json().catch(() => ({}));
  ok(r.status === 500, `a read that fails answers 500 (${r.status} ${JSON.stringify(body)})`);
  ok(body.status === "error" && body.error === "The report could not be read right now. Please retry in a moment.", `...with the fixed message only (${body.error})`);
  ok(!/stripe|connect|ECONN|timeout|terminat|127\.0\.0\.1|postgres/i.test(JSON.stringify(body)), "...and no error text from the failing dependency");
  await sleep(200);
  ok(serverLog().some((l) => l.includes("[human-checkout] report read failed:")), "the detail is in the server log");
} finally {
  srv?.child.kill("SIGKILL");
  dead.close();
  relay.heal();
  try {
    const pg = (await import("pg")).default; const c = new pg.Client({ connectionString: DIRECT }); await c.connect();
    try { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await c.end(); }
  } catch { /* best effort */ }
  await relay.close();
}
if (fail) for (const l of serverLog().slice(-20)) console.error("  server:", l);
console.log(`\ntest-session-read-error: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
