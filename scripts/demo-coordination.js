// Worked demo: two independent agents (two wallets) coordinating through one
// shared Agent402 memory namespace — the thing a single sandboxed agent cannot
// build for itself. Exercises grants, atomic counters, similarity recall, and
// the tamper-evident audit log end to end.
//
// Run:  node scripts/demo-coordination.js
// Uses the memory module directly (no payments needed) with two fresh wallets.
import { createHash } from "node:crypto";
import {
  memoryPut, memoryGet, memoryIncr,
  grant, listGrants, getLog, remember, recall, EMBEDDER,
} from "../src/tools/memory.js";

const wallet = (seed) => "0x" + createHash("sha256").update(seed + Date.now() + Math.random()).digest("hex").slice(0, 40);
const SCOUT = wallet("scout");   // Agent A: researches, on machine 1, today
const WRITER = wallet("writer"); // Agent B: writes, on machine 2, later

const log = (s) => console.log(s);
const hr = () => log("─".repeat(64));

log(`\n  Agent402 — multi-agent coordination demo  (embedder: ${EMBEDDER})`);
hr();
log(`  SCOUT  (researcher) wallet: ${SCOUT}`);
log(`  WRITER (writer)     wallet: ${WRITER}`);
log(`  The shared workspace is SCOUT's namespace. WRITER is a different wallet`);
log(`  on a different machine — it can only participate once SCOUT grants it.`);
hr();

// 1. WRITER cannot touch SCOUT's namespace yet.
log("\n[1] WRITER tries to read SCOUT's workspace before any grant:");
try {
  memoryGet(SCOUT, "brief", { actor: WRITER });
  log("    ✗ unexpectedly allowed");
} catch (e) {
  log(`    → blocked (${e.statusCode}): ${e.message}`);
}

// 2. SCOUT sets up the shared workspace and does its research.
log("\n[2] SCOUT writes the brief, remembers findings, opens a shared task counter:");
memoryPut(SCOUT, "brief", { title: "State of x402 agent commerce", due: "friday" }, { actor: SCOUT });
await remember(SCOUT, "Coinbase's CDP facilitator indexes paid endpoints into the x402 Bazaar.", { src: "cdp" }, { actor: SCOUT });
await remember(SCOUT, "Agents in locked sandboxes often have no outbound network or browser.", { src: "field" }, { actor: SCOUT });
await remember(SCOUT, "The office espresso machine is broken again.", { src: "noise" }, { actor: SCOUT });
memoryPut(SCOUT, "tasks/total", "3", { actor: SCOUT });
memoryIncr(SCOUT, "tasks/done", 1, SCOUT); // scout finished its own pass
log("    → brief stored, 3 findings remembered, tasks/done = 1");

// 3. SCOUT grants WRITER readwrite access (the cross-agent handoff).
log("\n[3] SCOUT grants WRITER readwrite on the workspace:");
grant(SCOUT, WRITER, "readwrite", 86400);
log(`    → grants now: ${JSON.stringify(listGrants(SCOUT).grants.map((g) => ({ grantee: g.grantee.slice(0, 10) + "…", mode: g.mode })))}`);

// 4. WRITER — a different wallet, "later" — picks up the work through the grant.
log(`\n[4] WRITER reads the brief and recalls the relevant findings by similarity`);
log(`    (${EMBEDDER} embedder — lexical by default; set EMBEDDINGS_URL for true semantic):`);
const brief = memoryGet(SCOUT, "brief", { actor: WRITER });
log(`    → brief: "${brief.value.title}" (due ${brief.value.due})`);
const hits = await recall(SCOUT, "agents with no browser or outbound network in their sandbox", 2, { actor: WRITER });
for (const h of hits.results) log(`    → recalled (score ${h.score}): ${h.text}`);

// 5. WRITER does its unit of work and atomically advances the shared counter.
log("\n[5] WRITER writes its draft and atomically increments the shared counter:");
memoryPut(SCOUT, "draft", { by: WRITER, body: "Agents rent capability and continuity they can't self-host." }, { actor: WRITER });
const done = memoryIncr(SCOUT, "tasks/done", 1, WRITER);
log(`    → draft saved by WRITER; tasks/done is now ${done.value} of ${memoryGet(SCOUT, "tasks/total", { actor: SCOUT }).value} (atomic across both agents)`);

// 6. SCOUT audits the namespace — verifiable provenance of who did what.
log("\n[6] SCOUT reads the tamper-evident audit log (hash-chained):");
const audit = getLog(SCOUT, SCOUT, 100);
let prev = "";
let chainOk = true;
for (const e of audit.entries) {
  const h = createHash("sha256")
    .update(`${e.prevHash}|${e.seq}|${e.ts}|${e.actor}|${e.action}|${e.key ?? ""}|${e.data === null ? "" : JSON.stringify(e.data)}`)
    .digest("hex");
  if (e.prevHash !== prev || h !== e.hash) chainOk = false;
  prev = e.hash;
  const who = e.actor === SCOUT ? "SCOUT " : e.actor === WRITER ? "WRITER" : e.actor.slice(0, 8);
  log(`    #${String(e.seq).padStart(2)} ${who}  ${e.action.padEnd(9)} ${e.key ?? ""}`);
}
hr();
log(`  Audit hash-chain verifies: ${chainOk ? "✓ yes — provenance is tamper-evident" : "✗ FAILED"}`);
log("  Two wallets, one namespace, no signup: shared state, an atomic handoff,");
log("  semantic recall, and a verifiable record of who did what. None of this is");
log("  something a single ephemeral agent can provide for itself.\n");

process.exit(chainOk ? 0 : 1);
