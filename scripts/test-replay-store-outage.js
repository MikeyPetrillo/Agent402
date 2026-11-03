// The replay guard while its shared store is configured but unreachable, on
// the real server, as two containers would run it: TWO servers configured as
// two replicas boot with a REDIS_URL naming a local port nothing listens on.
// Every paid route (a long-running one and a fast one alike) is refused with
// a 503 and Retry-After before any payment is verified or settled, so one
// signed payment sent to both containers at once runs nowhere and reaches
// the facilitator zero times (a per-process claim would let each container
// run the handler and send it to the facilitator). A single container
// (src/replay-topology.js) refuses a fast route only inside its deploy
// overlap window; past it a fast route is served on the per-process claim,
// so a store outage does not stop sales, and a long-running route is still
// refused. Controls: the same kind of
// payment is served and settled once by a server with NO shared store
// configured (one process: the per-process claim is the guarantee), and,
// when the caller provides a real REDIS_URL, two servers sharing that Redis
// serve one signed payment sent to both at once exactly once.
// Offline: a stub facilitator; Redis only for the optional live control.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { isLongRunningSlug } from "../src/composite-spend-guard.js";

const LIVE_REDIS = String(process.env.REDIS_URL || "").trim();
const [PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, FAC_PORT, DEAD_REDIS, PORT_F, PORT_G] = await getFreePorts(9);
const PAYER = "0x" + "4".repeat(40);
const TMP = mkdtempSync(join(tmpdir(), "replay-outage-"));
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let verifies = 0, settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; await sleep(150); return reply({ isValid: true, payer: PAYER }); }
    if (req.url === "/settle") { settles++; return reply({ success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: "eip155:8453", payer: PAYER }); }
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const procs = [];
const logs = new Map();
function boot(port, name, redisUrl, extra = {}) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const log = [];
  logs.set(name, log);
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(port), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true", STATE_DATABASE_URL: "", SALES_LEDGER_DB: join(dir, "sales.db"), REFUND_DB_DIR: dir,
      REDIS_URL: redisUrl, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (d) => { for (const l of String(d).split("\n")) if (l.trim()) log.push(l.slice(0, 300)); if (log.length > 80) log.splice(0, log.length - 80); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  procs.push(proc);
  return `http://127.0.0.1:${port}`;
}
async function waitUp(base) {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* booting */ } await sleep(500); }
  return false;
}

