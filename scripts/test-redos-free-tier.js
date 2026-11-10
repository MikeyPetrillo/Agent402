#!/usr/bin/env node
// No free-tier tool and no skill may hold the event loop on a long adversarial
// string. One server serves every buyer, so a regex or loop that goes
// quadratic on one request stalls every other request for its whole run.
//
//   node scripts/test-redos-free-tier.js            (boots its own server, port 0)
//   REDOS_BOUND_MS=250 REDOS_ONLY=duration,base58 node scripts/test-redos-free-tier.js
//
// HOW: the server boots in FREE_MODE under scripts/offline-egress-preload.js,
// so every outbound call fails at once and a tool's remaining time is its own
// work. Every string field of every free-tier tool (src/free-tier.js, less the
// WALLET_ONLY_SLUGS overrides) and of every skill (/api/skill/*) is sent each
// shape of the adversarial corpus below (inside an object and a list for an
// object or array field), one call at a time, while /health is
// polled. The longest /health wait during the call is how long the loop was
// held; a call that holds it past the bound is re-run up to three times and
// fails if it holds it every time (a pattern that goes quadratic on an input
// holds the loop on every run of it; a host busy with other work does not
// stretch four waits in a row the same way).
//
// Two more corpora ride the same loop. The long corpus fills the body limit
// with the runs whose cost shows only at that size (sentence punctuation
// before a letter, unclosed emphasis, brackets, quote markers, spaces). The
// structured corpus sends every field, whatever its declared type, a value
// that is small on the wire and large or unreadable once handled: thousands
// of objects that share no key, a spec whose every schema references the next
// one twice, dates at the ends of the range a Date holds, and an object whose
// toString is not a function. For those the guard also bounds the size of
// the answer, and a proof-of-work tool may not answer any call with a 500 or
// a 502: a field it cannot read is the caller's 400 (src/caller-input-errors.js
// names the field for a value that cannot be coerced; every other case is
// the tool's own check).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { oursMs, bound, OURS_READING } from "./lib/ours-clock.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUND_MS = Number(process.env.REDOS_BOUND_MS) || 250;
// A call over the bound is run again this many times before it counts.
const REPROBES = 3;
const ONLY = process.env.REDOS_ONLY ? new Set(process.env.REDOS_ONLY.split(",").map((s) => s.trim())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The corpus: long runs of the shapes that make a backtracking regex or a
// per-character rescan go quadratic. Bodies carry 20,000 characters; query
// strings carry fewer so the request line stays under the header limit.
function corpus(n) {
  return {
    a: "a".repeat(n),
    dotsAt: "x@" + ".".repeat(n) + " ",
    aDot: "a.".repeat(n / 2) + "-",
    spaces: "a" + " ".repeat(n) + "!",
    digits: "1".repeat(n) + "x",
    dash: "a-".repeat(n / 2) + "!",
    lt: "<a".repeat(n / 2),
    nl: "a\n".repeat(n / 2) + "!",
  };
}

// Sized to the JSON body limit (100 KB) less room for the rest of the body.
function longCorpus(n) {
  return {
    dotsLetter: ".".repeat(n) + "x",
    bangsLetter: "!?".repeat(n / 2) + "x",
    emphasis: "*a ".repeat(n / 3),
    brackets: "[".repeat(n),
    quotes: "> ".repeat(n / 2),
    spacesLetter: "a" + " ".repeat(n) + "b",
  };
}

// A schema that references the next one twice, level after level: the
// resolved document doubles per level.
function doublingRefs(depth) {
  const schemas = {};
  for (let i = 0; i < depth; i++) schemas["S" + i] = { type: "object", properties: { a: { $ref: "#/components/schemas/S" + (i + 1) }, b: { $ref: "#/components/schemas/S" + (i + 1) } } };
  schemas["S" + depth] = { type: "string" };
  return { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: { "/u": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } } } } } }, components: { schemas } };
}

