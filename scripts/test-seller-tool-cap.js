#!/usr/bin/env node
// The index keeps at most INDEX_SELLER_TOOL_CAP tools per seller
// (src/seller-tool-cap.js), applied once in IndexCache.set. Offline.
//   - the pure function: described tools first in listing order, then the
//     rest; the same input gives the same kept set; applied to its own result
//     it changes nothing; a list under the cap comes back as the same array;
//   - the entry: a cut entry carries toolsTotal and toolsCapped; one stored
//     capped at the cap is kept as it is (the same object, so no rewrite); a
//     lower cap keeps the larger total; a stale pair on an under-cap list is
//     dropped;
//   - a booted server (port 0, own stores) warm-started with a 12,000-tool
//     seller under a cap of 5,000 lists it with toolCount 5000, toolsTotal
//     12000 and toolsCapped true on the row and the detail, with the cap and
//     its legend; routes a query to one of its kept described tools and not to
//     a dropped one; the directory counts the kept rows; a 2,000-tool seller
//     is served untouched; the operator heap figures count the cut;
//   - a mutation control on a COPY of src (never the working tree): with the
//     cap removed from the funnel the same seller reads 12,000 tools, so the
//     assertions above are load-bearing.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { childJson } from "./lib/child-json.js";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = 5000;
process.env.INDEX_SELLER_TOOL_CAP = String(CAP);
const { SELLER_TOOL_CAP, capSellerTools, capSellerEntry, sellerToolsTotal, isDescribedTool } = await import("../src/seller-tool-cap.js");

// Listing order interleaves undescribed (even k) and described (odd k) tools.
const BIG = "https://big.example", SMALL = "https://small.example";
const tool = (k, origin = BIG) => ({
  seller: origin, method: "POST", route: `/api/big/${k}`, slug: `big-${k}`, name: `Big ${k}`,
  ...(k % 2 ? { description: `bigseller tool number ${k} wordk${k} returns an item for an agent` } : {}),
  category: "data", tags: ["big"], price: 0.001, networks: ["eip155:8453"],
});
const N = 12_000;
const bigTools = Array.from({ length: N }, (_, k) => tool(k));
const smallTools = Array.from({ length: 2000 }, (_, k) => ({ ...tool(k, SMALL), route: `/api/small/${k}`, slug: `small-${k}`, name: `Small ${k}`, description: `smallseller tool ${k} wordsm${k}` }));

