// The Solana intel deadlines on the real route: a RugCheck read that never
// answers ends at the tool's own cap as a 503 that names the upstream and the
// step, attributed upstream (never a 504, and >= 400 is never charged: the
// paywall settles after the handler). Both upstreams are stubbed in-process
// (--import), so nothing leaves the machine and nothing is spent.
//   - sol-token-safety: the summary read stalls -> 503 at the summary cap;
//   - sol-token-holders: the report read stalls -> 503 at the report cap, and
//     the whole answer lands inside the handler budget;
//   - control: another mint, served by the same stub, answers 200 with rows
//     and the partial-answer fields, so the 503s above are the deadline and
//     not a broken stub.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { __test } from "../src/tools/solana-intel-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./lib/stub-rugcheck-fetch.mjs", import.meta.url));
const D = __test.DEADLINES;
const STALL = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SERVED = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
// Timing slack: the cap is the signal's own timer; the rest is request
// plumbing on a loaded CI box.
const SLACK_MS = 3000;

const [port] = await getFreePorts(1);
const child = spawn(process.execPath, ["--import", PRELOAD, "src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", STATE_DATABASE_URL: "", JUPITER_API_BASE: "", POSTHOG_API_KEY: "", SOLANA_RPC_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
const post = async (path, body) => {
  const t0 = Date.now();
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(D.HANDLER_BUDGET_MS + 15_000) });
  return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - t0 };
};
try {
  let up = false;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(250); }
  if (!up) throw new Error(`server did not boot:\n${log.slice(-2000)}`);

  // The two stalls run together: each is its own request with its own budget.
  const [safety, holders, control, controlSafety] = await Promise.all([
    post("/api/sol-token-safety", { mint: STALL }),
    post("/api/sol-token-holders", { mint: STALL, limit: 10 }),
    post("/api/sol-token-holders", { mint: SERVED, limit: 10 }),
    post("/api/sol-token-safety", { mint: SERVED }),
  ]);

  ok(safety.status === 503, `a stalled RugCheck summary answers 503, not 504 (got ${safety.status} in ${safety.ms} ms)`);
  ok(/^RugCheck did not answer the report summary read within 8 s \(upstream deadline\)/.test(safety.body?.error || ""), `the body names the upstream and the step (got: ${safety.body?.error})`);
  ok(safety.body?.attribution === "upstream" && safety.body?.tool === "sol-token-safety", `the body is attributed upstream and names the tool (got ${JSON.stringify(safety.body)})`);
  ok(safety.ms >= D.RUGCHECK_SUMMARY_MS - 100 && safety.ms < D.RUGCHECK_SUMMARY_MS + SLACK_MS, `it answers at the summary cap (${safety.ms} ms against ${D.RUGCHECK_SUMMARY_MS})`);

  ok(holders.status === 503, `a stalled RugCheck report answers 503, not 504 (got ${holders.status} in ${holders.ms} ms)`);
  ok(/^RugCheck did not answer the report read within 12 s \(upstream deadline\)/.test(holders.body?.error || ""), `the body names the report step (got: ${holders.body?.error})`);
  ok(holders.ms >= D.RUGCHECK_REPORT_MS - 100 && holders.ms < D.RUGCHECK_REPORT_MS + SLACK_MS && holders.ms < D.HANDLER_BUDGET_MS, `it answers at the report cap and inside the handler budget (${holders.ms} ms against ${D.RUGCHECK_REPORT_MS} and ${D.HANDLER_BUDGET_MS})`);

  ok(control.status === 200 && control.body?.holders?.length === 10 && control.body?.returned === 10 && control.body?.matched === 20 && control.body?.complete === false && control.body?.maxHolders === 20,
    `control: a served mint through the same stub answers 200 with rows and the partial fields (${control.status}, ${JSON.stringify({ rows: control.body?.holders?.length, returned: control.body?.returned, matched: control.body?.matched, complete: control.body?.complete })})`);
  ok(controlSafety.status === 200 && controlSafety.body?.riskLevel === "good" && controlSafety.body?.token?.symbol === "FIX", `control: the safety route serves through the stub (${controlSafety.status}, ${controlSafety.body?.riskLevel}, ${controlSafety.body?.token?.symbol})`);
  // "504" as a status, not inside another number: the boot log can carry it
  // in a millisecond timestamp or a count. The offending lines are printed.
  const offending = log.split("\n").filter((l) => /upstream timed out|(?<![\d.:])504(?![\d])/.test(l));
  ok(offending.length === 0, `the server log carries no 504 or 'timed out' wording for these reads${offending.length ? `: ${offending.slice(0, 3).join(" | ")}` : ""}`);
} catch (e) {
  fail++; console.error(`FAIL - ${e?.message || e}`);
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
}
console.log(`\ntest-solana-intel-deadline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
