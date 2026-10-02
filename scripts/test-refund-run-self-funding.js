// A route-execute debt must be repayable by the refund job that ships.
//
//   node scripts/test-refund-run-self-funding.js      (offline, stub servers)
//
// The router tiers settle to OUR SPENDING WALLETS rather than the treasury
// (SELF_FUNDING_SLUGS / AVM_SELF_FUNDING_SLUGS in src/payments.js), and the
// refund job proves every inbound payment on chain before it repays one: the
// same payer, to a wallet we control, for at least the amount. It learns which
// wallets are ours from two places: the live 402 (the treasury payTo) and the
// public spending-wallet addresses in its environment (ourPayToSet in
// scripts/refund-run.js). So the workflow that runs the job has to hand it
// those addresses, or a route-execute debt paid to the spending wallet can
// never be proven and is held on every run.
//
// This drives the REAL scripts/refund-run.js as a child process, with the
// environment the "Run refunds" step of .github/workflows/refund.yml declares
// (its `vars.*` entries resolved from a fixture of repository variables),
// against stub servers for the operator ledger, our own 402, a Base RPC and an
// Algorand indexer. Nothing leaves this machine and no money can move: the
// stub refuses every claim, so the job stops after verification, and the
// dummy keys are not valid keys.
//
// Controls, so the fix is shown not to widen anything:
//   - a treasury-paid debt verifies with or without the spending addresses;
//   - a route-execute debt whose payment went to a stranger stays unverified;
//   - the addresses come from repository VARIABLES, never from secrets.
//
// A disconnect (http 499) on a route whose effect outlives the answer - the
// router tiers among them - is held for review before verification, on the
// dry run and the live run alike, and only the workflow's
// include_lasting_hangups input releases it. A disconnect on an ordinary
// route and a failed answer on a router tier are repaid as before.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { LASTING_HANGUP_HOLD, REPEAT_HANGUP_HOLD } from "./refund-run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- fixture identities (synthetic, not real wallets) ----
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_EVM = "0x1111111111111111111111111111111111111111";
const SPEND_EVM = "0x5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E";   // mixed case on purpose: EVM folds
const STRANGER_EVM = "0x9999999999999999999999999999999999999999";
const BUYER_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const BUYER_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const BUYER_C = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const BUYER_D = "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd";
const BUYER_E = "0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe";
const BUYER_F = "0xF0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0";
const ALGO_NET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TREASURY_ALGO = "TREASURYALGOTREASURYALGOTREASURYALGOTREASURYALGOTREASURYA";
const SPEND_ALGO = "SPENDALGOSPENDALGOSPENDALGOSPENDALGOSPENDALGOSPENDALGOSPE"; // case preserved on this rail
const BUYER_ALGO = "BUYERALGOBUYERALGOBUYERALGOBUYERALGOBUYERALGOBUYERALGOBUY";
const REPO_VARIABLES = {
  X402_UPSTREAM_BUYER_ADDRESS: SPEND_EVM,
  ALGORAND_UPSTREAM_BUYER_ADDRESS: SPEND_ALGO,
};

const hex64 = (c) => `0x${c.repeat(64)}`;
const TX = { reBase: hex64("a"), hash: hex64("b"), stranger: hex64("c"), reHangup: hex64("d"), hashHangup: hex64("e"), repeatHangup: hex64("f") };
const ALGO_TXID = "REALGOTXIDREALGOTXIDREALGOTXIDREALGOTXIDREALGOTXIDREALG";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const amt = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const receipts = {
  [TX.reBase]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_A), topic(SPEND_EVM)], data: amt(10_000) }] },
  [TX.hash]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_B), topic(TREASURY_EVM)], data: amt(1_000) }] },
  [TX.stranger]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_C), topic(STRANGER_EVM)], data: amt(10_000) }] },
  [TX.reHangup]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_D), topic(SPEND_EVM)], data: amt(50_000) }] },
  [TX.hashHangup]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_E), topic(TREASURY_EVM)], data: amt(1_000) }] },
  [TX.repeatHangup]: { status: "0x1", logs: [{ address: USDC_BASE, topics: [TRANSFER, topic(BUYER_F), topic(TREASURY_EVM)], data: amt(1_000) }] },
};

