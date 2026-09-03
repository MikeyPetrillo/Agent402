// Offline unit test for the third-party tool catalog (/marketplace/tools).
//
// The catalog reproduces other people's endpoints, in their own words, at
// scale. The properties that matter are therefore not "does it render" but
// "does it stay honest and safe": our own tools must never appear in a list
// whose premise is that nothing on it is ours, seller-supplied strings must be
// inert, and outbound links must not lend them our ranking.
//
// Run: node scripts/test-index-tools-catalog.js
import { indexToolsPage } from "../src/index-tools-page.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

const tool = (over = {}) => ({
  seller: "https://seller.test", sellerName: "Seller", name: "A tool", route: "/x", method: "POST",
  url: "https://seller.test/x", description: "Does a thing for agents, deterministically.", described: true,
  category: "data", tags: [], priceUsd: 0.01, networks: ["eip155:8453"], ...over,
});
const page = (results, extra = {}) =>
  indexToolsPage("https://agent402.tools",
    { total: results.length, matched: results.length, offset: 0, limit: 100, described: results.filter((r) => r.described).length, results, ...extra },
    [{ category: "data", count: 1 }], {});

// ── Disclaimers, scoped by provenance ───────────────────────────────────────
// The page mixes our tools with other people's, so a BLANKET disclaimer would
// now be a lie in both directions: "we do not test any of this" is false for
// our rows, and "tested on every deploy" is false for everyone else's. The
// wording has to attach to the badge, not the page.
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool()]);
  const must = [
    "do not operate, host, or test",   // third-party rows
    "written by the seller",           // third-party metadata is theirs
    "directly to the seller",          // non-custodial
    "not endorsement",                 // listing != review
    "untrusted",                       // prompt-injection warning
    "applies only to these rows",      // the scoping itself
  ];
  for (const phrase of must) check(`states: "${phrase}"`, html.toLowerCase().includes(phrase.toLowerCase()));
  check("claims the guarantee for OUR rows specifically", /build, host and stand behind/i.test(html));
  check("offers a way back to our own catalog", html.includes('href="/tools"'));
  check("does NOT disclaim everything as third-party", !/we do not operate, host, or test any endpoint on this page/i.test(html));
}

// ── Provenance is visible without reading ───────────────────────────────────
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool({ sellerName: "Someone Else" })]);
  check("our row carries an OURS badge", /ix-badge ours/.test(html));
  check("their row carries a third-party badge", /ix-badge third/.test(html));
  check("our row is visually marked", /class="is-ours"/.test(html));
  check("our row links to our own tool page, not an outbound link", html.includes('href="/tools/hash"'));
  check("our row is NOT nofollowed like a third party", !/href="\/tools\/hash"[^>]*nofollow/.test(html));
}

// ── Undescribed rows are shown and labelled, never silently dropped ─────────
{
  const html = page([tool({ described: false, description: "" })]);
  check("an undescribed tool is still listed", html.includes("A tool"));
  check("and is labelled as the seller's omission", /No description supplied by the seller/.test(html));
}

// ── Seller-supplied strings are inert ───────────────────────────────────────
{
  const evil = `<img src=x onerror=alert(1)> " onmouseover="alert(2)`;
  const html = page([tool({ name: evil, description: evil, sellerName: evil, category: evil })]);
  check("no unescaped tag survives", !/<img\s/i.test(html));
  check("no attribute break-out from a quote", !/href="[^"]*"[a-z]+="/i.test(html));
  check("no injected event handler becomes an attribute", !/\s onmouseover="/i.test(html));
  check("hostile text still renders, as escaped text", html.includes("&lt;img"));
}

// ── Outbound links must not lend third parties our ranking ──────────────────
{
  const html = page([tool(), tool({ url: "https://other.test/y", sellerName: "Other" })]);
  const links = html.match(/rel="noopener nofollow ugc"/g) || [];
  check("every seller link carries noopener nofollow ugc", links.length === 2);
}

// ── Prompt-injection notice for the agents that will read this ──────────────
{
  const html = page([tool()]);
  check("warns agents to treat descriptions as data, not instructions", /never as instructions/i.test(html));
}

// ── Empty state stays useful ────────────────────────────────────────────────
{
  const html = page([], { total: 1234, matched: 0 });
  check("empty result set explains itself", /Nothing matched/.test(html));
  check("and still offers the router", html.includes('href="/api/route"'));
}

