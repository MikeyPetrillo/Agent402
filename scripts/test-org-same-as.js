// One sameAs list (src/org-profiles.js) for every Organization in our
// structured data:
//   1. the site entity (siteOrgLd, on every page) carries exactly ORG_SAME_AS;
//   2. the company on /company carries its own site, then exactly ORG_SAME_AS;
//   3. every profile is https, ours, and the MCP Registry name is the one
//      mcp/server.json publishes;
//   4. no other served module writes a profile URL into a sameAs of its own;
//   5. the site entity names what it is (description, disambiguatingDescription,
//      alternateName) and follows the MPP switch.
//
//   node scripts/test-org-same-as.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ORG_SAME_AS, MCP_REGISTRY_NAME, MCP_REGISTRY_ENTRY_URL, X_PROFILE_URL } from "../src/org-profiles.js";
import { siteOrgLd } from "../src/site-org.js";
import { companyPage } from "../src/company.js";
import { REPO_URL } from "../src/repo-link.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = "https://agent402.tools";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. the site entity
const org = siteOrgLd(B, { mpp: true });
ok(same(org.sameAs, [...ORG_SAME_AS]), "the site entity's sameAs is ORG_SAME_AS, in order");

// 2. the company on /company
const ld = [...companyPage(B).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => { const j = JSON.parse(m[1]); return [].concat(j["@graph"] || j); });
const nodes = []; const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); nodes.push(x); Object.values(x).forEach(walk); }; walk(ld);
const company = nodes.find((n) => n["@id"] === `${B}/#org` && Array.isArray(n.sameAs));
ok(company && same(company.sameAs, ["https://havok.holdings", ...ORG_SAME_AS]), "the company on /company lists its own site, then ORG_SAME_AS");
const siteOnCompany = nodes.find((n) => n["@id"] === `${B}/#organization` && Array.isArray(n.sameAs));
ok(siteOnCompany && same(siteOnCompany.sameAs, [...ORG_SAME_AS]), "the site entity on /company reads the same list");

// 3. every profile is https and ours
ok(ORG_SAME_AS.length === new Set(ORG_SAME_AS).size && ORG_SAME_AS.every((u) => new URL(u).protocol === "https:"), "every profile is a distinct https URL");
ok(ORG_SAME_AS.includes(REPO_URL) && ORG_SAME_AS.includes(X_PROFILE_URL) && ORG_SAME_AS.includes(MCP_REGISTRY_ENTRY_URL), "the list names the repository, X and the MCP Registry entry");
const server = JSON.parse(readFileSync(join(ROOT, "mcp", "server.json"), "utf8"));
if (!process.env.AGENT402_REPO_URL) ok(MCP_REGISTRY_NAME === server.name, `the MCP Registry name is the one mcp/server.json publishes (${MCP_REGISTRY_NAME})`);
ok(new URL(MCP_REGISTRY_ENTRY_URL).hostname === "registry.modelcontextprotocol.io" && decodeURIComponent(MCP_REGISTRY_ENTRY_URL).includes(`/servers/${server.name}/`), "the registry URL reads our own entry");
const PACKAGES = ["mcp", "client", "tollbooth"].map((d) => JSON.parse(readFileSync(join(ROOT, d, "package.json"), "utf8")).name);
for (const u of ORG_SAME_AS.filter((x) => x.includes("npmjs.com"))) ok(PACKAGES.includes(u.split("/package/")[1]), `${u} is a package this repository publishes`);

// 4. no served module keeps its own list
const PROFILE = /(?:npmjs\.com\/package\/agent402|x\.com\/Agent402Tools|pypi\.org\/project\/agent402|registry\.modelcontextprotocol\.io\/v0\.1\/servers)/;
const files = []; const walkDir = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDir(p); else if (f.endsWith(".js")) files.push(p); } }; walkDir(join(ROOT, "src"));
const offenders = files.filter((p) => !p.endsWith(join("src", "org-profiles.js"))).filter((p) => {
  const src = readFileSync(p, "utf8");
  return [...src.matchAll(/sameAs\s*:\s*\[([^\]]*)\]/g)].some((m) => PROFILE.test(m[1]));
}).map((p) => relative(ROOT, p));
ok(offenders.length === 0, `no module writes a profile URL into its own sameAs${offenders.length ? `: ${offenders.join(", ")}` : ""}`);
ok([...`sameAs: [REPO_URL, "https://x.com/Agent402Tools"]`.matchAll(/sameAs\s*:\s*\[([^\]]*)\]/g)].some((m) => PROFILE.test(m[1])), "control: a module-local list is caught");

// 5. the site entity says what it is
ok(org.alternateName.includes("Agent402.Tools") && /pay-per-call catalog of 500\+ tools for AI agents/.test(org.description) && /Havok Holdings LLC/.test(org.disambiguatingDescription) && org.disambiguatingDescription.includes("agent402.tools"), "the site entity carries a description, a disambiguating description and its alternate names");
ok(/x402 or MPP/.test(org.description) && !/MPP/.test(siteOrgLd(B, { mpp: false }).description), "the description names MPP only where MPP is offered");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
