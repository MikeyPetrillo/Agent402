#!/usr/bin/env node
// Regenerates scripts/data/third-party-hashes.json for test-no-third-party-names.js.
// Hosts come from the public x402 discovery catalogs; names come from a private
// list (THIRD_PARTY_NAMES_FILE, one per line) that is never committed. Both are
// stored as truncated sha256 so the committed file names no one.
//   THIRD_PARTY_NAMES_FILE=/path/to/names.txt node scripts/gen-third-party-hashes.js
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
// Hosts this repo legitimately names: our own, upstreams, rails, registries.
const ALLOW = new Set(["agent402.tools", "www.agent402.tools", "example.com", "google.com", "www.google.com", "httpbin.org", "api.exa.ai",
  "pro-api.coingecko.com", "api.coingecko.com", "api.blockscout.com", "merchant.payai.network", "facilitator.payai.network", "www.x402scan.com",
  "x402scan.com", "sandbox.node4all.com", "api.cdp.coinbase.com", "openrouter.ai", "api.openai.com", "github.com", "api.github.com"]);
const hosts = new Set();
for (const base of ["https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources", "https://facilitator.payai.network/discovery/resources"]) {
  for (let off = 0, p = 0; p < 400; p++) {
    const j = await (await fetch(`${base}?limit=1000&offset=${off}`)).json().catch(() => null);
    const items = j?.items || [];
    if (!items.length) break;
    for (const it of items) { try { hosts.add(new URL(it.resource).hostname.toLowerCase()); } catch {} }
    off += items.length;
    if (off >= (j.pagination?.total || 0)) break;
  }
}
const names = process.env.THIRD_PARTY_NAMES_FILE ? readFileSync(process.env.THIRD_PARTY_NAMES_FILE, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
if (!names.length) { console.error("THIRD_PARTY_NAMES_FILE is required (the names list stays private)"); process.exit(2); }
const out = {
  _note: "sha256 (first 20 hex) of lowercased third-party seller hosts (from public discovery catalogs) and counterparty names. Hashed so this file does not itself name them. Regenerate with scripts/gen-third-party-hashes.js.",
  hosts: [...new Set([...hosts].filter((x) => !ALLOW.has(x)).map(h))].sort(),
  names: [...new Set(names.map(h))].sort(),
};
writeFileSync(new URL("./data/third-party-hashes.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`hosts ${out.hosts.length}, names ${out.names.length}`);
