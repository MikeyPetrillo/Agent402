#!/usr/bin/env node
// In-flight composites are cut off on SIGTERM (src/drain-abort.js): every
// outbound fetch inside a composite scope inherits the process-wide drain
// signal; a fetch outside a scope is untouched (an ordinary in-flight request
// still completes after SIGTERM); a caller's own signal is honoured beside it;
// a fetch started after the abort rejects at once. Plus source pins for the
// four seams in server.js, because the wrapper is only as good as what runs
// inside the scope.
import { readFileSync } from "node:fs";
import { runInAbortableScope, inAbortableScope, abortInFlightComposites, isDrainAbort, installDrainAwareFetch, activeAbortableScopes, clientGoneSignal, __resetDrainForTest } from "../src/drain-abort.js";
import { createServer } from "node:http";
import { clientGoneError, isClientGoneAbort } from "../src/hangup-settlement.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub upstream: resolves after 2 s unless its signal aborts first.
const slowUpstream = async (_url, init) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve({ status: 200 }), 2000);
  init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal.reason); }, { once: true });
});
const seen = [];
const f = installDrainAwareFetch({ fetchImpl: async (url, init) => { seen.push({ url, hasSignal: !!init?.signal }); return slowUpstream(url, init); } });

// 1. inside a scope the drain cuts the call at once
{
  __resetDrainForTest();
  const t0 = Date.now();
  const run = runInAbortableScope(async () => { ok(inAbortableScope(), "code inside the scope sees it"); return f("https://openrouter.example/v1/chat"); });
  await sleep(50);
  ok(activeAbortableScopes() === 1, "one composite counted as active");
  const cut = abortInFlightComposites("SIGTERM");
  const err = await run.then(() => null, (e) => e);
  ok(cut === 1 && err && isDrainAbort(err) && err.statusCode === 503, `the in-flight upstream call rejects with the drain abort (503) - ${Date.now() - t0} ms, not 2 s`);
  ok(Date.now() - t0 < 1000, "and it rejects promptly, not at the upstream's own timeout");
  ok(activeAbortableScopes() === 0, "the scope is released after the throw");
}
// 2. outside a scope nothing changes
{
  __resetDrainForTest();
  abortInFlightComposites("SIGTERM");
  seen.length = 0;
  const t0 = Date.now();
  const r = await f("https://ordinary.example/x");
  ok(r.status === 200 && Date.now() - t0 >= 1900 && seen[0].hasSignal === false, "a fetch outside any composite scope is untouched even while draining (no signal attached, completes normally)");
}
// 3. a fetch started after the abort, inside a scope, rejects immediately
{
  __resetDrainForTest();
  abortInFlightComposites("SIGTERM");
  const t0 = Date.now();
  const err = await runInAbortableScope(() => f("https://openrouter.example/late")).then(() => null, (e) => e);
  ok(err && isDrainAbort(err) && Date.now() - t0 < 100, "a composite fetch attempted after the abort rejects at once (no upstream spend)");
}
// 4. the caller's own signal is still honoured
{
  __resetDrainForTest();
  const own = new AbortController();
  const p = runInAbortableScope(() => f("https://x.example", { signal: own.signal }));
  await sleep(20);
  own.abort(new Error("caller timeout"));
  const err = await p.then(() => null, (e) => e);
  ok(err && /caller timeout/.test(err.message) && !isDrainAbort(err), "a caller's own abort still fires and is not mistaken for the drain");
}
// 5. idempotent global install
{
  const before = globalThis.fetch;
  const a = installDrainAwareFetch(); const b = installDrainAwareFetch();
  ok(a === b && globalThis.fetch.__a402DrainAware === true, "global install is idempotent");
  globalThis.fetch = before;
}
// 6. source pins: the scope wraps composites at BOTH doors, shutdown aborts, the error maps to 503
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/EXPENSIVE_COMPOSITE_SLUGS\.has\(tool\.slug\)\s*\?\s*await runInAbortableScope\(\(\) => tool\.handler\(input, req\)(, \{ signal: clientGoneCtl\.signal \})?\)/.test(src), "the dispatcher runs a composite slug inside the abortable scope");
  ok(/runInAbortableScope\(\(\) => withCompositeContext\(\{ rail: ctx\?\.rail \|\| "card"/.test(src), "the card/monitor generator runs inside the abortable scope too");
  const sd = src.slice(src.indexOf("function shutdown("), src.indexOf("process.on(\"SIGTERM\""));
  ok(/abortInFlightComposites\(signal\)/.test(sd) && sd.indexOf("draining = true") < sd.indexOf("abortInFlightComposites(signal)"), "shutdown() aborts in-flight composites right after it starts draining");
  ok(/installDrainAwareFetch\(\);/.test(src) && src.indexOf("installDrainAwareFetch();") < src.indexOf("app.listen("), "the drain-aware fetch is installed at boot, before the server listens");
  ok(/if \(isDrainAbort\(err\)\) \{ status = 503;/.test(src), "a drain abort surfaces as a 503 (>= 400: never charged), whatever shape the upstream raised it in");
}
// 7. The buyer's client-gone signal (src/hangup-settlement.js): carried by the
// scope, read only through clientGoneSignal(), and only while the scope lives.
{
  __resetDrainForTest();
  ok(clientGoneSignal() === null, "outside any scope there is no client-gone signal");
  const ctl = new AbortController();
  let inside = null, noSignal = "unset", later = "unset";
  await runInAbortableScope(async () => {
    inside = clientGoneSignal();
    setTimeout(() => { later = clientGoneSignal(); }, 30);
  }, { signal: ctl.signal });
  await runInAbortableScope(async () => { noSignal = clientGoneSignal(); });
  await sleep(60);
  ok(inside === ctl.signal, "inside a scope given a signal, clientGoneSignal() returns it");
  ok(noSignal === null, "a scope given no signal (the card/monitor generator) has none");
  ok(later === null, "a timer created inside the scope reads null once the scope has ended (the live flag)");
}
// 8. fetchOpenRouter joins it: a stub upstream sees its request closed when the
// buyer leaves, the call rejects with the 499 client-gone reason, a plain fetch
// in the same scope is NOT cut off, and outside a scope nothing changes.
{
  const before = globalThis.fetch;
  const drainFetch = installDrainAwareFetch({ fetchImpl: before });
  globalThis.fetch = drainFetch;
  const seen = { or: 0, orClosedEarly: 0, plain: 0, plainClosedEarly: 0 };
  const upstream = createServer((req, res) => {
    const key = req.url.startsWith("/api/v1/") ? "or" : "plain";
    seen[key]++;
    res.on("close", () => { if (!res.writableFinished) seen[`${key}ClosedEarly`]++; });
    req.resume();
    setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); } }, 600);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const U = `http://127.0.0.1:${upstream.address().port}`;
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key-never-used";
  const { fetchOpenRouter } = await import("../src/tools/llm-gateway-kit.js");
  try {
    __resetDrainForTest();
    const ctl = new AbortController();
    const t0 = Date.now();
    let orSettledAt = 0;
    const [orErr, plainRes] = await runInAbortableScope(async () => {
      const a = fetchOpenRouter({ model: "x", messages: [] }, { url: `${U}/api/v1/chat/completions`, timeoutMs: 5_000 }).then(() => null, (e) => e).finally(() => { orSettledAt = Date.now(); });
      const b = fetch(`${U}/plain`).then((r) => r.status, (e) => e);
      setTimeout(() => ctl.abort(clientGoneError()), 150);
      return Promise.all([a, b]);
    }, { signal: ctl.signal });
    await sleep(100);
    ok(isClientGoneAbort(orErr) && orErr.statusCode === 499 && orSettledAt - t0 < 500, `fetchOpenRouter inside a scope whose client-gone signal aborts rejects with the 499 reason, promptly (${orErr?.statusCode} after ${orSettledAt - t0} ms, the upstream answers at 600)`);
    ok(seen.orClosedEarly === 1, "the stub upstream sees its in-flight request closed early");
    ok(plainRes === 200 && seen.plainClosedEarly === 0, "a plain fetch in the same scope is NOT aborted by the client signal (shared work is never poisoned)");
    // a call started after the buyer left never reaches the upstream at all
    const n = seen.or;
    const late = await runInAbortableScope(() => fetchOpenRouter({ model: "x" }, { url: `${U}/api/v1/chat/completions` }).then(() => null, (e) => e), { signal: ctl.signal });
    ok(isClientGoneAbort(late) && seen.or === n, "a paid call started after the buyer left is refused before it reaches the upstream");
    // outside any scope: untouched
    const outside = await fetchOpenRouter({ model: "x" }, { url: `${U}/api/v1/chat/completions`, timeoutMs: 5_000 });
    ok(outside.status === 200, "fetchOpenRouter outside any scope is unaffected");
    // drain still works on top of it
    __resetDrainForTest();
    const d = runInAbortableScope(() => fetchOpenRouter({ model: "x" }, { url: `${U}/api/v1/chat/completions`, timeoutMs: 5_000 }).then(() => null, (e) => e), { signal: new AbortController().signal });
    await sleep(80);
    abortInFlightComposites("SIGTERM");
    const dErr = await d;
    ok(dErr && !isClientGoneAbort(dErr) && dErr.statusCode === 504 && /draining|composite aborted/.test(dErr.message), `a drain abort still cuts a composite's fetchOpenRouter call, and is not mistaken for the buyer leaving (${dErr?.statusCode} ${dErr?.message?.slice(0, 60)})`);
  } finally {
    __resetDrainForTest();
    globalThis.fetch = before;
    upstream.close();
  }
}

// ---- a per-scope stop signal cuts off that scope's calls only ----
{
  const seen = [];
  const stub = (u, init) => new Promise((res, rej) => { seen.push(init?.signal); if (init?.signal?.aborted) return rej(init.signal.reason); init?.signal?.addEventListener("abort", () => rej(init.signal.reason)); setTimeout(() => res({ ok: true }), 200); });
  const f = installDrainAwareFetch({ fetchImpl: stub });
  const stop = new AbortController();
  const inside = runInAbortableScope(() => f("https://example.com/a"), { stopSignal: stop.signal });
  const other = runInAbortableScope(() => f("https://example.com/b"));
  setTimeout(() => stop.abort(new Error("step timed out")), 20);
  const [a, b] = await Promise.allSettled([inside, other]);
  ok(a.status === "rejected" && /step timed out/.test(String(a.reason?.message)) && b.status === "fulfilled", "aborting a scope's stop signal cuts off its call and leaves another scope's alone");
  const nested = await Promise.allSettled([runInAbortableScope(() => runInAbortableScope(() => f("https://example.com/c")), { stopSignal: AbortSignal.abort(new Error("outer stopped")) })]);
  ok(nested[0].status === "rejected" && /outer stopped/.test(String(nested[0].reason?.message)), "a nested scope keeps the enclosing scope's stop signal");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
