// Unit tests for Memory v2 (coordination + provenance + recall).
// Exercises the module directly with two simulated wallets — no HTTP, no payments.
import { createHash } from "node:crypto";
import {
  memoryPut, memoryGet, memoryDelete, memoryIncr,
  grant, revoke, listGrants, getLog, remember, recall, forget,
} from "../src/tools/memory.js";

const rnd = () => "0x" + createHash("sha256").update(Math.random() + "" + Date.now()).digest("hex").slice(0, 40);
const A = rnd();
const B = rnd();

let pass = 0;
const checks = [];
function ok(name, cond) {
  checks.push([name, !!cond]);
  if (cond) pass++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
}
function throws(name, fn, codeWanted) {
  try {
    fn();
    ok(name + " (should throw)", false);
  } catch (e) {
    ok(`${name} -> ${e.statusCode || "?"} ${e.message.slice(0, 50)}`, codeWanted ? e.statusCode === codeWanted : true);
  }
}

// --- own-namespace KV + TTL ---
const w = memoryPut(A, "task/1", { status: "done" }, { actor: A });
ok("put returns owner", w.owner === A);
ok("get round-trips", JSON.stringify(memoryGet(A, "task/1", { actor: A }).value) === JSON.stringify({ status: "done" }));
const wt = memoryPut(A, "ephemeral", "x", { actor: A, ttlSeconds: 3600 });
ok("ttl sets expiresAt ~now+3600", Math.abs(wt.expiresAt - (Math.floor(Date.now() / 1000) + 3600)) <= 2);
ok("delete works", memoryDelete(A, "task/1", { actor: A }).deleted === true);
throws("get missing key", () => memoryGet(A, "task/1", { actor: A }), 404);

// --- atomic counter ---
ok("incr creates at by", memoryIncr(A, "ctr", 5, A).value === 5);
ok("incr adds", memoryIncr(A, "ctr", 3, A).value === 8);
ok("incr default +1", memoryIncr(A, "ctr", undefined, A).value === 9);
ok("incr negative", memoryIncr(A, "ctr", -4, A).value === 5);
memoryPut(A, "word", "hello", { actor: A });
throws("incr on non-numeric", () => memoryIncr(A, "word", 1, A), 400);

// --- isolation: B cannot touch A without a grant ---
throws("B read A (no grant)", () => memoryGet(A, "ctr", { actor: B }), 403);
throws("B write A (no grant)", () => memoryPut(A, "x", 1, { actor: B }), 403);

// --- grants: read then readwrite then revoke ---
grant(A, B, "read");
ok("B can read A after read-grant", memoryGet(A, "ctr", { actor: B }).value === 5);
throws("B still cannot write with read-grant", () => memoryPut(A, "x", 1, { actor: B }), 403);
grant(A, B, "readwrite");
ok("B can write A after readwrite-grant", memoryPut(A, "fromB", { by: "B" }, { actor: B }).owner === A);
ok("A sees B's write", JSON.stringify(memoryGet(A, "fromB", { actor: A }).value) === JSON.stringify({ by: "B" }));
ok("listGrants shows B", listGrants(A).grants.some((g) => g.grantee === B.toLowerCase() && g.mode === "readwrite"));
ok("incr shared by B", memoryIncr(A, "shared-ctr", 1, B).value === 1 && memoryIncr(A, "shared-ctr", 1, A).value === 2);
revoke(A, B);
throws("B blocked after revoke", () => memoryGet(A, "ctr", { actor: B }), 403);

// --- tamper-evident audit chain ---
const log = getLog(A, A, 1000);
ok("log has entries", log.entries.length > 0);
let okChain = true;
let prev = "";
for (const e of log.entries) {
  if (e.prevHash !== prev) okChain = false;
  const h = createHash("sha256")
    .update(`${e.prevHash}|${e.seq}|${e.ts}|${e.actor}|${e.action}|${e.key ?? ""}|${e.data === null ? "" : JSON.stringify(e.data)}`)
    .digest("hex");
  if (h !== e.hash) okChain = false;
  prev = e.hash;
}
ok("audit hash-chain verifies end-to-end", okChain);
ok("log records the grant action", log.entries.some((e) => e.action === "grant" && e.key === B.toLowerCase()));

// --- similarity recall ---
await remember(A, "The Railway deploy failed because the build ran out of memory.", { topic: "ops" }, { actor: A });
await remember(A, "Our favorite pizza topping is pineapple and jalapeno.", { topic: "food" }, { actor: A });
await remember(A, "Kubernetes pods were OOMKilled during the rollout.", { topic: "ops" }, { actor: A });
const r = await recall(A, "why did the deployment crash from low memory", 2, { actor: A });
ok("recall returns results", r.results.length > 0);
ok("recall ranks the ops docs above pizza", r.results[0].text.toLowerCase().includes("memory") || r.results[0].text.toLowerCase().includes("oomkilled"));
ok("recall not topped by unrelated food doc", !r.results[0].text.toLowerCase().includes("pizza"));
const firstId = r.results[0].id;
ok("forget deletes a doc", forget(A, firstId, { actor: A }).deleted === true);
ok("recall reports its embedder", typeof r.embedder === "string" && r.embedder.length > 0);

const failed = checks.filter(([, c]) => !c);
console.log(`\n${pass}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map(([n]) => n).join("; "));
  process.exit(1);
}
console.log("Memory v2 unit tests: ALL PASSED");
