// A slow paid call pages even while the event loop is fine.
//
// The stall alarm sees a frozen loop; a paid call whose handler waited a long
// time on an upstream while the loop stayed responsive raised nothing. This
// suite covers the slow-paid alarm (ALERT_SLOW_PAID_MS): the bound and its
// switch, the exemption of routes declared slow (held to their own run budget
// instead), the stall-overlap flag, the bounded list with no payer data, the
// paid-phase timer feeding it, and the serving-health, perf.json and heartbeat
// wiring. Offline, no server.
//
// Every check is counted and the suite fails at the end, so a run against the
// old code reports how many checks it fails instead of stopping at the first.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`not ok - ${m}`); } };
const tryImport = async (p) => { try { return await import(p); } catch (e) { console.log(`# import ${p} failed: ${String(e?.message || e).slice(0, 120)}`); return {}; } };
const fn = (f) => typeof f === "function";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

delete process.env.ALERT_SLOW_PAID_MS;
const S = await tryImport("../src/slow-paid-calls.js");
const L = await tryImport("../src/loop-lag.js");

// --- the bound ----------------------------------------------------------------
ok(fn(S.slowPaidMsFromEnv) && S.slowPaidMsFromEnv(undefined) === 20000, "ALERT_SLOW_PAID_MS defaults to 20000 ms");
ok(fn(S.slowPaidMsFromEnv) && S.slowPaidMsFromEnv("45000") === 45000, "ALERT_SLOW_PAID_MS takes a number");
ok(fn(S.slowPaidMsFromEnv) && S.slowPaidMsFromEnv("off") === 0 && S.slowPaidMsFromEnv("OFF") === 0, "ALERT_SLOW_PAID_MS=off disables the alarm");
ok(fn(S.slowPaidMsFromEnv) && S.slowPaidMsFromEnv("junk") === 20000, "an unreadable ALERT_SLOW_PAID_MS keeps the default rather than switching the alarm off");

// --- a slow ordinary paid call degrades, naming its slug -------------------------
{
  const now = Date.now();
  if (fn(S._resetSlowPaidCalls)) S._resetSlowPaidCalls();
  const fast = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "stock-history", handlerMs: 15_000, endEpochMs: now - 60_000, status: 200 }) : undefined;
  ok(fast === null, "a 15 s paid call is under the bound and is not listed");
  ok(fn(S.slowPaidVerdict) && S.slowPaidVerdict(3600_000, now).degraded === false, "no slow paid call: not degraded");
  const row = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "stock-history", handlerMs: 26_000, endEpochMs: now - 30_000, status: 200 }) : null;
  ok(row?.slug === "stock-history" && row?.ms === 26000 && row?.boundMs === 20000, `a 26 s paid call is listed against the shared bound (${JSON.stringify(row)})`);
  const v = fn(S.slowPaidVerdict) ? S.slowPaidVerdict(3600_000, now) : {};
  ok(v.degraded === true && v.count === 1, "one slow paid call in the hour degrades");
  ok(JSON.stringify(v.slugs) === JSON.stringify(["stock-history"]), `the verdict names the slug (${JSON.stringify(v.slugs)})`);
  ok(fn(S.slowPaidVerdict) && S.slowPaidVerdict(3600_000, now + 3_700_000).degraded === false, "a slow call older than an hour no longer degrades");
  ok(fn(S.slowPaidVerdict) && S.slowPaidVerdict(3600_000, now, 0).degraded === false, "with the alarm off the listed call does not degrade");
  ok(fn(S.noteSlowPaidCall) && S.noteSlowPaidCall({ slug: "stock-history", handlerMs: 90_000, endEpochMs: now }, 0) === null, "with the alarm off nothing is listed");
  const unfinished = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "web-search", handlerMs: null, elapsedMs: 121_000, endEpochMs: now, status: 200 }) : null;
  ok(unfinished?.unfinished === true && unfinished?.ms === 121000, "a handler still running when the call was recorded counts with its elapsed time");
}

