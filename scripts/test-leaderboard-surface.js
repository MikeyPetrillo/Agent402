// Lock the /api/leaderboard surfacing into every SEO/discovery surface so a
// future deploy can't silently drop it. Offline — pure functions only, no
// server, no network, no secrets.
import { robotsTxt, sitemapXml, llmsTxt } from "../src/seo.js";
import { serviceManifest } from "../src/discovery.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

const BASE = "https://agent402.tools";

// Minimal catalog so the generators have something to enumerate.
const CATALOG = {
  "POST /api/extract": { name: "Extract", slug: "extract", category: "web", price: "$0.005", description: "Extract markdown from a URL.", tags: [], discovery: { input: { url: "https://example.com" } } },
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "SHA-256 of text.", tags: [], discovery: { input: { text: "hi" } } },
};
const PRICES = { extract: 0.005, hash: 0.001 };
const POW = new Set(["hash"]);
const WALLET = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";

// ---- robots.txt ----
const robots = robotsTxt(BASE);
ok(robots.includes(`${BASE}/api/leaderboard`), "robots.txt advertises /api/leaderboard");
ok(robots.includes(`${BASE}/api/route`), "robots.txt still advertises /api/route");
ok(robots.includes(`${BASE}/api/find?q={task}`), "robots.txt still advertises /api/find");

// ---- sitemap.xml ----
const sitemap = sitemapXml(BASE, CATALOG);
ok(sitemap.includes(`<loc>${BASE}/api/leaderboard</loc>`), "sitemap.xml lists /api/leaderboard");
ok(sitemap.includes(`<loc>${BASE}/leaderboard</loc>`), "sitemap.xml lists HTML /leaderboard");
ok(sitemap.includes(`<loc>${BASE}/api/route</loc>`), "sitemap.xml still lists /api/route");
ok(sitemap.includes(`<loc>${BASE}/api/find</loc>`), "sitemap.xml still lists /api/find");

// ---- llms.txt ----
const llms = llmsTxt(BASE, CATALOG);
ok(llms.includes("/api/leaderboard"), "llms.txt mentions /api/leaderboard");
ok(/leaderboard/i.test(llms), "llms.txt uses the word 'leaderboard'");
ok(/eth_getLogs/.test(llms), "llms.txt explains the pipeline (eth_getLogs)");
ok(llms.includes("/api/route") && llms.includes("/api/find"), "llms.txt still advertises route + find");
// MCP + SDK parity: the leaderboard primitive lives on three surfaces now;
// llms.txt must mention all three so an LLM crawling the doc learns it can
// reach the same data via the MCP tool or the SDK method, not just the JSON.
ok(llms.includes("sellers.list"), "llms.txt names the MCP tool sellers.list");
ok(llms.includes("topSellers"), "llms.txt names the SDK method topSellers()");
ok(/\?sort=usd\|calls/.test(llms), "llms.txt documents the ?sort=usd|calls param");

// ---- service manifest (/.well-known/x402) ----
const manifest = serviceManifest({
  baseUrl: BASE, network: "base", networks: ["base", "polygon"],
  wallet: WALLET, walletName: "agent402.base.eth", catalog: CATALOG,
  toolCount: Object.keys(CATALOG).length, powSlugs: POW, powDifficulty: 20, prices: PRICES,
});
ok(manifest.machineReadable.leaderboard === `${BASE}/api/leaderboard`, "manifest.machineReadable.leaderboard set");
ok(manifest.discovery.leaderboard === `${BASE}/api/leaderboard`, "manifest.discovery.leaderboard set");
ok(manifest.discovery.leaderboardHtml === `${BASE}/leaderboard`, "manifest.discovery.leaderboardHtml set");
ok(manifest.discovery.refreshSeconds.leaderboard === 3600, "manifest.discovery.refreshSeconds.leaderboard = 3600");
// Sort lens must be advertised so machine consumers learn the new param —
// it mirrors the HTML toggle on /leaderboard. Default is "usd";
// "calls" ranks by raw call volume.
ok(Array.isArray(manifest.discovery.sortOptions), "manifest.discovery.sortOptions is an array");
ok(manifest.discovery.sortOptions.includes("usd") && manifest.discovery.sortOptions.includes("calls"), "manifest.discovery.sortOptions advertises both 'usd' and 'calls'");
// Cross-protocol surface index: the leaderboard primitive ships on three
// equivalent surfaces. The manifest must name all three so a Bazaar crawler
// or custom router can dispatch on the typed shape (not just prose).
ok(manifest.discovery.leaderboardSurfaces && typeof manifest.discovery.leaderboardSurfaces === "object", "manifest.discovery.leaderboardSurfaces present");
ok(manifest.discovery.leaderboardSurfaces.http === `${BASE}/api/leaderboard`, "leaderboardSurfaces.http = /api/leaderboard");
ok(manifest.discovery.leaderboardSurfaces.mcpTool === "sellers.list", "leaderboardSurfaces.mcpTool = sellers.list");
ok(manifest.discovery.leaderboardSurfaces.sdkMethod === "topSellers", "leaderboardSurfaces.sdkMethod = topSellers");
ok(manifest.machineReadable.findTool && manifest.discovery.neutralRouter, "manifest still exposes find + router");
// Must serialize (it is served as JSON).
JSON.parse(JSON.stringify(manifest));

console.log("test-leaderboard-surface: OK");
