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
  const { CODE_RUN_PER_PAYER_MAX, CODE_RUN_PER_IP_MAX } = await import("../src/tools/code-run-kit.js");
  const { unreadMax: u, unreadPaidMax: p } = cover.inflightCoverStatus();
  const min = Math.round(cover.GOOD_READ_MAX_MS / 60_000);
  ok(Number.isInteger(u) && Number.isInteger(p) && p > u && Number.isInteger(min) && min > 0 && CODE_RUN_PER_PAYER_MAX >= 1 && CODE_RUN_PER_IP_MAX > CODE_RUN_PER_PAYER_MAX,
    `control: the coverage figures read from the code (${u} unread, ${p} with a paid record, ${min} minutes, code-run ${CODE_RUN_PER_PAYER_MAX} per payer, ${CODE_RUN_PER_IP_MAX} per address)`);
  const vol = (String(read("wiki/Buying-at-Volume.md") || "").split("\n").find((l) => l.startsWith("| Paid calls in flight, per wallet")) || "");
  const sh = (String(read("wiki/Self-Hosting.md") || "").split("\n").find((l) => l.startsWith("| `INFLIGHT_COVER`")) || "");
  ok(vol.includes(`within the past ${min} minutes`) && vol.includes(`has not read in the past ${min} minutes`) && vol.includes(`runs up to ${u} calls at once (${p} for a wallet with a payment on record)`) && vol.includes(`a wallet runs up to ${u} calls at once there`) && vol.includes(`(the code-run tools: ${CODE_RUN_PER_PAYER_MAX} runs at once per EVM payer, credits key or Tempo sender; any other paid call counts only itself, and a call with no payment ${CODE_RUN_PER_IP_MAX} per client address)`),
    `wiki/Buying-at-Volume.md coverage row states ${u} and ${p} calls at once, ${min} minutes and code-run ${CODE_RUN_PER_PAYER_MAX}`);
  ok(sh.includes(`within the past ${min} minutes`) && sh.includes(`\`_UNREAD_MAX\` calls at once (default ${u})`) && sh.includes(`\`_UNREAD_PAID_MAX\` (default ${p})`) && sh.includes(`the code-run tools run ${CODE_RUN_PER_PAYER_MAX} at once per EVM payer, credits key or Tempo sender; any other paid call counts only itself, and a call with no payment ${CODE_RUN_PER_IP_MAX} per client address`),
    `wiki/Self-Hosting.md INFLIGHT_COVER row states defaults ${u} and ${p}, ${min} minutes and code-run ${CODE_RUN_PER_PAYER_MAX}`);
  // Every figure in the two wiki rows is one of the above, so a figure typed
  // beside them that the code does not hold is caught too.
  const stray = (row) => [...row.matchAll(/up to (\d+) calls at once|past (\d+) minutes|\(default (\d+)\)/g)].map((m) => Number(m[1] ?? m[2] ?? m[3])).filter((n) => ![u, p, min].includes(n));
  ok(stray(vol).length === 0 && stray(sh).length === 0, `no other coverage figure in the wiki rows (${[...stray(vol), ...stray(sh)].join(", ") || "none"})`);
  const guide = read("src/guides.js") || "";
  const row = guide.split("\n").find((l) => l.startsWith("| A wallet's paid calls in flight, on every paid route")) || "";
  ok(/const COVER_UNREAD_MAX = inflightCover\.inflightCoverStatus\(\)\.unreadMax;/.test(guide) && /const COVER_UNREAD_PAID_MAX = inflightCover\.inflightCoverStatus\(\)\.unreadPaidMax;/.test(guide) && /const COVER_GOOD_READ_MINUTES = Math\.round\(\(Number\(inflightCover\.GOOD_READ_MAX_MS\)/.test(guide) && /import \{ CODE_RUN_PER_PAYER_MAX, CODE_RUN_PER_IP_MAX \} from "\.\/tools\/code-run-kit\.js";/.test(guide),
    "src/guides.js reads the coverage figures and the code-run limit from the code");
  ok(row.includes("${COVER_GOOD_READ_MINUTES} minutes") && row.includes("up to ${COVER_UNREAD_MAX} calls at once (${COVER_UNREAD_PAID_MAX} with a payment on record)") && row.includes("(the code-run tools: ${CODE_RUN_PER_PAYER_MAX} runs at once per EVM payer, credits key or Tempo sender; any other paid call counts only itself, and a call with no payment ${CODE_RUN_PER_IP_MAX} per client address)") && !/\b\d+ calls at once|\bpast \d+ minutes|\b\d+ runs at once|\b\d+ per client address/.test(row),
    "src/guides.js coverage row quotes the derived figures and types none");
}
// What the coverage check keeps, and for how long (src/inflight-cover.js). A
// reservation lives for its call, and at most the shared window when a server
// stops mid-call. A kept balance read is used for at most GOOD_READ_MAX_MS; it
// stays while the wallet keeps calling (even with its balance unreadable) and
// is dropped by walletOf's bounded cleanup once the wallet is idle that long,
// sooner past the store's cap, or on restart. The privacy page and
// payment.dataHandling say exactly that, read every figure from the code, and
// never promise a hard bound on the read or "dropped at the next paid call".
{
  const priv = (read("src/privacy.js") || "").replace(/\s+/g, " ");
  const disc = read("src/discovery.js") || "";
  const cover = await import("../src/inflight-cover.js");
  const src = read("src/inflight-cover.js") || "";
  // Control: the cleanup the wording describes is the one in the code.
  ok(/if \(\+\+looked > 8\) break;/.test(src) && /if \(!over && now - v\.touched < GOOD_READ_MAX_MS\) break;/.test(src) && /if \(v\.open > 0 \|\| ledger\.has\(k\)\)/.test(src) && cover.COVER_WALLETS_MAX === 50_000 && Math.round(cover.sharedWindowMs() / 60_000) === 15,
    "control: walletOf clears at most eight of the longest idle wallets per call, by last touch, never one with a call in flight; the cap and the shared window read from the code");
  ok(priv.includes("kept in our shared store for the life of the call, and at most ${COVER_RESERVATION_MAX_MINUTES} minutes when a server stops mid-call") && /const COVER_RESERVATION_MAX_MINUTES = Math\.round\(\(2 \* sharedWindowMs\(\)\) \/ 60_000\);/.test(priv) && priv.includes("held in the server's memory and used for at most ${COVER_KEEP_MINUTES} minutes") && priv.includes("kept while the wallet goes on making paid calls, including while its balance cannot be read") && priv.includes("dropped when the wallet has been idle ${COVER_IDLE_MINUTES} minutes (with no paid call in flight), at a later paid call to the server, which clears the longest idle wallets a few at a time; sooner when the server holds ${COVER_WALLETS_MAX.toLocaleString(\"en-US\")} wallets (the longest idle first); or on restart") && priv.includes("kept there for ${COVER_SETTLED_MARK_MINUTES} minutes") && /const COVER_KEEP_MINUTES = Math\.round\(GOOD_READ_MAX_MS \/ 60_000\);/.test(priv) && /const COVER_IDLE_MINUTES = Math\.round\(GOOD_READ_MAX_MS \/ 60_000\);/.test(priv) && /const COVER_SETTLED_MARK_MINUTES = Math\.round\(SETTLED_MARK_MS \/ 60_000\);/.test(priv) && !/dropped at the next paid call/.test(priv) && !/neither is kept longer than/.test(priv),
    "src/privacy.js: a reservation for the call's life and at most the shared window; the kept read used for a derived time, kept while the wallet calls, dropped when idle by the bounded cleanup, sooner at the cap, or on restart; every figure derived");
  ok(disc.includes("for the life of the call, and at most ${Math.round((2 * sharedWindowMs()) / 60000)} minutes when a server stops mid-call") && disc.includes("used for at most ${Math.round(GOOD_READ_MAX_MS / 60000)} minutes, kept while the wallet goes on making paid calls (including while its balance cannot be read), and dropped when the wallet has been idle ${Math.round(GOOD_READ_MAX_MS / 60000)} minutes with no paid call in flight") && disc.includes("sooner when the server holds ${COVER_WALLETS_MAX} wallets") && disc.includes("kept there ${Math.round(SETTLED_MARK_MS / 60000)} minutes") && !/dropped at the next paid call/.test(disc) && !/neither longer than/.test(disc),
    "src/discovery.js dataHandling says the same, with the figures read from the code");
  // The changelog line that tells of that wording says the same, its figures
  // the code's: twice the shared window (each add renews the window key's
  // expiry, src/shared-limits.js WINDOW_ADD), the kept read's time, the cap.
  {
    const res = Math.round((2 * cover.sharedWindowMs()) / 60_000), keep = Math.round(cover.GOOD_READ_MAX_MS / 60_000), cap = cover.COVER_WALLETS_MAX.toLocaleString("en-US");
    const line = `a reservation per call in flight is kept for the life of the call, and at most ${res} minutes when a server stops mid-call, and that the last balance read is held in memory, used for at most ${keep} minutes, and dropped once the wallet has been idle ${keep} minutes, sooner when the server holds ${cap} wallets, or on restart`;
    const limits = read("src/shared-limits.js") || "";
    ok(/redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[2\]\)/.test(limits), "control: a window add renews its key's expiry, so a stopped server's reservation can outlast one window");
    for (const f of ["CHANGELOG.md", "src/changelog.js"]) {
      const t = (read(f) || "").replace(/\s+/g, " ");
      ok(t.includes(line) && !/dropped at the next paid call/.test(t), `${f}: the retention line reads the derived figures (${res} and ${keep} minutes, ${cap} wallets)`);
    }
  }
  // The admission's wait: about a second, and up to the admission wait plus
  // the read timeout when a settlement lands during the read.
  const secs = cover.ADMIT_SETTLED_READ_MAX_MS / 1000;
  ok(secs === 3.5 && /export const ADMIT_SETTLED_READ_MAX_MS = ADMIT_WAIT_MS \+ READ_TIMEOUT_MS;/.test(src), `control: the longest admission when a settlement lands during the read is the wait plus the read timeout (${secs} s)`);
  const guide = read("src/guides.js") || "";
  const QUAL = `up to about ${secs} seconds when a settlement lands during the`;
  ok(/const COVER_SETTLED_READ_SECONDS = \(Number\(inflightCover\.ADMIT_SETTLED_READ_MAX_MS\)/.test(guide) && guide.includes("(either takes up to about ${COVER_SETTLED_READ_SECONDS} seconds when a settlement lands during the read)"), "src/guides.js qualifies the one-second wait with the derived figure");
  for (const f of ["wiki/Buying-at-Volume.md", "wiki/Self-Hosting.md", "CHANGELOG.md", "src/changelog.js"]) {
    const t = (read(f) || "").replace(/\s+/g, " ");
    const seconds = (t.match(/about a second/g) || []).length;
    ok(seconds > 0 && t.includes(QUAL), `${f}: "about a second" carries the ${secs} s qualifier`);
  }
}
// A 429 on a catalog operation is not charged on x402 only: a Tempo transfer
// sent before the call is recorded as owed. The OpenAPI 429 every catalog
// operation carries and the API reference row say so, and name the coverage
// check as one limit among the documented ones.
{
  const pages = read("src/pages.js") || "";
  const api = read("wiki/API-Reference.md") || "";
  const SCOPE = "Not charged on x402; a Tempo transfer sent before the call is recorded as owed and repaid after on-chain proof.";
  const o429 = (pages.match(/const OPENAPI_429 = Object\.freeze\(\{ description: "([^"]*)" \}\);/) || [])[1] || "";
  const row = api.split("\n").find((l) => l.startsWith("| `429` |")) || "";
  ok(o429.includes("one of the documented limits") && o429.includes(SCOPE) && !/\band not charged\b|\bnever charged\b/i.test(o429) && /429: OPENAPI_429,/.test(pages),
    `src/pages.js: every catalog operation's 429 scopes "not charged" to x402 and names a Tempo transfer as owed (${o429.slice(0, 60)}...)`);
  ok(row.includes("one of the documented limits") && row.includes(SCOPE) && !/\band not charged\b|\bnever charged\b/i.test(row),
    "wiki/API-Reference.md: the 429 row scopes not charged to x402 and names a Tempo transfer as owed");
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
