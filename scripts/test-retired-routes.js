// Retired catalog routes answer 410 Gone with the replacement, never the
// guessed-slug 404 (src/retired-tools.js). Offline half: the registry rules.
// Booted half: the wire shape on a free server.
//
//   node scripts/test-retired-routes.js
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { RETIRED_TOOLS, RETIRED_PACKS, retiredEntryFor, assertRetiredRegistryConsistent } from "../src/retired-tools.js";
import { loadSnapshot, envGatedSegments, segmentsOf, accountFor } from "./published-slugs.js";

let pass = 0;
let proc = null; // the booted server, stopped on a failure so it never outlives the test
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); proc?.kill("SIGTERM"); process.exit(1); } };
const throws = (fn, re, m) => { let e = null; try { fn(); } catch (err) { e = err; } ok(e && re.test(e.message), `${m} (${e ? e.message.slice(0, 80) : "did not throw"})`); };

// --- the registry rules ---------------------------------------------------------
const liveSet = new Set(["crypto-options-chain", "kalshi-markets", "kalshi-event", "kalshi-live-data", "stock-quote", "price-coingecko", "business-days", "cron-next", "slugify", "hash", "contract-source", "wallet-balance", "token-metadata", "tx-receipt", "color", "xml-to-json", "skill-company-dossier", "checksum", "lorem", "password-strength", "qr", "semver", "case", "uuid"]);
ok(assertRetiredRegistryConsistent(liveSet) === true, "control: the registry is consistent against a live set that carries every replacement");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet, "options-chain"])), /listed as retired but is live/, "a retired tool that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet, "skill-market-open"])), /pack "market-open" is listed as retired but is live/, "a retired pack that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet].filter((s) => s !== "crypto-options-chain"))), /names replacement "crypto-options-chain", which is not a live/, "a replacement that is not live fails the boot");
ok(Object.values(RETIRED_TOOLS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)) && Object.values(RETIRED_PACKS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)), "every entry carries a retirement date");

// The boot guard is CALLED, against the real catalog, before any route is served.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/assertRetiredRegistryConsistent\(new Set\(Object\.values\(CATALOG\)\.map\(\(d\) => d\.slug\)\)\)/.test(src), "server.js runs the registry guard over the catalog's own slugs at boot");
  ok(src.indexOf("assertRetiredRegistryConsistent(new Set(") < src.indexOf("app.listen("), "...before the server listens");
}

// --- path resolution ------------------------------------------------------------
ok(retiredEntryFor("/api/options-chain")?.replacement === "crypto-options-chain", "/api/<retired tool> resolves with its replacement");
ok(retiredEntryFor("/api/options-chain/anything?x=1")?.slug === "options-chain", "a trailing segment does not hide a retired route");
ok(retiredEntryFor("/api/skill/market-open")?.kind === "pack", "/api/skill/<retired pack> resolves as a pack");
ok(retiredEntryFor("/api/skill/options-chain") === null, "a tool slug under /api/skill/ is not a retired pack");
ok(retiredEntryFor("/api/market-open") === null, "a pack slug under /api/ is not a retired tool");
ok(retiredEntryFor("/api/nope-nope") === null && retiredEntryFor("/v1/options-chain") === null, "unknown and off-prefix paths resolve to nothing");

// --- the published-routes snapshot rule (scripts/published-slugs.js) --------------
// Drive the accounting with planted cases first, so a clean run below means
// something: a published route that is neither live nor retired is reported,
// and a live route missing from the snapshot is reported.
{
  const snap = { tools: new Set(["alive", "gated", "gone-listed", "gone-forgotten"]), packs: new Set(["pack-alive", "pack-forgotten"]) };
  const r = accountFor({
    snapshot: snap,
    live: { tools: new Set(["alive", "brand-new"]), packs: new Set(["pack-alive"]) },
    gated: { tools: new Set(["gated"]), packs: new Set() },
    retiredTools: { "gone-listed": { retiredAt: "2026-01-01", replacement: null } },
    retiredPacks: {},
  });
  ok(r.unaccounted.join() === "pack pack-forgotten,tool gone-forgotten", `control: a forgotten retirement is reported (got ${r.unaccounted.join()})`);
  ok(r.missingFromSnapshot.join() === "tool brand-new", `control: a live route missing from the snapshot is reported (got ${r.missingFromSnapshot.join()})`);
  const segs = segmentsOf(["POST /api/memory/incr", "/api/skill/company-dossier", "/api/convert-km-to-miles", "/api/convert/km-to-miles", "/v1/judge"]);
  ok([...segs.tools].join() === "memory" && [...segs.packs].join() === "company-dossier", "route segments: first /api segment, packs apart, converters and /v1 excluded");
}
const snapshot = loadSnapshot();
ok(snapshot.tools.size >= 500 && snapshot.packs.size >= 100, `the snapshot is populated (${snapshot.tools.size} tools, ${snapshot.packs.size} packs)`);
for (const slug of [...Object.keys(RETIRED_TOOLS)]) ok(snapshot.tools.has(slug), `retired tool ${slug} is in the snapshot`);
for (const slug of [...Object.keys(RETIRED_PACKS)]) ok(snapshot.packs.has(slug), `retired pack ${slug} is in the snapshot`);
const gated = await envGatedSegments();

