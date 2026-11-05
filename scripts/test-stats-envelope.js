// /api/stats is the public M2M-economy counter. The homepage,
// listing portals (mcp.so, PulseMCP), and the /llms.txt copy all read this
// JSON. The most-watched fields are:
//
//   - toolCallsServed.{total, viaUSDC, viaProofOfWork, viaHeartbeat} — the
//     core rail breakdown. viaHeartbeat is the internal-probe attribution
//     bucket (HMAC-signed; see pow.js) — a regression that drops it would
//     re-mix probe traffic back into the "real PoW" bucket and inflate the
//     free-tier number.
//   - onchainRevenueProof — the basescan link the landing page uses for the
//     "verifiable revenue" claim. Removing it silently breaks that anchor.
//   - estimatedRevenueUsd — the headline number.
//
// This test boots FREE_MODE and locks:
//
//   1. GET /api/stats → 200 application/json.
//   2. Envelope keys: service, summary, tools, payment, walletName,
//      onchainRevenueProof, onchainNote, toolCallsServed, chargedButFailed,
//      topTools, estimatedRevenueUsd, recentCalls, servingSince,
//      processUptimeSeconds.
//   3. toolCallsServed has total + viaUSDC + viaProofOfWork + viaHeartbeat,
//      all non-negative integers (`total === viaUSDC + viaProofOfWork +
//      viaHeartbeat` would be tempting but the chargedButFailed path drops
//      the failure out of total without crediting a rail — so we lock the
//      four keys exist + are numbers, not the sum identity).
//   4. tools is a positive integer (the catalog size — must stay >= 400).
//   5. estimatedRevenueUsd is a number, processUptimeSeconds is a
//      non-negative number, servingSince is a parseable ISO string.
//   6. topTools / recentCalls are arrays.
//   7. topPaidTools is ABSENT (found live 2026-08-14: a purchase-count
//      bestsellers ranking was public here, and since /api/pricing is also
//      public, purchases × price reconstructs exact per-tool revenue - a
//      regression that re-adds the field must fail this test, not just go
//      unnoticed by an envelope check that only ever asserted presence).
//
//   node scripts/test-stats-envelope.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3092;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/api/stats`);
  ok(res.status === 200, `/api/stats → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json`);
  const body = await res.json();

  for (const k of ["service", "summary", "tools", "payment", "walletName", "onchainRevenueProof", "onchainNote", "toolCallsServed", "chargedButFailed", "topTools", "estimatedRevenueUsd", "recentCalls", "servingSince", "processUptimeSeconds"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(!("topPaidTools" in body), `topPaidTools is NOT in the public envelope (purchase-count bestsellers ranking - reconstructs exact revenue via public /api/pricing, stays operator-only)`);
  ok(body.service === "Agent402.Tools", `service='Agent402.Tools' (got ${body.service})`);
  ok(typeof body.summary === "string" && body.summary.length > 0, `summary is non-empty (got len ${body.summary?.length})`);

  // Catalog floor: must stay >= 400 (The 500 era: 462 interim → 500; a counter that fell
  // under 1000 would be a regression worth investigating).
  ok(typeof body.tools === "number" && body.tools >= 400, `tools is >= 400 (got ${body.tools})`);

  // Rail breakdown — the four rails serve different stories on the dashboard.
  ok(typeof body.toolCallsServed === "object" && body.toolCallsServed != null, `toolCallsServed is an object`);
  for (const k of ["total", "viaUSDC", "viaProofOfWork", "viaHeartbeat", "viaMPPWire", "viaRouter"]) {
    ok(typeof body.toolCallsServed[k] === "number" && body.toolCallsServed[k] >= 0, `toolCallsServed.${k} is non-negative number (got ${body.toolCallsServed[k]})`);
  }
  // viaHeartbeat is the HMAC-signed probe-attribution bucket. We can't
  // assert > 0 in CI (the test boot doesn't run heartbeat), but we can lock
  // that the key exists with the right type — a regression that re-merged
  // it into the PoW count would fail the typeof check above.

  // chargedButFailed — paid calls that errored after settlement. Surfaced
  // as a flat count, not a per-slug breakdown — the dashboard rolls up the
  // total to drive a "$X paid for failed calls" headline.
  ok(typeof body.chargedButFailed === "number" && body.chargedButFailed >= 0, `chargedButFailed is non-negative number (got ${body.chargedButFailed})`);

  // Top tools / recent calls — arrays the homepage iterates over. May be
  // empty in a fresh boot; only the type lock matters here.
  ok(Array.isArray(body.topTools), `topTools is an array`);
  ok(Array.isArray(body.recentCalls), `recentCalls is an array`);

  // Headline revenue number. May be 0 in a fresh boot but must be a number
  // — a string here ("$0.00") would parse-fail downstream consumers.
  ok(typeof body.estimatedRevenueUsd === "number" && body.estimatedRevenueUsd >= 0, `estimatedRevenueUsd is non-negative number (got ${body.estimatedRevenueUsd}, type ${typeof body.estimatedRevenueUsd})`);

  // Liveness.
  ok(typeof body.servingSince === "string" && !isNaN(Date.parse(body.servingSince)), `servingSince is parseable ISO (got ${body.servingSince})`);
  ok(typeof body.processUptimeSeconds === "number" && body.processUptimeSeconds >= 0, `processUptimeSeconds is non-negative number (got ${body.processUptimeSeconds})`);
  ok(!("uptimeSeconds" in body), "the old 'uptimeSeconds' key name is gone (misreadable as service-availability uptime, see /api/reliability's sibling fix)");

  // payment + walletName — the wallet info block. In FREE_MODE walletName
  // may be null; lock that the key exists with one of the legal types.
  ok("walletName" in body, `walletName key present (may be null in FREE_MODE; got ${body.walletName})`);
  ok(body.walletName === null || typeof body.walletName === "string", `walletName is string or null (got ${typeof body.walletName})`);

  // onchainRevenueProof — the basescan anchor the landing page uses. In
  // FREE_MODE (no wallet) it's null; in prod it's a basescan URL.
  ok(body.onchainRevenueProof === null || (typeof body.onchainRevenueProof === "string" && body.onchainRevenueProof.includes("basescan")), `onchainRevenueProof is null or a basescan URL (got ${body.onchainRevenueProof})`);
  ok(typeof body.onchainNote === "string" && body.onchainNote.length > 0, `onchainNote is non-empty (got "${body.onchainNote?.slice(0, 60)}…")`);

  console.log(`\n${pass} passed (tools=${body.tools}, rails: usdc=${body.toolCallsServed.viaUSDC}, pow=${body.toolCallsServed.viaProofOfWork}, heartbeat=${body.toolCallsServed.viaHeartbeat})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
