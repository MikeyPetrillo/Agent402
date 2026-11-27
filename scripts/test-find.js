// Unit tests for the one-call tool resolver (/api/find). Pure, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { findTools, applyFrontDoorTerms } from "../src/find.js";
import { API_TOOLS } from "../src/tools/api-kit.js";
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { MEV_AND_L2_TOOLS } from "../src/tools/mev-and-l2-kit.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
import { buildRouteExecuteTool, EXEC_TIERS } from "../src/tools/route-execute.js";
import { NETWORK_TOOLS2 } from "../src/tools/network-kit2.js";
import { KIT } from "../src/tools/kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
// An advice disclaimer is a notice, never a match: a report that says it is
// "not investment advice" is not found by "investment decision" on that word.
{
  const cat = [
    { slug: "report-x", name: "Company report", description: "A cited report for a decision. Information, not investment advice.", category: "llm", tags: [] },
    { slug: "backdrop", name: "Macro backdrop", description: "The macro backdrop before an investment decision.", category: "finance", tags: [] },
  ];
  const r = findTools(cat, "investment decision");
  ok(r.results?.[0]?.slug === "backdrop" && !(r.results || []).some((x) => x.slug === "report-x" && x.score >= r.results[0].score), "an advice disclaimer does not rank a tool for the word it disclaims");
}

const CATALOG = {
  "POST /api/extract": { name: "Extract article", slug: "extract", category: "web", price: "$0.005", description: "Extract the main article content from any URL as clean markdown.", tags: ["scraping", "markdown", "content"], discovery: { inputSchema: { properties: { url: { type: "string" } }, required: ["url"] }, input: { url: "https://example.com/article" } } },
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG from text or a URL.", tags: ["qr", "barcode"], discovery: { inputSchema: { properties: { text: { type: "string" } } }, input: { text: "hello" } } },
  "POST /api/unit-convert": { name: "Unit convert", slug: "unit-convert", category: "math", price: "$0.001", description: "Convert a value between units of length, mass, temperature and more (e.g. miles, kilograms, fahrenheit).", tags: ["units", "convert", "length", "mass"], discovery: { example: { value: 100, from: "fahrenheit", to: "celsius" } } },
  "GET /api/time-now": { name: "Time now", slug: "time-now", category: "time", price: "$0.001", description: "Current time in a timezone.", tags: ["time", "timezone"], discovery: { example: { tz: "UTC" } } },
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text with sha256/md5/etc.", tags: ["sha256", "crypto"], discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "hi", algo: "sha256" } } },
};
const POW = new Set(["qr", "hash", "unit-convert", "time-now"]);

// Exact slug term wins.
let r = findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW });
ok(r.results[0].slug === "extract", `"extract" → extract first (got ${r.results[0]?.slug})`);
ok(r.results[0].route === "POST /api/extract" && r.results[0].price === "$0.005", "result carries route + price");
ok(r.results[0].inputSchema && r.results[0].example?.url, "result carries inputSchema + example");
ok(r.results[0].docs === "https://agent402.tools/tools/extract", "result carries docs link");
ok(r.results[0].computePayable === false, "extract flagged not compute-payable");
// Prominent discovery: required keys + a pre-assembled callExample so an agent
// can call without splitting route or guessing body-vs-query.
ok(Array.isArray(r.results[0].required) && r.results[0].required[0] === "url", `result carries required keys (got ${JSON.stringify(r.results[0].required)})`);
ok(r.results[0].callExample?.method === "POST" && r.results[0].callExample?.path === "/api/extract" && r.results[0].callExample?.body?.url === "https://example.com/article", `POST callExample is method+path+body (got ${JSON.stringify(r.results[0].callExample)})`);
// Field order: callExample / example / required must come before description.
const k = Object.keys(r.results[0]);
ok(k.indexOf("callExample") < k.indexOf("description") && k.indexOf("example") < k.indexOf("description"), `callExample + example come before description (keys: ${k.join(",")})`);

// Natural-language task resolves to the surviving parametric converter — the
// unit-word synonym expansion maps "miles"/"kilometers" onto the "units" tag.
r = findTools(CATALOG, "convert miles to kilometers", {});
ok(r.results[0].slug === "unit-convert", `NL task → unit-convert (got ${r.results[0]?.slug})`);
// A tool with no required[] returns required:[] (not undefined) so agents can scan safely.
ok(Array.isArray(r.results[0].required) && r.results[0].required.length === 0, `no-required tool returns required:[] (got ${JSON.stringify(r.results[0].required)})`);
// GET tools put the example values on query, not body.
r = findTools(CATALOG, "current time in a timezone", {});
ok(r.results[0].slug === "time-now", `NL task → time-now (got ${r.results[0]?.slug})`);
ok(r.results[0].callExample?.method === "GET" && r.results[0].callExample?.path === "/api/time-now" && r.results[0].callExample?.query?.tz === "UTC" && !("body" in r.results[0].callExample), `GET callExample uses query, not body (got ${JSON.stringify(r.results[0].callExample)})`);

r = findTools(CATALOG, "make a qr code for a url", { powSlugs: POW });
ok(r.results[0].slug === "qr", `"qr code" → qr (got ${r.results[0]?.slug})`);
ok(r.results[0].computePayable === true, "qr flagged compute-payable");

// Description/tag hit still matches (no slug overlap).
r = findTools(CATALOG, "sha256 checksum", {});
ok(r.results.length > 0 && r.results[0].slug === "hash", `tag match → hash (got ${r.results[0]?.slug})`);

// Stopwords are stripped: a stopword-only query matches nothing.
ok(findTools(CATALOG, "the", {}).count === 0, "single stopword → no results");
ok(findTools(CATALOG, "of in on to for", {}).count === 0, "all-stopword query → no results");

// Stopwords don't poison NL queries — intent words still rank correctly.
r = findTools(CATALOG, "i would like to extract an article from the web", {});
ok(r.results[0]?.slug === "extract", `NL with stopwords → extract still wins (got ${r.results[0]?.slug})`);

// Exact tag match outranks a description-only hit. "barcode" is a tag on qr,
// not in qr's slug/name; "notes" mentions barcode only in description text.
const TAG_CATALOG = {
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG.", tags: ["qr", "barcode"], discovery: { input: { text: "hi" } } },
  "POST /api/notes": { name: "Notes", slug: "notes", category: "misc", price: "$0.001", description: "Plain text notes. Discusses barcode formats in passing.", tags: [], discovery: { input: { text: "hi" } } },
};
r = findTools(TAG_CATALOG, "barcode", {});
ok(r.results[0]?.slug === "qr", `exact tag match outranks description-only hit (got ${r.results[0]?.slug})`);

// Empty / no-match / k limit / guards.
ok(findTools(CATALOG, "", {}).count === 0, "empty query → no results");
ok(findTools(CATALOG, "   ", {}).count === 0, "whitespace query → no results");
ok(findTools(CATALOG, "zzzzznomatch", {}).count === 0, "no-match query → empty");
r = findTools(CATALOG, "convert hash qr extract", { k: 2 });
ok(r.results.length === 2, `k=2 caps results (got ${r.results.length})`);
ok(findTools(CATALOG, null, {}).count === 0, "null query handled");
// Pathological long input must not throw.
ok(findTools(CATALOG, "x ".repeat(5000) + "extract", {}).results.length >= 0, "long input handled without throwing");

