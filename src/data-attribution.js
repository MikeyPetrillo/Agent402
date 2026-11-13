// Attribution sentences a data source's terms require wherever its data is
// served. A tool that serves a source's data carries `attribution: "<key>"`
// (a key of ATTRIBUTIONS) and its catalog description ends with that
// sentence; a skill pack ends with the sentences of the tools it runs
// (packAttributions). The listing cut (bazaarCapDescription in
// src/payments.js) keeps a trailing run of these sentences whole, shortening
// the text before it instead. Each kit that reads a source cites the terms
// that require its sentence next to the tools that carry it.
// Dependency-free: src/payments.js, src/skills.js and the tool kits import it.

// The terms behind each sentence: FRED API Terms of Use
// (https://fred.stlouisfed.org/docs/api/terms_of_use.html, the notice the
// macro kit's FRED routes carry); CoinGecko in src/tools/coingecko-rate.js;
// Jupiter in src/tools/solana-intel-kit.js; OpenStreetMap in
// src/tools/geo-kit.js; Open-Meteo in src/tools/weather-kit.js; NVD in
// src/tools/cve-kit.js.
export const FRED_NOTICE ="This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";
export const COINGECKO_ATTRIBUTION = "Data provided by CoinGecko.";
export const JUPITER_ATTRIBUTION = "Powered by Jupiter.";
export const OSM_ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL (openstreetmap.org/copyright).";
export const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0).";
export const NVD_NOTICE = "This product uses the NVD API but is not endorsed or certified by the NVD.";

/** Source key (a tool's `attribution` field) -> the sentence its terms require. */
export const ATTRIBUTIONS = Object.freeze({
  fred: FRED_NOTICE,
  coingecko: COINGECKO_ATTRIBUTION,
  jupiter: JUPITER_ATTRIBUTION,
  openstreetmap: OSM_ATTRIBUTION,
  "open-meteo": OPEN_METEO_ATTRIBUTION,
  nvd: NVD_NOTICE,
});

/** Every sentence the listing cut keeps when a description ends with it. */
export const ATTRIBUTION_TAILS = Object.freeze(Object.values(ATTRIBUTIONS));

const endsWithSentence = (s, t) => s.endsWith(t) && (s.length === t.length || /\s/.test(s[s.length - t.length - 1]));

/** The run of attribution sentences `s` ends with (one or more, separated by
 *  single spaces), or null. Each step strips one known sentence off the end,
 *  so the walk is bounded by the number of sentences, not the text length. */
export function attributionTailOf(s) {
  if (typeof s !== "string") return null;
  let rest = s, start = s.length;
  for (let n = 0; n < ATTRIBUTION_TAILS.length; n++) {
    const t = ATTRIBUTION_TAILS.find((x) => endsWithSentence(rest, x));
    if (!t) break;
    start = rest.length - t.length;
    rest = rest.slice(0, start).replace(/ $/, "");
  }
  return start < s.length ? s.slice(start) : null;
}

/** Mark `tool` as serving `key`'s data: set its `attribution` field and end
 *  its description with the source's sentence (once). */
export function attribute(tool, key) {
  const sentence = ATTRIBUTIONS[key];
  if (!sentence) throw new Error(`unknown attribution key "${key}"`);
  tool.attribution = key;
  if (!endsWithSentence(String(tool.description || ""), sentence)) tool.description = `${tool.description} ${sentence}`;
  return tool;
}

/** The attribution sentences of the tools a skill pack runs, in the order the
 *  pack first names each source. `toolBySlug(slug)` returns a tool or null. */
export function packAttributions(toolSlugs, toolBySlug) {
  const keys = [];
  for (const slug of toolSlugs || []) {
    const key = toolBySlug(slug)?.attribution;
    if (key && ATTRIBUTIONS[key] && !keys.includes(key)) keys.push(key);
  }
  return keys.map((k) => ATTRIBUTIONS[k]);
}

/** `text` followed by each of `sentences` it does not already end with. */
export function withAttributions(text, sentences) {
  const s = String(text ?? "").trimEnd();
  const tail = attributionTailOf(s) || "";
  const missing = (sentences || []).filter((x) => !tail.includes(x));
  return missing.length ? `${s} ${missing.join(" ")}` : s;
}

/** `text` with every attribution sentence taken out: the text the catalog
 *  search ranks on (src/find.js, catalog.search in src/mcp-http.js). The
 *  sentences are legal notices, not what a tool does, so a query never
 *  matches a tool by its notice. */
export function withoutAttributions(text) {
  let s = String(text ?? "");
  for (const t of ATTRIBUTION_TAILS) if (s.includes(t)) s = s.split(t).join(" ");
  return s;
}
