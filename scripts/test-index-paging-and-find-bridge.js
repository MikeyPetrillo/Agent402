#!/usr/bin/env node
// Two surfaces that told a consumer something false, both found by USING them.
//
// 1. /api/index paginates ZERO-BASED and said `pages: N` next to "Use ?page=N"
//    with no base named. The obvious reading - iterate 1..pages - drops the
//    FIRST page (the highest-ranked sellers) and ends on an empty one. It cost
//    a real reading: three seller origins read as "not indexed" while sitting
//    on page 0, and the empty last page looked like the end of the list rather
//    than one step past it.
//
// 2. /api/find declared a MISS and recorded a demand-board wish for a query an
//    INDEXED SELLER already serves. The guard meant to prevent exactly that
//    ("the ecosystem already serves this") matched seller HOST LABELS only, so
//    it could answer for a query spelling a seller's name and never for one
//    describing a task - which is every real query. Reported by a seller whose
//    route /api/route?include=external ranks for the same words.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PORT = await getFreePort();
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const get = async (p) => (await fetch(`${base}${p}`)).json();

// --- 1. the paging contract names its own base ------------------------------
{
  const p0 = await get("/api/index?limit=2&page=0");
  ok(p0.firstPage === 0, "the envelope names the FIRST page rather than leaving the base to be guessed");
  ok(typeof p0.lastPage === "number" && p0.lastPage === Math.max(p0.pages - 1, 0),
     "lastPage is pages-1, so `pages` can no longer be read as the last page number");
  ok(/ZERO-BASED/.test(p0.note), "the note says the base out loud");
  ok(new RegExp(`\\?page=0 \\.\\. \\?page=${p0.lastPage}`).test(p0.note),
     "...and spells the whole valid range, which is the thing a consumer actually needs");

  // The bug in one assertion: a reader who iterates 1..pages must not silently
  // lose page 0's rows. They cannot, as long as the range is stated - but an
  // out-of-range page must SAY it is out of range rather than look like the end.
  const past = await get(`/api/index?limit=2&page=${p0.lastPage + 1}`);
  ok(Array.isArray(past.sellers) && past.sellers.length === 0, "a page past the end returns no sellers");
  ok(/No sellers at page/.test(past.note) && /first page, not page 1/.test(past.note),
     "...and says so in words, instead of an empty list that reads as the end of the data");
}

// --- 1b. the partialness reaches a machine that reads no prose ---------------
//
// The zero-based fix above put the facts in the envelope and a sentence in the
// note, and a seller's automated checker STILL reported their origin missing
// from the index (2026-09-22): it fetched the default page, searched 250 rows
// of 4,473, and did not find them. They were on page 15. So the answer has to
// say "this is a page" in the two places a machine looks before prose: a
// standard Link relation, and one boolean.
{
  const r = await fetch(`${base}/api/index?limit=1&page=0`);
  const body = await r.json();
  const link = r.headers.get("link") || "";
  const many = body.sellerCount > 1;

  ok(typeof body.complete === "boolean", "the envelope carries a machine-readable `complete` flag");
  ok(body.complete === (body.pages <= 1),
     "`complete` is false exactly when a seller is absent from THIS response but present in the index");
  ok(r.headers.get("x-total-count") === String(body.sellerCount),
     "X-Total-Count matches sellerCount, so a HEAD request alone answers 'how many are there'");

  if (many) {
    ok(/rel="next"/.test(link), "an RFC 8288 Link header offers rel=next while more pages exist");
    ok(/rel="last"/.test(link) && /rel="first"/.test(link), "...with first and last, so a crawler can bound the walk");
    ok(!/rel="prev"/.test(link), "page 0 offers no prev");
    ok(/PARTIAL/.test(body.note) && /\?seller=/.test(body.note),
       "the note leads with PARTIAL and names the single-origin form that pages nothing");

    const last = await (await fetch(`${base}/api/index?limit=1&page=${body.lastPage}`)).json();
    ok(last.complete === false, "the LAST page is still not the complete set");
  }

  // `perPage` is honoured as an alias for `limit`. Two consumers guessed that
  // name and were silently handed the default page instead.
  const alias = await (await fetch(`${base}/api/index?perPage=3&page=0`)).json();
  ok(alias.perPage === 3, "a guessed `perPage` is obeyed rather than silently ignored");

  // Browsers must be able to READ the paging headers, or the fix is invisible
  // to exactly the consumer that cannot inspect a proxy log.
  const cors = await (await import("node:fs")).promises.readFile(new URL("../src/cors.js", import.meta.url), "utf8");
  ok(/"Link",/.test(cors) && /"X-Total-Count",/.test(cors),
     "both paging headers are in Access-Control-Expose-Headers");

  // And our own copy must stop calling it a snapshot of everything, which is
  // what invited the misreading in the first place.
  const seo = await (await import("node:fs")).promises.readFile(new URL("../src/seo.js", import.meta.url), "utf8");
  ok(!/snapshot of every seller indexed/.test(seo),
     "llms.txt no longer advertises the paginated listing as every seller indexed");
  ok(/PAGINATED/.test(seo.slice(seo.indexOf("- [/api/index]"), seo.indexOf("- [/api/index]") + 400)),
     "...and says PAGINATED where an agent reads it");
}

// --- 2. find stops inventing demand for what the ecosystem sells -------------
{
  // The bridge is a HINT, never a result row: /api/find stays catalog-only.
  const src = await (await import("node:fs")).promises.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const externalServes = async \(q, meter = null\) => \{/.test(src), "the miss branch has an external-capability consult");
  ok(/externalServes\(q, meter\)/.test(src) && src.indexOf("externalServes(q, meter)") > src.indexOf("result.relatedSellers"),
     "...consulted AFTER the seller-name bridge, so a name match still wins");
  const missBranch = src.slice(src.indexOf("} else if (await externalServes(q, meter)) {"), src.indexOf('result.hint = "POST /api/wish'));
  ok(!/recordWish/.test(missBranch),
     "a query an indexed seller serves records NO wish - a false demand signal steers what we build next");
  ok(/routeAcross/.test(missBranch), "...and the caller is handed the router link instead of being told nothing exists");
  ok(/include: "external"/.test(src.slice(src.indexOf("const externalServes"), src.indexOf("const computeFind"))),
     "the consult asks the EXTERNAL pool, which is the half /api/find does not search");
}

child.kill("SIGTERM");
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
