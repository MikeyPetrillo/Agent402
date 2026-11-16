#!/usr/bin/env node
// Bazaar presence check: is every route of ours in the CDP discovery listing?
//
// Routes have been observed to leave the listing outside the 30-day window
// the keep-alive passes cover (2026-11-14: two routes, settled 17 days and
// less earlier, left the listing for up to an hour and came back only after
// a settlement of ours). This check reads the listing every few hours
// (.github/workflows/bazaar-presence.yml) and decides three things:
//
//   which routes to buy   A route is missing when every full pass of the
//                         listing lacks it (walkAgreed, two passes at least,
//                         a third when they disagree), so a page shift
//                         between requests never reads as a missing row. A
//                         missing route is bought once per absence: on the
//                         first check that finds it missing, never again
//                         while it stays missing. Exempt kinds are never
//                         bought (scripts/lib/keepalive-plan.js exemptKind:
//                         quoted, model-priced, the route-execute tiers and
//                         every route whose effect outlives the answer), nor
//                         is a route the twice-monthly pass above the ceiling
//                         owns (aboveCeilingRoutes: report products and
//                         premium tiers; their price, and the upstream work
//                         behind it, does not belong in a pass every few
//                         hours). The whole buy is refused when it holds more
//                         than MAX_ROUTES routes or its list prices together
//                         are over MAX_SPEND_USD.
//   whether to page       ONE issue opens when a route is missing on two
//                         readable checks in a row (the first check bought
//                         it, or could not), whatever its kind, and when
//                         the listing or our catalog has been unreadable on
//                         UNREADABLE_PAGE_AFTER checks in a row. It closes
//                         on a readable check with no repeat miss.
//   what to remember      The routes missing now and the unreadable streak,
//                         for the next check (the workflow keeps the file in
//                         the Actions cache). An unreadable check keeps the
//                         previous missing set, buys nothing and closes
//                         nothing.
//
// Reads only: /api/pricing and the listing. The buy is scripts/refresh-bazaar.js
// MODE=missing with the slugs this writes (REQUIRE_SLUGS=1), which reads the
// listing again and buys only what is still missing then.
//
// The run logs and the issue are public: nothing here prints a price, a total
// or a cap, and the issue carries route paths of ours and fixed words only.
//
// Env: TARGET_URL (default https://agent402.tools), BAZAAR_REGISTRY_URL,
// STATE_FILE (read and rewritten), OUT_DIR (body.md), OPEN_ISSUE (the number
// of the open issue, empty when none), MAX_SPEND_USD, MAX_ROUTES,
// UNREADABLE_PAGE_AFTER. Writes slugs=, max_price=, action= to $GITHUB_OUTPUT.
// Exit: 0 (a refusal and an unreadable listing included), 2 bad usage.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { walkAgreed, BAZAAR_REGISTRY_URL } from "./listing-coverage.js";
import {
  exemptKind, aboveCeilingRoutes, usdMicros, microsToUsd, spendCapVerdict, routeCountVerdict,
} from "./lib/keepalive-plan.js";

export const DEFAULT_MAX_ROUTES = 10;
export const DEFAULT_MAX_SPEND_USD = 2;
export const UNREADABLE_PAGE_AFTER = 3;
export const ISSUE_TITLE = "Bazaar presence check";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
// A path printed into the public issue: our own catalog's shape only.
const PATH_RE = /^\/[A-Za-z0-9/_.:-]{1,200}$/;

/** A listing resource URL -> its path when it is on `host`, else null. */
export function pathOnHost(resource, host) {
  try {
    const u = new URL(String(resource));
    return u.host.toLowerCase() === String(host).toLowerCase() ? u.pathname : null;
  } catch { return null; }
}

/** The catalog's priced rows as { slug, path, method, micros }, one per path. */
export function catalogRows(pricing) {
  const rows = Array.isArray(pricing?.endpoints) ? pricing.endpoints : Array.isArray(pricing?.tools) ? pricing.tools : [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.path !== "string" || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({ row: r, slug: typeof r.slug === "string" ? r.slug : "", path: r.path, method: String(r.method || "GET").toUpperCase(), micros: usdMicros(r.price) });
  }
  return out;
}

/** Why the presence check does not buy a route, or null when it may. */
export function presenceExemption(entry, tailSlugs) {
  if (!SLUG_RE.test(entry.slug)) return "unreadable slug";
  if (!(entry.micros > 0)) return "unpriced";
  const kind = exemptKind(entry.row);
  if (kind) return kind;
  if (tailSlugs.has(entry.slug)) return "above the ceiling";
  return null;
}

/** Pure: the catalog's routes absent from every pass of the listing. `passes`
 *  is walkAgreed's: each with `keys`, the set of our paths it held. */
