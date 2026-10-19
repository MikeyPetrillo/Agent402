#!/usr/bin/env node
// Correctness corpus: drive every tool with inputs OTHER than its documented
// example and assert the answer is populated, not merely shaped.
//
// Why this exists (2026-09-06): every guard we own drives the ONE published
// example per tool and asserts its shape. A charged 200 with nothing in it
// passes all of them - gov-data answered a plausible query with zero rows,
// demand-radar sold an empty radar for six weeks, Kalshi renamed its fields and
// every price came back null. Outsiders found each one by trying a second
// input. The paid canaries do not help here: they prove settlement, not that
// the tool works. This runs on a FREE_MODE boot, pays nothing, and for most of
// the catalog reaches nothing that bills.
//
// Corpus files: scripts/corpus/*.json  ->  { "pace"?: ms, "cases": [ { slug, name, input,
// expect: { status?, populated?, equals?, count?, minCount?, maxCount?,
// matches?, truthy?, falsy?, empty? }, requires? } ] }
//   populated: paths that must exist and be non-null / non-empty
//   equals:    { path: value } exact (deep) equality
//   count / minCount / maxCount: { path: n } array length (or object keys)
//   matches:   { path: "regex" } on String(value)
//   truthy / falsy: paths
//   empty:     paths that must be an empty array (the honest-empty case, paired
//              with `populated` on the count/note the tool must carry)
//   status:    expected HTTP status (default 200); a 4xx case asserts the
//              refusal is self-explaining (body.error present)
//   requires:  "payer" (identity-bound: skipped on a free boot) | an env var
//              name the tool needs (skipped as not-configured without it)
//
// Tiers are DERIVED, never declared: T0 = computePayable on /api/pricing
// (pure CPU, $0), T2 = METERED_SLUGS (paid upstream), T1 = everything else
// (free public upstreams). Default runs T0+T1; T2 needs --tier 2 or all.
//
// Classification (the probe-classify doctrine): an expectation miss, our own
// 4xx on a valid input, or a 500 is FATAL; 502/503/504/429 and network errors
// are UPSTREAM (reported, never fatal); a 503 "not configured" on a keyless
// boot is SKIPPED. A control case with a planted wrong expectation runs FIRST
// and the run refuses to report clean unless the harness caught it.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-corpus.js [--tier 0|1|2|all]
//     [--only slug,slug] [--file name] [--json out.json] [--concurrency 4]
//   (no TARGET_URL: boots its own FREE_MODE server on a free port)
import { createWriteStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { METERED_SLUGS } from "./test-non-metered-examples.js";
import { getFreePort } from "./lib/free-port.js";
import { RUGCHECK_SLUGS, rugcheckEnabled } from "../src/rugcheck-switch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, "corpus");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const TIER = String(opt("--tier", "0,1"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
const FILE = opt("--file", "");
const JSON_OUT = opt("--json", "");
const CONCURRENCY = Math.max(1, parseInt(opt("--concurrency", "4"), 10) || 4);
const TIMEOUT_MS = Math.max(5000, parseInt(opt("--timeout", "60000"), 10) || 60000);
const VERBOSE = args.includes("--verbose");
// --server-log <path>: the self-booted server's stdout+stderr, appended live.
// Without it the boot log is kept only until /health answers and a kit's own
// "[price-feed] upstream unreachable: … → TimeoutError" line (the one fact
// that separates a slow upstream from a blocked event loop) is lost.
const SERVER_LOG = opt("--server-log", "");

// ---------------------------------------------------------------- helpers
export function getPath(obj, p) {
  const parts = String(p).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const k of parts) { if (cur === null || cur === undefined) return undefined; cur = cur[k]; }
  return cur;
}
const isEmptyish = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) || (typeof v === "number" && Number.isNaN(v));
const lengthOf = (v) => Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : (typeof v === "string" ? v.length : NaN));
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Evaluate one case's expectations against a response. Returns [] when clean. */
export function checkExpect(expect, status, body) {
  const e = expect || {};
  const fails = [];
  const want = Number(e.status ?? 200);
  if (status !== want) { fails.push(`status ${status}, expected ${want}`); return fails; }
  if (want >= 400) {
    if (!body || typeof body !== "object" || !("error" in body)) fails.push("refusal carries no `error`");
    if (e.matches) for (const [p, re] of Object.entries(e.matches)) if (!new RegExp(re, "i").test(String(getPath(body, p)))) fails.push(`${p} !~ /${re}/i (got ${JSON.stringify(getPath(body, p)).slice(0, 80)})`);
    return fails;
  }
  for (const p of e.populated || []) { const v = getPath(body, p); if (isEmptyish(v)) fails.push(`${p} not populated (${JSON.stringify(v)})`); }
  for (const p of e.empty || []) { const v = getPath(body, p); if (!(Array.isArray(v) && v.length === 0)) fails.push(`${p} expected [] (got ${JSON.stringify(v)?.slice(0, 60)})`); }
  for (const [p, v] of Object.entries(e.equals || {})) { const g = getPath(body, p); if (!deepEq(g, v)) fails.push(`${p} = ${JSON.stringify(g)?.slice(0, 80)}, expected ${JSON.stringify(v)}`); }
  for (const [p, n] of Object.entries(e.count || {})) { const l = lengthOf(getPath(body, p)); if (l !== n) fails.push(`${p} length ${l}, expected ${n}`); }
  for (const [p, n] of Object.entries(e.minCount || {})) { const l = lengthOf(getPath(body, p)); if (!(l >= n)) fails.push(`${p} length ${l}, expected >= ${n}`); }
  for (const [p, n] of Object.entries(e.maxCount || {})) { const l = lengthOf(getPath(body, p)); if (!(l <= n)) fails.push(`${p} length ${l}, expected <= ${n}`); }
  for (const [p, re] of Object.entries(e.matches || {})) { const v = getPath(body, p); if (!new RegExp(re, "i").test(String(v))) fails.push(`${p} !~ /${re}/i (got ${JSON.stringify(v)?.slice(0, 80)})`); }
  for (const p of e.truthy || []) if (!getPath(body, p)) fails.push(`${p} not truthy (${JSON.stringify(getPath(body, p))})`);
  for (const p of e.falsy || []) if (getPath(body, p)) fails.push(`${p} not falsy (${JSON.stringify(getPath(body, p))?.slice(0, 60)})`);
  for (const [p, n] of Object.entries(e.gt || {})) { const v = Number(getPath(body, p)); if (!(v > n)) fails.push(`${p} = ${v}, expected > ${n}`); }
  for (const [p, n] of Object.entries(e.gte || {})) { const v = Number(getPath(body, p)); if (!(v >= n)) fails.push(`${p} = ${v}, expected >= ${n}`); }
  for (const [p, n] of Object.entries(e.lt || {})) { const v = Number(getPath(body, p)); if (!(v < n)) fails.push(`${p} = ${v}, expected < ${n}`); }
  return fails;
}

