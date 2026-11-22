// The words buyers use for a task that the catalog names another way, for the
// /api/find lexical ranker. A rule fires when every word it lists is in the
// query; it appends the catalog's own words (a slug, a slug word or a curated
// tag), the same mechanism as the "units" and "forex" terms in src/find.js.
// The buyer's words stay in the query: a synonym adds, it never replaces.
//
// Kept to words that name ONE capability whatever surrounds them, measured
// against the demand board's find-misses (2026-11-22). A word that also means
// something else in the catalog ("add", "difference", "duration" alone) is
// listed only beside the second word that makes it this task.
// scripts/test-find-synonyms.js checks every rule's targets against the live
// catalog, so a renamed tool or tag fails there instead of going quiet here.

export const FIND_SYNONYMS = Object.freeze([
  // base64 and friends decode to "plain text"; the catalog says decode.
  { when: ["plaintext"], add: ["decode"] },
  // A calculator is the calc tool; its operations name it too.
  { when: ["calculator"], add: ["calc"] },
  { when: ["multiply"], add: ["calc"] },
  { when: ["divide"], add: ["calc"] },
  { when: ["subtract"], add: ["calc"] },
  // The span between two dates is date-diff (duration parses "2h30m").
  { when: ["duration", "between"], add: ["date-diff"] },
  { when: ["time", "difference"], add: ["date-diff"] },
  // Measurement units, and a unit the converter knows by its plural only.
  { when: ["measurement"], add: ["units"] },
  { when: ["stone"], add: ["units"] },
  // Counting a table's rows is the lint tools' structure check (csv-lint
  // returns row and column counts).
  { when: ["count", "rows"], add: ["lint"] },
  // A briefing is a brief.
  { when: ["briefing"], add: ["brief"] },
  { when: ["briefings"], add: ["brief"] },
  // "time zones" and "timezones" are the catalog's "timezone".
  { when: ["time", "zones"], add: ["timezone"] },
  { when: ["time", "zone"], add: ["timezone"] },
  { when: ["timezones"], add: ["timezone"] },
].map((r) => Object.freeze({ when: Object.freeze(r.when), add: Object.freeze(r.add) })));

/**
 * Append the catalog words the query's synonyms name. Mutates `terms`;
 * returns a map from each added word to the query words that brought it in,
 * so coverage can read an added word as covering the words it stands for.
 * @param {string[]} terms
 * @returns {Map<string, string[]>}
 */
export function applySynonyms(terms) {
  const have = new Set(terms);
  const from = new Map();
  for (const rule of FIND_SYNONYMS) {
    if (!rule.when.every((w) => have.has(w))) continue;
    for (const a of rule.add) {
      if (!have.has(a)) { terms.push(a); have.add(a); }
      from.set(a, [...new Set([...(from.get(a) || []), ...rule.when])]);
    }
  }
  return from;
}

// OPERATION WORDS: what a task asks to compute or check. A top hit whose own
// text (slug, name, description, tags, aliases) never mentions the operation
// does not do the job, however strongly the rest of the query names it: "sum
// the totals of a csv" reaches csv-to-json on "csv" and "parse", and csv-to-json
// sums nothing (the demand board's real gaps, 2026-11-22). /api/find keeps
// such a query a miss, so the need is still recorded. Words only; each one is
// an operation in every phrasing that uses it.
export const FIND_OPERATION_WORDS = Object.freeze(new Set([
  "sum", "sums", "total", "totals", "aggregate", "distinct",
  "signature", "signatures", "position", "validity", "adjusted",
  "headers", "clean",
]));