// ---- the pure function --------------------------------------------------------
ok(SELLER_TOOL_CAP === CAP, `the cap reads INDEX_SELLER_TOOL_CAP (${SELLER_TOOL_CAP})`);
{
  const r = capSellerTools(bigTools, CAP);
  ok(r.capped === true && r.total === N && r.tools.length === CAP, `12,000 tools cut to ${r.tools.length}, total ${r.total}, capped ${r.capped}`);
  ok(r.tools.every(isDescribedTool), "every kept tool is described (6,000 described, 5,000 kept)");
  ok(r.tools.every((t, i) => t.slug === `big-${2 * i + 1}`), "the kept tools are the described ones in listing order");
  const again = capSellerTools(bigTools, CAP);
  ok(again.tools.every((t, i) => t === r.tools[i]), "the same listing gives the same kept set");
  const twice = capSellerTools(r.tools, CAP);
  ok(twice.tools === r.tools && twice.capped === false && twice.total === CAP, "applied to its own result it changes nothing (the same array)");
  const under = capSellerTools(smallTools, CAP);
  ok(under.tools === smallTools && under.capped === false && under.total === 2000, "a list under the cap comes back as the same array");
  const few = capSellerTools(Array.from({ length: 10 }, (_, k) => tool(k)), 7);
  ok(few.tools.length === 7 && few.tools.slice(0, 5).every((t) => Number(t.slug.slice(4)) % 2 === 1) && few.tools.slice(5).map((t) => t.slug).join() === "big-0,big-2",
    `with fewer described tools than the cap the rest follow in listing order (${few.tools.map((t) => t.slug).join(",")})`);
  ok(capSellerTools(null, CAP).capped === false && capSellerTools([], CAP).tools.length === 0, "no list, no cut");
  ok(!isDescribedTool({ description: "   " }) && isDescribedTool({ description: 7 }) && !isDescribedTool(null), "a blank description is not one; a scalar the cleaning turns into text is");
}
// ---- the entry ------------------------------------------------------------------
{
  const e = { manifest: { name: "Big" }, tools: bigTools, fetchedAt: 1 };
  const c = capSellerEntry(e, CAP);
  ok(c !== e && c.tools.length === CAP && c.toolsTotal === N && c.toolsCapped === true && c.manifest === e.manifest, "a cut entry carries toolsTotal and toolsCapped and keeps its other fields");
  ok(capSellerEntry(c, CAP) === c, "an entry stored capped at the cap is kept as it is (the same object)");
  const lower = capSellerEntry(c, 3000);
  ok(lower.tools.length === 3000 && lower.toolsTotal === N, `a lower cap cuts again and keeps the larger total (${lower.toolsTotal})`);
  const stale = capSellerEntry({ tools: smallTools, toolsTotal: N, toolsCapped: true }, CAP);
  ok(!("toolsTotal" in stale) && !("toolsCapped" in stale) && stale.tools === smallTools, "a stale pair on an under-cap list is dropped");
  const plain = { tools: smallTools };
  ok(capSellerEntry(plain, CAP) === plain && capSellerEntry(null, CAP) === null && capSellerEntry({ manifest: {} }, CAP).tools === undefined, "an under-cap entry, no entry and an entry without tools pass unchanged");
  ok(sellerToolsTotal(c) === N && sellerToolsTotal(plain) === 2000 && sellerToolsTotal({ tools: [] }, 9) === 9, "sellerToolsTotal reads the listing count, the held count, or the fallback");
}

