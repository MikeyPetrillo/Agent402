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
// The in-flight coverage figures (src/inflight-cover.js): the allowance of
// calls at once for a wallet with no recent read (and with a payment on
// record), how long a kept read is judged on, and the code-run tools' own
// per-payer limit (src/tools/code-run-kit.js). The wiki types them; the guide
// rows read them from the code. Each figure is compared, so a changed default
// or a changed sentence fails here.
{
  for (const k of ["INFLIGHT_COVER_UNREAD_MAX", "INFLIGHT_COVER_UNREAD_PAID_MAX"]) delete process.env[k];
  const cover = await import("../src/inflight-cover.js");
  const { CODE_RUN_PER_PAYER_MAX } = await import("../src/tools/code-run-kit.js");
  const { unreadMax: u, unreadPaidMax: p } = cover.inflightCoverStatus();
  const min = Math.round(cover.GOOD_READ_MAX_MS / 60_000);
  ok(Number.isInteger(u) && Number.isInteger(p) && p > u && Number.isInteger(min) && min > 0 && CODE_RUN_PER_PAYER_MAX >= 1,
    `control: the coverage figures read from the code (${u} unread, ${p} with a paid record, ${min} minutes, code-run ${CODE_RUN_PER_PAYER_MAX})`);
  const vol = (String(read("wiki/Buying-at-Volume.md") || "").split("\n").find((l) => l.startsWith("| Paid calls in flight, per wallet")) || "");
  const sh = (String(read("wiki/Self-Hosting.md") || "").split("\n").find((l) => l.startsWith("| `INFLIGHT_COVER`")) || "");
  ok(vol.includes(`within the past ${min} minutes`) && vol.includes(`has not read in the past ${min} minutes`) && vol.includes(`runs up to ${u} calls at once (${p} for a wallet with a payment on record)`) && vol.includes(`a wallet runs up to ${u} calls at once there`) && vol.includes(`(the code-run tools: ${CODE_RUN_PER_PAYER_MAX} runs at once per payer)`),
    `wiki/Buying-at-Volume.md coverage row states ${u} and ${p} calls at once, ${min} minutes and code-run ${CODE_RUN_PER_PAYER_MAX}`);
  ok(sh.includes(`within the past ${min} minutes`) && sh.includes(`\`_UNREAD_MAX\` calls at once (default ${u})`) && sh.includes(`\`_UNREAD_PAID_MAX\` (default ${p})`) && sh.includes(`the code-run tools run ${CODE_RUN_PER_PAYER_MAX} at once per payer`),
    `wiki/Self-Hosting.md INFLIGHT_COVER row states defaults ${u} and ${p}, ${min} minutes and code-run ${CODE_RUN_PER_PAYER_MAX}`);
  // Every figure in the two wiki rows is one of the above, so a figure typed
  // beside them that the code does not hold is caught too.
  const stray = (row) => [...row.matchAll(/up to (\d+) calls at once|past (\d+) minutes|\(default (\d+)\)/g)].map((m) => Number(m[1] ?? m[2] ?? m[3])).filter((n) => ![u, p, min].includes(n));
  ok(stray(vol).length === 0 && stray(sh).length === 0, `no other coverage figure in the wiki rows (${[...stray(vol), ...stray(sh)].join(", ") || "none"})`);
  const guide = read("src/guides.js") || "";
  const row = guide.split("\n").find((l) => l.startsWith("| A wallet's paid calls in flight, on every paid route")) || "";
  ok(/const COVER_UNREAD_MAX = inflightCover\.inflightCoverStatus\(\)\.unreadMax;/.test(guide) && /const COVER_UNREAD_PAID_MAX = inflightCover\.inflightCoverStatus\(\)\.unreadPaidMax;/.test(guide) && /const COVER_GOOD_READ_MINUTES = Math\.round\(\(Number\(inflightCover\.GOOD_READ_MAX_MS\)/.test(guide) && /import \{ CODE_RUN_PER_PAYER_MAX \} from "\.\/tools\/code-run-kit\.js";/.test(guide),
    "src/guides.js reads the coverage figures and the code-run limit from the code");
  ok(row.includes("${COVER_GOOD_READ_MINUTES} minutes") && row.includes("up to ${COVER_UNREAD_MAX} calls at once (${COVER_UNREAD_PAID_MAX} with a payment on record)") && row.includes("(the code-run tools: ${CODE_RUN_PER_PAYER_MAX} runs at once per payer)") && !/\b\d+ calls at once|\bpast \d+ minutes|\b\d+ runs at once/.test(row),
    "src/guides.js coverage row quotes the derived figures and types none");
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
