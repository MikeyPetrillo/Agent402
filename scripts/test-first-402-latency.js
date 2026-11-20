#!/usr/bin/env node
// The first unpaid 402 after boot answers about as fast as the ones after it.
//
// Right after a deploy, the first buyer (or the Bazaar's validator, whose
// probe gives up after 4 s) reads a paid route's 402 from a server that has
// just started. This suite boots THIS tree in paid mode on port 0, times the
// first unpaid POST /api/render the moment /health answers, and bounds it
// against a same-run baseline: the median of the next five.
//
// Leg A: every facilitator answers /supported at boot.
// Leg B: one facilitator (Stellar's) gives no /supported answer within the
//   boot read's limit, so the boot guard drops its rail, and its read is
//   still in flight when the server listens. The first x402 init must not
//   wait on that read: before the fix every paid request after boot waited
//   for that facilitator (about 6 s with one silent 20 s, 76 s with one
//   silent 120 s), so a route whose 402 is a 3 ms build answered the first
//   caller in seconds. The rail still comes back: once the facilitator
//   answers, the rail re-read restores it and the 402 offers Stellar again.
// Leg C: the silent facilitator is the one first in order on Base (the CDP
//   slot; another facilitator also lists Base, so Base stays offered). The
//   init still waits for it, as before: passing it over would hand Base to
//   the next facilitator for the life of the process, and the Bazaar indexes
//   what settles through the first. Once it answers, a Base payment is
//   verified there, not at the facilitator after it.
//
//   node scripts/test-first-402-latency.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { ownStoreEnv } from "./lib/own-stores.js";

const STELLAR = "stellar:pubnet";
// A first 402 within this much of the baseline passes; a first 402 that
// waited on a facilitator takes as long as the facilitator stays silent,
// which is held well past it here.
const FIRST_SLACK_MS = 1500;
const FIRST_ABORT_MS = 6000;
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const children = [];
const servers = [];
const stopAll = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } for (const s of servers) { try { s.close(); } catch {} } };
process.on("exit", stopAll);

const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const listen = async (handler) => { const s = createServer(handler); servers.push(s); await new Promise((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${s.address().port}`; };

// The EVM facilitator: answers at once. /verify refuses (no handler runs) and
// is counted, so a test can see which facilitator a payment went to.
const EVM_KINDS = ["eip155:8453", "eip155:137"].map((network) => ({ x402Version: 2, scheme: "exact", network }));
const verifies = { F: 0, primary: 0 };
const F = await listen((req, res) => { req.resume(); req.on("end", () => {
  if (req.url === "/supported") return json(res, 200, { kinds: EVM_KINDS, extensions: [], signers: {} });
  if (req.url === "/verify") { verifies.F++; return json(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }); }
  json(res, 404, {});
}); });
// The Stellar facilitator: answers /supported at once, or holds every
// answer until release() when `silent`.
function stellarFacilitator(silent, kinds = [{ x402Version: 2, scheme: "exact", network: STELLAR, extra: { areFeesSponsored: true } }], onVerify = null) {
  const held = [];
  let hits = 0, released = !silent;
  const answer = (res) => json(res, 200, { kinds, extensions: [], signers: {} });
  const urlP = listen((req, res) => { req.resume(); req.on("end", () => {
    if (req.url === "/verify" && onVerify) { onVerify(); return json(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }); }
    if (req.url !== "/supported") return json(res, 404, {});
    hits++;
    if (released) answer(res); else held.push(res);
  }); });
  return { urlP, hits: () => hits, release: () => { released = true; for (const r of held.splice(0)) answer(r); } };
}

async function boot(label, stellarUrl, extra = {}) {
  const env = { ...process.env };
  for (const k of ["TARGET_URL", "STATE_DATABASE_URL", "REDIS_URL", "X402_SYNC_ON_START", "X402_SUPPORTED_GUARD", "X402_RAIL_RECHECK_MS"]) delete env[k];
  const child = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], {
    env: {
      ...env, ...ownStoreEnv(label), PORT: "0", FREE_MODE: "", NODE_ENV: "test",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,polygon,stellar",
      FACILITATOR_URL: F, PAYAI_FACILITATOR_URL: F, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      STELLAR_WALLET_ADDRESS: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", STELLAR_FACILITATOR_URL: stellarUrl, STELLAR_FACILITATOR_KEY: "first-402-placeholder",
      // A short boot read, so a silent facilitator is given up on quickly.
      X402_SUPPORTED_TRY_MS: "400", X402_SUPPORTED_BOOT_MS: "1200",
      MPP_SECRET_KEY: "first-402-test-secret", FACILITATOR_GAS_CHECK: "off", STATS_ALLOW_EPHEMERAL: "true",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let log = "";
  const port = await new Promise((resolve) => {
    const read = (d) => { log = (log + d).slice(-20_000); const m = /listening on :(\d+)/.exec(log); if (m) resolve(Number(m[1])); };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.once("exit", () => resolve(0));
    setTimeout(() => resolve(0), 120_000);
  });
  const base = port ? `http://127.0.0.1:${port}` : null;
  let up = false;
  for (let i = 0; base && i < 2000 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch {} if (!up) await sleep(10); }
  return { base, up, child, log: () => log };
}

/** One unpaid POST /api/render: { ms, status, accepts } (status 0 on abort). */
async function render402(base, abortMs = 20_000) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }), signal: AbortSignal.timeout(abortMs) });
    await r.text();
    const h = r.headers.get("payment-required");
    const accepts = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")).accepts || [] : [];
    return { ms: Math.round(performance.now() - t0), status: r.status, accepts };
  } catch { return { ms: Math.round(performance.now() - t0), status: 0, accepts: [] }; }
}

