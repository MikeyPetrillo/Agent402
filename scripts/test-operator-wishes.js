// Offline unit tests for the token-gated operator demand board
// (src/operator-wishes.js) and its robots.txt disallow. Pure rendering, no
// server boot: the route-level 404 gate is exercised by the manual/boot path;
// here we assert the page reflects the qualification verdicts correctly and
// that the operator surface is kept out of robots.
import { operatorWishesPage } from "../src/operator-wishes.js";
import { robotsTxt } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BASE = "https://agent402.tools";
const aggregate = {
  distinctClusters: 4,
  totalWishes: 130,
  threshold: 5,
  qualifyMinSpanHours: 24,
  clusters: [
    // single-source burst — at threshold but must read as held, not qualified
    { text: "synthora mesh 962 m2m", count: 103, qualified: false,
      sources: { api: 103, mcp: 0, "find-miss": 0 }, firstSeen: "2026-07-17T02:00:00.000Z", lastSeen: "2026-07-17T06:00:00.000Z" },
    // genuine multi-source demand — qualified
    { text: "convert heic to png batch", count: 6, qualified: true,
      sources: { api: 2, mcp: 2, "find-miss": 2 }, firstSeen: "2026-07-15T10:00:00.000Z", lastSeen: "2026-07-16T10:00:00.000Z" },
    // below threshold
    { text: "solidity auditor", count: 2, qualified: false,
      sources: { api: 0, mcp: 0, "find-miss": 2 }, firstSeen: "2026-07-13T10:00:00.000Z", lastSeen: "2026-07-13T10:05:00.000Z" },
    // hostile raw text: the aggregate carries buyer text as written
    { text: "<script>alert(1)</script><img src=x onerror=alert(2)> &lt;kept&gt; \"q\" 'a'", count: 1, qualified: false,
      sources: { api: 1, mcp: 0, "find-miss": 0 }, firstSeen: "2026-07-16T00:00:00.000Z", lastSeen: "2026-07-16T00:00:00.000Z" },
  ],
};

const html = operatorWishesPage(BASE, aggregate);

// --- summary reflects the split ---
ok(/Distinct clusters/.test(html) && html.includes(">4<"), "summary shows distinct cluster count");
ok(html.includes("Qualified") && html.includes(">1<"), "summary shows 1 qualified");
ok(/Held/.test(html), "summary shows the held (spam/near-miss) bucket");

// --- per-cluster verdicts ---
ok(/qualified<\/span>/.test(html), "a qualified cluster renders the qualified badge");
ok(/single-source<\/span>/.test(html), "the single-source burst renders as single-source, not qualified");
ok(/below<\/span>/.test(html), "the sub-threshold cluster renders as below");
ok(html.includes("one surface, not corroborated"), "single-source note explains why it is held");

// --- the operator can see everything, including unqualified/below rows ---
ok(html.includes("synthora mesh 962 m2m"), "single-source spam is still visible to the operator");
ok(html.includes("convert heic to png batch"), "qualified demand is visible");
ok(html.includes("solidity auditor"), "below-threshold demand is visible");

// --- raw text is escaped where it is rendered ---
ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script>alert") && !html.includes("<img src=x"), "hostile wish text renders as inert text");
ok(html.includes("&amp;lt;kept&amp;gt;"), "an entity the buyer typed is shown as typed, not decoded");
ok(html.includes("&quot;q&quot;") && html.includes("&#39;a&#39;"), "quotes are escaped too");

// --- privacy: gated + advertised as non-public, kept out of robots ---
ok(html.includes("AGENT402_OPERATOR_TOKEN"), "page states it is token-gated");
ok(/Not public/.test(html), "page is labelled not public");
const robots = robotsTxt(BASE);
ok(/^Disallow: \/__operator$/m.test(robots), "robots.txt disallows /__operator");

// --- empty state ---
const empty = operatorWishesPage(BASE, { distinctClusters: 0, totalWishes: 0, threshold: 5, qualifyMinSpanHours: 24, clusters: [] });
ok(/No wishes recorded yet/.test(empty), "empty board renders a friendly empty state");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
