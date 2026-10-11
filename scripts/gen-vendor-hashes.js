#!/usr/bin/env node
// Regenerates scripts/data/vendor-name-hashes.json for test-no-third-party-names.js.
// The list of upstream data and service vendors is private (VENDOR_NAMES_FILE, never
// committed) and is stored as truncated sha256 so the committed file names no one.
//
// One vendor per line, lowercased tokens as they appear in copy ("open-meteo",
// "nominatim"). A line may carry the places where the vendor's own terms require
// an attribution, after the first "|": comma-separated "slug-regex::field-regex"
// pairs (a skill pack's slug for its fields), for example
//   somevendor|^weather-::^description$
//   othervendor|^v1-::^input\.(model|tools)$
// Lines starting with "#" are comments.
//   VENDOR_NAMES_FILE=/path/to/vendor-names.txt node scripts/gen-vendor-hashes.js
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const file = process.env.VENDOR_NAMES_FILE;
if (!file) { console.error("VENDOR_NAMES_FILE is required (the vendor list stays private)"); process.exit(2); }
const vendors = new Set();
const allow = {};
for (const raw of readFileSync(file, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const cut = line.indexOf("|");
  const name = cut < 0 ? line : line.slice(0, cut);
  const places = cut < 0 ? "" : line.slice(cut + 1);
  const key = h(name.trim().toLowerCase());
  vendors.add(key);
  const list = places.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of list) {
    if (!/^.+::.+$/.test(p)) { console.error(`bad allowance "${p}" (want slug-regex::field-regex)`); process.exit(2); }
    (allow[key] ||= []).push(p);
  }
}
const out = {
  _note: "sha256 (first 20 hex) of lowercased upstream vendor names that public tool text must not carry, plus the slug::field places where a vendor's terms require attribution. Hashed so this file does not itself name them. Regenerate with scripts/gen-vendor-hashes.js.",
  vendors: [...vendors].sort(),
  attribution: Object.fromEntries(Object.entries(allow).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(new URL("./data/vendor-name-hashes.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`vendors ${out.vendors.length}, attribution places ${Object.values(allow).flat().length}`);
