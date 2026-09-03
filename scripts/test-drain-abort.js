#!/usr/bin/env node
// In-flight composites are cut off on SIGTERM (src/drain-abort.js): every
// outbound fetch inside a composite scope inherits the process-wide drain
// signal; a fetch outside a scope is untouched (an ordinary in-flight request
// still completes after SIGTERM); a caller's own signal is honoured beside it;
// a fetch started after the abort rejects at once. Plus source pins for the
// four seams in server.js, because the wrapper is only as good as what runs
// inside the scope.
import { readFileSync } from "node:fs";
import { runInAbortableScope, inAbortableScope, abortInFlightComposites, isDrainAbort, installDrainAwareFetch, activeAbortableScopes, __resetDrainForTest } from "../src/drain-abort.js";
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
  ok(/EXPENSIVE_COMPOSITE_SLUGS\.has\(tool\.slug\)\s*\?\s*await runInAbortableScope\(\(\) => tool\.handler\(input, req\)\)/.test(src), "the dispatcher runs a composite slug inside the abortable scope");
  ok(/runInAbortableScope\(\(\) => withCompositeContext\(\{ rail: ctx\?\.rail \|\| "card"/.test(src), "the card/monitor generator runs inside the abortable scope too");
  const sd = src.slice(src.indexOf("function shutdown("), src.indexOf("process.on(\"SIGTERM\""));
  ok(/abortInFlightComposites\(signal\)/.test(sd) && sd.indexOf("draining = true") < sd.indexOf("abortInFlightComposites(signal)"), "shutdown() aborts in-flight composites right after it starts draining");
  ok(/installDrainAwareFetch\(\);/.test(src) && src.indexOf("installDrainAwareFetch();") < src.indexOf("app.listen("), "the drain-aware fetch is installed at boot, before the server listens");
  ok(/if \(isDrainAbort\(err\)\) \{ status = 503;/.test(src), "a drain abort surfaces as a 503 (>= 400: never charged), whatever shape the upstream raised it in");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
