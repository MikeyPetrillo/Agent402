// A paid call to a slow route sent without Prefer: respond-async
// (src/slow-sync-window.js), driven end to end through the REAL paid server: a
// stub facilitator counts every verify and settle, and a stub image upstream
// (preloaded over api.openai.com, so a test boot can never spend) answers the
// premium image route (run budget 75 s, past the default 20 s window) with a
// chosen delay or failure. The facilitator's counts are the proof:
//   1. a paid call with no Prefer from a client that does not follow a 202 is
//      answered 400 before every gate: nothing verified, run upstream or
//      settled; a Prefer: wait shorter than the run budget is refused alike;
//   2. the same call from a client that follows a 202 (agent402-client
//      0.8.16+) is served as a job: 202 and a job link, nothing settled while
//      it runs, the result retrievable from the link, settled exactly once;
//   3. controls, exactly as before: Prefer: respond-async is a job; Prefer:
//      wait covering the run budget is synchronous; the MCP connector's local
//      replay is synchronous; an unpaid call gets the 402 (whose async block
//      now names Prefer: wait); a fast route is untouched;
//   4. a run that fails after the 202 ends the job failed and never settles.
// Unit checks cover the switch (SLOW_SYNC_WINDOW_SECONDS, "off") and parsing.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
import { slowSyncWindowSeconds, preferWaitSeconds, needsAsyncOrWait, slowSyncWindowMiddleware } from "../src/slow-sync-window.js";
requireUpstreamCosts("test-slow-sync-window");

