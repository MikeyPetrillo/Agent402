// The shared header: Pricing, Company and Status as plain top-level links,
// exactly one primary action, and every destination the header and footer
// linked before still linked from the same place.
//
// Offline: renders the shell (src/ledger-chrome.js); no server, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ledgerShell, ledgerFooterCompact, setDecideLive, NAV_PRIMARY_ACTION } from "../src/ledger-chrome.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function render(activePath) {
  const html = ledgerShell({ title: "t", description: "d", canonical: "https://x.test/p", baseUrl: "https://x.test", activePath, body: ledgerFooterCompact() });
  const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
  const cut = nav.indexOf('id="ml-mobile-menu"');
  return { nav, desktop: nav.slice(0, cut), mobile: nav.slice(cut), footer: html.slice(html.lastIndexOf("<footer"), html.lastIndexOf("</footer>")) };
}
const hrefs = (s) => new Set([...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
// Each <a class="btn btn-primary ..."> as { href, label }.
const primaries = (s) => [...s.matchAll(/<a class="btn btn-primary[^"]*" href="([^"]+)">([^<]*)<\/a>/g)].map((m) => ({ href: m[1], label: m[2] }));

// The header and footer destinations at the batch base (8e2677602), with the
// decide tools live (their superset). Each must still be linked from the same
// region: the desktop bar or its panels, the tap menu, the footer.
const BEFORE = {
  desktop: ["/", "/101", "/agentic-finance", "/blog", "/changelog", "/contribute", "/decide", "/docs", "/glossary", "/guides", "/guides/smart-order-router", "/how-to-pay", "/integrations", "/leaderboard", "/llms.txt", "/marketplace", "/marketplace/tools", "/markets", "/mpp-marketplace", "/playground", "/pricing", "/proof", "/quickstart", "/reports", "/revenue", "/sell", "/skills", "/speech", "/status", "/tollbooth", "/tools", "/tools/category/crypto", "/tools/category/llm", "/what-is-mpp", "/what-is-x402", "/x402-test", "https://live.agent402.tools"],
  mobile: ["/101", "/agentic-finance", "/blog", "/changelog", "/contribute", "/decide", "/docs", "/glossary", "/guides", "/guides/smart-order-router", "/how-to-pay", "/integrations", "/leaderboard", "/llms.txt", "/marketplace", "/marketplace/tools", "/markets", "/mpp-marketplace", "/playground", "/pricing", "/proof", "/quickstart", "/reports", "/revenue", "/sell", "/skills", "/speech", "/status", "/tollbooth", "/tools", "/tools/category/crypto", "/tools/category/llm", "/what-is-x402", "https://live.agent402.tools"],
  footer: ["/", "/.well-known/x402", "/SKILL.md", "/api/pricing", "/api/stats", "/api/status", "/crawler", "/decide", "/docs", "/docs/webhooks", "/llms.txt", "/marketplace", "/monitors", "/openapi.json", "/pricing", "/privacy", "/reports", "/revenue", "/security", "/sell", "/status", "/terms", "/tools", "/transparency", "/x402-test", "https://havok.holdings", "https://x.com/Agent402Tools", "mailto:mike@agent402.tools"],
};

for (const decide of [false, true]) {
  setDecideLive(decide);
  const tag = decide ? " (decide live)" : "";
  const page = render("/quickstart");

  // Pricing, Company, Status: plain links in the desktop link row, in that order.
  const row = page.desktop.slice(page.desktop.indexOf('class="ml-nav-links"'));
  const plain = [...row.matchAll(/<a class="ml-nav-link[^"]*" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
  const want = ["Pricing /pricing", "Company /company", "Status /status"];
  const at = plain.indexOf(want[0]);
  ok(at >= 0 && want.every((w, i) => plain[at + i] === w), `the bar lists Pricing, Company, Status as plain links${tag} (plain links: ${plain.join(", ")})`);
  ok(["/pricing", "/company", "/status"].every((h) => hrefs(page.mobile).has(h)), `the tap menu lists them too${tag}`);

  // Exactly one primary action: one destination and label, in the bar and
  // (for phones, where the bar has no room) first in the tap menu.
  const all = primaries(page.nav);
  const distinct = new Set(all.map((p) => `${p.href} ${p.label}`));
  ok(distinct.size === 1 && all[0].href === NAV_PRIMARY_ACTION.href && all[0].label === NAV_PRIMARY_ACTION.label, `the header carries exactly one primary action, ${NAV_PRIMARY_ACTION.label} -> ${NAV_PRIMARY_ACTION.href}${tag} (found ${[...distinct].join(" | ") || "none"})`);
  ok(primaries(page.desktop).length === 1, `the bar shows it once${tag}`);
  ok(/class="btn btn-primary btn-sm ml-nav-cta"/.test(page.desktop) && /class="ml-mm-cta"/.test(page.mobile), `the bar copy and the tap-menu copy carry the classes that show one per width${tag}`);
  ok(!/class="ml-nav-link[^"]*btn|class="btn[^"]*ml-nav-link/.test(page.desktop), `the three links are links, not buttons${tag}`);

  // The home page's hero carries the same action; its header does not repeat it.
  const home = render("");
  ok(primaries(home.nav).length === 0, `the home page header leaves the primary action to the hero${tag}`);

  // Nothing linked before is lost from its region.
  if (decide) {
    for (const region of ["desktop", "mobile", "footer"]) {
      const now = hrefs(page[region]);
      const missing = BEFORE[region].filter((h) => !now.has(h));
      ok(missing.length === 0, `every ${region} destination linked before is still linked there (missing: ${missing.join(", ") || "none"})`);
    }
  }

  // A page in the new links lights only its own link, not a panel trigger too.
  for (const [path, label] of [["/pricing", "Pricing"], ["/status", "Status"], ["/company", "Company"]]) {
    const p = render(path);
    const on = [...p.desktop.matchAll(/class="ml-nav-link ml-nav-link-on[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
    ok(on.length === 1 && on[0] === path, `${label} lights its own link alone${tag} (lit: ${on.join(", ") || "none"})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
