// The index's background persist and pull never hold the event loop for long,
// at production scale (about 5,800 origins and 198,000 tools, ~170 MB of
// persisted lines). Both walk every tool array: the projection, the
// stringify, the hash and, on the pull, the fold of every changed row. They
// yield on elapsed time, so the longest block stays near one slice whatever
// the catalogues weigh.
// Container B runs in its own process, as each production container does: its
// loop and its collector are measured against its own index, not a heap that
// also holds A's index and the synthetic input.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-persist-slices-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PerformanceObserver } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { requireTestPg } from "./lib/test-pg.js";
import { oursMs, OURS_READING } from "./lib/ours-clock.js";
import "./lib/uncapped-sellers.js"; // every seeded tool is kept: the large sellers here are the point
const IS_B = process.env.INDEX_SLICES_ROLE === "b";
let DIR = null;
if (!IS_B) {
  // The child inherits all of this, the test schema included.
  requireTestPg({ label: "test-index-persist-slices-pg" });
  process.env.X402_INDEX_CRAWL = "off";
  DIR = mkdtempSync(join(tmpdir(), "index-slices-pg-"));
  // No write-through: the cache file's directory does not exist, as in production
  // (the rows are the cache there).
  process.env.INDEX_CACHE_FILE = join(DIR, "absent", "x402-index-cache.json");
  process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");
}

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Production shape: a few large catalogues (the largest ~5,000 tools) and
// thousands of small ones, ~198k tools in all.
function synth({ origins = 5800, tools = 198000, fetchedAt = 1_000_000 } = {}) {
  const giants = [LARGEST_TOOLS, 3186, 2198, 2100, 1900, 1800, 1500, 1200, 1100, 1000];
  const per = (tools - giants.reduce((a, b) => a + b, 0)) / (origins - giants.length);
  const out = [];
  let left = tools;
  for (let i = 0; i < origins; i++) {
    const n = i < giants.length ? giants[i] : (i === origins - 1 ? left : Math.max(1, Math.round(per * (0.25 + 1.5 * ((i * 7919) % 1000) / 1000))));
    left -= n;
    out.push(synthOrigin(i, n, fetchedAt));
  }
  return out;
}
const LARGEST_TOOLS = 5009;
const SYNTH_WORDS = ["crypto", "price", "weather", "search", "token", "wallet", "image", "llm", "data", "news", "stock", "defi", "swap", "nft", "email", "sms", "pdf", "scrape", "translate", "agent"];
// One origin of the input: [origin, entry]. Seller 0 with LARGEST_TOOLS tools is
// the largest, which each process times as its own unit of work.
function synthOrigin(i, n, fetchedAt = 1_000_000) {
  const words = SYNTH_WORDS;
  const origin = `https://seller-${i}.example`;
  const list = new Array(n);
  for (let k = 0; k < n; k++) {
    const w = words[(i * 7 + k) % words.length], w2 = words[(i + k * 3) % words.length];
    list[k] = {
      route: `/api/${w}/${w2}/${k}`, method: k % 3 ? "GET" : "POST", name: `${w} ${w2} tool ${k}`,
      description: `Returns ${w} and ${w2} information for an agent, with pagination, filters, sorting and a cached upstream read. ` +
        `Item ${k} of seller ${i}. Answers JSON with stable field names, a request id and documented error codes; ` +
        `rate limited per payer, retried upstream once, and priced per call in USDC on the listed networks.`,
      price: `$0.00${1 + (k % 9)}`, network: "eip155:8453", payTo: "0x" + i.toString(16).padStart(8, "0").repeat(5),
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tags: [w, w2, "x402", "agent"], mimeType: "application/json", maxTimeoutSeconds: 60,
      quoteSource: "live-402", quotedAt: 1_700_000_000_000 + k, networks: ["eip155:8453", "eip155:137"],
      // Held in memory, dropped from the persisted projection (as a crawled
      // catalog's schemas are).
      inputSchema: { type: "object", properties: { q: { type: "string", description: `${w} query` }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["q"] },
      outputSchema: { type: "object", properties: { items: { type: "array" }, next: { type: "string" } } },
      example: { q: w2, limit: 10 },
    };
  }
  return [origin, { manifest: { name: `Seller ${i}`, description: "A seller", homepage: origin, x402Version: 2, network: "base" }, tools: list, fetchedAt: fetchedAt + i, error: null, source: "crawl", history: [{ at: 1, ok: true }], paywall: null, discoveryPath: "/.well-known/x402" }];
}

// The longest gap between 1 ms timer ticks while `fn` runs, less the
// collector's pauses inside it: the longest stretch our own code held the
// event loop (the production stall line reports collector time apart too).
// A gap is read on the ours clock (scripts/lib/ours-clock.js): the smaller of
// its wall length and the time the thread had a core inside it. On a runner
// busy with other lanes the thread waits for a core in the middle of a slice,
// and that wait read as a block (189 ms against a 132 ms bound on one run,
// with none of this job's work in the difference).
async function longestBlock(fn) {
  const gcs = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]); });
  obs.observe({ entryTypes: ["gc"] });
  const gaps = [];
  let last = performance.now(), lastOurs = oursMs();
  const timer = setInterval(() => { const now = performance.now(), c = oursMs(); gaps.push([last, now, c - lastOurs]); last = now; lastOurs = c; }, 1);
  let result;
  try { result = await fn(); } finally {
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(timer);
    obs.disconnect();
  }
  let ms = 0, raw = 0, at = null;
  for (const [a, b, ours] of gaps) {
    let gc = 0;
    for (const [s, e] of gcs) gc += Math.max(0, Math.min(b, e) - Math.max(a, s));
    raw = Math.max(raw, b - a);
    const held = Math.min(b - a, ours) - gc;
    if (held > ms) { ms = held; at = [a, b]; }
  }
  return { result, ms: Math.round(ms), raw: Math.round(raw), at };
}
// On a failed bound: run the job again under the sampling profiler and print
// the functions on the stack inside its longest block, so the log names what
// held the loop rather than only how long.
function calibrationSpin(ms) { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
async function explainLongestBlock(label, fn) {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 250 });
    await session.post("Profiler.start");
    // The sampler's first sample lands up to a second after start.
    await new Promise((r) => setTimeout(r, 1500));
    // The profile's clock has its own origin: a known 30 ms spin, found in
    // the samples by name, maps it onto performance.now().
    const spinAt = performance.now();
    calibrationSpin(30);
    const block = await longestBlock(fn);
    const { profile } = await session.post("Profiler.stop");
    if (!block.at) return;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const sampleTimes = [];
    { let t = profile.startTime; for (const d of profile.timeDeltas) sampleTimes.push((t += d)); }
    const onSpin = (id) => { for (let n = id; n; n = parent.get(n)) if (byId.get(n).callFrame.functionName === "calibrationSpin") return true; return false; };
    const firstSpin = profile.samples.findIndex(onSpin);
    if (firstSpin < 0) { console.error(`# ${label}: longest block ${block.ms} ms (the profile has no calibration samples)`); return; }
    const offsetMs = spinAt - sampleTimes[firstSpin] / 1000;
    const counts = new Map(), leaves = new Map();
    let inside = 0;
    profile.samples.forEach((id, i) => {
      const at = sampleTimes[i] / 1000 + offsetMs;
      if (at < block.at[0] || at > block.at[1]) return;
      inside++;
      const leaf = byId.get(id).callFrame;
      const lk = `${leaf.functionName || "(anonymous)"}${leaf.url ? ` ${leaf.url.split("/").pop().split("?")[0]}:${leaf.lineNumber + 1}` : ""}`;
      leaves.set(lk, (leaves.get(lk) || 0) + 1);
      const seen = new Set();
      for (let n = id; n; n = parent.get(n)) {
        const cf = byId.get(n).callFrame;
        if (!cf.url) continue;
        seen.add(`${cf.functionName || "(anonymous)"} ${cf.url.split("/").pop().split("?")[0]}:${cf.lineNumber + 1}`);
      }
      for (const f of seen) counts.set(f, (counts.get(f) || 0) + 1);
    });
    console.error(`# ${label}: longest block ${block.ms} ms, ${inside} samples inside it`);
    for (const [f, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.error(`#   ${String(Math.round((100 * c) / Math.max(1, inside))).padStart(3)}%  ${f}`);
    // Where each sample was running: (garbage collector), (program) and
    // native builtins carry no script, so they show only here.
    for (const [f, c] of [...leaves].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.error(`#   leaf ${String(Math.round((100 * c) / Math.max(1, inside))).padStart(3)}%  ${f}`);
  } finally { session.disconnect(); }
}

// The bound is one slice (20 ms) plus four times the largest single unit of
// work (projecting, stringifying and hashing the largest origin). The unit is
// timed on the same clock as the blocks, in the process that runs the job and
// just before each run of it, so a slower or busier machine gets a
// proportionally larger bound at the moment it is slow. The walks this
// replaces held the loop for a whole pass over every origin (all 5,800 units
// in one block, where the bound allows four).
const SLICE_MS = 20;
function largestUnitMs(origin, entry) {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = oursMs();
    const slim = { ...entry, tools: entry.tools.map((t) => { const o = { ...t }; delete o.inputSchema; delete o.outputSchema; delete o.example; return o; }) };
    const line = JSON.stringify([origin, slim]);
    createHash("sha1").update(line).digest("base64");
    JSON.parse(line);
    best = Math.min(best, oursMs() - t0);
  }
  return best;
}
// One measured run of a job: its unit first, then its longest block, held to
// the bound that unit gives.
async function boundedBlock(largest, fn) {
  const unit = largestUnitMs(...largest);
  const bound = Math.round(SLICE_MS + 4 * unit);
  const { result, ms, raw } = await longestBlock(fn);
  return { result, ms, raw, unit, bound, ok: ms < bound };
}
// Each job runs twice and passes when either run is under its own bound: the
// walk this replaces blocks on every run, and a one-off pause on a shared
// runner is not the job's own block.
const verdict = (a, b) => { const best = (!a.ok && b.ok) || (a.ok === b.ok && b.ms - b.bound < a.ms - a.bound) ? b : a; return { a, b, ok: a.ok || b.ok, ms: best.ms, raw: best.raw, bound: best.bound, unit: best.unit }; };
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };
const sellers = (m) => m.indexSnapshot(snapArgs).sellers.filter((s) => s.origin.startsWith("https://seller-")).map((s) => `${s.origin} ${s.toolCount}`).sort();
const PULL = { pageSize: 1000, maxPages: 20 };