export function missingFromEveryPass(catalog, passes) {
  const seen = new Set();
  for (const p of passes || []) for (const k of p.keys || []) seen.add(k);
  return catalog.filter((c) => !seen.has(c.path));
}

/** Pure: the decision for one check. `reading` is null when the listing or the
 *  catalog could not be read, else { pricing, passes }. `prev` is the state the
 *  last check left ({ missing: { path: note }, unreadable }), or null. */
export function decide({ reading, prev, openIssue = false, maxSpendUsd = DEFAULT_MAX_SPEND_USD, maxRoutes = DEFAULT_MAX_ROUTES, unreadablePageAfter = UNREADABLE_PAGE_AFTER }) {
  const prevMissing = prev && prev.missing && typeof prev.missing === "object" ? prev.missing : {};
  const prevStreak = Number.isInteger(prev?.unreadable) && prev.unreadable > 0 ? prev.unreadable : 0;
  if (!reading) {
    const streak = prevStreak + 1;
    const page = streak >= unreadablePageAfter;
    return {
      readable: false, buy: [], refused: null, repeat: [], exempt: [], newlyMissing: [],
      state: { missing: prevMissing, unreadable: streak },
      action: page && !openIssue ? "open" : "none", cause: page ? "unreadable" : null,
    };
  }
  const catalog = catalogRows(reading.pricing);
  const tailSlugs = new Set(aboveCeilingRoutes(reading.pricing).map((r) => r.slug));
  const missing = missingFromEveryPass(catalog, reading.passes);
  const repeat = missing.filter((m) => Object.hasOwn(prevMissing, m.path));
  const newlyMissing = missing.filter((m) => !Object.hasOwn(prevMissing, m.path));
  const exempt = [];
  let buy = [];
  for (const m of newlyMissing) {
    const why = presenceExemption(m, tailSlugs);
    if (why) exempt.push({ ...m, why }); else buy.push(m);
  }
  let refused = null;
  if (buy.length) {
    const count = routeCountVerdict(buy, maxRoutes);
    const spend = spendCapVerdict(buy, maxSpendUsd);
    if (!count.ok) refused = count.reason;
    else if (!spend.ok) refused = spend.reason;
    if (refused) buy = [];
  }
  const state = { missing: {}, unreadable: 0 };
  for (const m of repeat) state.missing[m.path] = prevMissing[m.path];
  for (const m of exempt) state.missing[m.path] = m.why;
  for (const m of newlyMissing) if (!Object.hasOwn(state.missing, m.path)) state.missing[m.path] = refused ? "refused" : "bought";
  const action = repeat.length ? (openIssue ? "update" : "open") : openIssue ? "close" : "none";
  return { readable: true, buy, refused, repeat, exempt, newlyMissing, state, action, cause: repeat.length ? "missing" : null };
}

const NOTE = {
  bought: "a buy was sent on the check before",
  refused: "not bought: the check before refused the buy under its caps",
  quoted: "not bought here: quoted route",
  "model-priced": "not bought here: model-priced route",
  "route-execute": "not bought here: route-execute tier",
  "lasting-effect": "not bought here: its effect outlives the answer",
  "above the ceiling": "not bought here: the pass above the ceiling buys it",
  unpriced: "not bought here: unpriced",
  "unreadable slug": "not bought here: unreadable slug",
};

/** The issue body: fixed text and our own route paths, no figure or count. */
export function issueBody(decision, runUrl = "") {
  const run = runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl) ? `\n\nRun: ${runUrl}` : "";
  if (decision.cause === "unreadable") {
    return "The Bazaar presence check could not read the CDP discovery listing, or our own catalog, on several checks in a row, so it cannot tell whether every route of ours is listed. Nothing is bought while the listing is unreadable. This issue closes on the next readable check that finds no route missing twice in a row." + run;
  }
  const lines = decision.repeat
    .filter((m) => PATH_RE.test(m.path))
    .map((m) => `- \`${m.method} ${m.path}\`: ${NOTE[decision.state.missing[m.path]] || "not bought here"}`);
  return [
    "These routes of ours were observed to leave the Bazaar discovery listing and were still missing on the next check (each check reads the listing in two full passes at least, and a route counts as missing only when every pass lacks it).",
    "",
    ...lines,
    "",
    "A route the check may buy is bought once per absence (scripts/bazaar-presence.js, then scripts/refresh-bazaar.js MODE=missing). A route still missing after that, or one of a kind the check never buys, needs a hand pass: `gh workflow run bazaar-keepalive.yml --ref main -f slugs=<slug>` for a route at or under the ceiling, `gh workflow run bazaar-keepalive-tail.yml --ref main` for one above it. This issue closes on the next readable check with no route missing twice in a row.",
  ].join("\n") + run;
}

