// Entity/enrichment kit — who-is-this-company/person/site lookups for agents:
// GLEIF legal-entity records (LEI), Wikidata entity facts, GitHub repository
// enrichment, and site favicon capture.
//
// Every upstream is KEYLESS — no new required env vars. github-repo optionally
// sends `Authorization: Bearer ${GITHUB_TOKEN}` when that env var is set (lifts
// the shared 60 req/hr/IP ceiling to 5k/hr); env-gated no-op if unset, never
// required. All four tools reach the network and live in WALLET_ONLY_SLUGS.
//
// SSRF: favicon-grab takes a caller URL and rides safeFetch/assertPublicUrl
// end-to-end (page fetch AND the icon fetch derived from the page's HTML).
// The other tools hit fixed hosts but still ride the guarded dispatcher by
// convention. github-repo path segments are validated before interpolation:
// owner gets GitHub's real username charset (no dots at all), repo keeps dots
// (.github, repo.js are legit) but "."/".." and any ".." substring are
// rejected — otherwise owner=".." would URL-normalize /repos/../user into an
// arbitrary single-segment GitHub API endpoint spent on OUR token budget.
//
// Covered by scripts/test-enrich-kit.js (offline validation; live upstream
// checks opt-in via ENRICH_LIVE_TEST=1).

import { ssrfDispatcher, safeFetch } from "./fetch-guard.js";
import { assertRobotsAllow } from "./robots-gate.js";

import { upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
import { upstreamKeyFor, runWithUpstreamKey, upstreamKeyRefusedError, upstreamKeySentence } from "../upstream-key.js";
import { partialFields, clampFields } from "../partial-answer.js";
import { createHash } from "node:crypto";
import { atCeiling, ceilingCutError, assertBeforeCeiling } from "../run-ceiling.js";
// DEADLINES (src/upstream-deadline.js): each read under its own cap and the
// handler budget; a read that outlives it is a 503 naming the upstream and the
// step, never a 504. The reads answered in 0.05 to 1.6 s when measured
// (2026-10-14).
const TIMEOUT_MS = 12_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Small JSON GET against a fixed keyless upstream. Hosts are hardcoded by the
// handlers (except favicon-grab, which uses safeFetch instead), so this is not
// an SSRF surface, but every fetch still rides the guarded dispatcher.
// 404 passes through as { status: 404 } so handlers can return structured
// misses instead of errors.
async function getJson(url, upstream, headers = {}, step = "lookup", opts = {}) {
  const host = new URL(url).host;
  return WIKIMEDIA_HOSTS.has(host) ? oneReadPerHost(host, upstream, () => readJson(url, upstream, headers, step, opts)) : readJson(url, upstream, headers, step, opts);
}

// ONE READ PER WIKIMEDIA HOST, across the server (the Wikimedia robot
// policy's concurrency of 1 for an unauthenticated client, and the API usage
// guidelines' bar on concurrent connections): every Wikidata or Commons read
// any caller makes, from any tool in this kit, waits for the one before it on
// the same host to end, body included. The wait is bounded: at most
// `maxWaiters` reads wait per host and each waits at most `waitMs`, then
// answers a retryable 503 naming the upstream (a 5xx, never charged); inside
// a run with a ceiling (src/run-ceiling.js) the wait also ends at the ceiling
// as its 504. A read that ends, however it ends, hands the slot to the
// longest waiter.
const WIKIMEDIA_HOSTS = new Set(["www.wikidata.org", "commons.wikimedia.org"]);
export const WIKIMEDIA_LANE = { waitMs: 8_000, maxWaiters: 24 };
const wikimediaLanes = new Map();
async function oneReadPerHost(host, upstream, read) {
  let lane = wikimediaLanes.get(host);
  if (!lane) wikimediaLanes.set(host, (lane = { busy: false, waiters: [] }));
  if (lane.busy) {
    if (lane.waiters.length >= WIKIMEDIA_LANE.maxWaiters) throw bad(`${upstream} is busy with other reads - retry shortly`, 503);
    await new Promise((resolve, reject) => {
      const waiter = {};
      const done = (err) => {
        clearTimeout(timer);
        cancelCeiling();
        const at = lane.waiters.indexOf(waiter);
        if (at >= 0) lane.waiters.splice(at, 1);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => done(bad(`${upstream} is busy with other reads - retry shortly`, 503)), WIKIMEDIA_LANE.waitMs);
      const cancelCeiling = atCeiling(() => done(ceilingCutError()));
      waiter.grant = () => done();
      lane.waiters.push(waiter);
    });
  } else {
    lane.busy = true;
  }
  try {
    assertBeforeCeiling();
    return await read();
  } finally {
    const next = lane.waiters[0];
    if (next) next.grant(); else lane.busy = false;
  }
}

/** Test view: the reads waiting per Wikimedia host and whether one runs. */
export function wikimediaLaneState() {
  return Object.fromEntries([...wikimediaLanes].map(([h, l]) => [h, { busy: l.busy, waiting: l.waiters.length }]));
}

async function readJson(url, upstream, headers = {}, step = "lookup", { buyerKey = false } = {}) {
  const ctx = { label: upstream, step, timeoutMs: TIMEOUT_MS, tag: "[enrich]" };
  const res = await upstreamFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Agent402/1.0 (+https://agent402.tools)", ...headers },
    dispatcher: ssrfDispatcher,
  }, ctx);
  if (res.status === 429) throw bad(`${upstream} rate limit reached - retry shortly`, 503);
  // A buyer's own key the upstream refuses (src/upstream-key.js): 401 or 403,
  // uncharged, never retried with ours. A spent quota stays the 503 below.
  if (buyerKey && (res.status === 401 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0"))) throw upstreamKeyRefusedError(res.status, upstream);
  if (res.status === 403) {
    // GitHub reports an exhausted per-IP quota as 403 with a zeroed remaining
    // header — that's capacity, not authorization; surface as retryable 503.
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      throw bad(`${upstream} rate limit reached - retry shortly`, 503);
    }
    throw bad(`${upstream} refused the request (HTTP 403)`, 502);
  }
  if (!res.ok && res.status !== 404) throw bad(`${upstream} error (HTTP ${res.status})`, 502);
  let data = null;
  try { data = await bodyUnderDeadline(res.json(), ctx); } catch (err) {
    if (err?.statusCode) throw err;
    if (res.status !== 404) throw bad(`${upstream} returned non-JSON`, 502);
  }
  return { status: res.status, data };
}

// ============================================================================
// lei-lookup — GLEIF (Global Legal Entity Identifier Foundation) registry.
// ============================================================================
const LEI_RE = /^[A-Z0-9]{20}$/;
const GLEIF = "https://api.gleif.org/api/v1";

function leiRecordSummary(rec) {
  const a = rec?.attributes || {};
  const e = a.entity || {};
  const r = a.registration || {};
  const addr = (x) => (x ? { city: x.city ?? null, region: x.region ?? null, country: x.country ?? null } : null);
  return {
    lei: a.lei ?? null,
    legalName: e.legalName?.name ?? null,
    otherNames: (e.otherNames || []).map((n) => n.name).filter(Boolean).slice(0, 10),
    jurisdiction: e.jurisdiction ?? null,
    category: e.category ?? null,
    legalForm: e.legalForm?.id ?? null,
    entityStatus: e.status ?? null,
    legalAddress: addr(e.legalAddress),
    headquartersAddress: addr(e.headquartersAddress),
    registration: {
      status: r.status ?? null,
      initialDate: r.initialRegistrationDate ?? null,
      lastUpdated: r.lastUpdateDate ?? null,
      nextRenewal: r.nextRenewalDate ?? null,
      corroborationLevel: r.corroborationLevel ?? null,
    },
  };
}

// Direct/ultimate parent — 404 from GLEIF means "no parent reported (or a
// reporting exception)", a normal answer, not an error.
async function leiParent(lei, which) {
  const { status, data } = await getJson(`${GLEIF}/lei-records/${lei}/${which}`, "GLEIF");
  if (status === 404 || !data?.data) return null;
  const a = data.data.attributes || {};
  return { lei: a.lei ?? null, legalName: a.entity?.legalName?.name ?? null };
}

// ============================================================================
// wikidata-entity — Wikidata wbgetentities / wbsearchentities.
// ============================================================================
const WD_API = "https://www.wikidata.org/w/api.php";
const QID_RE = /^Q\d{1,10}$/;

// Curated property map — the enrichment facts agents actually ask for.
// Item-valued claims get their labels resolved in one batched follow-up call.
const WD_PROPS = {
  P31: "instanceOf",
  P571: "inception",
  P17: "country",
  P159: "headquartersLocation",
  P452: "industry",
  P112: "foundedBy",
  P169: "chiefExecutiveOfficer",
  P488: "chairperson",
  P1128: "employees",
  P2139: "totalRevenue",
  P856: "officialWebsite",
  P1278: "lei",
  P249: "tickerSymbol",
  P414: "stockExchange",
  P946: "isin",
  P154: "logoImage",
  P18: "image",
  // person-shaped facts
  P569: "dateOfBirth",
  P570: "dateOfDeath",
  P27: "citizenship",
  P106: "occupation",
  P108: "employer",
};
const WD_MAX_VALUES_PER_PROP = 8;

// Render a mainsnak datavalue into plain JSON. Item references come out as
// { id } and get a label attached later.
function renderSnak(snak) {
  if (!snak || snak.snaktype !== "value") return null;
  const dv = snak.datavalue;
  if (!dv) return null;
  switch (dv.type) {
    case "wikibase-entityid":
      return { id: dv.value.id };
    case "time":
      return String(dv.value.time || "").replace(/^\+/, "");
    case "quantity":
      return String(dv.value.amount || "").replace(/^\+/, "");
    case "monolingualtext":
      return dv.value.text ?? null;
    case "globecoordinate":
      return { lat: dv.value.latitude, lon: dv.value.longitude };
    case "string":
      // commonsMedia filenames become a fetchable URL.
      if (snak.datatype === "commonsMedia") {
        return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(dv.value)}`;
      }
      return dv.value;
    default:
      return null;
  }
}

// The values of one property's statements: preferred rank first, then
// normal; deprecated dropped; repeated values (the same value with other
// qualifiers) kept once; at most `max`.
function wdValues(statements, max = WD_MAX_VALUES_PER_PROP) {
  if (!Array.isArray(statements) || !statements.length) return [];
  const ranked = [
    ...statements.filter((s) => s.rank === "preferred"),
    ...statements.filter((s) => s.rank === "normal"),
  ];
  const seen = new Set();
  return ranked
    .map((s) => renderSnak(s.mainsnak))
    .filter((v) => {
      if (v === null) return false;
      const key = JSON.stringify(v);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

/** The curated facts of one entity's claims, keyed by `props`' names. */
function wdFacts(claims, props) {
  const facts = {};
  for (const [prop, key] of Object.entries(props)) {
    const values = wdValues(claims?.[prop]);
    if (values.length) facts[key] = values;
  }
  return facts;
}

// One batched follow-up gives every item reference in these fact sets its
// English label (at most 50 ids). Labels are an enhancement: when the read
// fails, the ids stand alone.
async function wdAttachLabels(factSets) {
  const refIds = new Set();
  for (const facts of factSets) for (const values of Object.values(facts)) {
    for (const v of values) if (v && typeof v === "object" && v.id) refIds.add(v.id);
  }
  if (!refIds.size) return;
  const ids = [...refIds].slice(0, 50).join("|");
  try {
    const { data: labelData } = await getJson(
      `${WD_API}?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=labels&languages=en&format=json&origin=*`,
      "Wikidata"
    );
    const labelOf = (qid) => labelData?.entities?.[qid]?.labels?.en?.value ?? null;
    for (const facts of factSets) for (const values of Object.values(facts)) {
      for (const v of values) if (v && typeof v === "object" && v.id) v.label = labelOf(v.id);
    }
  } catch { /* labels are an enhancement — the Q-ids still stand alone */ }
}

// ============================================================================
// name-records — what public sources record for a name: Wikidata statements,
// the Commons file page of the item's image, the US trademark serial numbers
// Wikidata records (each linked to its USPTO record page), and, for a given
// image, the Commons file with the same SHA-1.
//
// Facts only. The answer relays records, each labeled with the source that
// holds it and the time it was read; it never concludes anything about
// ownership or use. Left out on purpose: Wikidata's copyright status (P6216)
// and copyright license (P275), which read as a conclusion they are not, and
// "owned by" (P127). Trademark owner, status and classes are at the USPTO
// link (`trademarkDetails: "linked"`); nothing is read from USPTO.
//
// Terms: Wikidata's data is CC0 and Structured Data on Commons is CC0; a
// file page's short fields (author name, license name, restriction tags) are
// relayed as recorded, never the image or the page's description text.
// Reads are one at a time per Wikimedia host across the server, whoever
// calls (oneReadPerHost, above).
// ============================================================================
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const NAME_RECORDS_PROPS = Object.freeze({
  P170: "creator",
  P50: "author",
  P287: "designedBy",
  P123: "publisher",
  P272: "productionCompany",
  P176: "manufacturer",
  P571: "inception",
  P577: "publicationDate",
  P4584: "firstAppearance",
  P144: "basedOn",
  P138: "namedAfter",
});
export const US_TRADEMARK_SERIAL_PROP = "P10482";
const NAME_IMAGE_PROPS = [["P18", "image"], ["P154", "logo image"]];
export const NAME_RECORDS_MAX_ITEMS = 5;
const NAME_RECORDS_DEFAULT_ITEMS = 3;
const NAME_RECORDS_SEARCH_LIMIT = 10;
export const NAME_RECORDS_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const NAME_RECORDS_IMAGE_B64_MAX = Math.ceil(NAME_RECORDS_IMAGE_MAX_BYTES / 3) * 4;
const NAME_RECORDS_SHA1_MATCH_MAX = 5;
const FILE_FIELD_MAX = 200;
export const USPTO_CREDIT = "Source: United States Patent and Trademark Office, www.uspto.gov";
export const NAME_RECORDS_SCOPE = "This answer lists what Wikidata and Wikimedia Commons record for this name, with links to the USPTO record pages Wikidata names, each with its source link and read time. It makes no determination of ownership or of permitted use.";
export const NAME_RECORDS_SOURCES = Object.freeze([
  Object.freeze({ name: "Wikidata", url: "https://www.wikidata.org", dataLicense: "CC0 1.0" }),
  Object.freeze({ name: "Wikimedia Commons", url: "https://commons.wikimedia.org", fileLicenses: "each file's license line as recorded on its file page" }),
]);
const NAME_RECORDS_AFFILIATION = "Not affiliated with or endorsed by the Wikimedia Foundation or the United States Patent and Trademark Office.";

/** The USPTO record page (TSDR) for an 8-digit US serial number. */
export function usptoRecordUrl(serial) {
  return `https://tsdr.uspto.gov/#caseNumber=${serial}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`;
}

// A Commons field is HTML (an author is often a link). Its text, tags
// dropped in one linear pass, the common entities decoded, whitespace
// collapsed and cut to FILE_FIELD_MAX characters.
function fileFieldText(html) {
  if (typeof html !== "string" || !html) return null;
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length && out.length < FILE_FIELD_MAX * 4; i++) {
    const c = html[i];
    if (inTag) { if (c === ">") { inTag = false; out += " "; } continue; }
    if (c === "<") { inTag = true; continue; }
    out += c;
  }
  const text = out
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, FILE_FIELD_MAX) : null;
}

