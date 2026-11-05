#!/usr/bin/env node
// A bad seller listing fails alone, never the process.
//
// The route index drains crawled entries on setImmediate turns, and a throw
// there reaches process.on("uncaughtException"), which src/server.js keeps
// fatal. One crawled tool whose field could not be read as text restarted
// production every few minutes until that field was read as text. This suite
// pins the class: a listing whose rows throw when read is dropped alone,
// counted by origin, and the process, the drain, a shadow rebuild and every
// other seller's query go on.
//
// The poison: a tool object with an own enumerable accessor property that
// throws when read. The cache's cleaning (cleanSellerEntry) reads only the
// named text and list keys, so the entry is stored as is; decorateRow's spread
// of the tool reads every own enumerable property and throws there, inside
// routeIndexAddEntry, on the real drain, shadow and query paths. A listing
// that arrives over HTTP is parsed JSON and cannot carry an accessor, so the
// entry is planted in the booted server's own module through a preloaded
// probe (NODE_OPTIONS --import) asked over the IPC channel.
//
// Section 1 boots the server. Section 2 runs a tiny Express 5 app: a handler
// that rejects answers 500 for that request alone (asserted, not assumed).
// Section 3 is the control: the same poison against copies of the module with
// the containment removed, step by step, so the suite proves it is the
// containment that keeps the process up.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { childJson } from "./lib/child-json.js";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SRC = join(ROOT, "src");
const dir = mkdtempSync(join(tmpdir(), "a402-contain-"));
const GOOD = "https://good-vision.example";
const POISON = "https://poison-vision.example";
const POISON2 = "https://poison-late.example";
const STATICS = "https://poison-statics.example";
const STATICS2 = "https://poison-statics-late.example";
const FORGED = "https://forged-list.example";
const WIDE = 40; // sellers planted while every row's statics throw
const TOKEN = "crash-containment-operator-token-0123456789";

// The seller entries, built inside the child (an accessor cannot cross a
// process boundary): a well-formed seller and one whose tool throws when read.
const ENTRIES_JS = `
const tool = (origin, over = {}) => ({ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing from an image", category: "vision", tags: ["ocr"], price: 0.003, ...over });
export const entry = (origin, tools) => ({ manifest: { name: origin.replace(/^https:\\/\\//, "").split(".")[0] + " vision", homepage: origin }, openapiSummary: null, tools, fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
export function poisonTool(origin) {
  const t = tool(origin);
  Object.defineProperty(t, "pricing", { enumerable: true, configurable: true, get() { throw new TypeError("poison: a seller field that cannot be read"); } });
  return t;
}
export const goodEntry = (origin) => entry(origin, [tool(origin)]);
// A row whose decoration and cleaning read fine and whose statics throw. No
// seller field can do that any more (every field statics reads is cleaned to
// text or a number), so the throw is planted inside computeToolStatics by its
// test hook, for this slug only, and travels the real sentinel paths.
export function staticsPoisonTool(origin) {
  return tool(origin, { slug: "ocr-statics" });
}
export const staticsPoisonEntry = (origin) => entry(origin, [tool(origin, { slug: "ocr-statics-fine" }), staticsPoisonTool(origin)]);
export const poisonEntry = (origin) => entry(origin, [tool(origin, { slug: "ocr-fine" }), poisonTool(origin)]);
`;
writeFileSync(join(dir, "entries.mjs"), ENTRIES_JS);

