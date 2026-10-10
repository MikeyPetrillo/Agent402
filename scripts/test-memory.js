// Unit tests for Memory v2 (coordination + provenance + recall).
// Exercises the module directly with two simulated wallets — no HTTP, no payments.
import { createHash } from "node:crypto";
import {
  memoryPut, memoryGet, memoryDelete, memoryIncr, memoryCas,
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
// --- M9: retry-safe writes with a client request id ---
ok("incr with a requestId applies", memoryIncr(A, "ridc", 1, A, { requestId: "r-1" }).value === 1);
{ const again = memoryIncr(A, "ridc", 1, A, { requestId: "r-1" }); ok("a retry with the same requestId replays and counts once", again.value === 1 && again.replayed === true && memoryGet(A, "ridc", { actor: A }).value === 1); }
throws("the same requestId for a different write is refused", () => memoryIncr(A, "ridc", 2, A, { requestId: "r-1" }), 409);
ok("without a requestId every call counts", memoryIncr(A, "ridc", 1, A).value === 2);
ok("a retried delete replays", memoryDelete(A, "ridc", { actor: A, requestId: "d-1" }).deleted === true && memoryDelete(A, "ridc", { actor: A, requestId: "d-1" }).deleted === true);

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

// --- compare-and-set: locks + optimistic concurrency ---
let c = memoryCas(A, "locks/job", null, "agent-7", { actor: A, ttlSeconds: 30, hasValue: true });
ok("cas acquires absent key (lock)", c.swapped === true && c.value === "agent-7");
ok("cas sets ttl lease ~now+30", Math.abs(c.expiresAt - (Math.floor(Date.now() / 1000) + 30)) <= 2);
c = memoryCas(A, "locks/job", null, "agent-9", { actor: A, hasValue: true });
ok("cas contended acquire fails, returns holder", c.swapped === false && c.value === "agent-7");
c = memoryCas(A, "locks/job", "wrong-token", undefined, { actor: A, hasValue: false });
ok("cas release with wrong token fails", c.swapped === false);
c = memoryCas(A, "locks/job", "agent-7", undefined, { actor: A, hasValue: false });
ok("cas release with right token deletes", c.swapped === true && c.value === null);
throws("released lock key is gone", () => memoryGet(A, "locks/job", { actor: A }), 404);
memoryPut(A, "doc", { v: 1 }, { actor: A });
c = memoryCas(A, "doc", { v: 1 }, { v: 2 }, { actor: A, hasValue: true });
ok("cas optimistic update on match", c.swapped === true && JSON.stringify(memoryGet(A, "doc", { actor: A }).value) === JSON.stringify({ v: 2 }));
c = memoryCas(A, "doc", { v: 1 }, { v: 3 }, { actor: A, hasValue: true });
ok("cas update on stale expected fails", c.swapped === false && JSON.stringify(c.value) === JSON.stringify({ v: 2 }));
throws("B cas without grant blocked", () => memoryCas(A, "doc", { v: 2 }, { v: 9 }, { actor: B, hasValue: true }), 403);

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

// --- namespace byte budget (disk-fill guard) --------------------------------
// The key-count cap alone allows 10k × 64KB = 640MB per wallet on the shared
// /data volume. The byte budget bounds total stored value bytes; env-tunable
// (read at call time), so shrink it here to test without megabytes of writes.
{
  const C = rnd();
  process.env.MEMORY_MAX_NS_BYTES = "150000"; // 150KB budget for the test
  const big = "x".repeat(60_000);
  memoryPut(C, "b1", big);
  memoryPut(C, "b2", big);
  throws("third 60KB value busts the 150KB byte budget", () => memoryPut(C, "b3", big), 413);
  memoryPut(C, "b1", big); // same-size overwrite never counts as growth
  ok("same-size overwrite allowed at the budget line", true);
  memoryPut(C, "b1", "tiny"); // shrinking frees budget…
  memoryPut(C, "b3", big); // …so the third big value now fits
  ok("shrinking a value frees budget for new writes", true);
  throws("cas write path enforces the budget too", () => memoryCas(C, "b4", null, big, { hasValue: true }), 413);
  // Expired rows are reclaimed before rejecting.
  const D = rnd();
  memoryPut(D, "t1", big, { ttlSeconds: 1 });
  memoryPut(D, "t2", big);
  // Expiry is strict (exp < now) at whole-second resolution: a row written at
  // t.9 with ttl 1 stays valid through second t+1, so waiting just past 1s
  // races the boundary (flaked in CI). 2.2s clears it in every alignment.
  const t0 = Date.now();
  while (Date.now() - t0 < 2200) { /* let t1 expire (sync test file) */ }
  memoryPut(D, "t3", big); // t1 expired → reclaim makes room
  ok("expired rows are reclaimed before a budget rejection", true);
  delete process.env.MEMORY_MAX_NS_BYTES;
}

// --- D4 audit: payer attribution cannot be spoofed --------------------------
// payerFromRequest must read ONLY the signed payload.payload.authorization.from
// (the field the EIP-3009 signature covers) and be EVM-only — anything else
// would mint a signature-free memory namespace.
import { payerFromRequest, normalizePayerAddress } from "../src/payer.js";
const mkReq = (obj) => ({ header: (h) => h.toLowerCase() === "x-payment"
  ? Buffer.from(JSON.stringify(obj)).toString("base64") : undefined });
// top-level unsigned `from` must NOT be honored (only authorization.from)
if (payerFromRequest(mkReq({ from: "0x" + "a".repeat(40) })) !== null)
  { console.error("FAIL - honored unsigned top-level from"); process.exit(1); }
// a valid signed EVM from IS honored, lowercased
const evm = "0x" + "A".repeat(40);
if (payerFromRequest(mkReq({ payload: { authorization: { from: evm } } })) !== evm.toLowerCase())
  { console.error("FAIL - did not attribute signed EVM from"); process.exit(1); }
// non-EVM authorization.from → null (no signature-free namespace via this path)
if (payerFromRequest(mkReq({ payload: { authorization: { from: "GABC" + "A".repeat(52) } } })) !== null)
  { console.error("FAIL - minted a non-EVM namespace"); process.exit(1); }
// permit.owner is an UNSIGNED fallback field — must NOT be honored (only the
// EIP-3009-signed authorization.from can carry memory identity)
if (payerFromRequest(mkReq({ permit: { owner: evm } })) !== null)
  { console.error("FAIL - honored unsigned permit.owner"); process.exit(1); }
// Algorand/Stellar never lowercased by normalizePayerAddress
const algo = "A".repeat(58);
if (normalizePayerAddress(algo) !== algo) { console.error("FAIL - lowercased Algorand"); process.exit(1); }
console.log("ok - payer attribution cannot be spoofed");

// Adjacent attribution invariants, in the file's native check style.
ok("missing payment header -> null identity", payerFromRequest({ header: () => undefined }) === null);
ok("garbage (non-base64-JSON) header -> null", payerFromRequest({ header: () => "!!not-base64-json!!" }) === null);
const stellar = "G" + "B".repeat(55);
ok("Stellar address never lowercased", normalizePayerAddress(stellar) === stellar);
const sol = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
ok("Solana base58 case preserved", normalizePayerAddress(sol) === sol);
ok("EVM normalized to lowercase", normalizePayerAddress("0x" + "AB".repeat(20)) === "0x" + "ab".repeat(20));

// --- D4 audit: memory scoping via payer-derived namespaces ------------------
// Derive both identities exactly the way the server does (payerFromRequest on
// a signed x402 header) and prove reads/writes stay inside the payer namespace.
{
  const signed = (from) => mkReq({ payload: { authorization: { from } } });
  const payerA = payerFromRequest(signed("0x" + "1a".repeat(20)));
  const payerB = payerFromRequest(signed("0x" + "2b".repeat(20)));
  ok("payerFromRequest derives two distinct identities", !!payerA && !!payerB && payerA !== payerB);
  memoryPut(payerA, "secret", { pin: 1234 }, { actor: payerA });
  throws("payer B cannot read payer A's key", () => memoryGet(payerA, "secret", { actor: payerB }), 403);
  throws("payer B cannot list payer A's keys", () => memoryGet(payerA, undefined, { actor: payerB }), 403);
  throws("payer B cannot write into payer A's namespace", () => memoryPut(payerA, "planted", "x", { actor: payerB }), 403);
  throws("payer B cannot read payer A's audit log", () => getLog(payerA, payerB, 10), 403);
  let recallDenied = false;
  try { await recall(payerA, "secret", 5, { actor: payerB }); } catch (e) { recallDenied = e.statusCode === 403; }
  ok("payer B recall against A's namespace -> 403", recallDenied);
  // A checksummed casing of A's address is the SAME namespace, not a fresh one.
  const payerAChecksum = payerFromRequest(signed("0x" + "1A".repeat(20)));
  ok("checksum-cased EVM header maps to the same namespace", payerAChecksum === payerA);
  ok("owner still reads its own key", memoryGet(payerA, "secret", { actor: payerA }).value.pin === 1234);
  memoryDelete(payerA, "secret", { actor: payerA });
}

// --- D4 audit: both quotas answer 413 when the store is full ----------------
{
  const E = rnd();
  process.env.MEMORY_MAX_NS_BYTES = "1000";
  memoryPut(E, "q1", "y".repeat(900));
  throws("byte budget full -> 413", () => memoryPut(E, "q2", "y".repeat(200)), 413);
  delete process.env.MEMORY_MAX_NS_BYTES;
  const F = rnd();
  process.env.MEMORY_MAX_NS_KEYS = "3";
  memoryPut(F, "k1", 1);
  memoryPut(F, "k2", 1);
  memoryPut(F, "k3", 1);
  throws("key-count quota full -> 413", () => memoryPut(F, "k4", 1), 413);
  memoryPut(F, "k1", 2); // overwriting an existing key never counts against the cap
  ok("overwrite allowed at the key cap", true);
  throws("incr creating a key at the cap -> 413", () => memoryIncr(F, "k5", 1, F), 413);
  throws("cas creating a key at the cap -> 413", () => memoryCas(F, "k6", null, "v", { hasValue: true }), 413);
  delete process.env.MEMORY_MAX_NS_KEYS;
}

// --- text the state database cannot hold is refused in both backends ---
{
  const N = rnd();
  memoryPut(N, "nul", { keep: 1 });
  throws("object value holding U+0000 -> 400", () => memoryPut(N, "nul", { note: "a\u0000b" }), 400);
  throws("string value holding U+0000 -> 400", () => memoryPut(N, "nul", "a\u0000b"), 400);
  throws("value holding an unpaired surrogate -> 400", () => memoryPut(N, "nul", { s: "\udc00" }), 400);
  throws("cas to a value holding U+0000 -> 400", () => memoryCas(N, "nul", { keep: 1 }, ["\u0000"], { hasValue: true }), 400);
  throws("incr on a key holding U+0000 -> 400", () => memoryIncr(N, "n\u0000", 1, N), 400);
  ok("a refused write leaves the value as it was", JSON.stringify(memoryGet(N, "nul").value) === JSON.stringify({ keep: 1 }));
  memoryPut(N, "esc", { t: "a\\u0000b" });
  ok("an escaped backslash before u0000 round-trips", memoryGet(N, "esc").value.t === "a\\u0000b");
}

const failed = checks.filter(([, c]) => !c);
console.log(`\n${pass}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map(([n]) => n).join("; "));
  process.exit(1);
}
console.log("Memory v2 unit tests: ALL PASSED");
