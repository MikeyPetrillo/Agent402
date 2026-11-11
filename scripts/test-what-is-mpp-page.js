// Offline unit tests for /what-is-mpp (src/what-is-mpp.js, Aug 2026 revamp
// restyle - matches /what-is-x402's visual language). No fixtures needed:
// the page takes only baseUrl, no live data bindings. No server, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { whatIsMppPage } from "../src/what-is-mpp.js";
import { whatIsX402Page } from "../src/what-is-x402.js";
import { pageCtaHrefs } from "./lib/page-ctas.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const html = whatIsMppPage(BASE_URL);

// --- content -------------------------------------------------------------------
ok(html.includes("What is <span") && html.includes(">MPP</span>?"), "hero H1 renders");
ok(html.includes("How one MPP payment works."), "handshake section renders");
ok(html.includes("Where MPP settles today."), "the real 'settles daily via canary' section renders");
ok(html.includes("How do I accept MPP payments on my own API?"), "the accept-it section renders");
ok(html.includes("Questions people and agents ask."), "FAQ heading renders");

// --- comparison: one table, on /what-is-x402 ------------------------------------
// The 2026-11 trim keeps a single x402 vs MPP table (/what-is-x402#compare, the
// broader pillar page) and links it from here, so the two cannot drift apart.
ok(html.includes('id="compare"') && html.includes('href="/what-is-x402#compare"'), "#compare links the one comparison table on /what-is-x402");
ok(!/<th[^>]*>x402<\/th>/.test(html), "this page carries no second x402 vs MPP table");
{
  const x402 = whatIsX402Page(BASE_URL, {});
  const table = (x402.match(/<section id="compare"[\s\S]*?<\/section>/) || [""])[0];
  for (const needle of ["WWW-Authenticate: Payment", "X-PAYMENT", "Payment-Receipt", "PAYMENT-RESPONSE", "IETF Internet-Draft", "own relay", "same facilitator"]) {
    ok(table.includes(needle), `the /what-is-x402 table carries what this page's table said: ${needle}`);
  }
}

// --- cross-links to the sibling explainer page --------------------------------
ok(html.includes('href="/what-is-x402"'), "links to /what-is-x402 (the broader explainer, not duplicated content)");
ok((html.match(/href="\/what-is-x402(#compare)?"/g) || []).length >= 2, "the cross-link to /what-is-x402 appears in the hero and at #compare");
{
  const ctaHrefs = pageCtaHrefs(html);
  ok(ctaHrefs.length > 0 && new Set(ctaHrefs).size === ctaHrefs.length, `one call to action per target (${ctaHrefs.join(", ")})`);
}

// --- structured data -------------------------------------------------------------
ok(html.includes('"@type":"Organization"'), "Organization JSON-LD present");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present (was missing before this restyle)");
ok(html.includes('"@type":"Article"'), "Article JSON-LD present");
{
  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<article style="padding:26px 0/g) || []).length;
  ok(faqLdCount === 5, `FAQPage JSON-LD carries exactly 5 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 5, `visible FAQ prose carries exactly 5 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
}

// --- copy hygiene -----------------------------------------------------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

// --- no template artifacts -------------------------------------------------------
ok(!/undefined|NaN|\[object Object\]/.test(html), "no template artifacts leak into the render");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
