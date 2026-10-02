#!/usr/bin/env node
// The multi-page half of GET /api/index, which a booted test CANNOT reach.
//
// A CI boot indexes exactly ONE seller (the host's own row), so complete is
// always true there and rel="next" never appears. The first cut of the guard
// asserted those branches behind `if (sellerCount > 1)` and therefore proved
// nothing about them - a certificate for the half that never broke. The
// arithmetic lives in src/index-paging.js so it can be driven with the real
// numbers: 4,473 sellers, 250 a page, 18 pages, and a seller on page 15.
//
//   node scripts/test-index-paging-contract.js
import { pageSizeOf, pagingEnvelope, pagingNote } from "../src/index-paging.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The incident, reproduced as arithmetic: 4,473 sellers, default page size.
{
  const total = 4473, perPage = 250;
  const p0 = pagingEnvelope({ total, page: 0, perPage });
  ok(p0.pages === 18 && p0.lastPage === 17, "4,473 sellers at 250 a page is 18 pages, last index 17");
  ok(p0.complete === false, "page 0 is NOT the complete set, and says so in one boolean");
  ok(/rel="next"/.test(p0.link), "page 0 offers rel=next");
  ok(!/rel="prev"/.test(p0.link), "...and no rel=prev, because there is nothing before it");
  ok(/<\/api\/index\?page=17&limit=250>; rel="last"/.test(p0.link), "rel=last points at the real final page");

  const p15 = pagingEnvelope({ total, page: 15, perPage });   // where the seller actually was
  ok(/rel="prev"/.test(p15.link) && /rel="next"/.test(p15.link), "a middle page offers both directions");
  ok(p15.complete === false, "a middle page is not complete either");

  const p17 = pagingEnvelope({ total, page: 17, perPage });
  ok(!/rel="next"/.test(p17.link), "the LAST page offers no next, which is how a walk terminates");
  ok(p17.complete === false, "...and is still not the complete set - completeness is about the RESPONSE, not the position");
}

// complete is true only when one response really does hold everything.
{
  ok(pagingEnvelope({ total: 1, page: 0, perPage: 250 }).complete === true, "one seller in one page is complete");
  ok(pagingEnvelope({ total: 250, page: 0, perPage: 250 }).complete === true, "exactly one full page is complete");
  ok(pagingEnvelope({ total: 251, page: 0, perPage: 250 }).complete === false, "one more than a page is not");
  ok(pagingEnvelope({ total: 0, page: 0, perPage: 250 }).complete === true, "an empty index is trivially complete, never 'partial'");
  // The same lie in miniature: an out-of-range page holds nothing and must not
  // call itself complete. Completeness describes THIS response, not the index.
  ok(pagingEnvelope({ total: 10, page: 3, perPage: 250 }).complete === false,
     "a page past the end of a ONE-page index is not complete - it carries zero sellers");
}

// The note leads with the word that matters.
{
  const e = pagingEnvelope({ total: 4473, page: 0, perPage: 250 });
  const n = pagingNote({ total: 4473, page: 0, perPage: 250, shown: 250, ...e });
  ok(n.startsWith("PARTIAL:"), "the partial note LEADS with PARTIAL rather than burying it");
  ok(/\?seller=<host>/.test(n), "...and names the single-origin form, the call this incident needed");
  ok(/250 of 4473/.test(n), "...and states both numbers, so the sample size is unmissable");

  const done = pagingEnvelope({ total: 10, page: 0, perPage: 250 });
  ok(!/PARTIAL/.test(pagingNote({ total: 10, page: 0, perPage: 250, shown: 10, ...done })),
     "a complete answer never cries PARTIAL");

  const past = pagingEnvelope({ total: 4473, page: 99, perPage: 250 });
  const pn = pagingNote({ total: 4473, page: 99, perPage: 250, shown: 0, ...past });
  ok(/No sellers at page 99/.test(pn) && /not page 1/.test(pn),
     "an out-of-range page says so instead of reading as the end of the data");
}

// The alias that two consumers guessed.
{
  // 37, never 100: the default IS 100, so asserting that value proves nothing -
  // a build that ignores perPage entirely returns 100 and passes. (Caught by
  // mutation: dropping the alias left this assertion green.)
  ok(pageSizeOf(undefined, "37") === 37, "perPage is honoured when limit is absent");
  ok(pageSizeOf("25", "100") === 25, "limit wins when both are sent");
  ok(pageSizeOf(undefined, undefined) === 100, "the default is unchanged at 100");
  ok(pageSizeOf("9999", undefined) === 250, "the 250 ceiling still holds");
  ok(pageSizeOf("0", undefined) === 1 && pageSizeOf("-5", undefined) === 1, "a nonsense size floors at 1 rather than dividing by zero");
  ok(pageSizeOf("abc", undefined) === 100, "unparseable falls back to the default");
}

