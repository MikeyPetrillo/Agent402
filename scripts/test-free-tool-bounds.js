#!/usr/bin/env node
// Work and output bounds of the pure-CPU tools the free tier serves. Each
// section holds the reading the tool replaced, word for word, and proves the
// bounded reading answers the same on ordinary input and stays inside a
// time and size budget on the input shape that used to grow without limit.
// Pure functions, no server.
//
//   node scripts/test-free-tool-bounds.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { API_TOOLS, RESOLVE_REFS_MAX_BYTES } from "../src/tools/api-kit.js";
import { KIT2 } from "../src/tools/kit2.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const BOUND_MS = Number(process.env.FREE_BOUND_MS) || 250;
// Best of three: a load spike on one run is not the tool's cost.
const bestOf = async (fn) => {
  let best = Infinity, out, err;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try { out = await fn(); err = undefined; } catch (e) { err = e; }
    best = Math.min(best, performance.now() - t);
    if (best > BOUND_MS * 8) break;
  }
  return { ms: best, out, err };
};
// Deterministic random numbers, so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------
// openapi-resolve-refs: shared targets resolve once, the answer is capped.
// ---------------------------------------------------------------------------
{
  const tool = API_TOOLS.find((t) => t.slug === "openapi-resolve-refs");
  // The walk as it was before the budget and the reuse.
  const lookup = (root, ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
    let cur = root;
    for (const seg of ref.slice(2).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
    return cur;
  };
  const oldWalk = (node, root, path, report) => {
    if (Array.isArray(node)) return node.map((n) => oldWalk(n, root, path, report));
    if (node && typeof node === "object") {
      if (typeof node.$ref === "string") {
        const ref = node.$ref;
        if (!ref.startsWith("#/")) { if (!report.external.includes(ref)) report.external.push(ref); return node; }
        if (path.has(ref)) { if (!report.circular.includes(ref)) report.circular.push(ref); return node; }
        const target = lookup(root, ref);
        if (target === undefined) { if (!report.unresolved.includes(ref)) report.unresolved.push(ref); return node; }
        report.resolved++;
        const next = new Set(path); next.add(ref);
        return oldWalk(target, root, next, report);
      }
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = oldWalk(v, root, path, report);
      return out;
    }
    return node;
  };
  const oldAnswer = (spec) => {
    const report = { resolved: 0, circular: [], unresolved: [], external: [] };
    const resolved = oldWalk(spec, spec, new Set(), report);
    return { spec: resolved, resolved: report.resolved, circular: report.circular, unresolved: report.unresolved, external: report.external };
  };

  ok(JSON.stringify(tool.handler(tool.discovery.input)) === JSON.stringify(tool.discovery.output.example), "resolve-refs: the published example answers as published");

  // Random specs: schemas that reference each other (cycles included), refs
  // to missing targets, external refs, refs inside arrays, refs to scalars.
  const rand = rng(20261109);
  const pick = (n) => Math.floor(rand() * n);
  let same = 0, withCycle = 0, withShared = 0;
  const RUNS = 600;
  for (let run = 0; run < RUNS; run++) {
    const n = 2 + pick(6);
    const refTo = () => {
      const r = rand();
      if (r < 0.08) return { $ref: "#/components/schemas/Missing" + pick(3) };
      if (r < 0.16) return { $ref: ["./other.yaml#/A", "https://example.com/s.json", "file:///x"][pick(3)] };
      if (r < 0.22) return { $ref: "#/info/title" };
      return { $ref: "#/components/schemas/S" + pick(n), description: "dropped sibling" };
    };
    const value = (depth) => {
      const r = rand();
      if (r < 0.45) return refTo();
      if (r < 0.6 && depth < 2) return [value(depth + 1), value(depth + 1)];
      if (r < 0.75 && depth < 2) return { type: "object", properties: { p: value(depth + 1) } };
      return [{ type: "string" }, 7, null, true, "text"][pick(5)];
    };
    const schemas = {};
    for (let i = 0; i < n; i++) schemas["S" + i] = { type: "object", properties: { a: value(0), b: value(0) }, items: rand() < 0.3 ? value(0) : undefined };
    const spec = JSON.parse(JSON.stringify({ openapi: "3.0.0", info: { title: "T" }, paths: { "/x": { get: { schema: refTo(), list: [refTo(), refTo()] } } }, components: { schemas } }));
    const want = oldAnswer(spec);
    const got = tool.handler({ spec });
    if (JSON.stringify(got) === JSON.stringify(want)) same++;
    else if (same === run) console.error(`  first difference on run ${run}: ${JSON.stringify(spec)}`);
    if (want.circular.length) withCycle++;
    if (want.resolved > n) withShared++;
  }
  ok(same === RUNS, `resolve-refs: ${same}/${RUNS} random specs answer as the full walk did (${withCycle} with a cycle, ${withShared} with a target reached more than once)`);
  ok(withCycle > 50 && withShared > 50, "resolve-refs: the random specs cover cycles and shared targets");

  // A schema referenced twice by its parent, level after level.
  const doubling = (depth) => {
    const schemas = {};
    for (let i = 0; i < depth; i++) schemas["S" + i] = { type: "object", properties: { a: { $ref: "#/components/schemas/S" + (i + 1) }, b: { $ref: "#/components/schemas/S" + (i + 1) } } };
    schemas["S" + depth] = { type: "string" };
    return { openapi: "3.0.0", paths: { "/u": { get: { schema: { $ref: "#/components/schemas/S0" } } } }, components: { schemas } };
  };
  const small = doubling(8);
  ok(JSON.stringify(tool.handler({ spec: small })) === JSON.stringify(oldAnswer(small)), "resolve-refs: eight doubling levels answer as the full walk did");
  for (const depth of [18, 24, 400]) {
    const r = await bestOf(() => tool.handler({ spec: doubling(depth) }));
    ok(r.err?.statusCode === 413 && /4 MB/.test(r.err.message), `resolve-refs: ${depth} doubling levels are refused with a 413 naming the cap (${r.err?.statusCode} ${r.err?.message})`);
    ok(r.ms < BOUND_MS, `resolve-refs: ${depth} doubling levels are refused in ${r.ms.toFixed(1)}ms`);
  }
  // The same fan-out closed into a cycle: nothing is reusable, the budget still stops it.
  const cyc = doubling(24); cyc.components.schemas.S24 = { $ref: "#/components/schemas/S0" };
  const rc = await bestOf(() => tool.handler({ spec: cyc }));
  ok(rc.err?.statusCode === 413 && rc.ms < BOUND_MS * 4, `resolve-refs: a doubling cycle is refused (${rc.err?.statusCode}) in ${rc.ms.toFixed(1)}ms`);
  // One long string referenced many times.
  const fat = { info: { description: "d".repeat(50_000) }, list: Array.from({ length: 1000 }, () => ({ $ref: "#/info/description" })) };
  const rf = await bestOf(() => tool.handler({ spec: fat }));
  ok(rf.err?.statusCode === 413, `resolve-refs: a long string referenced 1,000 times is refused (${rf.err?.statusCode})`);
  // The largest answer the cap admits is near the cap, not a multiple of it.
  let biggest = 0;
  for (let depth = 10; depth < 20; depth++) { try { biggest = Math.max(biggest, JSON.stringify(tool.handler({ spec: doubling(depth) })).length); } catch { break; } }
  ok(biggest > 500_000 && biggest < RESOLVE_REFS_MAX_BYTES * 1.5, `resolve-refs: the largest doubling answer served is ${biggest} bytes against a ${RESOLVE_REFS_MAX_BYTES}-byte cap`);
  // A shared schema used many times stays inside the cap and is served.
  const shared = { components: { schemas: { Err: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } } } }, paths: {} };
  for (let i = 0; i < 300; i++) shared.paths["/r" + i] = { get: { responses: { 400: { schema: { $ref: "#/components/schemas/Err" } }, 500: { schema: { $ref: "#/components/schemas/Err" } } } } };
  const rs = tool.handler({ spec: shared });
  ok(rs.resolved === 600 && JSON.stringify(rs) === JSON.stringify(oldAnswer(shared)), "resolve-refs: one schema referenced 600 times is served and counted 600 times");
}