// --- the wire, on a free boot ------------------------------------------------------
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), BASE_URL: "http://agent402.test", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off" }, stdio: ["ignore", "ignore", "inherit"] });
try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted (the boot guard accepted the registry against the real catalog)");
  const get = await fetch(`${base}/api/options-chain`);
  const gb = await get.json();
  ok(get.status === 410 && gb.error === "gone" && gb.slug === "options-chain", `GET /api/options-chain is 410 gone (got ${get.status} ${JSON.stringify(gb).slice(0, 80)})`);
  ok(gb.replacement?.slug === "crypto-options-chain" && /^POST \/api\/crypto-options-chain$/.test(gb.replacement?.route || "") && gb.replacement?.url === "http://agent402.test/api/crypto-options-chain", "...naming the live replacement's slug, route and url");
  ok(gb.retiredAt === "2026-09-20" && /retired on 2026-09-20/.test(gb.hint) && /crypto-options-chain/.test(gb.hint), "...with the date and the replacement in the hint");
  ok(Array.isArray(gb.suggestions) && typeof gb.find === "string", "...and the same find + suggestions the 404 carries");
  const post = await fetch(`${base}/api/options-chain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "AAPL" }) });
  ok(post.status === 410, `POST on a retired route is 410 too (got ${post.status})`);
  // The 2026-09-22 explorer-data retirement: every one answers 410, never a
  // 404 and never a 402 (a retired route must not quote a price it cannot serve).
  for (const [slug, repl] of [["contract-inspect", "contract-source"], ["address-profile", "wallet-balance"], ["token-info", "token-metadata"], ["token-holders", null], ["tx-inspect", "tx-receipt"]]) {
    const r = await fetch(`${base}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json();
    ok(r.status === 410 && b.slug === slug && b.retiredAt === "2026-09-22" && (repl ? b.replacement?.slug === repl : b.replacement === null),
      `POST /api/${slug} is 410 naming ${repl || "no replacement"} (got ${r.status} ${JSON.stringify(b.replacement)})`);
  }
  const none = await fetch(`${base}/api/stock-dividends`);
  const nb = await none.json();
  ok(none.status === 410 && nb.replacement === null && /no direct replacement/.test(nb.hint), "a retirement with no replacement says so instead of inventing one");
  const pack = await fetch(`${base}/api/skill/market-open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const pb = await pack.json();
  ok(pack.status === 410 && pb.slug === "market-open" && /Skill pack market-open was retired/.test(pb.hint), `a retired skill pack is 410 (got ${pack.status})`);
  const unknown = await fetch(`${base}/api/nope-nope`);
  ok(unknown.status === 404 && (await unknown.json()).error === "not-found", "a guessed slug that was never a tool is still 404");
  const liveRoute = await fetch(`${base}/api/crypto-options-chain`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(liveRoute.status !== 410 && liveRoute.status !== 404, `the replacement itself is served (got ${liveRoute.status})`);
  // Every route ever published is live, key-gated, or retired - and every
  // retired one answers 410 on the wire, never the guessed-slug 404.
  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const live = segmentsOf((pricing.endpoints || []).map((e) => e.path));
  ok(live.tools.size >= 100, `the booted catalog is read (${live.tools.size} tool segments, ${live.packs.size} packs)`);
  const acct = accountFor({ snapshot, live, gated });
  ok(acct.unaccounted.length === 0, `every published route is live, key-gated or retired (unaccounted: ${acct.unaccounted.join(", ") || "none"}; add each to src/retired-tools.js)`);
  ok(acct.missingFromSnapshot.length === 0, `every live route is in the snapshot (missing: ${acct.missingFromSnapshot.join(", ") || "none"}; run node scripts/published-slugs.js --write)`);
  const bad = [];
  for (const slug of snapshot.tools) {
    if (live.tools.has(slug) || gated.tools.has(slug)) continue;
    const r = await fetch(`${base}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json().catch(() => ({}));
    const repl = RETIRED_TOOLS[slug]?.replacement || null;
    if (!(r.status === 410 && b.error === "gone" && b.slug === slug && (repl ? b.replacement?.slug === repl : b.replacement === null))) bad.push(`/api/${slug} ${r.status}`);
  }
  for (const slug of snapshot.packs) {
    if (live.packs.has(slug)) continue;
    const r = await fetch(`${base}/api/skill/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json().catch(() => ({}));
    if (!(r.status === 410 && b.slug === slug)) bad.push(`/api/skill/${slug} ${r.status}`);
    const pr = await fetch(`${base}/api/skill-packs/${slug}/prompt`);
    if (pr.status !== 410) bad.push(`/api/skill-packs/${slug}/prompt ${pr.status}`);
  }
  ok(bad.length === 0, `every retired snapshot route answers 410 with its registry replacement (wrong: ${bad.join(", ") || "none"})`);
  const research = await (await fetch(`${base}/api/research-company?ticker=AAPL`)).json();
  ok(research.replacement?.slug === "skill-company-dossier" && /^POST \/api\/skill\/company-dossier$/.test(research.replacement?.route || ""), "a pack can be a tool's replacement, with the pack's own route");
  const livePack = [...live.packs][0];
  ok((await fetch(`${base}/api/skill-packs/${livePack}/prompt`)).status === 200, `a live pack's prompt is still served (${livePack})`);
  const tpl = await fetch(`${base}/api/skill-packs/%7Bslug%7D/prompt`);
  const tb = await tpl.json();
  ok(tpl.status === 400 && tb.error === "placeholder" && /skill-packs\.json/.test(tb.list || ""), `the documented template called with its placeholder is a 400 naming the list (got ${tpl.status})`);
  ok((await fetch(`${base}/api/skill-packs/never-a-pack/prompt`)).status === 404, "an unknown pack's prompt is still 404");
  const conv = await fetch(`${base}/api/convert/km-to-miles`);
  ok(conv.status === 410, `the retired converters keep their own teaching 410 (got ${conv.status})`);
} finally { proc.kill("SIGTERM"); }
console.log(`OK: ${pass} passed`);
