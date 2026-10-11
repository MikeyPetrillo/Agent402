// Shared by test-no-third-party-names.js (the tool kits and skill packs, read
// offline) and test-static-pages.js (the catalog a booted server serves):
// public tool text describes the data, not the upstream vendor it comes from.
// The vendor list is hashed (scripts/data/vendor-name-hashes.json, regenerated
// by scripts/gen-vendor-hashes.js from a private list); where a source's terms
// require attribution the list names the slug::field places that may carry it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const WORD_RE = /[a-z0-9][a-z0-9-]{2,}/gi;

export function compileAllow(attr) {
  return Object.fromEntries(Object.entries(attr || {}).map(([k, v]) => [k, v.map((p) => { const [s, f] = p.split("::"); return [new RegExp(s), new RegExp(f)]; })]));
}

export function loadVendorData() {
  const data = JSON.parse(readFileSync(new URL("../data/vendor-name-hashes.json", import.meta.url), "utf8"));
  return { data, vendors: new Set(data.vendors), allow: compileAllow(data.attribution) };
}

/** Vendor hashes named in `text` at slug/field, minus the allowed attribution places. */
export function vendorHits(slug, field, text, vendors, allow = {}) {
  const tokens = String(text || "").toLowerCase().match(WORD_RE) || [];
  const hit = new Set();
  for (const t of tokens) for (const part of [t, ...t.split("-").filter((p) => p.length >= 4)]) if (vendors.has(h(part))) hit.add(h(part));
  return [...hit].filter((k) => !(allow[k] || []).some(([s, f]) => s.test(slug) && f.test(field)));
}