// Serializes cleanly (served as JSON).
JSON.parse(JSON.stringify(findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW })));


// ---- find->seller bridge: seller-name queries resolve to indexed sellers ----
// 25 recorded find-misses for "acmeagent" were agents hunting the INDEXED
// seller acmeagent.example; /api/find is catalog-only, so they missed forever.
{
  const { findRelatedSellers } = await import("../src/find.js");
  const sellers = [
    { host: "acmeagent.example", origin: "https://acmeagent.example", toolCount: 89 },
    { host: "www.bigworldmodel.example", origin: "https://www.bigworldmodel.example", toolCount: 42 },
    { host: "api.example.com", origin: "https://api.example.com", toolCount: 3 },
    { host: "acmeagent.invalid", origin: "https://acmeagent.invalid", toolCount: 5 },
  ];
  const one = findRelatedSellers("acmeagent", sellers);
  ok(one.length === 2 && one[0].host === "acmeagent.example", `exact label match, tool-count ranked (got ${JSON.stringify(one.map((s) => s.host))})`);
  ok(one[0].toolCount === 89 && !("displayName" in one[0]), "carries only host/origin/toolCount - no third-party text");
  ok(findRelatedSellers("bigworldmodel", sellers)[0]?.host === "www.bigworldmodel.example", "substring match ignores www. and TLD");
  ok(findRelatedSellers("extract the article from this url", sellers).length === 0, "a task-shaped query matches no seller");
  ok(findRelatedSellers("api", sellers).length === 0, "a short generic term does not match a seller label by substring");
  ok(findRelatedSellers("", sellers).length === 0 && findRelatedSellers("ab", sellers).length === 0, "empty/too-short queries are ignored");
  ok(findRelatedSellers("acmeagent", []).length === 0 && findRelatedSellers("x", null).length === 0, "no sellers / bad input is empty, not a crash");
}
// ---- delegated-purchase intent resolves to the Smart Order Router ----
// Audited 2026-07-28: agents asking the natural way ("buy a tool from another
// seller", "pay an external api on my behalf") got unrelated tools, because
// "api" matches every openapi-* slug and "pay" matches "payload". The
// synthetic "sor" term fixes intent WITHOUT touching ordinary buy/pay queries -
// both halves are pinned here, and the regression half is the important one.
{
  const catalog = {};
  for (const t of [...API_TOOLS, ...CRYPTO_TOOLS]) catalog[t.route] = t;
  const re = buildRouteExecuteTool({ getCatalog: () => ({}), baseUrl: "https://x", tier: EXEC_TIERS[0] });
  catalog[re.route] = re;
  const top = (q) => findTools(catalog, q, { k: 3, baseUrl: "https://x", powSlugs: new Set() }).results.map((r) => r.slug);
  for (const q of ["buy a tool from another seller", "purchase from an x402 seller", "outsource this task to a vendor", "pay an external api on my behalf"]) {
    ok(top(q).includes("route-execute"), `SOR intent resolves: "${q}" -> ${JSON.stringify(top(q))}`);
  }
  // The invariant that matters: the DOMAIN tool still wins. route-execute may
  // appear lower down (it carries buy/purchase tags and genuinely can buy
  // these), but it must never displace the tool that actually answers.
  for (const [q, want] of [["buy bitcoin price", "crypto-price"], ["purchase price of ethereum", "crypto-price"]]) {
    ok(top(q)[0] === want, `ordinary commerce query still resolves to ${want}: "${q}" -> ${JSON.stringify(top(q))}`);
  }
}

// --- Skill packs must be BUYABLE where they are recommended, and the
//     recommendation must not flatter them. --------------------------------
//
// A recommended pack used to carry only {slug,title,tagline,toolSlugs,url,
// promptName}. The one actionable field was promptName, which means "run the
// steps yourself" — so the bundled endpoint, which is the whole product, was
// invisible at the exact moment an agent was choosing what to do.
//
// The second half matters more. Measured across the catalog, 99 of 102 packs
// cost MORE than their tools bought individually, several by 12-30x. Surfacing
// packs harder while staying quiet about that would be an upsell wearing the
// costume of an answer. So the a la carte total rides along, and the wording
// must never claim a saving that the arithmetic contradicts.
{
  const { rankSkillPacks, PACK_PRICES } = await import("../src/skills.js");
  const usd = (s) => Number(String(s).replace(/[^0-9.]/g, ""));

  const packs = rankSkillPacks("audit the security of a domain", {
    baseUrl: "https://agent402.tools",
    toolPriceUsd: () => 0.005, // every step a known price -> comparison computable
  });
  ok(packs.length > 0, `a task query recommends at least one pack (got ${packs.length})`);

  for (const p of packs) {
    ok(p.method === "POST" && p.route === `/api/skill/${p.slug}`,
      `${p.slug}: recommendation names the callable bundled route`);
    ok(typeof p.price === "string" && usd(p.price) > 0,
      `${p.slug}: recommendation states the one-call price (${p.price})`);
    ok(usd(p.price) === (PACK_PRICES[p.slug] ?? 0.05),
      `${p.slug}: the quoted price is the price actually charged, not a second copy`);
    ok(typeof p.aLaCarteUsd === "number",
      `${p.slug}: states what the same steps cost individually ($${p.aLaCarteUsd})`);

    // THE HONESTY INVARIANT. If the bundle is dearer, the copy must say so and
    // must not assert the opposite.
    const dearer = p.aLaCarteUsd < usd(p.price);
    if (dearer) {
      ok(/cheaper a la carte/.test(p.oneCall),
        `${p.slug}: a dearer bundle SAYS it is dearer (pack $${usd(p.price)} vs $${p.aLaCarteUsd})`);
      ok(!/bundle is also the cheaper path/.test(p.oneCall),
        `${p.slug}: a dearer bundle never claims to be the cheaper path`);
    } else if (Math.round(p.aLaCarteUsd * 1e4) === Math.round(usd(p.price) * 1e4)) {
      ok(/the same price/.test(p.oneCall), `${p.slug}: an equal-priced bundle says "the same price"`);
    } else {
      ok(/bundle is also the cheaper path/.test(p.oneCall),
        `${p.slug}: a genuinely cheaper bundle is allowed to say so`);
    }
  }

  // An a la carte total EQUAL to the pack price is not "cheaper"; and a pack
  // whose every step runs free with proof-of-work says so.
  {
    const target = packs[0];
    const each = (PACK_PRICES[target.slug] ?? 0.05) / target.toolSlugs.length;
    const eq = rankSkillPacks("audit the security of a domain", {
      baseUrl: "https://agent402.tools",
      toolPriceUsd: () => each,
      toolFree: () => true,
    }).find((p) => p.slug === target.slug);
    ok(eq && /the same price/.test(eq.oneCall) && !/cheaper path/.test(eq.oneCall),
      `${target.slug}: a bundle priced the same as its steps says "the same price", never "cheaper" (${eq?.oneCall})`);
    ok(/free one at a time with proof-of-work/.test(eq.oneCall), `${target.slug}: an all-free-step pack names the free path`);
    ok(!/\u2014/.test(eq.oneCall) && packs.every((p) => !/\u2014/.test(p.oneCall)), "pack copy carries no em dash");
  }

  // A partial price lookup must yield NO total rather than an understated one:
  // a sum missing a step would make a la carte look cheaper than it is, which
  // biases the comparison in the bundle's favour — the exact failure mode.
  const partial = rankSkillPacks("audit the security of a domain", {
    baseUrl: "https://agent402.tools",
    toolPriceUsd: (s) => (s === "whois" ? null : 0.005),
  });
  ok(partial.every((p) => p.aLaCarteUsd === undefined || !(p.toolSlugs || []).includes("whois")),
    "an unpriceable step suppresses the comparison instead of understating it");

  // ...and with no lookup at all we still hand back a buyable route.
  const bare = rankSkillPacks("audit the security of a domain", { baseUrl: "https://agent402.tools" });
  ok(bare.every((p) => p.route && p.price && p.aLaCarteUsd === undefined),
    "without a price source the pack stays buyable but claims no comparison");
}

