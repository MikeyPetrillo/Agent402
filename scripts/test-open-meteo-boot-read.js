#!/usr/bin/env node
// The openMeteo status word leaves its boot value without waiting for a
// buyer: shortly after the server listens, one keyed forecast read is made
// (src/tools/weather-kit.js scheduleOpenMeteoBootRead), and its outcome moves
// the word exactly as a buyer's keyed call would.
//   - a keyed success reads ok; a 400 naming the key reads refused at once; a
//     403 is tried once more and two in a row read refused; a timeout or a 5xx
//     leaves the word where it was (a buyer's would too), after one retry;
//   - one read per boot plus at most one retry, each under its short timeout;
//   - no read in FREE_MODE, without the key, or with OPEN_METEO_BOOT_READ=off;
//   - nothing is read before the delay ends, the timers are unref'd, and
//     server.js starts it from the listen callback (never on a request).
// Offline: a stubbed fetch and resolver; no network, no server.
//
//   node scripts/test-open-meteo-boot-read.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const KEY = "omk" + "Bt5Rd1Lq8Wz2Xy6Nc4";
delete process.env.OPEN_METEO_API_KEY;
delete process.env.OPEN_METEO_BOOT_READ;
const kit = await import("../src/tools/weather-kit.js");
const { openMeteoStatus, _resetOpenMeteoStatus, openMeteoBootRead, scheduleOpenMeteoBootRead, OPEN_METEO_BOOT_READ_DELAY_MS, OPEN_METEO_BOOT_READ_TIMEOUT_MS } = kit;
ok(typeof openMeteoBootRead === "function" && typeof scheduleOpenMeteoBootRead === "function", "the kit exports the boot read and its scheduler");
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const restoreResolver = stubGuardResolver((host, family) => (/(^|\.)open-meteo\.com$/.test(host) ? (family === 4 ? ["93.184.216.34"] : []) : undefined));
const fetched = [];
let reply = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetched.push(String(url));
  const r = await reply(String(url), init);
  Object.defineProperty(r, "url", { value: String(url) });
  return r;
};
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GOOD = json(200, { current: { time: "2026-01-01T00:00", temperature_2m: 1 } });
const word = (env) => openMeteoStatus(env ? { env } : undefined).status;
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
// A scheduler run on real (short) timers, awaited to its end. The server's
// timers are unref'd; here each is held (a handle with no unref) so the suite
// stays alive until the run reports.
const held = (fn, ms) => ({ timer: setTimeout(fn, ms) });
const runBoot = (opts = {}) => new Promise((resolve) => {
  const t = scheduleOpenMeteoBootRead({ freeMode: false, delayMs: 5, retryDelayMs: 5, timeoutMs: 400, setTimer: held, onDone: resolve, ...opts });
  if (t === null) resolve(null);
});