// One Commons file page's recorded facts, from imageinfo's extmetadata.
function commonsFileFacts(page, readAt) {
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  if (!info) return null;
  const m = info.extmetadata || {};
  const restrictions = String(m.Restrictions?.value ?? "").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const licenseUrl = typeof m.LicenseUrl?.value === "string" && /^https?:\/\//.test(m.LicenseUrl.value) ? m.LicenseUrl.value.slice(0, 300) : null;
  return {
    file: page.title,
    url: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`,
    recordedOnFilePage: {
      author: fileFieldText(m.Artist?.value),
      license: fileFieldText(m.LicenseShortName?.value),
      licenseUrl,
      restrictions,
    },
    source: "commons.wikimedia.org",
    readAt,
  };
}

const commonsTitleKey = (t) => {
  const s = String(t || "").replace(/^File:/i, "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};

// The file page facts of each named file, in one Commons read.
async function commonsFiles(fileNames) {
  const out = new Map();
  if (!fileNames.length) return out;
  const titles = fileNames.map((f) => `File:${f}`).join("|");
  const { data } = await getJson(
    `${COMMONS_API}?action=query&titles=${encodeURIComponent(titles)}&prop=imageinfo&iiprop=extmetadata%7Curl&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl%7CRestrictions&format=json&formatversion=2&origin=*`,
    "Wikimedia Commons"
  );
  const readAt = new Date().toISOString();
  for (const page of Array.isArray(data?.query?.pages) ? data.query.pages : []) {
    const facts = commonsFileFacts(page, readAt);
    if (facts) out.set(commonsTitleKey(page.title), facts);
  }
  return out;
}

// The Commons files whose SHA-1 equals the given one (byte-identical files).
async function commonsSha1Matches(sha1) {
  const { data } = await getJson(
    `${COMMONS_API}?action=query&generator=allimages&gaisha1=${sha1}&gailimit=${NAME_RECORDS_SHA1_MATCH_MAX}&prop=imageinfo&iiprop=extmetadata%7Curl&iiextmetadatafilter=Artist%7CLicenseShortName%7CLicenseUrl%7CRestrictions&format=json&formatversion=2&origin=*`,
    "Wikimedia Commons"
  );
  const readAt = new Date().toISOString();
  const files = (Array.isArray(data?.query?.pages) ? data.query.pages : []).map((p) => commonsFileFacts(p, readAt)).filter(Boolean);
  return { files, more: Boolean(data?.continue) };
}

// The first file name an item records for one of the image properties.
function itemImage(claims) {
  for (const [prop, label] of NAME_IMAGE_PROPS) {
    const statements = Array.isArray(claims?.[prop]) ? claims[prop] : [];
    const ranked = [...statements.filter((s) => s.rank === "preferred"), ...statements.filter((s) => s.rank === "normal")];
    for (const s of ranked) {
      const v = s?.mainsnak?.snaktype === "value" ? s.mainsnak.datavalue?.value : null;
      if (typeof v === "string" && v && v.length <= 255) return { file: v, fromProperty: `${prop} ${label}` };
    }
  }
  return null;
}

// The caller's image: base64 or a data URL, decoded and bounded.
function nameRecordsImage(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw bad(`"image" must be a base64 string or a data URL`);
  if (raw.length > NAME_RECORDS_IMAGE_B64_MAX + 512) throw bad(`"image" is capped at ${NAME_RECORDS_IMAGE_MAX_BYTES / (1024 * 1024)} MB`, 413);
  let b64 = raw;
  if (raw.startsWith("data:")) {
    const comma = raw.indexOf(",");
    const head = comma > 0 && comma <= 200 ? raw.slice(0, comma) : "";
    if (!/^data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64$/.test(head)) throw bad(`"image" data URL must be data:<type>/<subtype>;base64,<data>`);
    b64 = raw.slice(comma + 1);
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad(`"image" must be valid base64 (A-Z, a-z, 0-9, +, / and = padding)`);
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw bad(`"image" decoded to no bytes`);
  if (bytes.length > NAME_RECORDS_IMAGE_MAX_BYTES) throw bad(`"image" is capped at ${NAME_RECORDS_IMAGE_MAX_BYTES / (1024 * 1024)} MB`, 413);
  return bytes;
}

async function nameRecords(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw bad(`"name" is required: a character, meme, logo, artwork, brand or work name`);
  if (name.length > 200) throw bad(`"name" is capped at 200 characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw bad(`"name" must not contain control characters`);
  let limit = NAME_RECORDS_DEFAULT_ITEMS;
  let clamp = {};
  if (input.limit !== undefined && input.limit !== null && input.limit !== "") {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n < 1) throw bad(`"limit" must be a whole number from 1 to ${NAME_RECORDS_MAX_ITEMS}`);
    clamp = clampFields(n, NAME_RECORDS_MAX_ITEMS, "limit");
    limit = Math.min(n, NAME_RECORDS_MAX_ITEMS);
  }
  const image = nameRecordsImage(input.image);

  const { data: search } = await getJson(
    `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&type=item&limit=${NAME_RECORDS_SEARCH_LIMIT}&format=json&origin=*`,
    "Wikidata", {}, "search"
  );
  const candidates = (Array.isArray(search?.search) ? search.search : []).filter((m) => typeof m?.id === "string" && QID_RE.test(m.id));
  const picked = candidates.slice(0, limit);
  const items = [];
  if (picked.length) {
    const { data } = await getJson(
      `${WD_API}?action=wbgetentities&ids=${picked.map((m) => m.id).join("%7C")}&props=labels%7Cdescriptions%7Cclaims&languages=en&format=json&origin=*`,
      "Wikidata", {}, "entities"
    );
    const readAt = new Date().toISOString();
    for (const m of picked) {
      const ent = data?.entities?.[m.id];
      if (!ent || ent.missing !== undefined) continue;
      const claims = ent.claims || {};
      const serials = wdValues(claims[US_TRADEMARK_SERIAL_PROP]).filter((v) => typeof v === "string");
      items.push({
        id: m.id,
        label: ent.labels?.en?.value ?? m.label ?? null,
        description: ent.descriptions?.en?.value ?? m.description ?? null,
        url: `https://www.wikidata.org/wiki/${m.id}`,
        recordedOnWikidata: wdFacts(claims, NAME_RECORDS_PROPS),
        trademarkSerialNumbers: serials.map((s) => {
          const linkable = /^\d{8}$/.test(s);
          return {
            serialNumber: s,
            recordedOn: "wikidata.org",
            usptoRecordUrl: linkable ? usptoRecordUrl(s) : null,
            trademarkDetails: linkable ? "linked" : "not linked: the recorded value is not an 8-digit US serial number",
          };
        }),
        image: itemImage(claims),
        commonsFile: null,
        source: "wikidata.org",
        readAt,
      });
    }
    await wdAttachLabels(items.map((it) => it.recordedOnWikidata));
    const files = items.map((it) => it.image?.file).filter(Boolean);
    const byTitle = await commonsFiles([...new Set(files)]);
    for (const it of items) {
      if (it.image) it.commonsFile = byTitle.get(commonsTitleKey(it.image.file)) ?? null;
    }
  }

  let imageMatch;
  if (image) {
    const sha1 = createHash("sha1").update(image).digest("hex");
    const { files, more } = await commonsSha1Matches(sha1);
    imageMatch = {
      method: "Commons SHA-1 lookup",
      byteIdenticalFilesOnly: true,
      note: "Matches only a Commons file with exactly these bytes; a resized, cropped or re-encoded copy does not match. No other image search is made.",
      sha1,
      bytes: image.length,
      found: files.length > 0,
      files,
      ...partialFields(files.length + (more ? 1 : 0), files.length),
      ...(more ? { matchedIsLowerBound: true } : {}),
    };
  }

  const linksUspto = items.some((it) => it.trademarkSerialNumbers.some((t) => t.usptoRecordUrl));
  const more = Boolean(search?.["search-continue"]);
  return {
    query: name,
    found: items.length > 0,
    items,
    ...partialFields(candidates.length, items.length),
    ...(more ? { matchedIsLowerBound: true } : {}),
    ...clamp,
    ...(imageMatch ? { imageMatch } : {}),
    scope: NAME_RECORDS_SCOPE,
    sources: NAME_RECORDS_SOURCES,
    ...(linksUspto ? { usptoCredit: USPTO_CREDIT } : {}),
    affiliation: NAME_RECORDS_AFFILIATION,
    ...(items.length ? {} : { note: "No Wikidata item matched this name in the search read." }),
  };
}

