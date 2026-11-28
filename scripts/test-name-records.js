// name-records (src/tools/enrich-kit.js): facts only, offline. Wikidata and
// Wikimedia Commons are stubbed at fetch; names resolve in-process.
//   1. the answer relays recorded statements (creator, publisher, inception),
//      the US trademark serial numbers Wikidata records with their USPTO
//      record links, and the Commons file page's author, license and
//      restriction tags, each with its source link and read time;
//   2. it never carries a conclusion: no copyright status, license field or
//      "owned by" from Wikidata, no verdict wording in its own text, and the
//      fixed scope field is always present;
//   3. the USPTO credit line rides an answer exactly when it prints a USPTO link;
//   4. the image match is Commons SHA-1 only (byte-identical files), match and
//      no match; an item with no image; a capped list says so in fields;
//   5. an upstream 429 or outage is a 5xx (never a charged 200), and the
//      Wikimedia reads run one at a time.
//
//   node scripts/test-name-records.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash } from "node:crypto";
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { ENRICH_TOOLS, NAME_RECORDS_SCOPE, USPTO_CREDIT, usptoRecordUrl, NAME_RECORDS_IMAGE_MAX_BYTES } from "../src/tools/enrich-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = ENRICH_TOOLS.find((t) => t.slug === "name-records");
ok(!!tool, "name-records is in the enrich kit");
const run = (input) => tool.handler(input);

// The verdict words the answer's own text and the description never hold.
// A file page's recorded license is the uploader's line, relayed under
// `recordedOnFilePage`, and is read apart (below).
const VERDICT = [/public domain/i, /free to use/i, /infring/i, /\brisk/i, /\bsafe/i, /\bcleared\b/i, /owned by/i, /copyright status/i];
const verdictHits = (text) => VERDICT.filter((re) => re.test(text)).map(String);
function withoutRecorded(answer) {
  return JSON.parse(JSON.stringify(answer, (k, v) => (k === "recordedOnFilePage" || k === "label" || k === "description" ? undefined : v)));
}