const ROWS = [
  { id: 1, slug: "route-execute", network: "eip155:8453", payer: BUYER_A, priceUsd: 0.01, evidence: TX.reBase, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 500 },
  { id: 2, slug: "route-execute", network: ALGO_NET, payer: BUYER_ALGO, priceUsd: 0.01, evidence: ALGO_TXID, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000 },
  { id: 3, slug: "hash", network: "eip155:8453", payer: BUYER_B, priceUsd: 0.001, evidence: TX.hash, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 502 },
  { id: 4, slug: "route-execute", network: "eip155:8453", payer: BUYER_C, priceUsd: 0.01, evidence: TX.stranger, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000 },
  // A disconnect on a router tier, paid to the spending wallet: held for review.
  { id: 5, slug: "route-execute-plus", network: "eip155:8453", payer: BUYER_D, priceUsd: 0.05, evidence: TX.reHangup, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 499 },
  // A disconnect on an ordinary route, paid to the treasury: repaid as before.
  { id: 6, slug: "hash", network: "eip155:8453", payer: BUYER_E, priceUsd: 0.001, evidence: TX.hashHangup, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 499, hangupReason: "settled in flight" },
  // A disconnect booked because the wallet's forgiveness budget was spent (a
  // repeat hang-up): held for review, released only by its own input.
  { id: 7, slug: "hash", network: "eip155:8453", payer: BUYER_F, priceUsd: 0.001, evidence: TX.repeatHangup, status: "owed", synthetic: 0, createdAt: Date.now() - 60_000, httpStatus: 499, hangupReason: "payer budget" },
];

// ---- one stub server: operator ledger, our 402, Base RPC, Algorand indexer ----
const seen = { claims: 0, claimIds: new Set(), updatesOtherThanClaim: 0, rpcMethods: [], sendRaw: 0 };
const accepts = [
  { scheme: "exact", network: "eip155:8453", payTo: TREASURY_EVM, asset: USDC_BASE, amount: "1000" },
  { scheme: "exact", network: ALGO_NET, payTo: TREASURY_ALGO, asset: "31566704", amount: "1000" },
];
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  const body = await readBody(req);
  const json = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/__operator/refunds.json") {
    if (req.headers.authorization !== "Bearer test-operator-token") return json(401, {});
    return json(200, { refunds: ROWS, totals: { owed: { n: ROWS.length } } });
  }
  if (url.pathname === "/__operator/refunds/update") {
    const upd = (() => { try { return JSON.parse(body); } catch { return {}; } })();
    if (upd.action === "claim") { seen.claims++; seen.claimIds.add(upd.id); } else seen.updatesOtherThanClaim++;
    return json(409, { ok: false });   // never let a send begin
  }
  if (url.pathname === "/api/hash" || url.pathname === "/api/solidity-scan") {
    const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
    return json(402, {}, { "payment-required": hdr });
  }
  if (url.pathname === "/rpc") {
    const { method, params, id } = JSON.parse(body || "{}");
    seen.rpcMethods.push(method);
    if (method === "eth_getTransactionReceipt") return json(200, { jsonrpc: "2.0", id, result: receipts[params[0]] || null });
    if (method === "eth_call") return json(200, { jsonrpc: "2.0", id, result: amt(6) });
    if (method === "eth_sendRawTransaction") seen.sendRaw++;
    return json(200, { jsonrpc: "2.0", id, error: { message: "not in stub" } });
  }
  if (url.pathname.startsWith("/idx/v2/transactions/")) {
    const txid = decodeURIComponent(url.pathname.split("/").pop());
    if (txid !== ALGO_TXID) return json(404, {});
    return json(200, { transaction: {
      id: ALGO_TXID, sender: BUYER_ALGO, "confirmed-round": 1,
      "asset-transfer-transaction": { "asset-id": 31566704, receiver: SPEND_ALGO, amount: 10_000 },
    } });
  }
  return json(404, {});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- the environment the workflow's "Run refunds" step declares ----
const wf = load(readFileSync(join(root, ".github/workflows/refund.yml"), "utf8"));
const steps = Object.values(wf.jobs || {}).flatMap((j) => j.steps || []);
const runStep = steps.find((s) => s.name === "Run refunds");
ok(!!runStep && /node scripts\/refund-run\.js/.test(runStep.run || ""), "refund.yml has the step that runs scripts/refund-run.js");
const stepEnv = runStep?.env || {};
const fromVars = {};
for (const [k, v] of Object.entries(stepEnv)) {
  const m = /^\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}$/.exec(String(v).trim());
  if (m) fromVars[k] = REPO_VARIABLES[m[1]] ?? "";
}
// The whole step environment for a dispatch with these inputs: repository
// variables resolved from the fixture, inputs from the dispatch or the
// workflow's own declared defaults. Secrets are left to runJob's dummies.
const declaredInputs = (wf.on || wf[true] || {}).workflow_dispatch?.inputs || {};
function stepEnvFor(inputs = {}) {
  const val = (name) => (Object.hasOwn(inputs, name) ? inputs[name] : declaredInputs[name]?.default);
  const out = {};
  for (const [k, v] of Object.entries(stepEnv)) {
    const t = String(v).trim();
    let m;
    if ((m = /^\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}$/.exec(t))) out[k] = REPO_VARIABLES[m[1]] ?? "";
    else if ((m = /^\$\{\{\s*inputs\.([a-z0-9_]+)\s*&&\s*'true'\s*\|\|\s*'false'\s*\}\}$/.exec(t))) out[k] = val(m[1]) === true ? "true" : "false";
    else if ((m = /^\$\{\{\s*inputs\.([a-z0-9_]+)\s*\}\}$/.exec(t))) out[k] = String(val(m[1]) ?? "");
  }
  return out;
}
const lastingInput = declaredInputs.include_lasting_hangups;
ok(lastingInput?.type === "boolean" && lastingInput?.default === false,
  "refund.yml declares include_lasting_hangups as a boolean that defaults to false");
