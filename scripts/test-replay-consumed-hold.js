#!/usr/bin/env node
// How long the replay guard holds a granted payment's consumed mark, read
// from the REAL Redis the booted server writes it to.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-replay-consumed-hold.js
//
// A settled 200 keeps its mark while its authorization stays valid (plus the
// margin), never under the guard's default hold (one hour): the nonce is
// spent on chain, but the gateway cache reader (src/gateway-cache-scope.js)
// takes a still-valid authorization the guard does not hold as its payer's
// proof, so the mark must not lapse while the authorization could be read
// there. That hold is bounded (MAX_SETTLED_VALIDITY_HOLD_MS from the settle):
// a mark held to a far validBefore for every paid call would keep one
// long-lived key each (a client signing century-long validity windows grows
// the store by one key per call), so a century-long authorization keeps its
// key for the bound and no longer, and a payment with the stock five-minute
// expiry keeps the default hour. A grant that was NOT settled (a hang-up the forgiveness budget
// forgave: the buyer was told it was free) leaves the authorization live, so
// its mark is held past the authorization's own validBefore
// (CONSUMED_VALIDITY_MARGIN_MS beyond it; a validBefore further out than a
// century is read as a century): only that mark stops a re-send from settling
// it. Both are the server's own call (server.js finishGuard:
// src/hangup-settlement.js grantedUnsettled), driven here through real HTTP
// against a stub facilitator, with the TTL of each consumed key read back.
//
// Deliberately does not skip without REDIS_URL: the hold is only observable
// on the shared store, and a skipped integration test is not coverage.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis (CI provides a service container).");
  console.error("      It deliberately does not skip - see the header comment.");
  process.exit(1);
}
const { createClient } = await import("redis");
const { CONSUMED_VALIDITY_MARGIN_MS, MAX_SETTLED_VALIDITY_HOLD_MS, SETTLED_HOLD_MS } = await import("../src/replay-guard.js");

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const PAYER = "0x" + "7".repeat(40);
const TMP = mkdtempSync(join(tmpdir(), "replay-hold-"));
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };

let settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply({ isValid: true, payer: PAYER });
    if (req.url === "/settle") { settles++; return reply({ success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: "eip155:8453", payer: PAYER }); }
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const serverLog = [];
const proc = spawn(process.execPath, ["--import", "./scripts/lib/hold-json-preload.js", "src/server.js"], {
  env: { ...process.env, TRUST_PROXY_HOPS: "1", ...ownStoreEnv("replay-hold"), PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
    // X402_INDEX_CRAWL=off also keeps the revenue warm-up (a public-RPC scan)
    // off; the x402 init itself stays on, against the stub facilitator.
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", SHARED_LIMITS_PREFIX: `replay-hold-${process.pid}-${randomBytes(4).toString("hex")}`,
    HANGUP_FORGIVE: "", HANGUP_FORGIVE_SALT: "replay-hold-salt", HANGUP_TEST_HOLD_JSON: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (d) => { for (const l of String(d).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);
const logSince = (i) => serverLog.slice(i).join("\n");

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", () => {});
await redis.connect();

// The guard's own key for an EIP-3009 authorization (src/replay-guard.js
// paymentReplayKey, namesOf): the consumed mark lives at replay:c:n2:<id>.
const consumedKey = (nonce) => "replay:c:n2:" + createHash("sha256").update(`eip155:8453\n${PAYER.toLowerCase()}\n${nonce.toLowerCase()}`).digest("hex");
const credential = (accept, nonce, validBefore = "9999999999") => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: String(validBefore), nonce } },
})).toString("base64");
// The earlier build's name for the same credential (namesOf: the tagged twin).
const legacyKey = (nonce) => "replay:c:n:" + createHash("sha256").update(`?:${nonce.toLowerCase()}`).digest("hex");
const hangUp = (url, { headers = {}, abortWhen } = {}) => new Promise((resolve) => {
  const req = httpRequest(url, { method: "GET", headers });
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  req.on("error", finish);
  req.on("response", (r) => { r.resume(); finish(); });
  req.end();
  abortWhen.then(() => { req.destroy(); finish(); });
});

