#!/usr/bin/env node
// No third-party seller host or counterparty name in a tracked file, and no
// upstream vendor name in public tool text outside a required attribution.
//
// Public files carry technical mechanism only; a seller we investigated, a
// counterparty we talked to or a competitor is never named, in copy, comments,
// tests or fixtures (use placeholder hosts under .example / .invalid). A
// 2026-10-06 audit found about forty such names across src, scripts and
// served pages, each added by a well-meaning edit that no check looked at.
// This is that check. The list is carried as hashes
// (scripts/data/third-party-hashes.json) so this test names no one either.
//
// Allowed on purpose: the router seed (src/sor-seed-sellers.json), the index's
// default seed list in src/x402-index.js (one seeded origin per line, with its
// comment), and the paid canary's target origin.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { vendorHits, compileAllow, loadVendorData } from "./lib/vendor-names.js";

const ROOT = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("./data/third-party-hashes.json", import.meta.url), "utf8"));
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const HOSTS = new Set(data.hosts), NAMES = new Set(data.names);
const HOST_RE = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const WORD_RE = /[a-z0-9][a-z0-9-]{2,}/gi;

const allowedLine = (file, line) =>
  file === "src/sor-seed-sellers.json" ||
  (file === "src/x402-index.js" && /^\s*"https:\/\/[^"]+",\s*\/\/ /.test(line)) ||
  (file === "scripts/paid-canary.js" && /^\s*body: \{ origin: "/.test(line));

export function findHits(file, text, hosts = HOSTS, names = NAMES) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (allowedLine(file, line)) return;
    const lower = line.toLowerCase();
    const hostHit = (lower.match(HOST_RE) || []).some((t) => hosts.has(h(t)) || hosts.has(h(t.replace(/^www\./, ""))));
    const nameHit = !hostHit && (lower.match(WORD_RE) || []).some((t) => names.has(h(t)) || t.split("-").some((p) => p.length >= 4 && names.has(h(p))) || t.split(".").some((p) => names.has(h(p))));
    if (hostHit || nameHit) out.push(`${file}:${i + 1}`);
  });
  return out;
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Controls: a synthetic denylist entry is caught as a host, inside a URL, and
// as a bare name; a placeholder host is not.
{
  const H = new Set([h("zzseller.invalid")]), N = new Set([h("zzcounterparty")]);
  ok(findHits("x.js", 'fetch("https://zzseller.invalid/api")', H, N).length === 1, "control: a denylisted host inside a URL is caught");
  ok(findHits("x.js", "// talked to Zzcounterparty about it", H, N).length === 1, "control: a denylisted name is caught case-insensitively");
  ok(findHits("x.js", 'origin: "https://seller.example"', H, N).length === 0, "control: a placeholder host passes");
  ok(data.hosts.length > 100 && data.names.length > 10, `the hash list is populated (${data.hosts.length} hosts, ${data.names.length} names)`);
}

const SKIP = /(^|\/)(package-lock\.json|third-party-hashes\.json|vendor-name-hashes\.json)$|\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|webp|svg|mp3|zip|gz)$/i;
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && !SKIP.test(f));
const hits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(new URL(f, ROOT), "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue;
  hits.push(...findHits(f, text));
}
ok(hits.length === 0, `no tracked file names a third-party seller or counterparty (${files.length} files scanned)${hits.length ? ":\n    " + hits.join("\n    ") : ""}`);
// --- upstream vendor names in public tool text ------------------------------
// Tool names, descriptions, tags and input descriptions, and every skill-pack
// string, describe the data, not the vendor it is read from. The vendor list is
// hashed (scripts/data/vendor-name-hashes.json, scripts/gen-vendor-hashes.js);
// where a source's terms require attribution, the list names the slug::field
// places that may carry it, and the tool's source has a comment citing the terms.
const { data: vdata, vendors: VENDOR_SET, allow: VENDOR_ALLOW } = loadVendorData();
{
  const V = new Set([h("zzvendor")]), A = compileAllow({ [h("zzvendor")]: ["^zz-weather$::^description$"] });
  ok(vendorHits("x", "description", "Prices from Zzvendor's feed", V, A).length === 1, "control: a vendor name in a description is caught");
  ok(vendorHits("x", "tags", "zzvendor-data", V, A).length === 1, "control: a vendor name inside a hyphenated tag is caught");
  ok(vendorHits("zz-weather", "description", "Data by Zzvendor (CC BY 4.0)", V, A).length === 0, "control: an attribution at an allowed place passes");
  ok(vendorHits("zz-weather", "name", "Zzvendor weather", V, A).length === 1, "control: the same vendor at another field of that tool is caught");
  ok(vdata.vendors.length >= 10, `the vendor hash list is populated (${vdata.vendors.length} vendors)`);
}
{
  const VENDORS = VENDOR_SET, ALLOW = VENDOR_ALLOW;
  const toolsDir = new URL("../src/tools/", import.meta.url);
  const found = [];
  const seen = new Set();
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".js") && !/-worker\.js$/.test(f))) {
    const mod = await import(new URL(f, toolsDir));
    for (const v of Object.values(mod)) if (Array.isArray(v)) for (const t of v) {
      if (!t || typeof t !== "object" || !t.slug || typeof t.description !== "string" || seen.has(t.slug)) continue;
      seen.add(t.slug);
      const fields = [["name", t.name], ["description", t.description], ["tags", (t.tags || []).join(" ")]];
      for (const [k, d] of Object.entries(t.discovery?.inputSchema?.properties || {})) if (d?.description) fields.push([`input.${k}`, d.description]);
      for (const [field, text] of fields) if (vendorHits(t.slug, field, text, VENDORS, ALLOW).length) found.push(`${f} ${t.slug} ${field}`);
    }
  }
  const { SKILL_PACKS } = await import("../src/skills.js");
  for (const pack of SKILL_PACKS) {
    const walk = (o, path) => {
      if (typeof o === "string") { if (vendorHits(pack.slug, path, o, VENDORS, ALLOW).length) found.push(`skills.js ${pack.slug} ${path}`); }
      else if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (o && typeof o === "object") for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(pack, "");
  }
  ok(seen.size >= 400 && SKILL_PACKS.length >= 10, `the vendor check read the catalog (${seen.size} tools, ${SKILL_PACKS.length} skill packs)`);
  ok(found.length === 0, `no public tool or skill-pack text names an upstream vendor outside a required attribution${found.length ? ":\n    " + found.join("\n    ") : ""}`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