// The handler must actually USE this module, or the arithmetic above is a
// pretty fiction. Pinned from source, like every other call-site guard here.
{
  const src = await (await import("node:fs")).promises.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/from "\.\/index-paging\.js"/.test(src), "server.js imports the paging contract");
  // Window the HANDLER, never a byte count: a fixed slice silently stops
  // covering its own assertions the moment anything above grows, and then the
  // guard reports green for code it can no longer see.
  const hStart = src.indexOf('app.get("/api/index"');
  const h = src.slice(hStart, src.indexOf("app.get(", src.indexOf("});", src.indexOf("legend: dispatchLegend", hStart))));
  ok(/pagingEnvelope\(\{ total: sellers\.length/.test(h), "the handler builds its envelope from it");
  ok(/res\.set\("Link", link\)/.test(h), "...sets the Link header from it");
  ok(/X-Total-Count/.test(h), "...and publishes the total as a header");
  // Matches the CALL, not the assignment: the note gained a readiness sentence
  // prepended to it, and a rule anchored on `note: pagingNote(` went red for a
  // change that kept the very property it exists to protect. What matters is
  // that the prose is BUILT by the module and fed the same numbers as the
  // fields, so nothing can drift; where the string is concatenated is not.
  ok(/pagingNote\(\{ total: sellers\.length, page, perPage/.test(h),
    "...and takes its note from the same place, so note and fields cannot drift");
}

// The SAME defect one branch away: the seller detail cuts the tool list at 500
// and said nothing, on the surface we tell sellers to self-diagnose with. A row
// declaring 3,638 tools returned 500, so an audit against it would report 3,138
// routes lost. toolCount was right the whole time, which is what made the
// silence convincing.
{
  const src = await (await import("node:fs")).promises.readFile(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/export const SELLER_TOOLS_CAP = 500;/.test(src), "the tool cap is a named constant, not a magic number in a slice");
  const dStart = src.indexOf("export function sellerDetail");
  const dEnd = src.indexOf("\nexport ", dStart + 10);
  const d = src.slice(dStart, dEnd > dStart ? dEnd : src.length);
  ok(/toolsTruncated: \(v\.tools \|\| \[\]\)\.length > SELLER_TOOLS_CAP/.test(d),
     "the detail says when its tool list was cut");
  ok(/toolsReturned:/.test(d) && /toolsCap: SELLER_TOOLS_CAP/.test(d),
     "...and publishes how many it returned against the cap, so the gap is arithmetic rather than a guess");
  ok(/slice\(0, SELLER_TOOLS_CAP\)/.test(d),
     "the slice and the flag read the SAME constant, so they cannot drift apart");
}

// The two RANKING surfaces, same class: a ceiling reported as a count. Found by
// using them against prod, not by reading them: ?top=100 on /api/route returned
// 25 with count:25, and /api/find ignored `top` entirely (it took only `k`),
// always returned 5 and called that the count. A caller asking "how many tools
// do you have for data" was told five.
{
  const { ROUTE_TOP_MAX } = await import("../src/x402-index.js");
  const { FIND_TOP_MAX, FIND_TOP_DEFAULT, findTools } = await import("../src/find.js");
  ok(ROUTE_TOP_MAX === 25 && FIND_TOP_MAX === 25, "both ranking ceilings are named constants, not magic numbers");
  ok(FIND_TOP_DEFAULT === 5, "...and the find default is named too, since it is the number that was being read as a match count");

  // A catalog big enough to be cut, so `truncated` is exercised rather than
  // asserted against an empty ranking - the trap that made the first paging
  // guard prove nothing.
  const catalog = {};
  for (let i = 0; i < 40; i++) catalog[`/api/data-${i}`] = { slug: `data-${i}`, name: `data tool ${i}`, description: "data data data", price: "$0.001", category: "data", tags: ["data"] };
  const cut = findTools(catalog, "data", { k: 5 });
  ok(cut.count === 5 && cut.truncated === true, "a ranking cut by the limit says truncated");
  ok(cut.topMax === FIND_TOP_MAX, "...and publishes the ceiling beside the count");
  const whole = findTools(catalog, "data", { k: 25 });
  ok(whole.truncated === true, "40 matches at the 25 ceiling is still truncated");
  catalog["/api/zephyr"] = { slug: "zephyr", name: "zephyr", description: "zephyr", price: "$0.001", category: "misc", tags: ["zephyr"] };
  const narrow = findTools(catalog, "zephyr", { k: 25 });
  ok(narrow.truncated === false, "a ranking that fits is NOT truncated - the flag tracks the cut, not the query");

  const src = await (await import("node:fs")).promises.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const k = req\.query\.k \?\? req\.query\.top;/.test(src),
     "/api/find accepts `top`, the name its sibling /api/route takes, instead of silently serving the default");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