// ---- the booted server ------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "a402-seller-cap-"));
const now = Date.now();
const entry = (origin, tools, name) => [origin, { manifest: { name, homepage: origin }, tools, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1] }];
const lines = [entry(BIG, bigTools, "Big Seller"), entry(SMALL, smallTools, "Small Seller")].map((e) => JSON.stringify(e));
writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
const TOKEN = "seller-tool-cap-operator-token-0123456789";
const serverEnv = {
  ...process.env, ...ownStoreEnv("seller-tool-cap"),
  FREE_MODE: "true", PORT: "0", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", INDEX_SELLER_TOOL_CAP: String(CAP),
  X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", REDIS_URL: "", STATE_DATABASE_URL: "",
  ROUTER_WORKERS: "0", LOAD_SHED: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", LAZY_DEPS_WARM: "off", AGENT402_OPERATOR_TOKEN: TOKEN,
};
const proc = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });
let exited = null;
proc.on("exit", (code, signal) => { exited = { code, signal }; });
const getJson = async (base, path, init) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  let base = null;
  for (let i = 0; i < 240 && !base && !exited; i++) { const m = log.match(/listening on :(\d+)/); if (m) base = `http://127.0.0.1:${m[1]}`; else await sleep(250); }
  if (!base) throw new Error(`server never came up${exited ? ` (exited ${JSON.stringify(exited)})` : ""}:\n${log.slice(-800)}`);
  let sellers = 0;
  for (let i = 0; i < 120 && sellers < 2 && !exited; i++) {
    try { sellers = (await getJson(base, "/api/index?limit=1")).body?.sellerCount || 0; } catch { /* warming */ }
    if (sellers < 2) await sleep(500);
  }
  ok(sellers >= 2, `the index warm-started with both seeded sellers (${sellers})`);

  const detail = (await getJson(base, "/api/index?seller=big.example")).body;
  ok(detail?.toolCount === CAP && detail.toolsTotal === N && detail.toolsCapped === true, `?seller= detail: toolCount ${detail?.toolCount}, toolsTotal ${detail?.toolsTotal}, toolsCapped ${detail?.toolsCapped}`);
  ok(detail?.toolCap === CAP && typeof detail.toolCapLegend === "string" && detail.toolCapLegend.includes(String(CAP)), "...with the cap and a legend naming it");
  ok(detail?.toolsReturned === 500 && detail.toolsTruncated === true && Array.isArray(detail.tools) && detail.tools.length === 500 && detail.tools.every((t) => Number(t.slug.slice(4)) % 2 === 1 && t.description),
    "...and the answer's own 500-row window shows kept described tools only");
  const small = (await getJson(base, "/api/index?seller=small.example")).body;
  ok(small?.toolCount === 2000 && small.toolsTotal === 2000 && small.toolsCapped === false, `a 2,000-tool seller is served untouched (${small?.toolCount}/${small?.toolsTotal}/${small?.toolsCapped})`);

  const page = (await getJson(base, "/api/index?limit=250")).body;
  const rowBig = page?.sellers?.find((s) => s.origin === BIG), rowSmall = page?.sellers?.find((s) => s.origin === SMALL);
  ok(rowBig?.toolCount === CAP && rowBig.toolsTotal === N && rowBig.toolsCapped === true, `the /api/index row reads toolCount ${rowBig?.toolCount}, toolsTotal ${rowBig?.toolsTotal}, toolsCapped ${rowBig?.toolsCapped}`);
  ok(rowSmall?.toolCount === 2000 && rowSmall.toolsTotal === 2000 && rowSmall.toolsCapped === false, "the small seller's row is uncapped");
  ok(page?.totals?.cappedSellers === 1 && page.totals.toolCap === CAP && typeof page.toolCapLegend === "string" && page.totals.toolsTotal - page.totals.tools === N - CAP,
    `totals name the cut: cappedSellers ${page?.totals?.cappedSellers}, toolCap ${page?.totals?.toolCap}, toolsTotal exceeds tools by ${page?.totals?.toolsTotal - page?.totals?.tools}`);

  const route = async (query) => (await getJson(base, "/api/route", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, include: "external", top: 10 }) })).body;
  const kept = await route("wordk9999");
  ok(kept?.results?.some((t) => t.slug === "big-9999"), `a kept described tool is routed (${(kept?.results || []).map((t) => t.slug).slice(0, 3).join(",") || "none"})`);
  const dropped = await route("wordk10001");
  ok(Array.isArray(dropped?.results) && !dropped.results.some((t) => t.slug === "big-10001"), "a described tool past the cap is not routed (the kept one beside it is the control)");
  const smallHit = await route("wordsm1999");
  ok(smallHit?.results?.some((t) => t.slug === "small-1999"), "the small seller's last tool is routed");

  const directory = (await getJson(base, "/api/index/tools?q=bigseller&limit=1")).body;
  ok(directory?.matched === CAP, `the directory counts the kept rows (${directory?.matched} matched for the big seller's text)`);

  const heap = (await getJson(base, "/__operator/heap.json", { headers: { "x-operator-token": TOKEN } })).body;
  ok(heap?.index?.cappedSellers === 1 && heap.index.toolsDropped === N - CAP && heap.index.toolCap === CAP && heap.index.tools === CAP + 2000,
    `the operator heap figures count the cut (${JSON.stringify({ cappedSellers: heap?.index?.cappedSellers, toolsDropped: heap?.index?.toolsDropped, tools: heap?.index?.tools })})`);
  ok(!exited && (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)), "the server is still up");
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  proc.kill("SIGKILL");
}