// --- a route declared slow is held to its own run budget --------------------------
{
  const { asyncProfileOf } = await tryImport("../src/slow-routes.js");
  const p = fn(asyncProfileOf) ? asyncProfileOf({ slug: "v1-videos" }) : null;
  ok(p?.slow === true && p.maxSeconds * 1000 > 20000, "v1-videos is declared slow with a run budget past the shared bound");
  const budgetMs = (p?.maxSeconds || 0) * 1000;
  ok(fn(S.slowPaidBoundMs) && S.slowPaidBoundMs("v1-videos", 20000) === budgetMs, "a declared-slow route's bound is its run budget");
  ok(fn(S.slowPaidBoundMs) && S.slowPaidBoundMs("search-news", 20000) === 20000, "an ordinary route's bound is the shared one");
  {
    const { UPSTREAM_TIMEOUT_MS } = await import("../src/tools/llm-gateway-kit.js");
    ok(S.CHAT_ATTEMPT_BOUND_MS === UPSTREAM_TIMEOUT_MS, `the chat bound is the gateway's own bound on one model attempt (${S.CHAT_ATTEMPT_BOUND_MS} ms)`);
  }
  ok(["v1-chat", "v1-chat-metered", "v1-chat-nano", "v1-chat-pro"].every((s) => S.slowPaidBoundMs(s, 20000) === S.CHAT_ATTEMPT_BOUND_MS), "a chat tier is held to one model attempt, not the shared bound");
  ok(S.slowPaidBoundMs("v1-chat-metered", 120000) === 120000, "...and a shared bound above it still applies");
  ok(S.slowPaidBoundMs("v1-chatter", 20000) === 20000 && S.slowPaidBoundMs("v1-embeddings", 20000) === 20000, "a slug that only starts like a chat tier keeps the shared bound");
  ok(S.slowPaidBoundMs("route-execute", 20000) === 240000, "a job-capable router tier is held to the outside-seller deadline, not the shared bound");
  ok(S.slowPaidBoundMs("seller-payability", 20000) === 55000, "a job-capable route with its own ceiling is held to that ceiling");
  ok(S.slowPaidBoundMs("seller-payability", 90000) === 90000, "a shared bound above a route's ceiling still applies");
  if (fn(S._resetSlowPaidCalls)) S._resetSlowPaidCalls();
  const within = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "v1-videos", handlerMs: Math.round(budgetMs / 2), endEpochMs: Date.now(), status: 200 }) : undefined;
  ok(within === null, "a declared-slow route past the shared bound but within its budget is not listed");
  ok(fn(S.slowPaidVerdict) && S.slowPaidVerdict().degraded === false, "...and does not degrade");
  const past = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "v1-videos", handlerMs: budgetMs + 1000, endEpochMs: Date.now(), status: 200 }) : null;
  ok(past?.slug === "v1-videos" && past?.boundMs === budgetMs, "a declared-slow route past its own budget is listed");
}

// --- the stall overlap, and no payer data ----------------------------------------
{
  if (fn(S._resetSlowPaidCalls)) S._resetSlowPaidCalls();
  const now = Date.now();
  if (fn(L.recordStall)) L.recordStall({ at: now - 10_000, ms: 6000, gcMs: 0, inFlight: [], jobs: [] });
  const over = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "search-news", handlerMs: 25_000, endEpochMs: now - 5_000, status: 200 }) : null;
  ok(over?.stallOverlap === true, "a slow call whose handler spanned a stall says so");
  const clear = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "search-news", handlerMs: 25_000, endEpochMs: now - 120_000, status: 200 }) : null;
  ok(clear?.stallOverlap === false, "a slow call with no stall in its span says not");
  const v = fn(S.slowPaidVerdict) ? S.slowPaidVerdict(3600_000, now) : {};
  ok(v.withStall === 1 && v.count === 2, "the verdict counts how many overlapped a stall");
  const rows = fn(S.recentSlowPaidCalls) ? S.recentSlowPaidCalls() : [];
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  ok(rows.length === 2 && ["slug", "ms", "at", "stallOverlap"].every((k) => keys.has(k)), "each row has slug, ms, time and the stall flag");
  ok(![...keys].some((k) => /payer|from|wallet|address|amount|price|ip|input/i.test(k)), `no row carries payer data or an amount (${[...keys].join(",")})`);
  const odd = fn(S.noteSlowPaidCall) ? S.noteSlowPaidCall({ slug: "evil<script>\"slug; rm", handlerMs: 30_000, endEpochMs: now, status: 200 }) : null;
  ok(odd?.slug === "evilscriptslugrm", `a slug is reduced to safe characters (${odd?.slug})`);
}

// --- the list stays bounded -------------------------------------------------------
{
  if (fn(S._resetSlowPaidCalls)) S._resetSlowPaidCalls();
  const now = Date.now();
  if (fn(S.noteSlowPaidCall)) for (let i = 0; i < 130; i++) S.noteSlowPaidCall({ slug: `tool-${i}`, handlerMs: 21_000 + i, endEpochMs: now - (130 - i), status: 200 });
  const rows = fn(S.recentSlowPaidCalls) ? S.recentSlowPaidCalls() : [];
  ok(rows.length === 50, `the slow-paid list keeps the last 50 (${rows.length})`);
  ok(rows[0]?.slug === "tool-129" && rows[49]?.slug === "tool-80", "newest first, oldest dropped");
  const v = fn(S.slowPaidVerdict) ? S.slowPaidVerdict(3600_000, now) : {};
  ok(v.slugs?.length === 10 && v.slugs[0] === "tool-129", "the verdict names at most ten slugs, newest first");
  if (rows[0]) rows[0].slug = "mutated";
  ok(fn(S.recentSlowPaidCalls) && S.recentSlowPaidCalls()[0].slug === "tool-129", "a reader gets copies, not the list itself");
}

