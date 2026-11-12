#!/usr/bin/env node
// examples/agentkit-data-to-deploy: the committed contract artifact must belong
// to the committed source (a .sol edited without `npm run compile` would ship
// a stale blob), its constructor must take exactly what agent.js passes, the
// deploy data must encode, and the live workflow must ship the files the
// script reads. Offline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodeDeployData } from "viem";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";

const dir = new URL("../examples/agentkit-data-to-deploy/", import.meta.url);
const read = (p) => readFileSync(new URL(p, dir), "utf8");
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };

const artifact = JSON.parse(read("contracts/artifact.json"));
const source = read("contracts/Agent402PriceSnapshot.sol");
ok(artifact.sourceSha256 === createHash("sha256").update(source).digest("hex"), "artifact.json was compiled from the committed .sol (run `npm run compile` in the example after editing it)");
ok(/^solc 0\.8\.\d+/.test(artifact.compiler), "artifact names its compiler");
ok(/^0x[0-9a-f]{200,}$/i.test(artifact.bytecode), "artifact carries creation bytecode");

const ctor = artifact.abi.find((f) => f.type === "constructor");
const want = ["string", "string", "uint256", "uint64", "string", "bytes32"];
assert.deepEqual(ctor.inputs.map((i) => i.type), want, "constructor takes symbol, currency, priceMicro, observedAt, source, paymentTx - what agent.js encodes");
const snapshot = artifact.abi.find((f) => f.type === "function" && f.name === "snapshot");
ok(snapshot && snapshot.stateMutability === "view" && snapshot.outputs.length === 7, "snapshot() reads all seven fields back");
for (const name of ["buyer", "priceMicro", "observedAt", "paymentTx", "symbol", "currency", "source"]) {
  ok(artifact.abi.some((f) => f.type === "function" && f.name === name), `public getter ${name}`);
}

// The deploy data encodes with the shapes agent.js produces (a price bigint,
// a unix-seconds bigint, a 32-byte tx hash).
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: ["ETH", "usd", 3520450000n, 1750000000n, "agent402.tools GET /api/crypto-price", `0x${"ab".repeat(32)}`] });
ok(data.startsWith(artifact.bytecode), "deploy data = creation code + encoded constructor args");
ok(data.length > artifact.bytecode.length + 6 * 64, "constructor args encoded after the bytecode");

// agent.js: the script pins the same things the test does.
const agent = read("agent.js");
for (const s of ['const SLUG = "crypto-price"', "payees: payees.length ? payees : null", "maxPerCallUsd: 0.02", "blockNumber: deployReceipt.blockNumber", "retrying once in 5 s", "encodeDeployData(", "walletProvider.sendTransaction({ data })", 'functionName: "snapshot"', "receipt.transaction", "process.exit(1)", "DRY_RUN"]) {
  ok(agent.includes(s), `agent.js carries ${JSON.stringify(s)}`);
}
ok(!/AGENT_WALLET_KEY\s*=\s*["']0x[0-9a-f]{64}/i.test(agent), "no key literal in the example");

// The live workflow ships exactly the files the script reads.
const wf = readFileSync(new URL("../.github/workflows/agentkit-data-to-deploy.yml", import.meta.url), "utf8");
for (const s of ["AGENT402_PAYEES=\"0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0\"", "examples/agentkit-data-to-deploy/agent.js", "examples/agentkit-data-to-deploy/contracts/artifact.json", "scripts/agentkit-live/package-lock.json", "npm ci --ignore-scripts", "env -i ", "add-mask", "workflow_dispatch"]) {
  ok(wf.includes(s), `workflow carries ${JSON.stringify(s)}`);
}
ok(!/\bon:\s*\n\s*(push|schedule|pull_request)/.test(wf), "the funded-key workflow is dispatch-only");

// The example's own package pins the versions the pinned proof tree uses.
const pkg = JSON.parse(read("package.json"));
const pinned = JSON.parse(readFileSync(new URL("./agentkit-live/package.json", import.meta.url), "utf8"));
for (const [name, v] of Object.entries(pinned.dependencies)) ok(pkg.dependencies[name] === v, `example pins ${name}@${v} like the proof tree`);

// CI recompiles the artifact from source with the pinned solc and diffs it.
const ci = expandedDeployWorkflow();
ok(ci.includes("node scripts/test-agentkit-data-to-deploy.js"), "this test runs in a CI lane");
ok(ci.includes("solc@0.8.28 && node contracts/compile.js") && ci.includes("git diff --exit-code -- examples/agentkit-data-to-deploy/contracts/artifact.json"), "CI recompiles the artifact from the committed source and requires byte equality");

console.log(`test-agentkit-data-to-deploy: ${n} assertions ok`);