// ---------------------------------------------------------------- fixtures
const LOGO_BYTES = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><rect width='4' height='4'/></svg>");
const LOGO_SHA1 = createHash("sha1").update(LOGO_BYTES).digest("hex");
const stmt = (prop, value, type = "wikibase-entityid", rank = "normal", datatype) => ({
  rank,
  mainsnak: { snaktype: "value", property: prop, ...(datatype ? { datatype } : {}), datavalue: type === "wikibase-entityid" ? { type, value: { id: value } } : type === "time" ? { type, value: { time: value } } : { type: "string", value } },
});
const ENTITIES = {
  Q100: {
    labels: { en: { value: "Example Show" } }, descriptions: { en: { value: "animated television series" } },
    claims: {
      P170: [stmt("P170", "Q201"), stmt("P170", "Q202")],
      P123: [stmt("P123", "Q203")],
      P272: [stmt("P272", "Q204")],
      P571: [stmt("P571", "+2010-01-04T00:00:00Z", "time")],
      P4584: [stmt("P4584", "Q205")],
      P10482: [stmt("P10482", "85722192", "string"), stmt("P10482", "85722192", "string"), stmt("P10482", "12AB", "string")],
      P154: [stmt("P154", "Logo de Example Show.svg", "string", "normal", "commonsMedia")],
      // Recorded on the item and never relayed: copyright status, copyright
      // license, owned by.
      P6216: [stmt("P6216", "Q19652")],
      P275: [stmt("P275", "Q6938433")],
      P127: [stmt("P127", "Q206")],
    },
  },
  Q101: { labels: { en: { value: "Example Show, season 1" } }, descriptions: { en: { value: "season of television series" } }, claims: { P4584: [stmt("P4584", "Q205")] } },
  Q102: { labels: { en: { value: "Example Character" } }, descriptions: { en: { value: "fictional character" } }, claims: { P170: [stmt("P170", "Q201")], P18: [stmt("P18", "Example Character.png", "string", "normal", "commonsMedia")] } },
};
const LABELS = { Q201: "First Creator", Q202: "Second Creator", Q203: "Example Publisher", Q204: "Example Studio", Q205: "Pilot Episode", Q206: "Holding Company", Q19652: "public domain", Q6938433: "CC0" };
const FILE_PAGES = {
  "Logo de Example Show.svg": { Artist: "<a href=\"//commons.wikimedia.org/wiki/User:Uploader\" title=\"User:Uploader\">Uploader&amp;Co</a>", LicenseShortName: "CC BY-SA 4.0", LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", Restrictions: "trademarked" },
  "Example Character.png": { Artist: "<p>Studio Artist</p>", LicenseShortName: "Public domain", Restrictions: "trademarked|personality" },
};
const page = (title, m) => ({
  title: `File:${title}`,
  imageinfo: [{ descriptionurl: `https://commons.wikimedia.org/wiki/File:${title.replace(/ /g, "_")}`, extmetadata: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v, source: "commons-desc-page" }])) }],
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let mode = {};
let reads = [];
let inFlight = 0, maxInFlight = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const q = u.searchParams;
  reads.push(`${u.host} ${q.get("action")}${q.get("list") ? `:${q.get("list")}` : ""}${q.get("generator") ? `:${q.get("generator")}` : ""}`);
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 2));
    if (u.host === "www.wikidata.org") {
      if (mode.wikidata) return new Response("busy", { status: mode.wikidata });
      if (q.get("action") === "wbsearchentities") {
        const term = q.get("search");
        if (term === "Nothing Here") return json({ search: [], success: 1 });
        if (term === "Season Only") return json({ search: [{ id: "Q101", label: "Example Show, season 1" }], success: 1 });
        if (term === "Character") return json({ search: [{ id: "Q102", label: "Example Character" }], success: 1 });
        const hits = ["Q100", "Q101", "Q102", "Q103", "Q104", "Q105", "Q106", "Q107", "Q108", "Q109"].map((id) => ({ id, label: id, description: "x" }));
        return json({ search: hits, "search-continue": 10, success: 1 });
      }
      if (q.get("action") === "wbgetentities") {
        const ids = q.get("ids").split("|");
        if (q.get("props") === "labels") return json({ entities: Object.fromEntries(ids.map((id) => [id, { labels: LABELS[id] ? { en: { value: LABELS[id] } } : {} }])) });
        return json({ entities: Object.fromEntries(ids.map((id) => [id, ENTITIES[id] ? { id, ...ENTITIES[id] } : { id, missing: "" }])) });
      }
    }
    if (u.host === "commons.wikimedia.org") {
      if (mode.commons) return new Response("busy", { status: mode.commons });
      if (q.get("generator") === "allimages") {
        if (q.get("gaisha1") === LOGO_SHA1) return json({ batchcomplete: true, query: { pages: [page("Logo de Example Show.svg", FILE_PAGES["Logo de Example Show.svg"])] } });
        return json({ batchcomplete: true });
      }
      if (q.get("titles")) {
        const titles = q.get("titles").split("|").map((t) => t.replace(/^File:/, ""));
        return json({ batchcomplete: true, query: { pages: titles.map((t) => (FILE_PAGES[t] ? page(t, FILE_PAGES[t]) : { title: `File:${t}`, missing: true })) } });
      }
    }
    return new Response("not stubbed", { status: 404 });
  } finally { inFlight--; }
};
const undoDns = stubGuardResolver(offlineGuardAnswer);

async function status(input) {
  try { await run(input); return 200; } catch (e) { return e.statusCode || 500; }
}