// --- the paid-phase timer feeds the alarm (the caller path) -------------------------
{
  if (fn(S._resetSlowPaidCalls)) S._resetSlowPaidCalls();
  process.env.ALERT_SLOW_PAID_MS = "60";
  process.env.PAID_TIMING_LOG = "off";
  const P = await tryImport("../src/paid-phase-timing.js");
  const call = async (slug, holdMs) => {
    const req = { headers: { "payment-signature": "x" } };
    const res = new EventEmitter();
    res.statusCode = 200; res.writableFinished = false; res.headersSent = false;
    res.end = function () { this.writableFinished = true; this.headersSent = true; this.emit("close"); return this; };
    req.res = res;
    if (fn(P.phaseArrivalMiddleware)) P.phaseArrivalMiddleware()(req, res, () => {});
    if (fn(P.markPaidHandlerStart)) P.markPaidHandlerStart(req, res, slug, { describe: () => ({ payer: "0xabcdef0123456789", synthetic: false }) });
    await sleep(holdMs);
    res.end();
    await sleep(5);
  };
  await call("stock-history", 120);
  await call("search-news", 5);
  delete process.env.ALERT_SLOW_PAID_MS;
  const rows = fn(S.recentSlowPaidCalls) ? S.recentSlowPaidCalls() : [];
  ok(rows.length === 1 && rows[0].slug === "stock-history" && rows[0].ms >= 60, `a paid call recorded by the phase timer past the bound lands in the list (${JSON.stringify(rows)})`);
  ok(!JSON.stringify(rows).includes("0xabcd"), "the payer the timer knows never reaches the list");
}

// --- a chat call is slow only past its own attempt deadline ----------------------
// The gateway records the deadline it computed for the call (bufferedAttemptMs:
// up to 110 s under an x402 EVM window, 90 s on every other rail); the alarm
// holds the call to it.
{
  const G = await import("../src/tools/llm-gateway-kit.js");
  const premium = G.TIERS["v1-chat-premium"];
  const v = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300 },
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "1000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "01".repeat(32) } } })).toString("base64");
  const evmReq = { headers: { "payment-signature": v }, header: (n) => (String(n).toLowerCase() === "payment-signature" ? v : undefined) };
  const creditsReq = { headers: {}, header: () => undefined, creditsSettling: true };
  const evmMs = G.bufferedAttemptMs(8000, premium, evmReq);
  const creditsMs = G.bufferedAttemptMs(8000, premium, creditsReq);
  ok(evmMs === 110_000 && S.chatAttemptBoundOf(evmReq) === 110_000, `the gateway records the EVM premium call's own deadline (${evmMs}, ${S.chatAttemptBoundOf(evmReq)})`);
  ok(creditsMs === 90_000 && S.chatAttemptBoundOf(creditsReq) === 90_000, `...and 90 s for a credits call (${creditsMs})`);
  const at = Date.now();
  S._resetSlowPaidCalls();
  const within = S.noteSlowPaidCall({ slug: "v1-chat-premium", handlerMs: 105_000, endEpochMs: at, status: 200, ownBoundMs: S.chatAttemptBoundOf(evmReq) });
  ok(within === null && S.slowPaidVerdict(3600_000, at).degraded === false, "a 105 s EVM premium call within its 110 s deadline does not degrade serving health");
  const past = S.noteSlowPaidCall({ slug: "v1-chat-premium", handlerMs: 112_000, endEpochMs: at, status: 200, ownBoundMs: S.chatAttemptBoundOf(evmReq) });
  ok(past?.boundMs === 110_000 && S.slowPaidVerdict(3600_000, at).degraded === true, "a 112 s EVM premium call past its deadline does");
  S._resetSlowPaidCalls();
  const credits = S.noteSlowPaidCall({ slug: "v1-chat-premium-messages", handlerMs: 105_000, endEpochMs: at, status: 200, ownBoundMs: S.chatAttemptBoundOf(creditsReq) });
  ok(credits?.boundMs === 90_000 && S.slowPaidVerdict(3600_000, at).degraded === true, "a 105 s credits premium call (90 s deadline) does");
  S._resetSlowPaidCalls();
  const bare = S.noteSlowPaidCall({ slug: "v1-chat-premium", handlerMs: 95_000, endEpochMs: at, status: 200 });
  ok(bare?.boundMs === 90_000, "a chat call with no recorded deadline keeps the 90 s bound");
  S._resetSlowPaidCalls();
  // The caller path: the phase timer hands the alarm the request's recorded deadline.
  process.env.ALERT_SLOW_PAID_MS = "60";
  process.env.PAID_TIMING_LOG = "off";
  const P = await tryImport("../src/paid-phase-timing.js");
  const call = async (slug, ownMs, holdMs) => {
    const req = { headers: { "payment-signature": "x" } };
    const res = new EventEmitter();
    res.statusCode = 200; res.writableFinished = false; res.headersSent = false;
    res.end = function () { this.writableFinished = true; this.headersSent = true; this.emit("close"); return this; };
    req.res = res;
    P.phaseArrivalMiddleware()(req, res, () => {});
    P.markPaidHandlerStart(req, res, slug, { describe: () => ({ payer: null, synthetic: false }) });
    S.noteChatAttemptBound(req, ownMs);
    await sleep(holdMs);
    res.end();
    await sleep(5);
  };
  await call("v1-chat-premium", 400, 150);
  ok(S.recentSlowPaidCalls().length === 0, "through the phase timer: a chat call inside its recorded deadline is not listed");
  await call("v1-chat-premium", 100, 150);
  const rows = S.recentSlowPaidCalls();
  ok(rows.length === 1 && rows[0].boundMs === 100, `through the phase timer: past its recorded deadline it is listed at that bound (${JSON.stringify(rows)})`);
  delete process.env.ALERT_SLOW_PAID_MS;
  S._resetSlowPaidCalls();
}

