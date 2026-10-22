// A memo whose builder reads another memo. Runs server.js's own memo code
// (sliced from the source) under a fake clock: an outer build waits for the
// inner rebuild instead of caching a stale inner value, and a partial inner
// value keeps the outer one partial.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const from = src.indexOf("const PARTIAL_MEMO_MS");
const to = src.indexOf("function dropSurface(");
ok(from > 0 && to > from, "the memo helpers are found in server.js");
const memoCode = src.slice(from, to);

let loaded = false;
let now = 0;
const surfaceMemo = new Map();
const realNow = Date.now;
Date.now = () => now;
// eslint-disable-next-line no-new-func
const { runAsJob } = await import("../src/active-jobs.js");
const { memoSurfaceAsync } = new Function("surfaceMemo", "stateStoresLoaded", "runAsJob", `${memoCode}\nreturn { memoSurfaceAsync };`)(surfaceMemo, () => loaded, runAsJob);
const settle = () => new Promise((r) => setImmediate(r));

try {
  let gen = 0;
  const inner = (opts) => memoSurfaceAsync("inner", 60_000, async () => { await settle(); return { gen: ++gen, loaded }; }, opts);
  const outer = () => memoSurfaceAsync("outer", 60_000, async () => {
    const v = await inner({ awaitRebuild: true });
    return { inner: v, ...(v.partial === true ? { partial: true } : {}) };
  });

  // Boot with the stores still loading: both memos are partial.
  const first = await outer();
  ok(first.partial === true && first.inner.loaded === false, "a build while the stores load is marked partial");

  // The stores load; the partial window (2 s) passes. The outer rebuild must
  // wait for a fresh inner value, not cache the stale partial one as full.
  loaded = true;
  now = 3_000;
  await outer();            // serves the stale value, rebuilds in the background
  for (let i = 0; i < 6; i++) await settle();
  now = 4_000;
  const after = await outer();
  ok(after.inner.loaded === true && after.partial !== true, "after the load the outer value is rebuilt from a fresh inner value");

  // A partial inner value keeps the outer one partial even when the stores
  // read as loaded at the outer build.
  surfaceMemo.clear();
  loaded = false;
  now = 100_000;
  await inner();
  loaded = true;
  now = 100_500; // inner is still fresh (inside its 2 s partial window)
  const mixed = await outer();
  ok(mixed.partial === true && mixed.partialReason === "state-loading", "an outer value built from a partial inner value is stored as partial");

  // Without awaitRebuild a stale hit still serves at once (request paths).
  surfaceMemo.clear();
  loaded = true;
  now = 200_000;
  const a = await inner();
  now = 270_000;
  const b = await inner();
  ok(b === a, "a request path still serves the last value while it rebuilds");
} finally {
  Date.now = realNow;
}
console.log(`test-revenue-memo-chain: ${n} passed`);
