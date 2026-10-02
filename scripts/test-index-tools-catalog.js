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
  // A manifest price is an origin declaration and is stamped as one
  // (originDeclaredPrice, normaliseManifestTools), so the fixtures carry it.
  check(`verified two days ago: left alone`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, originDeclaredPrice: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 2 * day, networksVerifiedMethod: "GET" }, now) === false);
  check(`verified eight days ago: read again`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, originDeclaredPrice: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 8 * day, networksVerifiedMethod: "GET" }, now) === true);
  // The stamp's clock covers the ORIGIN's price. The same fresh stamp on a row
  // whose price nobody declared and no read learned (a registry snapshot the
  // rebuild took after the origin stopped declaring) does not defer the read.
  check(`a fresh stamp beside a price that is neither the origin's nor a live quote asks for a read`,
    networksNeedLiveVerify({ price: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 2 * day, networksVerifiedMethod: "GET" }, now) === true);
  check(`a learned (live-402) row keeps its own clock, not this one`, networksNeedLiveVerify({ quoteSource: "live-402", price: 0.25, networks: ["eip155:8453"] }, now) === false);
  check(`an unpriced or chainless row is already a candidate by the older rule`, networksNeedLiveVerify({ quoteSource: "manifest", networks: ["eip155:8453"] }, now) === false && networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: [] }, now) === false);
  const rebuilt = carryForwardLearnedQuotes([{ route: "/api/rewrite", method: "POST", price: 0.25, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/api/rewrite", method: "POST", price: 0.25, quoteSource: "live-402", networks: ["eip155:8453", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="], networksVerifiedAt: now - 1 * day, networksVerifiedMethod: "POST" }] })[0];
  check(`a verified live read's extra chain survives the next crawl's manifest-shaped rebuild (union, never a drop)`, rebuilt.networks.length === 2 && rebuilt.networks.includes("eip155:8453") && rebuilt.networksVerifiedAt === now - 1 * day && networksNeedLiveVerify(rebuilt, now) === false);
  const unverified = carryForwardLearnedQuotes([{ route: "/y", method: "GET", price: 0.1, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/y", method: "GET", price: 0.1, quoteSource: "live-402", networks: ["eip155:137"] }] })[0];
  check(`a remembered row that was never VERIFIED does not add chains to a row that already has them (the old fill-a-gap rule stands)`, unverified.networks.length === 1 && unverified.networks[0] === "eip155:8453");
}

// A verified live read on an ORIGIN-PRICED row must survive every probe-less
// rebuild (2026-09-28). Such a row is never re-stamped live-402 (the origin's
// price is not a learned quote), so the first rebuild after the read copied
// its chains and payTo once WITHOUT the verification stamp, and the second
// rebuild found nothing remembered at all: chains [] and payTo gone, the
// dispatch label flapping between settlement_required and network_unknown,
// and the wallet the Base scan reads flapping with it. Three rebuilds in a
// row, because the defect only shows on the second.
{
  const { carryForwardLearnedQuotes, networksNeedLiveVerify, quoteIsStale } = await import("../src/x402-index.js");
  const day = 86_400_000, now = Date.now();
  const NETS = ["eip155:8453", "eip155:143", "eip155:137"];
  const PAYTO = "0x2222222222222222222222222222222222222222";
  const ROUTE = "/api/v1/preflight";
  // Crawl N: the probe read the route's 402. It adopted the live amount (0.015,
  // under the drift factor) and stamped the row live-402, as enrichLiveQuotes does.
  const readAt = now - 2 * day;
  const crawlN = (over = {}) => [{
    method: "GET", route: ROUTE, slug: "preflight", price: 0.015, originDeclaredPrice: 0.01,
    networks: [...NETS], networksVerifiedAt: readAt, networksVerifiedMethod: "GET", liveProvenAt: readAt,
    quoteSource: "live-402", quoteObservedAt: readAt, payToByNetwork: { "eip155:8453": PAYTO }, ...over,
  }];
  // Every later crawl rebuilds the row from the origin's own document: the
  // declared price, no chains, no wallet.
  const rebuild = (over = {}) => [{ method: "GET", route: ROUTE, slug: "preflight", price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi", ...over }];

  let prev = crawlN();
  for (let i = 1; i <= 3; i++) {
    const row = carryForwardLearnedQuotes(rebuild(), { tools: prev })[0];
    check(`rebuild ${i}: the verified chains survive (got ${JSON.stringify(row.networks)})`,
      Array.isArray(row.networks) && row.networks.length === 3 && NETS.every((n) => row.networks.includes(n)));
    check(`rebuild ${i}: the payTo the live 402 named survives (got ${JSON.stringify(row.payToByNetwork)})`, row.payToByNetwork?.["eip155:8453"] === PAYTO);
    check(`rebuild ${i}: the verification stamp is carried, not reset or lost (got ${row.networksVerifiedAt})`, row.networksVerifiedAt === readAt);
    check(`rebuild ${i}: the live proof keeps its own timestamp`, row.liveProvenAt === readAt);
    check(`rebuild ${i}: the origin's declared price still wins over the learned amount (got ${row.price})`, row.price === 0.01 && row.quoteCarriedForward !== true);
    check(`rebuild ${i}: an origin-priced row is not relabelled live-402 (got ${row.quoteSource})`, row.quoteSource !== "live-402");
    check(`rebuild ${i}: a fresh verification is left alone by the weekly re-read`, networksNeedLiveVerify(row, now) === false);
    prev = [row];
  }
  // The clock is the READ's, not the rebuild's: a week past the read, the same
  // carried row asks for a live re-read.
  check("a week after the read the carried row is re-verified (the clock was never reset)",
    networksNeedLiveVerify(prev[0], readAt + 8 * day) === true);
  let aged = crawlN({ networksVerifiedAt: now - 8 * day });
  for (let i = 1; i <= 3; i++) aged = carryForwardLearnedQuotes(rebuild(), { tools: aged });
  check(`an EXPIRED verification still carries its chains but asks for a re-read (got needVerify ${networksNeedLiveVerify(aged[0], now)})`,
    aged[0].networks?.length === 3 && aged[0].networksVerifiedAt === now - 8 * day && networksNeedLiveVerify(aged[0], now) === true);

  // A manifest chain the 402 did not offer is never dropped (union), rebuild after rebuild.
  let withManifest = crawlN();
  for (let i = 1; i <= 3; i++) withManifest = carryForwardLearnedQuotes(rebuild({ networks: ["eip155:10"] }), { tools: withManifest });
  check(`a manifest chain and the verified chains are unioned across rebuilds (got ${JSON.stringify(withManifest[0].networks)})`,
    withManifest[0].networks.length === 4 && withManifest[0].networks.includes("eip155:10") && NETS.every((n) => withManifest[0].networks.includes(n)));

  // A verified read never becomes a learned PRICE: if the origin stops
  // declaring one, the row is unpriced (a probe candidate), not carried.
  let settled = crawlN();
  settled = carryForwardLearnedQuotes(rebuild(), { tools: settled });
  const undeclared = carryForwardLearnedQuotes([{ method: "GET", route: ROUTE, slug: "preflight" }], { tools: settled })[0];
  check(`an origin that stops declaring its price leaves the row unpriced, chains kept (price ${undeclared.price}, source ${undeclared.quoteSource})`,
    !(Number(undeclared.price) > 0) && undeclared.quoteSource !== "live-402" && undeclared.networks?.length === 3);

  // A verified read is evidence about its own verb: a declared sibling on the
  // path that was never read gets no chains and no stamp from it. (On the
  // first rebuild the sibling may take the learned QUOTE's chains through the
  // route fallback, as before - but never the stamp, which would hide it from
  // its own weekly read.)
  const firstPair = carryForwardLearnedQuotes([...rebuild(), { method: "POST", route: ROUTE, slug: "preflight-post", price: 0.01, originDeclaredPrice: 0.01 }], { tools: crawlN() });
  const firstPost = firstPair.find((r) => r.method === "POST");
  check(`first rebuild: a declared sibling is not stamped verified by the learned quote's read (got ${firstPost?.networksVerifiedAt})`,
    firstPost && !(Number(firstPost.networksVerifiedAt) > 0) && networksNeedLiveVerify(firstPost, now) === !!firstPost.networks?.length);
  let pair = crawlN();
  pair = carryForwardLearnedQuotes(rebuild(), { tools: pair });
  pair = carryForwardLearnedQuotes([...rebuild(), { method: "POST", route: ROUTE, slug: "preflight-post", price: 0.01, originDeclaredPrice: 0.01 }], { tools: pair });
  const post = pair.find((r) => r.method === "POST");
  check(`a declared sibling verb is not stamped verified by another verb's read (got ${JSON.stringify({ n: post?.networks, v: post?.networksVerifiedAt })})`,
    post && !(Number(post.networksVerifiedAt) > 0) && !(post.networks?.length));

  // A recorded verb CORRECTION on an origin-priced row survives too: the
  // document keeps stating GET, the route answers only POST.
  let corrected = crawlN({ method: "POST", methodCorrectedFrom: "GET", networksVerifiedMethod: "POST" });
  for (let i = 1; i <= 3; i++) corrected = carryForwardLearnedQuotes(rebuild(), { tools: corrected });
  check(`a verb correction on an origin-priced row survives three rebuilds (got ${corrected[0].method}, ${JSON.stringify(corrected[0].networks)})`,
    corrected[0].method === "POST" && corrected[0].methodCorrectedFrom === "GET" && corrected[0].networksVerifiedAt === readAt && corrected[0].networks?.length === 3);
  // The live proof belongs to the verb that answered, so it travels with the
  // correction like the stamp. The rebuilt row states the wrong verb and never
  // matches the remembered row exactly, so an exact-only carry lost it on the
  // first rebuild.
  check(`the live proof time survives three rebuilds of a corrected row (got ${corrected[0].liveProvenAt})`, corrected[0].liveProvenAt === readAt);
  // A correction also takes the verified UNION when the rebuilt row names
  // chains of its own: the gate is "the read's own row", not "an exact hit".
  let correctedManifest = crawlN({ method: "POST", methodCorrectedFrom: "GET", networksVerifiedMethod: "POST" });
  for (let i = 1; i <= 3; i++) correctedManifest = carryForwardLearnedQuotes(rebuild({ networks: ["eip155:10"] }), { tools: correctedManifest });
  const cm = correctedManifest[0];
  check(`a corrected row with a manifest chain keeps the union, stamp and payTo across rebuilds (got ${JSON.stringify({ m: cm.method, n: cm.networks, v: cm.networksVerifiedAt === readAt, p: cm.payToByNetwork })})`,
    cm.method === "POST" && cm.networks?.length === 4 && cm.networks.includes("eip155:10") && NETS.every((n) => cm.networks.includes(n))
      && cm.networksVerifiedAt === readAt && cm.payToByNetwork?.["eip155:8453"] === PAYTO);

  // A declared sibling verb that names chains OF ITS OWN in the seller's
  // document was never read. It must not take the other verb's chains, stamp,
  // payTo or domain through the route fallback: the stamp would hide it from
  // its own weekly read, and once verified reads are carried it would keep all
  // of it rebuild after rebuild as its own "verified read", listing the other
  // verb's Base wallet as the sibling's (the router's row-level payTo).
  {
    const DOMAIN = { "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" } };
    const sibling = () => ({ method: "POST", route: ROUTE, slug: "preflight-post", price: 0.01, originDeclaredPrice: 0.01, networks: ["eip155:10"] });
    let rows = crawlN({ evmDomainByNetwork: DOMAIN });
    for (let i = 1; i <= 3; i++) {
      rows = carryForwardLearnedQuotes([...rebuild(), sibling()], { tools: rows });
      const p = rows.find((r) => r.method === "POST");
      const g = rows.find((r) => r.method === "GET");
      check(`rebuild ${i}: a sibling with its own chains keeps only them (got ${JSON.stringify(p?.networks)})`,
        p?.networks?.length === 1 && p.networks[0] === "eip155:10");
      check(`rebuild ${i}: that sibling is not stamped verified and still asks for its own read (got ${p?.networksVerifiedAt})`,
        p && !(Number(p.networksVerifiedAt) > 0) && networksNeedLiveVerify(p, now) === true);
      check(`rebuild ${i}: that sibling takes no payTo and no domain from the other verb's read (got ${JSON.stringify({ p: p?.payToByNetwork, d: p?.evmDomainByNetwork })})`,
        p && !p.payToByNetwork && !p.evmDomainByNetwork);
      check(`rebuild ${i}: the verb that was read keeps its chains, stamp, payTo and domain`,
        g?.networks?.length === 3 && g.networksVerifiedAt === readAt && g.payToByNetwork?.["eip155:8453"] === PAYTO && g.evmDomainByNetwork?.["eip155:8453"]?.name === "USD Coin");
    }
    // Contrast: a declared sibling with NO chains of its own still takes a
    // learned quote's chains through the route-level price-and-networks
    // fallback (pinned above for the price), and the payTo and domain that
    // describe those chains ride with them, so the row is never left naming a
    // chain with no wallet. Never the stamp: it was not read.
    const bare = carryForwardLearnedQuotes([...rebuild(), { ...sibling(), networks: undefined }], { tools: crawlN({ evmDomainByNetwork: DOMAIN }) })
      .find((r) => r.method === "POST");
    check(`a chainless sibling takes the learned chains with their payTo and domain, unstamped (got ${JSON.stringify({ n: bare?.networks, p: bare?.payToByNetwork, v: bare?.networksVerifiedAt })})`,
      bare?.networks?.length === 3 && bare.payToByNetwork?.["eip155:8453"] === PAYTO
        && bare.evmDomainByNetwork?.["eip155:8453"]?.name === "USD Coin" && !(Number(bare.networksVerifiedAt) > 0));
  }

  // The ORDER rules the carry keeps when several remembered rows share a key.
  // The index can hold two rows for one verb and path (a registry row and a
  // document row), and a third declared verb on a path reads the route map.
  {
    // Exact key: a learned quote is never displaced by a verified read,
    // whichever came first; between learned quotes the last one stands.
    const R = "/api/v1/order";
    const learned = { method: "GET", route: R, price: 0.02, quoteSource: "live-402", quoteObservedAt: readAt, networks: ["eip155:8453"], networksVerifiedAt: readAt, networksVerifiedMethod: "GET" };
    const verified = { method: "GET", route: R, price: 0.01, originDeclaredPrice: 0.01, networks: ["eip155:137"], networksVerifiedAt: readAt, networksVerifiedMethod: "GET" };
    for (const [label, remembered] of [["learned first", [learned, verified]], ["verified first", [verified, learned]]]) {
      const r = carryForwardLearnedQuotes([{ method: "GET", route: R, slug: "order" }], { tools: remembered })[0];
      check(`exact key, ${label}: the learned quote is carried, never a verified read (got ${JSON.stringify({ p: r.price, s: r.quoteSource, n: r.networks })})`,
        r.price === 0.02 && r.quoteSource === "live-402" && r.networks?.length === 1 && r.networks[0] === "eip155:8453");
    }
    const later = { ...learned, price: 0.03 };
    const lastLearned = carryForwardLearnedQuotes([{ method: "GET", route: R, slug: "order" }], { tools: [learned, later] })[0];
    check(`exact key: between two learned quotes the later one stands (got ${lastLearned.price})`, lastLearned.price === 0.03);

    // Route map: the FIRST learned quote holds the route; a learned quote
    // replaces a verified read held there, and a verified read never displaces
    // a learned quote. Observed through a declared PUT on the path, which has
    // no remembered row of its own and takes the route's learned price and
    // chains (the price-and-networks fallback).
    const B = "/api/v1/basket";
    const getQ = { method: "GET", route: B, price: 0.02, quoteSource: "live-402", networks: ["eip155:8453"] };
    const postQ = { method: "POST", route: B, price: 0.03, quoteSource: "live-402", networks: ["eip155:137"] };
    const getV = { method: "GET", route: B, price: 0.01, originDeclaredPrice: 0.01, networks: ["eip155:10"], networksVerifiedAt: readAt, networksVerifiedMethod: "GET" };
    const put = () => [{ method: "PUT", route: B, slug: "basket-put" }];
    const first = carryForwardLearnedQuotes(put(), { tools: [getQ, postQ] })[0];
    check(`route map: the first learned quote holds the route (got ${first.price}, ${JSON.stringify(first.networks)})`,
      first.price === 0.02 && first.networks?.[0] === "eip155:8453" && first.method === "PUT");
    for (const [label, remembered] of [["verified first", [getV, postQ]], ["learned first", [postQ, getV]]]) {
      const r = carryForwardLearnedQuotes(put(), { tools: remembered })[0];
      check(`route map, ${label}: the learned quote holds the route over a verified read (got ${r.price}, ${JSON.stringify(r.networks)})`,
        r.price === 0.03 && r.networks?.length === 1 && r.networks[0] === "eip155:137");
    }

    // A stamp with NO chains is not a verified read: it verified nothing that
    // can ride forward, so it carries no payTo and no proof time.
    const L = "/api/v1/ledger";
    const stampedChainless = { method: "GET", route: L, price: 0.01, originDeclaredPrice: 0.01, networks: [], networksVerifiedAt: readAt, networksVerifiedMethod: "GET", liveProvenAt: readAt, payToByNetwork: { "eip155:8453": PAYTO } };
    const r = carryForwardLearnedQuotes([{ method: "GET", route: L, slug: "ledger", price: 0.01, originDeclaredPrice: 0.01 }], { tools: [stampedChainless] })[0];
    check(`a stamp without chains carries nothing forward (got ${JSON.stringify({ p: r.payToByNetwork, l: r.liveProvenAt, v: r.networksVerifiedAt })})`,
      !r.payToByNetwork && !(Number(r.liveProvenAt) > 0) && !(Number(r.networksVerifiedAt) > 0));
  }

  // A stamp is evidence about the verb that EARNED it: the probe records that
  // verb (networksVerifiedMethod), and only a stamp naming the row's own verb
  // is carried as a verified read. Rows written before the verb was recorded
  // are still in the persisted cache, and some of them are exactly the
  // contamination this carry used to write: a declared, origin-priced GET with
  // a chain of its own, stamped with its POST sibling's read, holding the
  // POST's chains and Base payTo under its own key. Carried as its own verified
  // read it would keep them for good. It must come out clean on the first
  // rebuild and ask for a read of its own.
  {
    const BASE = "eip155:8453", OP = "eip155:10";
    const POST_PAYTO = "0x1111111111111111111111111111111111111111";
    const DOMAIN = { [BASE]: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" } };
    const C = "/api/v1/contaminated";
    const legacyPost = () => ({ method: "POST", route: C, price: 0.02, quoteSource: "live-402", quoteObservedAt: readAt,
      networks: [BASE], networksVerifiedAt: readAt, payToByNetwork: { [BASE]: POST_PAYTO }, evmDomainByNetwork: DOMAIN });
    const contaminatedGet = () => ({ method: "GET", route: C, price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi",
      networks: [OP, BASE], networksVerifiedAt: readAt, payToByNetwork: { [BASE]: POST_PAYTO }, evmDomainByNetwork: DOMAIN });
    const rebuildPair = () => [
      { method: "POST", route: C, slug: "c-post", quoteSource: "openapi" },
      { method: "GET", route: C, slug: "c-get", price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi", networks: [OP] },
    ];
    let rows = [legacyPost(), contaminatedGet()];
    for (let i = 1; i <= 3; i++) {
      rows = carryForwardLearnedQuotes(rebuildPair(), { tools: rows });
      const g = rows.find((x) => x.method === "GET");
      check(`legacy contamination, rebuild ${i}: the GET lists only its own chain, with no stamp, payTo or domain from the POST (got ${JSON.stringify({ n: g?.networks, v: g?.networksVerifiedAt, p: g?.payToByNetwork, d: g?.evmDomainByNetwork })})`,
        g?.networks?.length === 1 && g.networks[0] === OP && !(Number(g.networksVerifiedAt) > 0) && !g.payToByNetwork && !g.evmDomainByNetwork);
      check(`legacy contamination, rebuild ${i}: the GET asks for a read of its own`, networksNeedLiveVerify(g, now) === true);
    }
    // Nor is it carried to a rebuilt row with no chains of its own: a stamp
    // that names no verb is no verified read at all, so it lends the row no
    // chains, payTo or live proof by any rule. The row is then unchained, which
    // makes it a probe candidate by the older rule, and its own read restores
    // all of it. The same row stamped with its own verb carries everything.
    const legacyRead = { method: "GET", route: C, price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi",
      networks: [BASE], networksVerifiedAt: readAt, liveProvenAt: readAt, payToByNetwork: { [BASE]: PAYTO } };
    const chainless = () => [{ method: "GET", route: C, slug: "c-get", price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi" }];
    const unread = carryForwardLearnedQuotes(chainless(), { tools: [legacyRead] })[0];
    check(`a stamp naming no verb lends a chainless row nothing (got ${JSON.stringify({ n: unread.networks, p: unread.payToByNetwork, l: unread.liveProvenAt, v: unread.networksVerifiedAt })})`,
      !(unread.networks?.length) && !unread.payToByNetwork && !(Number(unread.liveProvenAt) > 0) && !(Number(unread.networksVerifiedAt) > 0));
    const reread = carryForwardLearnedQuotes(chainless(), { tools: [{ ...legacyRead, networksVerifiedMethod: "GET" }] })[0];
    check(`control: the same read stamped with its own verb carries its chains, payTo, proof and stamp (got ${JSON.stringify({ n: reread.networks, v: reread.networksVerifiedMethod })})`,
      reread.networks?.length === 1 && reread.payToByNetwork?.[BASE] === PAYTO && reread.liveProvenAt === readAt
        && reread.networksVerifiedAt === readAt && reread.networksVerifiedMethod === "GET");
    // The same row with its stamp naming ANOTHER verb is no verified read either.
    const foreign = carryForwardLearnedQuotes([rebuildPair()[1]], { tools: [{ ...contaminatedGet(), networksVerifiedMethod: "POST" }] })[0];
    check(`a stamp naming another verb is not carried (got ${JSON.stringify({ n: foreign.networks, p: foreign.payToByNetwork })})`,
      foreign.networks?.length === 1 && !(Number(foreign.networksVerifiedAt) > 0) && !foreign.payToByNetwork);
    check("networksNeedLiveVerify: a fresh stamp that names no verb, or another verb, asks for a read; its own verb defers it",
      networksNeedLiveVerify({ ...contaminatedGet(), networks: [OP] }, now) === true
        && networksNeedLiveVerify({ ...contaminatedGet(), networks: [OP], networksVerifiedMethod: "POST" }, now) === true
        && networksNeedLiveVerify({ ...contaminatedGet(), networks: [OP], networksVerifiedMethod: "GET" }, now) === false);

    // A LEARNED QUOTE's stamp is gated the same way: an exact key does not
    // prove the stamp is this verb's, since the old carry filed a sibling's read
    // under this row's key and relabelled it live-402. On a row with chains of
    // its own, a quote whose stamp names no verb keeps its price but not the
    // read's chains, payTo or domain, and is carried without its age, so it is
    // due for the one read that restores them. The same quote stamped with its
    // own verb carries all of it and keeps its age.
    const Q = "/api/v1/quoted";
    const quoted = (over = {}) => ({ method: "GET", route: Q, price: 0.02, quoteSource: "live-402", quoteObservedAt: readAt,
      networks: [BASE, OP], networksVerifiedAt: readAt, payToByNetwork: { [BASE]: PAYTO }, evmDomainByNetwork: DOMAIN, ...over });
    const fresh = () => [{ method: "GET", route: Q, slug: "quoted", quoteSource: "openapi", networks: [BASE] }];
    const legacyQ = carryForwardLearnedQuotes(fresh(), { tools: [quoted()] })[0];
    check(`a legacy learned quote keeps its price and is due for a read (got ${JSON.stringify({ p: legacyQ.price, s: legacyQ.quoteSource, o: legacyQ.quoteObservedAt, stale: quoteIsStale(legacyQ, now) })})`,
      legacyQ.price === 0.02 && legacyQ.quoteSource === "live-402" && !legacyQ.quoteObservedAt && quoteIsStale(legacyQ, now) === true);
    check(`...and holds only its own document's chain, no stamp, payTo or domain (got ${JSON.stringify({ n: legacyQ.networks, v: legacyQ.networksVerifiedAt, p: legacyQ.payToByNetwork })})`,
      legacyQ.networks.length === 1 && legacyQ.networks[0] === BASE && !(Number(legacyQ.networksVerifiedAt) > 0) && !legacyQ.payToByNetwork && !legacyQ.evmDomainByNetwork);
    const ownQ = carryForwardLearnedQuotes(fresh(), { tools: [quoted({ networksVerifiedMethod: "GET" })] })[0];
    check(`the same quote stamped with its own verb carries its read and its age (got ${JSON.stringify({ n: ownQ.networks, v: ownQ.networksVerifiedMethod, o: ownQ.quoteObservedAt === readAt })})`,
      ownQ.networks.length === 2 && ownQ.networksVerifiedAt === readAt && ownQ.networksVerifiedMethod === "GET"
        && ownQ.payToByNetwork?.[BASE] === PAYTO && ownQ.evmDomainByNetwork?.[BASE]?.name === "USD Coin" && ownQ.quoteObservedAt === readAt && quoteIsStale(ownQ, now) === false);
    // A row with NO chains of its own still takes a legacy quote's chains and
    // payTo by the older price-and-networks rule, with its age: nothing was
    // withheld from it but the stamp.
    const bareQ = carryForwardLearnedQuotes([{ method: "GET", route: Q, slug: "quoted", quoteSource: "openapi" }], { tools: [quoted()] })[0];
    check(`a chainless row takes a legacy quote's chains, payTo and age, never its stamp (got ${JSON.stringify({ n: bareQ.networks, p: bareQ.payToByNetwork, v: bareQ.networksVerifiedAt })})`,
      bareQ.networks.length === 2 && bareQ.payToByNetwork?.[BASE] === PAYTO && bareQ.quoteObservedAt === readAt && !(Number(bareQ.networksVerifiedAt) > 0));
    // The verb rides with the stamp, so the carried row is still its own read
    // on the next rebuild (and a corrected row's stamp names the corrected verb).
    let own = carryForwardLearnedQuotes(rebuild(), { tools: crawlN() });
    own = carryForwardLearnedQuotes(rebuild(), { tools: own });
    const corr = carryForwardLearnedQuotes(rebuild(), { tools: crawlN({ method: "POST", methodCorrectedFrom: "GET", networksVerifiedMethod: "POST" }) })[0];
    check(`the verb travels with the stamp (got ${own[0].networksVerifiedMethod}, corrected ${corr.networksVerifiedMethod}/${corr.method})`,
      own[0].networksVerifiedMethod === "GET" && own[0].networksVerifiedAt === readAt && corr.networksVerifiedMethod === "POST" && corr.method === "POST");
  }
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

  // A `price` that is an OBJECT is a legitimate, richer manifest shape: the
  // seller carries scheme/network/asset/payTo per resource with the figure
  // inside. Reading scalars only, we normalised such a manifest to price null,
  // which costs a live-402 probe to learn what the origin already stated and,
  // worse, leaves `originDeclaredPrice` unstamped - the anchor this whole block
  // exists to protect. Found reviewing a seed PR (2026-09-13) whose manifest
  // used `price: { amountUsd: "0.01", ... }`.
  const objShape = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/score", method: "POST",
      price: { scheme: "exact", network: "eip155:8453", amountUsd: "0.01", amountLabel: "$0.01 USDC",
               payTo: "0x0000000000000000000000000000000000000001" } }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/score"));
  check(`an object-shaped manifest price is read (got ${objShape?.price})`, String(objShape?.price).includes("0.01"));
  check(`...and is marked origin-declared, so the drift guard keeps its anchor (got ${objShape?.originDeclaredPrice})`,
    objShape?.originDeclaredPrice === 0.01);
  const objNoFigure = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/nofig", method: "POST", price: { scheme: "exact", network: "eip155:8453" } }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/nofig"));
  check(`a price object carrying no figure still declares nothing`, !(Number(objNoFigure?.originDeclaredPrice) > 0));
  // An ARRAY is not the object shape: descending into it reads index keys that
  // mean nothing, so it must declare nothing rather than invent a figure.
  const objArray = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/arr", method: "POST", price: [{ amountUsd: "0.01" }] }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/arr"));
  check(`an array-shaped price declares nothing (got ${objArray?.price})`,
    !(Number(objArray?.originDeclaredPrice) > 0) && !String(objArray?.price || "").includes("0.01"));
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
    quoteProbeCapFor([...Array.from({ length: 90 }, (_, i) => ({ route: `/p${i}`, price: 0.001 })), ...Array.from({ length: 10 }, (_, i) => ({ route: `/u${i}`, price: null }))]) === 15);
  check("an empty list never returns a smaller cap than the steady state", quoteProbeCapFor([]) >= 15);
}

// ── One reader for every payment annotation dialect (2026-09-18) ────────────
// One prod crawl cycle logged unrecognized payment-ish keys from ~250 origins,
// whose operations were indexed as FREE because the reader knew four keys.
// Each fixture below is the shape read off a live document that day (addresses
// replaced). Mutation check: remove one dialect from openapiOperationPayment
// and its fixture reads free (paid false / price null) here.
{
  const { normaliseOpenapiTools, openapiOperationPayment, unknownPaymentishKeys } = await import("../src/x402-index.js");
  const PAYTO = "0x1111111111111111111111111111111111111111";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const doc = {
    openapi: "3.1.0",
    paths: {
      // dialect A: x-price-usd + x-payment with amountUsd AND amountAtomic
      "/usd": { post: { operationId: "usd", "x-x402-price-usd": 0.001, "x-price-usd": 0.001, "x-payment": { protocol: "x402", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountUsd: 0.001, amountAtomic: "1000" } } },
      // dialect B: "$0.003" string + x-payment with no amount at all
      "/usd-str": { post: { operationId: "usd-str", "x-price-usd": "$0.003", "x-payment": { protocol: "x402", network: "eip155:8453", asset: "USDC", payTo: PAYTO } } },
      // dialect C: x-x402 accepts-shaped with amountAtomic only
      "/x402-atomic": { post: { operationId: "x402-atomic", "x-x402": { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountAtomic: "1000" } } },
      // dialect D: x-x402 with a display price and network_default
      "/x402-price": { post: { operationId: "x402-price", "x-x402": { price: "$0.01", scheme: "exact", network_default: "eip155:8453" } } },
      // dialect E: x-payment v2 accepts with the ATOMIC `amount` (1,000,000 = $1)
      "/pay-amount": { post: { operationId: "pay-amount", "x-payment": { x402Version: 2, scheme: "exact", network: "eip155:8453", amount: "1000000", asset: USDC_BASE, payTo: PAYTO, maxTimeoutSeconds: 300 } } },
      // dialect F: x-402 with price + priceMicros
      "/x402-micros": { post: { operationId: "x402-micros", "x-402": { price: "$0.05", priceMicros: 50000, network: "eip155:8453", payTo: PAYTO, asset: "USDC" } } },
      // dialect G: x-402 with price_usdc and a shorthand network
      "/x402-usdc": { post: { operationId: "x402-usdc", "x-402": { price_usdc: 0.003, network: "base", asset: "USDC" } } },
      // dialect H: x-402 priceUsd
      "/x402-priceusd": { post: { operationId: "x402-priceusd", "x-402": { priceUsd: 0.005, network: "eip155:8453", asset: "USDC" } } },
      // dialect I: x-price-usdc scalar
      "/price-usdc": { post: { operationId: "price-usdc", "x-price-usdc": 0.001 } },
      // dialect J: x-x402-price-atomic + x-x402-network beside x-payment-info
      "/atomic": { post: { operationId: "atomic", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.003" } }, "x-x402-price-atomic": "3000", "x-x402-network": "eip155:8453" } },
      // dialect K: x-payment-required true + x-payment-info with a STRING price
      "/required": { get: { operationId: "required", "x-payment-required": true, "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "$0.01" } } },
      // x-payment-required true alone: paid, price unknown (the live 402 learns it)
      "/required-bare": { get: { operationId: "required-bare", "x-payment-required": true } },
      // dialect J, router form: x-payment-required false + a non-numeric atomic marker: FREE
      "/free": { post: { operationId: "free", "x-payment-required": false, "x-x402-price-atomic": "quoted_from_live_rail" } },
      // no annotation at all in an annotated document: free sibling
      "/plain": { get: { operationId: "plain" } },
    },
  };
  const rows = Object.fromEntries(normaliseOpenapiTools(doc, "https://seller.example").map((t) => [t.slug, t]));
  const priced = (slug, price, why) => check(`${slug}: ${why} -> price ${price} (got ${rows[slug]?.price}, paid ${rows[slug]?.paid})`, rows[slug]?.price === price && rows[slug]?.paid === true);
  priced("usd", "$0.001", "x-price-usd scalar reads as dollars");
  priced("usd-str", "$0.003", "x-price-usd \"$0.003\" string reads as dollars");
  priced("x402-atomic", "$0.001", "x-x402 amountAtomic 1000 reads through the asset's decimals");
  priced("x402-price", "$0.01", "x-x402 display price reads as dollars");
  priced("pay-amount", "$1", "x-payment accepts-shaped amount \"1000000\" is ATOMIC, one dollar, never a million");
  priced("x402-micros", "$0.05", "x-402 price wins over priceMicros and they agree");
  priced("x402-usdc", "$0.003", "x-402 price_usdc reads as dollars");
  priced("x402-priceusd", "$0.005", "x-402 priceUsd reads as dollars");
  priced("price-usdc", "$0.001", "x-price-usdc scalar reads as dollars");
  priced("atomic", "$0.003", "x-payment-info amount + x-x402-price-atomic agree at $0.003");
  priced("required", "$0.01", "x-payment-info with a STRING price beside x-payment-required true");
  check(`required-bare: x-payment-required true alone is PAID with the price unknown (got paid ${rows["required-bare"]?.paid}, price ${rows["required-bare"]?.price})`, rows["required-bare"]?.paid === true && rows["required-bare"]?.price == null);
  check(`free: x-payment-required false with no price is FREE (got paid ${rows.free?.paid}, price ${rows.free?.price})`, rows.free?.paid === false && rows.free?.price == null);
  check(`plain: an unannotated sibling in an annotated document is free (got paid ${rows.plain?.paid})`, rows.plain?.paid === false);
  // A declared ZERO is "free", never a paid "$0" row that wins the cheapest-price
  // tiebreak on every equal-score /api/route query; negative and exponent
  // figures are not prices at all (a "$-0.001" display price the money path
  // cannot read). x-payment-required true beside a zero wins as paid/unknown.
  const zero = (op, why, exp) => { const r = openapiOperationPayment(op); check(`${why} (got paid ${r.paid}, price ${r.price})`, r.paid === exp.paid && r.price === exp.price); };
  zero({ "x-price-usd": 0 }, "x-price-usd 0 is FREE, not a $0 paid row", { paid: false, price: null });
  zero({ "x-402": { priceMicros: 0, network: "eip155:8453" } }, "x-402 priceMicros 0 is FREE", { paid: false, price: null });
  zero({ "x-payment": { x402Version: 2, scheme: "exact", network: "eip155:8453", amount: "0", asset: USDC_BASE, payTo: PAYTO } }, "accepts-shaped amount 0 is FREE", { paid: false, price: null });
  zero({ "x-price-usd": 0, "x-payment-required": true }, "zero beside x-payment-required true is PAID with the price unknown", { paid: true, price: null });
  zero({ "x-x402": { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountAtomic: "-1000" } }, "a negative atomic amount is not a price (terms declared, so still paid)", { paid: true, price: null });
  zero({ "x-x402": { scheme: "exact", network: "eip155:8453", asset: "USDC", amountAtomic: "1e6" } }, "an exponent atomic amount is not a price", { paid: true, price: null });
  zero({ "x-price-usd": -0.5 }, "a negative dollar figure is not a price (terms declared, so still paid)", { paid: true, price: null });
  // Chains and payTo ride out of the object dialects, so these rows chain-match.
  check(`usd: network + payTo from x-payment (got ${JSON.stringify(rows.usd?.networks)} ${JSON.stringify(rows.usd?.payToByNetwork)})`, rows.usd?.networks?.[0] === "eip155:8453" && rows.usd?.payToByNetwork?.["eip155:8453"] === PAYTO);
  check(`x402-usdc: shorthand network "base" normalises to eip155:8453 (got ${JSON.stringify(rows["x402-usdc"]?.networks)})`, rows["x402-usdc"]?.networks?.[0] === "eip155:8453");
  check(`atomic: x-x402-network rides out as the row's network (got ${JSON.stringify(rows.atomic?.networks)})`, rows.atomic?.networks?.[0] === "eip155:8453");
  check(`x402-price: network_default rides out (got ${JSON.stringify(rows["x402-price"]?.networks)})`, rows["x402-price"]?.networks?.[0] === "eip155:8453");
  // An atomic figure read as dollars would be the 2026-09-15 class of overquote.
  const atomicOnly = openapiOperationPayment({ "x-payment": { x402Version: 2, network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount: "2500" } });
  check(`accepts-shaped amount "2500" is $0.0025, not $2500 (got ${atomicOnly.price})`, atomicOnly.price === "$0.0025");
  // The dialect watch: every key above is recognized (no log line), a novel one still surfaces.
  check(`no recognized dialect is reported as unknown (got ${JSON.stringify(unknownPaymentishKeys(doc))})`, unknownPaymentishKeys(doc).length === 0);
  const novel = unknownPaymentishKeys({ paths: { "/n": { get: { "x-fee-usd": 0.1 } } } });
  check(`a novel payment-ish key still announces itself (got ${JSON.stringify(novel)})`, novel.length === 1 && novel[0] === "x-fee-usd");
  // A document annotated only with x-payment-required:false is not a paid service.
  check("x-payment-required:false alone never reads as a paid signal", openapiOperationPayment({ "x-payment-required": false }).paid === false);
}


// --- the origin-declaration anchor (2026-09-21) ------------------------------
// CN Evidence reported a $0.032 route listed at $0.002 across two
// re-registrations. The correction that should have caught it re-probes a
// route whose learned price disagrees with the origin's declaration - and the
// anchor it needs, originDeclaredPrice, was never stamped for them, so there
// was nothing to disagree with. Measured across 41 indexed sellers carrying
// priced rows, 38 had no anchor at all: the fix shipped in August and again in
// September was inert for about 93% of them.
{
  const { normaliseOpenapiTools } = await import("../src/x402-index.js");
  const openapi = {
    openapi: "3.0.0",
    paths: {
      "/paid": { get: { summary: "Paid thing", "x-price": "$0.032" } },
      "/free": { get: { summary: "Free thing" } },
    },
  };
  const rows = normaliseOpenapiTools(openapi, "https://seller.example");
  const paid = rows.find((r) => r.route === "/paid");
  check(`an x-price in the origin's OWN OpenAPI stamps the anchor (got ${paid?.originDeclaredPrice})`, Number(paid?.originDeclaredPrice) === 0.032);
  const free = rows.find((r) => r.route === "/free");
  check("an operation that declares no price declares no anchor either", free && free.originDeclaredPrice === undefined);

  // The stamp must survive a display string. A bare Number("$0.032") is NaN,
  // which skipped the stamp silently on the manifest path once already.
  const dollars = normaliseOpenapiTools({ openapi: "3.0.0", paths: { "/d": { get: { "x-price": "$1.25" } } } }, "https://seller.example");
  check(`a display-string price still stamps (got ${dollars[0]?.originDeclaredPrice})`, Number(dollars[0]?.originDeclaredPrice) === 1.25);
}

// --- a priced catalogue beside an unpriced canonical array --------------------
{
  const { normaliseManifestTools } = await import("../src/x402-index.js");
  // CN Evidence's real shape: `resources` is bare URL strings carrying no
  // price, and the priced rows live one key over in `resourceCatalog`.
  const manifest = {
    resources: ["https://seller.example/x402/basic", "https://seller.example/x402/full"],
    resourceCatalog: [
      { id: "basic", method: "GET", url: "https://seller.example/x402/basic", price: { amount: "0.032", currency: "USDC" } },
      { id: "full", method: "POST", url: "https://seller.example/x402/full", price: { amount: "0.093", currency: "USDC" } },
    ],
  };
  const rows = normaliseManifestTools(manifest, "https://seller.example");
  check(`the bare URL and its priced catalogue entry merge into ONE row per route (got ${rows.length})`, rows.length === 2);
  const basic = rows.find((r) => r.route === "/x402/basic");
  const full = rows.find((r) => r.route === "/x402/full");
  check(`the price is read from the catalogue (got ${basic?.price})`, Number(String(basic?.price).replace(/[^0-9.]/g, "")) === 0.032);
  check("and it anchors, so a stale learned quote can be corrected", Number(basic?.originDeclaredPrice) === 0.032);
  check(`the declared method wins over the verb inferred from a bare URL (got ${full?.method})`, full?.method === "POST");
}

// --- an inferred verb must not publish a seller's route twice -----------------
{
  const { normaliseManifestTools } = await import("../src/x402-index.js");
  // Measured on api.aurelianflo.com: 8 bare `resources` URLs inferred as GET
  // alongside the SAME 8 routes declared POST in `endpoints`, so every endpoint
  // was listed twice and half the buyers were sent to a verb the seller answers
  // 405 to. jmt-x402-proxy carried 20 of these.
  const dup = {
    resources: ["https://seller.example/api/thing"],
    endpoints: [{ path: "/api/thing", method: "POST", name: "Thing" }],
  };
  const rows = normaliseManifestTools(dup, "https://seller.example");
  check(`an inferred-GET row is dropped when a declared sibling exists for that route (got ${rows.length})`, rows.length === 1);
  check("the surviving row carries the method the seller declared", rows[0].method === "POST");

  // A seller who genuinely serves both declares both, and neither is inferred.
  const both = {
    endpoints: [
      { path: "/api/thing", method: "GET", name: "Read" },
      { path: "/api/thing", method: "POST", name: "Write" },
    ],
  };
  const kept = normaliseManifestTools(both, "https://seller.example");
  check(`two DECLARED verbs on one route both survive (got ${kept.length})`, kept.length === 2);

  // An inferred row with no declared sibling is real listing data and stays.
  const lone = { resources: ["https://seller.example/api/only"] };
  check("an inferred row with no declared sibling is kept - the rule removes duplicates, not discoveries", normaliseManifestTools(lone, "https://seller.example").length === 1);
}

// --- the payTo a live 402 names is RECORDED (2026-09-22) ---------------------
// A seller whose manifest publishes `resources` as bare URL STRINGS and its
// wallet once, in a top-level payment block, was listed with an EMPTY
// payToByNetwork: the live-402 probe read the price, the chains and the EIP-712
// domain off the challenge and threw the payTo away, the carry-forward carried
// everything but that, and the manifest reader only ever looked for a payTo on
// a RESOURCE. allPayToOrigins builds the Base scan's wallet list from that one
// field, so the wallet was never scanned, no settlement could be credited to
// the origin, and such a seller could not clear the settlement floor however
// many outside buyers paid it. Fixtures are the live shapes on a neutral origin.
{
  process.env.X402_INDEX_CRAWL = "off";
  process.env.X402_SYNC_ON_START = "false";
  const { quoteFromAccepts } = await import("../src/x402-live-quote.js");
  const {
    enrichLiveQuotes, carryForwardLearnedQuotes, normaliseManifestTools, networksNeedLiveVerify,
    allPayToOrigins, sellerDetail, indexSnapshot, __testSeedCache, __testResetSubmitted,
    markRouteGone, goneMark, quoteIsStale,
  } = await import("../src/x402-index.js");

  const PAYTO = "0x3333333333333333333333333333333333333333";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_PAYTO = "22222222222222222222222222222222222222222222";
  const accept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount: "32000", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });

  // 1. the reader keeps every accept's payTo, keyed by its network
  {
    const q = quoteFromAccepts([accept(), { network: SOL_NET, payTo: SOL_PAYTO, amount: "32000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]);
    check(`a live 402's payTo rides out per network (got ${JSON.stringify(q?.payToByNetwork)})`,
      q?.payToByNetwork?.["eip155:8453"] === PAYTO && q.payToByNetwork[SOL_NET] === SOL_PAYTO);
    const twice = quoteFromAccepts([accept({ payTo: "0x0000000000000000000000000000000000000001", extra: { name: "WEIRD" } }), accept()]);
    check("one network offered twice keeps the PREFERRED accept's payee, not the first row",
      twice?.payToByNetwork?.["eip155:8453"] === PAYTO);
  }

  // 2. the probe writes it onto the row, and a v1-style network label is
  //    normalised first - allPayToOrigins reads the eip155 key, so a payTo
  //    filed under "base" is a payTo the Base scan never sees.
  const ORIGIN = "https://example.com"; // resolves: assertPublicUrl runs before the (stubbed) fetch
  const header = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  const stub = (rules) => async (url, init = {}) => {
    const u = new URL(String(url));
    const hit = rules[`${String(init.method || "GET").toUpperCase()} ${u.pathname}`];
    if (!hit) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 402, headers: { "payment-required": header(hit), "content-type": "application/json" } });
  };
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = stub({ "GET /x402/basic": [accept()] });
    const rows = [{ seller: ORIGIN, route: "/x402/basic", method: "GET", slug: "basic", price: null, networks: [] }];
    await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
    check(`the probed row carries the payTo its own 402 named (got ${JSON.stringify(rows[0].payToByNetwork)})`,
      rows[0].payToByNetwork?.["eip155:8453"] === PAYTO);

    globalThis.fetch = stub({ "GET /x402/v1": [accept({ network: "base" })] });
    const v1 = [{ seller: ORIGIN, route: "/x402/v1", method: "GET", slug: "v1", price: null, networks: [] }];
    await enrichLiveQuotes(v1, ORIGIN, { ignoreBudget: true });
    check(`a 402 naming "base" files its payTo under eip155:8453 (got ${JSON.stringify(v1[0].payToByNetwork)})`,
      v1[0].payToByNetwork?.["eip155:8453"] === PAYTO);

    // the sibling branch: the stated GET does not answer, the declared POST
    // sibling does, so the payTo belongs on the row that survives. The POST row
    // is origin-priced with a fresh verified read, so the AUTOMATIC crawl does
    // not probe it itself - otherwise its own probe would write the payTo and
    // this case could not observe the sibling write at all. (A re-registration
    // would re-ask it: see the next case.)
    globalThis.fetch = stub({ "POST /x402/full": [accept()] });
    const pair = [
      { seller: ORIGIN, route: "/x402/full", method: "GET", slug: "full-get", price: null, networks: [] },
      { seller: ORIGIN, route: "/x402/full", method: "POST", slug: "full-post", price: 0.032, originDeclaredPrice: 0.032, networks: ["eip155:8453"], networksVerifiedAt: Date.now(), networksVerifiedMethod: "POST" },
    ];
    await enrichLiveQuotes(pair, ORIGIN);
    const survivor = pair.find((r) => r.method === "POST");
    check(`the surviving sibling carries the payTo (got ${JSON.stringify(survivor?.payToByNetwork)}, rows ${pair.length})`,
      pair.length === 1 && survivor?.payToByNetwork?.["eip155:8453"] === PAYTO);

    // A re-registration re-reads a CARRIED verified read on an origin-priced
    // row. Carry-forward keeps such a row's chains, payTo, EIP-712 domain and
    // verification stamp across probe-less rebuilds, so the automatic crawl
    // leaves it alone until the weekly re-verify; the seller's lever for a
    // change inside that week (a wrong USDC domain fixed, a payout wallet
    // moved) is re-registering, which must ask the route's 402 again even
    // though the origin's price needs no re-ask.
    {
      const ROUTE = "/x402/moved";
      const OLD = "0x1111111111111111111111111111111111111111";
      const readAt = Date.now() - 86_400_000;
      let asked = 0;
      const counting = stub({ [`GET ${ROUTE}`]: [accept()] });   // today's 402: PAYTO, "USD Coin"
      globalThis.fetch = async (url, init) => { if (new URL(String(url)).pathname === ROUTE) asked++; return counting(url, init); };
      const crawlN = [{
        seller: ORIGIN, method: "GET", route: ROUTE, slug: "moved", price: 0.032, originDeclaredPrice: 0.032,
        networks: ["eip155:8453"], networksVerifiedAt: readAt, networksVerifiedMethod: "GET", liveProvenAt: readAt, quoteSource: "live-402", quoteObservedAt: readAt,
        payToByNetwork: { "eip155:8453": OLD }, evmDomainByNetwork: { "eip155:8453": { asset: USDC_BASE, name: "USDC" } },
      }];
      const rebuild = () => [{ seller: ORIGIN, method: "GET", route: ROUTE, slug: "moved", price: 0.032, originDeclaredPrice: 0.032, quoteSource: "openapi" }];
      let rows = carryForwardLearnedQuotes(rebuild(), { tools: crawlN });
      rows = carryForwardLearnedQuotes(rebuild(), { tools: rows });
      await enrichLiveQuotes(rows, ORIGIN);
      check(`the automatic crawl leaves a freshly verified carried row to its weekly clock (asked ${asked})`,
        asked === 0 && rows[0].payToByNetwork?.["eip155:8453"] === OLD);
      await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
      const r = rows[0];
      check(`a re-registration re-asks the carried verified row (asked ${asked})`, asked === 1);
      check(`the re-read replaces the carried payTo with the one the 402 names now (got ${JSON.stringify(r.payToByNetwork)})`,
        r.payToByNetwork?.["eip155:8453"] === PAYTO);
      check(`the re-read replaces the carried EIP-712 domain (got ${JSON.stringify(r.evmDomainByNetwork?.["eip155:8453"])})`,
        r.evmDomainByNetwork?.["eip155:8453"]?.name === "USD Coin");
      check(`the re-read restarts the verification clock and the origin's price stands (verifiedAt ${r.networksVerifiedAt > readAt}, price ${r.price})`,
        Number(r.networksVerifiedAt) > readAt && r.price === 0.032);
      const next = carryForwardLearnedQuotes(rebuild(), { tools: carryForwardLearnedQuotes(rebuild(), { tools: rows }) })[0];
      check(`two rebuilds later the NEW payTo and domain are the ones carried (got ${JSON.stringify({ p: next.payToByNetwork, d: next.evmDomainByNetwork?.["eip155:8453"]?.name })})`,
        next.payToByNetwork?.["eip155:8453"] === PAYTO && next.evmDomainByNetwork?.["eip155:8453"]?.name === "USD Coin" && next.price === 0.032);
    }

    // The origin STOPS declaring the price of a route it priced when we read
    // its 402, and the rebuild takes a registry's settlement snapshot for it.
    // Carry-forward keeps the verified read's chains, payTo and stamp; the
    // stamp must not defer the read the row now needs, because no read ever
    // looked at the snapshot's price. (Before verified reads were carried the
    // row had no stamp here and was read on the next crawl.)
    {
      const ROUTE = "/x402/undeclared";
      const readAt = Date.now() - 86_400_000;
      let asked = 0;
      const counting = stub({ [`GET ${ROUTE}`]: [accept()] });   // today's 402: 32000 base units
      globalThis.fetch = async (url, init) => { if (new URL(String(url)).pathname === ROUTE) asked++; return counting(url, init); };
      const prevRows = [{
        seller: ORIGIN, method: "GET", route: ROUTE, slug: "undeclared", price: 0.032, originDeclaredPrice: 0.032, quoteSource: "openapi",
        networks: ["eip155:8453"], networksVerifiedAt: readAt, networksVerifiedMethod: "GET", liveProvenAt: readAt, payToByNetwork: { "eip155:8453": PAYTO },
      }];
      const snapshot = () => [{ seller: ORIGIN, method: "GET", route: ROUTE, slug: "undeclared", price: 0.05, paid: true, networks: ["eip155:8453"] }];
      const rows = carryForwardLearnedQuotes(snapshot(), { tools: prevRows });
      check(`the carried stamp stays beside the snapshot price but asks for a read (stamp ${rows[0].networksVerifiedAt === readAt}, needVerify ${networksNeedLiveVerify(rows[0])})`,
        rows[0].networksVerifiedAt === readAt && rows[0].price === 0.05 && networksNeedLiveVerify(rows[0]) === true);
      await enrichLiveQuotes(rows, ORIGIN);
      check(`the automatic crawl reads it at once (asked ${asked}) and the 402's price replaces the snapshot (got ${rows[0].price}, ${rows[0].quoteSource})`,
        asked === 1 && rows[0].price === 0.032 && rows[0].quoteSource === "live-402" && Number(rows[0].networksVerifiedAt) > readAt);
      // Control: the same carried read beside a price the origin still
      // declares keeps its weekly clock.
      const declared = carryForwardLearnedQuotes([{ ...snapshot()[0], price: 0.032, originDeclaredPrice: 0.032 }], { tools: prevRows });
      await enrichLiveQuotes(declared, ORIGIN);
      check(`control: beside the origin's own price the stamp defers the read (asked ${asked})`, asked === 1 && networksNeedLiveVerify(declared[0]) === false);
    }

    // A chain the seller WITHDRAWS from its 402 leaves the row, with its
    // payTo, on the next live read; a chain the seller's own document names
    // never does. Carry-forward records which chains the documents named
    // (documentedNetworks) whenever remembered chains join them, and the read
    // keeps those and takes the 402's current set for the rest. Until
    // 2026-09-28 the read was a pure union, so a withdrawn chain and its old
    // wallet stayed listed for as long as the route was indexed.
    {
      const BASE = "eip155:8453", POLY = "eip155:137", OP = "eip155:10";
      const DOC = "0x3333333333333333333333333333333333333333";
      const OLD = "0x1111111111111111111111111111111111111111";
      const POLY_PAYTO = "0x4444444444444444444444444444444444444444";
      const NOW_PAYTO = "0x5555555555555555555555555555555555555555";
      const ROUTE = "/x402/withdrawn";
      const staleAt = Date.now() - 8 * 86_400_000;   // past the weekly re-read
      globalThis.fetch = stub({ [`GET ${ROUTE}`]: [accept({ payTo: NOW_PAYTO })] });   // today's 402: Base only
      const crawlN = [{
        seller: ORIGIN, method: "GET", route: ROUTE, slug: "withdrawn", price: 0.032, originDeclaredPrice: 0.032,
        networks: [OP, BASE, POLY], networksVerifiedAt: staleAt, networksVerifiedMethod: "GET", quoteSource: "live-402", quoteObservedAt: staleAt,
        payToByNetwork: { [OP]: DOC, [BASE]: OLD, [POLY]: POLY_PAYTO },
      }];
      // Every rebuild: the document prices the route and names Optimism, with its wallet.
      const rebuild = () => [{ seller: ORIGIN, method: "GET", route: ROUTE, slug: "withdrawn", price: 0.032, originDeclaredPrice: 0.032, networks: [OP], payToByNetwork: { [OP]: DOC } }];
      const rows = carryForwardLearnedQuotes(rebuild(), { tools: crawlN });
      check(`carry-forward records the chains the document named before the read's joined them (got ${JSON.stringify(rows[0].documentedNetworks)})`,
        JSON.stringify(rows[0].documentedNetworks) === JSON.stringify([OP]) && rows[0].networks.length === 3);
      await enrichLiveQuotes(rows, ORIGIN);
      const r = rows[0];
      check(`the read withdraws the chain the 402 no longer offers and keeps the documented one (got ${JSON.stringify(r.networks)})`,
        r.networks.length === 2 && r.networks.includes(OP) && r.networks.includes(BASE) && !r.networks.includes(POLY));
      check(`the withdrawn chain's payTo goes with it, the documented chain's stays, the offered chain's is today's (got ${JSON.stringify(r.payToByNetwork)})`,
        r.payToByNetwork?.[POLY] === undefined && r.payToByNetwork?.[OP] === DOC && r.payToByNetwork?.[BASE] === NOW_PAYTO);
      const next = carryForwardLearnedQuotes(rebuild(), { tools: carryForwardLearnedQuotes(rebuild(), { tools: rows }) })[0];
      check(`two rebuilds later the withdrawn chain is still gone (got ${JSON.stringify({ n: next.networks, p: next.payToByNetwork })})`,
        next.networks.length === 2 && !next.networks.includes(POLY) && next.payToByNetwork?.[POLY] === undefined && next.payToByNetwork?.[BASE] === NOW_PAYTO);

      // Two reads with no rebuild between them (a re-registration, or a row
      // object reused unchanged from the last crawl): the first read records
      // which chains the row held before it, so the second can withdraw what
      // the first added.
      const TWICE = "/x402/read-twice";
      globalThis.fetch = stub({ [`GET ${TWICE}`]: [accept({ payTo: NOW_PAYTO }), accept({ network: POLY, payTo: POLY_PAYTO })] });
      const twice = [{ seller: ORIGIN, method: "GET", route: TWICE, slug: "twice", price: null, networks: [OP], payToByNetwork: { [OP]: DOC } }];
      await enrichLiveQuotes(twice, ORIGIN, { ignoreBudget: true });
      check(`the first read adds its chains and records the row's own (got ${JSON.stringify({ n: twice[0].networks, d: twice[0].documentedNetworks })})`,
        twice[0].networks.length === 3 && JSON.stringify(twice[0].documentedNetworks) === JSON.stringify([OP]));
      globalThis.fetch = stub({ [`GET ${TWICE}`]: [accept({ payTo: NOW_PAYTO })] });
      await enrichLiveQuotes(twice, ORIGIN, { ignoreBudget: true });
      check(`the second read withdraws what the first added and the 402 no longer offers (got ${JSON.stringify({ n: twice[0].networks, p: twice[0].payToByNetwork })})`,
        twice[0].networks.length === 2 && !twice[0].networks.includes(POLY) && twice[0].payToByNetwork?.[POLY] === undefined && twice[0].payToByNetwork?.[OP] === DOC);
      // Carry-forward keeps a record the row already holds: a reused row
      // object states its document's chains plus earlier live ones, so
      // recomputing the record from it would count live chains as documented.
      const held = carryForwardLearnedQuotes(
        [{ seller: ORIGIN, method: "GET", route: TWICE, slug: "twice", price: 0.032, originDeclaredPrice: 0.032, documentedNetworks: [OP], networks: [OP, BASE] }],
        { tools: [{ method: "GET", route: TWICE, price: 0.032, quoteSource: "live-402", networks: [OP, BASE, POLY], networksVerifiedAt: Date.now(), networksVerifiedMethod: "GET" }] })[0];
      check(`carry-forward keeps an existing documented-chains record (got ${JSON.stringify({ d: held.documentedNetworks, n: held.networks })})`,
        JSON.stringify(held.documentedNetworks) === JSON.stringify([OP]) && held.networks.length === 3);

      // A row with no record of its documented chains (persisted before the
      // record existed) keeps everything it holds: nothing on it is known not
      // to be the seller's own claim.
      const LEGACY = "/x402/legacy-row";
      globalThis.fetch = stub({ [`GET ${LEGACY}`]: [accept({ payTo: NOW_PAYTO })] });
      const legacy = [{ seller: ORIGIN, method: "GET", route: LEGACY, slug: "legacy", price: null, networks: [BASE, POLY], payToByNetwork: { [BASE]: OLD, [POLY]: POLY_PAYTO } }];
      await enrichLiveQuotes(legacy, ORIGIN, { ignoreBudget: true });
      check(`a row without the record keeps every chain it held (got ${JSON.stringify(legacy[0].networks)})`,
        legacy[0].networks.length === 2 && legacy[0].networks.includes(POLY) && legacy[0].payToByNetwork?.[POLY] === POLY_PAYTO && legacy[0].payToByNetwork?.[BASE] === NOW_PAYTO);

      // A 402 whose accepts name no chain says nothing about chains.
      const NONET = "/x402/no-network";
      globalThis.fetch = stub({ [`GET ${NONET}`]: [accept({ network: undefined, payTo: NOW_PAYTO })] });
      const nonet = [{ seller: ORIGIN, method: "GET", route: NONET, slug: "nonet", price: null, documentedNetworks: [], networks: [BASE, POLY], payToByNetwork: { [BASE]: OLD, [POLY]: POLY_PAYTO } }];
      await enrichLiveQuotes(nonet, ORIGIN, { ignoreBudget: true });
      check(`a read that names no chain withdraws none (got ${JSON.stringify({ n: nonet[0].networks, p: nonet[0].payToByNetwork, q: nonet[0].quoteSource })})`,
        nonet[0].quoteSource === "live-402" && nonet[0].networks.length === 2 && nonet[0].payToByNetwork?.[POLY] === POLY_PAYTO);

      // The sibling write withdraws the same way: the stated GET is refused,
      // the declared POST answers with Base only, and the POST row had taken
      // Base and Polygon earlier (its own verified read, so the automatic
      // crawl does not probe it itself).
      const SIB = "/x402/sibling-withdrawn";
      globalThis.fetch = stub({ [`POST ${SIB}`]: [accept({ payTo: NOW_PAYTO })] });
      const sib = [
        { seller: ORIGIN, route: SIB, method: "GET", slug: "sib-get", price: null, networks: [] },
        { seller: ORIGIN, route: SIB, method: "POST", slug: "sib-post", price: 0.032, originDeclaredPrice: 0.032, documentedNetworks: [], networks: [BASE, POLY], networksVerifiedAt: Date.now(), networksVerifiedMethod: "POST", payToByNetwork: { [BASE]: OLD, [POLY]: POLY_PAYTO } },
      ];
      await enrichLiveQuotes(sib, ORIGIN);
      const post = sib.find((x) => x.method === "POST");
      check(`the sibling write withdraws the chain its 402 no longer offers (got ${JSON.stringify({ rows: sib.length, n: post?.networks, p: post?.payToByNetwork })})`,
        sib.length === 1 && post?.networks?.length === 1 && post.networks[0] === BASE && post.payToByNetwork?.[POLY] === undefined && post.payToByNetwork?.[BASE] === NOW_PAYTO);
    }

    // A declared sibling verb whose own verb does not answer a quote is left
    // exactly as it was, unless that verb refused definitively (404/405/410 on
    // every attempt). The case: the seller declares POST (read on an earlier
    // crawl: a learned quote on Base) and GET, the GET origin-priced with a
    // chain of its own and validating its input before the paywall, so an
    // unpaid GET answers 400 while the POST answers 402. Carry-forward no
    // longer stamps the GET from the POST's read, which makes the GET a probe
    // candidate of its own, and until 2026-09-28 the probe then dropped it
    // after ANY non-402 on GET. The drop writes no gone mark, so the declared
    // GET product left the index on every crawl and came back on every rebuild.
    {
      const BASE = "eip155:8453", OP = "eip155:10";
      const PREV_PAYTO = "0x1111111111111111111111111111111111111111";
      const NOW_PAYTO = "0x5555555555555555555555555555555555555555";
      const readAt = Date.now() - 86_400_000;
      // `get` answers the GET: a status, "throw" (a network failure), or a
      // function of the URL (a route tried with placeholder query params and
      // then bare). The POST answers 402 on the bare path only.
      const answers = (route, get) => async (url, init = {}) => {
        const u = new URL(String(url));
        const m = String(init.method || "GET").toUpperCase();
        if (u.pathname !== route) return new Response("{}", { status: 404 });
        if (m === "POST") {
          if (u.search) return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
          return new Response("{}", { status: 402, headers: { "payment-required": header([accept({ payTo: NOW_PAYTO })]), "content-type": "application/json" } });
        }
        const a = typeof get === "function" ? get(u) : get;
        if (a === "throw") throw new TypeError("fetch failed");
        return new Response("{}", { status: a, headers: { "content-type": "application/json" } });
      };
      const readN = (route) => [{
        seller: ORIGIN, route, method: "POST", slug: "v-post", price: 0.032, quoteSource: "live-402", quoteObservedAt: readAt,
        networks: [BASE], networksVerifiedAt: readAt, networksVerifiedMethod: "POST", liveProvenAt: readAt, payToByNetwork: { [BASE]: PREV_PAYTO },
      }];
      const crawl = (route, prevRows, getOver = {}) => carryForwardLearnedQuotes([
        { seller: ORIGIN, route, method: "POST", slug: "v-post", quoteSource: "openapi" },
        { seller: ORIGIN, route, method: "GET", slug: "v-get", price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi", networks: [OP], ...getOver },
      ], { tools: prevRows });
      const untouched = (g) => g?.method === "GET" && g.networks?.length === 1 && g.networks[0] === OP && !(Number(g.networksVerifiedAt) > 0)
        && !g.payToByNetwork && !g.evmDomainByNetwork && !(Number(g.liveProvenAt) > 0) && g.price === 0.01 && g.quoteSource === "openapi";

      for (const get of [400, 401, 403, 500, 503, "throw"]) {
        const route = `/x402/validates-first-${get}`;
        globalThis.fetch = answers(route, get);
        const rows = crawl(route, readN(route));
        check(`GET ${get}: before the crawl the GET is a probe candidate of its own`, networksNeedLiveVerify(rows.find((r) => r.method === "GET")) === true);
        await enrichLiveQuotes(rows, ORIGIN);
        const g = rows.find((r) => r.method === "GET"), p = rows.find((r) => r.method === "POST");
        check(`GET ${get}, POST 402: the declared GET stays in the index (rows ${rows.length})`, rows.length === 2 && Boolean(g));
        check(`GET ${get}: the GET row keeps nothing from the POST's read (got ${JSON.stringify({ n: g?.networks, v: g?.networksVerifiedAt, p: g?.payToByNetwork, l: g?.liveProvenAt, price: g?.price, s: g?.quoteSource })})`, untouched(g));
        check(`GET ${get}: the POST row takes the read (got ${JSON.stringify({ v: p?.networksVerifiedAt > readAt, l: p?.liveProvenAt > readAt, p: p?.payToByNetwork })})`,
          Number(p?.networksVerifiedAt) > readAt && Number(p?.liveProvenAt) > readAt && p?.payToByNetwork?.[BASE] === NOW_PAYTO);
      }

      // The proof that a verb answered lands on that verb's row: a pending
      // miss mark on the answering verb is cleared, and the stated verb's own
      // mark is not touched by an answer it did not give.
      {
        const route = "/x402/validates-first-marks";
        globalThis.fetch = answers(route, 400);
        markRouteGone(ORIGIN, "POST", route, { kind: "pending" });
        markRouteGone(ORIGIN, "GET", route, { kind: "pending" });
        const rows = crawl(route, readN(route));
        await enrichLiveQuotes(rows, ORIGIN);
        check(`GET 400, POST 402: the answering verb's pending mark is cleared, the stated verb's is left (got ${JSON.stringify({ post: goneMark(ORIGIN, "POST", route)?.kind ?? null, get: goneMark(ORIGIN, "GET", route)?.kind ?? null })})`,
          goneMark(ORIGIN, "POST", route) === null && goneMark(ORIGIN, "GET", route)?.kind === "pending" && rows.length === 2);
      }

      // A verb is "refused" only when EVERY attempt on it said so: a route
      // declaring a required query parameter is tried with placeholders and
      // then bare, and one definitive answer among others is not a refusal.
      // A network failure on one attempt counts against it too.
      const withQuery = { requestContract: ["declared", { query: ["url"] }] };
      for (const [route, label, get] of [
        ["/x402/mixed-404-400", "404 with placeholders, 400 bare", (u) => (u.search ? 404 : 400)],
        ["/x402/mixed-throw-404", "a network failure with placeholders, 404 bare", (u) => (u.search ? "throw" : 404)],
      ]) {
        globalThis.fetch = answers(route, get);
        const rows = crawl(route, readN(route), withQuery);
        await enrichLiveQuotes(rows, ORIGIN);
        const g = rows.find((r) => r.method === "GET");
        check(`GET ${label}: not a refusal, the GET stays as it was (rows ${rows.length})`, rows.length === 2 && untouched(g));
      }

      // Contrast: the stated verb refusing definitively (the seller declares a
      // verb it does not honour) still drops the stated row, and the POST
      // takes the read. 410 is the gone path and is pinned elsewhere.
      for (const get of [404, 405]) {
        const route = `/x402/refuses-${get}`;
        globalThis.fetch = answers(route, get);
        const rows = crawl(route, readN(route));
        await enrichLiveQuotes(rows, ORIGIN);
        check(`GET ${get}, POST 402: the refused GET row is dropped and the POST takes the read (rows ${rows.length})`,
          rows.length === 1 && rows[0].method === "POST" && Number(rows[0].networksVerifiedAt) > readAt && rows[0].payToByNetwork?.[BASE] === NOW_PAYTO);
      }
      {
        const route = "/x402/refuses-every";
        globalThis.fetch = answers(route, () => 404);
        const rows = crawl(route, readN(route), withQuery);
        await enrichLiveQuotes(rows, ORIGIN);
        check(`GET 404 on every attempt (placeholders and bare) is a refusal: dropped (rows ${rows.length})`, rows.length === 1 && rows[0].method === "POST");
      }

      // Rebuild after rebuild the kept GET stays, and the route backs off like
      // any probe that learned nothing for the row it probed, instead of asking
      // both verbs on every crawl.
      {
        const route = "/x402/validates-first-repeat";
        let gets = 0;
        const inner = answers(route, 400);
        globalThis.fetch = async (url, init = {}) => {
          if (String(init.method || "GET").toUpperCase() === "GET" && new URL(String(url)).pathname === route) gets++;
          return inner(url, init);
        };
        let rows = readN(route);
        const perCrawl = [];
        let stayed = true;
        for (let i = 1; i <= 6; i++) {
          rows = crawl(route, rows);
          const before = gets;
          await enrichLiveQuotes(rows, ORIGIN);
          perCrawl.push(gets - before);
          stayed = stayed && untouched(rows.find((r) => r.method === "GET"));
        }
        check("six crawls: the declared GET is indexed, untouched, after every one", stayed);
        check(`six crawls: the GET re-asks back off (GET probes per crawl ${JSON.stringify(perCrawl)})`,
          perCrawl[0] === 1 && perCrawl.slice(4).every((n) => n === 0) && perCrawl.reduce((a, b) => a + b, 0) <= 4);
      }

      // Rows the older carry already wrote to the persisted cache: a declared,
      // origin-priced GET with a chain of its own, holding its POST sibling's
      // read under its own key (the POST's Base chain, stamp and Base payTo),
      // beside the POST's learned quote. Neither stamp names a verb. From the
      // first crawl on, the GET lists only its own chain and no Base payTo,
      // whether it validates its input first (400: it never gets a read of its
      // own, so nothing can clean it later) or answers a 402 of its own on its
      // own chain (the union never drops a chain, so nothing can clean it
      // later either). The POST keeps its read throughout.
      {
        const GET_PAYTO = "0x6666666666666666666666666666666666666666";
        const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
        const olderCarry = (route) => [
          { seller: ORIGIN, route, method: "POST", slug: "v-post", price: 0.032, quoteSource: "live-402", quoteObservedAt: readAt,
            networks: [BASE], networksVerifiedAt: readAt, liveProvenAt: readAt, payToByNetwork: { [BASE]: PREV_PAYTO } },
          { seller: ORIGIN, route, method: "GET", slug: "v-get", price: 0.01, originDeclaredPrice: 0.01, quoteSource: "openapi",
            networks: [OP, BASE], networksVerifiedAt: readAt, payToByNetwork: { [BASE]: PREV_PAYTO } },
        ];
        for (const getAnswer of [400, 402]) {
          const route = `/x402/older-carry-${getAnswer}`;
          let gets = 0;
          globalThis.fetch = async (url, init = {}) => {
            const u = new URL(String(url));
            const m = String(init.method || "GET").toUpperCase();
            if (u.pathname !== route) return new Response("{}", { status: 404 });
            if (m === "POST") return new Response("{}", { status: 402, headers: { "payment-required": header([accept({ payTo: NOW_PAYTO })]), "content-type": "application/json" } });
            gets++;
            if (getAnswer === 400) return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
            return new Response("{}", { status: 402, headers: { "payment-required": header([accept({ network: OP, asset: USDC_OP, payTo: GET_PAYTO, amount: "10000" })]), "content-type": "application/json" } });
          };
          let rows = olderCarry(route);
          const getSeen = [], postSeen = [];
          for (let i = 1; i <= 8; i++) {
            rows = crawl(route, rows);
            await enrichLiveQuotes(rows, ORIGIN);
            const g = rows.find((r) => r.method === "GET"), p = rows.find((r) => r.method === "POST");
            getSeen.push({ n: g?.networks, p: g?.payToByNetwork ?? null, v: g?.networksVerifiedMethod ?? null, price: g?.price });
            postSeen.push({ n: p?.networks, p: p?.payToByNetwork?.[BASE] ?? null });
          }
          await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
          const g = rows.find((r) => r.method === "GET");
          getSeen.push({ n: g?.networks, p: g?.payToByNetwork ?? null, v: g?.networksVerifiedMethod ?? null, price: g?.price });
          const ownChainOnly = (s) => s.n?.length === 1 && s.n[0] === OP && !s.p?.[BASE] && s.price === 0.01;
          check(`older carry, GET ${getAnswer}: every crawl and a re-registration list the GET with its own chain only and no Base payTo (got ${JSON.stringify(getSeen)})`,
            getSeen.length === 9 && getSeen.every(ownChainOnly));
          check(`older carry, GET ${getAnswer}: the POST keeps its Base chain and a payTo on every crawl (got ${JSON.stringify(postSeen)})`,
            postSeen.every((s) => s.n?.length === 1 && s.n[0] === BASE && (s.p === PREV_PAYTO || s.p === NOW_PAYTO)));
          if (getAnswer === 400) {
            check(`older carry, GET 400: the GET never holds a stamp and takes no read (got ${JSON.stringify(getSeen.map((s) => s.v))})`,
              getSeen.every((s) => s.v === null && !s.p));
            check(`older carry, GET 400: the POST takes the read with a stamp naming POST (got ${JSON.stringify({ v: rows.find((r) => r.method === "POST")?.networksVerifiedMethod, p: postSeen.at(-1).p })})`,
              rows.find((r) => r.method === "POST")?.networksVerifiedMethod === "POST" && postSeen.at(-1).p === NOW_PAYTO);
          } else {
            check(`older carry, GET 402: the GET's own read names GET and its own wallet, and is carried from then on (got ${JSON.stringify(getSeen.slice(0, 8).map((s) => [s.v, s.p?.[OP] ?? null]))})`,
              getSeen.slice(0, 8).every((s) => s.v === "GET" && s.p?.[OP] === GET_PAYTO));
            check(`older carry, GET 402: one read, then the weekly clock (GET probes over 8 crawls: ${gets - 1} before the re-registration)`, gets === 2);
          }
        }
      }
    }

    // A learned quote whose read carry-forward WITHHOLDS (its stamp names no
    // verb, on a row with a chain of its own) keeps its price but no payTo, and
    // gets them back only from its own read. That read has to come: the probe
    // takes a capped number of rows per crawl, and until 2026-09-28 it ranked
    // them by quoteObservedAt alone, which a withheld row does not carry. Two
    // kinds of row sat level with it and ahead of it in array order:
    //  - "snapshot": a learned quote's row that the rebuild priced from a
    //    registry snapshot keeps the quote's stamp but not its age, so it is due
    //    on every crawl and read as never attempted. A cap's worth of these took
    //    the probes on every crawl, and the withheld rows never got theirs.
    //  - "weekly": origin-priced rows due for their weekly re-read. They took
    //    the first crawl's probes.
    // A stamp naming the row's own verb now also counts as a read, so a row
    // holding neither goes first, in either array order.
    {
      const BASE = "eip155:8453", OP = "eip155:10";
      const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
      const OLD_PAYTO = "0x1111111111111111111111111111111111111111";
      const NOW_PAYTO = "0x5555555555555555555555555555555555555555";
      const COMPETING = 20, HELD = 5, CRAWLS = 5;
      const twoDays = Date.now() - 2 * 86_400_000, eightDays = Date.now() - 8 * 86_400_000;
      for (const competitor of ["snapshot", "weekly"]) {
        for (const heldFirst of [false, true]) {
          const label = `${competitor} rows ${heldFirst ? "behind" : "ahead of"} the withheld rows`;
          const prefix = `/x402/rank-${competitor}-${heldFirst ? "h" : "c"}-`;
          const compRoute = (i) => `${prefix}comp-${i}`, heldRoute = (i) => `${prefix}held-${i}`;
          const asked = new Map();
          globalThis.fetch = async (url, init = {}) => {
            const u = new URL(String(url));
            if (String(init.method || "GET").toUpperCase() !== "GET" || !u.pathname.startsWith(prefix)) return new Response("{}", { status: 404 });
            asked.set(u.pathname, (asked.get(u.pathname) || 0) + 1);
            return new Response("{}", { status: 402, headers: { "payment-required": header([accept({ payTo: NOW_PAYTO, amount: "20000" }), accept({ network: OP, asset: USDC_OP, payTo: NOW_PAYTO, amount: "20000" })]), "content-type": "application/json" } });
          };
          const compBuilt = (i) => competitor === "snapshot"
            ? { seller: ORIGIN, method: "GET", route: compRoute(i), slug: `comp-${i}`, price: 0.02, paid: true, networks: [BASE], payToByNetwork: { [BASE]: NOW_PAYTO } }
            : { seller: ORIGIN, method: "GET", route: compRoute(i), slug: `comp-${i}`, price: 0.02, originDeclaredPrice: 0.02, quoteSource: "openapi", networks: [BASE] };
          const compPrev = (i) => competitor === "snapshot"
            ? { ...compBuilt(i), quoteSource: "live-402", quoteObservedAt: twoDays, networks: [BASE, OP], networksVerifiedAt: twoDays, networksVerifiedMethod: "GET" }
            : { ...compBuilt(i), networksVerifiedAt: eightDays, networksVerifiedMethod: "GET", payToByNetwork: { [BASE]: NOW_PAYTO } };
          const heldBuilt = (i) => ({ seller: ORIGIN, method: "GET", route: heldRoute(i), slug: `held-${i}`, quoteSource: "openapi", networks: [BASE] });
          // As the older carry left them: a learned quote with both chains and a
          // Base payTo, stamped before the verb was recorded.
          const heldPrev = (i) => ({ ...heldBuilt(i), price: 0.02, quoteSource: "live-402", quoteObservedAt: twoDays,
            networks: [BASE, OP], networksVerifiedAt: twoDays, payToByNetwork: { [BASE]: OLD_PAYTO } });
          const ids = (n) => Array.from({ length: n }, (_, i) => i);
          const order = (comp, held) => (heldFirst ? [...held, ...comp] : [...comp, ...held]);
          const rebuild = () => order(ids(COMPETING).map(compBuilt), ids(HELD).map(heldBuilt));
          let rows = order(ids(COMPETING).map(compPrev), ids(HELD).map(heldPrev));
          const heldAsked = [], compAsked = [], heldCarried = [];
          for (let crawl = 1; crawl <= CRAWLS; crawl++) {
            rows = carryForwardLearnedQuotes(rebuild(), { tools: rows });
            const held = rows.filter((r) => r.route.startsWith(`${prefix}held-`));
            heldCarried.push(held.map((r) => ({ p: r.payToByNetwork?.[BASE] ?? null, n: r.networks?.length ?? 0, v: r.networksVerifiedMethod ?? null })));
            if (crawl === 1) {
              check(`${label}: after the first rebuild the withheld rows hold their price, no Base payTo and no stamp, and are due (got ${JSON.stringify(held.map((r) => [r.price, r.payToByNetwork?.[BASE] ?? null, r.networksVerifiedAt ?? null, quoteIsStale(r)]))})`,
                held.length === HELD && held.every((r) => r.price === 0.02 && !r.payToByNetwork?.[BASE] && !(Number(r.networksVerifiedAt) > 0) && quoteIsStale(r) === true));
            }
            const before = new Map(asked);
            await enrichLiveQuotes(rows, ORIGIN);
            const delta = (route) => (asked.get(route) || 0) - (before.get(route) || 0);
            heldAsked.push(ids(HELD).reduce((n, i) => n + delta(heldRoute(i)), 0));
            compAsked.push(ids(COMPETING).reduce((n, i) => n + delta(compRoute(i)), 0));
          }
          // Control: the competing rows were due and took probes on the first
          // crawl, so the withheld rows were competing for the cap.
          check(`${label}: the competing rows took probes on the first crawl (per crawl ${JSON.stringify(compAsked)})`, compAsked[0] > 0);
          check(`${label}: every withheld row is read on the first crawl, and not again (held probes per crawl ${JSON.stringify(heldAsked)})`,
            heldAsked[0] === HELD && heldAsked.slice(1).every((n) => n === 0));
          const restored = (s) => s.p === NOW_PAYTO && s.n === 2 && s.v === "GET";
          check(`${label}: from the second rebuild on, each withheld row carries both chains, the 402's Base payTo and a stamp naming GET (rows restored per rebuild ${JSON.stringify(heldCarried.map((c) => c.filter(restored).length))}, e.g. ${JSON.stringify(heldCarried.at(-1)?.[0])})`,
            heldCarried.slice(1).every((crawl) => crawl.length === HELD && crawl.every(restored)));
        }
      }

      // Rows whose quote carries an age still go last, as before: a stale
      // learned quote ahead in array order waits behind rows due for their
      // weekly re-read when those fill the cap. Control: alone, it is read.
      {
        const prefix = "/x402/rank-aged-";
        const asked = new Map();
        globalThis.fetch = async (url, init = {}) => {
          const u = new URL(String(url));
          if (String(init.method || "GET").toUpperCase() !== "GET" || !u.pathname.startsWith(prefix)) return new Response("{}", { status: 404 });
          asked.set(u.pathname, (asked.get(u.pathname) || 0) + 1);
          return new Response("{}", { status: 402, headers: { "payment-required": header([accept({ payTo: NOW_PAYTO, amount: "20000" })]), "content-type": "application/json" } });
        };
        const aged = () => ({ seller: ORIGIN, method: "GET", route: `${prefix}stale`, slug: "stale", price: 0.02, quoteSource: "live-402", quoteObservedAt: eightDays,
          networks: [BASE], networksVerifiedAt: eightDays, networksVerifiedMethod: "GET", payToByNetwork: { [BASE]: NOW_PAYTO } });
        const weekly = (i) => ({ seller: ORIGIN, method: "GET", route: `${prefix}weekly-${i}`, slug: `weekly-${i}`, price: 0.02, originDeclaredPrice: 0.02, quoteSource: "openapi",
          networks: [BASE], networksVerifiedAt: eightDays, networksVerifiedMethod: "GET", payToByNetwork: { [BASE]: NOW_PAYTO } });
        const rows = [aged(), ...Array.from({ length: COMPETING }, (_, i) => weekly(i))];
        check("the stale learned quote and the weekly rows are all due", quoteIsStale(rows[0]) === true && rows.slice(1).every((r) => networksNeedLiveVerify(r) === true));
        await enrichLiveQuotes(rows, ORIGIN);
        const weeklyAsked = [...asked].filter(([p]) => p.includes("weekly-")).reduce((n, [, c]) => n + c, 0);
        check(`a stale learned quote goes behind rows with no age (stale asked ${asked.get(`${prefix}stale`) || 0}, weekly rows asked ${weeklyAsked} of ${COMPETING})`,
          !asked.has(`${prefix}stale`) && weeklyAsked > 0 && weeklyAsked < COMPETING);
        const alone = [aged()];
        await enrichLiveQuotes(alone, ORIGIN);
        check(`control: alone, the stale learned quote is read (asked ${asked.get(`${prefix}stale`) || 0})`, asked.get(`${prefix}stale`) === 1);

        // A stamp that names no verb, or another verb, is no record of a read
        // of this row (the same rule networksNeedLiveVerify reads): a row still
        // holding one, as the persisted cache can hand a re-registration, goes
        // ahead of rows due for their weekly re-read, not level with them.
        const foreign = (route, over) => ({ seller: ORIGIN, method: "GET", route: `${prefix}${route}`, slug: route, price: 0.02, originDeclaredPrice: 0.02, quoteSource: "openapi",
          networks: [OP, BASE], networksVerifiedAt: twoDays, payToByNetwork: { [BASE]: NOW_PAYTO }, ...over });
        const later = [...Array.from({ length: COMPETING }, (_, i) => weekly(`later-${i}`)), foreign("verbless", {}), foreign("other-verb", { networksVerifiedMethod: "POST" })];
        check("the verb-less and other-verb stamps are due", networksNeedLiveVerify(later.at(-2)) === true && networksNeedLiveVerify(later.at(-1)) === true);
        await enrichLiveQuotes(later, ORIGIN);
        check(`rows whose stamp names no verb, or another verb, are read ahead of a cap's worth of weekly rows (asked ${JSON.stringify([asked.get(`${prefix}verbless`) || 0, asked.get(`${prefix}other-verb`) || 0])})`,
          asked.get(`${prefix}verbless`) === 1 && asked.get(`${prefix}other-verb`) === 1);
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // 3. and it SURVIVES the next crawl, which rebuilds the row from a catalogue
  //    that names no wallet - filling a gap only, never overriding an address
  //    the origin's own document declared this crawl.
  const learned = { tools: [{ route: "/x402/basic", method: "GET", price: 0.032, quoteSource: "live-402", networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAYTO } }] };
  const carried = carryForwardLearnedQuotes([{ route: "/x402/basic", method: "GET", slug: "basic" }], learned)[0];
  check(`carry-forward keeps the learned payTo across the rebuild (got ${JSON.stringify(carried.payToByNetwork)})`,
    carried.payToByNetwork?.["eip155:8453"] === PAYTO);
  const declaredNow = carryForwardLearnedQuotes([{ route: "/x402/basic", method: "GET", payToByNetwork: { "eip155:8453": "0x0000000000000000000000000000000000000002" } }], learned)[0];
  check("a payTo this crawl read from the origin is never overwritten by the remembered one",
    declaredNow.payToByNetwork["eip155:8453"] === "0x0000000000000000000000000000000000000002");
  const sharedSource = { "eip155:8453": "0x0000000000000000000000000000000000000003" };
  // The remembered row names its chain, so its payTo rides with it (a payTo
  // travels only with the chains it describes); the row gets the wallet, the
  // manifest's shared object does not.
  const sharedRow = carryForwardLearnedQuotes([{ route: "/a", method: "GET", payToByNetwork: sharedSource }],
    { tools: [{ route: "/a", method: "GET", price: 1, quoteSource: "live-402", networks: [SOL_NET], payToByNetwork: { [SOL_NET]: SOL_PAYTO } }] })[0];
  check("a manifest's shared payTo object is never written through (rows on one path would move together)",
    sharedSource[SOL_NET] === undefined && sharedRow.payToByNetwork?.[SOL_NET] === SOL_PAYTO);

  // 4. the manifest's own top-level wallet reaches a bare-string resource row
  const manifest = {
    spec: "x402", version: 2,
    resources: ["https://seller.example/x402/basic", "https://seller.example/x402/full"],
    payment: { x402: { version: 2, currency: "USDC", networks: ["base"], primaryNetwork: "base", payTo: PAYTO, nonCustodial: true } },
  };
  const bare = normaliseManifestTools(manifest, "https://seller.example");
  check(`a bare-string resource inherits the service-wide payTo (got ${JSON.stringify(bare[0]?.payToByNetwork)})`,
    bare.length === 2 && bare.every((r) => r.payToByNetwork?.["eip155:8453"] === PAYTO));
  check(`and the declared chain with it (got ${JSON.stringify(bare[0]?.networks)})`, bare[0]?.networks?.[0] === "eip155:8453");
  const mixed = normaliseManifestTools({ resources: ["https://seller.example/x"], payment: { x402: { networks: ["base", "solana"], payTo: PAYTO } } }, "https://seller.example");
  check(`an EVM wallet is not filed under a Solana network (got ${JSON.stringify(mixed[0]?.payToByNetwork)})`,
    mixed[0]?.payToByNetwork?.["eip155:8453"] === PAYTO && Object.keys(mixed[0].payToByNetwork).length === 1
    && mixed[0].networks.length === 2);

  // 5. end to end: the field the Base scan and the seller page actually read
  __testResetSubmitted();
  __testSeedCache([["https://seller.example", {
    origin: "https://seller.example", fetchedAt: Date.now(), history: [1], originResponded: true,
    manifest: { name: "Seller" },
    tools: bare.map((r) => ({ ...r, price: 0.032, paid: true })),
  }]]);
  const detail = sellerDetail("seller.example");
  check(`sellerDetail publishes the payTo (got ${JSON.stringify(detail?.payToByNetwork)})`,
    detail?.payToByNetwork?.["eip155:8453"] === PAYTO && detail.payTosByNetwork["eip155:8453"][0] === PAYTO);
  const snapRow = indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "x" })
    .sellers.find((x) => x.origin === "https://seller.example");
  check(`the snapshot row carries it (got ${JSON.stringify(snapRow?.payToByNetwork)})`,
    snapRow?.payToByNetwork?.["eip155:8453"] === PAYTO);
  const scan = allPayToOrigins("eip155:8453");
  check("allPayToOrigins offers the wallet to the Base scan, mapped to its origin",
    scan.get(PAYTO.toLowerCase())?.has("https://seller.example") === true);
  __testResetSubmitted();
}

// --- an ATOMIC amount is not dollars, in two more shapes (2026-09-22) --------
// The 2026-09-15 fix taught the reader that an accept-shaped ENTRY states base
// units. Two live shapes kept reading them as dollars because the context sits
// one level in: a manifest `price` OBJECT carrying decimals/asset beside the
// amount (listed a $0.003 route at $3000) and MPP's `x-payment-info`
// {amount, currency, method, intent, offers} (listed a $0.005 route at $5000).
// A listing a million times the seller's real price also puts the route over
// every router tier cap, and the seller cannot see our index to report it.
{
  const { normaliseManifestTools, normaliseOpenapiTools, openapiOperationPayment, mergeOpenapiIntoBazaar, bazaarItemToTool, priceToMicroUsd } = await import("../src/x402-index.js");
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50"; // Tempo, six decimals
  const PAYTO = "0x4444444444444444444444444444444444444444";
  const stack = (price) => normaliseManifestTools({
    x402Version: 2,
    payment: { protocol: "x402", scheme: "exact", network: "eip155:8453", asset: "USDC", asset_address: USDC_BASE, pay_to: PAYTO },
    resources: [{ resource: "https://seller.example/stack", method: "POST", price, description: "Identify a site's stack." }],
  }, "https://seller.example")[0];

  const priced = (row, want, why) => check(`${why} -> ${want} (got ${row?.price})`, row?.price === want);
  priced(stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" }), "$0.003",
    "the seller's own display string wins over a figure we would have to convert");
  priced(stack({ amount: "3000", asset: USDC_BASE, decimals: 6 }), "$0.003", "declared decimals size the amount");
  priced(stack({ amount: "3000", asset: USDC_BASE }), "$0.003", "a token we know is six decimals needs no declaration");
  priced(stack({ amount: "0.032", currency: "USDC", network: "eip155:8453" }), "$0.032",
    "a bare currency beside a fractional amount is dollars, which is what catalogues publish");
  priced(stack({ amount: "0.003", asset: USDC_BASE, decimals: 6 }), "$0.003",
    "a fractional figure cannot be base units whatever sits beside it");
  const unknown = stack({ amount: "3000", asset: "0x00000000000000000000000000000000000000ff" });
  check(`a token we cannot size publishes NO price rather than a guess (got ${unknown?.price})`,
    unknown?.price == null && !(Number(unknown?.originDeclaredPrice) > 0));
  priced(stack({ amount: "3000", asset: "0x00000000000000000000000000000000000000ff", display: "$0.003" }), "$0.003",
    "and the seller's own label rescues exactly that row, which is what reading it first is for");

  // DECIMALS SAY HOW TO READ AN AMOUNT, NEVER WHAT IT IS WORTH. The first cut
  // let a declared `decimals` size ANY asset, so the seller's own field was the
  // whole rule: the same row at decimals 18 publishes 0.000000000000005 and at
  // decimals 2 publishes $50, neither of them a dollar figure of a dollar.
  // decimals 2, deliberately: at 18 the figure is unwritable and the plain-
  // decimal guard below would refuse it anyway, so the case would pass with the
  // peg rule deleted. At 2 the old reader publishes a confident $50.
  const declaredOnUnknown = stack({ amount: "5000", asset: "0x00000000000000000000000000000000000000ff", decimals: 2 });
  check(`a declared decimals does NOT size a token we cannot recognise as a dollar - $50 of an unknown token is not $50 (got ${declaredOnUnknown?.price})`,
    declaredOnUnknown?.price == null && !(Number(declaredOnUnknown?.originDeclaredPrice) > 0));
  const contradiction = stack({ amount: "3000", asset: USDC_BASE, decimals: 18 });
  check(`a declaration contradicting the chain (USDC is six) publishes nothing rather than picking a side (got ${contradiction?.price})`,
    contradiction?.price == null);
  const huge = stack({ amount: "1" + "0".repeat(27), asset: USDC_BASE });
  check(`an amount whose dollar figure cannot be written as a plain decimal publishes nothing, never "$1e+21" (got ${huge?.price})`,
    huge?.price == null);

  // THE MUTATION THIS SECTION COULD NOT KILL: every bare-currency assertion
  // above used a FRACTIONAL amount, which takes the fractional path whatever
  // atomicContext says - so deleting the `method`/`intent` clause from it left
  // the suite green while every catalogue row of this shape got divided by a
  // million. A WHOLE amount beside a bare currency is the case that separates
  // them: dollars, because that is what catalogues publish, and $0.000032 only
  // if a bare ticker is wrongly read as payment context.
  priced(stack({ amount: "32", currency: "USDC", network: "eip155:8453" }), "$32",
    "a WHOLE amount beside a bare currency is still dollars: a ticker alone is not payment context");

  // ONE DECLARATION, ONE READING. The ticker rule was applied to `currency` and
  // not to `asset`, so the same sentence written three ways read $2, $2 and
  // $0.000002 - a millionfold under-quote on a seller's listing, reached from
  // an identical statement. An asset field carrying a real IDENTIFIER still
  // states base units; that is the case this machinery was built for.
  const ticker = ["currency", "asset", "symbol"].map((field) =>
    stack({ amount: "2", [field]: "USDC", network: "eip155:8453" })?.price);
  check(`a bare ticker reads the same in currency, asset and symbol (got ${JSON.stringify(ticker)})`,
    ticker.every((v) => v === "$2"));
  priced(stack({ amount: "3000", asset: USDC_BASE }), "$0.003",
    "...while an asset IDENTIFIER beside the amount still states base units");
  priced(stack({ amount: "5000", currency: USDC_E, method: "tempo", intent: "charge" }), "$0.005",
    "...and so does an MPP declaration, whose currency IS the identifier");
  check(`the readable one anchors the drift guard (got ${stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })?.originDeclaredPrice})`,
    stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })?.originDeclaredPrice === 0.003);

  const mpp = { amount: "5000", currency: USDC_E, description: "Ask a question.", intent: "charge", method: "tempo" };
  const doc = { openapi: "3.1.0", paths: { "/v1/query": { post: { operationId: "query", "x-payment-info": { ...mpp, offers: [{ ...mpp }] } } } } };
  const mppRow = normaliseOpenapiTools(doc, "https://seller.example").find((t) => t.route === "/v1/query");
  check(`MPP x-payment-info amount "5000" is $0.005, never $5000 (got ${mppRow?.price})`, mppRow?.price === "$0.005" && mppRow?.paid === true);
  check("an offers-only declaration prices the same way",
    openapiOperationPayment({ "x-payment-info": { intent: "charge", method: "tempo", offers: [{ ...mpp }] } }).price === "$0.005");
  const stripeish = openapiOperationPayment({ "x-payment-info": { amount: "50", currency: "usd", intent: "charge", method: "stripe" } });
  check(`a currency we cannot size is PAID with the price unknown, never $50 (got ${stripeish.price})`,
    stripeish.paid === true && stripeish.price == null);

  // GUARD, scoped to the FIGURE rather than to these two dialects: an
  // origin-declared price that differs from the settlement-observed Bazaar
  // price by 1000x or more is not a disagreement about value, it is a units
  // bug. Whatever shape arrives next in base units lands here.
  const thousandfold = (rows) => rows.filter((r) => {
    const o = priceToMicroUsd(r?.priceObservations?.origin);
    const b = priceToMicroUsd(r?.priceObservations?.bazaar);
    if (!(o > 0) || !(b > 0)) return false;
    return (o > b ? o / b : b / o) >= 1000;
  });
  const observed = (route, amount, method) => bazaarItemToTool({
    resource: `https://seller.example${route}`, method,
    accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount, extra: { name: "USD Coin" } }],
  }, "https://seller.example");
  // control FIRST: the figure the old reader produced must be flagged, so a
  // clean sweep below is only believed once the check has caught one.
  const planted = mergeOpenapiIntoBazaar([{ ...stack({ amount: "3000", asset: USDC_BASE, decimals: 6 }), price: "$3000" }], [observed("/stack", "3000", "POST")]);
  check(`control: a $3000 reading of a 3000-base-unit route is flagged (${thousandfold(planted).length})`, thousandfold(planted).length === 1);
  const swept = [
    ...mergeOpenapiIntoBazaar([stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })], [observed("/stack", "3000", "POST")]),
    ...mergeOpenapiIntoBazaar([mppRow], [observed("/v1/query", "5000", "POST")]),
  ];
  check(`no declared price is a thousandfold of what settled (${thousandfold(swept).length} flagged of ${swept.length})`,
    swept.length === 2 && thousandfold(swept).length === 0);
}

// The directory's endpoint count measures rows held (healthy https sellers,
// one per distinct endpoint), not the summed advertised tool counts the
// marketplace and the standing band print; the page says which it is.
{
  const html = page([tool()]);
  check("/marketplace/tools names what its endpoint count measures", /1 endpoints in one searchable list, one row per distinct endpoint from sellers whose last crawl over https succeeded/.test(html));
  check("/marketplace/tools says why its figure differs from the marketplace tool listings", /sum the tool count each indexed seller advertises, including sellers this list leaves out/.test(html));
}

console.log(`\ntest-index-tools-catalog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);