// ---- mutation control on a copy ------------------------------------------------------
// The same seller through the module itself, from a copy of src: intact, it
// is cut; with the cap removed from the funnel it is not. The working tree is
// never edited.
const copy = join(dir, "copy");
mkdirSync(copy);
cpSync(join(ROOT, "src"), join(copy, "src"), { recursive: true });
cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true }); // the index imports revenue readers from there
cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
symlinkSync(realpathSync(join(ROOT, "node_modules")), join(copy, "node_modules"));
const INDEX_COPY = join(copy, "src", "x402-index.js");
const FUNNEL = "v = cleanSellerEntry(capSellerEntry(v));";
const CONTROL = join(dir, "control.mjs");
writeFileSync(CONTROL, `
import { pathToFileURL } from "node:url";
const copy = process.argv[2];
const x = await import(pathToFileURL(copy + "/src/x402-index.js").href);
const tools = Array.from({ length: ${N} }, (_, k) => ({ seller: ${JSON.stringify(BIG)}, method: "POST", route: "/api/big/" + k, slug: "big-" + k, name: "Big " + k, ...(k % 2 ? { description: "bigseller tool number " + k } : {}), price: 0.001, networks: ["eip155:8453"] }));
x.__testSeedCache([[${JSON.stringify(BIG)}, { manifest: { name: "Big" }, tools, fetchedAt: 1, error: null, source: "manifest", history: [1] }]]);
const d = x.sellerDetail("big.example");
console.log(JSON.stringify({ toolCount: d.toolCount, toolsTotal: d.toolsTotal, toolsCapped: d.toolsCapped }));
`);
const controlEnv = { ...process.env, ...ownStoreEnv("seller-cap-control"), REDIS_URL: "", STATE_DATABASE_URL: "", X402_INDEX_CRAWL: "off", INDEX_CACHE_FILE: join(dir, "control-cache.json"), INDEX_SELLER_TOOL_CAP: String(CAP) };
function runControl() {
  const r = spawnSync(process.execPath, [CONTROL, copy], { cwd: copy, env: controlEnv, encoding: "utf8", timeout: 120_000 });
  let out = null;
  try { out = childJson(r.stdout); } catch { /* no answer line */ }
  return { status: r.status, out, stderr: r.stderr || "" };
}
{
  const c = runControl();
  ok(c.status === 0 && c.out?.toolCount === CAP && c.out.toolsTotal === N && c.out.toolsCapped === true, `intact copy: exit ${c.status}, ${JSON.stringify(c.out)}`);
  if (c.status !== 0) console.log(c.stderr.slice(-600));
  const src = readFileSync(INDEX_COPY, "utf8");
  const at = src.indexOf(FUNNEL);
  ok(at >= 0 && src.indexOf(FUNNEL, at + 1) < 0, "the funnel line is found once in the copy");
  writeFileSync(INDEX_COPY, src.replace(FUNNEL, "v = cleanSellerEntry(v);"));
  const m = runControl();
  ok(m.status === 0 && m.out?.toolCount === N && m.out.toolsCapped === false, `cap removed from the funnel: the same seller reads ${m.out?.toolCount} tools, toolsCapped ${m.out?.toolsCapped} (the assertions above are load-bearing)`);
  if (m.status !== 0) console.log(m.stderr.slice(-600));
}