ok(stepEnvFor({ include_lasting_hangups: true }).REFUND_INCLUDE_LASTING_HANGUPS === "true"
   && stepEnvFor({}).REFUND_INCLUDE_LASTING_HANGUPS === "false",
  "the step passes that input to the job as REFUND_INCLUDE_LASTING_HANGUPS");
const repeatInput = declaredInputs.include_repeat_hangups;
ok(repeatInput?.type === "boolean" && repeatInput?.default === false,
  "refund.yml declares include_repeat_hangups as a boolean that defaults to false");
ok(stepEnvFor({ include_repeat_hangups: true }).REFUND_INCLUDE_REPEAT_HANGUPS === "true"
   && stepEnvFor({}).REFUND_INCLUDE_REPEAT_HANGUPS === "false",
  "the step passes that input to the job as REFUND_INCLUDE_REPEAT_HANGUPS");

// The spending wallets the server settles to, as payments.js reads them; the
// ones the refund job knows how to use, as refund-run.js reads them; and what
// the workflow passes. All three must be the same set, so a spending wallet
// added to one place cannot leave the other two behind.
const payments = readFileSync(join(root, "src/payments.js"), "utf8");
const refundRun = readFileSync(join(root, "scripts/refund-run.js"), "utf8");
const settledTo = new Set([...payments.matchAll(/process\.env\.([A-Z0-9_]*UPSTREAM_BUYER_ADDRESS)\b/g)].map((m) => m[1]));
const jobReads = new Set([...refundRun.matchAll(/\["([A-Z0-9_]*UPSTREAM_BUYER_ADDRESS)"/g)].map((m) => m[1]));
const passed = new Set(Object.keys(stepEnv).filter((k) => /UPSTREAM_BUYER_ADDRESS$/.test(k)));
ok(settledTo.size >= 2, `payments.js settles the router tiers to ${settledTo.size} spending wallet(s) read from the environment`);
ok([...settledTo].every((k) => jobReads.has(k)), `the refund job counts every one of them as ours (${[...settledTo].join(", ")})`);
ok([...settledTo].every((k) => passed.has(k)), `refund.yml passes every one of them to the job (passed: ${[...passed].join(", ") || "none"})`);
ok([...passed].every((k) => /^\$\{\{\s*vars\.[A-Z0-9_]+\s*\}\}$/.test(String(stepEnv[k]).trim())),
  "each is a public repository variable, never a secret");
ok(![...passed].some((k) => /KEY|MNEMONIC|SECRET/.test(k)), "and none of them is a key");

// ---- drive the real job ----
function runJob(extraEnv) {
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH,
      TARGET_URL: base,
      AGENT402_OPERATOR_TOKEN: "test-operator-token",
      REFUND_LIVE: "true",
      REFUND_RPC_8453: `${base}/rpc`,
      REFUND_ALGORAND_INDEXERS: `${base}/idx`,
      // Present so the planner has a sender for each family; neither is a
      // valid key, and the stub refuses every claim before a send could start.
      REFUND_EVM_KEY: "not-a-key",
      REFUND_ALGORAND_MNEMONIC: "not a mnemonic",
      ...extraEnv,
    };
    const child = spawn(process.execPath, [join(root, "scripts/refund-run.js")], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
const confirmed = (out, id) => new RegExp(`#${id} inbound payment confirmed on-chain`).test(out);
// The row ids a plan printed under one HELD bucket.
function heldIds(out, reason) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`HELD (${reason}): `));
  if (at < 0) return [];
  const ids = [];
  for (const l of lines.slice(at + 1)) { const m = /^\s+#(\d+) /.exec(l); if (!m) break; ids.push(Number(m[1])); }
  return ids;
}
async function runWithClaims(env) {
  seen.claimIds = new Set();
  const r = await runJob(env);
  return { ...r, claimed: new Set(seen.claimIds) };
}
const unverified = (out, id) => new RegExp(`HOLD\\s+#${id} .*UNVERIFIED`).test(out);