try {
  let up = false;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted on the shared store with the hold-json preload");
  if (!up) throw new Error("the server did not boot");
  const unpaid = await fetch(`${B}/api/uuid`);
  const accept = (() => { try { return (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453") || null; } catch { return null; } })();
  ok(unpaid.status === 402 && !!accept, `GET /api/uuid quotes a Base payment (${unpaid.status})`);
  if (!accept) throw new Error("no Base accept to pay");
  const YEAR_S = 365 * 24 * 3600;

  // 1. Settled 200s. The mark is written after the response ends, so each
  // read waits for the key (with a deadline).
  const HOUR_S = SETTLED_HOLD_MS / 1000, BOUND_S = MAX_SETTLED_VALIDITY_HOLD_MS / 1000, MARGIN_S = CONSUMED_VALIDITY_MARGIN_MS / 1000;
  const paySettled = async (label, validBefore) => {
    const nonce = "0x" + randomBytes(32).toString("hex");
    const s0 = settles;
    const cred = validBefore === undefined ? credential(accept, nonce) : credential(accept, nonce, validBefore);
    const r = await fetch(`${B}/api/uuid`, { headers: { "payment-signature": cred } });
    ok(r.status === 200 && settles === s0 + 1, `${label}: a connected buyer is served and settled once (${r.status}, settle +${settles - s0})`);
    let ttl = -2;
    for (const t0 = Date.now(); Date.now() - t0 < 5000 && ttl <= 0;) { ttl = await redis.ttl(consumedKey(nonce)); if (ttl <= 0) await sleep(20); }
    return { nonce, cred, ttl, twin: await redis.ttl(legacyKey(nonce)) };
  };
  {
    // a. Stock expiry (five minutes): the default hour, as before.
    const a = await paySettled("settled, stock expiry", Math.floor(Date.now() / 1000) + 300);
    ok(a.ttl > HOUR_S - 30 && a.ttl <= HOUR_S, `settled, stock expiry: the consumed mark keeps the guard's default hour (TTL ${a.ttl} s)`);
    // b. Valid two hours and seven days: held until the authorization expires plus the margin.
    for (const [label, life] of [["two hours", 2 * 3600], ["seven days", 7 * 24 * 3600]]) {
      const b = await paySettled(`settled, valid ${label}`, Math.floor(Date.now() / 1000) + life);
      ok(b.ttl > life + MARGIN_S - 30 && b.ttl <= life + MARGIN_S + 1, `settled, valid ${label}: the consumed mark lasts until the authorization expires plus the margin (TTL ${b.ttl} s, expiry in ${life} s)`);
      ok(b.twin > life + MARGIN_S - 30 && b.twin <= life + MARGIN_S + 1, `settled, valid ${label}: and so does its twin under the earlier key name (TTL ${b.twin} s)`);
      const s0 = settles;
      const again = await fetch(`${B}/api/uuid`, { headers: { "payment-signature": b.cred } });
      // Inside the idempotency window a re-sent payment is answered with
      // the stored answer; past it the guard's mark refuses it. Never a
      // second settle or handler run either way.
      ok((again.status === 409 || again.status === 200) && settles === s0, `settled, valid ${label}: the same authorization again settles nothing (${again.status}, settle +${settles - s0})`);
    }
    // c. Valid for centuries: the settled bound, no long-lived key.
    const c = await paySettled("settled, valid for centuries");
    ok(c.ttl > BOUND_S - 30 && c.ttl <= BOUND_S, `settled, valid for centuries: the consumed mark is held for the settled bound, not to the authorization's validBefore (TTL ${c.ttl} s, bound ${BOUND_S} s)`);
    ok(c.twin > 0 && c.twin <= BOUND_S && c.ttl < YEAR_S, `settled, valid for centuries: no key outlives the bound (twin TTL ${c.twin} s)`);
  }

  // 2. A forgiven hang-up: granted, not settled, held past validBefore.
  {
    const nonce = "0x" + randomBytes(32).toString("hex");
    const s0 = settles, logAt = serverLog.length;
    const held = waitFor(() => /\[hold-json\] holding GET \/api\/uuid/.test(logSince(logAt)), 8000);
    await hangUp(`${B}/api/uuid`, { headers: { "payment-signature": credential(accept, nonce), "x-test-hold-json-ms": "1500", "x-forwarded-for": "10.9.0.2" }, abortWhen: held.then(() => sleep(200)) });
    await sleep(2_500);
    const log = logSince(logAt);
    ok(settles === s0, `forgiven: the buyer left mid-handler and the payment was NOT settled (settle +${settles - s0})`);
    ok(/\[hangup\] SETTLE WITHHELD: [^\n]*GET \/api\/uuid[^\n]*within the hang-up forgiveness budget/.test(log), "forgiven: the log says SETTLE WITHHELD within the forgiveness budget");
    const ttl = await redis.ttl(consumedKey(nonce));
    const now = Date.now();
    // validBefore 9999999999 s is centuries out; the guard caps the hold at a
    // century past now, so the mark outlives any hour and any year.
    const floorS = Math.floor((Math.min(9999999999 * 1000, now + 100 * YEAR_S * 1000) + CONSUMED_VALIDITY_MARGIN_MS - now) / 1000) - 60;
    ok(ttl >= floorS, `forgiven: the consumed mark is held to the authorization's validBefore plus the margin (TTL ${ttl} s, at least ${floorS} s)`);
    const again = await fetch(`${B}/api/uuid`, { headers: { "payment-signature": credential(accept, nonce) } });
    ok(again.status === 409 && settles === s0, `forgiven: re-sending the same authorization is refused as consumed and settles nothing (${again.status}, settle +${settles - s0})`);
  }
} finally {
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  facilitator.close();
  try { await redis.quit(); } catch { /* closed */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}
if (failed) for (const l of serverLog.slice(-25)) console.error("  server:", l);
console.log(`\ntest-replay-consumed-hold: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
