// The replay guard's claim when two requests carrying one payment overlap and
// the shared store answers one of them but not the other. Offline: an
// in-memory client with the commands the guard sends (GET, SET NX/EX, DEL,
// EXPIRE) whose calls can be held or failed one at a time, so each
// interleaving is placed exactly.
//
//   1. One process, two requests in flight. Request B's read of the store is
//      held; request A's read fails, so A takes the per-process claim. When
//      B's read returns, B's SET NX lands (A never wrote the store): B must
//      read this process's own claim before it is granted, give its store
//      claim back and answer "inflight". Exactly one of the two runs.
//   2. The same with the order reversed: B's store claim is taken first, then
//      A's store read fails: A reads B's per-process mark and is refused.
//   3. Two processes (a deploy overlap). The old container's store read fails
//      and it takes a per-process claim; that claim is written to the store as
//      soon as the store answers again (not at the first 30 s renewal), so the
//      new container, whose next try reaches the store, reads it in flight.
//   4. Controls: one request alone is granted on each path; after a release a
//      retry of the same unused payment is granted.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
delete process.env.REDIS_URL;
const { createReplayGuard } = await import("../src/replay-guard.js");
const { __setTestClient } = await import("../src/shared-limit.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; process.stderr.write(`FAIL - ${m}\n`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = console.error;

// An in-memory store. `plan` is a queue of per-call actions for GET: "ok",
// "fail" (throws), or a promise to wait on before answering.
function memStore() {
  const data = new Map();
  const plan = [];
  let down = false;
  const step = async () => {
    if (down) throw new Error("simulated outage");
    const a = plan.shift();
    if (a === "fail") throw new Error("simulated blip");
    if (a && typeof a.then === "function") await a;
  };
  const c = {
    isReady: true,
    data, plan,
    setDown(v) { down = v; },
    get: async (k) => { await step(); return data.has(k) ? data.get(k) : null; },
    set: async (k, v, o = {}) => { if (down) throw new Error("simulated outage"); if (o.NX && data.has(k)) return null; data.set(k, v); return "OK"; },
    del: async (k) => { if (down) throw new Error("simulated outage"); return data.delete(k) ? 1 : 0; },
    expire: async (k) => { if (down) throw new Error("simulated outage"); return data.has(k) ? 1 : 0; },
  };
  return c;
}
const claimsIn = (store) => [...store.data.keys()].filter((k) => k.includes(":f:"));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

console.error = () => {};
try {
  // ---- 1. Store read held for B, failed for A, on one process ---------------
  {
    const store = memStore();
    __setTestClient(store);
    const g = createReplayGuard();
    const held = gate();
    store.plan.push(held.p, "fail");
    const pB = g.begin("n:race-1");
    await sleep(5);
    const a = await g.begin("n:race-1");
    held.open();
    const b = await pB;
    const granted = [a, b].filter((v) => v === "ok").length;
    ok(granted === 1, `one process, store answers one request only: exactly one of two is granted (A=${a}, B=${b})`);
    ok(a === "ok" && b === "inflight", "the request that holds the per-process claim runs; the other reads it in flight");
    ok(g._state().inFlight === 1, "one claim is held on this process");
    await g.release("n:race-1");
    ok(await g.begin("n:race-1") === "ok", "CONTROL: after a release, a retry of the same unused payment is granted");
    await g.release("n:race-1");
  }

  // ---- 2. The reverse order: store claim first, then a failed read ----------
  {
    const store = memStore();
    __setTestClient(store);
    const g = createReplayGuard();
    ok(await g.begin("n:race-2") === "ok", "CONTROL: a lone request is granted on the store path");
    store.plan.push("fail");
    const a = await g.begin("n:race-2");
    ok(a === "inflight", `a second request whose store read fails is refused on the first one's per-process mark (got ${a})`);
    await g.settle("n:race-2");
    store.plan.push("fail");
    ok(await g.begin("n:race-2") === "consumed", "and once settled it reads consumed on either path");
  }

  // ---- 3. Two processes: the old container's fallback claim ------------------
  {
    const store = memStore();
    __setTestClient(store);
    const oldC = createReplayGuard();
    const newC = createReplayGuard();
    store.plan.push("fail");
    ok(await oldC.begin("n:race-3") === "ok", "old container: a store blip falls back to the per-process claim");
    // The store answers again well inside the 30 s renewal period.
    await sleep(1_500);
    ok(claimsIn(store).length === 1, `the per-process claim is written to the store once it answers (claims in store: ${claimsIn(store).length})`);
    const n = await newC.begin("n:race-3", undefined, { requireShared: true });
    ok(n === "inflight", `new container: the same payment reads in flight (got ${n})`);
    await oldC.settle("n:race-3");
    ok(await newC.begin("n:race-3", undefined, { requireShared: true }) === "consumed", "and consumed once the old container settles it");
  }

  // ---- 4. Control: a payment nobody else holds is granted on the fallback ----
  {
    const store = memStore();
    __setTestClient(store);
    const g = createReplayGuard();
    store.plan.push("fail");
    ok(await g.begin("n:race-4") === "ok", "CONTROL: a lone request on a store blip is still granted (a buyer who can pay is served)");
    await g.release("n:race-4");
  }
} finally {
  console.error = quiet;
  __setTestClient(null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