// Control first: with no spending addresses the job must still reach its
// verifier and prove the treasury row, or a later "confirmed" proves nothing.
const bare = await runJob({});
ok(confirmed(bare.out, 3), "control: a treasury-paid debt verifies with no spending addresses configured");
ok(unverified(bare.out, 1) && unverified(bare.out, 2),
  "control: without the spending addresses a route-execute debt cannot be proven, on Base or Algorand");

const shipped = await runWithClaims(stepEnvFor({ live: true }));
ok(confirmed(shipped.out, 1), "with refund.yml's environment, a route-execute debt paid to the Base spending wallet verifies");
ok(confirmed(shipped.out, 2), "...and one paid to the Algorand spending wallet verifies (address case preserved)");
ok(confirmed(shipped.out, 3), "the treasury-paid debt still verifies (honest path unchanged)");
ok(unverified(shipped.out, 4) && !confirmed(shipped.out, 4),
  "a route-execute debt paid to a stranger is still held: the set grew by our own wallets only");

// A disconnect on a router tier is held for review before verification, on
// the dry run a reviewer reads and on the live run alike; a disconnect on an
// ordinary route is repaid as before.
const dry = await runWithClaims(stepEnvFor({}));
ok(/DRY RUN/.test(dry.out) && heldIds(dry.out, LASTING_HANGUP_HOLD).join(",") === "5",
  `the dry run lists the router-tier disconnect in its own held bucket (${heldIds(dry.out, LASTING_HANGUP_HOLD)})`);
ok(heldIds(shipped.out, LASTING_HANGUP_HOLD).join(",") === "5" && !confirmed(shipped.out, 5) && !unverified(shipped.out, 5) && !shipped.claimed.has(5),
  "on a live run with the default inputs it is never verified or claimed");
ok(confirmed(shipped.out, 6) && shipped.claimed.has(6),
  "control: a disconnect on an ordinary route verifies and is claimed for repayment, as before");
ok(shipped.claimed.has(1) && shipped.claimed.has(3),
  "control: a failed answer on a router tier and a treasury-paid debt are claimed for repayment, as before");
ok(heldIds(dry.out, REPEAT_HANGUP_HOLD).join(",") === "7" && heldIds(shipped.out, REPEAT_HANGUP_HOLD).join(",") === "7"
   && !confirmed(shipped.out, 7) && !shipped.claimed.has(7),
  `a disconnect booked past the forgiveness budget is held in its own bucket and never claimed by default (${heldIds(shipped.out, REPEAT_HANGUP_HOLD)})`);
ok(/#7 eip155:8453 \$0\.001 -> payer:[0-9a-f]{8} \(hash, http 499, payer budget\)/.test(shipped.out),
  "the plan names why that disconnect was not forgiven");
const repeatIn = await runWithClaims(stepEnvFor({ live: true, include_repeat_hangups: true }));
ok(!heldIds(repeatIn.out, REPEAT_HANGUP_HOLD).length && confirmed(repeatIn.out, 7) && repeatIn.claimed.has(7)
   && heldIds(repeatIn.out, LASTING_HANGUP_HOLD).join(",") === "5",
  "with include_repeat_hangups set it verifies and is claimed, and the lasting-effect hold is untouched");
const optIn = await runWithClaims(stepEnvFor({ live: true, include_lasting_hangups: true }));
ok(!heldIds(optIn.out, LASTING_HANGUP_HOLD).length && confirmed(optIn.out, 5) && optIn.claimed.has(5),
  "with include_lasting_hangups set, the reviewed disconnect verifies and is claimed for repayment");
ok(confirmed(optIn.out, 6) && optIn.claimed.has(1) && optIn.claimed.has(3) && optIn.claimed.has(6),
  "...and the other debts are claimed exactly as without it");

// A route-execute row can now pass verification, so the plan a reviewer reads
// before approving a live run names the status each debt was recorded on: a
// 499 is a buyer who disconnected, not an answer that failed.
ok(/#5 eip155:8453 \$0\.05 -> payer:[0-9a-f]{8} \(route-execute-plus, http 499\)/.test(shipped.out)
   && /#1 eip155:8453 \$0\.01 -> payer:[0-9a-f]{8} \(route-execute, http 500\)/.test(shipped.out)
   && /#3 eip155:8453 \$0\.001 -> payer:[0-9a-f]{8} \(hash, http 502\)/.test(shipped.out)
   && /#2 \S+ \$0\.01 -> payer:[0-9a-f]{8} \(route-execute\)/.test(shipped.out),
   "the plan names each row's recorded status, and a row with none prints as before");

ok(seen.claims > 0 && seen.updatesOtherThanClaim === 0 && seen.sendRaw === 0,
  `nothing was sent: the job stopped at the refused claim (claims ${seen.claims}, other updates ${seen.updatesOtherThanClaim}, raw sends ${seen.sendRaw})`);
if (fail) { console.error("--- job output (shipped env) ---\n" + shipped.out.slice(0, 4000)); }

server.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
