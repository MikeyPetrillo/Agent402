// Resale terms of a tool's data source, as the referral copies (/ref, src/referral-gate.js)
// read them. A copy under /ref is sold through a third party's marketplace, so a tool
// that passes a source's data through as it came is left out at boot when that
// source's terms bar resale or syndication through a third party.
//
// A tool declares it beside its handler, slug by slug, in its own kit:
//   resale: "barred"    its answer is the source's data as it came, and the
//                       source's terms bar resale through a third party;
//                       `resaleReason` says why, in a few words, and the boot
//                       refusal quotes it.
//   resale: "computed"  it reads such a source and its answer is computed here
//                       (a screen, a ranking, a deviation, a brief), so it is not
//                       a pass-through.
// Every tool that serves the market-data source (attribution "coingecko",
// src/data-attribution.js) declares one of the two (scripts/test-referral-gate.js),
// so a new tool on that source cannot reach /ref undecided.
//
// CLEARANCE. A tool is sold through a third party's marketplace (the /ref
// copies and the AWS Marketplace front door, src/aws-marketplace-gate.js)
// only when its upstream terms were read and cleared for that, declared
// beside its handler:
//   markResaleCleared(tools, slugs, "the source")   resaleCleared: true and
//                       resaleClearedBy, the source it was cleared for.
// A tool that reaches no upstream (the server's compute reading) has nothing
// to clear, unless its answer serves facts compiled from outside sources (a
// calendar, a rule table): such a tool declares each source beside its
// handler (markContentSources: the source, its license and whether that
// license allows passing the facts on), and is sold through a third party
// only when it also carries a clearance mark. Every other tool is refused at boot with RESALE_NOT_CLEARED_REASON
// (resaleClearanceRefusal), so a new tool, or one whose source is not cleared,
// cannot be listed by a setting alone (scripts/test-resale-clearance.js).
//
// Imports only src/test-seams.js: the tool kits and the referral gate import it.
import { testSeam } from "./test-seams.js";

export const RESALE_BARRED = "barred";
export const RESALE_COMPUTED = "computed";

/** The market-data source's terms (cited in src/tools/coingecko-rate.js) bar
 *  resale or syndication of its data through a third party. */
export const MARKET_DATA_RESALE_REASON = "raw pass-through of a data source whose terms bar resale or syndication through a third party";
/** The Wikimedia Foundation's API usage guidelines bar sublicensing,
 *  leasing or white-labeling access to its APIs (search-suggest). */
export const WIKIMEDIA_API_RESALE_REASON = "a relay of a Wikimedia Foundation API, whose usage guidelines bar sublicensing access to it";
/** The holiday source's terms (cited in src/tools/holiday-source.js) forbid
 *  operating a holiday portal or republishing its dataset. */
export const HOLIDAY_PORTAL_RESALE_REASON = "a whole-year holiday list from a source whose terms bar a holiday portal";

function mark(tools, slugs, fields) {
  const bySlug = new Map((tools || []).map((t) => [t?.slug, t]));
  for (const slug of slugs) {
    const tool = bySlug.get(slug);
    if (!tool) throw new Error(`resale terms: no tool "${slug}" in this kit`);
    Object.assign(tool, fields);
  }
  return tools;
}

/** Mark `slugs` of `tools` as raw pass-throughs of a source that bars resale, with the reason. */
export function markResaleBarred(tools, slugs, reason) {
  const why = String(reason || "").trim();
  if (!why) throw new Error("resale terms: a barred tool needs a reason");
  return mark(tools, slugs, { resale: RESALE_BARRED, resaleReason: why });
}

/** Why a tool is not sold through a third party when it declares no clearance. */
export const RESALE_NOT_CLEARED_REASON = "its upstream terms are not cleared for resale through a third party";

/** Mark `slugs` of `tools` as cleared for resale through a third party, with
 *  the source they were cleared for (a few words). A tool marked barred is
 *  never cleared. */
export function markResaleCleared(tools, slugs, source) {
  const by = String(source || "").trim();
  if (by.length < 3) throw new Error("resale terms: a clearance names its source");
  for (const t of tools || []) if (slugs.includes(t?.slug) && t.resale === RESALE_BARRED) throw new Error(`resale terms: "${t.slug}" is barred and cannot be cleared`);
  return mark(tools, slugs, { resaleCleared: true, resaleClearedBy: by.slice(0, 120) });
}

/** Why `def` may not be sold through a third party, or null: a barred
 *  pass-through's own reason; else null when it is cleared or reaches no
 *  upstream (`compute`, the server's reading); else RESALE_NOT_CLEARED_REASON.
 *  RESALE_CLEARED_FOR_TEST (a comma list, never read in production) clears
 *  named slugs for a suite's boot. */
export function resaleClearanceRefusal(def, { compute = false, env = process.env } = {}) {
  const barred = resaleBarredReason(def);
  if (barred) return barred;
  if (!def || typeof def !== "object") return RESALE_NOT_CLEARED_REASON;
  if (def.resaleCleared === true) return null;
  // Reaching no upstream clears a tool only when none of its facts come from
  // an outside source (markContentSources).
  if (compute === true && !hasContentSources(def)) return null;
  const seam = testSeam("RESALE_CLEARED_FOR_TEST", env);
  if (seam && seam.split(",").map((x) => x.trim()).includes(def.slug)) return null;
  return RESALE_NOT_CLEARED_REASON;
}

