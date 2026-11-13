// Attribution sentences a data source's terms require wherever its data is
// served. A tool's catalog description ends with its source's sentence, and
// the listing cut (bazaarCapDescription in src/payments.js) keeps a trailing
// one whole, shortening the text before it instead.
// Dependency-free: src/payments.js and the tool kits both import it.

export const FRED_NOTICE = "This product uses the FRED(R) API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";

/** Every sentence the listing cut keeps when a description ends with it. */
export const ATTRIBUTION_TAILS = Object.freeze([FRED_NOTICE]);

/** The attribution sentence `s` ends with, or null. */
export function attributionTailOf(s) {
  if (typeof s !== "string") return null;
  return ATTRIBUTION_TAILS.find((t) => s.endsWith(t) && (s.length === t.length || /\s/.test(s[s.length - t.length - 1]))) || null;
}