// --- A common word must not outrank a distinguishing one -------------------
//
// Two scoring defects, found by running realistic agent tasks through the
// resolver we advertise as the entry point and reading the answers:
//
//   * an INCIDENTAL SUBSTRING scored like a real match, so "check" inside
//     `checksum` and "data" inside `wikidata-entity` beat `http-check` and the
//     memory tools.
//   * every term counted equally, so a word shared by dozens of tools ("check")
//     outvoted the one word that actually narrowed it ("website").
//
// A wrong top result is not cosmetic: an agent that trusts /api/find pays for
// the wrong tool and gets something useless on its FIRST call.
{
  const C = {
    "POST /api/checksum": { name: "Checksum", slug: "checksum", category: "encoding", price: "$0.001", description: "CRC32 and Adler checksums of text.", tags: ["crc", "checksum"], discovery: {} },
    "POST /api/http-check": { name: "HTTP check", slug: "http-check", category: "network", price: "$0.003", description: "Check any public URL: status code, latency, redirects.", tags: ["uptime", "website", "up", "status"], discovery: {} },
    "POST /api/spf-check": { name: "SPF check", slug: "spf-check", category: "network", price: "$0.003", description: "Validate a domain's SPF record.", tags: ["spf", "email", "dns"], discovery: {} },
    "POST /api/wikidata-entity": { name: "Wikidata entity", slug: "wikidata-entity", category: "data", price: "$0.005", description: "Look up a Wikidata entity.", tags: ["wikidata", "entity"], discovery: {} },
    "POST /api/memory": { name: "Memory write", slug: "memory-write", category: "memory", price: "$0.002", description: "Persistent key-value memory for agents.", tags: ["memory", "store", "session", "sessions", "state"], discovery: {} },
  };
  const top1 = (q) => findTools(C, q, { baseUrl: "https://agent402.tools" }).results[0]?.slug;

  ok(top1("check if a website is up") === "http-check",
    `"check if a website is up" -> http-check, not a tool that merely contains "check" (got ${top1("check if a website is up")})`);
  ok(top1("store data between sessions") === "memory-write",
    `"store data between sessions" -> memory-write, not a slug containing "data" (got ${top1("store data between sessions")})`);

  // The mechanism, asserted directly so the fix cannot be silently undone:
  // a whole slug segment must outscore an incidental substring.
  const seg = findTools(C, "check", { baseUrl: "" }).results.map((r) => r.slug);
  ok(seg.indexOf("http-check") < seg.indexOf("checksum") || !seg.includes("checksum"),
    `a slug SEGMENT ("http-check") outranks an accidental substring ("checksum") for "check" (${seg.join(",")})`);

  // And a term shared by many tools must carry less weight than a rare one.
  // "check" appears in three of five here; "website" in one. The rare word wins.
  ok(top1("website check") === "http-check",
    `the rarer term decides when a common one is shared (got ${top1("website check")})`);
}

// --- A capability gap must be OBSERVABLE ------------------------------------
//
// The miss signal keyed on an absolute score floor of 3. Measured against the
// live catalog, eighteen tasks this service cannot do — "order me a pizza",
// "call my mother", "write my thesis" — all returned confident top hits scoring
// 4 to 42. "call" matched `eth-call`, "car" matched `card-validate`, "write"
// matched `memory-write`. Not one was recorded as a miss.
//
// So the demand board's find-miss source could never fire for a real gap: it
// captured only gibberish ("undefined", "[object object]") and was structurally
// blind to what we should build. "No demand for X" was unfalsifiable — which is
// how a missing capability stays missing.
//
// The rarest query term is the one that defines the task. If the top hit never
// mentions it, we did not serve the query however high the score climbed on
// common words. Ranking is deliberately NOT changed by this: results are still
// returned, so a false flag only over-records demand and never withholds an
// answer from a buyer.
{
  const C = {
    "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text with sha256, sha512, md5.", tags: ["sha256", "digest"], discovery: {} },
    "POST /api/eth-call": { name: "Eth call", slug: "eth-call", category: "chain", price: "$0.003", description: "Execute a read-only contract call on an EVM chain.", tags: ["evm", "contract"], discovery: {} },
    "POST /api/memory": { name: "Memory write", slug: "memory-write", category: "memory", price: "$0.002", description: "Persistent key-value memory for agents.", tags: ["memory", "store"], discovery: {} },
    // `sessions` appears ONLY in tags - not in the slug, name or description.
    // That is exactly the case the API response cannot see.
    "POST /api/keep": { name: "Keep", slug: "keep", category: "memory", price: "$0.002", description: "Durable storage for agents.", tags: ["sessions"], discovery: {} },
  };
  const f = (q) => findTools(C, q, { baseUrl: "https://agent402.tools" });

  // A task the catalog cannot serve: "mother" appears nowhere, so the high
  // score on "call" (which does hit eth-call) must not read as an answer.
  const impossible = f("call my mother");
  ok(impossible.results.length > 0, "an unservable query still RETURNS results (ranking is untouched)");
  ok(impossible.rarestTerm === "mother", `the defining term is identified (got ${impossible.rarestTerm})`);
  ok(impossible.rarestTermCovered === false,
    "...and is reported as NOT covered, which is what makes the gap observable");

  // A task the catalog does serve must not be flagged.
  const real = f("hash text with sha256");
  ok(real.results[0].slug === "hash", "a servable query resolves normally");
  ok(real.rarestTermCovered === true, "...and is NOT flagged as a miss");

  // The coverage check must read the FULL record including TAGS. An earlier
  // version tested the API response, which omits `tags`, and so reported a
  // 40% false-miss rate that did not exist.
  const viaTag = f("keep sessions");
  ok(viaTag.results[0].slug === "keep", `tag-only query resolves (got ${viaTag.results[0]?.slug})`);
  ok(viaTag.rarestTermCovered === true,
    `a match that lives only in a TAG counts as covered - the check reads the catalog record, not the API response, which omits tags (rarest=${viaTag.rarestTerm})`);

  // An incidental word no tool mentions must not turn a right answer into a
  // miss. 346 of 359 live board clusters on 2026-09-25 were queries like
  // "decode jwt token and extract claims" where the top hit was the tool.
  const J = { ...C, "POST /api/jwt-decode": { name: "JWT decode", slug: "jwt-decode", category: "encoding", price: "$0.001", description: "Decode a JWT and extract its header and payload.", tags: ["jwt", "token"], discovery: {} } };
  const incidental = findTools(J, "decode jwt token and extract claims", { baseUrl: "https://agent402.tools" });
  ok(incidental.results[0].slug === "jwt-decode" && incidental.rarestTerm === "claims", `the rarest term is an incidental word (${incidental.rarestTerm})`);
  ok(incidental.rarestTermCovered === true, `...and the top hit covering most of the query in its own name counts as served (share ${incidental.coverageShare})`);
  // Description-only overlap is not enough: the covered terms must touch the
  // top hit's slug or name.
  const D = { ...C, "POST /api/jobs": { name: "Unemployment rate", slug: "unemployment-rate", category: "macro", price: "$0.005", description: "US jobs data: unemployment rate and payrolls.", tags: ["labor"], discovery: {} } };
  const descOnly = findTools(D, "excel data jobs", { baseUrl: "https://agent402.tools" });
  ok(descOnly.rarestTermCovered === false, `a description-only overlap with an uncovered defining word stays a miss (top ${descOnly.results[0]?.slug})`);
  ok(f("call my mother").rarestTermCovered === false, "one covered word is still a miss (call my mother)");
}