try {
  process.env.OPEN_METEO_API_KEY = KEY;
  ok(OPEN_METEO_BOOT_READ_DELAY_MS >= 5_000 && OPEN_METEO_BOOT_READ_DELAY_MS <= 120_000 && OPEN_METEO_BOOT_READ_TIMEOUT_MS > 0 && OPEN_METEO_BOOT_READ_TIMEOUT_MS <= 10_000, `the read waits a short while after boot and runs under a short timeout (${OPEN_METEO_BOOT_READ_DELAY_MS} ms, ${OPEN_METEO_BOOT_READ_TIMEOUT_MS} ms)`);

  // Success: unknown -> ok, one keyed read of the forecast API.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0; reply = GOOD;
  ok(word() === "unknown", "a fresh process with a key reads unknown");
  let out = await runBoot();
  let u = new URL(fetched[0] || "http://none");
  ok(out === "ok" && word() === "ok" && fetched.length === 1, `after the boot read succeeds the word is ok, with one read (${out}, ${word()}, ${fetched.length})`);
  ok(u.host === "customer-api.open-meteo.com" && u.pathname === "/v1/forecast" && u.searchParams.get("apikey") === KEY, `the read is one keyed forecast read (${u.host}${u.pathname})`);

  // A 400 that names the key: refused at once, no retry needed to say so.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0; reply = json(400, { error: true, reason: "The supplied API key is invalid." });
  out = await quiet(() => runBoot());
  ok(out === "refused" && word() === "refused" && fetched.length === 2, `a key refusal reads refused, after the read and its one retry (${out}, ${word()}, ${fetched.length} reads)`);

  // A 403: one refusal does not turn the word (a buyer's would not); the retry's second does.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0; reply = json(403, {});
  out = await quiet(() => openMeteoBootRead({ timeoutMs: 400 }));
  ok(out === "refused" && word() === "unknown" && fetched.length === 1, `one 403 alone leaves the word unknown, as one buyer's refusal would (${word()})`);
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0;
  out = await quiet(() => runBoot());
  ok(out === "refused" && word() === "refused" && fetched.length === 2, `a 403 on the read and on its retry reads refused: two in a row (${word()}, ${fetched.length} reads)`);

  // A refusal, then a success on the retry: ok, and nothing after it.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0;
  { let n = 0; reply = (...a) => (++n === 1 ? json(403, {})(...a) : GOOD(...a)); }
  out = await quiet(() => runBoot());
  await new Promise((r) => setTimeout(r, 40));
  ok(out === "ok" && word() === "ok" && fetched.length === 2, `a retry that succeeds reads ok, and no third read follows (${fetched.length} reads)`);

  // An upstream that never answers: the read ends at its timeout, the word stays, one retry at most.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0;
  reply = (_url, init) => new Promise((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
  const t0 = Date.now();
  out = await quiet(() => runBoot({ timeoutMs: 150 }));
  const took = Date.now() - t0;
  ok(out === "failed" && word() === "unknown" && fetched.length === 2 && took < 3_000, `a read with no answer ends at its timeout and leaves the word unknown, as a buyer's timeout would (${out}, ${fetched.length} reads, ${took} ms)`);

  // Nothing is read before the delay ends, and scheduling returns at once.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0; reply = GOOD;
  {
    const timers = [];
    const s0 = Date.now();
    const t = scheduleOpenMeteoBootRead({ freeMode: false, setTimer: (fn, ms) => { const h = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } }; timers.push(h); return h; } });
    ok(t !== null && Date.now() - s0 < 50 && fetched.length === 0 && timers.length === 1 && timers[0].ms === OPEN_METEO_BOOT_READ_DELAY_MS && timers[0].unrefd, "scheduling returns at once with one unref'd timer at the boot delay and reads nothing");
    await timers[0].fn();
    ok(fetched.length === 1 && word() === "ok" && timers.length === 1, "the timer's run makes the one read, and a success arms no retry");
  }

  // Never in FREE_MODE, without the key, or with the switch off.
  _resetOpenMeteoStatus({ logs: true }); fetched.length = 0;
  ok(scheduleOpenMeteoBootRead({ freeMode: true, delayMs: 1 }) === null, "FREE_MODE: nothing is scheduled");
  ok(scheduleOpenMeteoBootRead({ freeMode: false, delayMs: 1, env: {} }) === null && await openMeteoBootRead({ env: {} }) === "skipped", "no key: nothing is scheduled and the read itself is skipped");
  ok(scheduleOpenMeteoBootRead({ freeMode: false, delayMs: 1, env: { OPEN_METEO_API_KEY: KEY, OPEN_METEO_BOOT_READ: "off" } }) === null, "OPEN_METEO_BOOT_READ=off: nothing is scheduled");
  await new Promise((r) => setTimeout(r, 40));
  ok(fetched.length === 0 && word() === "unknown" && word({}) === "off", "none of the three made a read; the word is unchanged (unknown with a key, off without)");

  // The server starts it once it listens, with its own FREE_MODE, and nowhere else.
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const calls = server.split("scheduleOpenMeteoBootRead(").length - 1;
  const listen = server.slice(server.indexOf("listenedAt = Date.now();"), server.indexOf("httpServer.on(\"clientError\""));
  ok(calls === 1 && /scheduleOpenMeteoBootRead\(\{ freeMode: FREE_MODE \}\);/.test(listen), "server.js schedules the read once, in the listen callback, passing FREE_MODE (not awaited, not on a request)");
} finally {
  globalThis.fetch = realFetch;
  restoreResolver();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