// ---------------------------------------------------------------------------
// business-days: counted by arithmetic, equal to the day-by-day walk.
// ---------------------------------------------------------------------------
{
  const tool = KIT2.find((t) => t.slug === "business-days");
  const parseDate = (v) => {
    if (v === undefined || v === null || v === "now") return new Date();
    if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
    return new Date(String(v));
  };
  // The walk as it was.
  const oldAnswer = (i) => {
    const from = parseDate(i.from), to = parseDate(i.to);
    const holidays = new Set((Array.isArray(i.holidays) ? i.holidays : []).map((h) => new Date(h).toISOString().slice(0, 10)));
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    let days = 0, cur = new Date(start);
    const dir = end >= start ? 1 : -1;
    while (dir > 0 ? cur < end : cur > end) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6 && !holidays.has(cur.toISOString().slice(0, 10))) days++;
      cur.setUTCDate(cur.getUTCDate() + dir);
    }
    return { businessDays: days * dir < 0 ? -days : days, calendarDays: Math.round((end - start) / 86400000) };
  };
  ok(JSON.stringify(tool.handler(tool.discovery.input)) === JSON.stringify(tool.discovery.output.example), "business-days: the published example answers as published");

  const rand = rng(1109);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const iso = (ms) => new Date(ms).toISOString();
  // Anchor years: ordinary, two-digit, before year zero, past 9999, and both ends of the date range.
  const anchors = [() => Date.UTC(int(1900, 2100), int(0, 11), int(1, 28)), () => Date.UTC(int(1900, 2100), int(0, 11), int(1, 28)), () => new Date("00" + int(10, 99) + "-06-15T00:00:00Z").getTime(), () => Date.UTC(-int(1, 500), int(0, 11), int(1, 28)), () => Date.UTC(int(9990, 10010), int(0, 11), int(1, 28)), () => 8.64e15 - int(0, 4000) * 86400000, () => -8.64e15 + int(0, 4000) * 86400000];
  const shape = (ms) => { const r = rand(); return r < 0.5 ? iso(ms).slice(0, ms >= -62167219200000 && ms < 253402300800000 ? 10 : 13) : r < 0.75 ? iso(ms + int(0, 86399999)) : r < 0.9 && ms > 1e12 ? ms : iso(ms); };
  let same = 0, backward = 0, withHoliday = 0, hit = 0;
  const RUNS = 4000;
  for (let run = 0; run < RUNS; run++) {
    const a = anchors[int(0, anchors.length - 1)]();
    const span = int(0, 9) === 0 ? int(0, 3) : int(0, 2500);
    let b = a + (rand() < 0.3 ? -span : span) * 86400000;
    if (Math.abs(b) > 8.64e15) b = a;
    const input = { from: shape(a), to: shape(b) };
    if (rand() < 0.6) {
      input.holidays = Array.from({ length: int(0, 12) }, () => { const h = Math.min(8.64e15, Math.max(-8.64e15, Math.min(a, b) + int(-40, Math.abs(span) + 40) * 86400000)); const r = rand(); return r < 0.7 ? iso(h).slice(0, h >= -62167219200000 && h < 253402300800000 ? 10 : 13) : r < 0.85 ? iso(h) : h; });
      if (input.holidays.length && rand() < 0.2) input.holidays.push(input.holidays[0]);
    }
    const want = oldAnswer(input), got = tool.handler(input);
    if (JSON.stringify(got) === JSON.stringify(want) && Object.is(got.businessDays, want.businessDays)) same++;
    else if (same === run) console.error(`  first difference on run ${run}: ${JSON.stringify(input)} walk ${JSON.stringify(want)} count ${JSON.stringify(got)}`);
    if (b < a) backward++;
    if (input.holidays?.length) { withHoliday++; if (JSON.stringify(oldAnswer({ ...input, holidays: [] })) !== JSON.stringify(want)) hit++; }
  }
  ok(same === RUNS, `business-days: ${same}/${RUNS} random ranges count as the walk did (${backward} backward, ${withHoliday} with holidays, ${hit} where a holiday changed the count)`);
  ok(backward > 500 && hit > 500, "business-days: the random ranges cover backward spans and holidays that land on weekdays");
  for (const input of [{ from: 1e30, to: "2026-01-01" }, { from: "2026-01-01", to: 1e30 }, { from: "2026-06-08", to: "2026-06-01" }, { from: "2026-06-06", to: "2026-06-07" }, { from: "2026-06-07", to: "2026-06-06" }]) {
    ok(JSON.stringify(tool.handler(input)) === JSON.stringify(oldAnswer(input)), `business-days: ${JSON.stringify(input)} answers as the walk did (${JSON.stringify(tool.handler(input))})`);
  }
  const far = await bestOf(() => tool.handler({ from: "0001-01-01", to: "+275000-01-01", holidays: ["2026-01-01", "+010000-01-05"] }));
  ok(far.ms < 20 && far.out?.calendarDays > 99_000_000, `business-days: the widest range answers in ${far.ms.toFixed(2)}ms (${JSON.stringify(far.out)})`);
  const many = await bestOf(() => tool.handler({ from: "-271821-04-20", to: "+275760-09-13", holidays: Array.from({ length: 7000 }, (_, k) => new Date(Date.UTC(2000, 0, 1 + k)).toISOString().slice(0, 10)) }));
  ok(many.ms < BOUND_MS, `business-days: the widest range with 7,000 holidays answers in ${many.ms.toFixed(1)}ms`);
  let refused; try { tool.handler({ from: "2026-01-01", to: "2026-02-01", holidays: ["not a date"] }); } catch (e2) { refused = e2; }
  ok(refused?.statusCode === 400, `business-days: a holiday that is not a date is a 400 (${refused?.statusCode})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