// --- 1. the booted server -----------------------------------------------------
// The probe runs in the server's main thread and plants entries on request.
const PROBE = join(dir, "probe.mjs");
writeFileSync(PROBE, `
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
if (isMainThread && typeof process.send === "function") {
  const src = process.env.CONTAIN_SRC_DIR;
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {} };
  let x = null, ct = null, E = null;
  const load = async () => {
    x ||= await import(pathToFileURL(src + "/x402-index.js").href);
    ct ||= await import(pathToFileURL(src + "/contained-turn.js").href);
    E ||= await import(${JSON.stringify(pathToFileURL(join(dir, "entries.mjs")).href)});
  };
  const settled = async () => {
    for (let i = 0; i < 20000; i++) {
      const s = x._routeIndexStatsForTest();
      if (!s.pending && !s.partial) return s;
      await new Promise((r) => setImmediate(r));
    }
    return x._routeIndexStatsForTest();
  };
  const report = (id, extra) => process.send({ id, stats: x._routeIndexStatsForTest(), broken: x.brokenListingsSummary(), contained: ct.containedTurnsSummary(), ...extra });
  process.on("message", async (m) => {
    try {
      await load();
      const cache = x._cacheForTests();
      if (m.cmd === "plant") {
        cache.set(${JSON.stringify(GOOD)}, E.goodEntry(${JSON.stringify(GOOD)}));
        cache.set(${JSON.stringify(POISON)}, E.poisonEntry(${JSON.stringify(POISON)}));
        const after = await settled();
        report(m.id, { after });
      } else if (m.cmd === "shadow") {
        const before = x._routeIndexStatsForTest().builds;
        x._routeIndexStartShadowForTest();
        await x._routeIndexSettledForTest();
        report(m.id, { before });
      } else if (m.cmd === "query-pending") {
        // A second poison planted and queried in the same turn: the query meets
        // it in the pending set, before any drain turn has seen it.
        cache.set(${JSON.stringify(POISON2)}, E.poisonEntry(${JSON.stringify(POISON2)}));
        const pendingBefore = x._routeIndexStatsForTest().pending;
        let r = null, err = null;
        try { r = x.routeQuery({ query: "ocr a thing from an image", top: 50, include: "external", ...ctx }); } catch (e) { err = String(e && e.message || e); }
        report(m.id, { pendingBefore, err, sellers: (r && r.results || []).map((t) => t.seller) });
      } else if (m.cmd === "shadow-finish-fault") {
        // The rebuild's finish throws once: the build is abandoned and the
        // shadow cleared, so the next rebuild runs and swaps in.
        const before = x._routeIndexStatsForTest().builds;
        x._setShadowFinishFaultForTest(new Error("planted shadow finish fault"));
        x._routeIndexStartShadowForTest();
        let turns = 0;
        while (x._routeIndexStatsForTest().rebuilding && turns < 20000) { turns++; await new Promise((r) => setImmediate(r)); }
        const afterFault = x._routeIndexStatsForTest();
        const containedAfterFault = ct.containedTurnsSummary().byName["route-index-shadow"] || null;
        x._routeIndexStartShadowForTest();
        turns = 0;
        while (x._routeIndexStatsForTest().rebuilding && turns < 20000) { turns++; await new Promise((r) => setImmediate(r)); }
        report(m.id, { before, afterFault, containedAfterFault, afterRetry: x._routeIndexStatsForTest() });
      } else if (m.cmd === "statics-poison") {
        // A row whose statics throw inside computeToolStatics (not in
        // decoration): the drain indexes the entry's other row and skips it.
        const skippedBefore = x.brokenListingsSummary().toolsSkipped;
        x._setToolStaticsFaultForTest(new TypeError("poison-statics: a row whose statics throw"), (t) => t.slug === "ocr-statics");
        cache.set(${JSON.stringify(STATICS)}, E.staticsPoisonEntry(${JSON.stringify(STATICS)}));
        const after = await settled();
        const skippedAfterDrain = x.brokenListingsSummary().toolsSkipped;
        // A second one queried in the same turn it is planted: the query
        // meets it in the pending set and skips its broken row there.
        cache.set(${JSON.stringify(STATICS2)}, E.staticsPoisonEntry(${JSON.stringify(STATICS2)}));
        const pendingBefore = x._routeIndexStatsForTest().pending;
        let r = null, err = null;
        try { r = x.routeQuery({ query: "ocr a thing from an image", top: 50, include: "external", ...ctx }); } catch (e) { err = String(e && e.message || e); }
        x._setToolStaticsFaultForTest(null);
        report(m.id, { after, skippedBefore, skippedAfterDrain, pendingBefore, err, results: (r && r.results || []).map((t) => [t.seller, t.slug]) });
      } else if (m.cmd === "forged") {
        // One listing whose 30 rows each name another seller in their own
        // seller field, every row's statics throwing: one origin, the cache key.
        x._setToolStaticsFaultForTest(new TypeError("forged rows"), (t) => String(t.route).startsWith("/api/forged-"));
        cache.set(${JSON.stringify(FORGED)}, E.entry(${JSON.stringify(FORGED)}, Array.from({ length: 30 }, (_, k) => ({ seller: "https://forged-seller-" + k + ".example", method: "GET", route: "/api/forged-" + k, slug: "forged-" + k, name: "ocr forged " + k, description: "ocr a thing from an image", price: 0.001 }))));
        const after = await settled();
        let r = null, err = null;
        try { r = x.routeQuery({ query: "ocr a thing from an image", top: 50, include: "external", ...ctx }); } catch (e) { err = String(e && e.message || e); }
        x._setToolStaticsFaultForTest(null);
        report(m.id, { after, err, status: x.brokenListingsStatus({ full: true }) });
      } else if (m.cmd === "widespread") {
        // A code bug that breaks every listing: every row's statics throw.
        x._setToolStaticsFaultForTest(new TypeError("planted statics fault for every row"));
        for (let i = 0; i < ${WIDE}; i++) cache.set("https://wide-" + i + ".example", E.goodEntry("https://wide-" + i + ".example"));
        const after = await settled();
        let r = null, err = null;
        try { r = x.routeQuery({ query: "ocr a thing from an image", top: 100, include: "external", ...ctx }); } catch (e) { err = String(e && e.message || e); }
        report(m.id, { after, err, sellers: (r && r.results || []).map((t) => t.seller), indexed: cache.size });
      } else if (m.cmd === "clear-fault") {
        x._setToolStaticsFaultForTest(null);
        report(m.id, {});
      } else if (m.cmd === "fault") {
        x._setRouteQueryFaultForTest(new Error("planted handler fault"));
        report(m.id, {});
      } else if (m.cmd === "summary") {
        report(m.id, {});
      } else process.send({ id: m.id, error: "unknown command " + m.cmd });
    } catch (e) { process.send({ id: m.id, error: String(e && e.stack || e) }); }
  });
}
`);