// --- A data value never decides whether a query was served -----------------
// Replayed from the demand board 2026-10-06: "convert unix timestamp 1767200000
// to america/chicago", "generate qr code 400x400", "decode base32 jmsu6ubfru4s2gm"
// and "convert timezone from auckland to sydney" all ranked the right tool first
// and were still filed as misses, because the rarest term was the VALUE.
{
  const { isValueTerm } = await import("../src/find.js");
  for (const t of ["1767200000", "400x400", "jmsu6ubfru4s2gm", "auckland", "pacific", "c2l0zs10cmfja2vyltiwmjy6", "june", "march", "friday"]) ok(isValueTerm(t), `"${t}" is a value, not a defining word`);
  for (const t of ["pizza", "language", "mother", "timezone", "fleet"]) ok(!isValueTerm(t), `"${t}" can still define a task`);
  const { KIT } = await import("../src/tools/kit.js");
  const { STATS_TOOLS } = await import("../src/tools/stats-kit.js");
  const { DATE_TIME_TOOLS } = await import("../src/tools/date-time-kit.js");
  const V = Object.fromEntries([...KIT, ...STATS_TOOLS, ...DATE_TIME_TOOLS].map((t) => [t.route, t]));
  const g = (q) => findTools(V, q, { baseUrl: "https://agent402.tools" });
  const tz = g("convert timezone from auckland to sydney");
  ok(tz.results[0]?.slug === "timezone-convert" && tz.rarestTermCovered === true, `a city name does not turn a served time-zone query into a miss (top ${tz.results[0]?.slug}, rarest ${tz.rarestTerm})`);
  const qr = g("generate qr code from text string, 400x400 pixels");
  ok(qr.results[0]?.slug === "qr" && qr.rarestTermCovered === true, `a size value does not turn a served QR query into a miss (rarest ${qr.rarestTerm})`);
  const ema = g("compute ema from a list of closing prices");
  ok(ema.results[0]?.slug === "moving-average", `"ema from closing prices" reaches moving-average (got ${ema.results[0]?.slug})`);
  ok(g("call my mother").rarestTermCovered === false || g("call my mother").count === 0, "a real gap is still a miss");
}

// --- The catalog must answer in the ASKER's vocabulary ----------------------
//
// A tool we already ship is worth nothing if the words a domain-fluent agent
// uses reach none of it. Measured against the live catalog:
//
//   layer 2 updates -> sql-guard at 4 (wrong tool entirely)
//
// "layer 2" is the spelled-out form of the l2 tag, and its digit is a 1-char
// token dropped before ranking, so only "layer" survives to match on. (The
// rollup locked-value ranking, l2-tvl, was retired 2026-11-16 with its
// vocabulary; a locked-value query now has no L2 tool to land on.)
//
// Asserted against the REAL kit records rather than a fixture, because the
// thing under test IS the curated vocabulary on those records - a fixture
// would restate the fix instead of checking it.
{
  const C = {};
  for (const t of [...API_TOOLS, ...CRYPTO_TOOLS, ...MEV_AND_L2_TOOLS]) C[t.route] = t;
  const f = (q) => findTools(C, q, { baseUrl: "https://agent402.tools" });
  const top1 = (q) => f(q).results[0]?.slug;

  // A retired route is never a find result, whatever the query.
  for (const q of ["l2beat", "rollup tvs", "total value locked on rollups"]) {
    ok(!f(q).results.some((r) => r.slug === "l2-tvl"), `"${q}" does not resolve to the retired l2-tvl`);
  }
  ok(String(top1("layer 2 updates") || "").startsWith("l2-"), `"layer 2 updates" -> an L2 tool (got ${top1("layer 2 updates")})`);
  ok(String(top1("layer-2 gas costs") || "").startsWith("l2-"), `hyphenated "layer-2" also expands (got ${top1("layer-2 gas costs")})`);

  // ...and ONLY as a phrase. Tagging bare "layer" on the L2 tools was the first
  // attempt and it hijacked ordinary English: "osi model layer" and "layer of
  // encryption" both resolved to an L2 tool at high confidence. These two assert
  // the narrower rule, so reintroducing the broad tag fails here.
  ok(!String(top1("layer of encryption") || "").startsWith("l2-"),
    `bare "layer" does NOT reach the L2 tools (got ${top1("layer of encryption")})`);
  ok(!String(top1("osi model layer") || "").startsWith("l2-"),
    `a networking "layer" question does NOT reach the L2 tools (got ${top1("osi model layer")})`);

  // A gas question belongs to the gas tool, and a locked-value question must
  // not land there: a zero-result miss is cheaper than a confidently wrong
  // answer - the agent PAYS for that one.
  ok(top1("compare l2 gas fees across chains") === "l2-gas-comparison",
    `a gas query still resolves to l2-gas-comparison (got ${top1("compare l2 gas fees across chains")})`);
  ok(top1("total value locked on rollups") !== "l2-gas-comparison",
    `a locked-value query does not land on the gas tool (got ${top1("total value locked on rollups")})`);
}

