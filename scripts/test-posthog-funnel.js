// PostHog conversion funnel (discovery → paywall_402 → payment_settled) —
// fully offline, two legs:
//
//   1. UNIT — imports src/posthog.js with POSTHOG_TEST_CAPTURE=1 (the test
//      sink: events go to an in-memory array + `[posthog-test]` log lines,
//      never the network) and exercises every capture function directly:
//      event shapes, the paywall_402 rollup (top-slugs + "_other" remainder,
//      counts preserved exactly), the discovery hourly cap, and the
//      tool_error probe suppression regression.
//
//   2. INTEGRATION — boots the real server in PAID mode against a mock
//      facilitator (a local HTTP server answering GET /supported with an
//      exact/eip155:8453 kind, so real 402 challenges build offline — the
//      X402_SYNC_ON_START lesson), then walks the actual funnel:
//      /llms.txt (discovery) → unpaid /api/hash (402) → PoW-paid /api/hash
//      (settlement, rail=pow) and asserts the exact events from the
//      server's [posthog-test] output.
//
//   node scripts/test-posthog-funnel.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

process.env.POSTHOG_TEST_CAPTURE = "1";
const {
  capturePostHogDiscovery,
  capturePostHogPaywall,
  capturePostHogSettlement,
  capturePostHogToolError,
  _flushPaywallRollupForTest,
  _testEventsForTest,
} = await import("../src/posthog.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const events = _testEventsForTest();
const take = () => events.splice(0, events.length); // read + clear

// --- unit: discovery ------------------------------------------------------------
capturePostHogDiscovery({ surface: "llms.txt", synthetic: false });
let got = take();
ok(got.length === 1 && got[0].event === "discovery" && got[0].properties.surface === "llms.txt" && got[0].properties.synthetic === false,
  "discovery event carries surface + synthetic");
ok(Object.keys(got[0].properties).sort().join(",") === "surface,synthetic",
  "discovery properties are exactly {surface, synthetic} — nothing about the caller");

// --- unit: paywall rollup -------------------------------------------------------
for (let i = 0; i < 3; i++) capturePostHogPaywall({ slug: "hash", priceUsd: 0.001, powEligible: true, synthetic: false });
capturePostHogPaywall({ slug: "screenshot", priceUsd: 0.01, powEligible: false, synthetic: false });
capturePostHogPaywall({ slug: "hash", priceUsd: 0.001, powEligible: true, synthetic: true }); // synthetic bucket is separate
ok(take().length === 0, "paywall captures accumulate silently (no events before flush)");
_flushPaywallRollupForTest();
got = take();
const byKey = new Map(got.map((e) => [`${e.properties.slug}|${e.properties.synthetic ? 1 : 0}`, e.properties]));
ok(got.length === 3 && got.every((e) => e.event === "paywall_402"), `flush emits one paywall_402 per (slug, synthetic) pair (got ${got.length})`);
ok(byKey.get("hash|0")?.count === 3 && byKey.get("hash|0")?.powEligible === true, "counts aggregate per slug");
ok(byKey.get("hash|1")?.count === 1, "synthetic 402s roll up separately");
ok(byKey.get("screenshot|0")?.count === 1 && byKey.get("screenshot|0")?.priceUsd === 0.01, "price rides along");
_flushPaywallRollupForTest();
ok(take().length === 0, "empty rollup flush emits nothing");

// --- unit: rollup "_other" remainder keeps the exact total -----------------------
for (let i = 0; i < 60; i++) {
  for (let n = 0; n <= i % 3; n++) capturePostHogPaywall({ slug: `slug-${i}`, priceUsd: 0.001, powEligible: true, synthetic: false });
}
const expectedTotal = Array.from({ length: 60 }, (_, i) => (i % 3) + 1).reduce((a, b) => a + b, 0);
_flushPaywallRollupForTest();
got = take();
ok(got.length === 51, `60 slugs flush as top-50 + one _other (got ${got.length})`);
ok(got.some((e) => e.properties.slug === "_other"), "_other remainder event present");
const total = got.reduce((s, e) => s + e.properties.count, 0);
ok(total === expectedTotal, `sum(count) is the exact 402 total — nothing sampled away (${total} = ${expectedTotal})`);

// --- unit: settlement ------------------------------------------------------------
capturePostHogSettlement({ slug: "hash", rail: "usdc", network: "eip155:8453", priceUsd: 0.001, synthetic: false });
capturePostHogSettlement({ slug: "hash", rail: "pow", network: null, priceUsd: 0.001, synthetic: false });
got = take();
ok(got.length === 2 && got.every((e) => e.event === "payment_settled"), "settlements are per-event, never rolled up");
ok(got[0].properties.rail === "usdc" && got[0].properties.network === "eip155:8453", "USDC settlement carries the chain");
ok(got[1].properties.rail === "pow" && got[1].properties.network === null, "PoW settlement has no chain");
ok(Object.keys(got[0].properties).sort().join(",") === "network,priceUsd,rail,slug,synthetic",
  "settlement properties are exactly {slug, rail, network, priceUsd, synthetic} — no payer identity");

// --- unit: tool_error probe suppression still holds through the sink refactor ----
capturePostHogToolError({ slug: "hash", status: 400, message: "x", shape: [], synthetic: false, probe: true });
ok(take().length === 0, "probe tool_errors stay suppressed (regression lock)");
capturePostHogToolError({ slug: "hash", status: 500, message: "x", shape: ["b:url"], synthetic: false, probe: false });
got = take();
ok(got.length === 1 && got[0].event === "tool_error" && got[0].properties.errorClass === "5xx", "real tool_errors still captured");

// --- unit: discovery hourly cap ---------------------------------------------------
for (let i = 0; i < 1200; i++) capturePostHogDiscovery({ surface: "find", synthetic: false });
got = take();
ok(got.length === 999, `discovery capped per rolling hour (got ${got.length} of 1200 — 1 was used above)`);

// --- integration: the real funnel through a paid-mode server ----------------------
const FAC_PORT = 3082, PORT = 3081, B = `http://localhost:${PORT}`;
// Mock facilitator: /supported advertises the exact scheme on Base so the
// middleware's kind sync succeeds and real 402 challenges build offline.
const facilitator = createServer((req, res) => {
  if (req.url.startsWith("/supported")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: `http://localhost:${FAC_PORT}`,
    X402_SYNC_ON_START: "true", // the kind sync MUST run for 402s to build
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
    FREE_MODE: "",
    POSTHOG_TEST_CAPTURE: "1",
    POSTHOG_PAYWALL_FLUSH_MS: "1000", // flush fast so the test can observe it
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout.on("data", (d) => { serverLog += d; });
proc.stderr.on("data", (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const solve = (c) => { let n = 0; while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++; return n; };

try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/api/pow`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "paid-mode server booted against the mock facilitator");

  // Stage 1: discovery.
  ok((await fetch(`${B}/llms.txt`)).ok, "GET /llms.txt serves");
  ok((await fetch(`${B}/api/pricing`)).ok, "GET /api/pricing serves");

  // Stage 2: an unpaid catalog call must get a REAL 402 (not a 500 — that
  // would mean the kind sync failed, the exact bug the wallet E2E hit).
  const unpaid = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  ok(unpaid.status === 402, `unpaid catalog call answers 402 (got ${unpaid.status})`);

  // Stage 3: settle via proof-of-work and get the result.
  const c = await (await fetch(`${B}/api/pow/challenge?slug=hash`)).json();
  const paid = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": `${c.token}:${solve(c)}` },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(paid.status === 200 && (await paid.json()).hex.slice(0, 8) === "b94d27b9", "PoW-paid call settles and answers");

  await sleep(1800); // let the paywall rollup flush (1s window) + finish hooks run

  const captured = serverLog.split("\n")
    .filter((l) => l.includes("[posthog-test]"))
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
    .filter(Boolean);
  const of = (name) => captured.filter((e) => e.event === name);

  const disc = of("discovery").map((e) => e.properties.surface);
  ok(disc.includes("llms.txt") && disc.includes("pricing"), `server captured discovery for llms.txt + pricing (got: ${disc.join(", ")})`);
  const pw = of("paywall_402").find((e) => e.properties.slug === "hash");
  ok(Boolean(pw) && pw.properties.count >= 1 && pw.properties.powEligible === true,
    `server captured the 402 rollup for hash (count ${pw?.properties.count})`);
  const settled = of("payment_settled");
  ok(settled.length === 1 && settled[0].properties.slug === "hash" && settled[0].properties.rail === "pow",
    `exactly one settlement, slug=hash rail=pow (got ${settled.length}: ${JSON.stringify(settled.map((e) => e.properties))})`);
  ok(!captured.some((e) => JSON.stringify(e).match(/userAgent|"ip"|remoteAddr|x-forwarded/i)),
    "no caller identity in any captured event");
} catch (e) {
  ok(false, `integration leg threw: ${e.message}`);
} finally {
  proc.kill("SIGKILL");
  facilitator.close();
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
