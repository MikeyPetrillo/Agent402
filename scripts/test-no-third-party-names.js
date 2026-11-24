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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { vendorHits, compileAllow, loadVendorData } from "./lib/vendor-names.js";
import { OWN_NAMES } from "./lib/own-names.js";

const ROOT = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("./data/third-party-hashes.json", import.meta.url), "utf8"));
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const HOSTS = new Set(data.hosts), NAMES = new Set(data.names);
const HOST_RE = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const WORD_RE = /[a-z0-9][a-z0-9-]{2,}/gi;

const README_BADGE_LINE = /^\[!\[[^\]\n]*\]\(https:\/\/[^\s()]+\)\]\(https:\/\/[^\s()]+\)$/;
const allowedLine = (file, line) =>
  file === "src/sor-seed-sellers.json" ||
  (file === "src/x402-index.js" && /^\s*"https:\/\/[^"]+",\s*\/\/ /.test(line)) ||
  (file === "scripts/paid-canary.js" && /^\s*body: \{ origin: "/.test(line)) ||
  // README "Independent records" (owner decision 2026-11-12): a line that is one badge image
  // linking to the outside service that keeps the record, and nothing else.
  (file === "README.md" && README_BADGE_LINE.test(line));

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
  ok(findHits("README.md", "[![zz](https://zzseller.invalid/b.svg)](https://zzseller.invalid/s)", H, N).length === 0, "a README line that is one badge linking to its record service passes");
  ok(findHits("README.md", "Bought from Zzcounterparty: [![zz](https://zzseller.invalid/b.svg)](https://zzseller.invalid/s)", H, N).length === 1 && findHits("docs/x.md", "[![zz](https://zzseller.invalid/b.svg)](https://zzseller.invalid/s)", H, N).length === 1, "a badge line with prose, or outside README.md, is still caught");
  // A site the maintainer operates is first-party: the list never carries it.
  for (const own of OWN_NAMES) {
    ok(!NAMES.has(h(own)) && !HOSTS.has(h(own)), `the list does not carry our own name ${own}`);
    ok(findHits("x.md", `Read the guide at https://www.${own}.ai/x402 or ${own}.tools`).length === 0, `a line naming our own site ${own} passes`);
  }
  ok(/filter\(\(s\) => s && !OWN_NAMES\.includes\(s\)\)/.test(readFileSync(new URL("./gen-third-party-hashes.js", import.meta.url), "utf8")), "the generator drops our own names from a names file");
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
// --- counterparties named in settlement code, never in published prose -----
// A facilitator behind a configuration variable is named in code (its
// variable, its client), but the published prose (the README, the wiki, docs/,
// the security policy, the changelog, the blog and guide pages) names none:
// it says "a facilitator". Variable names (ALL_CAPS identifiers) and the
// anchors built from them are code contracts and are set aside before the read.
const PUBLIC_NAMES = new Set(data.publicNames || []);
const PUBLIC_PROSE = (f) => /^(wiki|docs)\/.+\.md$/.test(f) || /^(README|SECURITY|CONTRIBUTING|AGENTS|CHANGELOG|llms-install)\.md$/.test(f) || f === "src/blog.js" || f === "src/guides.js";
export function publicProseHits(file, text, names = PUBLIC_NAMES) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const prose = line.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g, " ").replace(/\(#[a-z0-9-]+\)/g, " ").toLowerCase();
    if ((prose.match(WORD_RE) || []).some((t) => names.has(h(t)) || t.split(/[-.]/).some((p) => p.length >= 4 && names.has(h(p))))) out.push(`${file}:${i + 1}`);
  });
  return out;
}
{
  const N = new Set([h("zzfacilitator")]);
  ok(publicProseHits("wiki/x.md", "settles through Zzfacilitator's registry", N).length === 1, "control: a counterparty named in prose is caught");
  ok(publicProseHits("docs/x.md", "| `ZZFACILITATOR_API_KEY_ID` | Key id for a fallback facilitator. |", N).length === 0, "control: its configuration variable alone passes");
  ok(publicProseHits("docs/x.md", "[ZZFACILITATOR](#zzfacilitator) · ## ZZFACILITATOR", N).length === 0, "control: a variable group's heading and anchor pass");
  ok(publicProseHits("wiki/x.md", "default https://api.zzfacilitator.example/x402", N).length === 1, "control: a counterparty's host in prose is caught");
  ok(PUBLIC_NAMES.size >= 5, `the public-prose list is populated (${PUBLIC_NAMES.size} names)`);
  const proseHits = [];
  for (const f of files.filter(PUBLIC_PROSE)) {
    let text;
    try { text = readFileSync(new URL(f, ROOT), "utf8"); } catch { continue; }
    proseHits.push(...publicProseHits(f, text));
  }
  ok(proseHits.length === 0, `no published prose names a settlement counterparty${proseHits.length ? ":\n    " + proseHits.join("\n    ") : ""}`);
}
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
  // The packs' own listings end with the attribution sentences of the sources
  // their tools serve (src/data-attribution.js): read them as built.
  const { buildSkillTools } = await import("../src/tools/skill-runner.js");
  const kitTools = [];
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".js") && !/-worker\.js$/.test(f))) {
    for (const v of Object.values(await import(new URL(f, toolsDir)))) if (Array.isArray(v)) for (const t of v) if (t && typeof t === "object" && typeof t.slug === "string" && typeof t.route === "string") kitTools.push(t);
  }
  const packDefs = buildSkillTools({ getCatalog: () => Object.fromEntries(kitTools.map((t) => [t.route, t])) });
  for (const t of packDefs) for (const [field, text] of [["name", t.name], ["description", t.description]]) if (vendorHits(t.slug, field, text, VENDORS, ALLOW).length) found.push(`skill-runner.js ${t.slug} ${field}`);
  // At an allowed place a source with an attribution sentence is named only
  // inside that sentence: the text before the description's attribution run
  // names none of them.
  const { ATTRIBUTION_TAILS, attributionTailOf } = await import("../src/data-attribution.js");
  const attributed = new Set(ATTRIBUTION_TAILS.flatMap((x) => vendorHits("", "", x, VENDORS, {})));
  const outside = [];
  for (const t of [...kitTools, ...packDefs]) {
    const d = String(t.description || "");
    const tail = attributionTailOf(d) || "";
    if (vendorHits(t.slug, "description", d.slice(0, d.length - tail.length), VENDORS, {}).some((k) => attributed.has(k))) outside.push(t.slug);
  }
  ok(attributed.size >= 4, `the attribution sentences name the sources the vendor list carries (${attributed.size})`);
  ok(outside.length === 0, `a source is named only inside its attribution sentence (${outside.join(", ") || "none outside"})`);
  ok(packDefs.length === SKILL_PACKS.length, `the vendor check read every pack's own listing (${packDefs.length})`);
  ok(seen.size > 0 && SKILL_PACKS.length > 0, `the vendor check read the catalog (${seen.size} tools, ${SKILL_PACKS.length} skill packs)`);
  ok(found.length === 0, `no public tool or skill-pack text names an upstream vendor outside a required attribution${found.length ? ":\n    " + found.join("\n    ") : ""}`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