const NOT_CONFIGURED = /not configured|not set|not installed on this server|missing api key|no api key|OPENROUTER_API_KEY|BRAVE_API_KEY|E2B_API_KEY|X402_UPSTREAM_BUYER_KEY|ALCHEMY_API_KEY|OPENAI_API_KEY|COINGECKO_API_KEY|FRED_API_KEY|unavailable on this server|requires a key/i;
// Deliberately narrow: only network-class words. "upstream", "timeout" and
// "aborted" appear in OUR OWN 4xx messages, and a 4xx that names the input is
// ours (independent review, 2026-09-06).
const UPSTREAM_TEXT = /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|rate.?limit|too many requests|Source URL (timed out|returned HTTP 5\d\d|is unreachable)/i;

// A host we operate: a reading of it is a reading of us.
const isOurHost = (h) => h === "agent402.tools" || h.endsWith(".agent402.tools");

/** The outside host a case's input points the tool at (the first http(s) URL
 *  in the input whose host is not ours), or null. A case with an outside
 *  target depends on that host for its expected value, so that host's own
 *  5xx or silence must be reported as upstream, named, and never as our code
 *  (2026-10-12: httpbin.org answered 503 to a 404 probe and the corpus paged
 *  http-check as broken). */
export function targetHostOf(input) {
  let found = null;
  const walk = (v) => {
    if (found) return;
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      try { const h = new URL(v).hostname.toLowerCase(); if (h && !isOurHost(h)) found = h; } catch { /* not a URL */ }
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return found;
}

/** A 200 whose body says the TARGET failed: http-check's `up`/`status`
 *  reading of a 5xx, an `up:false` with the target's error, or an error text
 *  in the network vocabulary. Null when the body says nothing of the kind, so
 *  a hollow 200 stays ours. */
function targetFailureIn(body) {
  if (!body || typeof body !== "object") return null;
  if ("up" in body && Number.isInteger(body.status) && body.status >= 500 && body.status < 600) return `answered ${body.status}`;
  const err = String(body.error ?? body.message ?? "");
  if (body.up === false && err) return err.slice(0, 120);
  if (err && UPSTREAM_TEXT.test(err)) return err.slice(0, 120);
  return null;
}

/** Pace scheduling, pure: reserve the next start slot on the case's clock and
 *  return how long to wait for it. `paceNext` maps paceKey -> next free ms.
 *  A case with no pace never waits and never advances any clock. */
export function paceWaitMs(c, paceNext, now) {
  if (!(c.pace > 0)) return 0;
  const key = c.paceKey || c.file;
  const at = Math.max(now, paceNext.get(key) || 0);
  paceNext.set(key, at + c.pace);
  return at - now;
}

/** What one outcome says about OUR code. `targetHost` is the outside host the
 *  case points the tool at (targetHostOf), or null for a tool on fixed or no
 *  upstreams. */
export function classify({ status, body, netError, expectFails, tier, targetHost = null }) {
  if (netError) return { kind: "upstream", note: `network: ${netError}` };
  const msg = String(body?.error ?? body?.message ?? "");
  // A keyless boot: a 503 that says so, or a pack's 502 whose steps all say so
  // (the equities feed went key-gated on 2026-09-20 and three packs read as
  // "upstream" every night after), is configuration, not a verdict.
  if ((status === 503 || status === 502) && NOT_CONFIGURED.test(msg)) return { kind: "skipped", note: "not configured on this boot" };
  const host = targetHost && tier !== 0 ? ` (outside host ${targetHost})` : "";
  if (status === 502 || status === 503 || status === 504 || status === 429) return { kind: tier === 0 ? "fatal" : "upstream", note: `${status}${host} ${msg.slice(0, 120)}` };
  if (status >= 500) return { kind: "fatal", note: `${status} ${msg.slice(0, 160)}` };
  if (expectFails.length) {
    // A 200 that reports the case's own outside target failing is that host's
    // outage, named; without a target host the same body is our hollow 200.
    if (targetHost && tier !== 0 && status < 400) {
      const tf = targetFailureIn(body);
      if (tf) return { kind: "upstream", note: `outside host ${targetHost} ${tf}` };
    }
    // A 4xx from a T1 tool whose message blames the network is upstream.
    if (status >= 400 && tier !== 0 && UPSTREAM_TEXT.test(msg) && !NOT_CONFIGURED.test(msg)) return { kind: "upstream", note: `${status}${host} ${msg.slice(0, 120)}` };
    return { kind: "fatal", note: expectFails.join("; ") };
  }
  return { kind: "ok", note: "" };
}

// ---------------------------------------------------------------- loading
function loadCorpus() {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json") && (!FILE || f === FILE || f === `${FILE}.json`)).sort();
  const cases = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(path.join(CORPUS_DIR, f), "utf8"));
    const docPace = Number(doc.pace) > 0 ? Number(doc.pace) : 0;
    // A pace clock is keyed by `paceKey` (default: the file), so cases that
    // share one rate-limited upstream can share ONE clock across files: the
    // CoinGecko cases live in three files, and three per-file clocks at 3 s
    // each started 60/min against a 25/min bucket (nightly 2026-09-06: 13
    // cases never verified). A case may override both fields.
    const docKey = typeof doc.paceKey === "string" && doc.paceKey ? doc.paceKey : f;
    for (const c of doc.cases || []) {
      if (!c.slug || !c.name) throw new Error(`${f}: every case needs slug + name`);
      const pace = Number(c.pace) > 0 ? Number(c.pace) : docPace;
      const paceKey = typeof c.paceKey === "string" && c.paceKey ? c.paceKey : docKey;
      cases.push({ ...c, file: f, pace, paceKey });
    }
  }
  return cases;
}

