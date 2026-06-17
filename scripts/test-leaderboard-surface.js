// Lock the /api/leaderboard surfacing into every SEO/discovery surface so a
// future deploy can't silently drop it. Offline — pure functions only, no
// server, no network, no secrets.
import { robotsTxt, sitemapXml, llmsTxt } from "../src/seo.js";
import { landingPage } from "../src/landing.js";
import { serviceManifest } from "../src/discovery.js";
import { leaderboardPage, windowLabelFromBlocks } from "../src/leaderboard.js";

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
ok(manifest.machineReadable.findTool && manifest.discovery.neutralRouter, "manifest still exposes find + router");
// Must serialize (it is served as JSON).
JSON.parse(JSON.stringify(manifest));

// ---- landing page (HTML title, meta, JSON-LD FAQ, visible callout) ----
const html = landingPage(BASE, "base", false, CATALOG, null);
ok(/<title>[^<]*Leaderboard[^<]*<\/title>/i.test(html), "landing <title> mentions Leaderboard");
ok(/<title>[^<]*Find[^<]*<\/title>/i.test(html), "landing <title> mentions Find");
ok(/<title>[^<]*Router[^<]*<\/title>/i.test(html), "landing <title> mentions Router");
ok(/<meta name="description"[^>]*Leaderboard/i.test(html) || /<meta name="description"[^>]*leaderboard/.test(html), "meta description mentions leaderboard");
ok(/og:title[^>]*Leaderboard/i.test(html), "og:title mentions Leaderboard");
ok(/og:image[^>]*\/card\.png/.test(html), "og:image points at /card.png");
ok(/twitter:card[^>]*summary_large_image/.test(html), "twitter card present");
ok(html.includes('href="/api/leaderboard"'), "landing has a visible link to /api/leaderboard");
ok(/How do I see which x402 sellers are most used\?/.test(html), "FAQ JSON-LD/visible includes the leaderboard question");

// JSON-LD FAQPage must include the leaderboard question on the machine side too.
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(ldBlocks.length >= 1, "at least one JSON-LD block present");
let faqMatched = false;
for (const block of ldBlocks) {
  try {
    const parsed = JSON.parse(block);
    const graph = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const node of graph) {
      if (node && node["@type"] === "FAQPage" && Array.isArray(node.mainEntity)) {
        if (node.mainEntity.some((q) => /leaderboard/i.test(q.name) || /leaderboard/i.test(q?.acceptedAnswer?.text || ""))) {
          faqMatched = true;
        }
      }
    }
  } catch { /* not strict JSON — skip */ }
}
ok(faqMatched, "JSON-LD FAQPage contains a leaderboard Q&A");

// ---- windowLabelFromBlocks ----
// Maps block count → human window label so the HTML page can say "24h" / "7d"
// instead of "43200 blocks". Base block time is ~2s.
ok(windowLabelFromBlocks(43200) === "24h", "43200 blocks → 24h");
ok(windowLabelFromBlocks(302400) === "7d", "302400 blocks → 7d");
ok(windowLabelFromBlocks(9000) === "5h", "9000 blocks → 5h");
ok(windowLabelFromBlocks(0) === "—", "zero blocks → em-dash");

// ---- HTML /leaderboard page ----
// Cache-warming state (no scan run yet) — the page must still render cleanly.
const warmingHtml = leaderboardPage(
  { spec: "x402-leaderboard/1", asOf: new Date().toISOString(), warming: true, leaderboard: [] },
  { baseUrl: BASE }
);
ok(/<title>[^<]*Leaderboard[^<]*<\/title>/i.test(warmingHtml), "leaderboardPage <title> mentions Leaderboard");
ok(warmingHtml.includes("Warming the cache"), "warming snapshot renders a warming message");
ok(warmingHtml.includes(`${BASE}/api/leaderboard`), "leaderboardPage links to /api/leaderboard JSON");
ok(warmingHtml.includes('href="/leaderboard"'), "leaderboardPage header marks /leaderboard active");

// Real snapshot with rows — verifies escaping + table render + basescan links.
const snap = {
  spec: "x402-leaderboard/1",
  asOf: "2026-06-16T20:00:00.000Z",
  scannedBlocks: 43200,
  windowLabel: "24h",
  maxCallUsd: 0.5,
  scannedSellers: 12,
  walletsQueried: 12,
  bazaarTotal: 1234,
  leaderboard: [
    { rank: 1, name: "Acme x402", origins: ["https://acme.example"], homepage: "https://acme.example", endpoints: 4, wallet: "0xabcdef0000000000000000000000000000001234", network: "base", callsSettled: 42, totalUsd: 0.42, uniqueBuyers: 9 },
    { rank: 2, name: "<script>x", origins: [], homepage: null, endpoints: 1, wallet: "0x1111111111111111111111111111111111111111", network: "base", callsSettled: 1, totalUsd: 0.001, uniqueBuyers: 1 },
  ],
};
const html2 = leaderboardPage(snap, { baseUrl: BASE });
ok(html2.includes("Acme x402"), "leaderboardPage renders seller names");
ok(html2.includes("basescan.org/address/0xabcdef0000000000000000000000000000001234"), "leaderboardPage links wallet to Basescan");
ok(!/<script>x</.test(html2), "leaderboardPage escapes HTML in seller names");
ok(html2.includes("&lt;script&gt;x"), "leaderboardPage HTML-escapes hostile names");
ok(html2.includes("$0.4200") || html2.includes("$0.420"), "leaderboardPage formats USDC totals");
ok(html2.includes("Last 24h"), "leaderboardPage labels the active window in human terms");
ok(html2.includes("USDC settled"), "leaderboardPage uses 'USDC settled' column header (clarity over raw 'USDC')");
ok(html2.includes("$0 \u2260 no revenue"), "leaderboardPage explains that 0 in-window is not lifetime revenue");

console.log("test-leaderboard-surface: OK");
