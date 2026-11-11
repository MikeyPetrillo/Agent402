#!/usr/bin/env node
// Docs that state a REQUIREMENT must match the thing that enforces it.
//
//   node scripts/test-doc-claims.js        (offline, no server)
//
// Two claims drifted from their own source of truth and nothing could see it:
//
//   * wiki/Self-Hosting.md said "Node.js >= 20" while package.json requires
//     >= 22.22.2, so a reader following the prerequisites hit a failing
//     `npm ci` on the version the docs told them to install.
//   * wiki/Pay-per-crawl-Walkthrough.md said "Node 18+" while the tollbooth
//     package declares engines.node >= 20.
//
// A version in prose is a promise about what will work. Pin it to `engines`,
// which is what actually refuses the install.
//
// ONE-DIRECTIONAL on purpose: a doc stating a HIGHER major than `engines`
// requires is not a failure - it turns nobody away who would have succeeded,
// it just asks for a newer runtime than the floor. Only the reverse breaks a
// reader, so only the reverse fails here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };
const engines = (rel) => { try { return JSON.parse(read(rel) || "{}").engines?.node || null; } catch { return null; } };
const major = (spec) => { const m = String(spec || "").match(/(\d+)/); return m ? Number(m[1]) : null; };

// --- every published package declares a runtime it supports ----------------
{
  const dirs = ["mcp", "client", "tollbooth", "openclaw", ...readdirSync(join(root, "adapters"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => `adapters/${d.name}`)];
  const missing = [];
  for (const d of dirs) {
    const pkg = read(`${d}/package.json`);
    if (!pkg) continue;
    let j; try { j = JSON.parse(pkg); } catch { continue; }
    if (j.private) continue;
    if (!j.engines?.node) missing.push(`${j.name || d} (${d})`);
  }
  ok(missing.length === 0,
     `every published package declares engines.node${missing.length ? ` - MISSING: ${missing.join(", ")}` : ""}`);
}

// --- prose version claims match the engines that enforce them --------------
// [doc, regex capturing the stated major, package whose engines it describes]
const CLAIMS = [
  ["wiki/Self-Hosting.md", /Node\.js >= *(\d+)/, "package.json", "the server's own prerequisites"],
  ["wiki/Pay-per-crawl-Walkthrough.md", /Node (\d+)\+ runtime/, "tollbooth/package.json", "the tollbooth a reader installs"],
];
// Control first: a doc claiming a lower major than its package must be caught.
const compare = (stated, required) => stated !== null && required !== null && stated < required;
ok(compare(18, 20), "control: a doc stating an older major than engines is reported by this comparison");
ok(!compare(22, 22), "control: a doc matching engines is not reported");

for (const [doc, re, pkg, why] of CLAIMS) {
  const text = read(doc);
  const m = text ? text.match(re) : null;
  ok(!!m, `${doc} still states a Node version (${why})`);
  if (!m) continue;
  const stated = Number(m[1]);
  const required = major(engines(pkg));
  ok(required !== null, `${pkg} declares engines.node (got ${engines(pkg)})`);
  ok(!compare(stated, required),
     `${doc} says Node ${stated}+ and ${pkg} requires ${engines(pkg)} - the doc must not promise a version the install refuses`);
}

// --- limits and alarm words in prose match the code that decides them ------
// The settle-failure breaker: verdict failures refuse at MAX_FAILS, failures of
// unknown cause at UNKNOWN_MAX_FAILS, and a failure on our side or the
// facilitator's is never counted (src/gateway-settle-breaker.js). The wiki row
// and the /guides/buying-at-volume row both say all three.
{
  const b = await import("../src/gateway-settle-breaker.js");
  const flat = (t) => String(t || "").replace(/\s+/g, " ");
  const vol = flat(read("wiki/Buying-at-Volume.md"));
  const guide = flat(read("src/guides.js"));
  const NEVER = /could not complete on this server's side or the facilitator's \([^)]*\) is never counted against the wallet/;
  ok(b.UNKNOWN_MAX_FAILS > b.MAX_FAILS, `control: unknown-cause failures refuse later than verdicts (${b.MAX_FAILS} < ${b.UNKNOWN_MAX_FAILS})`);
  ok(vol.includes(`failed to settle for a reason about the payment itself`) && vol.includes(`at ${b.MAX_FAILS} in ${Math.round(b.WINDOW_MS / 60_000)} minutes (${b.UNKNOWN_MAX_FAILS} for failures whose cause the settlement did not name`) && NEVER.test(vol),
    `wiki/Buying-at-Volume.md breaker row: verdicts at ${b.MAX_FAILS}, unknown causes at ${b.UNKNOWN_MAX_FAILS}, our side or the facilitator's never counted`);
  ok(guide.includes("failed to settle for a reason about the payment itself") && guide.includes("(${SETTLE_BREAKER_UNKNOWN_MAX} for failures whose cause the settlement did not name") && /UNKNOWN_MAX_FAILS as SETTLE_BREAKER_UNKNOWN_MAX/.test(guide) && NEVER.test(guide),
    "src/guides.js breaker row reads the unknown-cause count from the code and says our side or the facilitator's is never counted");
}
// facilitatorFunds: a gas balance under the floor reads low; one that cannot
// be read reads unknown (src/tool-failure-monitor.js), which does not page.
{
  const mon = read("src/tool-failure-monitor.js");
  const { thresholds } = await import("../src/tool-failure-monitor.js");
  const rh = String(read("wiki/Robinhood-Chain.md") || "").replace(/\s+/g, " ");
  ok(/gasLow\.length \? "low" : gasUnread\.length \? "unknown"/.test(mon), "control: the monitor reads an unread gas balance as unknown and a low one as low");
  ok(/cannot be read three times running reads `facilitatorFunds=unknown`, which pages only once it has held past `FACILITATOR_UNREAD_PAGE_HOURS` \(default (\d+)\)/.test(rh) && Number(rh.match(/FACILITATOR_UNREAD_PAGE_HOURS` \(default (\d+)\)/)?.[1]) === Math.round(thresholds({}).gasUnreadPageMs / 3_600_000) && !/cannot be read three times running, reads `facilitatorFunds=low`/.test(rh),
    "wiki/Robinhood-Chain.md says an unreadable balance reads facilitatorFunds=unknown and pages only past the code's default hours");
}

console.log(`test-doc-claims: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