async function bootServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.join(HERE, ".."),
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", SOLANA_LEADERBOARD: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const sink = SERVER_LOG ? createWriteStream(SERVER_LOG, { flags: "a" }) : null;
  const onData = (d) => { log += d; if (sink) sink.write(d); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return { base, child }; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not answer /health in 120s\n${log.slice(-2000)}`);
}

// ---------------------------------------------------------------- driving
async function drive(base, ep, input) {
  const method = ep.method.toUpperCase();
  let url = `${base}${ep.path}`;
  const init = { method, headers: {}, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input || {})) qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const q = qs.toString();
    if (q) url += `?${q}`;
  } else {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(input || {});
  }
  const t0 = Date.now();
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") || "";
  let body;
  if (/json/.test(ct)) { try { body = await res.json(); } catch { body = null; } }
  else { const buf = Buffer.from(await res.arrayBuffer()); body = { __binary: true, contentType: ct, bytes: buf.length }; }
  return { status: res.status, body, ms: Date.now() - t0 };
}

async function main() {
  const cases = loadCorpus();
  let base = process.env.TARGET_URL?.replace(/\/+$/, "") || "";
  let child = null;
  if (!base) ({ base, child } = await bootServer());
  try {
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const eps = new Map(pricing.endpoints.map((e) => [e.slug, e]));
    const tierOf = (slug) => { const e = eps.get(slug); if (!e) return null; if (METERED_SLUGS.has(slug)) return 2; return e.computePayable ? 0 : 1; };
    const wantTiers = TIER === "all" ? new Set([0, 1, 2]) : new Set(TIER.split(",").map((t) => parseInt(t, 10)));
    const configured = (c) => !c.requires || c.requires === "payer" || !!process.env[c.requires];

    // Control: the harness must catch a planted wrong expectation before a
    // clean run is believed. `/api/hash` is pure CPU and always present.
    const control = await drive(base, eps.get("hash"), { text: "control", algo: "sha256" });
    const controlFails = checkExpect({ populated: ["hex", "definitely-not-a-field"], equals: { algo: "md5" } }, control.status, control.body);
    if (controlFails.length < 2) { console.error(`CONTROL FAILED: harness did not catch the planted expectation (${JSON.stringify(controlFails)})`); process.exit(2); }
    console.log(`control: harness caught ${controlFails.length} planted misses (ok)`);

    const selected = cases.filter((c) => (!ONLY || ONLY.has(c.slug)));
    const results = [];
    const paceNext = new Map();
    const counts = { ok: 0, fatal: 0, upstream: 0, skipped: 0, filtered: 0, unknown: 0 };
    let i = 0;
    const worker = async () => {
      while (i < selected.length) {
        const c = selected[i++];
        const ep = eps.get(c.slug);
        if (!ep) {
          // An ENV-GATED tool is legitimately absent from an unkeyed boot: the
          // kit lists nothing without its key, so "not in catalog" here is the
          // configuration, not a defect. Skip it the same way a configured-but-
          // unkeyed case is skipped. A case with NO `requires` that is missing
          // from the catalog stays UNKNOWN and still fails the run - that is a
          // retired or renamed tool, which is exactly what this check is for.
          if (c.requires && c.requires !== "payer" && !process.env[c.requires]) {
            results.push({ ...c, kind: "skipped", note: `needs ${c.requires} (kit not listed on this boot)` });
            counts.skipped++;
            continue;
          }
          // The RugCheck-backed tools are listed only while their data-source
          // switch is on (src/rugcheck-switch.js); off, they are configuration,
          // not a retired or renamed tool.
          if (RUGCHECK_SLUGS.has(c.slug) && !rugcheckEnabled()) {
            results.push({ ...c, kind: "skipped", note: "RUGCHECK_TOOLS is off on this boot (tool not listed)" });
            counts.skipped++;
            continue;
          }
          results.push({ ...c, kind: "unknown", note: "slug not in catalog" }); counts.unknown++; console.log(`?? ${c.slug} [${c.name}]: not in catalog`); continue;
        }
        const tier = tierOf(c.slug);
        if (!wantTiers.has(tier)) { counts.filtered++; continue; }
        if (c.requires === "payer" && !process.env.CORPUS_PAYER) { results.push({ ...c, tier, kind: "skipped", note: "identity-bound (no payer on a free boot)" }); counts.skipped++; continue; }
        if (!configured(c)) { results.push({ ...c, tier, kind: "skipped", note: `needs ${c.requires}` }); counts.skipped++; continue; }
        // A file (or case) may declare `pace` (ms): cases on the same
        // `paceKey` clock start no closer together than that, whatever the
        // concurrency - rate-limited upstreams (CoinGecko demo: 30/min shared)
        // otherwise read as failures.
        const wait = paceWaitMs(c, paceNext, Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        let out;
        try { out = await drive(base, ep, c.input); }
        catch (err) { out = { status: 0, body: null, ms: 0, netError: err?.cause?.code || err?.name || String(err) }; }
        const fails = out.netError ? [] : checkExpect(c.expect, out.status, out.body);
        const cls = classify({ status: out.status, body: out.body, netError: out.netError, expectFails: fails, tier, targetHost: targetHostOf(c.input) });
        counts[cls.kind]++;
        const row = { slug: c.slug, name: c.name, file: c.file, tier, status: out.status, ms: out.ms, kind: cls.kind, note: cls.note };
        if (cls.kind === "fatal" || VERBOSE) row.body = JSON.stringify(out.body)?.slice(0, 600);
        results.push(row);
        const tag = { ok: "ok", fatal: "FAIL", upstream: "upstream", skipped: "skip" }[cls.kind] || cls.kind;
        console.log(`${tag.padEnd(8)} T${tier} ${c.slug} [${c.name}] ${out.status} ${out.ms}ms${cls.note ? ` - ${cls.note}` : ""}`);
        if (cls.kind === "fatal") console.log(`         body: ${row.body}`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const driven = counts.ok + counts.fatal + counts.upstream;
    console.log(`\ncorpus: ${selected.length} cases selected; ok ${counts.ok}, FAIL ${counts.fatal}, upstream ${counts.upstream}, skipped ${counts.skipped}, tier-filtered ${counts.filtered}, unknown ${counts.unknown}`);
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), base, counts, results }, null, 2));
    // Silence is not success: a run that drove almost nothing must not pass.
    // Explicit skips (no key on this boot, identity-bound) are accounted for;
    // what must never pass is a run that drove nothing for no stated reason.
    const accounted = driven + counts.skipped + counts.filtered;
    if (selected.length && accounted < selected.length * 0.5 && !ONLY) { console.error(`corpus: only ${accounted} of ${selected.length} cases were driven or skipped for a reason; refusing to report clean`); process.exit(1); }
    if (driven === 0 && selected.length) { console.error(`corpus: nothing driven (${counts.skipped} skipped, ${counts.filtered} tier-filtered) - a run that measured nothing is not a pass`); process.exit(1); }
    // An upstream storm is not a pass either: if most of what was driven came
    // back as "upstream", the run learned nothing about our code.
    if (counts.upstream > driven / 2) { console.error(`corpus: ${counts.upstream} of ${driven} driven cases were upstream failures - refusing to report clean`); process.exit(1); }
    process.exit(counts.fatal || counts.unknown ? 1 : 0);
  } finally {
    if (child) child.kill("SIGTERM");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