/** The log lines for one decision: counts, paths and words, never a figure. */
export function logLines(d) {
  if (!d.readable) return [`The listing or the catalog could not be read; nothing bought. Unreadable checks in a row: ${d.state.unreadable}.`];
  const out = [`Routes missing from every pass: ${d.newlyMissing.length + d.repeat.length} (newly missing ${d.newlyMissing.length}, missing on the check before too ${d.repeat.length}).`];
  for (const m of d.newlyMissing) if (PATH_RE.test(m.path)) out.push(`  missing ${m.method} ${m.path}${d.exempt.some((e) => e.path === m.path) ? ` (not bought: ${d.exempt.find((e) => e.path === m.path).why})` : ""}`);
  for (const m of d.repeat) if (PATH_RE.test(m.path)) out.push(`  still missing ${m.method} ${m.path}`);
  if (d.refused) out.push(`Refusing the buy: ${d.refused}. Nothing bought.`);
  else out.push(`Routes to buy: ${d.buy.length}.`);
  return out;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Reads the catalog and the listing; null when either is unreadable, or the
 *  listing holds none of our routes (an empty listing is no reading). */
export async function readListing({ target, registryUrl = BAZAAR_REGISTRY_URL, fetchJson = getJson, log = () => {} }) {
  const host = new URL(target).host;
  try {
    const pricing = await fetchJson(`${target.replace(/\/+$/, "")}/api/pricing`);
    if (catalogRows(pricing).length === 0) { log("The catalog lists no routes."); return null; }
    const feed = await walkAgreed(registryUrl, {
      isOurs: (it) => pathOnHost(it?.resource, host) !== null,
      keyOf: (it) => pathOnHost(it?.resource, host),
      fetchJson,
    });
    log(`The listing was read in ${feed.passes.length} full passes${feed.agreed ? "; the last two agree" : "; they disagree, so only a route absent from every pass counts as missing"}.`);
    if (feed.passes.some((p) => p.keys.size === 0)) { log("A pass held none of our routes; not a reading."); return null; }
    return { pricing, passes: feed.passes };
  } catch (e) {
    log(`Read failed (${String(e?.message || e).replace(/\$\s?\d[\d.,]*/g, "").slice(0, 120)}).`);
    return null;
  }
}

function readState(file) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** One check; returns the exit code. Every dependency is injectable so
 *  scripts/test-bazaar-presence.js runs it offline. */
export async function run({ env = process.env, log = console.log, fetchJson = getJson } = {}) {
  const target = env.TARGET_URL || "https://agent402.tools";
  try { new URL(target); } catch { log("bazaar-presence: TARGET_URL is not a URL"); return 2; }
  const maxRoutes = env.MAX_ROUTES === undefined || env.MAX_ROUTES === "" ? DEFAULT_MAX_ROUTES : Number(env.MAX_ROUTES);
  const maxSpendUsd = env.MAX_SPEND_USD === undefined || env.MAX_SPEND_USD === "" ? DEFAULT_MAX_SPEND_USD : env.MAX_SPEND_USD;
  const pageAfter = Math.max(1, parseInt(env.UNREADABLE_PAGE_AFTER || "", 10) || UNREADABLE_PAGE_AFTER);
  const prev = readState(env.STATE_FILE);
  const reading = await readListing({ target, registryUrl: env.BAZAAR_REGISTRY_URL || BAZAAR_REGISTRY_URL, fetchJson, log });
  const d = decide({ reading, prev, openIssue: /^\d+$/.test(String(env.OPEN_ISSUE || "")), maxSpendUsd, maxRoutes, unreadablePageAfter: pageAfter });
  for (const l of logLines(d)) log(l);
  log(`Issue: ${d.action}.`);
  if (env.STATE_FILE) writeFileSync(env.STATE_FILE, JSON.stringify({ v: 1, ...d.state }));
  if (env.OUT_DIR) {
    mkdirSync(env.OUT_DIR, { recursive: true });
    writeFileSync(join(env.OUT_DIR, "body.md"), issueBody(d, env.RUN_URL || ""));
  }
  if (env.GITHUB_OUTPUT) {
    const max = d.buy.reduce((m, r) => Math.max(m, r.micros), 0);
    appendFileSync(env.GITHUB_OUTPUT, `slugs=${d.buy.map((r) => r.slug).join(",")}\nmax_price=${d.buy.length ? microsToUsd(max) : ""}\naction=${d.action}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => process.exit(code), (e) => { console.error("bazaar-presence:", String(e?.message || e).slice(0, 160)); process.exit(2); });
}
