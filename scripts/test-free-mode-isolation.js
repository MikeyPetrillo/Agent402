// FREE_MODE verifies no payment, so nothing it holds may pass for a paid
// fact. Two servers share one job store directory, as a FREE_MODE sibling on
// the same host would: one FREE_MODE, one paid (a stub facilitator verifies
// and settles every well-formed credential, and refuses one wallet).
//
// Identity (src/payer.js identityPayerOf):
//   - FREE_MODE: an unsigned X-Payment header naming a wallet is no identity.
//     The memory takeover sequence (write as the victim, grant yourself, read
//     with your own header) is refused at every step with a 400 that names
//     FREE_MODE; my-usage, receipts, feedback and attest refuse the same way;
//     the documented demo namespace (?ns=) still works.
//   - Paid: the same forged header is a 402 (the gate verifies first), and a
//     verified payer still owns its namespace: write, read back, and a second
//     wallet without a grant is refused.
// Jobs (src/mcp-tasks.js `freeMode` on each record):
//   - a job the FREE_MODE server created is 404 on the paid server, which
//     still serves its own; the FREE_MODE server reads its own.
//
//   node scripts/test-free-mode-isolation.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { createTaskStore } from "../src/mcp-tasks.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = mkdtempSync(join(tmpdir(), "free-mode-isolation-"));
const TASKS = join(TMP, "tasks");
const procs = [];
let facilitator = null;
const cleanup = () => { for (const p of procs) try { p.kill("SIGKILL"); } catch { /* gone */ } try { facilitator?.close(); } catch { /* closed */ } try { rmSync(TMP, { recursive: true, force: true }); } catch { /* kept */ } };
setTimeout(() => { console.error("FAIL - timed out"); for (const p of procs) console.error(p.log.join("").slice(-1500)); cleanup(); process.exit(1); }, 180_000).unref();

const [FREE_PORT, PAID_PORT, FAC_PORT] = await getFreePorts(3);
const FREE = `http://127.0.0.1:${FREE_PORT}`;
const PAID = `http://127.0.0.1:${PAID_PORT}`;
const VICTIM = "0x" + "3".repeat(40);
const ATTACKER = "0x" + "4".repeat(40);
const REFUSED = "0x" + "ba".repeat(20);

// --- 0. the store, in process: a record a FREE_MODE store wrote is unknown to a paid one
{
  const dir = join(TMP, "unit");
  const freeStore = createTaskStore({ dir, freeMode: true, log: () => {} });
  const paidStore = createTaskStore({ dir, freeMode: false, log: () => {} });
  const f = freeStore.create({ slug: "uuid" });
  const p = paidStore.create({ slug: "uuid" });
  freeStore.complete?.(f.taskId, { httpStatus: 200, body: { ok: true } });
  ok(f.freeMode === true && !("freeMode" in p), "a FREE_MODE store stamps its records; a paid store does not");
  ok(paidStore.get(f.taskId) === null, "a paid store answers a FREE_MODE record as unknown");
  ok(paidStore.get(p.taskId)?.taskId === p.taskId, "a paid store reads its own record");
  ok(freeStore.get(f.taskId)?.taskId === f.taskId && freeStore.get(p.taskId)?.taskId === p.taskId, "a FREE_MODE store reads both");
}

// --- stub facilitator for the paid server
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
    const sig = p.paymentPayload?.payload?.signature;
    // A credential with no signature is what a forged header looks like: refuse it.
    const valid = typeof sig === "string" && sig.length > 10 && payer !== REFUSED;
    if (req.url === "/verify") return reply(valid ? { isValid: true, payer } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer });
    if (req.url === "/settle") return reply(valid ? { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer } : { success: false, errorReason: "invalid_payload" });
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const common = { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  REDIS_URL: "", SHARED_LIMITS: "off", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", POSTHOG_API_KEY: "", AGENT402_TASK_DATA_DIR: TASKS };
const boot = (port, env, label) => {
  const p = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...ownStoreEnv(label), PORT: String(port), ...common, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.log = [];
  p.stdout.on("data", (d) => p.log.push(String(d)));
  p.stderr.on("data", (d) => p.log.push(String(d)));
  procs.push(p);
  return p;
};
const healthy = async (base, p) => {
  for (let i = 0; i < 200; i++) {
    if (p.exitCode !== null) return false;
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* booting */ }
    await sleep(500);
  }
  return false;
};

