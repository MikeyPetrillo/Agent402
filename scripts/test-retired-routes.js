// Retired catalog routes answer 410 Gone with the replacement, never the
// guessed-slug 404 (src/retired-tools.js). Offline half: the registry rules.
// Booted half: the wire shape on a free server.
//
//   node scripts/test-retired-routes.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { RETIRED_TOOLS, RETIRED_PACKS, RETIRED_CONVERTERS_AT, retiredEntryFor, retiredEntryForSlug, assertRetiredRegistryConsistent, retirementHeaders } from "../src/retired-tools.js";
import { execFileSync } from "node:child_process";
import { readFileSync as readTextSync } from "node:fs";
import { loadSnapshot, envGatedSegments, segmentsOf, accountFor } from "./published-slugs.js";

let pass = 0;
let proc = null; // the booted server, stopped on a failure so it never outlives the test
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); proc?.kill("SIGTERM"); process.exit(1); } };
const throws = (fn, re, m) => { let e = null; try { fn(); } catch (err) { e = err; } ok(e && re.test(e.message), `${m} (${e ? e.message.slice(0, 80) : "did not throw"})`); };

// --- the registry rules ---------------------------------------------------------
const liveSet = new Set(["coin-search", "lending-rates", "defi-screener", "coin-profile", "chain-board", "stablecoin-depeg-watch", "stablecoin-peg", "dex-volume-board", "global-defi", "dex-pool-health", "l2-gas-comparison", "perp-orderbook", "onchain-sql", "fred-series", "kalshi-markets", "kalshi-event", "kalshi-live-data", "stock-quote", "price-coingecko", "crypto-price", "business-days", "cron-next", "slugify", "hash", "contract-source", "wallet-balance", "token-metadata", "tx-receipt", "color", "xml-to-json", "skill-company-dossier", "checksum", "lorem", "password-strength", "qr", "semver", "case", "uuid", "place-lookup", "geo-lookup", "search", "answer", "extract"]);
ok(assertRetiredRegistryConsistent(liveSet) === true, "control: the registry is consistent against a live set that carries every replacement");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet, "options-chain"])), /listed as retired but is live/, "a retired tool that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet, "skill-market-open"])), /pack "market-open" is listed as retired but is live/, "a retired pack that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...liveSet].filter((s) => s !== "coin-search"))), /names replacement "coin-search", which is not a live/, "a replacement that is not live fails the boot");
ok(Object.values(RETIRED_TOOLS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)) && Object.values(RETIRED_PACKS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)), "every entry carries a retirement date");

// --- what a 410 or 404 suggests (goneSuggestions) ---------------------------------
// By meaning, never word overlap: a retired route's declared replacement leads,
// a route with none suggests only the live tools its note names, and only an
// unknown path falls back to matching, held to the best match's category.
{
  const { goneSuggestions } = await import("../src/retired-tools.js");
  const D = (slug, category) => ({ slug, category, route: `GET /api/${slug}`, price: "$0.001", name: slug });
  const defs = [D("coin-search", "crypto"), D("crypto-price", "crypto"), D("search", "search"), D("search-news", "search"), D("fred-series", "data"), D("dex-volume-board", "crypto"), D("uuid", "dev"), D("hash", "dev")];
  const slugsOf = (xs) => xs.map((x) => x.slug).join(",");
  // A word-overlap match that leads with an unrelated tool (web search for "coins list").
  const overlap = [D("search", "search"), D("crypto-price", "crypto"), D("coin-search", "crypto")];
  const rep = goneSuggestions({ gone: { replacement: "coin-search" }, defs, matches: overlap });
  ok(slugsOf(rep) === "coin-search,crypto-price", `a declared replacement leads, and the rest share its category (${slugsOf(rep)})`);
  ok(rep[0].route === "GET /api/coin-search" && rep[0].price === "$0.001" && Object.keys(rep[0]).sort().join() === "name,price,route,slug", "each suggestion carries slug, route, price and name");
  const noted = goneSuggestions({ gone: { replacement: null, note: "fred-series reads a series' observations; search-news answers a news search for any query." }, defs, matches: overlap });
  ok(slugsOf(noted) === "fred-series,search-news", `no replacement: only the live tools the note names, in its order, never a matched word (${slugsOf(noted)})`);
  ok(goneSuggestions({ gone: { replacement: null, note: "nothing-live-here reads it." }, defs, matches: overlap }).length === 0, "a note naming no live tool suggests nothing");
  ok(goneSuggestions({ gone: { replacement: null }, defs, matches: overlap }).length === 0, "no replacement and no note: nothing suggested by word overlap");
  const unknown = goneSuggestions({ gone: null, defs, matches: [D("uuid", "dev"), D("search", "search"), D("hash", "dev")] });
  ok(slugsOf(unknown) === "uuid,hash", `an unknown path falls back to matching, held to the best match's category (${slugsOf(unknown)})`);
  ok(goneSuggestions({ gone: null, defs, matches: [] }).length === 0, "no match, no suggestion");
  ok(goneSuggestions({ gone: { replacement: "coin-search" }, defs, matches: [D("coin-search", "crypto"), D("crypto-price", "crypto"), D("dex-volume-board", "crypto"), D("coin-search", "crypto")] }).length === 3, "at most three, the replacement once");
}

