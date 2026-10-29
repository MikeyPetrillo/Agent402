// The replay guard while its shared store is configured but unreachable, on
// the real server: a long-running or composite route is refused with a 503
// and Retry-After before any payment is verified or settled, and a fast route
// keeps the per-process fallback and is served and settled as usual.
// Offline: a stub facilitator, and REDIS_URL naming a local port nothing
// listens on.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { getFreePorts } from "./lib/free-port.js";
import { isLongRunningSlug } from "../src/composite-spend-guard.js";

const [PORT, FAC_PORT, DEAD_REDIS] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const PAYER = "0x" + "4".repeat(40);
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let verifies = 0, settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply({ isValid: true, payer: PAYER }); }
    if (req.url === "/settle") { settles++; return reply({ success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: "eip155:8453", payer: PAYER }); }
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const log = [];
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", REDIS_URL: `redis://127.0.0.1:${DEAD_REDIS}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (d) => { for (const l of String(d).split("\n")) if (l.trim()) log.push(l.slice(0, 300)); if (log.length > 80) log.splice(0, log.length - 80); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const credential = (accept) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
const acceptOf = (r) => {
  try { return (JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453") || null; } catch { return null; }
};

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "the server booted with an unreachable shared store");
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const list = Array.isArray(pricing?.endpoints) ? pricing.endpoints : [];
  const routeOf = (e) => { const [method, path] = String(e.route || `${e.method || "GET"} ${e.path || ""}`).split(" "); return { method, path }; };

  // A long-running route: refused before the paywall, nothing verified or settled.
  const slow = list.find((e) => isLongRunningSlug(e.slug) && routeOf(e).method === "POST");
  ok(!!slow, `found a long-running route (${slow?.slug})`);
  if (slow) {
    const { method, path } = routeOf(slow);
    const unpaid = await fetch(`${B}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600" }, body: "{}" });
    const accept = acceptOf(unpaid);
    ok(unpaid.status === 402 && !!accept, `the long-running route quotes a Base payment (${unpaid.status})`);
    const v0 = verifies, s0 = settles;
    const r = await fetch(`${B}${path}`, { method, headers: { "content-type": "application/json", prefer: "wait=600", "payment-signature": credential(accept || {}) }, body: "{}" });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 503 && body.reason === "replay-store-unavailable", `a paid call to ${slow.slug} is refused while the shared store is out (${r.status} ${body.reason || body.error || ""})`);
    ok(r.headers.get("retry-after") === "30", `and says when to retry (Retry-After ${r.headers.get("retry-after")})`);
    ok(verifies === v0 && settles === s0, `nothing was verified or settled for it (verify +${verifies - v0}, settle +${settles - s0})`);
    // Routing ignores case and a trailing slash; so does the refusal.
    const v1 = verifies, s1 = settles;
    const upper = await fetch(`${B}${path.toUpperCase()}/`, { method, headers: { "content-type": "application/json", prefer: "wait=600", "payment-signature": credential(accept || {}) }, body: "{}" });
    const ub = await upper.json().catch(() => ({}));
    ok(upper.status === 503 && ub.reason === "replay-store-unavailable" && verifies === v1 && settles === s1, `the same call on ${path.toUpperCase()}/ is refused the same way (${upper.status} ${ub.reason || ub.error || ""})`);
  }

  // A fast route: served on the per-process fallback and settled.
  const fast = list.find((e) => e.slug === "sql-guard");
  ok(!!fast, "found a fast wallet-only route");
  if (fast) {
    const { method, path } = routeOf(fast);
    const q = method === "GET" ? `?sql=${encodeURIComponent("SELECT 1")}` : "";
    const send = (headers) => fetch(`${B}${path}${q}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify({ sql: "SELECT 1" }) }) });
    const accept = acceptOf(await send({}));
    ok(!!accept, "the fast route quotes a Base payment");
    const s0 = settles;
    const cred = credential(accept || {});
    const r = await send({ "payment-signature": cred });
    ok(r.status === 200 && settles === s0 + 1, `a paid call to ${fast.slug} is served and settled on the per-process fallback (${r.status}, settle +${settles - s0})`);
    const again = await send({ "payment-signature": cred });
    ok(again.status !== 200 || again.headers.get("x-replayed-answer") === "1", `the same payment does not buy a second run on this replica (${again.status})`);
  }
} finally {
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  facilitator.close();
}
if (failed) for (const l of log.slice(-25)) console.error("  server:", l);
console.log(`\ntest-replay-store-outage: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