// The strix PoC header: base64 JSON naming a wallet, no signature.
const forged = (wallet) => Buffer.from(JSON.stringify({ payload: { authorization: { from: wallet } } })).toString("base64");
const call = async (base, method, path, headers = {}, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
};

try {
  const free = boot(FREE_PORT, { FREE_MODE: "true", X402_SYNC_ON_START: "false" }, "fmi-free");
  const paid = boot(PAID_PORT, { FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", FIRST_CALL_ALLOWANCE: "" }, "fmi-paid");
  const [uf, up] = await Promise.all([healthy(FREE, free), healthy(PAID, paid)]);
  ok(uf && up, `both servers booted (free ${uf}, paid ${up})`);
  if (!uf || !up) throw new Error(`boot failed:\n${free.log.join("").slice(-1500)}\n${paid.log.join("").slice(-1500)}`);

  // The paywall reads the facilitator's supported kinds after listen.
  let gate = 0;
  for (let i = 0; i < 120; i++) { gate = (await call(PAID, "GET", "/api/uuid")).status; if (gate === 402) break; await sleep(250); }
  ok(gate === 402, `the paid server's paywall is up (${gate})`);

  // --- 1. FREE_MODE: the PoC sequence, step by step
  const w = await call(FREE, "POST", "/api/memory", { "X-Payment": forged(VICTIM) }, { key: "victim_secret", value: "VICTIM-PRIVATE-42" });
  ok(w.status === 400 && /FREE_MODE/.test(w.json?.error || ""), `FREE_MODE: a forged victim header cannot write the victim's namespace (${w.status}: ${String(w.json?.error).slice(0, 80)})`);
  const g = await call(FREE, "POST", "/api/memory/grant", { "X-Payment": forged(VICTIM) }, { grantee: ATTACKER, mode: "readwrite" });
  ok(g.status === 400 && /FREE_MODE/.test(g.json?.error || "") && !g.json?.grantee, `FREE_MODE: a forged victim header cannot grant (${g.status})`);
  const rd = await call(FREE, "GET", `/api/memory?key=victim_secret&owner=${VICTIM}`, { "X-Payment": forged(ATTACKER) });
  ok(rd.status === 400 && !/VICTIM-PRIVATE-42/.test(rd.text), `FREE_MODE: a forged attacker header reads nothing (${rd.status})`);
  const ps = await call(FREE, "POST", "/api/memory", { "payment-signature": forged(VICTIM) }, { key: "k", value: "v" });
  ok(ps.status === 400, `FREE_MODE: the payment-signature header carries no identity either (${ps.status})`);
  for (const [path, body] of [["/api/my-usage", {}], ["/api/receipts", {}], ["/api/feedback", { tx: "0x" + "ab".repeat(32), verdict: "good" }], ["/api/attest", { tx: "0x" + "ab".repeat(32) }]]) {
    const r = await call(FREE, "POST", path, { "X-Payment": forged(VICTIM) }, body);
    ok(r.status === 400 && /FREE_MODE/.test(r.json?.error || r.text), `FREE_MODE: ${path} names no wallet from a forged header (${r.status}: ${String(r.json?.error || r.text).slice(0, 70)})`);
  }
  // The documented FREE_MODE identity still works.
  const dw = await call(FREE, "POST", "/api/memory?ns=demo-one", {}, { key: "k", value: "demo-value" });
  const dr = await call(FREE, "GET", "/api/memory?ns=demo-one&key=k");
  ok(dw.status === 200 && dr.status === 200 && dr.json?.value === "demo-value" && /^demo:/.test(dr.json?.owner || ""), `FREE_MODE: the demo namespace (?ns=) writes and reads (${dw.status}/${dr.status}, owner ${dr.json?.owner})`);

  // --- 2. paid: the forged header is refused by the gate; a verified payer keeps its namespace
  const pf = await call(PAID, "POST", "/api/memory", { "X-Payment": forged(VICTIM) }, { key: "victim_secret", value: "x" });
  ok(pf.status === 402, `paid: the forged header is a 402 at the gate (${pf.status}${pf.status === 402 ? "" : ": " + pf.text.slice(0, 200)})`);
  const pg = await call(PAID, "POST", "/api/memory/grant", { "X-Payment": forged(VICTIM) }, { grantee: ATTACKER, mode: "readwrite" });
  ok(pg.status === 402, `paid: a forged grant is a 402 at the gate (${pg.status})`);
  const offerOf = async (method, path, body) => {
    const r = await call(PAID, method, path, {}, body);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    return (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  };
  let n = 0;
  const signed = (accepted, from) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7100 + ++n).toString(16).padStart(64, "0") } },
  })).toString("base64");
  const putOffer = await offerOf("POST", "/api/memory", { key: "victim_secret", value: "VICTIM-PRIVATE-42" });
  ok(!!putOffer, "paid: memory writes offer exact on Base");
  const vw = await call(PAID, "POST", "/api/memory", { "payment-signature": signed(putOffer, VICTIM) }, { key: "victim_secret", value: "VICTIM-PRIVATE-42" });
  ok(vw.status === 200 && vw.json?.owner === VICTIM, `paid: a verified payer writes its own namespace (${vw.status}, owner ${vw.json?.owner})`);
  const getOffer = await offerOf("GET", `/api/memory?key=victim_secret`);
  const vr = await call(PAID, "GET", "/api/memory?key=victim_secret", { "payment-signature": signed(getOffer, VICTIM) });
  ok(vr.status === 200 && vr.json?.value === "VICTIM-PRIVATE-42", `paid: the verified payer reads it back (${vr.status})`);
  const ar = await call(PAID, "GET", `/api/memory?key=victim_secret&owner=${VICTIM}`, { "payment-signature": signed(getOffer, ATTACKER) });
  ok(ar.status !== 200 && !/VICTIM-PRIVATE-42/.test(ar.text), `paid: another verified wallet without a grant is refused (${ar.status})`);

  // --- 3. jobs: one store directory, two modes
  const JOB_PATH = "/api/image-gen-premium";
  const shape = Buffer.from(JSON.stringify({ scheme: "exact", network: "eip155:8453", x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" } })).toString("base64");
  const fj = await call(FREE, "POST", JOB_PATH, { prefer: "respond-async", "X-PAYMENT": shape }, { prompt: "a red fox" });
  const freeJob = fj.headers.get("location") || fj.json?.links?.self || "";
  ok(fj.status === 202 && /^\/api\/jobs\/[0-9a-f]{48}$/.test(freeJob), `the FREE_MODE server makes a job (${fj.status} ${freeJob})`);
  let freeDoc = null;
  for (let i = 0; i < 60; i++) { freeDoc = await call(FREE, "GET", freeJob); if (freeDoc.json?.status !== "working") break; await sleep(250); }
  ok(freeDoc.status === 200 && freeDoc.json?.jobId, `the FREE_MODE server reads its own job (${freeDoc.status} ${freeDoc.json?.status})`);
  const leaked = await call(PAID, "GET", freeJob);
  ok(leaked.status === 404 && !leaked.json?.result, `the paid server answers the FREE_MODE job 404 (${leaked.status} ${leaked.json?.error || leaked.json?.status})`);
  // Control: a paid job in the same directory is served by the paid server.
  const offer = await offerOf("POST", JOB_PATH, { prompt: "a red fox" });
  const pj = await call(PAID, "POST", JOB_PATH, { prefer: "respond-async", "payment-signature": signed(offer, "0x" + "5".repeat(40)) }, { prompt: "a red fox" });
  const paidJob = pj.headers.get("location") || "";
  const pd = paidJob ? await call(PAID, "GET", paidJob) : { status: 0 };
  ok(pj.status === 202 && pd.status === 200 && pd.json?.jobId, `the paid server serves its own job from the same directory (${pj.status} then ${pd.status})`);
} catch (e) {
  ok(false, `run threw: ${e?.message}`);
} finally {
  if (fail) for (const p of procs) console.error(p.log.join("").split("\n").filter((l) => /error|FAIL|warn/i.test(l)).slice(-15).join("\n"));
  cleanup();
}

console.log(`\ntest-free-mode-isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