// --- Front door: search / answer / news phrasing ----------------------------
//
// Product intent: common "search the web / answer a question / news" queries
// must land on the flagship web tools first. Phrase-gated so bare English
// ("search tools catalog") does not hijack unrelated tasks.
{
  const terms = ["something"];
  applyFrontDoorTerms(terms, "search the web for x402");
  ok(terms.includes("web-search"), `applyFrontDoorTerms adds web-search for "search the web" (got ${terms.join(",")})`);
  const terms2 = [];
  applyFrontDoorTerms(terms2, "decode a jwt token");
  ok(!terms2.includes("web-search") && !terms2.includes("answer"),
    `applyFrontDoorTerms is a no-op on unrelated queries (got ${terms2.join(",") || "empty"})`);

  const C = {};
  for (const t of SEARCH_TOOLS) C[t.route] = t;
  // Distractor that used to compete on loose "search" vocabulary.
  C["POST /api/hash"] = { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text.", tags: ["digest"], discovery: {} };
  const top1 = (q) => findTools(C, q, { k: 3, baseUrl: "https://agent402.tools" }).results[0]?.slug;

  ok(top1("search the web for x402 adoption") === "search",
    `"search the web…" → search (got ${top1("search the web for x402 adoption")})`);
  ok(top1("answer this question with citations: what is x402?") === "answer",
    `"answer this question with citations…" → answer (got ${top1("answer this question with citations: what is x402?")})`);
  ok(top1("latest news about the Federal Reserve") === "search-news",
    `"latest news about…" → search-news (got ${top1("latest news about the Federal Reserve")})`);
}

// A wish-board phrase (2026-09-25) that missed the uuid tool: "time" and
// "captcha" outranked it until uuid carried its identifier aliases and tags.
{
  const { KIT } = await import("../src/tools/kit.js");
  const kitCatalog = Object.fromEntries(KIT.map((t) => [t.route, t]));
  const first = (q) => findTools(kitCatalog, q, { baseUrl: "https://agent402.tools", powSlugs: new Set() }).results?.[0]?.slug;
  ok(first("generate time-ordered unique identifiers") === "uuid", `"generate time-ordered unique identifiers" -> uuid (got ${first("generate time-ordered unique identifiers")})`);
  ok(first("uuid v7") === "uuid", `"uuid v7" -> uuid (got ${first("uuid v7")})`);
  // A curated alias scores like a word of the slug (2026-09-25): at +1 in the
  // haystack "md5" ranked hash below hex/checksum although hash carries it.
  ok(first("compute md5 hex digest of a string") === "hash", `"compute md5 hex digest of a string" -> hash (got ${first("compute md5 hex digest of a string")})`);
}
{
  // A plural query word reads as the singular the catalog names (2026-11-22):
  // "uuids" was no slug, tag or alias word of uuid, so the shared verb
  // "generate" carried a *-generate tool to the top. A plural the catalog
  // itself uses as a word stays as written, and a spelled-out version
  // ("version 7") also reads as its short form ("v7").
  const cat = {
    "GET /api/uuid": { name: "Unique ID generator", slug: "uuid", aliases: ["time-ordered-id", "uuid-v7"], category: "identifiers", price: "$0.001", description: "Generate random or time-ordered identifiers.", tags: ["uuid", "id"], discovery: { example: {} } },
    "POST /api/captcha-generate": { name: "Captcha generate", slug: "captcha-generate", category: "api", price: "$0.001", description: "Mint a captcha challenge.", tags: ["captcha"], discovery: { example: {} } },
    "GET /api/time": { name: "Time", slug: "time", category: "time", price: "$0.001", description: "The current time in a zone.", tags: ["time", "clock"], discovery: { example: {} } },
    "GET /api/news": { name: "News", slug: "news", category: "web", price: "$0.001", description: "Headlines.", tags: ["news"], discovery: { example: {} } },
    "GET /api/new-pairs": { name: "New pairs", slug: "new-pairs", category: "crypto", price: "$0.001", description: "Newly listed trading pairs.", tags: ["new"], discovery: { example: {} } },
    // "time" is a common word in the real catalog, as it is here.
    "GET /api/time-convert": { name: "Time convert", slug: "time-convert", category: "time", price: "$0.001", description: "Convert a time between zones.", tags: ["time"], discovery: { example: {} } },
    "GET /api/relative-time": { name: "Relative time", slug: "relative-time", category: "time", price: "$0.001", description: "A time as words.", tags: ["time"], discovery: { example: {} } },
    "GET /api/date-diff": { name: "Date difference", slug: "date-diff", category: "time", price: "$0.001", description: "Time between two dates.", tags: ["date", "time"], discovery: { example: {} } },
  };
  const top = (q) => findTools(cat, q, {}).results?.[0]?.slug;
  ok(top("generate uuids") === "uuid", `"generate uuids" -> uuid (got ${top("generate uuids")})`);
  ok(top("make some version 7 uuids") === "uuid", `"make some version 7 uuids" -> uuid (got ${top("make some version 7 uuids")})`);
  ok(top("time ordered ids") === "uuid", `"time ordered ids" -> uuid (got ${top("time ordered ids")})`);
  ok(top("news") === "news", `a plural the catalog names stays as written: "news" -> news (got ${top("news")})`);
  const r2 = findTools(cat, "generate uuids", {});
  ok(r2.rarestTermCovered === true, `"generate uuids" reads as served (rarest ${r2.rarestTerm})`);
}
{
  // A plural whose singular the query also writes is not read a second time
  // as that name: "URLs and PDFs ... PDF pages" scored the pdf tool once for
  // "pdf" and again for "pdfs", which carried it over pdf-extract-pages.
  const P = {
    "POST /api/pdf": { name: "PDF to text", slug: "pdf", category: "web", price: "$0.001", description: "Fetch a PDF and extract its text (up to 20MB PDFs).", tags: ["pdf", "documents"], discovery: { example: {} } },
    "POST /api/pdf-extract-pages": { name: "Extract PDF pages", slug: "pdf-extract-pages", category: "web", price: "$0.003", description: "Pull a subset of pages into a new PDF.", tags: ["pdf", "pages", "extract"], discovery: { example: {} } },
    "POST /api/pdf-merge": { name: "Merge PDF files", slug: "pdf-merge", category: "web", price: "$0.003", description: "Merge PDF files.", tags: ["pdf"], discovery: { example: {} } },
  };
  for (const [i, w] of ["alpha", "beta", "gamma", "delta", "omega", "sigma"].entries()) P[`GET /api/p${i}`] = { name: w, slug: w, category: "misc", price: "$0.001", description: `The ${w} tool.`, tags: [w], discovery: { example: {} } };
  const pt = (q) => findTools(P, q, {}).results?.[0]?.slug;
  ok(pt("turn PDFs into text: PDF pages") === "pdf-extract-pages", `a plural beside its written singular counts once (got ${pt("turn PDFs into text: PDF pages")})`);
  // The plural alone still reads as the name.
  ok(pt("pdfs") === "pdf", `"pdfs" alone -> pdf (got ${pt("pdfs")})`);
}
{
  // The singular is not read where it would mislead: a verb's -s form the
  // catalog also writes as a verb, and a word the catalog writes more often
  // than its singular ("https" against "http").
  const V = {
    "POST /api/transcribe": { name: "Transcribe", slug: "transcribe", category: "media", price: "$0.01", description: "Transcribing audio to text.", tags: ["audio"], discovery: { example: {} } },
    "POST /api/transcribe-pro": { name: "Transcribe pro", slug: "transcribe-pro", category: "media", price: "$0.02", description: "Pro tier for long recordings; transcribes a file.", tags: ["audio"], discovery: { example: {} } },
    "GET /api/http": { name: "HTTP check", slug: "http", category: "web", price: "$0.001", description: "Check an http endpoint.", tags: ["http"], discovery: { example: {} } },
    "GET /api/a": { name: "Fetch", slug: "fetch-page", category: "web", price: "$0.001", description: "Fetch https pages.", tags: ["web"], discovery: { example: {} } },
    "GET /api/b": { name: "Quote", slug: "quote", category: "web", price: "$0.001", description: "Read https payment requirements.", tags: ["web"], discovery: { example: {} } },
  };
  const vt = (q) => findTools(V, q, {}).results?.[0]?.slug;
  ok(vt("transcribes recordings") === "transcribe-pro", `a verb's -s form does not read as a slug (got ${vt("transcribes recordings")})`);
  ok(vt("https") !== "http", `"https" is not read as a plural of http (got ${vt("https")})`);
  // A spelled-out version reaches the tool that names the short form.
  const W = {
    "GET /api/ids": { name: "Ids", slug: "id-maker", aliases: ["v7"], category: "identifiers", price: "$0.001", description: "Identifiers of any version.", tags: ["id"], discovery: { example: {} } },
    "GET /api/vc": { name: "Version control", slug: "version-control", category: "dev", price: "$0.001", description: "Version history of a repository.", tags: ["git"], discovery: { example: {} } },
  };
  for (const [i, w] of ["alpha", "beta", "gamma", "delta", "omega", "sigma"].entries()) W[`GET /api/f${i}`] = { name: w, slug: w, category: "misc", price: "$0.001", description: `The ${w} tool.`, tags: [w], discovery: { example: {} } };
  const wt = (q) => findTools(W, q, {}).results?.[0]?.slug;
  ok(wt("version 7") === "id-maker", `"version 7" reads as v7 (got ${wt("version 7")})`);
  const { singularCandidates, versionTerms } = await import("../src/query-terms.js");
  ok(JSON.stringify(singularCandidates("uuids")) === '["uuid"]', `uuids -> uuid (got ${JSON.stringify(singularCandidates("uuids"))})`);
  ok(singularCandidates("anomalies").includes("anomaly"), "anomalies -> anomaly");
  ok(singularCandidates("hashes").includes("hash"), "hashes -> hash");
  ok(singularCandidates("address").length === 0 && singularCandidates("status").length === 0 && singularCandidates("analysis").length === 0, "ss/us/is endings are not plurals");
  ok(singularCandidates("ids").includes("id"), "ids -> id");
  ok(JSON.stringify(versionTerms("make some version 7 uuids")) === '["v7"]', `"version 7" -> v7 (got ${JSON.stringify(versionTerms("make some version 7 uuids"))})`);
  ok(JSON.stringify(versionTerms("uuid ver. 4 and v 6")) === '["v4","v6"]', `"ver. 4", "v 6" -> v4, v6 (got ${JSON.stringify(versionTerms("uuid ver. 4 and v 6"))})`);
  ok(versionTerms("version control history").length === 0, "a version word without a number adds nothing");
}
{
  // A multi-word alias counts only when EVERY word is in the query: one generic
  // word ("chat", "image") must not let an alias outrank a tool's own name.
  const cat = {
    "POST /api/a": { name: "Chat completions - pro tier", slug: "v1-chat-pro", category: "ai", price: "$0.1", description: "Pro chat.", tags: ["chat"], discovery: { example: {} } },
    "POST /api/b": { name: "Nano chat", slug: "v1-chat-nano", aliases: ["chat-completions-nano-tier"], category: "ai", price: "$0.003", description: "Nano chat.", tags: ["chat"], discovery: { example: {} } },
    "POST /api/c": { name: "Wayback snapshot", slug: "archive-snapshot", aliases: ["website-history"], category: "web", price: "$0.003", description: "Archived page.", tags: ["archive"], discovery: { example: {} } },
    "POST /api/d": { name: "Crypto history", slug: "crypto-history", category: "crypto", price: "$0.003", description: "Price history for a coin.", tags: ["crypto"], discovery: { example: {} } },
    "POST /api/e": { name: "Uptime check", slug: "http-check", category: "web", price: "$0.001", description: "Is a website up right now.", tags: ["uptime"], discovery: { example: {} } },
  };
  const top = (q) => findTools(cat, q, { baseUrl: "https://agent402.tools", powSlugs: new Set() }).results?.[0]?.slug;
  ok(top("chat completions pro tier") === "v1-chat-pro", `a partial alias match does not beat the tool's own name (got ${top("chat completions pro tier")})`);
  ok(top("website history") === "archive-snapshot", `a full multi-word alias match counts (got ${top("website history")})`);
  ok(top("is my website up") === "http-check", `one word of a multi-word alias ("website") earns nothing (got ${top("is my website up")})`);
}

// The demand board's most repeated find-miss (2026-09-20..25): price, OHLCV
// candles and RSI/EMA for BTC and ETH in one call. crypto-indicators answers
// all of it (ohlcv option), but its name said none of those words and the
// searches were recorded as misses. Driven against the REAL crypto kits so a
// description or tag edit that loses the match fails here.
{
  const { CRYPTO_SIGNALS_TOOLS } = await import("../src/tools/crypto-signals-kit.js");
  const { DERIVATIVES_TOOLS } = await import("../src/tools/derivatives-kit.js");
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { PRICE_FEED_TOOLS } = await import("../src/tools/price-feed-kit.js");
  const real = {};
  for (const t of [...CRYPTO_TOOLS, ...CRYPTO_SIGNALS_TOOLS, ...DERIVATIVES_TOOLS, ...CRYPTO_MARKETS_TOOLS, ...PRICE_FEED_TOOLS]) real[`${t.method || "POST"} ${t.route}`] = t;
  const find = (q) => findTools(real, q, {});
  for (const q of [
    "btc eth cryptocurrency price ohlcv candles rsi ema",
    "get bitcoin and ethereum live spot price and ohlcv candles for rsi ema",
    "get live bitcoin and ethereum spot price and rsi ema indicators",
    "btc eth crypto spot price and ohlcv candles rsi ema indicators",
  ]) {
    const r = find(q);
    ok(r.results[0]?.slug === "crypto-indicators" && r.rarestTermCovered, `"${q}" -> crypto-indicators, served (got ${r.results[0]?.slug}, covered=${r.rarestTermCovered})`);
  }
  const plain = find("get live bitcoin and ethereum cryptocurrency spot price usd");
  ok(plain.results[0]?.slug === "crypto-price" && plain.rarestTermCovered, `a price-only ask stays on crypto-price, served (got ${plain.results[0]?.slug})`);
  ok(find("bitcoin price").results[0]?.slug === "crypto-price", "a bare price ask is not pulled onto the indicators tool");
  ok(find("perp klines for btc 1h").results[0]?.slug === "perp-klines", "a klines ask still reaches perp-klines");
}

// ---- html-frames speaks the render-contract vocabulary (2026-10-20) ----
// The tool's aliases and tags, against the real kit definitions beside the
// kits that could compete for these words (contract-*, html-*, search).
{
  const { BROWSER_MEASURE_TOOLS } = await import("../src/tools/browser-measure-kit.js");
  const { HTML_TOOLS } = await import("../src/tools/html-kit.js");
  const C = {};
  for (const t of [...API_TOOLS, ...CRYPTO_TOOLS, ...MEV_AND_L2_TOOLS, ...SEARCH_TOOLS, ...HTML_TOOLS, ...BROWSER_MEASURE_TOOLS]) C[t.route] = t;
  for (const q of ["render contract", "renderAt", "contact sheet", "motion design frame check", "freeze frames of my animation"]) {
    const r = findTools(C, q, {});
    ok(r.results[0]?.slug === "html-frames", `"${q}" -> html-frames (got ${r.results.slice(0, 3).map((x) => x.slug).join(", ")})`);
  }
  ok(findTools(C, "page speed", {}).results[0]?.slug === "page-speed", "the sibling tool keeps its own words");
}

// ---- typos and misses (2026-10-15, from the demand board) ----
{
  const { closestCatalogWord, markMissRows } = await import("../src/find.js");
  const words = new Map([["sanctions", 4], ["screenshot", 2], ["other", 9], ["lowercase", 1]]);
  ok(closestCatalogWord("danctions", words) === "sanctions", "a one-letter slip in a long word is corrected (danctions -> sanctions)");
  ok(closestCatalogWord("screenhsot", words) === "screenshot", "two swapped letters are corrected (screenhsot -> screenshot)");
  ok(closestCatalogWord("mother", words) === null, "a short real word is never turned into another by dropping a letter (mother stays)");
  ok(closestCatalogWord("sanctions", words) === null, "a word already in the catalog is not corrected");
  const m = markMissRows({ results: [{ slug: "perp-orderbook" }] });
  ok(m.weakMatches === true && m.results[0].weak === true, "a miss marks every returned row weak");
}
// ---- currency words reach the currency converter (2026-11-17) ----
// "convert currency" ranked the *-convert tools on "convert" ("currency" sits
// inside "cryptocurrency" across the crypto kits) and read as a miss while
// fx-rate does the task. Against the real kits that compete for the words.
{
  const { KIT } = await import("../src/tools/kit.js");
  const { KIT2 } = await import("../src/tools/kit2.js");
  const { DATA_TOOLS } = await import("../src/tools/data-kit.js");
  const { MACRO_TOOLS } = await import("../src/tools/macro-kit.js");
  const { MEDIA_TOOLS } = await import("../src/tools/media-kit.js");
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { PRICE_FEED_TOOLS } = await import("../src/tools/price-feed-kit.js");
  const { FORECAST_TOOLS } = await import("../src/tools/forecast-kit.js");
  const { PREDICTION_MARKET_TOOLS } = await import("../src/tools/prediction-market-kit.js");
  const { FINANCE_MATH_TOOLS } = await import("../src/tools/finance-math-kit.js");
  const { USAGE_TOOLS } = await import("../src/tools/usage-kit.js");
  const C = {};
  for (const t of [...API_TOOLS, ...CRYPTO_TOOLS, ...KIT, ...KIT2, ...DATA_TOOLS, ...MACRO_TOOLS, ...MEDIA_TOOLS, ...CRYPTO_MARKETS_TOOLS, ...PRICE_FEED_TOOLS, ...FORECAST_TOOLS, ...PREDICTION_MARKET_TOOLS, ...FINANCE_MATH_TOOLS, ...USAGE_TOOLS]) C[t.route] = t;
  for (const q of ["convert currency", "convert usd to eur", "convert 100 dollars to euros", "convert dollars to euros", "currency converter", "exchange currency"]) {
    const r = findTools(C, q, {});
    ok(r.results[0]?.slug === "fx-rate" && r.rarestTermCovered === true, `"${q}" -> fx-rate as a strong match (got ${r.results.slice(0, 3).map((x) => x.slug).join(", ")}, covered ${r.rarestTermCovered})`);
  }
  // Controls: crypto and unit phrasings keep their own tools.
  for (const q of ["convert eth to usd", "bitcoin price in usd", "convert miles to kilometers", "convert php to python", "try base64 decode"]) {
    const r = findTools(C, q, {});
    ok(r.results[0]?.slug !== "fx-rate", `"${q}" is not sent to fx-rate (got ${r.results[0]?.slug})`);
  }
  {
    const r = findTools(C, "convert yen to dollars", {});
    ok(/^fx-/.test(r.results[0]?.slug || "") && r.rarestTermCovered === true, `"convert yen to dollars" -> an fx tool as a strong match (got ${r.results[0]?.slug}, covered ${r.rarestTermCovered})`);
  }
  // A money word outside a conversion still defines the task: a query whose
  // only uncovered word is the currency stays a miss, never a confident hit.
  for (const q of ["yuan devaluation", "jpy volatility", "dollar index", "pay in euros", "gbp interest rate", "invoice total in euros", "sterling exchange rate", "tip calculator dollars", "inflation in euros", "peso inflation argentina", "cpi us dollar"]) {
    const r = findTools(C, q, {});
    ok(r.rarestTermCovered === false, `"${q}" stays a weak match (top ${r.results[0]?.slug}, rarest "${r.rarestTerm}", covered ${r.rarestTermCovered})`);
  }
  // A crypto word anywhere keeps the currency rule off, even beside two fiat codes.
  const { applyCurrencyTerms } = await import("../src/find.js");
  for (const terms of [["crypto", "currency", "converter", "usd", "eur"], ["convert", "eth", "usd", "eur"], ["bitcoin", "dollars", "euros"]]) {
    const t = [...terms];
    ok(applyCurrencyTerms(t) === false && !t.includes("forex"), `[${terms.join(" ")}] is not a fiat conversion (terms ${t.join(" ")})`);
  }
  for (const q of ["crypto currency converter usd eur", "convert eth to usd and eur", "bitcoin price in dollars and euros"]) {
    const r = findTools(C, q, {});
    ok(!/^fx-/.test(r.results[0]?.slug || ""), `"${q}" stays with the crypto tools (got ${r.results[0]?.slug})`);
  }
  // Money named without a conversion keeps every word: no synthetic term.
  for (const terms of [["g10", "fx", "dashboard", "usd"], ["currency", "usd", "eur", "dashboard"]]) {
    const t = [...terms];
    ok(applyCurrencyTerms(t) === false && !t.includes("forex"), `[${terms.join(" ")}] asks for no conversion (terms ${t.join(" ")})`);
  }
  // Two different currencies joined ("to", "vs", "/") or beside a rate word
  // ask for a conversion without the verb, and a currency the fx tools do not
  // spell out still reaches the converter, never another *-convert tool.
  for (const q of ["rupee to peso", "rupees to pesos", "convert rupees to pesos", "euro to yen", "eur/jpy", "inr vs mxn", "euro yen rate"]) {
    const r = findTools(C, q, {});
    ok(r.results[0]?.slug === "fx-rate" && r.rarestTermCovered === true, `"${q}" -> fx-rate as a strong match (got ${r.results.slice(0, 3).map((x) => x.slug).join(", ")}, covered ${r.rarestTermCovered})`);
  }
  // Listed side by side, joined by "and", or one currency twice: no conversion.
  for (const [terms, q] of [[["currency", "usd", "eur", "dashboard"], "currency usd eur dashboard"], [["translate", "dollars", "euros"], "translate it in dollars and euros"], [["dollar", "dollars"], "dollar to dollars"], [["usd", "dollar", "rate"], "usd dollar rate"]]) {
    const t = [...terms];
    ok(applyCurrencyTerms(t, q) === false && !t.includes("forex"), `"${q}" asks for no conversion (terms ${t.join(" ")})`);
  }
  for (const q of ["translate it in dollars and euros", "translate in dollars and euros"]) {
    const r = findTools(C, q, {});
    ok(!/^fx-/.test(r.results[0]?.slug || "") && !(r.results.length && r.rarestTermCovered === true && /^fx-/.test(r.results[0]?.slug || "")), `"${q}" is not a confident fx match (top ${r.results[0]?.slug}, covered ${r.rarestTermCovered})`);
  }
  const named = ["convert", "dollars", "euros"];
  ok(applyCurrencyTerms(named) === true && named.includes("usd") && named.includes("eur") && named.includes("forex"), `currency names read as their codes in a conversion (terms ${named.join(" ")})`);
}

// A query that is exactly a tool's slug or one of its aliases ranks that tool first.
{
  const mk = (slug, extra = {}) => ({ route: `POST /api/${slug}`, slug, name: slug.replace(/-/g, " "), category: "validation", price: "$0.001", description: `${slug.replace(/-/g, " ")} validate check digits identifier`, tags: ["validate", "check-digit"], ...extra });
  const cat = Object.fromEntries([
    mk("uuid-validate", { tags: ["validate", "uuid", "id"] }), mk("card-validate", { tags: ["validate", "card", "id"] }), mk("gtin-validate", { tags: ["validate", "gtin", "id"] }),
    mk("iban-validate", { tags: ["validate", "iban", "id"] }), mk("isbn-validate", { tags: ["validate", "isbn", "id"] }), mk("id-validate"),
    mk("eth-call", { description: "eth_call balance read getbalance", tags: ["eth", "balance", "rpc"] }), mk("wallet-balance", { aliases: ["eth_getbalance"], description: "wallet balance", tags: ["balance"] }),
  ].map((t) => [t.route, t]));
  const top = (q) => findTools(cat, q, { k: 5 }).results.map((x) => x.slug);
  ok(top("id-validate")[0] === "id-validate", `"id-validate" ranks id-validate first (${top("id-validate").join(", ")})`);
  ok(top("ID-Validate ")[0] === "id-validate", "the match ignores case and surrounding space");
  ok(top("eth_getbalance")[0] === "wallet-balance", `a query that is a tool's alias ranks it first (${top("eth_getbalance").join(", ")})`);
  ok(top("validate an id")[0] !== undefined, "an ordinary query is ranked as before");
  // A one-word alias is a word, not an identifier: it keeps normal ranking.
  const cat2 = Object.fromEntries([
    mk("fx-rate", { category: "data", description: "currency exchange rate", tags: ["fx", "rate", "currency"] }),
    mk("feedback", { category: "agent", description: "leave a verdict on a call", tags: ["feedback"], aliases: ["rate", "review", "verdict"] }),
    mk("x402-audit", { category: "x402", description: "audit an x402 seller", tags: ["audit", "x402"] }),
    mk("audit-report", { category: "research", description: "a report", tags: ["report"], aliases: ["audit"] }),
  ].map((t) => [t.route, t]));
  const top2 = (q) => findTools(cat2, q, { k: 5 }).results.map((x) => x.slug);
  ok(top2("rate")[0] === "fx-rate", `"rate" (a one-word alias of feedback) still ranks fx-rate first (${top2("rate").join(", ")})`);
  ok(top2("audit")[0] === "x402-audit", `"audit" (a one-word alias of audit-report) still ranks x402-audit first (${top2("audit").join(", ")})`);
}

// asn-info reads an IP to ASN mapping service that is not a geolocation
// source, so a geolocation search does not find it as a match: no alias,
// tag or name offers it for that, and a bare "ip" word stays under the weak
// floor /api/find reads (FIND_WEAK_SCORE, 3) with the rarest word uncovered.
{
  const cat = {};
  for (const t of NETWORK_TOOLS2) cat[t.route] = t;
  const asn = NETWORK_TOOLS2.find((t) => t.slug === "asn-info");
  ok(!(asn.aliases || []).some((a) => /geo|location/i.test(a)) && !(asn.tags || []).some((t) => /geo/i.test(t)) && !/geolocation/i.test(asn.name), `asn-info carries no geolocation alias, tag or name (${asn.name}; ${(asn.aliases || []).join(", ")})`);
  for (const q of ["ip geolocation", "geoip", "geolocate ip", "ip-geolocation"]) {
    const r = findTools(cat, q, { k: 3 });
    const top = r.results?.[0];
    const served = top?.slug === "asn-info" && top.score >= 3 && r.rarestTermCovered !== false;
    ok(!served, `"${q}" does not resolve to asn-info (top ${top?.slug || "none"} ${Math.round(top?.score ?? 0)}, rarest ${r.rarestTerm} covered ${r.rarestTermCovered})`);
  }
  ok(findTools(cat, "ip to asn", { k: 3 }).results?.[0]?.slug === "asn-info", "control: an ASN search still finds asn-info first");
}

// ip-info reads the address and its PTR record, never a location: its name
// says what it returns, no name, alias, tag or description word offers it for
// a geolocation search, and such a search does not read it as served (a
// score at the weak floor /api/find reads, FIND_WEAK_SCORE 3, with the
// rarest word covered).
{
  const cat = {};
  for (const t of [...KIT, ...NETWORK_TOOLS2]) cat[t.route] = t;
  const ipInfo = KIT.find((t) => t.slug === "ip-info");
  ok(ipInfo?.name === "IP address type and reverse DNS" && ipInfo.route === "POST /api/ip-info", `ip-info is named for what it returns (${ipInfo?.name})`);
  const words = [ipInfo.name, ipInfo.description, ipInfo.category, ...(ipInfo.tags || []), ...(ipInfo.aliases || [])].join(" ");
  ok(!/geo|locat|city|latitude|longitude/i.test(words.replace(/no country, city or network owner/, "")), "ip-info carries no geolocation word in its name, description, category, tags or aliases");
  // Longer wordings ("geolocate an ip address") are read against the whole
  // catalog in the find-misses gaps (scripts/test-find-misses-corpus.js).
  for (const q of ["ip geolocation", "geoip", "geolocate ip", "ip-geolocation", "ip location"]) {
    const r = findTools(cat, q, { k: 3 });
    const top = r.results?.[0];
    const served = top?.slug === "ip-info" && top.score >= 3 && r.rarestTermCovered !== false;
    ok(!served, `"${q}" does not resolve to ip-info (top ${top?.slug || "none"} ${Math.round(top?.score ?? 0)}, rarest ${r.rarestTerm} covered ${r.rarestTermCovered})`);
  }
  for (const q of ["reverse dns for an ip", "is this ip address private", "ptr record of an ip"]) {
    ok(findTools(cat, q, { k: 3 }).results?.[0]?.slug === "ip-info", `control: "${q}" still finds ip-info first`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