// ---- container B: a child process answering the parent's commands ----------
async function containerB() {
  const B = await import("../src/x402-index.js");
  const largest = synthOrigin(0, LARGEST_TOOLS);
  const commands = {
    init: () => B.pullIndexChanges(), // B's watermark: it has read everything older
    warm: () => B.warmRouteIndex(),
    pull: () => boundedBlock(largest, () => B.pullIndexChanges(PULL)),
    explain: () => explainLongestBlock("pull, profiled", () => B.pullIndexChanges(PULL)),
    sellers: () => sellers(B),
    exit: () => { setImmediate(() => process.exit(0)); },
  };
  process.on("message", async ({ id, cmd }) => {
    try { process.send({ id, value: (await commands[cmd]()) ?? null }); } catch (e) { process.send({ id, error: String(e?.stack || e) }); }
  });
  process.send({ id: 0, value: "ready" });
}

async function main() {
  const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, INDEX_SLICES_ROLE: "b" }, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const waiting = new Map();
  let seq = 0;
  child.on("message", ({ id, value, error }) => { const w = waiting.get(id); if (!w) return; waiting.delete(id); if (error) w.reject(new Error(error)); else w.resolve(value); });
  child.on("exit", (code) => { for (const w of waiting.values()) w.reject(new Error(`container B exited (${code})`)); waiting.clear(); });
  const askB = (cmd) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); child.send({ id, cmd }); });
  await new Promise((resolve, reject) => { waiting.set(0, { resolve, reject }); });
  try {
    const A = await import("../src/x402-index.js");
    await askB("init");
    const data = synth();
    const toolCount = data.reduce((n, [, e]) => n + e.tools.length, 0);
    ok(toolCount === 198000 && data.length === 5800, `prod-scale input: ${data.length} origins, ${toolCount} tools`);
    ok(data[0][1].tools.length === LARGEST_TOOLS, `the largest origin, each process's unit of work, holds ${LARGEST_TOOLS} tools`);
    console.log(`# blocks and units read as ${OURS_READING}; a bound is ${SLICE_MS} ms plus four units, the unit timed before each run`);
    A.__testSeedCache(data);
    ok(await A.persistIndexCacheAsync(), "A's first save writes every origin");
    // A's route index is built now, so its own background drain (a separate
    // sliced job) is not running beside the measurements below.
    A.warmRouteIndex();

    const twice = async (fn) => verdict(await boundedBlock(data[0], fn), await boundedBlock(data[0], fn));
    const line = (v) => `longest block ${v.ms} ms against ${v.bound} ms, unit ${v.unit.toFixed(1)} ms; ${v.raw} ms of wall time with collector pauses; runs ${v.a.ms}/${v.a.bound} and ${v.b.ms}/${v.b.bound}`;

    // ---- an unchanged save: project, stringify and hash every origin ---------
    const save = await twice(() => A.persistIndexCacheAsync());
    ok(save.a.result === true && save.b.result === true, "A's unchanged saves complete");
    ok(save.ok, `the save never held the event loop past its bound (${line(save)})`);

    // ---- B folds every origin A wrote ------------------------------------------
    const pullOnce = () => askB("pull");
    const pullA = await pullOnce();
    // A re-crawls everything, so B has every origin to fold again.
    A.__testSeedCache(data.map(([o, e]) => [o, { ...e, fetchedAt: e.fetchedAt + 10_000_000 }]));
    await A.persistIndexCacheAsync();
    A.warmRouteIndex(); await askB("warm");
    const pullB = await pullOnce();
    const pull = verdict(pullA, pullB);
    ok(pull.a.result === data.length && pull.b.result === data.length, `B pulls every origin A wrote, both times (${pull.a.result}, ${pull.b.result})`);
    ok(pull.ok, `the pull never held the event loop past its bound (${line(pull)})`);

    // Same index on both sides: the slicing changed when the work runs, not what it produces.
    ok(JSON.stringify(sellers(A)) === JSON.stringify(await askB("sellers")), "B serves the same sellers and tool counts as A after the pull");
    // The largest origin is past the part size, so its row is a header and its
    // catalogue is in part rows (src/index-parts.js); read assembled.
    const row = await A._storedEntryForTest("https://seller-0.example");
    ok(row?.tools?.length === 5009 && row.tools[0].description === data[0][1].tools[0].description && row.fetchedAt === data[0][1].fetchedAt + 10_000_000, "the largest origin's stored entry holds its whole catalogue");
    ok((await sdb.records.get("x402-index", "https://seller-0.example"))?.parts?.tools === 5009, "...stored as a header naming its parts");
    // ---- a row too large for a batch: sent as UTF-8 bytes built in pieces ----
    // (the text parameter's clean and encode were each one call over the whole
    // body, 0.6-1 s on the largest seller's 84 MB row). The row stored is the
    // one the text parameter stored. A seller of the part size or fewer tools
    // is one row whatever it weighs, so this one stays under it.
    {
      const { cleanPgText } = sdb;
      const bigOrigin = "https://seller-big.example";
      // (The persisted projection cuts a description at 400 characters; the
      // weight sits in the name so the row passes two megabytes.)
      const tools = Array.from({ length: 2000 }, (_, k) => ({ route: `/api/big/${k}`, method: "GET", name: `big tool ${k} 漢字 é \u{1F600} ${"ü".repeat(500)} ${"x".repeat(500)}`, description: `Item ${k}: ${"ü".repeat(200)} ${"x".repeat(190)}`, price: "$0.001", network: "eip155:8453", tags: ["big"] }));
      A._cacheForTests().set(bigOrigin, { manifest: { name: "Big" }, tools, fetchedAt: 5_000_000, error: null, source: "crawl", history: [], paywall: null, discoveryPath: "/.well-known/x402" });
      const line = A._persistedLineForTest(bigOrigin);
      const h = createHash("sha1").update(line).digest("base64");
      const entryText = line.slice(JSON.stringify(bigOrigin).length + 2, -1);
      const textBody = cleanPgText(`${entryText.slice(0, -1)},"contentHash":${JSON.stringify(h)}}`);
      const p0 = A._rowBytesPiecesForTest();
      const big = await boundedBlock(data[0], () => A.persistIndexCacheAsync());
      const pieces = A._rowBytesPiecesForTest() - p0;
      ok(big.result === true && line.length > 2 * 1048576 && pieces >= Math.ceil(entryText.length / 1048576), `a ${(line.length / 1048576).toFixed(1)} MB row is sent in ${pieces} encoded pieces`);
      ok(big.ok, `...and that save never held the event loop past ${big.bound} ms (longest block ${big.ms} ms, unit ${big.unit.toFixed(1)} ms; ${big.raw} ms of wall time with collector pauses)`);
      const r = await sdb.stateQuery(`SELECT body::text = $2::jsonb::text AS same, body->>'contentHash' AS h FROM ${sdb.stateDbSchema()}.records WHERE collection = 'x402-index' AND id = $1`, [bigOrigin, textBody]);
      ok(r.rows[0]?.same === true && r.rows[0].h === h, "the stored row equals the row the text parameter stores, its hash included");
    }

    // Last, as it rewrites every row: a failed pull bound is run again under the profiler.
    if (!pull.ok) {
      A.__testSeedCache(data.map(([o, e]) => [o, { ...e, fetchedAt: e.fetchedAt + 20_000_000 }]));
      await A.persistIndexCacheAsync();
      A.warmRouteIndex(); await askB("warm");
      await askB("explain");
    }
    A.stopCrawler?.();
  } catch (e) {
    fail++; console.error("FAIL - threw:", e?.stack || e);
  } finally {
    await askB("exit").catch(() => {});
    if (child.exitCode === null) child.kill();
    await sdb.__dropStateSchema().catch(() => {});
    await sdb.closeStateDb();
    rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\ntest-index-persist-slices-pg: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (IS_B) await containerB(); else await main();