// ============================================================================
// github-repo — GitHub REST v3, keyless (optional GITHUB_TOKEN lifts limits).
// ============================================================================
// Owner follows GitHub's actual username/org rule: alphanumeric + hyphens,
// can't start with a hyphen, max 39 chars — critically, NO dots, so "." / ".."
// can never build a path-traversing /repos/../<x> URL.
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// Repo names legitimately contain dots (e.g. ".github", "repo.js"), so dots
// stay in the charset — dot-only and ".."-bearing names are rejected in the
// handler instead.
const GH_REPO_RE = /^[A-Za-z0-9._-]+$/;

// The github-repo read, with the buyer's token or our optional one.
async function githubRepoRead(owner, repo, buyerToken) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const opts = { buyerKey: !!buyerToken };
  const { status, data } = await getJson(base, "GitHub", ghHeaders(buyerToken), "lookup", opts);
  // A private repository a configured token can read answers exactly like
  // one that does not exist: nothing about it leaves through this tool.
  if (status === 404 || !data || typeof data !== "object" || data.private === true) {
    throw bad(`Repository ${owner}/${repo} not found (or private)`, 404);
  }
  // Language byte mix — best-effort second call; the core record stands alone.
  let languages = null;
  try {
    const { status: ls, data: langs } = await getJson(`${base}/languages`, "GitHub", ghHeaders(buyerToken), "lookup", opts);
    if (ls === 200 && langs && typeof langs === "object") {
      const total = Object.values(langs).reduce((s, n) => s + n, 0) || 1;
      languages = Object.entries(langs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([language, bytes]) => ({ language, bytes, percent: Math.round((bytes / total) * 1000) / 10 }));
    }
  } catch { /* per-IP quota may not stretch to the second call — mix stays null */ }
  return {
    fullName: data.full_name ?? `${owner}/${repo}`,
    description: data.description ?? null,
    stars: data.stargazers_count ?? 0,
    forks: data.forks_count ?? 0,
    watchers: data.subscribers_count ?? data.watchers_count ?? 0,
    openIssues: data.open_issues_count ?? 0,
    license: data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : data.license?.name ?? null,
    topics: Array.isArray(data.topics) ? data.topics.slice(0, 20) : [],
    language: data.language ?? null,
    languages,
    pushedAt: data.pushed_at ?? null,
    createdAt: data.created_at ?? null,
    defaultBranch: data.default_branch ?? null,
    archived: Boolean(data.archived),
    fork: Boolean(data.fork),
    homepage: data.homepage || null,
    url: data.html_url ?? `https://github.com/${owner}/${repo}`,
    source: "api.github.com",
  };
}