// A retired capability is not offered in prose either: code execution
// (code-run, code-run-pro, retired 2026-11-23) is named in no page module,
// tool text, README, wiki, docs or package README, except the changelog and
// the retirement registry that record its retirement.
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = (await import("node:url")).fileURLToPath(new URL("..", import.meta.url));
  const OFFER = /\bcode sandbox\b|\bcode[- ]execution sandbox\b|\brun (?:your )?(?:python|javascript|code) (?:in|on) a sandbox\b|\bsandboxed (?:python|code)\b/i;
  const SKIP = new Set(["src/changelog.js", "src/retired-tools.js", "CHANGELOG.md"]);
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(join(root, dir))) { const rel = `${dir}/${f}`; if (/node_modules|\/generated\//.test(rel)) continue; const st = statSync(join(root, rel)); if (st.isDirectory()) walk(rel); else if (/\.(js|md|json|txt)$/.test(f)) files.push(rel); } };
  for (const d of ["src", "wiki", "docs"]) walk(d);
  for (const f of ["README.md", "mcp/README.md", "client/README.md", "tollbooth/README.md", "openclaw/README.md"]) files.push(f);
  const offers = files.filter((f) => !SKIP.has(f)).filter((f) => { try { return OFFER.test(readTextSync(join(root, f), "utf8")); } catch { return false; } });
  ok(offers.length === 0, `no surface offers code execution after its retirement (${offers.join(", ") || "none"})`);
}

// A replacement answers the SAME question as the retired route; a tool that
// answers a neighboring one is no pointer. The 2026-11-16 and 2026-11-17
// retirements are pinned whole, so a pointer added back is a decision made here.
{
  const POINTERS_2026_11 = {
    geocode: null, "reverse-geocode": null, "place-search": null,
    "exa-search": "search", "exa-answer": "answer", "exa-contents": "extract",
    "defi-yields": null, "defi-yield-history": null, "defi-protocols": null, "defi-protocol": null, "defi-chains": null,
    "defi-chain-tvl-history": null, stablecoins: null, "stablecoin-supply-history": null, "defi-fees": null,
    "defi-dex-volume": null, "defi-tvl": null, "dex-top-pools": null, "l2-tvl": null, "options-volume": null, "crypto-orderbook": null,
  };
  const batch = Object.entries(RETIRED_TOOLS).filter(([, e]) => e.retiredAt === "2026-11-16" || e.retiredAt === "2026-11-17");
  const wrong = batch.filter(([slug, e]) => !(slug in POINTERS_2026_11) || e.replacement !== POINTERS_2026_11[slug]).map(([slug, e]) => `${slug} -> ${e.replacement}`);
  ok(batch.length === Object.keys(POINTERS_2026_11).length && wrong.length === 0, `the 21 routes retired on 2026-11-16 and 2026-11-17 name exactly the reviewed replacements (${wrong.join(", ") || "all match"})`);
  ok(["l2-tvl", "stablecoin-supply-history", "dex-top-pools", "reverse-geocode"].every((s) => RETIRED_TOOLS[s].replacement === null), "locked value by rollup, supply history, pools by locked value and reverse geocoding name no replacement: no live tool answers them");
  // geocode took a street address, which the place lookup answers found: false; the stablecoin list
  // ranked every peg by circulating supply per chain, which the USD depeg watch does not carry.
  ok(RETIRED_TOOLS.geocode.replacement === null && RETIRED_TOOLS.stablecoins.replacement === null, "street-address geocoding and the stablecoin supply ranking name no replacement");
  const named = batch.filter(([, e]) => e.replacement).map(([slug, e]) => `${slug} -> ${e.replacement}`).sort().join(", ");
  ok(named === "exa-answer -> answer, exa-contents -> extract, exa-search -> search", `three of the 21 name a replacement, eighteen none (${named})`);
  // The cross-chain DEX ranking over periods up to all time has no live
  // equal; the per-network 24h board is named in a note, never as the replacement.
  ok(RETIRED_TOOLS["defi-dex-volume"].replacement === null && /dex-volume-board/.test(RETIRED_TOOLS["defi-dex-volume"].note || "") && /every chain/.test(RETIRED_TOOLS["defi-dex-volume"].note || ""), "defi-dex-volume names no replacement, and its note says what the live board answers and what it does not");
  ok(Object.values(RETIRED_TOOLS).every((e) => e.note === undefined || (typeof e.note === "string" && e.note.length <= 240 && !/[<>]/.test(e.note))), "every note is one short plain-text sentence");
  ok(retiredEntryFor("/api/l2-tvl")?.replacement === null && !("Link" in retirementHeaders(RETIRED_TOOLS["l2-tvl"].retiredAt, null)), "such a route answers 410 with a Sunset date and no successor link");
}

// The 2026-11-23 retirement is pinned whole: a pointer added or dropped is a
// decision made here. Only a route whose question a live tool answers over a
// narrower range names one.
{
  const POINTERS_2026_11_23 = {
    "solana-rpc": null, "onchain-sql-week": "onchain-sql", "onchain-sql-range": "onchain-sql", "x-post-counts": null, "x-trends": null,
    "fc-cast-search": null, "fc-cast-metrics": null, "fc-channel-feed": null, "farcaster-profile": null, "fc-trending": null, "fc-user-casts": null,
    "fc-cast": null, "fc-cast-replies": null, "fc-channel": null, "fc-user-search": null, "farcaster-by-address": null,
    "options-summary": null, "crypto-options-chain": null, "options-ticker": null, "sol-swap-quote": null, "sol-token-lookup": null,
    "judge-vision": null, "judge-locate": null, "judge-long": null,
    "fred-release-calendar": null, "fred-search": null, "fred-series-info": null, "fred-release-observations": "fred-series",
    "crypto-news": null, "gravatar-check": null,
    // Code execution, retired the same day with no successor.
    "code-run": null, "code-run-pro": null,
  };
  const batch = Object.entries(RETIRED_TOOLS).filter(([, e]) => e.retiredAt === "2026-11-23");
  const wrong = batch.filter(([slug, e]) => !(slug in POINTERS_2026_11_23) || e.replacement !== POINTERS_2026_11_23[slug]).map(([slug, e]) => `${slug} -> ${e.replacement}`);
  ok(batch.length === 32 && Object.keys(POINTERS_2026_11_23).length === 32 && wrong.length === 0, `the 32 routes retired on 2026-11-23 name exactly the reviewed replacements (${batch.length}; ${wrong.join(", ") || "all match"})`);
  ok(/\/v1\/judge/.test(RETIRED_TOOLS["judge-long"].note || ""), "judge-long names no replacement (judge is listed only with a backend) and its note points to /v1/judge");
  ok(RETIRED_TOOLS["options-chain"].replacement === null, "options-chain no longer points at the retired crypto options chain");
}

// The boot guard is CALLED, against the real catalog, before any route is served.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/assertRetiredRegistryConsistent\(new Set\(Object\.values\(CATALOG\)\.map\(\(d\) => d\.slug\)\)\)/.test(src), "server.js runs the registry guard over the catalog's own slugs at boot");
  ok(src.indexOf("assertRetiredRegistryConsistent(new Set(") < src.indexOf("app.listen("), "...before the server listens");
}

// --- the retirement headers (RFC 8594 Sunset, Link rel="successor-version") ---
{
  const h = retirementHeaders("2026-09-20", "https://example.test/api/coin-search");
  ok(h.Sunset === "Sun, 20 Sep 2026 00:00:00 GMT", `Sunset is the retirement date as an HTTP-date (got ${h.Sunset})`);
  ok(h.Link === '<https://example.test/api/coin-search>; rel="successor-version"', `Link names the successor (got ${h.Link})`);
  const none = retirementHeaders("2026-09-20", null);
  ok(none.Sunset && !("Link" in none), "no replacement: Sunset only, never an invented successor");
  ok(!("Sunset" in retirementHeaders("not-a-date")), "a malformed date sets no Sunset rather than a wrong one");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(RETIRED_CONVERTERS_AT), "the converters carry a retirement date too");
}
// A Sunset already past is what reads as retired (a future one is only a notice).
const pastSunset = (r, date) => {
  const raw = r.headers.get("sunset");
  const t = Date.parse(raw || "");
  return Number.isFinite(t) && t < Date.now() && raw === new Date(`${date}T00:00:00Z`).toUTCString();
};
const successorOf = (r) => (/^<([^>]+)>; rel="successor-version"$/.exec(r.headers.get("link") || "") || [])[1] || null;