try {
  // --- catalog -------------------------------------------------------------
  ok(tool.route === "POST /api/name-records" && tool.category === "data" && tool.price === "$0.005", `route, category and price (${tool.route} ${tool.price})`);
  ok(WALLET_ONLY_SLUGS.has("name-records"), "wallet-only: it reaches the network on its own example");
  ok(JSON.stringify(tool.upstreamHosts) === JSON.stringify(["www.wikidata.org", "commons.wikimedia.org"]), "declares its upstream hosts as a literal list");
  ok(!tool.resaleCleared, "not cleared for a third party's marketplace");
  ok(verdictHits(tool.description).length === 0 && verdictHits(NAME_RECORDS_SCOPE).length === 0, `the description and the scope field hold no verdict wording (${verdictHits(tool.description + NAME_RECORDS_SCOPE)})`);
  ok(/no determination of ownership or of permitted use/.test(NAME_RECORDS_SCOPE), "the scope field says the answer makes no determination of ownership or permitted use");
  ok(USPTO_CREDIT === "Source: United States Patent and Trademark Office, www.uspto.gov", "the USPTO credit is the line its terms request");
  ok(usptoRecordUrl("85722192") === "https://tsdr.uspto.gov/#caseNumber=85722192&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch", "the USPTO record link is the TSDR status page for the serial number");
  const ex = tool.discovery.output.example;
  ok(ex.scope === NAME_RECORDS_SCOPE && ex.usptoCredit === USPTO_CREDIT && ex.items[0].trademarkSerialNumbers[0].usptoRecordUrl, "the published example carries the scope field and the USPTO credit beside its USPTO link");

  // --- 1. happy path -------------------------------------------------------
  reads = []; maxInFlight = 0;
  const a = await run({ name: "Example Show", limit: 1 });
  const it = a.items[0];
  ok(a.found === true && a.items.length === 1 && it.id === "Q100" && it.url === "https://www.wikidata.org/wiki/Q100" && it.source === "wikidata.org", "the best match with its Wikidata link");
  ok(/^\d{4}-\d{2}-\d{2}T/.test(it.readAt) && /^\d{4}-\d{2}-\d{2}T/.test(it.commonsFile?.readAt), "each record carries its read time");
  const r = it.recordedOnWikidata;
  ok(r.creator?.map((c) => c.label).join() === "First Creator,Second Creator" && r.publisher?.[0]?.label === "Example Publisher" && r.productionCompany?.[0]?.label === "Example Studio", `creator, publisher and production company with labels (${JSON.stringify(r).slice(0, 200)})`);
  ok(r.inception?.[0] === "2010-01-04T00:00:00Z" && r.firstAppearance?.[0]?.label === "Pilot Episode", "inception and first appearance as recorded");
  const tm = it.trademarkSerialNumbers;
  ok(tm.length === 2 && tm[0].serialNumber === "85722192" && tm[0].usptoRecordUrl === usptoRecordUrl("85722192") && tm[0].trademarkDetails === "linked" && tm[0].recordedOn === "wikidata.org", `the recorded serial number, its USPTO link and trademarkDetails "linked" (${JSON.stringify(tm[0])})`);
  ok(tm[1].serialNumber === "12AB" && tm[1].usptoRecordUrl === null, "a recorded value that is not an 8-digit serial number gets no link");
  ok(tm.every((t) => !("owner" in t) && !("status" in t) && !("classes" in t)), "no trademark owner, status or class: those are at the link");
  const cf = it.commonsFile;
  ok(it.image?.fromProperty === "P154 logo image" && cf?.file === "File:Logo de Example Show.svg" && cf.url === "https://commons.wikimedia.org/wiki/File:Logo_de_Example_Show.svg" && cf.source === "commons.wikimedia.org", "the item's image and its Commons file page");
  ok(cf.recordedOnFilePage.author === "Uploader&Co" && cf.recordedOnFilePage.license === "CC BY-SA 4.0" && cf.recordedOnFilePage.licenseUrl === "https://creativecommons.org/licenses/by-sa/4.0" && JSON.stringify(cf.recordedOnFilePage.restrictions) === '["trademarked"]', `the file page's author (tags dropped), license and restriction tag as recorded (${JSON.stringify(cf.recordedOnFilePage)})`);
  ok(a.scope === NAME_RECORDS_SCOPE && a.usptoCredit === USPTO_CREDIT && a.sources.some((s) => s.name === "Wikidata") && a.sources.some((s) => s.name === "Wikimedia Commons"), "the scope field, the USPTO credit and both sources named");

  // --- 2. nothing that reads as a conclusion -------------------------------
  const flat = JSON.stringify(a);
  ok(!/P6216|P275|P127|copyrightStatus|copyrightLicense|ownedBy|Holding Company/.test(flat) && !/"label":"public domain"|"label":"CC0"/.test(flat), "Wikidata's copyright status, copyright license and owned-by are never relayed");
  ok(verdictHits(JSON.stringify(withoutRecorded(a))).length === 0, `the answer's own text holds no verdict wording (${verdictHits(JSON.stringify(withoutRecorded(a)))})`);
  const ch = await run({ name: "Character" });
  const recLicense = ch.items[0].commonsFile?.recordedOnFilePage?.license;
  ok(recLicense === "Public domain" && JSON.stringify(ch.items[0].commonsFile.recordedOnFilePage.restrictions) === '["trademarked","personality"]', "a file page's own license line is relayed as recorded, every restriction tag kept");
  ok(verdictHits(JSON.stringify(withoutRecorded(ch))).length === 0 && JSON.stringify(ch).split("Public domain").length === 2, "and it appears once, only under recordedOnFilePage");
  ok(ch.scope === NAME_RECORDS_SCOPE && !("usptoCredit" in ch), "an answer with no USPTO link carries the scope field and no USPTO credit");

  // --- 3. USPTO credit iff a USPTO link ------------------------------------
  const both = [a, ch, await run({ name: "Season Only" }), await run({ name: "Nothing Here" })];
  ok(both.every((x) => ("usptoCredit" in x) === /tsdr\.uspto\.gov/.test(JSON.stringify(x))), "the USPTO credit is present exactly when a USPTO link is");

  // --- 4. no image, capped list, image match --------------------------------
  reads = [];
  const s = await run({ name: "Season Only" });
  ok(s.items[0].image === null && s.items[0].commonsFile === null && !reads.some((x) => x.startsWith("commons")), "an item with no image: no Commons file and no Commons read");
  const none = await run({ name: "Nothing Here" });
  ok(none.found === false && none.items.length === 0 && none.complete === true && /No Wikidata item matched/.test(none.note) && none.scope === NAME_RECORDS_SCOPE, "no match: found false, an empty complete list and the scope field");
  const cap = await run({ name: "Example", limit: 2 });
  ok(cap.returned === 2 && cap.matched === 10 && cap.truncated === true && cap.complete === false && cap.matchedIsLowerBound === true, `a capped list says so in fields (${JSON.stringify({ returned: cap.returned, matched: cap.matched, truncated: cap.truncated, lb: cap.matchedIsLowerBound })})`);
  const clamped = await run({ name: "Example", limit: 9 });
  ok(clamped.returned === 3 && clamped.requestedExceededMax === true && clamped.requestedMax === 9, "a limit past the maximum is clamped and says so (3 of the 10 stubbed ids exist)");
  ok((await run({ name: "Example" })).returned === 3, "the default is three items");
  const m = await run({ name: "Example Show", limit: 1, image: LOGO_BYTES.toString("base64") });
  ok(m.imageMatch?.found === true && m.imageMatch.byteIdenticalFilesOnly === true && m.imageMatch.sha1 === LOGO_SHA1 && m.imageMatch.files[0].file === "File:Logo de Example Show.svg" && m.imageMatch.files[0].recordedOnFilePage.license === "CC BY-SA 4.0" && m.imageMatch.complete === true, "the exact-copy match: byte-identical only, with the matched file's recorded facts");
  ok(/byte|re-encoded/.test(m.imageMatch.note) && /No other image search/.test(m.imageMatch.note), "the match says it reads byte-identical files only and makes no other image search");
  const dm = await run({ name: "Example Show", limit: 1, image: `data:image/svg+xml;base64,${LOGO_BYTES.toString("base64")}` });
  ok(dm.imageMatch?.found === true, "a data URL is read the same");
  const nm = await run({ name: "Example Show", limit: 1, image: Buffer.from("other bytes").toString("base64") });
  ok(nm.imageMatch?.found === false && nm.imageMatch.files.length === 0 && nm.imageMatch.byteIdenticalFilesOnly === true, "no exact copy on Commons: found false");
  ok(!("imageMatch" in a), "no image, no image match field");

  // --- input bounds ---------------------------------------------------------
  ok(await status({}) === 400 && await status({ name: "   " }) === 400 && await status({ name: "x".repeat(201) }) === 400 && await status({ name: "a\u0001b" }) === 400, "name: required, at most 200 characters, no control characters");
  ok(await status({ name: "Example", limit: 0 }) === 400 && await status({ name: "Example", limit: 1.5 }) === 400, "limit: a whole number from 1");
  ok(await status({ name: "Example", image: 5 }) === 400 && await status({ name: "Example", image: "not base64!" }) === 400 && await status({ name: "Example", image: "abc" }) === 400 && await status({ name: "Example", image: "data:text;base64,QUJD" }) === 400, "image: a base64 string or a well-formed data URL");
  const big = Buffer.alloc(NAME_RECORDS_IMAGE_MAX_BYTES + 3, 1).toString("base64");
  ok(await status({ name: "Example", image: big }) === 413, "image: over 4 MB decoded is refused");

  // --- 5. upstream refusal and outage are 5xx; reads one at a time -----------
  ok(maxInFlight === 1, `Wikimedia reads run one at a time (most in flight: ${maxInFlight})`);
  mode = { wikidata: 429 };
  ok(await status({ name: "Example Show" }) === 503, "a Wikidata 429 is a retryable 503, never a charged 200");
  mode = { wikidata: 500 };
  ok(await status({ name: "Example Show" }) === 502, "a Wikidata outage is a 502");
  mode = { commons: 429 };
  ok(await status({ name: "Example Show", limit: 1 }) === 503, "a Commons 429 is a 503");
  mode = { commons: 503 };
  ok(await status({ name: "Season Only", image: LOGO_BYTES.toString("base64") }) === 502, "a Commons outage on the image match is a 502");
  mode = {};
} catch (e) {
  ok(false, `a stubbed run threw: ${e?.stack || e}`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
