// Paid check of Decide against production. NOT in CI: it spends (about $1).
// Every golden task is bought as a plan, and the tasks that carry their data
// are also executed, from our test wallet with the heartbeat token so the
// ledger records them as our own traffic. Each request's budget is nudged so
// a cached plan from an older planner is never what gets measured.
//
//   BURNER_KEY=0x... POW_SECRET=... [ONLY="task text|other"] node scripts/decide-prod-check.mjs [out.json]
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { GOLDEN } from "./decide-golden-eval.mjs";
import { validateParams } from "../src/decide/params.js";
const TARGET = "https://agent402.tools";
const pk = process.env.BURNER_KEY.startsWith("0x") ? process.env.BURNER_KEY : `0x${process.env.BURNER_KEY}`;
const secret = process.env.POW_SECRET;
const heartbeat = () => createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);
const tagged = (base) => (input, init) => { const req = new Request(input, init); req.headers.set("X-Heartbeat-Token", heartbeat()); return base(req); };
const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }, { disableVendorSpendControls }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"), import("../src/x402-spend-controls.js")]);
const client = disableVendorSpendControls(new x402Client());
registerExactEvmScheme(client, { signer: privateKeyToAccount(pk) });
const pay = wrapFetchWithPayment(tagged(fetch), client);
const post = (path, body) => pay(`${TARGET}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rows = [];
const ONLY = process.env.ONLY ? process.env.ONLY.split("|") : null;
for (const g of GOLDEN.filter((g) => !ONLY || ONLY.some((o) => g.task.includes(o)))) {
  const t0 = Date.now();
  let d = null, err = null;
  try { const r = await post("/api/decide", { task: g.task, depth: "plan", constraints: { maxBudgetUsd: Math.round((g.budget + 0.0007) * 1e4) / 1e4 } }); d = await r.json(); if (r.status !== 200) err = `HTTP ${r.status} ${d?.error || ""}`; } catch (e) { err = String(e?.message || e); }
  const problems = [];
  if (!err) {
    if (!d.plan?.length) problems.push("empty plan");
    for (const p of d.plan || []) {
      const v = validateParams(p.tool.inputSchema, p.tool.exampleParams); if (!v.ok) problems.push(`s${p.step} params invalid`);
      const open = Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^<[^>]+>$/.test(x));
      if (open && g.data) problems.push(`s${p.step} placeholder`);
    }
    const linked = (d.plan || []).some((p) => Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^\{\{step \d+\}\}$/.test(x)));
    if (g.chain && !linked) problems.push("not chained");
  }
  let run = null;
  if (!err && !problems.length && g.data && (g.chain || g.budget <= 0.1) && d.executionCredit?.token) {
    try {
      const r = await post("/api/decide/execute", { decisionId: d.decisionId, creditToken: d.executionCredit.token });
      const x = await r.json();
      run = { full: x, http: r.status, status: x.status, spent: x.spentUsd, steps: (x.steps || []).map((s) => `${s.step}:${s.status}${s.reason ? `(${s.reason.slice(0, 60)})` : ""}`), error: x.error?.slice?.(0, 160) };
    } catch (e) { run = { error: String(e?.message || e).slice(0, 160) }; }
  }
  const kind = (g.heldOut ? "held-" : "") + (g.chain ? "chain" : g.data ? "data" : "no-data");
  rows.push({ task: g.task, kind, err, problems, decision: d, plan: (d?.plan || []).map((p) => `${p.tool.slug || p.tool.name}${p.tool.firstParty ? "" : "@" + p.tool.seller}`), run, ms: Date.now() - t0 });
  console.log(`${err || problems.length ? "FAIL" : "PASS"} [${kind}] ${g.task.slice(0, 55)} ${err || problems.join(",")}${run ? ` | run ${run.http} ${run.status || ""} ${run.steps?.join(" ") || run.error || ""}` : ""}`);
}
writeFileSync(process.argv[2] || "prod-golden.json", JSON.stringify(rows, null, 2));
const by = (k) => rows.filter((r) => r.kind === k);
const pass = (r) => !r.err && !r.problems.length;
console.log(JSON.stringify({ plans: Object.fromEntries(["data", "chain", "no-data", "held-data", "held-chain"].map((k) => [k, `${by(k).filter(pass).length}/${by(k).length}`])), heldRuns: { tried: rows.filter((r) => r.run && r.kind.startsWith("held")).length, complete: rows.filter((r) => r.run?.status === "complete" && r.kind.startsWith("held")).length }, runs: { tried: rows.filter((r) => r.run).length, complete: rows.filter((r) => r.run?.status === "complete").length, partial: rows.filter((r) => r.run?.status === "partial").length, refused: rows.filter((r) => r.run && r.run.http !== 200).length } }));