// --- path resolution ------------------------------------------------------------
ok(retiredEntryFor("/api/coins-list")?.replacement === "coin-search", "/api/<retired tool> resolves with its replacement");
ok(retiredEntryFor("/api/options-chain/anything?x=1")?.slug === "options-chain", "a trailing segment does not hide a retired route");
ok(retiredEntryFor("/api/skill/market-open")?.kind === "pack", "/api/skill/<retired pack> resolves as a pack");
ok(retiredEntryFor("/api/skill/options-chain") === null, "a tool slug under /api/skill/ is not a retired pack");
ok(retiredEntryFor("/api/market-open") === null, "a pack slug under /api/ is not a retired tool");
ok(retiredEntryFor("/api/nope-nope") === null && retiredEntryFor("/v1/options-chain") === null, "unknown and off-prefix paths resolve to nothing");
// A retired route outside /api is matched on its whole path (the /v1 judge previews).
ok(retiredEntryFor("/v1/judge/vision")?.slug === "judge-vision" && retiredEntryFor("/V1/Judge/Locate/")?.slug === "judge-locate" && retiredEntryFor("/v1/judge/long?x=1")?.slug === "judge-long", "a retired /v1 route resolves by its whole path, case and a trailing slash aside");
{
  // A long run of interior slashes is read in linear time (no end-anchored regex backtracking).
  const hostile = `/v1${"/".repeat(100000)}x`;
  const t0 = process.hrtime.bigint();
  const got = retiredEntryFor(hostile);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(got === null && ms < 200, `a path with 100k interior slashes resolves fast (${ms.toFixed(1)} ms)`);
  ok(retiredEntryFor(`/v1/judge/vision${"/".repeat(50000)}`)?.slug === "judge-vision", "a long trailing-slash run still resolves the retired route");
}
ok(retiredEntryFor("/v1/judge") === null && retiredEntryFor("/v1/judge/visionary") === null && retiredEntryFor("/v1/judge/vision/x") === null, "control: the live /v1/judge and other /v1 paths resolve to nothing");
ok(retiredEntryForSlug("judge-vision")?.route === "/v1/judge/vision" && retiredEntryForSlug("solana-rpc")?.route === "/api/solana-rpc", "a retired /v1 slug carries its own route; an /api one its /api route");

// --- slug resolution (the MCP connector's catalog.call takes slugs) --------------
ok(retiredEntryForSlug("workday-count")?.route === "/api/workday-count" && retiredEntryForSlug("workday-count")?.replacement === "business-days", "a retired tool slug resolves to its route and replacement");
ok(retiredEntryForSlug("skill-a11y-audit")?.route === "/api/skill/a11y-audit" && retiredEntryForSlug("skill-a11y-audit")?.kind === "pack", "skill-<pack> resolves as a retired pack");
ok(retiredEntryForSlug("color-palette")?.kind === "tool" && retiredEntryForSlug("skill-color-palette")?.kind === "pack", "a slug retired as both tool and pack reads by its form");
ok(retiredEntryForSlug("business-days") === null && retiredEntryForSlug("skill-company-dossier") === null && retiredEntryForSlug("../x") === null && retiredEntryForSlug("") === null, "live, malformed and empty slugs resolve to nothing");