async function firstAndBaseline(base) {
  const first = await render402(base, FIRST_ABORT_MS);
  const later = [];
  for (let i = 0; i < 5; i++) later.push(await render402(base));
  return { first, later, baseline: median(later.map((r) => r.ms)) };
}

try {
  // --- Leg A: every facilitator answers -------------------------------------
  {
    const stellar = stellarFacilitator(false);
    const s = await boot("first-402-a", await stellar.urlP);
    ok(s.up, "A: the paid server booted (every facilitator answering)");
    if (!s.up) { console.log(s.log().slice(-1500)); process.exit(1); }
    const { first, later, baseline } = await firstAndBaseline(s.base);
    console.log(`   A: first 402 ${first.ms} ms; next five ${later.map((r) => r.ms).join(", ")} ms (median ${baseline})`);
    ok(first.status === 402 && later.every((r) => r.status === 402), `A: the first and the next five answers are 402s (${first.status}, ${later.map((r) => r.status).join(",")})`);
    ok(first.accepts.some((a) => a.network === STELLAR), "A: the 402 offers Stellar (its facilitator answered at boot)");
    ok(first.ms <= baseline + FIRST_SLACK_MS, `A: the first 402 (${first.ms} ms) is within ${FIRST_SLACK_MS} ms of the same run's baseline (${baseline} ms)`);
    s.child.kill("SIGKILL");
  }

  // --- Leg B: one facilitator silent past the boot read ---------------------
  {
    const stellar = stellarFacilitator(true);
    const s = await boot("first-402-b", await stellar.urlP, { X402_RAIL_RECHECK_MS: "500", X402_RAIL_RECHECK_MAX_MS: "1000" });
    ok(s.up, "B: the paid server booted with Stellar's facilitator silent");
    if (!s.up) { console.log(s.log().slice(-1500)); process.exit(1); }
    ok(stellar.hits() > 0 && /gave no \/supported answer/.test(s.log()), `B: control: the boot read asked Stellar's facilitator (${stellar.hits()} read(s)) and got no answer within its limit`);
    const { first, later, baseline } = await firstAndBaseline(s.base);
    console.log(`   B: first 402 ${first.status ? `${first.ms} ms` : `none within ${FIRST_ABORT_MS} ms`}; next five ${later.map((r) => r.ms).join(", ")} ms (median ${baseline})`);
    ok(first.status === 402, `B: the first unpaid request after boot is answered 402 (got ${first.status || `nothing within ${FIRST_ABORT_MS} ms`})`);
    ok(first.status === 402 && first.ms <= baseline + FIRST_SLACK_MS, `B: the first 402 (${first.status ? `${first.ms} ms` : "none"}) is within ${FIRST_SLACK_MS} ms of the same run's baseline (${baseline} ms): it does not wait on the silent facilitator`);
    ok(later.every((r) => r.status === 402 && !r.accepts.some((a) => a.network === STELLAR)), "B: while it is silent, every 402 leaves Stellar out (the boot guard dropped the rail)");
    // The facilitator answers: the rail re-read restores Stellar live.
    stellar.release();
    let restored = false;
    for (let i = 0; i < 100 && !restored; i++) { const r = await render402(s.base); restored = r.status === 402 && r.accepts.some((a) => a.network === STELLAR); if (!restored) await sleep(100); }
    ok(restored, "B: once the facilitator answers, the rail re-read restores Stellar and the 402 offers it again");
    s.child.kill("SIGKILL");
  }

  // --- Leg C: the facilitator first on Base is the silent one -----------------
  {
    const primary = stellarFacilitator(true, EVM_KINDS, () => { verifies.primary++; });
    const stellar = stellarFacilitator(false);
    const s = await boot("first-402-c", await stellar.urlP, { CDP_FACILITATOR_URL: await primary.urlP, X402_RAIL_RECHECK_MS: "500", X402_RAIL_RECHECK_MAX_MS: "1000" });
    ok(s.up, "C: the paid server booted with the facilitator first on Base silent");
    if (!s.up) { console.log(s.log().slice(-1500)); process.exit(1); }
    ok(primary.hits() > 0 && /gave no \/supported answer/.test(s.log()), "C: control: the boot read got no answer from the facilitator first on Base");
    const pending = render402(s.base);
    await sleep(800);
    primary.release();
    const first = await pending;
    ok(first.status === 402 && first.accepts.some((a) => a.network === "eip155:8453"), `C: the first 402 is answered once that facilitator answers, and offers Base (${first.status}, ${first.ms} ms)`);
    const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
      await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);
    const client = new x402Client((_v, accepts) => accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453") || accepts[0]);
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const before = { ...verifies };
    const paid = await wrapFetchWithPayment(fetch, client)(`${s.base}/api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
    await paid.text();
    ok(verifies.primary === before.primary + 1 && verifies.F === before.F, `C: a Base payment is verified at the facilitator first on Base, not the one after it (first ${verifies.primary - before.primary}, next ${verifies.F - before.F})`);
    s.child.kill("SIGKILL");
  }
  // --- Leg D: the only facilitator listing upto on Base is a later one -------
  // It gives no boot /supported answer within the limit, then answers while
  // the upto gate reads it, so upto on Base is offered. Passing it over in the
  // first init would leave that pair with no facilitator: the route check
  // fails the init and every paid route answers 500 until the retry.
  {
    const primary = stellarFacilitator(false, EVM_KINDS);
    // Answers 1.8 s after its first read: past the boot read's 1.2 s, inside the upto gate's read.
    let firstRead = 0;
    const lateUrl = await listen((req, res) => { req.resume(); req.on("end", () => {
      if (req.url !== "/supported") return json(res, 404, {});
      if (!firstRead) firstRead = Date.now();
      setTimeout(() => json(res, 200, { kinds: [...EVM_KINDS, { x402Version: 2, scheme: "upto", network: "eip155:8453" }], extensions: [], signers: {} }), Math.max(0, firstRead + 1800 - Date.now()));
    }); });
    const s = await boot("first-402-d", await stellarFacilitator(false).urlP, { CDP_FACILITATOR_URL: await primary.urlP, PAYAI_FACILITATOR_URL: lateUrl, X402_UPTO_NETWORKS: "eip155:8453", PAYMENT_NETWORKS: "base,polygon", STELLAR_FACILITATOR_URL: "", STELLAR_WALLET_ADDRESS: "" });
    ok(s.up, "D: the paid server booted with the only upto facilitator late");
    if (!s.up) { console.log(s.log().slice(-1500)); process.exit(1); }
    ok(/gave no \/supported answer/.test(s.log()) && /upto: variable-amount settlement offered on eip155:8453/.test(s.log()), "D: control: its boot read got no answer, and upto on Base is offered");
    const first = await render402(s.base, FIRST_ABORT_MS);
    ok(first.status === 402 && first.accepts.some((a) => a.scheme === "upto"), `D: the first unpaid request after boot is a 402 offering upto (got ${first.status})`);
    ok(!/init attempt \d+ failed/.test(s.log()), "D: the first init does not fail on the upto pair");
    s.child.kill("SIGKILL");
  }
} catch (e) {
  failed++;
  console.log(`FAIL - ${e?.stack || e}`);
}
stopAll();
// The changelog says what leg C proves: only a fallback settlement service is
// passed over at the first init; the first one listed for a network is
// still waited for.
{
  const { readFileSync } = await import("node:fs");
  const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
  const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  const page = CHANGELOG_ENTRIES.flatMap((e) => e.items || []).join("\n");
  for (const [label, text] of [["CHANGELOG.md", md], ["src/changelog.js", page]]) {
    ok(/even when a fallback settlement service is slow to answer \(the first service listed for a network is still waited for\)/.test(text) && !/even when a payment network's settlement service is slow to answer/.test(text), `${label}: the first-paid-request item scopes the claim to a fallback settlement service`);
  }
}
console.log(`${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