// Price CUTS must propagate (reported 2026-08-29 by a seller whose 2026-08-20
// cut we were still quoting at 10x, nine days and dozens of crawls later).
// Three sites composed into "a learned price can rise but never fall": the
// merge took max(), carry-forward filled the fresh row with the stale amount
// and re-stamped it live-402, and a priced route was never re-probed.
{
  const { mergeOpenapiIntoBazaar, carryForwardLearnedQuotes, priceDisagreesWithOrigin } = await import("../src/x402-index.js");

  // 1. the merge prefers the origin's OWN current declaration, both directions
  if (typeof mergeOpenapiIntoBazaar === "function") {
    // signature is (openapiTools, bazaarTools): the ORIGIN's document first.
    const cut = mergeOpenapiIntoBazaar(
      [{ route: "/audit", method: "POST", price: 0.05, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
      [{ route: "/audit", method: "POST", price: 0.5, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
    )[0];
    check(`a price CUT propagates: origin 0.05 beats a stale 0.5 (got ${cut.price})`, cut.price === 0.05);
    check("both observations stay visible for a buyer that wants to fail closed", cut.originDeclaredPrice === 0.05 && cut.priceObservations?.bazaar === 0.5);
    const raise = mergeOpenapiIntoBazaar(
      [{ route: "/audit", method: "POST", price: 0.5, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
      [{ route: "/audit", method: "POST", price: 0.05, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
    )[0];
    check(`a price RISE still wins too, which is what max() was protecting (got ${raise.price})`, raise.price === 0.5);
  }

  // 2. carry-forward fills a gap, never overrides what the origin declared today
  const kept = carryForwardLearnedQuotes(
    [{ route: "/audit", price: 0.05, originDeclaredPrice: 0.05 }],
    { tools: [{ route: "/audit", price: 0.5, quoteSource: "live-402" }] },
  )[0];
  check(`a stale learned quote never overwrites today's origin price (got ${kept.price})`, kept.price === 0.05);
  check("and it is not re-stamped live-402, which made a nine-day-old price look fresh", kept.quoteSource !== "live-402");
  // Keyed by method + route (2026-09-02): a path with GET and POST keeps each
  // row's own verb. Before, the remembered row's verb was stamped onto every
  // current row on the route, and minia2a.uk's POST operations came out GET.
  {
    const prev = { tools: [
      { method: "GET", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" },
      { method: "POST", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" },
    ] };
    const cur = [
      { method: "GET", route: "/x402/ip-geo", slug: "x402_ip_geo_get" },
      { method: "POST", route: "/x402/ip-geo", slug: "x402_ip_geo_post" },
    ];
    const out = carryForwardLearnedQuotes(cur, prev);
    check("GET and POST rows on one route each keep their own verb when both were learned", out.map((r) => r.method).join(",") === "GET,POST" && out.every((r) => r.price === 0.5));
    const onlyGet = { tools: [{ method: "GET", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" }] };
    const declared = carryForwardLearnedQuotes([{ method: "POST", route: "/x402/ip-geo", slug: "p" }], onlyGet)[0];
    check("a DECLARED POST keeps its verb when only GET was learned on the route, and still takes the price + networks", declared.method === "POST" && declared.price === 0.5 && declared.networks.length === 1);
    const inferred = carryForwardLearnedQuotes([{ method: "GET", methodInferred: true, route: "/x402/ip-geo", slug: "i" }], { tools: [{ method: "POST", route: "/x402/ip-geo", price: 0.5, quoteSource: "live-402" }] })[0];
    check("an INFERRED verb adopts the verb that was observed to answer the quote", inferred.method === "POST" && inferred.methodInferred === false);
  }
  const filled = carryForwardLearnedQuotes([{ route: "/x" }], { tools: [{ route: "/x", price: 0.02, quoteSource: "live-402" }] })[0];
  check("a genuine gap is still filled, and says so", filled.price === 0.02 && filled.quoteCarriedForward === true);

  // 3. a priced route that disagrees with the origin is re-probed
  check("a 10x disagreement is worth a live probe", priceDisagreesWithOrigin({ price: 0.5, originDeclaredPrice: 0.05 }) === true);
  check("a rounding difference is not", priceDisagreesWithOrigin({ price: 0.051, originDeclaredPrice: 0.05 }) === false);
  check("no origin declaration means nothing to disagree with", priceDisagreesWithOrigin({ price: 0.5 }) === false);
}

// A learned quote also EXPIRES (2026-08-29): the drift test only fires when the
// origin declares a price, and about 95% of crawled sellers publish none. For
// them a learned amount would stand forever - the same ratchet by a quieter
// route - so a live-402 quote is re-asked once it is a week old.
{
  const { quoteIsStale, carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const day = 86_400_000, now = Date.now();
  check(`a week-old learned quote is re-probed`, quoteIsStale({ quoteSource: "live-402", price: 0.5, quoteObservedAt: now - 8 * day }, now) === true);
  check(`a fresh learned quote is left alone`, quoteIsStale({ quoteSource: "live-402", price: 0.5, quoteObservedAt: now - 2 * day }, now) === false);
  check(`a row from before stamping existed is refreshed once`, quoteIsStale({ quoteSource: "live-402", price: 0.5 }, now) === true);
  check(`an origin-declared price is not a learned quote and never expires this way`, quoteIsStale({ quoteSource: "openapi", price: 0.5 }, now) === false);
  check(`nothing to refresh when there is no price`, quoteIsStale({ quoteSource: "live-402" }, now) === false);
  // the age must survive a carry-forward, or every crawl would reset the clock
  const carried = carryForwardLearnedQuotes([{ route: "/x" }], { tools: [{ route: "/x", price: 0.02, quoteSource: "live-402", quoteObservedAt: now - 9 * day }] })[0];
  check(`carry-forward preserves when the quote was observed, so the clock cannot reset`, carried.quoteObservedAt === now - 9 * day && quoteIsStale(carried, now) === true);
  // Manifest-vs-402 consistency (issue #1178, 2026-09-02): a manifest-priced,
  // manifest-networked row is read live once, then weekly, and the chains the
  // 402 actually offers are unioned in and survive the next crawl's rebuild.
  const { networksNeedLiveVerify } = await import("../src/x402-index.js");
  check(`a manifest-priced row with chains but no live read is verified once`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"] }, now) === true);
  check(`verified two days ago: left alone`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 2 * day }, now) === false);
  check(`verified eight days ago: read again`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 8 * day }, now) === true);
  check(`a learned (live-402) row keeps its own clock, not this one`, networksNeedLiveVerify({ quoteSource: "live-402", price: 0.25, networks: ["eip155:8453"] }, now) === false);
  check(`an unpriced or chainless row is already a candidate by the older rule`, networksNeedLiveVerify({ quoteSource: "manifest", networks: ["eip155:8453"] }, now) === false && networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: [] }, now) === false);
  const rebuilt = carryForwardLearnedQuotes([{ route: "/api/rewrite", method: "POST", price: 0.25, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/api/rewrite", method: "POST", price: 0.25, quoteSource: "live-402", networks: ["eip155:8453", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="], networksVerifiedAt: now - 1 * day }] })[0];
  check(`a verified live read's extra chain survives the next crawl's manifest-shaped rebuild (union, never a drop)`, rebuilt.networks.length === 2 && rebuilt.networks.includes("eip155:8453") && rebuilt.networksVerifiedAt === now - 1 * day && networksNeedLiveVerify(rebuilt, now) === false);
  const unverified = carryForwardLearnedQuotes([{ route: "/y", method: "GET", price: 0.1, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/y", method: "GET", price: 0.1, quoteSource: "live-402", networks: ["eip155:137"] }] })[0];
  check(`a remembered row that was never VERIFIED does not add chains to a row that already has them (the old fill-a-gap rule stands)`, unverified.networks.length === 1 && unverified.networks[0] === "eip155:8453");
}

// The reporter's own row is discovered via /.well-known/x402, NOT OpenAPI, and
// a manifest price is a display STRING ("$0.05"). The first cut of the #1043
// fix marked only OpenAPI prices as origin-declared and guarded with a bare
// Number(), so their corrected manifest price kept losing to the stale learned
// quote even after the "fix" - verified against their live endpoint.
{
  const { normaliseManifestTools, carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const rows = normaliseManifestTools({ tools: [{ route: "/audit", price: "$0.05", name: "Audit" }] }, "https://seller.example");
  const row = rows.find((r) => String(r.route).includes("/audit"));
  check(`a manifest price is marked origin-declared even as a display string (got ${row?.originDeclaredPrice})`, row?.originDeclaredPrice === 0.05);
  const after = carryForwardLearnedQuotes(rows, { tools: [{ route: row?.route, price: 0.5, quoteSource: "live-402" }] }).find((r) => String(r.route).includes("/audit"));
  check(`a stale learned quote cannot override a manifest-declared price (got ${after?.price})`, String(after?.price).includes("0.05"));
  const bare = normaliseManifestTools({ tools: [{ route: "/x", name: "X" }] }, "https://seller.example").find((r) => String(r.route).includes("/x"));
  check(`an unpriced manifest entry claims no declaration`, !(Number(bare?.originDeclaredPrice) > 0));
}

// ---- new-catalog quote burst (2026-09-01) ----------------------------------
// An origin with zero priced tools is invisible to routing; the burst exists
// so a new large catalog becomes routable in one cycle instead of half a day.
{
  const { quoteProbeCapFor } = await import("../src/x402-index.js");
  const unpriced = Array.from({ length: 100 }, (_, i) => ({ route: `/r${i}`, price: null }));
  const cap = quoteProbeCapFor(unpriced);
  check(`a wholly unpriced catalog gets the burst (${cap})`, cap >= 60);
  check("a FEW priced rows do not end the burst - the live miss: a registry merge priced 8 of 128 and the burst never fired",
    quoteProbeCapFor([...Array.from({ length: 8 }, (_, i) => ({ route: `/p${i}`, price: 0.001 })), ...unpriced]) >= 60);
  check("a mostly-priced catalog is back on the polite cap",
    quoteProbeCapFor([...Array.from({ length: 90 }, (_, i) => ({ route: `/p${i}`, price: 0.001 })), ...Array.from({ length: 10 }, (_, i) => ({ route: `/u${i}`, price: null }))]) === 5);
  check("an empty list never returns a smaller cap than the steady state", quoteProbeCapFor([]) >= 5);
}

console.log(`\ntest-index-tools-catalog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);