/** Mark `slugs` of `tools` as serving facts compiled from outside sources,
 *  each `{ name, url, license, redistribution, credit? }` (`redistribution`:
 *  whether that license allows the facts to be passed on, true or false;
 *  `credit`: the line it asks a user to keep, if any). A tool so
 *  marked is never cleared for resale by reaching no upstream alone
 *  (resaleClearanceRefusal). */
export function markContentSources(tools, slugs, sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length || !list.every((x) => x && typeof x.name === "string" && x.name.trim() && /^https:\/\//.test(String(x.url || "")) && typeof x.license === "string" && x.license.trim() && typeof x.redistribution === "boolean")) {
    throw new Error("resale terms: each content source names itself, its https URL, its license and whether it allows redistribution");
  }
  return mark(tools, slugs, { contentSources: Object.freeze(list.map((x) => Object.freeze({ name: x.name, url: x.url, license: x.license, redistribution: x.redistribution, ...(typeof x.credit === "string" && x.credit ? { credit: x.credit } : {}) }))) });
}

/** Does `def` serve facts compiled from outside sources? */
export function hasContentSources(def) {
  return Array.isArray(def?.contentSources) && def.contentSources.length > 0;
}

/** Mark `slugs` of `tools` as computing their answer from such a source. */
export function markResaleComputed(tools, slugs) {
  return mark(tools, slugs, { resale: RESALE_COMPUTED });
}

/** The reason a definition may not be resold through a third party, or null. */
export function resaleBarredReason(def) {
  if (!def || typeof def !== "object" || def.resale !== RESALE_BARRED) return null;
  const why = typeof def.resaleReason === "string" && def.resaleReason.trim() ? def.resaleReason.trim() : "its data source's terms bar resale through a third party";
  return why.slice(0, 200);
}

/** The clearance a tool computed over market data carries (markResaleCleared's
 *  source): the source's terms allow products that incorporate its data, not
 *  its own figures resold as they came. A tool cleared this way sells, through
 *  a third party, no field named in RAW_MARKET_FIELDS at any depth, and a tool
 *  whose answer carries such figures drops them with markRefAnswer, naming
 *  each one (scripts/test-resale-clearance.js drives every such tool's
 *  published example through refAnswerOf). */
export const MARKET_DATA_CLEARANCE = "computed over market data whose terms allow products that incorporate it";

/** Field names that hold a market-data source's own figures (a coin's price,
 *  market cap, fully diluted value, volume, all-time high and low, the 24-hour
 *  range, supply counts): never sold through a third party by a tool cleared
 *  with MARKET_DATA_CLEARANCE. A sum, share or ratio computed here is named
 *  otherwise and is not on the list. */
export const RAW_MARKET_FIELDS = Object.freeze([
  "price", "currentPrice", "marketCap", "fullyDilutedValuation", "fdv", "volume24h", "totalVolume",
  "ath", "atl", "high24h", "low24h", "circulatingSupply", "totalSupply", "maxSupply",
  "medianPriceUsd", "volumeWeightedPriceUsd",
]);

/** Declare, beside a tool's handler, what its answer becomes on a /ref copy
 *  and on /aws (both resell through a third party):
 *  `transform(answer)` returns the answer the referral gate serves (a new
 *  value; it never changes the one it is given). The public route serves the
 *  handler's own answer, untouched. `rawFields` names every field the
 *  transform drops, as a path ("coins[].price", "rows[].supply.total",
 *  "medianPriceUsd"); the clearance suite reads each one in the published
 *  example and requires it gone from the resold answer. */
export function markRefAnswer(tools, slugs, transform, rawFields) {
  if (typeof transform !== "function") throw new Error("resale terms: a /ref answer transform must be a function");
  if (!Array.isArray(rawFields) || rawFields.length === 0 || !rawFields.every((p) => typeof p === "string" && /^[A-Za-z0-9_]+(\[\])?(\.[A-Za-z0-9_]+(\[\])?)*$/.test(p))) {
    throw new Error("resale terms: a /ref answer transform names the raw fields it drops (rawFields, paths such as \"coins[].price\")");
  }
  return mark(tools, slugs, { refAnswer: transform, refRawFields: Object.freeze([...rawFields]) });
}

/** The values at `path` ("rows[].supply.total") in `value`: [] when the path
 *  is absent. Arrays marked "[]" are walked element by element. */
export function valuesAtPath(value, path) {
  let cur = [value];
  for (const part of String(path).split(".")) {
    const each = part.endsWith("[]");
    const key = each ? part.slice(0, -2) : part;
    const next = [];
    for (const v of cur) {
      if (!v || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, key)) continue;
      const got = v[key];
      if (each) { if (Array.isArray(got)) next.push(...got); } else next.push(got);
    }
    cur = next;
  }
  return cur;
}

/** The answer a /ref copy (src/referral-gate.js) and an /aws sale
 *  (src/aws-marketplace-gate.js) serve for `def`: its declared transform
 *  applied, or the answer as it came. */
export function refAnswerOf(def, answer) {
  return def && typeof def.refAnswer === "function" ? def.refAnswer(answer) : answer;
}
