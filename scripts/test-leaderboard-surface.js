// Lock the /api/leaderboard surfacing into every SEO/discovery surface so a
// future deploy can't silently drop it. Offline — pure functions only, no
// server, no network, no secrets.
import { robotsTxt, sitemapXml, llmsTxt } from "../src/seo.js";
import { landingPage } from "../src/landing.js";
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

console.log("test-leaderboard-surface: OK");