export function ghHeaders(buyerToken = null) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  // A buyer's own token (X-Agent402-Upstream-Key, src/upstream-key.js) is the
  // only credential its call carries: ours is never sent beside or after it.
  if (buyerToken) { h.Authorization = `Bearer ${buyerToken}`; return h; }
  // Optional env-gated enhancement: 60 req/hr/IP keyless → 5k/hr with a token.
  // Never required; absence changes nothing but the rate limit.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// ============================================================================
// favicon-grab — declared-icon discovery + SSRF-guarded fetch.
// ============================================================================
const PAGE_MAX_BYTES = 1024 * 1024; // HTML page read cap
const ICON_MAX_BYTES = 1024 * 1024; // icon fetch cap (413 past this)
const ICON_DATAURI_MAX = 256 * 1024; // inline as data URI only up to here

function parseDeclaredIcons(html, baseUrl) {
  const icons = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
      return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
    };
    const rel = (attr("rel") || "").toLowerCase();
    // rel is a space-separated token list — match the icon-bearing rels.
    const tokens = rel.split(/\s+/);
    if (!tokens.includes("icon") && !tokens.includes("apple-touch-icon") && !tokens.includes("apple-touch-icon-precomposed") && !tokens.includes("mask-icon")) continue;
    const href = attr("href");
    if (!href) continue;
    let resolved;
    try { resolved = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https?:/.test(resolved)) continue;
    icons.push({
      href: resolved,
      rel,
      sizes: (attr("sizes") || null),
      type: (attr("type") || null),
      // Safari mask icons are monochrome outlines — usable, but only when
      // nothing better is declared.
      mask: tokens.includes("mask-icon") && !tokens.includes("icon"),
    });
    if (icons.length >= 20) break;
  }
  return icons;
}

// Deterministic pick: real icons (rel icon / apple-touch-icon) beat monochrome
// mask icons; within a class the largest declared pixel area wins
// (unspecified/any = 0); ties break by document order.
function pickIcon(icons) {
  const byArea = (list) => {
    let best = null, bestArea = -1;
    for (const icon of list) {
      const m = (icon.sizes || "").match(/(\d+)x(\d+)/i);
      const area = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
      if (area > bestArea) { best = icon; bestArea = area; }
    }
    return best;
  };
  return byArea(icons.filter((i) => !i.mask)) || byArea(icons);
}

async function fetchIcon(url) {
  const { finalUrl, buffer, contentType } = await safeFetch(url, { binary: true, maxBytes: ICON_MAX_BYTES, headers: { Accept: "image/*,*/*" } });
  if (!buffer.length) throw bad("Icon URL returned an empty body", 422);
  return { finalUrl, buffer, contentType: (contentType || "image/x-icon").split(";")[0].trim() };
}