const credential = (accept) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
const acceptOf = (r) => {
  try { return (JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453") || null; } catch { return null; }
};
const routeOf = (e) => { const [method, path] = String(e.route || `${e.method || "GET"} ${e.path || ""}`).split(" "); return { method, path }; };

const A = boot(PORT_A, "a", `redis://127.0.0.1:${DEAD_REDIS}`, { RATE_LIMIT_REPLICAS: "2" });
const Bsrv = boot(PORT_B, "b", `redis://127.0.0.1:${DEAD_REDIS}`, { RATE_LIMIT_REPLICAS: "2" });
// One replica past its deploy overlap window, and one still inside it.
const F = boot(PORT_F, "f", `redis://127.0.0.1:${DEAD_REDIS}`, { RATE_LIMIT_REPLICAS: "1", STATE_DB_REPLICAS: "", DEPLOY_OVERLAP_SECONDS: "0" });
const G = boot(PORT_G, "g", `redis://127.0.0.1:${DEAD_REDIS}`, { RATE_LIMIT_REPLICAS: "1", STATE_DB_REPLICAS: "", DEPLOY_OVERLAP_SECONDS: "3600" });
const C = boot(PORT_C, "c", "");
const prefix = `outage-${process.pid}-${randomBytes(4).toString("hex")}`;
const D = LIVE_REDIS ? boot(PORT_D, "d", LIVE_REDIS, { SHARED_LIMITS_PREFIX: prefix }) : null;
const E = LIVE_REDIS ? boot(PORT_E, "e", LIVE_REDIS, { SHARED_LIMITS_PREFIX: prefix }) : null;

try {
  const ups = await Promise.all([A, Bsrv, C, D, E, F, G].filter(Boolean).map(waitUp));
  ok(ups.every(Boolean), `every server booted (two with an unreachable shared store, one with none${LIVE_REDIS ? ", two on the live Redis" : ""})`);
  if (!ups.every(Boolean)) { for (const [name, log] of logs) for (const l of log.slice(-12)) console.error(`  server ${name}:`, l); throw new Error("a server did not boot"); }
  const pricing = await (await fetch(`${A}/api/pricing`)).json();
  const list = Array.isArray(pricing?.endpoints) ? pricing.endpoints : [];

  // A long-running route: refused before the paywall, nothing verified or settled.
  const slow = list.find((e) => isLongRunningSlug(e.slug) && routeOf(e).method === "POST");
  ok(!!slow, `found a long-running route (${slow?.slug})`);
  if (slow) {
    const { method, path } = routeOf(slow);
    const unpaid = await fetch(`${A}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600" }, body: "{}" });
    const accept = acceptOf(unpaid);
    ok(unpaid.status === 402 && !!accept, `the long-running route quotes a Base payment (${unpaid.status})`);
    const v0 = verifies, s0 = settles;
    const r = await fetch(`${A}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600", "payment-signature": credential(accept || {}) }, body: "{}" });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 503 && body.reason === "replay-store-unavailable", `a paid call to ${slow.slug} is refused while the shared store is out (${r.status} ${body.reason || body.error || ""})`);
    ok(r.headers.get("retry-after") === "30", `and says when to retry (Retry-After ${r.headers.get("retry-after")})`);
    ok(verifies === v0 && settles === s0, `nothing was verified or settled for it (verify +${verifies - v0}, settle +${settles - s0})`);
    // Routing ignores case and a trailing slash; so does the refusal.
    const v1 = verifies, s1 = settles;
    const upper = await fetch(`${A}${path.toUpperCase()}/`, { method, headers: { "content-type": "application/json", prefer: "wait=600", "payment-signature": credential(accept || {}) }, body: "{}" });
    const ub = await upper.json().catch(() => ({}));
    ok(upper.status === 503 && ub.reason === "replay-store-unavailable" && verifies === v1 && settles === s1, `the same call on ${path.toUpperCase()}/ is refused the same way (${upper.status} ${ub.reason || ub.error || ""})`);
    // A single container past its overlap window still refuses a long-running
    // route: its run outlives the window.
    const unpaidF = await fetch(`${F}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600" }, body: "{}" });
    const acceptF = acceptOf(unpaidF);
    const v2 = verifies;
    const rF = await fetch(`${F}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600", "payment-signature": credential(acceptF || {}) }, body: "{}" });
    const bF = await rF.json().catch(() => ({}));
    ok(rF.status === 503 && bF.reason === "replay-store-unavailable" && verifies === v2, `one container past its window: a long-running route is still refused (${rF.status} ${bF.reason || ""})`);
  }

  // A fast route: one signed payment sent to BOTH containers at once.
  const fast = list.find((e) => e.slug === "sql-guard");
  ok(!!fast, "found a fast wallet-only route");
  if (fast) {
    const { method, path } = routeOf(fast);
    const q = method === "GET" ? `?sql=${encodeURIComponent("SELECT 1")}` : "";
    const send = (base, headers) => fetch(`${base}${path}${q}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify({ sql: "SELECT 1" }) }) });
    const accept = acceptOf(await send(A, {}));
    ok(!!accept, "the fast route quotes a Base payment");

    const cred = credential(accept || {});
    const v0 = verifies, s0 = settles;
    const [ra, rb] = await Promise.all([send(A, { "payment-signature": cred }), send(Bsrv, { "payment-signature": cred })]);
    const [ba, bb] = await Promise.all([ra.json().catch(() => ({})), rb.json().catch(() => ({}))]);
    ok(ra.status === 503 && rb.status === 503 && ba.reason === "replay-store-unavailable" && bb.reason === "replay-store-unavailable",
      `shared store out: one payment sent to two containers is refused on both (${ra.status} ${ba.reason || ""}, ${rb.status} ${bb.reason || ""})`);
    ok(ra.headers.get("retry-after") === "30" && rb.headers.get("retry-after") === "30", "and each says when to retry");
    ok(verifies === v0 && settles === s0, `nothing reached the facilitator (verify +${verifies - v0}, settle +${settles - s0})`);

    // Control: the same kind of payment on a server with no shared store
    // configured is served and settled once, and buys no second run.
    const credC = credential(accept || {});
    const c0 = settles;
    const rc = await send(C, { "payment-signature": credC });
    ok(rc.status === 200 && settles === c0 + 1, `control: with no shared store configured the payment is served and settled (${rc.status}, settle +${settles - c0})`);
    const againC = await send(C, { "payment-signature": credC });
    ok(againC.status !== 200 || againC.headers.get("x-replayed-answer") === "1", `control: the same payment does not buy a second run there (${againC.status})`);
    ok(settles === c0 + 1, "control: and is not settled again");

    // One container past its overlap window: the fast route is served on the
    // per-process claim (a store outage does not stop sales), once.
    const credF = credential(accept || {});
    const f0 = settles;
    const rf = await send(F, { "payment-signature": credF });
    ok(rf.status === 200 && settles === f0 + 1, `one container, store out, past the overlap window: the fast route is served and settled once (${rf.status}, settle +${settles - f0})`);
    const againF = await send(F, { "payment-signature": credF });
    ok((againF.status !== 200 || againF.headers.get("x-replayed-answer") === "1") && settles === f0 + 1, `and the same payment buys no second run there (${againF.status})`);
    // ...while inside the window (an old container may still serve) it is refused.
    const credG = credential(accept || {});
    const g0 = verifies;
    const rg = await send(G, { "payment-signature": credG });
    const bg = await rg.json().catch(() => ({}));
    ok(rg.status === 503 && bg.reason === "replay-store-unavailable" && verifies === g0, `one container inside its deploy overlap window: refused before any verify (${rg.status} ${bg.reason || ""})`);

    // Live control: two servers on one reachable Redis serve one payment
    // sent to both at once exactly once.
    if (D && E) {
      const credD = credential(accept || {});
      const d0 = settles;
      const [rd, re] = await Promise.all([send(D, { "payment-signature": credD }), send(E, { "payment-signature": credD })]);
      const served = [rd, re].filter((r) => r.status === 200 && r.headers.get("x-replayed-answer") !== "1").length;
      ok(served === 1 && settles === d0 + 1, `live Redis: one payment sent to two containers runs once and settles once (${rd.status}, ${re.status}; settle +${settles - d0})`);
    } else {
      console.log("note - no REDIS_URL given: the live two-container control is skipped (the outage cases above do not need one)");
    }
  }
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  facilitator.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}
if (failed) for (const [name, log] of logs) for (const l of log.slice(-15)) console.error(`  server ${name}:`, l);
console.log(`\ntest-replay-store-outage: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