const serverEnv = {
  ...process.env, ...ownStoreEnv("crash-containment"),
  FREE_MODE: "true", PORT: "0", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
  X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", REDIS_URL: "", STATE_DATABASE_URL: "",
  ROUTER_WORKERS: "0", LOAD_SHED: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", LAZY_DEPS_WARM: "off",
  AGENT402_OPERATOR_TOKEN: TOKEN, CONTAIN_SRC_DIR: SRC,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${pathToFileURL(PROBE).href}`.trim(),
};
let proc = null;
let stderr = "";
let stdout = "";
let ipcSeq = 0;
const ask = (cmd) => new Promise((resolve, reject) => {
  const id = ++ipcSeq;
  const timer = setTimeout(() => { proc.off("message", on); reject(new Error(`the probe did not answer ${cmd} in 20 s`)); }, 20_000);
  function on(m) { if (m?.id === id) { clearTimeout(timer); proc.off("message", on); m.error ? reject(new Error(m.error)) : resolve(m); } }
  proc.on("message", on);
  proc.send({ cmd, id });
});
try {
  proc = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", (d) => { stderr += d; });
  let port = 0;
  for (let i = 0; i < 600 && !port; i++) {
    const m = stdout.match(/listening on :(\d+)/);
    if (m) port = Number(m[1]);
    else if (proc.exitCode !== null) break;
    else await sleep(100);
  }
  ok(port > 0, `server booted on port ${port}`);
  const base = `http://127.0.0.1:${port}`;
  const op = { headers: { authorization: `Bearer ${TOKEN}` } };
  const alive = async () => { try { return (await fetch(`${base}/health`)).ok && proc.exitCode === null; } catch { return false; } };
  ok(await alive(), "health answers before anything is planted");

  // The drain turn meets the poison.
  const planted = await ask("plant");
  ok(proc.exitCode === null && (await alive()), "the process is alive after the drain turn that read the poison listing");
  ok(planted.after && !planted.after.pending && !planted.after.partial, `the drain finished (pending ${planted.after?.pending}, partial ${planted.after?.partial})`);
  ok(planted.after?.indexedTools >= 1, `the well-formed seller was indexed (${planted.after?.indexedTools} tools indexed)`);
  ok(planted.broken.byOrigin[POISON]?.count >= 1 && /poison/.test(planted.broken.byOrigin[POISON]?.lastMessage || ""), `the poison listing is counted by origin with its message (${planted.broken.byOrigin[POISON]?.count}, "${planted.broken.byOrigin[POISON]?.lastMessage}")`);
  ok(!planted.broken.byOrigin[GOOD], "the well-formed seller is not counted as broken");
  ok(planted.contained.total === 0, `the entry step contained the throw itself; no turn had to (${planted.contained.total} contained turns)`);

  // A shadow rebuild walks the whole cache, poison included.
  const shadow = await ask("shadow");
  ok(proc.exitCode === null && (await alive()), "the process is alive after a shadow rebuild over the poison listing");
  ok(shadow.stats.builds === shadow.before + 1 && !shadow.stats.rebuilding, `the shadow rebuild completed and swapped in (builds ${shadow.before} -> ${shadow.stats.builds})`);
  ok(shadow.stats.indexedTools >= 1, `the rebuilt index still holds the well-formed seller (${shadow.stats.indexedTools} tools)`);
  ok(shadow.contained.total === 0, "the rebuild skipped the dropped listing without a throw");

  // A throw in the rebuild's finish (after its slices) abandons that build
  // and clears the shadow, so a later rebuild still starts and swaps in.
  const sf = await ask("shadow-finish-fault");
  ok(!sf.afterFault.rebuilding && sf.afterFault.builds === sf.before, `a rebuild whose finish throws is abandoned and the shadow cleared (rebuilding ${sf.afterFault.rebuilding}, builds ${sf.before} -> ${sf.afterFault.builds})`);
  ok(sf.containedAfterFault?.count >= 1 && /planted shadow finish fault/.test(sf.containedAfterFault?.lastMessage || ""), `...the throw counted under route-index-shadow (${JSON.stringify(sf.containedAfterFault)})`);
  ok(!sf.afterRetry.rebuilding && sf.afterRetry.builds === sf.before + 1 && sf.afterRetry.indexedTools >= 1, `the next rebuild runs and swaps in (builds ${sf.afterRetry.builds}, ${sf.afterRetry.indexedTools} tools)`);
  ok(proc.exitCode === null && (await alive()), "the process is alive after the rebuild's finish threw");
  const ctBase = sf.contained.total; // the planted finish fault; nothing after it may add to the count

  // Route queries over HTTP answer with the other seller.
  const route = await fetch(`${base}/api/route?q=${encodeURIComponent("ocr a thing from an image")}&include=external&top=20`);
  const routeBody = await route.json().catch(() => null);
  ok(route.status === 200, `GET /api/route answers 200 (${route.status})`);
  ok(Array.isArray(routeBody?.results) && routeBody.results.some((t) => t.seller === GOOD), `the route answer carries the well-formed seller (${(routeBody?.results || []).map((t) => t.seller).join(", ") || "none"})`);
  ok(!(routeBody?.results || []).some((t) => t.seller === POISON), "the route answer carries nothing from the poison listing");
  const find = await fetch(`${base}/api/find?q=${encodeURIComponent("good-vision")}`);
  const findBody = await find.json().catch(() => null);
  ok(find.status === 200, `GET /api/find answers 200 beside the poison listing (${find.status})`);
  ok(Array.isArray(findBody?.relatedSellers) && findBody.relatedSellers.some((s) => String(s.host || s.origin || "").includes("good-vision")), `the find answer's seller bridge names the well-formed seller (${JSON.stringify(findBody?.relatedSellers || null)?.slice(0, 120)})`);

  // A query that meets a poison entry still pending (no drain turn yet).
  const late = await ask("query-pending");
  ok(!late.err && late.pendingBefore >= 1, `an in-thread query over a pending poison listing answers without a throw (pending ${late.pendingBefore}, ${late.err || "no throw"})`);
  ok(late.sellers.some((s) => s === GOOD) && !late.sellers.some((s) => s === POISON2), `that query ranks the well-formed seller and nothing from the pending poison (${late.sellers.join(", ")})`);
  ok(late.broken.byOrigin[POISON2]?.count >= 1, `the late poison is counted by origin too (${late.broken.byOrigin[POISON2]?.count})`);
  ok(proc.exitCode === null && (await alive()), "the process is alive after the query met the pending poison");

  // A row whose statics throw inside computeToolStatics itself (decoration
  // reads it fine): the sentinel keeps it out of the index and the query,
  // the entry's other row is indexed and routed, and the poison is counted.
  const st = await ask("statics-poison");
  ok(st.after && !st.after.pending && !st.after.partial && st.contained.total === ctBase, `the drain finished over the statics poison with no contained turn (pending ${st.after?.pending}, contained ${st.contained.total - ctBase})`);
  ok(!st.err && st.results.some(([s]) => s === GOOD), `the query answers and finds the well-formed seller (${st.err || st.results.map(([s, g]) => `${s}#${g}`).join(", ")})`);
  ok(st.results.some(([s, g]) => s === STATICS && g === "ocr-statics-fine") && !st.results.some(([, g]) => g === "ocr-statics"), "the statics poison's well-formed sibling row is routed; the poison row is not (the entry was not dropped whole)");
  ok(st.broken.byOrigin[STATICS]?.count >= 1 && /poison-statics/.test(st.broken.byOrigin[STATICS]?.lastMessage || ""), `the statics poison is counted by origin with its message (${JSON.stringify(st.broken.byOrigin[STATICS])})`);
  ok(st.skippedAfterDrain > st.skippedBefore, `the broken row was skipped by indexing (${st.skippedBefore} -> ${st.skippedAfterDrain})`);
  ok(st.pendingBefore >= 1 && st.broken.toolsSkipped > st.skippedAfterDrain && st.results.some(([s, g]) => s === STATICS2 && g === "ocr-statics-fine") && !st.results.some(([s, g]) => s === STATICS2 && g === "ocr-statics"),
    `a statics poison still pending is skipped by the query itself, its sibling row ranked (pending ${st.pendingBefore}, skipped ${st.skippedAfterDrain} -> ${st.broken.toolsSkipped})`);
  ok(st.broken.byOrigin[STATICS2]?.count >= 1, `the pending statics poison is counted by origin (${st.broken.byOrigin[STATICS2]?.count})`);
  ok(proc.exitCode === null && (await alive()), "the process is alive after the statics poison");
  // One listing with 30 forged seller fields counts one origin.
  const fg = await ask("forged");
  const forgedKeys = Object.keys(fg.broken.byOrigin).filter((k) => /forged/.test(k));
  ok(!fg.err && forgedKeys.join() === FORGED && fg.broken.byOrigin[FORGED].count >= 30, `30 rows naming 30 sellers count under the one entry origin (${forgedKeys.join(", ")}; ${fg.broken.byOrigin[FORGED]?.count} rows)`);
  const quiet = await fetch(`${base}/api/gateway-status`).then((r) => r.json()).catch(() => null);
  ok(quiet?.brokenListings?.status === "ok" && Object.keys(quiet.brokenListings).join() === "status", `five poison sellers leave brokenListings ok, word only (${JSON.stringify(quiet?.brokenListings)})`);

  // A handler that rejects answers 500 for that request only.
  await ask("fault");
  const faulted = await fetch(`${base}/api/route?q=${encodeURIComponent("fault probe one")}&include=external`);
  const faultBody = await faulted.json().catch(() => null);
  ok(faulted.status === 500 && /planted handler fault/.test(faultBody?.error || ""), `a route query whose handler rejects answers 500 for that request (${faulted.status}, ${JSON.stringify(faultBody)?.slice(0, 80)})`);
  const next = await fetch(`${base}/api/route?q=${encodeURIComponent("fault probe two ocr")}&include=external`);
  ok(next.status === 200, `the next route query answers 200 (${next.status})`);
  ok(proc.exitCode === null && (await alive()), "the process is alive after the rejected handler");

  // The operator surface carries both counts.
  const perf = await fetch(`${base}/__operator/perf.json`, op);
  const perfBody = await perf.json().catch(() => null);
  ok(perf.status === 200 && perfBody?.brokenListings?.byOrigin?.[POISON]?.count >= 1 && perfBody.brokenListings.byOrigin[POISON2]?.count >= 1, `/__operator/perf.json brokenListings counts both poison origins (${JSON.stringify(perfBody?.brokenListings)?.slice(0, 160)})`);
  ok(typeof perfBody?.containedTurns?.total === "number" && perfBody.containedTurns.byName && typeof perfBody.containedTurns.names === "number", `/__operator/perf.json carries containedTurns by name (${JSON.stringify(perfBody?.containedTurns)?.slice(0, 120)})`);
  const anon = await fetch(`${base}/__operator/perf.json`);
  ok(anon.status === 404, `the operator surface stays operator-only (${anon.status} without the token)`);
  const status = await fetch(`${base}/api/gateway-status`);
  const statusText = await status.text();
  ok(status.status === 200 && !/\d{3,}/.test(statusText.replace(/"[a-zA-Z]+":\s*"[^"]*"/g, "")), "/api/gateway-status still carries words only");

  // A code bug that breaks every listing: statics forced to throw for every
  // row, then fresh sellers planted. External routing empties and the public
  // word reads widespread (each throw is caught per row, so no turn sees it).
  const wide = await ask("widespread");
  ok(!wide.err && !wide.sellers.some((s) => /wide-/.test(s)), `with every row's statics throwing, no planted seller routes (${wide.err || wide.sellers.length + " results"})`);
  ok(Object.keys(wide.broken.byOrigin).filter((k) => /wide-/.test(k)).length === WIDE && wide.contained.total === ctBase, `all ${WIDE} planted origins are counted broken, and no contained turn saw it (${wide.contained.total - ctBase})`);
  const loud = await fetch(`${base}/api/gateway-status`).then((r) => r.json()).catch(() => null);
  ok(loud?.brokenListings?.status === "widespread" && Object.keys(loud.brokenListings).join() === "status", `brokenListings reads widespread, word only (${JSON.stringify(loud?.brokenListings)}; ${wide.indexed} origins indexed)`);
  const loudOp = await fetch(`${base}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } }).then((r) => r.json()).catch(() => null);
  ok(loudOp?.brokenListings?.status === "widespread" && loudOp.brokenListings.origins >= WIDE, `the operator view carries the window's origin count (${JSON.stringify(loudOp?.brokenListings)})`);
  await ask("clear-fault");
  ok(proc.exitCode === null && (await alive()), "the process is alive with every listing broken");
} catch (e) {
  ok(false, `section 1 threw: ${e?.stack || e}`);
} finally {
  if (proc && proc.exitCode === null) { proc.kill("SIGKILL"); await new Promise((r) => proc.once("exit", r)); }
  if (fail) console.log(stderr.split("\n").filter((l) => /uncaught|contained-turn|poison|Error/.test(l)).slice(0, 20).join("\n"));
}
ok(!/\[uncaughtException\]/.test(stderr), "the server never logged an uncaught exception");

// --- 2. Express 5: a rejected async handler is a 500 for that request only ------
{
  const express = (await import("express")).default;
  const app = express();
  app.set("env", "test"); // the final handler's stack print is not the assertion
  let calls = 0;
  app.get("/q", async (req, res) => { calls++; if (req.query.fail) throw new Error("handler rejected"); res.json({ ok: true, calls }); });
  const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const port = srv.address().port;
  const a = await fetch(`http://127.0.0.1:${port}/q?fail=1`);
  const b = await fetch(`http://127.0.0.1:${port}/q`);
  const bBody = await b.json().catch(() => null);
  ok(a.status === 500 && b.status === 200 && bBody?.calls === 2, `Express ${JSON.parse(readFileSync(join(ROOT, "node_modules/express/package.json"), "utf8")).version}: a rejected async handler answers 500 (${a.status}) and the next request answers 200 (${b.status})`);
  await new Promise((r) => srv.close(r));
}

// --- 3. the control: the same poison against copies with the containment removed
// A copy of the module tree (never the working tree): src/, the scripts the
// revenue readers import, package.json, and node_modules linked.
const copy = join(dir, "copy");
mkdirSync(copy);
cpSync(SRC, join(copy, "src"), { recursive: true });
cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true });
cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
symlinkSync(realpathSync(join(ROOT, "node_modules")), join(copy, "node_modules"));
const INDEX_COPY = join(copy, "src", "x402-index.js");
const original = readFileSync(INDEX_COPY, "utf8");
function mutate(pairs) {
  let s = original;
  for (const [from, to] of pairs) {
    const i = s.indexOf(from);
    if (i < 0 || s.indexOf(from, i + 1) >= 0) throw new Error(`mutation target not found once: ${from.slice(0, 60)}`);
    s = s.slice(0, i) + to + s.slice(i + from.length);
  }
  writeFileSync(INDEX_COPY, s);
}
// The per-entry layer: every entry-level catch reports through this function.
const ENTRY_CATCH = [`function routeIndexEntryBroken(origin, v, err) {\n  if (v && typeof v === "object") brokenEntries.add(v);\n  noteBrokenListing(origin, err);\n}`, `function routeIndexEntryBroken(origin, v, err) { throw err; }`];
// The turn wrapper on the drain.
const DRAIN_WRAP = [`const drainSlice = contained("route-index-drain", () => {`, `const drainSlice = ((f) => f)(() => {`];
const CONTROL = join(dir, "control.mjs");
writeFileSync(CONTROL, `
import { pathToFileURL } from "node:url";
const copy = process.argv[2];
const x = await import(pathToFileURL(copy + "/src/x402-index.js").href);
const ct = await import(pathToFileURL(copy + "/src/contained-turn.js").href);
const E = await import(${JSON.stringify(pathToFileURL(join(dir, "entries.mjs")).href)});
const cache = x._cacheForTests(); cache.clear();
cache.set(${JSON.stringify(GOOD)}, E.goodEntry(${JSON.stringify(GOOD)}));
cache.set(${JSON.stringify(POISON)}, E.poisonEntry(${JSON.stringify(POISON)}));
for (let i = 0; i < 20000; i++) { const s = x._routeIndexStatsForTest(); if (!s.pending && !s.partial) break; await new Promise((r) => setImmediate(r)); }
x._routeIndexStartShadowForTest();
await x._routeIndexSettledForTest();
const r = x.routeQuery({ query: "ocr a thing from an image", top: 50, include: "external", baseUrl: "https://agent402.tools", catalog: {}, prices: {} });
console.log(JSON.stringify({ sellers: r.results.map((t) => t.seller), broken: x.brokenListingsSummary(), contained: ct.containedTurnsSummary(), stats: x._routeIndexStatsForTest() }));
`);
const controlEnv = { ...process.env, ...ownStoreEnv("crash-control"), REDIS_URL: "", STATE_DATABASE_URL: "", X402_INDEX_CRAWL: "off", INDEX_CACHE_FILE: join(dir, "control-cache.json") };
function runControl(label) {
  const r = spawnSync(process.execPath, [CONTROL, copy], { cwd: copy, env: controlEnv, encoding: "utf8", timeout: 120_000 });
  let out = null;
  try { out = childJson(r.stdout); } catch { /* no answer line */ }
  return { label, status: r.status, signal: r.signal, out, stderr: r.stderr || "" };
}
{
  // Unmutated copy: the same answer the booted server gave.
  const c = runControl("intact");
  ok(c.status === 0 && c.out?.sellers.some((s) => s === GOOD) && c.out.broken.byOrigin[POISON]?.count >= 1 && c.out.contained.total === 0,
    `intact copy: exit ${c.status}, finds the well-formed seller, counts the poison listing (${c.out?.broken.byOrigin[POISON]?.count}), no turn had to contain (${c.out?.contained.total})`);
  if (c.status !== 0) console.log(c.stderr.slice(-800));
}
{
  // Per-entry catches rethrow: the drain's turn wrapper is what keeps it up.
  mutate([ENTRY_CATCH]);
  const c = runControl("entry layer removed");
  ok(c.status === 0 && c.out?.sellers.some((s) => s === GOOD),
    `entry-level containment removed: exit ${c.status}, the process lives and the well-formed seller is still found (${c.out?.sellers.join(", ")})`);
  ok(c.out?.contained.byName["route-index-drain"]?.count >= 1 && /poison/.test(c.out?.contained.byName["route-index-drain"]?.lastMessage || ""),
    `...because the drain's contained() turn caught the poison (${JSON.stringify(c.out?.contained.byName["route-index-drain"])})`);
  ok(c.out?.broken.byOrigin[POISON]?.count >= 1 && !c.out?.stats.pending && !c.out?.stats.partial, `...and the entry was dropped and counted, the drain finished (${c.out?.broken.byOrigin[POISON]?.count}, pending ${c.out?.stats.pending})`);
  if (c.status !== 0) console.log(c.stderr.slice(-800));
}
{
  // Both removed: the same poison takes the process down.
  mutate([ENTRY_CATCH, DRAIN_WRAP]);
  const c = runControl("drain wrapper removed too");
  ok(c.status !== 0 && c.status !== null && /poison: a seller field that cannot be read/.test(c.stderr),
    `with the drain's contained() wrapper removed as well, the same poison takes the process down (exit ${c.status}${c.signal ? ` signal ${c.signal}` : ""}, the uncaught throw names the poison)`);
  ok(c.out === null, "...and it never answers the query");
}
writeFileSync(INDEX_COPY, original);
rmSync(dir, { recursive: true, force: true });
console.log(`\ntest-crash-containment: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