// --- serving health, perf.json and the heartbeat are wired --------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = src.indexOf("function servingHealth()");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  ok(/slowPaidMs: slowPaidMsFromEnv\(process\.env\.ALERT_SLOW_PAID_MS\)/.test(src), "serving health reads its bound from ALERT_SLOW_PAID_MS");
  ok(/slowPaidVerdict\(3600_000, Date\.now\(\), SERVING\.slowPaidMs\)/.test(body) && /reasons\.push\("slow-paid"\)/.test(body), "serving health degrades with reason \"slow-paid\" on the last hour's verdict");
  ok(/\bslowPaid,/.test(body) && /recentSlowPaid: recentSlowPaidCalls\(\)/.test(body), "serving-health.json carries the verdict (with its slugs) and the list");
  const pAt = src.indexOf('app.get("/__operator/perf.json"');
  const perf = src.slice(pAt, src.indexOf("\n});", pAt));
  ok(/slowPaid: \{ verdict: slowPaidVerdict\(/.test(perf) && /recent: recentSlowPaidCalls\(\)/.test(perf), "perf.json carries the slow paid calls");
  const pt = readFileSync(new URL("../src/paid-phase-timing.js", import.meta.url), "utf8");
  const rec = pt.slice(pt.indexOf("function recordPaidCall("), pt.indexOf("function pct("));
  const note = rec.slice(rec.indexOf("noteSlowPaidCall("), rec.indexOf(");", rec.indexOf("noteSlowPaidCall(")));
  ok(note.length > 0 && !/payer|whoOf|describe/.test(note), "the timer hands the alarm no payer field");

  const yml = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  const sAt = yml.indexOf("- name: Serving health check");
  const step = yml.slice(sAt, yml.indexOf("\n      - name:", sAt + 10));
  const slugLine = (step.match(/SLOW_SLUGS=\$\(.*\n/) || [""])[0];
  ok(/\.slowPaid\.slugs/.test(slugLine) && /gsub\("\[\^A-Za-z0-9\._-\]"; ""\)/.test(slugLine), "the heartbeat reads the slow slugs and keeps only safe characters");
  ok(slugLine && !/(\.ms\b|Ms\b|worst|count|amount|price|payer|recentSlowPaid)/.test(slugLine), "the slug variable reads names and nothing counted");
  ok(/CULPRIT_NOTE="\$\{CULPRIT_NOTE\} Slow paid calls: \$SLOW_SLUGS\."/.test(step), "the issue note names the slow paid calls");
  const bodies = [...step.matchAll(/--(?:body|comment) "([^"]*)"/g)].map((m) => m[1]);
  ok(bodies.filter((b) => /\$\{CULPRIT_NOTE\}/.test(b)).length === 2, "the opening issue and its still-degraded comment both carry the note");
}

console.log(`test-slow-paid-alarm: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