// ============================================================================
export const ENRICH_TOOLS = [
  // ===========================================================================
  // lei-lookup — GLEIF legal-entity registry: LEI record or fulltext search.
  // ===========================================================================
  {
    route: "POST /api/lei-lookup",
    name: "Legal entity (LEI) lookup",
    slug: "lei-lookup",
    category: "data",
    price: "$0.002",
    description:
      "Look up a legal entity in the official GLEIF registry. Pass a 20-character LEI for the full record - legal name, jurisdiction, legal form, addresses, registration status, and the reported direct + ultimate parent entities - or pass a company name to fulltext-search the registry and get ranked candidate LEIs. Unknown LEIs return {found:false}; parents that aren't reported return null. Official registry data, keyless.",
    tags: ["data", "lei", "gleif", "legal-entity", "company", "enrichment", "kyc"],
    discovery: {
      bodyType: "json",
      input: { lei: "HWUPKR0MPOU8FGXBT394" },
      inputSchema: {
        properties: {
          lei: { type: "string", maxLength: 20, description: "20-character alphanumeric Legal Entity Identifier (exact record lookup)." },
          name: { type: "string", maxLength: 200, description: "Company name to fulltext-search instead (ranked candidate list). Provide lei OR name." },
        },
      },
      output: {
        example: {
          found: true,
          record: {
            lei: "HWUPKR0MPOU8FGXBT394",
            legalName: "APPLE INC.",
            jurisdiction: "US-CA",
            entityStatus: "ACTIVE",
            legalAddress: { city: "Cupertino", region: "US-CA", country: "US" },
            registration: { status: "ISSUED", nextRenewal: "2026-10-13T00:31:58Z" },
          },
          parents: { direct: null, ultimate: null },
          source: "api.gleif.org",
        },
      },
    },
    handler: async (i) => {
      const lei = typeof i.lei === "string" ? i.lei.trim().toUpperCase() : "";
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (lei) {
        if (!LEI_RE.test(lei)) throw bad(`"lei" must be a 20-character alphanumeric LEI, e.g. HWUPKR0MPOU8FGXBT394`);
        const { status, data } = await getJson(`${GLEIF}/lei-records/${lei}`, "GLEIF");
        if (status === 404 || !data?.data) {
          return { found: false, lei, record: null, note: "No record for this LEI in the GLEIF registry.", source: "api.gleif.org" };
        }
        const [direct, ultimate] = await Promise.all([
          leiParent(lei, "direct-parent"),
          leiParent(lei, "ultimate-parent"),
        ]);
        return { found: true, record: leiRecordSummary(data.data), parents: { direct, ultimate }, source: "api.gleif.org" };
      }
      if (!name) throw bad(`Provide "lei" (20-char identifier) or "name" (company name to search)`);
      if (name.length > 200) throw bad(`"name" is capped at 200 characters`);
      const { data } = await getJson(`${GLEIF}/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(name)}&page%5Bsize%5D=10`, "GLEIF");
      const matches = (Array.isArray(data?.data) ? data.data : []).map((rec) => {
        const a = rec.attributes || {};
        return {
          lei: a.lei ?? null,
          legalName: a.entity?.legalName?.name ?? null,
          jurisdiction: a.entity?.jurisdiction ?? null,
          entityStatus: a.entity?.status ?? null,
          registrationStatus: a.registration?.status ?? null,
        };
      });
      return {
        found: matches.length > 0,
        query: name,
        matches,
        note: matches.length ? "Pass a candidate's lei back for the full record + parents." : "No registry match for this name.",
        source: "api.gleif.org",
      };
    },
  },

  // ===========================================================================
  // wikidata-entity — entity facts by Q-id, or ranked name search.
  // ===========================================================================
  {
    route: "POST /api/wikidata-entity",
    name: "Wikidata entity facts",
    slug: "wikidata-entity",
    category: "data",
    price: "$0.005",
    description:
      "Company/person/organization facts from Wikidata. Pass an entity id (e.g. Q312 for Apple Inc.) for the enrichment record - label, description, aliases, and a curated fact set (inception, HQ location, country, industry, founders, CEO, employees, revenue, official website, LEI, ticker + exchange, ISIN, logo; for people: birth/death dates, citizenship, occupation) with item references resolved to human-readable labels. Or pass a name to search: ambiguous names return ranked candidate matches in Wikidata's stable order. Keyless.",
    tags: ["data", "wikidata", "entity", "company", "person", "enrichment", "knowledge-graph"],
    discovery: {
      bodyType: "json",
      input: { id: "Q312" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Wikidata entity id, e.g. Q312 (exact entity lookup)." },
          name: { type: "string", maxLength: 200, description: "Entity name to search instead (ranked candidate list). Provide id OR name." },
        },
      },
      output: {
        example: {
          found: true,
          id: "Q312",
          label: "Apple Inc.",
          description: "American multinational technology company",
          aliases: ["Apple", "Apple Computer, Inc."],
          facts: {
            inception: ["1976-04-01T00:00:00Z"],
            headquartersLocation: [{ id: "Q3070754", label: "Apple Park" }],
            officialWebsite: ["https://www.apple.com/"],
            tickerSymbol: ["AAPL"],
            lei: ["HWUPKR0MPOU8FGXBT394"],
          },
          statementCount: 300,
          source: "wikidata.org",
        },
      },
    },
    handler: async (i) => {
      const id = typeof i.id === "string" ? i.id.trim().toUpperCase() : "";
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (id) {
        if (!QID_RE.test(id)) throw bad(`"id" must be a Wikidata entity id like Q312`);
        const { data } = await getJson(
          `${WD_API}?action=wbgetentities&ids=${id}&props=labels%7Cdescriptions%7Caliases%7Cclaims&languages=en&format=json&origin=*`,
          "Wikidata"
        );
        const ent = data?.entities?.[id];
        if (!ent || ent.missing !== undefined) {
          return { found: false, id, note: "No Wikidata entity with this id.", source: "wikidata.org" };
        }
        const claims = ent.claims || {};
        const facts = wdFacts(claims, WD_PROPS);
        // One batched follow-up resolves item references to labels (≤50 ids).
        await wdAttachLabels([facts]);
        let statementCount = 0;
        for (const arr of Object.values(claims)) statementCount += Array.isArray(arr) ? arr.length : 0;
        return {
          found: true,
          id,
          label: ent.labels?.en?.value ?? null,
          description: ent.descriptions?.en?.value ?? null,
          aliases: (ent.aliases?.en || []).map((a) => a.value).slice(0, 10),
          facts,
          statementCount,
          source: "wikidata.org",
        };
      }
      if (!name) throw bad(`Provide "id" (e.g. Q312) or "name" (entity name to search)`);
      if (name.length > 200) throw bad(`"name" is capped at 200 characters`);
      const { data } = await getJson(
        `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&type=item&limit=10&format=json&origin=*`,
        "Wikidata"
      );
      const matches = (Array.isArray(data?.search) ? data.search : []).map((m) => ({
        id: m.id,
        label: m.label ?? null,
        description: m.description ?? null,
      }));
      return {
        found: matches.length > 0,
        query: name,
        matches,
        note: matches.length ? "Ranked by Wikidata relevance - pass a candidate's id back for the full fact set." : "No Wikidata match for this name.",
        source: "wikidata.org",
      };
    },
  },

  // ===========================================================================
  // name-records — recorded creator, publisher, trademark serial numbers and
  // Commons file facts for a name; the Commons SHA-1 match for an image.
  // ===========================================================================
  {
    route: "POST /api/name-records",
    name: "Name records lookup",
    slug: "name-records",
    category: "data",
    price: "$0.005",
    upstreamHosts: ["www.wikidata.org", "commons.wikimedia.org"],
    description:
      "Look up what public sources record for a name: a character, meme, logo, artwork, brand or work. Returns the best-matching Wikidata items with their recorded creator, author, designer, publisher, production company, manufacturer, inception, publication date, first appearance, based-on and named-after statements; each item's US trademark serial numbers as Wikidata records them, with a link to each USPTO record page, where the owner, status and classes are shown; and the Wikimedia Commons file page of the item's image with its author, license and restriction tags as that file page records them. Pass an image (base64 or a data URL, up to 4 MB) to find the Commons file with the same SHA-1: byte-identical files only. Every record carries its source link and read time, and a fixed field states that the answer lists records and makes no determination of ownership or permitted use. Up to 5 items per call; a capped list says so in fields. Keyless: Wikidata (CC0) and Wikimedia Commons.",
    tags: ["data", "wikidata", "commons", "trademark", "creator", "records", "attribution"],
    discovery: {
      bodyType: "json",
      input: { name: "BeBox" },
      inputSchema: {
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, description: "The name to look up: a character, meme, logo, artwork, brand or work." },
          limit: { type: "integer", minimum: 1, maximum: NAME_RECORDS_MAX_ITEMS, description: `Wikidata items to return, best match first (default ${NAME_RECORDS_DEFAULT_ITEMS}, at most ${NAME_RECORDS_MAX_ITEMS}).` },
          image: { type: "string", description: "Optional image as base64 or a data URL (up to 4 MB decoded), matched against Commons by SHA-1: byte-identical files only." },
        },
        required: ["name"],
      },
      output: {
        example: {
          query: "BeBox",
          found: true,
          items: [{
            id: "Q812806",
            label: "BeBox",
            description: "Personal computer sold by Be Inc.",
            url: "https://www.wikidata.org/wiki/Q812806",
            recordedOnWikidata: {
              creator: [{ id: "Q1254581", label: "Jean-Louis Gassée" }, { id: "Q7613836", label: "Steve Sakoman" }],
              manufacturer: [{ id: "Q791615", label: "Be Inc." }],
            },
            trademarkSerialNumbers: [{ serialNumber: "75054089", recordedOn: "wikidata.org", usptoRecordUrl: usptoRecordUrl("75054089"), trademarkDetails: "linked" }],
            image: { file: "Bebox Face.jpg", fromProperty: "P18 image" },
            commonsFile: {
              file: "File:Bebox Face.jpg",
              url: "https://commons.wikimedia.org/wiki/File:Bebox_Face.jpg",
              recordedOnFilePage: { author: "Josh Carlson", license: "CC BY 2.0", licenseUrl: "https://creativecommons.org/licenses/by/2.0", restrictions: [] },
              source: "commons.wikimedia.org",
              readAt: "2026-11-27T20:20:00.000Z",
            },
            source: "wikidata.org",
            readAt: "2026-11-27T20:20:00.000Z",
          }],
          returned: 1, matched: 1, complete: true, truncated: false,
          scope: NAME_RECORDS_SCOPE,
          sources: NAME_RECORDS_SOURCES,
          usptoCredit: USPTO_CREDIT,
          affiliation: NAME_RECORDS_AFFILIATION,
        },
      },
    },
    handler: (i) => nameRecords(i),
  },

  // ===========================================================================
  // github-repo — public repository enrichment via GitHub REST.
  // ===========================================================================
  {
    route: "POST /api/github-repo",
    name: "GitHub repository enrichment",
    slug: "github-repo",
    category: "data",
    price: "$0.005",
    description:
      "Enrich a public GitHub repository: stars, forks, watchers, open issues, license, topics, primary language plus the full language byte mix with percentages, created/last-push timestamps, default branch, archived/fork flags, and homepage. Keyless (shared per-IP rate limit; the server optionally uses a GITHUB_TOKEN env var for a higher ceiling). Unknown repos return 404." + (upstreamKeySentence("github-repo") ? ` ${upstreamKeySentence("github-repo")}` : ""),
    tags: ["data", "github", "repository", "oss", "enrichment", "dev", "stars"],
    discovery: {
      bodyType: "json",
      input: { owner: "expressjs", repo: "express" },
      inputSchema: {
        properties: {
          owner: { type: "string", maxLength: 39, description: "Repository owner (user or org)." },
          repo: { type: "string", maxLength: 128, description: "Repository name." },
        },
        required: ["owner", "repo"],
      },
      output: {
        example: {
          fullName: "expressjs/express",
          description: "Fast, unopinionated, minimalist web framework for node.",
          stars: 69000, forks: 25000, watchers: 1700, openIssues: 230,
          license: "MIT", topics: ["express", "javascript", "nodejs", "server"],
          language: "JavaScript",
          languages: [{ language: "JavaScript", bytes: 1000000, percent: 99.9 }],
          pushedAt: "2026-07-12T20:11:04Z", createdAt: "2009-06-26T18:56:01Z",
          defaultBranch: "master", archived: false, fork: false,
          homepage: "https://expressjs.com",
          url: "https://github.com/expressjs/express",
          source: "api.github.com",
        },
      },
    },
    handler: async (i, req) => {
      const owner = typeof i.owner === "string" ? i.owner.trim() : "";
      const repo = typeof i.repo === "string" ? i.repo.trim() : "";
      if (!GH_OWNER_RE.test(owner)) throw bad(`"owner" must be a GitHub user/org name (letters, digits, hyphens; max 39 chars)`);
      if (!GH_REPO_RE.test(repo) || repo.length > 128 || repo === "." || repo.includes("..")) throw bad(`"repo" must be a GitHub repository name (letters, digits, . _ -; no ".." segments)`);
      // The buyer's own token, when its request carried one this route took.
      const buyerToken = upstreamKeyFor(req, "github-repo");
      return runWithUpstreamKey(buyerToken ? "github-repo" : null, () => githubRepoRead(owner, repo, buyerToken), req);
    },
  },

  // ===========================================================================
  // favicon-grab — site favicon/logo → base64 data URI + declared sizes.
  // ===========================================================================
  {
    route: "POST /api/favicon-grab",
    name: "Site favicon grabber",
    slug: "favicon-grab", aliases: ["site-favicon-grabber", "favicon"],
    category: "web",
    price: "$0.001",
    description:
      "Fetch a site's favicon/logo: reads the page's declared <link rel=icon…> tags (all variants with their sizes and types), deterministically picks the largest declared icon (falling back to /favicon.ico), fetches it, and returns the bytes as a base64 data URI plus the resolved icon URL and content type. Icons over 256KB return the URL and metadata without the inline data URI. SSRF-guarded - private-network hosts are rejected. Sites with no reachable icon return {found:false}.",
    tags: ["web", "favicon", "icon", "logo", "enrichment", "domain", "brand"],
    discovery: {
      bodyType: "json",
      // The example target is NOT github.com on purpose (2026-09-14): the
      // strict sweep runs on a GitHub Actions runner, and github.com answers a
      // runner's page fetch differently from a browser - the HTML read failed,
      // `declared` came back empty, and the /favicon.ico fallback still
      // succeeded, so the tool reported found:true with nothing declared and
      // the sweep rightly failed the example. Wikipedia serves the same page
      // to everyone and declares two icons. Since 2026-10-07 the example is our
      // own home page, which declares four, so it never depends on another site.
      input: { url: "https://agent402.tools" },
      inputSchema: {
        properties: {
          url: { type: "string", maxLength: 2048, description: "Site URL or bare domain (https:// is assumed when omitted)." },
        },
        required: ["url"],
      },
      output: {
        example: {
          found: true,
          url: "https://agent402.tools/",
          iconUrl: "https://agent402.tools/favicon.ico?v=4",
          finalIconUrl: "https://agent402.tools/favicon.ico?v=4",
          contentType: "image/png",
          bytes: 76462,
          dataUri: "data:image/png;base64,iVBORw0KGgo…",
          declared: [
            { href: "https://agent402.tools/favicon.svg?v=4", rel: "icon", sizes: null, type: "image/svg+xml", mask: false },
            { href: "https://agent402.tools/favicon.ico?v=4", rel: "icon", sizes: "512x512", type: "image/png", mask: false },
            { href: "https://agent402.tools/favicon.ico?v=4", rel: "shortcut icon", sizes: null, type: null, mask: false },
            { href: "https://agent402.tools/logo.png?v=3", rel: "apple-touch-icon", sizes: null, type: null, mask: false },
          ],
        },
      },
    },
    handler: async (i) => {
      let raw = typeof i.url === "string" ? i.url.trim() : "";
      if (!raw) throw bad(`"url" is required - a site URL or bare domain`);
      if (raw.length > 2048) throw bad(`"url" is capped at 2048 characters`);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw bad(`"url" must be http(s) or a bare domain`);
      if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
      await assertRobotsAllow(raw);
      // Page fetch (SSRF-guarded). A page that won't serve HTML still gets the
      // /favicon.ico fallback below.
      let page = null;
      try {
        page = await safeFetch(raw, { maxBytes: PAGE_MAX_BYTES });
      } catch (e) {
        if (e.statusCode === 400) throw e; // SSRF block / invalid URL — caller error, stop here
        page = null; // 4xx/5xx/timeout page — still try /favicon.ico
      }
      const baseUrl = page?.finalUrl || raw;
      const declared = page?.html ? parseDeclaredIcons(page.html, baseUrl) : [];
      const fallback = new URL("/favicon.ico", baseUrl).href;
      // Candidate order: best declared icon, then /favicon.ico.
      const chosen = pickIcon(declared);
      const candidates = [...(chosen ? [chosen.href] : []), fallback];
      let icon = null, iconUrl = null;
      for (const candidate of [...new Set(candidates)]) {
        try {
          icon = await fetchIcon(candidate);
          iconUrl = candidate;
          break;
        } catch (e) {
          if (e.statusCode === 413) throw e; // oversized icon is a real answer boundary, not a miss
          /* 4xx/5xx/timeout — try the next candidate */
        }
      }
      if (!icon) {
        return { found: false, url: baseUrl, iconUrl: null, declared, note: "No reachable favicon - none declared and /favicon.ico did not serve." };
      }
      const inline = icon.buffer.length <= ICON_DATAURI_MAX;
      return {
        found: true,
        url: baseUrl,
        iconUrl,
        finalIconUrl: icon.finalUrl,
        contentType: icon.contentType,
        bytes: icon.buffer.length,
        dataUri: inline ? `data:${icon.contentType};base64,${icon.buffer.toString("base64")}` : null,
        ...(inline ? {} : { note: `Icon exceeds ${ICON_DATAURI_MAX / 1024}KB - fetch iconUrl directly.` }),
        declared,
      };
    },
  },
];

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(ENRICH_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