let pass = 0, fail = 0, proc = null, facilitator = null, upstream = null;
const TMP = mkdtempSync(join(tmpdir(), "slow-sync-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(50); } return cond(); };
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 120_000).unref();

// ---- unit ----
{
  ok(slowSyncWindowSeconds({}) === 20 && slowSyncWindowSeconds({ SLOW_SYNC_WINDOW_SECONDS: "45" }) === 45 && slowSyncWindowSeconds({ SLOW_SYNC_WINDOW_SECONDS: "junk" }) === 20, "SLOW_SYNC_WINDOW_SECONDS defaults to 20");
  ok(["off", "OFF", "0", "false"].every((v) => slowSyncWindowSeconds({ SLOW_SYNC_WINDOW_SECONDS: v }) === null), "\"off\" (or 0/false) switches the window off");
  const pw = (v) => preferWaitSeconds({ headers: { prefer: v } });
  ok(pw("wait=240") === 240 && pw("handling=lenient, wait=300") === 300 && pw("wait = 90") === 90 && pw("respond-async") === null && pw("") === null && pw("nowait=5") === null, "Prefer: wait parses per RFC 7240");
  ok(needsAsyncOrWait({ slow: true, maxSeconds: 75 }, 20) && !needsAsyncOrWait({ slow: true, maxSeconds: 75 }, 90) && !needsAsyncOrWait({ slow: false, maxSeconds: 55 }, 20) && !needsAsyncOrWait({ slow: true, maxSeconds: 75 }, null) && !needsAsyncOrWait(null, 20), "only a slow route whose budget is past the window is gated");
  // Window off: the middleware passes every request through.
  const def = { slug: "x", asyncProfile: { slow: true, maxSeconds: 240 } };
  let passed = false;
  slowSyncWindowMiddleware({ asyncRouteOf: () => def, wantsAsync: () => false, carriesPaymentAttempt: () => true, followsJobAnswer: () => false, windowSeconds: () => null, log: () => {} })({ method: "POST", headers: {} }, {}, () => { passed = true; });
  ok(passed, "with the window off, a paid call without Prefer passes through untouched");
}

const [PORT, FAC_PORT, UP_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;

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
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const up = { calls: 0, delayMs: 2500, failNext: false };
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
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "", CDN_PROXY: "",
    // The default window (20 s) against the premium image route's 75 s budget.
    SLOW_SYNC_WINDOW_SECONDS: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    AGENT402_MCP_TASK_TTL_MS: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const PATH = "/api/image-gen-premium";
const BODY = JSON.stringify({ prompt: "a red fox in the snow" });
const FOLLOWER = "agent402-client/0.8.16 (node)";
let nonce = 0;
let accepted = null;
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const credential = (payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0xa000 + ++nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
const post = (headers, path = PATH, body = BODY) => fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "curl/8.4.0", ...headers }, body });
const job = async (url) => (await fetch(`${B}${url}`)).json();
const final = (url) => waitFor(async () => ["succeeded", "failed"].includes((await job(url)).state));
const counts = () => ({ v: fac.verify, s: fac.settle, u: up.calls });

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  // 3a. Unpaid: the ordinary 402, whose async block names both headers.
  const r0 = await post({ "x-forwarded-for": "10.8.0.1" });
  ok(r0.status === 402, `an unpaid call without Prefer gets the ordinary 402 (got ${r0.status})`);
  const req402 = JSON.parse(Buffer.from(r0.headers.get("payment-required"), "base64").toString("utf8"));
  accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "the route offers exact on Base");
  const b0 = await r0.json();
  ok(b0.async?.recommended === true && b0.async?.preferWait === `wait=${b0.async?.maxSeconds}` && b0.async?.withoutPrefer === 400 && /Prefer: wait=\d+/.test(b0.async?.how || ""), `the 402's async block names Prefer: wait and the refusal (${JSON.stringify(b0.async && { w: b0.async.preferWait, n: b0.async.withoutPrefer })})`);
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const row = pricing.endpoints.find((e) => e.slug === "image-gen-premium");
  ok(row?.async?.preferWait === "wait=75" && /Prefer: wait=75/.test(row?.description || "") && /answered 400 before any payment is taken/.test(row?.description || ""), "/api/pricing states the behavior in the row's async block and description");
  const oa = await (await fetch(`${B}/openapi.json`)).json();
  const op = oa.paths?.[PATH]?.post;
  ok(op?.["x-agent402-async"]?.preferWait === "wait=75" && op["x-agent402-async"].withoutPrefer === 400, "/openapi.json carries the same async block");
  const llms = await (await fetch(`${B}/llms.txt`)).text();
  ok(/image-gen-premium\)[^\n]*Prefer: wait=75 to wait on the connection/.test(llms), "/llms.txt marks the route with both headers");

  // 1. Paid, no Prefer, a client that does not follow a 202: refused before every gate.
  {
    const c = counts();
    const r = await post({ "x-forwarded-for": "10.8.0.2", "payment-signature": credential(wallet(1)) });
    const j = await r.json();
    await sleep(300);
    ok(r.status === 400 && j.error === "respond_async_required" && j.maxSeconds === 75 && j.preferWait === "wait=75", `a paid call without Prefer is answered 400 naming the headers (got ${r.status} ${j.error})`);
    ok(/Prefer: respond-async/.test(j.hint) && /Prefer: wait=75/.test(j.hint) && !r.headers.get("payment-response"), "the hint names both headers, and the answer carries no receipt");
    ok(fac.verify === c.v && fac.settle === c.s && up.calls === c.u, `nothing verified, settled or run upstream (verify +${fac.verify - c.v}, settle +${fac.settle - c.s}, upstream +${up.calls - c.u})`);
    const c2 = counts();
    const rs = await post({ prefer: "wait=10", "x-forwarded-for": "10.8.0.2", "payment-signature": credential(wallet(2)) });
    await sleep(300);
    ok(rs.status === 400 && fac.verify === c2.v && fac.settle === c2.s && up.calls === c2.u, `a Prefer: wait shorter than the run budget is refused alike (got ${rs.status})`);
  }

  // 2. Paid, no Prefer, a client that follows a 202: a job, settled once on the delivered result.
  {
    const c = counts();
    const t0 = Date.now();
    const r = await post({ "user-agent": FOLLOWER, "x-forwarded-for": "10.8.0.3", "payment-signature": credential(wallet(3)) });
    const j = await r.json();
    ok(r.status === 202 && Date.now() - t0 < up.delayMs && /^[0-9a-f]{48}$/.test(j.jobId || "") && r.headers.get("location") === `/api/jobs/${j.jobId}` && Number(r.headers.get("retry-after")) >= 1 && j.statusUrl === `/api/jobs/${j.jobId}`, `a following client gets 202, Location and Retry-After before the run finishes (${r.status} in ${Date.now() - t0} ms)`);
    ok(fac.settle === c.s, `the 202 settles nothing (settle +${fac.settle - c.s})`);
    await waitFor(async () => (await job(j.statusUrl)).state === "running" || up.calls > c.u);
    ok(fac.settle === c.s, "nothing settles while the job is running");
    await final(j.statusUrl);
    const g = await job(j.statusUrl);
    ok(g.state === "succeeded" && g.result?.httpStatus === 200 && g.result?.body && g.result?.headers?.["payment-response"], `the result is retrievable from the job link with its receipt (state ${g.state})`);
    ok(fac.settle === c.s + 1, `settled exactly once, after the result was ready (settle +${fac.settle - c.s})`);
    await job(j.statusUrl);
    ok(fac.settle === c.s + 1, "collecting the result again settles nothing more");
  }

  // 4. A run that fails after the 202: the job fails, nothing settles.
  {
    const c = counts();
    up.failNext = true;
    const r = await post({ "user-agent": FOLLOWER, "x-forwarded-for": "10.8.0.4", "payment-signature": credential(wallet(4)) });
    const j = await r.json();
    ok(r.status === 202, `a following client's call is accepted as a job (got ${r.status})`);
    await final(j.statusUrl);
    const g = await job(j.statusUrl);
    ok(g.state === "failed" && g.error?.httpStatus >= 500 && /nothing was charged/.test(g.message || ""), `a failed run ends the job failed (state ${g.state}, error HTTP ${g.error?.httpStatus}, ${g.message || ""})`);
    ok(fac.settle === c.s, `a failed run after the 202 settles nothing (settle +${fac.settle - c.s})`);
  }

  // 3. Controls, exactly as before.
  up.delayMs = 300;
  {
    const c = counts();
    const r = await post({ prefer: "respond-async", "x-forwarded-for": "10.8.0.5", "payment-signature": credential(wallet(5)) });
    const j = await r.json();
    ok(r.status === 202 && r.headers.get("preference-applied") === "respond-async", `Prefer: respond-async answers 202 as before (got ${r.status})`);
    await final(j.statusUrl);
    ok((await job(j.statusUrl)).state === "succeeded" && fac.settle === c.s + 1, "and its job settles once on the result");
  }
  {
    const c = counts();
    const r = await post({ prefer: "wait=75", "x-forwarded-for": "10.8.0.6", "payment-signature": credential(wallet(6)) });
    ok(r.status === 200 && fac.settle === c.s + 1 && !!r.headers.get("payment-response"), `Prefer: wait covering the run budget is served synchronously and settles once (got ${r.status})`);
  }
  {
    const c = counts();
    const r = await post({ "x-agent402-via": "mcp", "x-forwarded-for": "10.8.0.7", "payment-signature": credential(wallet(7)) });
    ok(r.status === 200 && fac.settle === c.s + 1, `the MCP connector's local replay is served synchronously as before (got ${r.status})`);
  }
  {
    const r = await post({ "x-forwarded-for": "10.8.0.8" }, "/api/uuid", "{}");
    ok(r.status !== 400 && r.status !== 202 && !r.headers.get("x-async-recommended"), `a fast route is untouched (got ${r.status})`);
  }
} finally {
  proc?.kill("SIGKILL"); facilitator?.close(); upstream?.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog.slice(-25)) console.error("  server:", l);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