// --- no surface we control advertises a retired route -----------------------------
// Old catalog copies keep calling retired routes, so every listing we publish
// (machine surfaces on the wire below, the docs trees and package manifests
// here) must carry only live ones. A mention in the retirement registry, the
// published-routes snapshot, a changelog or a test is history, not an offer.
const RETIRED_ROUTE_PATTERNS = [
  ...Object.keys(RETIRED_TOOLS).map((s) => [`/api/${s}`, new RegExp(`/api/${s}(?![a-z0-9-])`)]),
  ...Object.keys(RETIRED_PACKS).map((s) => [`/api/skill/${s}`, new RegExp(`(?:/api/skill/|/skills/|/api/skill-packs/)${s}(?![a-z0-9-])|["'\`]skill-${s}["'\`]`)]),
  ["/api/convert/<a>-to-<b>", /\/api\/convert[-/][a-z0-9]+(?:-[a-z0-9]+)*-to-[a-z0-9-]+/],
];
const advertisedRetired = (text) => RETIRED_ROUTE_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
ok(advertisedRetired('see "/api/workday-count" and /api/skill/savings-goal, slug "skill-a11y-audit", /api/convert/feet-to-meters').length === 4, "control: the scan finds planted retired tool, pack, pack-slug and converter routes");
ok(advertisedRetired("/api/business-days /api/skill/company-dossier /api/unit-convert /api/color /api/workday-counts").length === 0, "control: live routes and longer slugs are not retired routes");
{
  const tracked = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter(Boolean);
  const advertised = tracked.filter((f) => /^(wiki|docs|adapters|examples|client|mcp|openclaw|tollbooth|\.claude-plugin|\.codex-plugin|\.cursor-plugin)\/|^(README\.md|glama\.json|server\.json|llms-install\.md)$/.test(f))
    .filter((f) => !/(^|\/)CHANGELOG\.md$|(^|\/)test[^/]*\.(m?js|py)$|\.(png|jpe?g|gif|ico|webp|woff2?|lock)$|package-lock\.json$/.test(f));
  const found = [];
  for (const f of advertised) {
    let text; try { text = readTextSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { continue; }
    for (const name of advertisedRetired(text)) found.push(`${f}: ${name}`);
  }
  ok(advertised.length >= 50, `the docs trees and manifests are read (${advertised.length} files)`);
  ok(found.length === 0, `no doc, package or manifest advertises a retired route (found: ${found.join(", ") || "none"})`);
}

// --- no doc or pack names a retired tool as one to call ---------------------------
// The scan above reads routes (/api/<slug>). A tool is also offered by its bare
// slug: a code-quoted name in a README, the wiki catalog or the listing copy,
// or a step of a pack's workflow prose ("resolve each stop with geocode"). A
// retired slug restored there sends a reader to a 410.
//   - A hyphenated slug is no English word: it is matched as a whole word
//     (never inside a longer slug, never as a route, which the scan above reads).
//   - A one-word slug is also a word a sentence may use ("use place-lookup to
//     geocode a city", "paid in stablecoins"), so it is matched only where it
//     is used AS A TOOL NAME: quoted as code or as a string, "the <slug> tool"
//     (or route, endpoint, API), or after a verb of calling ("call geocode").
//   - A one-word slug that is not an everyday noun is also matched as the
//     object of "with", "via" or "using" and as an item of a slug list. The
//     nouns (ORDINARY_WORDS: a thing a sentence is about with, via or using,
//     or lists) are read in the tool-name forms above only.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (slug) => new RegExp(`(?<![a-z0-9/-])${escRe(slug)}(?![a-z0-9-])`);
{
  const ORDINARY_WORDS = new Set(["market", "stablecoins", "soundex", "combinatorics", "pbkdf2"]);
  const oneWord = Object.keys(RETIRED_TOOLS).filter((slug) => !slug.includes("-"));
  ok([...ORDINARY_WORDS].every((w) => oneWord.includes(w)), "every allowlisted ordinary word is a one-word retired slug");
  ok(oneWord.join() === "market,geocode,stablecoins,combinatorics,pbkdf2,soundex", `each one-word retired slug has been read against the ordinary-word list (${oneWord.join()}): a new one is added to this line, and to ORDINARY_WORDS when it is an everyday noun`);
  const asToolName = (slug) => {
    const w = escRe(slug), end = "(?![a-z0-9-])", start = "(?<![a-z0-9/-])";
    const forms = [
      `[\`"']${w}\\\\?[\`"']`,                                                    // code or string quoted
      `${start}${w}\\s+(?:tool|route|endpoint|API)\\b`,                            // "the geocode tool"
      `\\b(?:[Cc]all|[Cc]alls|[Cc]alling|[Rr]un|[Rr]uns|[Rr]unning|[Ii]nvoke|[Ii]nvokes|[Ii]nvoking)\\s+${w}${end}`, // "call geocode"
    ];
    if (!ORDINARY_WORDS.has(slug)) {
      forms.push(`\\b(?:[Ww]ith|[Vv]ia|[Uu]sing)\\s+${w}${end}`);                  // "resolve it with geocode"
      forms.push(`(?:[,|]\\s*|^\\s*[-*]\\s+)${w}(?=\\s*(?:[,|]|$))`);              // an item of a slug list
    }
    return new RegExp(forms.join("|"), "m");
  };
  const NAMED = Object.keys(RETIRED_TOOLS).map((slug) => [slug, slug.includes("-") ? wholeWord(slug) : asToolName(slug)]);
  const namedRetired = (text) => NAMED.filter(([, re]) => re.test(text)).map(([slug]) => slug);
  const planted = "| `defi-yields`, `stablecoins` | then call reverse-geocode with the lat/lon, or l2-tvl; resolve the address with geocode, then hash with `pbkdf2`.";
  ok(namedRetired(planted).join() === "geocode,reverse-geocode,defi-yields,stablecoins,l2-tvl,pbkdf2", `control: a code-quoted slug, a bare hyphenated one and a bare one-word one are found (${namedRetired(planted).join()})`);
  ok(namedRetired("paid in stablecoins by supply; geocoded addresses, a geocoder; `defi-yields-v2`, crypto-orderbook-depth, /api/defi-yields, /api/geocode, skill-defi-yields-watch, reverse-geocoding").length === 0, "control: an allowlisted ordinary word, a longer word or slug and a route (read by the scan above) are not bare retired names");
  // The same word as a verb or a noun of a sentence is not a tool name.
  const PROSE = [
    "Use place-lookup to geocode a city.", "Geocode the address, then forecast.", "It will geocode each stop first.", "geocode a city with `place-lookup`",
    "Settle with stablecoins on any chain.", "USDC, stablecoins, and cards are accepted.", "Match names using soundex or metaphone.", "- combinatorics", "Keys are stretched with pbkdf2, then compared.", "permutations, combinatorics, and primes",
  ];
  const tripped = PROSE.filter((line) => namedRetired(line).length);
  ok(tripped.length === 0, `control: a one-word slug used as an ordinary verb or noun is not a tool name (tripped: ${tripped.join(" / ") || "none"})`);
  // Each way of naming a tool is found, for the verb-like slug and for a noun.
  const AS_TOOL = [
    ["Call `geocode` with the address.", "geocode"], ["| `geocode` | Address to coordinates |", "geocode"], ['tools: ["geocode", "weather-current"]', "geocode"], ['{"workflow":"run \\"geocode\\" first"}', "geocode"],
    ["Use the geocode tool for addresses.", "geocode"], ["the geocode endpoint answers in JSON", "geocode"], ["First call geocode, then forecast.", "geocode"], ["Resolve each stop with geocode, then forecast.", "geocode"],
    ["weather-current, geocode, place-lookup", "geocode"], ["- geocode", "geocode"], ["resolve it via geocode.", "geocode"],
    ["the `stablecoins` board", "stablecoins"], ["Use the stablecoins tool.", "stablecoins"], ["then call soundex on each name", "soundex"], ["the combinatorics route", "combinatorics"], ['"pbkdf2"', "pbkdf2"],
  ];
  const missed = AS_TOOL.filter(([line, slug]) => namedRetired(line).join() !== slug).map(([line]) => line);
  ok(missed.length === 0, `control: a retired slug used as a tool name is found in each form (missed: ${missed.join(" / ") || "none"})`);
  const tracked = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n")
    .filter((f) => /^(README\.md|llms-install\.md)$|^(wiki|docs)\/.*\.(md|txt)$|^(mcp|client|tollbooth|openclaw|adapters|examples|facilitator)\/(.*\/)?README\.md$/.test(f) && !/(^|\/)CHANGELOG\.md$/.test(f));
  const found = [];
  for (const f of tracked) for (const slug of namedRetired(readTextSync(new URL(`../${f}`, import.meta.url), "utf8"))) found.push(`${f}: ${slug}`);
  const must = ["README.md", "mcp/README.md", "client/README.md", "tollbooth/README.md", "wiki/Tool-Catalog.md", "docs/ecosystem-listings.md", "llms-install.md"];
  ok(must.every((f) => tracked.includes(f)) && tracked.length >= 30, `the README, each package README, the wiki and the listing copy are read (${tracked.length} files; missing: ${must.filter((f) => !tracked.includes(f)).join(", ") || "none"})`);
  ok(found.length === 0, `no doc names a retired tool by its slug (found: ${found.join(", ") || "none"})`);
  const { SKILL_PACKS } = await import("../src/skills.js");
  const inPacks = [];
  const proseOf = (pack) => JSON.stringify({ ...pack, slug: undefined, toolSlugs: undefined });
  for (const pack of SKILL_PACKS) {
    for (const slug of pack.toolSlugs || []) if (Object.hasOwn(RETIRED_TOOLS, slug)) inPacks.push(`${pack.slug}: step ${slug}`);
    for (const slug of namedRetired(proseOf(pack))) inPacks.push(`${pack.slug}: prose names ${slug}`);
  }
  ok(namedRetired(proseOf({ slug: "skill-x", toolSlugs: ["geocode"], workflow: "Resolve each stop with geocode, then forecast." })).join() === "geocode", "control: a pack's workflow that names a one-word retired tool is found");
  ok(SKILL_PACKS.length > 0 && inPacks.length === 0, `no pack runs or names a retired tool in its steps, workflow or prompt (found: ${inPacks.join(", ") || "none"}; ${SKILL_PACKS.length} packs)`);
}

// --- the changelog's retirement sentences say what the registry says ----------------
// A changelog item that announces retirements names, for each route, the
// replacement its 410 carries, or says it names none. The sentence forms read:
//   "<slug> names <replacement> as the replacement"      "<slug> (<replacement>)"
//   "<a>, <b> and <c> are retired and answer 410 naming <x>, <y> and <z>."  (in order)
//   "<a> and <b> name none"                              "name none: <a>, <b> and <c>."
//   "<a>, <b> and <c> are retired and answer 410, and name none"
// and the counts a sentence states in words ("Fifteen routes are retired", "Two
// name a replacement", "The other thirteen name none"). Each is held to
// src/retired-tools.js, for every route retired on or after 2026-11-16.
{
  const NUMBER = Object.fromEntries("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ").map((w, k) => [w, k + 1]));
  const LIST = "(?:[a-z0-9-]+(?:, | and ))*[a-z0-9-]+";
  const listOf = (x) => x.split(/, | and /);
  const problemsIn = (text, registry) => {
    const problems = [];
    const mentioned = Object.keys(registry).filter((slug) => wholeWord(slug).test(text));
    const pairs = new Map(), none = new Set();
    for (const m of text.matchAll(/([a-z0-9-]+) names ([a-z0-9-]+) as the replacement/g)) pairs.set(m[1], m[2]);
    for (const m of text.matchAll(/([a-z0-9-]+) \(([a-z0-9-]+)\)/g)) pairs.set(m[1], m[2]);
    for (const m of text.matchAll(new RegExp(`(${LIST}) are retired and answer 410 naming (${LIST})\\.`, "g"))) {
      const from = listOf(m[1]), to = listOf(m[2]);
      if (from.length !== to.length) problems.push(`"${m[0].slice(0, 60)}" lists ${from.length} routes and ${to.length} replacements`);
      else from.forEach((slug, k) => pairs.set(slug, to[k]));
    }
    for (const m of text.matchAll(new RegExp(`(${LIST}) names? none`, "g"))) for (const slug of listOf(m[1])) none.add(slug);
    for (const m of text.matchAll(new RegExp(`names? none: (${LIST})\\.`, "g"))) for (const slug of listOf(m[1])) none.add(slug);
    for (const m of text.matchAll(new RegExp(`(${LIST}) are retired and answer 410,? and name none`, "g"))) for (const slug of listOf(m[1])) none.add(slug);
    for (const slug of mentioned) {
      const want = registry[slug].replacement;
      if (want && pairs.get(slug) !== want) problems.push(`${slug}: the registry names ${want}, the sentence ${pairs.get(slug) ?? "none"}`);
      if (want && none.has(slug)) problems.push(`${slug}: listed as naming none, the registry names ${want}`);
      if (!want && pairs.has(slug)) problems.push(`${slug}: the registry names no replacement, the sentence ${pairs.get(slug)}`);
      if (!want && !none.has(slug)) problems.push(`${slug}: the registry names no replacement and the sentence does not say so`);
    }
    const count = (re, actual, what) => { const m = re.exec(text); if (m && NUMBER[m[1].toLowerCase()] !== undefined && NUMBER[m[1].toLowerCase()] !== actual) problems.push(`"${m[0]}" but ${actual} ${what}`); };
    count(/\b([A-Za-z]+) routes are retired/, mentioned.length, "are named");
    count(/\b([A-Za-z]+) names? a replacement/, mentioned.filter((slug) => registry[slug].replacement).length, "do");
    count(/other ([a-z]+) name none/, mentioned.filter((slug) => !registry[slug].replacement).length, "do");
    return { mentioned, problems };
  };
  const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
  const SINCE = "2026-11-16";
  const items = CHANGELOG_ENTRIES.filter((entry) => entry.date >= SINCE).flatMap((entry) => entry.items).filter((item) => /\bretired and answer 410\b/.test(item));
  const covered = new Set(), problems = [];
  for (const item of items) { const r = problemsIn(item, RETIRED_TOOLS); r.mentioned.forEach((slug) => covered.add(slug)); problems.push(...r.problems); }
  const due = Object.entries(RETIRED_TOOLS).filter(([, e]) => e.retiredAt >= SINCE);
  const unsaid = due.filter(([slug]) => !covered.has(slug)).map(([slug]) => slug);
  const pointers = due.filter(([, e]) => e.replacement).length;
  ok(items.length >= 2 && problems.length === 0, `each changelog retirement sentence matches the registry (${problems.join("; ") || `${items.length} items`})`);
  ok(unsaid.length === 0, `every route retired since ${SINCE} is announced in a changelog retirement sentence (missing: ${unsaid.join(", ") || "none"})`);
  ok(due.length === 55 && pointers === 8 && due.length - pointers === 47, `those sentences cover ${due.length} routes: ${pointers} with a replacement, ${due.length - pointers} with none`);
  // Controls: each way a sentence can part from the registry is reported.
  const REG = { geocode: { replacement: "place-lookup" }, "reverse-geocode": { replacement: null }, "place-search": { replacement: null }, "exa-search": { replacement: "search" }, "exa-answer": { replacement: "answer" } };
  const good = "geocode, reverse-geocode and place-search are retired and answer 410: geocode names place-lookup as the replacement, and reverse-geocode and place-search name none. exa-search and exa-answer are retired and answer 410 naming search and answer.";
  ok(problemsIn(good, REG).problems.length === 0 && problemsIn(good, REG).mentioned.length === 5, "control: sentences that match the registry report nothing");
  const bad = (text, re, what) => { const p = problemsIn(text, REG).problems; ok(p.length > 0 && p.some((x) => re.test(x)), `control: ${what} is reported (${p.join("; ").slice(0, 110) || "nothing"})`); };
  bad(good.replace("names place-lookup", "names geo-lookup"), /geocode: the registry names place-lookup, the sentence geo-lookup/, "a wrong replacement");
  bad(good.replace("naming search and answer", "naming answer and search"), /exa-search: the registry names search, the sentence answer/, "replacements listed out of order");
  bad(good.replace("and reverse-geocode and place-search name none", "and reverse-geocode names place-lookup as the replacement"), /reverse-geocode: the registry names no replacement, the sentence place-lookup/, "a pointer the registry does not carry");
  bad(good.replace("geocode names place-lookup as the replacement, and reverse-geocode and place-search name none", "geocode, reverse-geocode and place-search name none"), /geocode: listed as naming none/, "a route with a replacement listed as naming none");
  bad("geocode (place-lookup) is retired; reverse-geocode is retired too.", /reverse-geocode: the registry names no replacement and the sentence does not say so/, "a route whose missing replacement goes unsaid");
  bad("Four routes are retired and answer 410. One names a replacement: geocode (place-lookup). The other two name none: reverse-geocode and place-search.", /"Four routes are retired" but 3 are named/, "a count that does not match the routes named");
  bad("Three routes are retired. geocode (place-lookup). The other three name none: reverse-geocode and place-search.", /"other three name none" but 2 do/, "a none-count that does not match");
  bad("exa-search and exa-answer are retired and answer 410 naming search.", /lists 2 routes and 1 replacements/, "a replacement list shorter than the routes");
  ok(problemsIn("reverse-geocode and place-search are retired and answer 410, and name none: nothing live answers them.", REG).problems.length === 0, "control: routes retired with no replacement in one sentence report nothing");
  bad("geocode, reverse-geocode and place-search are retired and answer 410, and name none.", /geocode: listed as naming none/, "a route with a replacement swept into such a sentence");
  bad("Two name a replacement: geocode (place-lookup). reverse-geocode and place-search name none.", /"Two name a replacement" but 1 do/, "a pointer count that does not match");
}

