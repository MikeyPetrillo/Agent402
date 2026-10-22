// Every settlement emits one payment_settled, from the one place a settlement
// becomes final (the settlement tally in src/server.js, run through
// onSettleOutcome in src/hangup-settlement.js), driven end to end through the
// REAL paid server: a stub facilitator counts every settle, a stub image
// upstream (preloaded over api.openai.com, so a test boot can never spend)
// answers the premium image route after a chosen delay, and PostHog's test
// sink prints every event the server would have sent. The facilitator's settle
// count is the oracle: settlements and payment_settled events must agree.
//   - a direct paid call: one settlement, one event;
//   - Prefer: respond-async: the 202 emits nothing, the loopback replay emits
//     exactly one (never two for one sale);
//   - a handler 4xx and a refused payment: nothing settles, nothing is emitted;
//   - a buyer who closes the connection before the first byte with no
//     forgiveness ticket (HANGUP_FORGIVE=off): the charge goes through and is
//     booked as owed, and the settlement is still emitted exactly once. Node
//     emits no "finish" for a response ended on a closed socket, which is how
//     these settlements went missing from the funnel, the sales ledger and the
//     served-call tally until the tally moved to onSettleOutcome.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-settlement-event");

let pass = 0, fail = 0, proc = null, facilitator = null, upstream = null;
const TMP = mkdtempSync(join(tmpdir(), "settlement-event-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); } return cond(); };
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 120_000).unref();

const [PORT, FAC_PORT, UP_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const BAD_PAYER = "0x" + "ba".repeat(20);

const fac = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const payer = p.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; return reply(payer === BAD_PAYER ? { isValid: false, invalidReason: "insufficient_funds", payer } : { isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const up = { calls: 0, delayMs: 300 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
upstream = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    up.calls++;
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }, up.delayMs);
  });
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

const preload = join(TMP, "openai-stub.mjs");
writeFileSync(preload, `
const STUB = ${JSON.stringify(`http://127.0.0.1:${UP_PORT}`)};
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && url.startsWith("https://api.openai.com/")) return real.call(this, STUB + url.slice("https://api.openai.com".length), init);
  return real.call(this, input, init);
};
`);
proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
  // The slow-route sync window (src/slow-sync-window.js) is off: this suite
  // drives slow routes synchronously; test-slow-sync-window.js covers the window.
  env: { ...process.env, SLOW_SYNC_WINDOW_SECONDS: "off", PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
    POSTHOG_API_KEY: "", POSTHOG_TEST_CAPTURE: "1",
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    // No forgiveness: a buyer who leaves before the first byte is settled and
    // booked as owed, the path whose settlement had no event.
    HANGUP_FORGIVE: "off",
    AGENT402_MCP_TASK_TTL_MS: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 2000)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const PATH = "/api/image-gen-premium";
const SLUG = "image-gen-premium";
const BODY = JSON.stringify({ prompt: "a red fox in the snow" });
let nonce = 0;
let accepted = null;
const credential = (payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x9000 + ++nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const post = (headers, path = PATH, body = BODY) => fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const job = async (url) => (await fetch(`${B}${url}`)).json();
const events = () => serverLog
  .filter((l) => l.includes("[posthog-test]"))
  .map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
  .filter(Boolean);
const settledEvents = () => events().filter((e) => e.event === "payment_settled");
// Settle count and event count agree: the invariant under test.
const agree = async () => waitFor(() => settledEvents().length >= fac.settle, 5000);

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  const r0 = await post({ "x-forwarded-for": "10.9.1.1" });
  ok(r0.status === 402, `an unpaid call gets the ordinary 402 (got ${r0.status})`);
  const req402 = JSON.parse(Buffer.from(r0.headers.get("payment-required"), "base64").toString("utf8"));
  accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "the route offers exact on Base");
  ok(settledEvents().length === 0, "a 402 emits no settlement");

  // 1. Direct paid call: one settlement, one event.
  const r1 = await post({ "x-forwarded-for": "10.9.1.2", "payment-signature": credential(wallet(1)) });
  await r1.arrayBuffer();
  await agree();
  const e1 = settledEvents();
  ok(r1.status === 200 && fac.settle === 1, `a direct paid call answers 200 and settles once (got ${r1.status}, settles ${fac.settle})`);
  ok(e1.length === 1 && e1[0].properties.slug === SLUG && e1[0].properties.rail === "usdc" && e1[0].properties.paid === true && e1[0].properties.network === "base",
    `exactly one payment_settled for it, slug=${SLUG} rail=usdc on Base (got ${e1.length}: ${JSON.stringify(e1.map((e) => e.properties))})`);
  ok(e1[0]?.properties.payer === wallet(1), "the event names the signed payer");

  // 2. Prefer: respond-async: the 202 emits nothing; the replay emits one.
  const r2 = await post({ prefer: "respond-async", "x-forwarded-for": "10.9.1.3", "payment-signature": credential(wallet(2)) });
  const j2 = await r2.json();
  ok(r2.status === 202 && j2.status === "working", `the async call answers 202 (got ${r2.status})`);
  ok(settledEvents().length === 1 && fac.settle === 1, "the 202 itself settles nothing and emits nothing");
  const done2 = await waitFor(async () => ["completed", "failed"].includes((await job(j2.statusUrl)).status));
  const g2 = await job(j2.statusUrl);
  await agree();
  ok(done2 && g2.status === "completed" && fac.settle === 2, `the job completes and settles once (status ${g2.status}, settles ${fac.settle})`);
  const e2 = settledEvents();
  ok(e2.length === 2 && e2[1].properties.slug === SLUG && e2[1].properties.payer === wallet(2), `the replayed call emits exactly one payment_settled, for its payer (got ${e2.length})`);

  // 3. A handler 4xx with a valid payment: nothing settles, nothing is emitted.
  const r3 = await post({ "x-forwarded-for": "10.9.1.4", "payment-signature": credential(wallet(3)) }, PATH, JSON.stringify({}));
  await r3.arrayBuffer();
  await sleep(300);
  ok(r3.status === 400 && fac.settle === 2 && settledEvents().length === 2, `a handler 4xx settles nothing and emits nothing (got ${r3.status}, settles ${fac.settle}, events ${settledEvents().length})`);

  // 4. A refused payment: 402, nothing settles, nothing is emitted.
  const r4 = await post({ "x-forwarded-for": "10.9.1.5", "payment-signature": credential(BAD_PAYER) });
  await r4.arrayBuffer();
  await sleep(300);
  ok(r4.status === 402 && fac.settle === 2 && settledEvents().length === 2, `a refused payment settles nothing and emits nothing (got ${r4.status})`);

  // 5. The buyer leaves before the first byte, with no forgiveness ticket: the
  //    run completes, the charge goes through, the response is ended on a
  //    closed socket, and the settlement is emitted exactly once.
  up.delayMs = 1500;
  const calls5 = up.calls;
  await new Promise((resolve) => {
    const r = httpRequest(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.1.6", "payment-signature": credential(wallet(5)) } }, () => {});
    r.on("error", () => {});
    r.on("close", resolve);
    r.end(BODY);
    // After the handler has started its upstream call, before any byte comes back.
    waitFor(() => up.calls > calls5, 5000).then(() => setTimeout(() => r.destroy(), 100));
  });
  ok(await waitFor(() => fac.settle === 3, 10_000), `the abandoned run is settled anyway (no ticket) (settles ${fac.settle})`);
  await agree();
  const e5 = settledEvents();
  ok(e5.length === 3 && e5[2].properties.slug === SLUG && e5[2].properties.payer === wallet(5) && e5[2].properties.paid === true,
    `the settlement the buyer never received still emits exactly one payment_settled (got ${e5.length})`);
  ok(serverLog.some((l) => /\[hangup\] CHARGED-BUT-NOT-SERVED/.test(l)), "and the charge is booked as owed in the refund ledger");
  // The sales ledger and the served-call tally ride the same hook.
  const sales = await (await fetch(`${B}/api/sales`)).json();
  ok(Number(sales.totals?.byRail?.["external:usdc"] || 0) === 3, `the sales ledger holds all three settlements by name (byRail ${JSON.stringify(sales.totals?.byRail)})`);

  // The oracle, once more, over the whole run.
  await sleep(300);
  ok(settledEvents().length === fac.settle, `payment_settled events and facilitator settles agree (${settledEvents().length} vs ${fac.settle})`);
  ok(!events().some((e) => e.event === "charged_but_failed"), "no charged_but_failed was recorded for a settled 200");
} finally {
  proc?.kill("SIGKILL"); facilitator?.close(); upstream?.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog.slice(-40)) console.error("  server:", l);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
