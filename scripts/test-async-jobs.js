// "Prefer: respond-async" on a slow paid route (src/async-jobs.js), driven end
// to end through the REAL paid server: a stub facilitator counts every verify
// and settle, and a stub image upstream (preloaded over api.openai.com, so a
// test boot can never spend) answers the premium image route with a chosen
// delay or failure. The settle count is the proof:
//   - the 202 settles nothing; the job settles exactly once, and only when the
//     result is ready;
//   - an upstream failure ends the job failed with no settlement;
//   - a refused payment ends the job failed (HTTP 402) with no settlement;
//   - an unpaid request, a fast route, or a call without the header is served
//     exactly as before (no job);
//   - a forged loopback marker is stripped and served synchronously;
//   - the per-client cap refuses a fifth concurrent job before anything runs;
//   - job links are bearer ids: unknown or malformed ids are 404.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-async-jobs");

let pass = 0, fail = 0, proc = null, facilitator = null, upstream = null;
const TMP = mkdtempSync(join(tmpdir(), "async-jobs-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); } return cond(); };
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 120_000).unref();

const [PORT, FAC_PORT, UP_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const BAD_PAYER = "0x" + "ba".repeat(20);

const fac = { verify: 0, settle: 0, verifiedPayers: [] };
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
    if (req.url === "/verify") { fac.verify++; fac.verifiedPayers.push(String(payer || "").toLowerCase()); return reply(payer === BAD_PAYER ? { isValid: false, invalidReason: "insufficient_funds", payer } : { isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const up = { calls: 0, delayMs: 1500, failNext: false };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
upstream = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    up.calls++;
    const failing = up.failNext; up.failNext = false;
    setTimeout(() => {
      if (res.destroyed) return;
      if (failing) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "boom" } })); }
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
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    AGENT402_MCP_TASK_TTL_MS: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const PATH = "/api/image-gen-premium";
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

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  // Unpaid, with the header: the ordinary 402, no job.
  const r0 = await post({ prefer: "respond-async", "x-forwarded-for": "10.9.0.1" });
  ok(r0.status === 402, `an unpaid call with Prefer: respond-async gets the ordinary 402 (got ${r0.status})`);
  const req402 = JSON.parse(Buffer.from(r0.headers.get("payment-required"), "base64").toString("utf8"));
  accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "the route offers exact on Base");

  // 1. Paid + async: 202 now, settle only when the result is ready.
  const s0 = fac.settle;
  const t0 = Date.now();
  const r1 = await post({ prefer: "respond-async", "x-forwarded-for": "10.9.0.2", "payment-signature": credential(wallet(1)) });
  const j1 = await r1.json();
  ok(r1.status === 202 && Date.now() - t0 < up.delayMs && /^[0-9a-f]{48}$/.test(j1.jobId || ""), `a paid call answers 202 with a job id before the run finishes (${r1.status} in ${Date.now() - t0} ms)`);
  ok(r1.headers.get("location") === `/api/jobs/${j1.jobId}` && r1.headers.get("preference-applied") === "respond-async" && j1.status === "working", "the 202 carries Location, Preference-Applied and status working");
  ok(fac.settle === s0, `nothing has settled when the 202 is answered (settles ${fac.settle - s0})`);
  const done1 = await waitFor(async () => ["completed", "failed"].includes((await job(j1.statusUrl)).status));
  const g1 = await job(j1.statusUrl);
  ok(done1 && g1.status === "completed" && g1.result?.httpStatus === 200 && g1.result?.body, `the job completes with the route's 200 answer (status ${g1.status})`);
  ok(fac.settle === s0 + 1, `exactly one settlement, after the result was ready (settles ${fac.settle - s0})`);
  ok(!!g1.result?.headers?.["payment-response"], "the settle receipt is kept with the result");
  ok(!("owner" in g1) && !("pid" in g1), "the job document exposes no owner or process id");

  // 2. Upstream failure: the job fails and nothing settles.
  const s2 = fac.settle; up.failNext = true;
  const j2 = await (await post({ prefer: "respond-async", "x-forwarded-for": "10.9.0.3", "payment-signature": credential(wallet(2)) })).json();
  await waitFor(async () => ["completed", "failed"].includes((await job(j2.statusUrl)).status));
  const g2 = await job(j2.statusUrl);
  ok(g2.status === "failed" && g2.error?.httpStatus >= 500 && /nothing was charged/.test(g2.message || ""), `a failed run ends the job failed and says not charged (error HTTP ${g2.error?.httpStatus})`);
  ok(fac.settle === s2, `a failed run settles nothing (settles ${fac.settle - s2})`);

  // 3. Refused payment: the job carries the 402, nothing settles.
  const s3 = fac.settle, calls3 = up.calls;
  const j3 = await (await post({ prefer: "respond-async", "x-forwarded-for": "10.9.0.4", "payment-signature": credential(BAD_PAYER) })).json();
  await waitFor(async () => ["completed", "failed"].includes((await job(j3.statusUrl)).status));
  const g3 = await job(j3.statusUrl);
  ok(g3.status === "failed" && g3.error?.httpStatus === 402 && /payment was not accepted/i.test(g3.message || ""), `a refused payment ends the job failed with the 402 (error HTTP ${g3.error?.httpStatus})`);
  ok(fac.settle === s3 && up.calls === calls3, "a refused payment settles nothing and never reaches the upstream");

  // 4. No header: served synchronously as before.
  const s4 = fac.settle;
  const r4 = await post({ "x-forwarded-for": "10.9.0.5", "payment-signature": credential(wallet(4)) });
  ok(r4.status === 200 && fac.settle === s4 + 1, `without the header the call is synchronous and settles once (got ${r4.status})`);

  // 5. A forged loopback marker from outside is stripped: synchronous, no job.
  const s5 = fac.settle;
  const r5 = await post({ prefer: "respond-async", "x-agent402-async-loopback": "f".repeat(48), "x-forwarded-for": "10.9.0.6", "payment-signature": credential(wallet(5)) });
  ok(r5.status === 200 && fac.settle === s5 + 1, `a forged loopback marker gets an ordinary synchronous answer, not a job (got ${r5.status})`);

  // 6. A fast route ignores the header.
  const r6 = await fetch(`${B}/api/uuid`, { method: "POST", headers: { prefer: "respond-async", "content-type": "application/json", "x-forwarded-for": "10.9.0.7" }, body: "{}" });
  ok(r6.status !== 202, `a fast route never answers 202 (got ${r6.status})`);

  // 7. Per-client cap: a fifth concurrent job is refused before anything runs.
  up.delayMs = 4000;
  const ip = "10.9.0.8";
  const firstFour = [];
  for (let i = 0; i < 4; i++) firstFour.push(await post({ prefer: "respond-async", "x-forwarded-for": ip, "payment-signature": credential(wallet(100 + i)) }));
  ok(firstFour.every((r) => r.status === 202), `four concurrent jobs from one client are accepted (${firstFour.map((r) => r.status).join(",")})`);
  const r7 = await post({ prefer: "respond-async", "x-forwarded-for": ip, "payment-signature": credential(wallet(200)) });
  await sleep(300);
  ok(r7.status === 429 && !fac.verifiedPayers.includes(wallet(200).toLowerCase()), `a fifth concurrent job is refused with 429 and its payment is never verified (got ${r7.status})`);
  up.delayMs = 50;

  // 8. Bearer ids.
  ok((await fetch(`${B}/api/jobs/${"0".repeat(48)}`)).status === 404 && (await fetch(`${B}/api/jobs/..%2Fetc`)).status === 404, "unknown and malformed job ids are 404");
} finally {
  proc?.kill("SIGKILL"); facilitator?.close(); upstream?.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog.slice(-25)) console.error("  server:", l);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