// --- the published-routes snapshot rule (scripts/published-slugs.js) --------------
// Drive the accounting with planted cases first, so a clean run below means
// something: a published route that is neither live nor retired is reported,
// and a live route missing from the snapshot is reported.
{
  const snap = { tools: new Set(["alive", "gated", "gone-listed", "gone-forgotten"]), packs: new Set(["pack-alive", "pack-forgotten"]) };
  const r = accountFor({
    snapshot: snap,
    live: { tools: new Set(["alive", "brand-new"]), packs: new Set(["pack-alive"]) },
    gated: { tools: new Set(["gated"]), packs: new Set() },
    retiredTools: { "gone-listed": { retiredAt: "2026-01-01", replacement: null } },
    retiredPacks: {},
  });
  ok(r.unaccounted.join() === "pack pack-forgotten,tool gone-forgotten", `control: a forgotten retirement is reported (got ${r.unaccounted.join()})`);
  ok(r.missingFromSnapshot.join() === "tool brand-new", `control: a live route missing from the snapshot is reported (got ${r.missingFromSnapshot.join()})`);
  const segs = segmentsOf(["POST /api/memory/incr", "/api/skill/company-dossier", "/api/convert-km-to-miles", "/api/convert/km-to-miles", "/v1/judge"]);
  ok([...segs.tools].join() === "memory" && [...segs.packs].join() === "company-dossier", "route segments: first /api segment, packs apart, converters and /v1 excluded");
}
const snapshot = loadSnapshot();
ok(snapshot.tools.size >= 500 && snapshot.packs.size >= 100, `the snapshot is populated (${snapshot.tools.size} tools, ${snapshot.packs.size} packs)`);
// A retired route outside /api (its own `route`, the /v1 judge previews) is
// not an /api segment, so the snapshot does not carry it.
for (const slug of Object.keys(RETIRED_TOOLS).filter((s) => !RETIRED_TOOLS[s].route)) ok(snapshot.tools.has(slug), `retired tool ${slug} is in the snapshot`);
ok(Object.keys(RETIRED_TOOLS).filter((s) => RETIRED_TOOLS[s].route).every((s) => !snapshot.tools.has(s) && /^\/v1\//.test(RETIRED_TOOLS[s].route)), "a retired /v1 route is outside the /api snapshot");
for (const slug of [...Object.keys(RETIRED_PACKS)]) ok(snapshot.packs.has(slug), `retired pack ${slug} is in the snapshot`);
const gated = await envGatedSegments();

// --- the wire, on a free boot ------------------------------------------------------
const booting = bootServer({ stores: false, timeoutMs: 90_000, env: { FREE_MODE: "true", BASE_URL: "http://agent402.test", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", KALSHI_TOOLS: "" } })
  .catch((e) => { console.error(e.message); return null; });
let base = "";
try {
  const srv = await booting;
  proc = srv?.child ?? null;
  base = srv?.url ?? "";
  ok(Boolean(srv), "server booted (the boot guard accepted the registry against the real catalog)");
  // Every machine surface and listing page we serve names live routes only.
  {
    const found = [];
    for (const p of ["/openapi.json", "/llms.txt", "/llms-full.txt", "/.well-known/x402", "/api/pricing", "/api/index", "/sitemap.xml", "/api/skill-packs.json", "/skills", "/tools", "/.well-known/agent.json", "/.well-known/glama.json", "/robots.txt"]) {
      const r = await fetch(`${base}${p}`);
      if (r.status !== 200) { found.push(`${p} answered ${r.status}`); continue; }
      // A robots Disallow line keeps crawlers off a path; it offers nothing
      // (Disallow: /api/market/ covers the live chain panels, not a retired tool).
      let text = await r.text();
      if (p === "/robots.txt") text = text.split("\n").filter((l) => !/^\s*Disallow:/i.test(l)).join("\n");
      for (const name of advertisedRetired(text)) found.push(`${p}: ${name}`);
    }
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const mcpText = await mcp.text();
    ok(mcp.status === 200 && /catalog\.call/.test(mcpText), `the MCP tool list is read (${mcp.status})`);
    for (const name of advertisedRetired(mcpText)) found.push(`mcp tools/list: ${name}`);
    let slugsRead = 0;
    for (const q of ["workday count", "color contrast", "savings goal", "polymarket", "pyth price"]) {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "catalog.search", arguments: { query: q } } }) });
      const t = await r.text();
      for (const name of advertisedRetired(t)) found.push(`mcp catalog.search "${q}": ${name}`);
      const slugs = [...t.matchAll(/\\?"slug\\?":\s*\\?"([a-z0-9-]+)/g)].map((m) => m[1]);
      slugsRead += slugs.length;
      for (const slug of slugs) if (retiredEntryForSlug(slug)) found.push(`mcp catalog.search "${q}": slug ${slug}`);
    }
    ok(slugsRead >= 5, `catalog.search answers are read slug by slug (${slugsRead} slugs)`);
    ok(found.length === 0, `no served surface or MCP listing advertises a retired route (found: ${found.join(", ") || "none"})`);
    const mc = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "catalog.call", arguments: { slug: "skill-checksum-suite", params: {} } } }) });
    const mct = await mc.text();
    ok(/Skill pack checksum-suite was retired on 2026-07-06/.test(mct) && /Use slug checksum instead/.test(mct), `catalog.call on a retired pack slug names the retirement and the replacement (got ${mct.slice(0, 140)})`);
  }
  {
    // A route that names no replacement but carries a note: the 410's hint,
    // the tool page and catalog.call all state it, and no successor is linked.
    const r = await fetch(`${base}/api/defi-dex-volume`);
    const b = await r.json();
    ok(r.status === 410 && b.replacement === null && b.hint.includes(RETIRED_TOOLS["defi-dex-volume"].note) && successorOf(r) === null, `GET /api/defi-dex-volume is 410 with no replacement and the note in its hint (got ${r.status} ${String(b.hint).slice(0, 160)})`);
    const page = await fetch(`${base}/tools/defi-dex-volume`);
    const html = await page.text();
    ok(page.status === 410 && html.includes("nothing live ranks DEXes across every chain"), `the tool page states the note (got ${page.status})`);
    const mc = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "catalog.call", arguments: { slug: "defi-dex-volume", params: {} } } }) });
    const mct = await mc.text();
    ok(/no direct replacement/.test(mct) && /nothing live ranks DEXes across every chain/.test(mct), `catalog.call states the note (got ${mct.slice(0, 200)})`);
  }
  const get = await fetch(`${base}/api/coins-list`);
  const gb = await get.json();
  ok(get.status === 410 && gb.error === "gone" && gb.slug === "coins-list", `GET /api/coins-list is 410 gone (got ${get.status} ${JSON.stringify(gb).slice(0, 80)})`);
  ok(gb.replacement?.slug === "coin-search" && /^GET \/api\/coin-search$/.test(gb.replacement?.route || "") && gb.replacement?.url === "http://agent402.test/api/coin-search", "...naming the live replacement's slug, route and url");
  ok(gb.retiredAt === "2026-11-21" && /retired on 2026-11-21/.test(gb.hint) && /coin-search/.test(gb.hint), "...with the date and the replacement in the hint");
  ok(Array.isArray(gb.suggestions) && typeof gb.find === "string", "...and the same find + suggestions the 404 carries");
  {
    // Suggestions by meaning on the wire: the declared replacement first, the
    // rest in its category; a note's live tools only; an unknown path held to
    // one category.
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const catOf = new Map((pricing.endpoints || []).map((e) => [e.slug, e.category]));
    ok(gb.suggestions[0]?.slug === "coin-search" && gb.suggestions.every((s) => catOf.get(s.slug) === catOf.get("coin-search")), `the coins-list 410 suggests coin-search first, the rest in its category (${gb.suggestions.map((s) => s.slug).join(",")})`);
    const fr = await (await fetch(`${base}/api/fred-search`)).json();
    ok(fr.suggestions.map((s) => s.slug).join() === "fred-series" && /no direct replacement/.test(fr.hint), `the fred-search 410 suggests only the tool its note names (${fr.suggestions.map((s) => s.slug).join(",")})`);
    const xt = await (await fetch(`${base}/api/x-trends`)).json();
    ok(xt.suggestions.length === 0 && !/closest live tools are listed/.test(xt.hint) && /api\/find/.test(xt.hint), `a 410 with no replacement and no note suggests nothing by word overlap (${xt.suggestions.map((s) => s.slug).join(",")})`);
    const un = await fetch(`${base}/api/uuid-v99-generator-thing`);
    const ub = await un.json();
    ok(un.status === 404 && ub.suggestions.length > 0 && new Set(ub.suggestions.map((s) => catOf.get(s.slug))).size === 1, `an unknown path's suggestions share one category (${ub.suggestions.map((s) => `${s.slug}:${catOf.get(s.slug)}`).join(",")})`);
  }
  ok(pastSunset(get, "2026-11-21"), `...with a past Sunset header on the retirement date (got ${get.headers.get("sunset")})`);
  ok(successorOf(get) === "http://agent402.test/api/coin-search", `...and Link rel="successor-version" to the replacement (got ${get.headers.get("link")})`);
  {
    // The 2026-11-23 retirement on the wire: an /api route naming its
    // replacement, one naming none, and the /v1 judge previews, each 410.
    const w = await fetch(`${base}/api/onchain-sql-week`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const wb = await w.json();
    ok(w.status === 410 && wb.replacement?.slug === "onchain-sql" && successorOf(w) === "http://agent402.test/api/onchain-sql", `POST /api/onchain-sql-week is 410 naming onchain-sql (got ${w.status} ${JSON.stringify(wb.replacement)})`);
    const f = await fetch(`${base}/api/fc-cast`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(f.status === 410 && (await f.json()).replacement === null && f.headers.get("link") === null, `POST /api/fc-cast is 410 naming none (got ${f.status})`);
    for (const path of ["/v1/judge/vision", "/v1/judge/locate", "/v1/judge/long"]) {
      const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const b = await r.json();
      ok(r.status === 410 && b.error === "gone" && b.retiredAt === "2026-11-23" && pastSunset(r, "2026-11-23"), `POST ${path} is 410 gone with its Sunset (got ${r.status} ${JSON.stringify(b).slice(0, 100)})`);
    }
    const lb = await (await fetch(`${base}/v1/judge/long`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    ok(lb.hint.includes(RETIRED_TOOLS["judge-long"].note), `the judge-long 410 carries its note (got ${String(lb.hint).slice(0, 160)})`);
    const v1miss = await fetch(`${base}/v1/judge/visionary`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(v1miss.status !== 410, `control: a /v1 path that was never published is not a retirement (got ${v1miss.status})`);
  }
  const post = await fetch(`${base}/api/options-chain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "AAPL" }) });
  ok(post.status === 410, `POST on a retired route is 410 too (got ${post.status})`);
  // The 2026-09-22 explorer-data retirement: every one answers 410, never a
  // 404 and never a 402 (a retired route must not quote a price it cannot serve).
  for (const [slug, repl] of [["contract-inspect", "contract-source"], ["address-profile", "wallet-balance"], ["token-info", "token-metadata"], ["token-holders", null], ["tx-inspect", "tx-receipt"]]) {
    const r = await fetch(`${base}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json();
    ok(r.status === 410 && b.slug === slug && b.retiredAt === "2026-09-22" && (repl ? b.replacement?.slug === repl : b.replacement === null),
      `POST /api/${slug} is 410 naming ${repl || "no replacement"} (got ${r.status} ${JSON.stringify(b.replacement)})`);
  }
  {
    // The market tick read (published as GET /api/market/tick) is retired:
    // its path answers 410 naming crypto-price, never the generic 404.
    const r = await fetch(`${base}/api/market/tick?symbols=BTC`);
    const b = await r.json();
    ok(r.status === 410 && b.slug === "market" && b.retiredAt === "2026-11-22" && b.replacement?.slug === "crypto-price" && /retired on 2026-11-22/.test(b.hint),
      `GET /api/market/tick is 410 naming crypto-price (got ${r.status} ${JSON.stringify(b.replacement)})`);
    // Control: the live chain panel under the same segment is still served.
    const panel = await fetch(`${base}/api/market/base/panel`);
    ok(panel.status !== 410 && panel.status !== 404, `GET /api/market/base/panel is still served (got ${panel.status})`);
  }
  const none = await fetch(`${base}/api/stock-dividends`);
  const nb = await none.json();
  ok(none.status === 410 && nb.replacement === null && /no direct replacement/.test(nb.hint), "a retirement with no replacement says so instead of inventing one");
  ok(pastSunset(none, RETIRED_TOOLS["stock-dividends"].retiredAt) && none.headers.get("link") === null, "...with a Sunset header and no successor Link");
  const pack = await fetch(`${base}/api/skill/market-open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const pb = await pack.json();
  ok(pack.status === 410 && pb.slug === "market-open" && /Skill pack market-open was retired/.test(pb.hint), `a retired skill pack is 410 (got ${pack.status})`);
  // The retired tool's and pack's PAGES answer 410 too, with the same headers,
  // the date and the replacement's page; a slug that never existed stays 404.
  {
    const page = await fetch(`${base}/tools/coins-list`);
    const html = await page.text();
    ok(page.status === 410 && /text\/html/.test(page.headers.get("content-type") || ""), `a retired tool's page is 410 (got ${page.status})`);
    ok(pastSunset(page, RETIRED_TOOLS["coins-list"].retiredAt) && /\/tools\/coin-search>; rel="successor-version"/.test(page.headers.get("link") || ""), `...with Sunset and a successor Link to the replacement's page (${page.headers.get("link")})`);
    ok(html.includes(RETIRED_TOOLS["coins-list"].retiredAt) && html.includes('href="/tools/coin-search"') && /noindex/.test(html), "the page names the retirement date, links the replacement and is not indexed");
    // The date is in the page's own sentence, not only in its meta description.
    ok(html.includes(`<code>coins-list</code> was retired on ${RETIRED_TOOLS["coins-list"].retiredAt}.`), "the page body says the slug was retired on that date");
    ok((await fetch(`${base}/tools/coin-search`)).status === 200, "control: the replacement's page is served");
    const noRep = await fetch(`${base}/tools/stock-dividends`);
    ok(noRep.status === 410 && !/successor-version/.test(noRep.headers.get("link") || "") && (await noRep.text()).includes('href="/tools"'), "a retired tool with no replacement: 410, no successor, a link to the catalog");
    const packPage = await fetch(`${base}/skills/market-open`);
    ok(packPage.status === 410 && /Skill pack retired/.test(await packPage.text()), `a retired skill pack's page is 410 (got ${packPage.status})`);
    const packTool = await fetch(`${base}/tools/skill-market-open`);
    ok(packTool.status === 410, `a retired pack's catalog page is 410 (got ${packTool.status})`);
    for (const p of ["/tools/nope-nope", "/skills/nope-nope"]) ok((await fetch(`${base}${p}`)).status === 404, `control: ${p} never existed and is still 404`);
    const pagesBad = [];
    for (const slug of Object.keys(RETIRED_TOOLS)) { const r = await fetch(`${base}/tools/${slug}`); if (r.status !== 410) pagesBad.push(`${slug}:${r.status}`); }
    ok(pagesBad.length === 0, `every retired tool's page answers 410 (${pagesBad.join(", ") || "all"})`);
  }
  const unknown = await fetch(`${base}/api/nope-nope`);
  ok(unknown.status === 404 && (await unknown.json()).error === "not-found", "a guessed slug that was never a tool is still 404");
  // Routing is case-insensitive, so is the machine-surface test: an uppercase
  // /V1 or /API miss is the same JSON 404, never the HTML shell.
  for (const p of ["/V1/nothing-here", "/API/NOPE-NOPE", "/Mcp/x"]) {
    const r = await fetch(`${base}${p}`);
    const ct = r.headers.get("content-type") || "";
    ok(r.status === 404 && /application\/json/.test(ct) && (await r.json()).error === "not-found", `${p} is a JSON 404 (${r.status}, ${ct})`);
  }
  const liveRoute = await fetch(`${base}/api/coin-search?q=bitcoin`);
  ok(liveRoute.status !== 410 && liveRoute.status !== 404, `the replacement itself is served (got ${liveRoute.status})`);
  // Every route ever published is live, key-gated, or retired - and every
  // retired one answers 410 on the wire, never the guessed-slug 404.
  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const live = segmentsOf((pricing.endpoints || []).map((e) => e.path));
  ok(live.tools.size >= 100, `the booted catalog is read (${live.tools.size} tool segments, ${live.packs.size} packs)`);
  const acct = accountFor({ snapshot, live, gated });
  ok(acct.unaccounted.length === 0, `every published route is live, key-gated or retired (unaccounted: ${acct.unaccounted.join(", ") || "none"}; add each to src/retired-tools.js)`);
  ok(acct.missingFromSnapshot.length === 0, `every live route is in the snapshot (missing: ${acct.missingFromSnapshot.join(", ") || "none"}; run node scripts/published-slugs.js --write)`);
  const bad = [];
  for (const slug of snapshot.tools) {
    if (live.tools.has(slug) || gated.tools.has(slug)) continue;
    const r = await fetch(`${base}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json().catch(() => ({}));
    const repl = RETIRED_TOOLS[slug]?.replacement || null;
    if (!(r.status === 410 && b.error === "gone" && b.slug === slug && (repl ? b.replacement?.slug === repl : b.replacement === null))) bad.push(`/api/${slug} ${r.status}`);
    else if (!pastSunset(r, RETIRED_TOOLS[slug].retiredAt) || successorOf(r) !== (b.replacement?.url || null)) bad.push(`/api/${slug} headers ${r.headers.get("sunset")} ${r.headers.get("link")}`);
  }
  for (const slug of snapshot.packs) {
    if (live.packs.has(slug) || gated.packs.has(slug)) continue;
    const r = await fetch(`${base}/api/skill/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json().catch(() => ({}));
    if (!(r.status === 410 && b.slug === slug)) bad.push(`/api/skill/${slug} ${r.status}`);
    else if (!pastSunset(r, RETIRED_PACKS[slug].retiredAt) || successorOf(r) !== (b.replacement?.url || null)) bad.push(`/api/skill/${slug} headers ${r.headers.get("sunset")} ${r.headers.get("link")}`);
    const pr = await fetch(`${base}/api/skill-packs/${slug}/prompt`);
    if (pr.status !== 410) bad.push(`/api/skill-packs/${slug}/prompt ${pr.status}`);
    else if (!pastSunset(pr, RETIRED_PACKS[slug].retiredAt)) bad.push(`/api/skill-packs/${slug}/prompt headers ${pr.headers.get("sunset")}`);
  }
  ok(bad.length === 0, `every retired snapshot route answers 410 with its registry replacement (wrong: ${bad.join(", ") || "none"})`);
  const research = await (await fetch(`${base}/api/research-company?ticker=AAPL`)).json();
  ok(research.replacement?.slug === "skill-company-dossier" && /^POST \/api\/skill\/company-dossier$/.test(research.replacement?.route || ""), "a pack can be a tool's replacement, with the pack's own route");
  // stock-quote is listed only with a stock provider (src/tools/stock-provider.js); this boot has none.
  ok(RETIRED_TOOLS["premarket-quote"].replacement === null, "a retirement whose replacement tool is not listed names none on this boot");
  const livePack = [...live.packs][0];
  ok((await fetch(`${base}/api/skill-packs/${livePack}/prompt`)).status === 200, `a live pack's prompt is still served (${livePack})`);
  const tpl = await fetch(`${base}/api/skill-packs/%7Bslug%7D/prompt`);
  const tb = await tpl.json();
  ok(tpl.status === 400 && tb.error === "placeholder" && /skill-packs\.json/.test(tb.list || ""), `the documented template called with its placeholder is a 400 naming the list (got ${tpl.status})`);
  ok((await fetch(`${base}/api/skill-packs/never-a-pack/prompt`)).status === 404, "an unknown pack's prompt is still 404");
  const conv = await fetch(`${base}/api/convert/km-to-miles`);
  ok(conv.status === 410, `the retired converters keep their own teaching 410 (got ${conv.status})`);
  const convBody = await conv.json();
  ok(/POST \/api\/unit-convert/.test(convBody.error || "") && convBody.replacement?.route === "POST /api/unit-convert", "...with its body unchanged");
  for (const shape of ["/api/convert/km-to-miles", "/api/convert-km-to-miles", "/api/convert-not-a-unit-to-other"]) {
    const r = shape === "/api/convert/km-to-miles" ? conv : await fetch(`${base}${shape}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(r.status === 410 && pastSunset(r, RETIRED_CONVERTERS_AT) && successorOf(r) === "http://agent402.test/api/unit-convert", `${shape} 410 carries a past Sunset and the unit-convert successor (got ${r.status} ${r.headers.get("sunset")} ${r.headers.get("link")})`);
  }
  // A key-gated stock route or pack (no stock provider on this boot) answers a
  // free 503 naming the slug: never a 402, a 410 or the guessed-slug 404.
  {
    const { STOCK_SLUGS } = await import("../src/tools/stock-provider.js");
    const { STOCK_CORE_PACK_SLUGS: STOCK_PACK_SLUGS } = await import("../src/skills.js");
    const wrong = [];
    for (const path of [...[...STOCK_SLUGS].map((s) => `/api/${s}`), ...[...STOCK_PACK_SLUGS].map((s) => `/api/skill/${s}`)]) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 503 && b.error === "not-offered" && !r.headers.get("payment-required"))) wrong.push(`${method} ${path} ${r.status}`);
      }
    }
    ok(STOCK_PACK_SLUGS.size > 0 && wrong.length === 0, `every gated stock route and pack answers 503 not-offered with no payment challenge (${wrong.join(", ") || `${STOCK_SLUGS.size} tools, ${STOCK_PACK_SLUGS.size} packs`})`);
  }
  // The same for a Kalshi route while KALSHI_TOOLS is off (this boot).
  {
    const { KALSHI_SLUGS } = await import("../src/kalshi-switch.js");
    const wrong = [];
    for (const path of [...KALSHI_SLUGS].map((s) => `/api/${s}`)) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 503 && b.error === "not-offered" && !r.headers.get("payment-required"))) wrong.push(`${method} ${path} ${r.status}`);
      }
    }
    ok(KALSHI_SLUGS.size === 4 && wrong.length === 0, `every Kalshi route answers 503 not-offered with no payment challenge (${wrong.join(", ") || `${KALSHI_SLUGS.size} tools`})`);
  }
  // A converter call we can serve is untouched: it is served (free boot), never a 410.
  const served = await fetch(`${base}/api/convert-miles-to-kilometers?value=2`);
  ok(served.status === 200 && served.headers.get("sunset") === null, `a servable converter call is still served, with no Sunset (got ${served.status})`);
} finally { proc?.kill("SIGTERM"); }
console.log(`OK: ${pass} passed`);