// ---- a fresh crawl reads its total from the new list -------------------------------
// A seller stored capped with toolsTotal 77,000 that now lists fewer tools is
// re-crawled through the real fallback path (its openapi document, through
// the crawl fetch seam): the total comes from the new list, not the old
// entry. Run on the working tree, and on the copy with the fix reverted.
const SHRINK = "https://shrink.example";
const FRESH_CAP = 50;
const FRESH = join(dir, "fresh-crawl.mjs");
writeFileSync(FRESH, `
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const x = await import(pathToFileURL(root + "/src/x402-index.js").href);
const O = ${JSON.stringify(SHRINK)};
const paid = { "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.010000" }, protocols: [{ x402: {} }] } };
let paths = 0;
const doc = () => JSON.stringify({ openapi: "3.1.0", info: { title: "Shrink", version: "1" }, paths: Object.fromEntries(Array.from({ length: paths }, (_, k) => ["/api/item/" + k, { get: { operationId: "item" + k, summary: "Item " + k + " lookup", ...paid } }])) });
x.__setCrawlFetchForTest(async (url) => {
  if (url === O + "/robots.txt") return { html: "User-agent: *\\nAllow: /\\n", finalUrl: url, validators: null };
  if (url === O + "/openapi.json") return { html: doc(), finalUrl: url, validators: null };
  throw Object.assign(new Error("Upstream returned HTTP 404 for " + url), { statusCode: 422 });
});
const prevTools = Array.from({ length: ${FRESH_CAP} }, (_, k) => ({ seller: O, method: "GET", route: "/api/item/" + k, slug: "item" + k, name: "Item " + k, description: "Item " + k + " lookup", price: 0.01, networks: ["eip155:8453"] }));
x.__testSeedCache([[O, { manifest: { name: "Shrink", synthesized: true }, tools: prevTools, toolsTotal: 77000, toolsCapped: true, fetchedAt: 1, error: null, source: "openapi-fallback", history: [1] }]]);
const out = {};
const read = () => { const d = x.sellerDetail("shrink.example"); return { toolCount: d.toolCount, toolsTotal: d.toolsTotal, toolsCapped: d.toolsCapped }; };
out.stored = read();
paths = 60; x.__resetRobotsCacheForTest(); await x.__crawlSellerForTest(O); out.past = read();
x.__testSeedCache([[O, { ...x._cacheForTests().get(O), toolsTotal: 77000, toolsCapped: true }]]);
paths = ${FRESH_CAP}; x.__resetRobotsCacheForTest(); await x.__crawlSellerForTest(O); out.at = read();
console.log(JSON.stringify(out));
`);
const freshEnv = { ...controlEnv, INDEX_SELLER_TOOL_CAP: String(FRESH_CAP), INDEX_CACHE_FILE: join(dir, "fresh-cache.json"), REMOVED_ORIGINS_FILE: join(dir, "fresh-removed.json") };
function runFresh(root) {
  const r = spawnSync(process.execPath, [FRESH, root], { cwd: root, env: freshEnv, encoding: "utf8", timeout: 120_000 });
  let out = null;
  try { out = childJson(r.stdout); } catch { /* no answer line */ }
  return { status: r.status, out, stderr: r.stderr || "" };
}
{
  const f = runFresh(ROOT);
  ok(f.status === 0 && f.out?.stored?.toolsTotal === 77000 && f.out.stored.toolsCapped === true, `the seeded seller reads as stored capped (${JSON.stringify(f.out?.stored)})`);
  ok(f.out?.past?.toolCount === FRESH_CAP && f.out.past.toolsTotal === 60 && f.out.past.toolsCapped === true, `re-crawled at 60 tools under a cap of ${FRESH_CAP}: toolsTotal reads the new list (${JSON.stringify(f.out?.past)})`);
  ok(f.out?.at?.toolCount === FRESH_CAP && f.out.at.toolsTotal === FRESH_CAP && f.out.at.toolsCapped === false, `re-crawled at exactly the cap after a capped copy: no stale total (${JSON.stringify(f.out?.at)})`);
  if (f.status !== 0) console.log(f.stderr.slice(-800));
  // The control: the copy with the crawl spreading the old entry whole again.
  const src = readFileSync(INDEX_COPY, "utf8").replace(FUNNEL, "v = cleanSellerEntry(capSellerEntry(v));");
  const FIX = "...freshListBase(prev),";
  ok(src.split(FIX).length === 2, "the fallback crawl's fresh-list base is found once in the copy");
  writeFileSync(INDEX_COPY, src.replace(FIX, "...(prev || {}),"));
  const m = runFresh(copy);
  ok(m.status === 0 && m.out?.past?.toolsTotal === 77000, `with the old entry spread whole the shrunk seller keeps toolsTotal ${m.out?.past?.toolsTotal} (the assertions above are load-bearing)`);
  if (m.status !== 0) console.log(m.stderr.slice(-800));
}
rmSync(dir, { recursive: true, force: true });
console.log(`\ntest-seller-tool-cap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
