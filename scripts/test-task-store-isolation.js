// The file-backed job store (src/mcp-tasks.js createTaskStore, used by the HTTP
// async jobs and the MCP tasks) resolves, at boot, every working record another
// boot owns as failed: its run died with that process. Two live processes on
// one directory therefore fail each other's running jobs. Each container has
// its own /tmp, but local servers (tests run side by side) all defaulted to
// /tmp/async-jobs. AGENT402_TASK_DATA_DIR gives a process its own directory.
//   - unit: taskDataDir follows AGENT402_TASK_DATA_DIR; a second store on the
//     same directory fails the first one's running record, and a store on its
//     own directory leaves it alone;
//   - live, two paid-mode servers with a stub facilitator and a slow stub image
//     upstream: a server booting on the SAME directory fails a running job of
//     another (the mechanism, reproduced); a server booting on its OWN
//     directory leaves it running, and the job completes and settles once.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
import { createTaskStore, taskDataDir } from "../src/mcp-tasks.js";
requireUpstreamCosts("test-task-store-isolation");

let pass = 0, fail = 0;
const procs = [];
let facilitator = null, upstream = null;
const TMP = mkdtempSync(join(tmpdir(), "task-iso-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(100); } return cond(); };
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); for (const p of procs) p.kill("SIGKILL"); process.exit(1); }, 150_000).unref();

// ---- unit ----
{
  const prior = process.env.AGENT402_TASK_DATA_DIR;
  process.env.AGENT402_TASK_DATA_DIR = join(TMP, "unit-a");
  ok(taskDataDir("async-jobs") === join(TMP, "unit-a", "async-jobs"), "taskDataDir follows AGENT402_TASK_DATA_DIR");
  const a = createTaskStore({ dir: taskDataDir("async-jobs"), bootId: "boot-a", log: () => {} });
  const rec = a.create({ slug: "x", controller: new AbortController() });
  process.env.AGENT402_TASK_DATA_DIR = join(TMP, "unit-b");
  createTaskStore({ dir: taskDataDir("async-jobs"), bootId: "boot-b", log: () => {} });
  ok(a.get(rec.taskId)?.status === "working", "a store booting on its own directory leaves another's running record alone");
  createTaskStore({ dir: join(TMP, "unit-a", "async-jobs"), bootId: "boot-c", log: () => {} });
  ok(a.get(rec.taskId)?.status === "failed", "a store booting on the same directory resolves another's running record as failed (the mechanism)");
  if (prior === undefined) delete process.env.AGENT402_TASK_DATA_DIR; else process.env.AGENT402_TASK_DATA_DIR = prior;
}

// ---- every suite that boots a server and runs a job there has its own store ----
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const here = new URL(".", import.meta.url);
  const shared = [];
  for (const f of readdirSync(here)) {
    if (!/^test-.*\.js$/.test(f)) continue;
    const src = readFileSync(new URL(f, here), "utf8");
    const bootsServer = /spawn\([^)]*src\/server\.js/.test(src);
    const runsJobs = /respond-async|tasks\/get/.test(src);
    if (bootsServer && runsJobs && !/AGENT402_TASK_DATA_DIR:/.test(src)) shared.push(f);
  }
  ok(shared.length === 0, `every suite that boots a server and runs jobs sets AGENT402_TASK_DATA_DIR (missing: ${shared.join(", ") || "none"})`);
}

// ---- live ----
const [PA, PB, PC, FAC_PORT, UP_PORT] = await getFreePorts(5);
const fac = { settle: 0 };
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
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const up = { delayMs: 30_000 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }, up.delayMs));
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
const boot = async (port, dataDir, tag) => {
  const sub = join(TMP, tag);
  mkdirSync(sub, { recursive: true });
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    env: { ...process.env, PORT: String(port), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
      OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "", CDN_PROXY: "", STATE_DATABASE_URL: "",
      AGENT402_TASK_DATA_DIR: dataDir,
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      REFUND_DB_DIR: sub, SALES_LEDGER_DB: join(sub, "sales.db"), HANGUP_FORGIVE_FILE: join(sub, "hangup.json"),
      AGENT402_MCP_TASK_TTL_MS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(`${tag}: ${l.slice(0, 300)}`); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const ready = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, 80_000);
  ok(ready, `server ${tag} boots`);
  return proc;
};

const A = `http://127.0.0.1:${PA}`;
const PATH = "/api/image-gen-premium";
const BODY = JSON.stringify({ prompt: "a red fox in the snow" });
let accepted = null, nonce = 0;
const credential = (payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0xb000 + ++nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
const startJob = async (n) => {
  const r = await fetch(`${A}${PATH}`, { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async", "x-forwarded-for": `10.7.0.${n}`, "payment-signature": credential(`0x${n.toString(16).padStart(40, "0")}`) }, body: BODY });
  return r.status === 202 ? (await r.json()).statusUrl : null;
};
const jobOf = async (url) => (await fetch(`${A}${url}`)).json();

try {
  const dirA = join(TMP, "store-a");
  await boot(PA, dirA, "A");
  const r0 = await fetch(`${A}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
  accepted = (JSON.parse(Buffer.from(r0.headers.get("payment-required") || "", "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "server A offers exact on Base");

  // Control: a second server on A's directory fails A's running job at boot.
  const j1 = await startJob(1);
  ok(!!j1, "server A accepts a job");
  const b = await boot(PB, dirA, "B-same-dir");
  const g1 = await jobOf(j1);
  ok(g1.state === "failed" && /restart/.test(g1.message || ""), `a server booting on the same directory fails another's running job (state ${g1.state})`);
  b.kill("SIGKILL");

  // Isolated: a server on its own directory leaves A's job running to completion.
  const s0 = fac.settle;
  const j2 = await startJob(2);
  ok(!!j2, "server A accepts a second job");
  await boot(PC, join(TMP, "store-c"), "C-own-dir");
  const g2 = await jobOf(j2);
  ok(g2.state === "queued" || g2.state === "running", `a server booting on its own directory leaves the job running (state ${g2.state})`);
  await waitFor(async () => ["succeeded", "failed"].includes((await jobOf(j2)).state), 60_000);
  const g2b = await jobOf(j2);
  ok(g2b.state === "succeeded" && g2b.result?.httpStatus === 200, `the job then completes with its answer (state ${g2b.state})`);
  ok(fac.settle >= s0 + 1, `and it settled (settles +${fac.settle - s0})`);
} catch (e) {
  ok(false, `the live run finished (${e?.message || e})`);
} finally {
  for (const p of procs) p.kill("SIGKILL");
  facilitator?.close(); upstream?.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog.slice(-30)) console.error("  server:", l);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