// Values sent to every field as they are, whatever type the field declares.
function structuredCorpus() {
  const refs = doublingRefs(18);
  // The same fan-out closed into a cycle, where no resolved schema can be reused.
  const cycle = doublingRefs(16); cycle.components.schemas.S16 = { $ref: "#/components/schemas/S0" };
  return {
    doublingCycle: cycle,
    manyKeys: Array.from({ length: 7000 }, (_, i) => ({ [i]: 1 })),
    doublingRefs: refs,
    doublingRefsText: JSON.stringify(refs),
    noToString: { toString: 1, valueOf: "x" },
    noToStringList: [{ toString: 1 }],
    farFuture: "+275000-01-01",
    farPast: "-271821-04-20",
    yearOne: "0001-01-01",
    lastInstant: 8.64e15,
  };
}
// Above the largest answer a tool may write (16 MB of resolved spec or of CSV, plus its envelope).
const MAX_ANSWER_BYTES = 24_000_000;

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// The listing screen (src/listing-screen.js) reads seller-written text on
// every route call, every judged pick and every index screen, and a free
// tool (email-guard) reads a buyer's sentences through it: every exported
// screen function gets 100,000-character runs of the shapes above behind
// each phrase that opens one of its rules, and must answer each inside
// LISTING_BOUND_MS (best of three) and grow at most LISTING_GROWTH times from
// a quarter of the length when it takes over a quarter of the bound (linear
// grows 4x; a quadratic one 16x). The functions are synchronous, so a reading
// is the time this thread had a core (scripts/lib/ours-clock.js), not wall
// time, and the bound is 100 ms or six times the same-machine baseline job,
// whichever is larger: the slowest shape reads about 34 ms on a laptop, and
// on a host busy with other suites the wall clock read it near and past
// 100 ms. The readings this guards against are the old ones, in seconds
// (17 s for the digit reading below).
{
  const LISTING = bound(Number(process.env.LISTING_BOUND_MS) || 100, 6);
  const LISTING_BOUND_MS = LISTING.ms;
  console.log(`# screen functions timed as ${OURS_READING}; ${LISTING.note}`);
  const LISTING_GROWTH = 10;
  const screen = await import("../src/listing-screen.js");
  const fns = {
    looksLikeListingInjection: (s) => screen.looksLikeListingInjection(s),
    matchesInjectionPhrase: (s) => screen.matchesInjectionPhrase(s),
    listingInjectionFinding: (s) => screen.listingInjectionFinding(s),
    addressesReader: (s) => screen.addressesReader(s),
    judgeReadableText: (s) => screen.judgeReadableText(s),
    judgeReadableName: (s) => screen.judgeReadableName(s),
    judgeReadableListing: (s) => screen.judgeReadableListing({ host: s, slug: s, description: s, tags: [s, s] }),
    // The screen's parts on their own: every reading of the text with no hint,
    // and the two hints and the alternation on each.
    __testListingScreen: (s) => { const p = screen.__testListingScreen(); for (const f of p.injectionForms(s)) { p.INJECTION_LEET_HINT.test(f); p.INJECTION_HINT.test(f); p.INJECTION_ANY.test(f); } },
  };
  const exported = Object.keys(screen).filter((k) => typeof screen[k] === "function");
  ok(exported.every((k) => k in fns), `every exported screen function is timed (${exported.filter((k) => !(k in fns)).join(",") || "all"})`);
  const openers = ["", "a1 ", "1gn0re ", "s y s ", "note to the ", "dear ", "hi ", "as the judge ", "you ", "the model ", "system ", "choose ", "best ", "rank ", "rate ", "rate every ", "only ", "always ", "confidence ", "fit ", "perfect ", "evaluators ", "ignore ", "disregard what ", "forget ", "override ", "do not ", "<", "[", "<|", "## ", "judge: ", "select this ", "wähle immer ", "immer dieses ", "elige siempre ", "choisis toujours ", "escolha sempre "];
  const fills = { space: " ", a: "a", spaceA: " a", dashA: "-a", aUnderscore: "a_", dotA: ".a", comma: ", ", digitA: "1a", cyrillic: "а ", tab: "\t", nl: "\n", entity: "&lt;", zeroWidth: "a​", colon: ": " };
  const build = (open, fill, n) => (open + fill.repeat(Math.ceil(n / fill.length))).slice(0, n) + "!";
  // Best of three, but a run far past the bound is not repeated, and a
  // function found slow once is not timed again, so a regression fails in
  // seconds rather than running every shape at its slow speed.
  const bestOf = (fn, s) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = oursMs(); fn(s); best = Math.min(best, oursMs() - t);
      if (best > LISTING_BOUND_MS * 5) break;
    }
    return best;
  };
  const slowScreens = [];
  const slowFns = new Set();
  let worst = { ms: 0 };
  for (const open of openers) for (const [fk, fill] of Object.entries(fills)) {
    const long = build(open, fill, 100_000);
    for (const [name, fn] of Object.entries(fns)) {
      if (slowFns.has(name)) continue;
      const ms = bestOf(fn, long);
      if (ms > worst.ms) worst = { ms, name, open, fk };
      if (ms > LISTING_BOUND_MS) { slowFns.add(name); slowScreens.push(`${name} ${JSON.stringify(open)}+${fk}: ${ms.toFixed(1)}ms`); }
      else if (ms > LISTING_BOUND_MS / 4) {
        const quarter = bestOf(fn, build(open, fill, 25_000));
        // A suspicion is measured again, both sizes back to back: a load spike
        // that lands on one reading is not growth; a quadratic reading grows
        // every time.
        const grows = (big, small) => big > LISTING_GROWTH * Math.max(small, LISTING_BOUND_MS / 20);
        if (grows(ms, quarter)) {
          const again = bestOf(fn, long), againQuarter = bestOf(fn, build(open, fill, 25_000));
          if (grows(again, againQuarter)) slowScreens.push(`${name} ${JSON.stringify(open)}+${fk}: ${againQuarter.toFixed(1)}ms at 25k, ${again.toFixed(1)}ms at 100k (measured twice)`);
        }
      }
    }
  }
  for (const s of slowScreens) console.error(`  slow screen: ${s}`);
  ok(slowScreens.length === 0, `every screen function answers 100k-character inputs inside ${LISTING_BOUND_MS}ms and grows linearly (worst ${worst.ms.toFixed(1)}ms: ${worst.name} ${JSON.stringify(worst.open)}+${worst.fk})`);
  // Control: the shape the old digit reading took 17 s on, timed the same way.
  const probe = bestOf(fns.addressesReader, "a1 " + "a".repeat(100_000));
  ok(probe < LISTING_BOUND_MS, `control: a digit-and-letter word before a 100k run of letters reads in ${probe.toFixed(1)}ms`);
  // A long run of '#' (a markdown heading marker) is read once, not retried from every '#'.
  for (const [name, fn] of [["addressesReader", fns.addressesReader], ["judgeReadableText", fns.judgeReadableText]]) {
    const hashes = bestOf(fn, "#".repeat(100_000));
    ok(hashes < LISTING_BOUND_MS, `${name}: a 100k run of '#' reads in ${hashes.toFixed(1)}ms`);
  }
}

// The plan sketch reads the task text of /api/find, /api/route and the
// connector's catalog.find before any limiter that counts work: its split
// must stay linear in the 500 characters it reads.
{
  const { splitSteps } = await import("../src/plan-sketch.js");
  // The split takes microseconds; the pattern it replaced took over 100 ms on
  // a run of spaces. Least of five on the ours clock, so a busy runner does
  // not read as slow.
  const PLAN_BOUND_MS = Number(process.env.PLAN_BOUND_MS) || 50;
  const slowPlans = [];
  for (const [name, fill] of Object.entries({ spaces: " ", tabs: "\t", commaSpace: ", ", spaceComma: " ,", newlines: "\n", thens: " then", dots: "." })) {
    const q = "a" + fill.repeat(Math.floor(498 / fill.length)) + "b";
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t = oursMs(); splitSteps(q); best = Math.min(best, oursMs() - t); }
    if (best > PLAN_BOUND_MS) slowPlans.push(`${name}: ${best.toFixed(1)}ms`);
  }
  ok(slowPlans.length === 0, `the plan sketch splits a 500-character run of each separator inside ${PLAN_BOUND_MS}ms (${slowPlans.join(", ") || "all"})`);
}

const srv = spawn(process.execPath,["--import", "./scripts/offline-egress-preload.js", "src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    FREE_MODE: "true",
    PORT: "0",
    X402_INDEX_CRAWL: "off",
    X402_SYNC_ON_START: "false",
    X402_PAYWALL_PROBES_PER_CYCLE: "0",
    AGENT402_MCP_MAX_PER_MIN: "999999",
    AGENT402_MCP_MAX_PER_HOUR: "9999999",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => { srvLog += d; });
srv.stderr.on("data", (d) => { srvLog += d; });

async function timedCall(B, job) {
  let inflight = true, maxWait = 0;
  const pinger = (async () => {
    while (inflight) {
      const t = Date.now();
      try { await (await fetch(`${B}/health`, { signal: AbortSignal.timeout(60_000) })).arrayBuffer(); } catch { /* counted by the wait */ }
      maxWait = Math.max(maxWait, Date.now() - t);
      await sleep(15);
    }
  })();
  let status = "ERR", bytes = 0;
  try {
    const r = await fetch(B + job.url, { method: job.method, headers: job.body ? { "content-type": "application/json" } : {}, body: job.body, signal: AbortSignal.timeout(60_000) });
    bytes = (await r.arrayBuffer()).byteLength;
    status = r.status;
  } catch { /* a timeout is reported through the wait */ }
  inflight = false;
  await pinger;
  return { maxWait, status, bytes };
}

try {
  let B = null;
  for (let i = 0; i < 180 && !B; i++) {
    const m = srvLog.match(/listening on :(\d+)/);
    if (m) B = `http://127.0.0.1:${m[1]}`;
    else await sleep(500);
  }
  if (!B) throw new Error(`server never came up:\n${srvLog.slice(-800)}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }
  ok(true, `offline server booted at ${B}`);
  await sleep(3000); // let boot-time work settle before measuring

  const [pricing, openapi] = await Promise.all([
    fetch(`${B}/api/pricing`).then((r) => r.json()),
    fetch(`${B}/openapi.json`).then((r) => r.json()),
  ]);
  const targets = pricing.endpoints.filter((e) =>
    (ONLY ? ONLY.has(e.slug) : true) &&
    ((FREE_TIER_SLUGS.has(e.slug) && !WALLET_ONLY_SLUGS.has(e.slug)) || e.path.startsWith("/api/skill/")));
  const jobs = [];
  const structured = structuredCorpus();
  for (const e of targets) {
    const op = openapi.paths?.[e.path]?.[e.method.toLowerCase()];
    if (!op) continue;
    // A proof-of-work tool reads nothing but its input, so no input is a 500 or a 502.
    const pure = FREE_TIER_SLUGS.has(e.slug) && !WALLET_ONLY_SLUGS.has(e.slug);
    if (e.method === "POST") {
      const c = op.requestBody?.content?.["application/json"];
      if (!c) continue;
      const ex = c.example || {};
      for (const [k, v] of Object.entries(c.schema?.properties || {})) {
        const types = [].concat(v.type || []);
        // A string field gets the string; an object or array field (or one
        // with no declared type) gets the string inside an object and a list.
        const asString = !types.length || types.includes("string");
        const asNested = !types.length || types.includes("object") || types.includes("array");
        for (const [pn, pv] of Object.entries(structured)) jobs.push({ slug: e.slug, pure, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: pv }), label: `${e.slug} ${k} ${pn}` });
        if (asString) for (const [pn, pv] of Object.entries(longCorpus(80_000))) jobs.push({ slug: e.slug, pure, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: pv }), label: `${e.slug} ${k} ${pn}` });
        if (!asString && !asNested) continue;
        for (const [pn, pv] of Object.entries(corpus(20_000))) {
          if (asString) jobs.push({ slug: e.slug, pure, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: pv }), label: `${e.slug} ${k} ${pn}` });
          if (asNested) jobs.push({ slug: e.slug, pure, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: types.includes("array") ? [pv] : { v: pv, list: [pv] } }), label: `${e.slug} ${k}.nested ${pn}` });
        }
      }
    } else if (e.method === "GET") {
      const params = (op.parameters || []).filter((p) => p.in === "query" && (!p.schema?.type || p.schema.type === "string"));
      const ex = Object.fromEntries((op.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => [p.name, String(p.example)]));
      for (const p of params) {
        for (const [pn, pv] of Object.entries({ ...corpus(4_000), ...longCorpus(4_000) })) jobs.push({ slug: e.slug, pure, method: "GET", url: `${e.path}?${new URLSearchParams({ ...ex, [p.name]: pv })}`, label: `${e.slug} ${p.name} ${pn}` });
      }
      // Every query parameter, whatever its type: the far dates, and the
      // bracket form a query parser reads as an object with a "toString" key.
      for (const p of (op.parameters || []).filter((x) => x.in === "query")) {
        for (const pn of ["farFuture", "farPast", "yearOne"]) jobs.push({ slug: e.slug, pure, method: "GET", url: `${e.path}?${new URLSearchParams({ ...ex, [p.name]: structured[pn] })}`, label: `${e.slug} ${p.name} ${pn}` });
        const rest = new URLSearchParams(Object.fromEntries(Object.entries(ex).filter(([k]) => k !== p.name)));
        jobs.push({ slug: e.slug, pure, method: "GET", url: `${e.path}?${rest}${[...rest].length ? "&" : ""}${encodeURIComponent(p.name)}%5BtoString%5D=1`, label: `${e.slug} ${p.name} noToString` });
      }
    }
  }
  // The free discovery routes read a task as text: a long run of spaces and a
  // task that is not text. Not tools, so they ride under their own names.
  for (const [name, path] of [["_find", "/api/find"], ["_route", "/api/route"]]) {
    if (ONLY && !ONLY.has(name)) continue;
    const spaces = "a" + " ".repeat(498) + "b";
    jobs.push({ slug: name, pure: true, method: "GET", url: `${path}?${new URLSearchParams({ q: spaces })}`, label: `${name} q spacesLetter` });
    jobs.push({ slug: name, pure: true, method: "POST", url: path, body: JSON.stringify({ q: spaces }), label: `${name} q spacesLetter (body)` });
    jobs.push({ slug: name, pure: true, method: "POST", url: path, body: JSON.stringify({ q: { toString: 1 } }), label: `${name} q noToString (body)` });
    jobs.push({ slug: name, pure: true, method: "GET", url: `${path}?q%5BtoString%5D=1`, label: `${name} q noToString` });
  }
  const slugs = new Set(jobs.map((j) => j.slug));
  ok(slugs.size >= (ONLY ? 1 : 100), `${jobs.length} adversarial calls across ${slugs.size} tools and skills`);

  // Baseline: a trivial call must leave /health well under the bound, or the
  // bound is measuring the runner rather than the tools.
  if (!ONLY) {
    const ctlJob = { method: "POST", url: "/api/calc", body: JSON.stringify({ expression: "1+1" }) };
    let ctl = await timedCall(B, ctlJob);
    for (let again = 0; again < REPROBES && ctl.maxWait >= BOUND_MS; again++) ctl = await timedCall(B, ctlJob);
    ok(ctl.maxWait < BOUND_MS, `control: a trivial call leaves /health answering (${ctl.maxWait}ms)`);
  }

  const slow = [], large = [], faults = [];
  let pureCalls = 0;
  const t0 = Date.now();
  for (const job of jobs) {
    let r = await timedCall(B, job);
    for (let again = 0; again < REPROBES && r.maxWait > BOUND_MS; again++) r = await timedCall(B, job);
    if (r.maxWait > BOUND_MS) slow.push(`${job.label}: loop held ${r.maxWait}ms (status ${r.status})`);
    if (r.bytes > MAX_ANSWER_BYTES) large.push(`${job.label}: ${r.bytes} bytes (status ${r.status})`);
    if (job.pure) { pureCalls++; if (r.status === 500 || r.status === 502 || r.status === "ERR") faults.push(`${job.label}: status ${r.status}`); }
  }
  for (const s of slow) console.error(`  slow: ${s}`);
  ok(slow.length === 0, `no call holds the event loop past ${BOUND_MS}ms (${jobs.length} calls in ${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const s of large) console.error(`  large: ${s}`);
  ok(large.length === 0, `no call answers more than ${MAX_ANSWER_BYTES / 1_000_000} MB`);
  for (const s of faults.slice(0, 40)) console.error(`  fault: ${s}`);
  ok(faults.length === 0, `no proof-of-work tool answers a 500 or a 502 for any input (${faults.length} of ${pureCalls} calls did)`);
  ok(srv.exitCode === null, "the server is still up after the corpus");
} catch (e) {
  failed++;
  console.error(`FAIL - ${e.message}`);
} finally {
  srv.kill("SIGKILL");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
