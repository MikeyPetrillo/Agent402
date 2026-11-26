#!/usr/bin/env node
// Bazaar presence check: is every route of ours in the CDP discovery listing?
//
// Routes have been observed to leave the listing inside the 30-day window
// the keep-alive passes cover (2026-11-14: two routes, settled 17 days and
// less earlier, left the listing for up to an hour and returned after a
// settlement of ours). This check reads the listing every few hours
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
//                         quoted with no fromInput, model-priced, the route-execute tiers and
//                         every route whose effect outlives the answer), nor
//                         is a route the twice-monthly pass above the ceiling
//                         owns (aboveCeilingRoutes: report products and
//                         premium tiers; their price, and the upstream work
//                         behind it, does not belong in a pass every few
//                         hours). The whole buy is refused when it holds more
//                         than MAX_ROUTES routes or its list prices together
//                         are over MAX_SPEND_USD. HOLD_BUY=1 (a keep-alive
//                         pass is running or queued) buys nothing and
//                         remembers no buyable route, so the next check
//                         treats it as new again. Catalog rows are keyed by
//                         method and path (a GET and a POST may share a
//                         path); the listing is keyed by path.
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
//                         nothing. A reading that has not completed
//                         within READ_DEADLINE_MS is unreadable.
//   MCP tool listings     The connector's fixed-price flagship tools are listed
//                         as MCP tools too (scripts/lib/mcp-listings.js), one
//                         feed row each at /mcp#<tool>. The check reads them
//                         beside the routes. One that has never been seen in
//                         the listing is not yet listed: it is logged and
//                         counts as nothing. Once seen (the state remembers
//                         the tool names), a listing that leaves is missing:
//                         the log names it on every check, and on the second
//                         check in a row ONE issue of its own opens
//                         (MCP_ISSUE_TITLE, fixed text, never edited; the
//                         route issue never lists a listing), whether or not
//                         the scheduled MCP listings pass is on
//                         (BAZAAR_MCP_KEEPALIVE). It closes on a readable check
//                         with no listing missing twice in a row. A listing is
//                         never bought here (a payment on the HTTP route does
//                         not restore it; scripts/refresh-bazaar.js MODE=mcp
//                         does, through the connector, on its schedule only
//                         while that switch is on).
//   retired listings      An MCP tool listing the server no longer offers
//                         (RETIRED_MCP_LISTING_TOOLS: a deliberate flagship
//                         change) is expected to leave: it is never a catalog
//                         row, so never missing and never paged; the state
//                         drops it from the seen set, and the log names one
//                         still in the feed as retired, expected to age out.
//   feed lag              The public feed lags CDP's own index: a route
//                         bought minutes ago can be indexed and still absent
//                         from the feed for over an hour. So before a route
//                         counts as missing, the check asks CDP's validator
//                         about it (scripts/bazaar-validate.js validateOne).
//                         One the validator reports indexed (index.active)
//                         and valid, with a crawl at most FEED_LAG_GRACE_MS
//                         before the check, on a check at most
//                         FEED_LAG_GRACE_MS after the first check that found
//                         it absent (the state's absentSince), is pending the
//                         feed: not missing, not bought,
//                         not paged, and named in the log. A route reported
//                         invalid or not indexed, a read that fails, a crawl
//                         date that is absent, older or in the future, and every route past
//                         VALIDATE_MAX_PER_RUN stay missing as before. Only
//                         routes the feed lacks are asked, one at a time, the
//                         ones missing on the check before first, inside the
//                         reading's deadline and VALIDATE_PHASE_MAX_MS. The MCP
//                         tool listings are not asked: the validator probes
//                         an HTTP route for its 402, and a listing's offer
//                         rides a tool result.
//   lost state            With no saved state and an issue open, a route the
//                         issue already lists counts as a repeat miss (never
//                         bought again, the issue updated), and the issue is
//                         never closed while any route is missing. With the MCP
//                         listing issue open, that check holds it as is and
//                         records no absent listing as seen or missing; only a
//                         listing observed in the reading becomes seen.
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
// of the open issue, empty when none), OPEN_ISSUE_BODY_FILE (its body),
// MCP_OPEN_ISSUE (the open MCP listing issue's number), HOLD_BUY,
// MAX_SPEND_USD, MAX_ROUTES, UNREADABLE_PAGE_AFTER, READ_DEADLINE_MS,
// BAZAAR_MCP_KEEPALIVE ("on": the scheduled MCP listings pass runs; the log
// says so). Writes out/body.md and out/mcp-body.md, and slugs=, max_price=,
// action=, mcp_action= to $GITHUB_OUTPUT.
// Exit: 0 (a refusal and an unreadable listing included), 2 bad usage.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { walkAgreed, BAZAAR_REGISTRY_URL } from "./listing-coverage.js";
import {
  exemptKind, aboveCeilingRoutes, usdMicros, microsToUsd, spendCapVerdict, routeCountVerdict,
} from "./lib/keepalive-plan.js";
import { validateOne } from "./bazaar-validate.js";
import { mcpListingRoutes, mcpToolOfResource, mcpListingKey, mcpListingSlugOf, RETIRED_MCP_LISTING_TOOLS } from "./lib/mcp-listings.js";

export const DEFAULT_MAX_ROUTES = 10;
export const DEFAULT_MAX_SPEND_USD = 2;
export const UNREADABLE_PAGE_AFTER = 3;
export const ISSUE_TITLE = "Scheduled check needs review: listing-presence";
// The MCP tool listings page under their own issue, never the route issue.
export const MCP_ISSUE_TITLE = "Scheduled check needs review: mcp-listing-presence";
/** The keys a retired MCP tool listing was read by, in any state an older check saved. */
const RETIRED_MCP_KEYS = new Set(RETIRED_MCP_LISTING_TOOLS.map((t) => `MCP ${mcpListingKey(t)}`));
// One page of the listing or the catalog waits this long; the whole reading
// (two or three passes) this long. The workflow's step and job timeouts are
// set above both (scripts/test-bazaar-presence.js reads them).
export const PAGE_TIMEOUT_MS = 30_000;
export const DEFAULT_READ_DEADLINE_MS = 20 * 60_000;

// The validator step (see "feed lag" above).
export const VALIDATE_MAX_PER_RUN = 25;
export const VALIDATE_PHASE_MAX_MS = 4 * 60_000;
// The feed buyers read trails a fresh crawl by hours, never longer: past this, indexed-but-unlisted is a real miss.
export const FEED_LAG_GRACE_MS = 6 * 60 * 60_000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
// A path printed into the public issue: our own catalog's shape only.
// An MCP tool listing's is /mcp#<tool name>.
const PATH_RE = /^\/[A-Za-z0-9/_.:-]{1,200}(?:#[a-z][a-z0-9._-]{0,60})?$/;

/** A listing resource URL -> its path when it is on `host`, else null. */
export function pathOnHost(resource, host) {
  try {
    const u = new URL(String(resource));
    return u.host.toLowerCase() === String(host).toLowerCase() ? u.pathname : null;
  } catch { return null; }
}

/** A listing resource URL -> the key it is read by on `host`: an MCP tool
 *  listing's /mcp#<tool>, else the route's path; null off the host. */
export function listingKeyOnHost(resource, host) {
  const tool = mcpToolOfResource(resource, host);
  return tool ? mcpListingKey(tool) : pathOnHost(resource, host);
}

/** The catalog's MCP tool listings, shaped as catalogRows' entries: method
 *  "MCP", path /mcp#<tool>, `mcp` the tool name. */
export function mcpCatalogRows(pricing) {
  return mcpListingRoutes(pricing).map((r) => ({ row: { slug: r.slug, price: r.price }, key: `MCP ${r.key}`, slug: r.slug, path: r.key, method: "MCP", micros: r.micros, mcp: r.toolName }));
}

/** The catalog's rows as { key, slug, path, method, micros }, one per method
 *  and path: a GET and a POST on one path are two routes. */
export function catalogRows(pricing) {
  const rows = Array.isArray(pricing?.endpoints) ? pricing.endpoints : Array.isArray(pricing?.tools) ? pricing.tools : [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.path !== "string") continue;
    const method = String(r.method || "GET").toUpperCase();
    const key = `${method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ row: r, key, slug: typeof r.slug === "string" ? r.slug : "", path: r.path, method, micros: usdMicros(r.price) });
  }
  return out;
}

/** The routes an open issue's body lists ("- `METHOD /path`: ..."), as keys. */
export function issueListedKeys(body) {
  const out = new Set();
  for (const m of String(body || "").matchAll(/^- `([A-Z]{3,7}) (\/[^`\s]+)`/gm)) if (PATH_RE.test(m[2])) out.add(`${m[1]} ${m[2]}`);
  return out;
}

/** Why the presence check does not buy a route, or null when it may. */
export function presenceExemption(entry, tailSlugs) {
  if (entry.mcp) return "mcp listing";
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

/** Pure: the crawl time (ms) when a validator answer reports the route in
 *  CDP's index, valid, with a crawl at most FEED_LAG_GRACE_MS before `now`, else
 *  null. A read that failed, a route not indexed, and a crawl date that is
 *  absent, unparseable, older or in the future never count. */
export function indexedRecently(r, now = Date.now()) {
  if (!r || r.ok !== true || r.valid !== true || r.indexed !== true || typeof r.lastCrawledAt !== "string") return null;
  const t = Date.parse(r.lastCrawledAt);
  if (!Number.isFinite(t) || t > now || now - t > FEED_LAG_GRACE_MS) return null;
  return t;
}

/** Asks the validator about the catalog routes every pass of the feed lacks
 *  (the ones missing on the check before first), one at a time, at most
 *  `max`, until `deadlineAt`. Returns { pending: Map(key -> ms since the crawl), asked,
 *  unreadable, skipped }. `validate` is validateOne's shape. */
export async function feedPendingRoutes({ reading, prev = null, target, validate = validateOne, validateUrl, deadlineAt = 0, max = VALIDATE_MAX_PER_RUN, now = () => Date.now() }) {
  const out = { pending: new Map(), asked: 0, unreadable: 0, skipped: 0 };
  if (!reading) return out;
  const prevMissing = prev && prev.missing && typeof prev.missing === "object" ? prev.missing : {};
  const absent = missingFromEveryPass(catalogRows(reading.pricing), reading.passes);
  const ordered = [...absent.filter((m) => Object.hasOwn(prevMissing, m.key)), ...absent.filter((m) => !Object.hasOwn(prevMissing, m.key))];
  const ask = ordered.slice(0, Math.max(0, max));
  out.skipped = ordered.length - ask.length;
  const base = String(target).replace(/\/+$/, "");
  const at = now();
  for (const m of ask) {
    if (deadlineAt > 0 && now() >= deadlineAt) { out.unreadable += ask.length - out.asked; break; }
    out.asked++;
    let r;
    try { r = await validate({ method: m.method, path: m.path }, { base, deadlineAt, ...(validateUrl ? { validateUrl } : {}) }); } catch { r = null; }
    if (!r || r.ok !== true) { out.unreadable++; continue; }
    const t = indexedRecently(r, at);
    if (t !== null) out.pending.set(m.key, at - t);
  }
  return out;
}

/** Pure: the decision for one check. `reading` is null when the listing or the
 *  catalog could not be read, else { pricing, passes }. `prev` is the state the
 *  last check left ({ missing: { "METHOD path": note }, unreadable }), or null
 *  when none was saved. `issueListed` is the set of keys the open issue lists,
 *  or null when its body could not be read. `pendingFeed` maps the keys of
 *  routes CDP's validator reports indexed recently (feedPendingRoutes) to
 *  how long ago they were crawled: absent from the feed, they are not missing. `hold` buys nothing. The MCP tool
 *  listings are decided apart (`mcpMissing`, `mcpRepeat`, `mcpAction` for
 *  their own issue, `mcpOpenIssue` whether it is open); `mcpKeepalive` (the
 *  scheduled MCP pass is on) changes only what the log says, never whether a
 *  listing counts. */
export function decide({ reading, prev, now = Date.now(), pendingFeed = new Map(), openIssue = false, issueListed = new Set(), mcpOpenIssue = false, hold = false, mcpKeepalive = false, maxSpendUsd = DEFAULT_MAX_SPEND_USD, maxRoutes = DEFAULT_MAX_ROUTES, unreadablePageAfter = UNREADABLE_PAGE_AFTER }) {
  const lost = !prev || typeof prev !== "object";
  const prevMissing = prev && prev.missing && typeof prev.missing === "object" ? prev.missing : {};
  const prevStreak = Number.isInteger(prev?.unreadable) && prev.unreadable > 0 ? prev.unreadable : 0;
  const prevSeen = Array.isArray(prev?.mcpSeen) ? prev.mcpSeen.filter((t) => typeof t === "string" && !RETIRED_MCP_LISTING_TOOLS.includes(t)) : [];
  // When each route was first found absent from the feed (ms); a time in the
  // future or unreadable is not kept.
  const prevSince = {};
  if (prev?.absentSince && typeof prev.absentSince === "object") {
    for (const [k, v] of Object.entries(prev.absentSince)) { const t = Date.parse(v); if (typeof v === "string" && Number.isFinite(t) && t <= now) prevSince[k] = v; }
  }
  const prevMcpMissing = Array.isArray(prev?.mcpMissing) ? prev.mcpMissing.filter((k) => typeof k === "string" && !RETIRED_MCP_KEYS.has(k)) : [];
  if (!reading) {
    const streak = prevStreak + 1;
    const page = streak >= unreadablePageAfter;
    return {
      readable: false, buy: [], refused: null, repeat: [], pendingFeed: [], exempt: [], newlyMissing: [], notYetListed: [], mcpMissing: [], mcpRepeat: [], mcpRetiredListed: [], mcpAction: "none", mcpKeepalive,
      state: { missing: prevMissing, unreadable: streak, mcpSeen: prevSeen, mcpMissing: prevMcpMissing, absentSince: prevSince },
      action: page && !openIssue ? "open" : "none", cause: page ? "unreadable" : null,
    };
  }
  const mcpRows = mcpCatalogRows(reading.pricing);
  const catalog = catalogRows(reading.pricing);
  const tailSlugs = new Set(aboveCeilingRoutes(reading.pricing).map((r) => r.slug));
  // State lost with an issue open: what the issue lists was missing before.
  const inherited = lost && openIssue && issueListed instanceof Set ? issueListed : new Set();
  const wasMissing = (m) => Object.hasOwn(prevMissing, m.key) || inherited.has(m.key);
  const pending = pendingFeed instanceof Map ? pendingFeed : new Map();
  const absentRoutes = missingFromEveryPass(catalog, reading.passes);
  // Indexed by CDP, not yet in the public feed: never missing, bought or paged.
  // The grace counts from the first check that found the route absent too, so
  // a route CDP keeps re-crawling is not pending the feed forever. One with no
  // recorded time (first absent now, or an older state) starts its clock now.
  const nowIso = new Date(now).toISOString();
  const absentSince = {};
  for (const m of absentRoutes) absentSince[m.key] = prevSince[m.key] || nowIso;
  const inGrace = (m) => pending.has(m.key) && now - Date.parse(absentSince[m.key]) <= FEED_LAG_GRACE_MS;
  const pendingRoutes = absentRoutes.filter(inGrace).map((m) => ({ ...m, crawledAgoMs: pending.get(m.key) }));
  const missing = absentRoutes.filter((m) => !inGrace(m));
  // The MCP tool listings, apart from the routes. One counts as missing only
  // once it has been listed: seen by a check before, or missing before (the
  // state names it). An older state kept them in `missing` beside the routes;
  // that still counts. Only a listing observed in a reading becomes seen, so a
  // lost state never turns a listing that was never listed into a miss.
  const mcpAbsent = missingFromEveryPass(mcpRows, reading.passes);
  const absentKeys = new Set(mcpAbsent.map((m) => m.key));
  const mcpWasMissing = (m) => prevMcpMissing.includes(m.key) || Object.hasOwn(prevMissing, m.key);
  const seen = new Set(prevSeen);
  for (const m of mcpRows) if (!absentKeys.has(m.key)) seen.add(m.mcp);
  const notYetListed = mcpAbsent.filter((m) => !seen.has(m.mcp) && !mcpWasMissing(m));
  const mcpMissing = mcpAbsent.filter((m) => !notYetListed.includes(m));
  for (const m of mcpMissing) seen.add(m.mcp);
  const mcpRepeat = mcpMissing.filter(mcpWasMissing);
  // Retired listings still in the feed: named in the log, never counted.
  const feedKeys = new Set((reading.passes || []).flatMap((p) => [...(p.keys || [])]));
  const mcpRetiredListed = RETIRED_MCP_LISTING_TOOLS.filter((t) => feedKeys.has(mcpListingKey(t)));
  // Opened once, never edited while open (its text is fixed; the log names
  // the listings); closed on a readable check with no repeat miss, never on
  // lost state while a listing is absent: that check holds the issue as is
  // and records no absent listing, so the next readable check decides.
  const mcpAction = mcpRepeat.length ? (mcpOpenIssue ? "none" : "open") : !mcpOpenIssue ? "none" : lost && mcpAbsent.length ? "none" : "close";
  const repeat = missing.filter(wasMissing);
  const newlyMissing = missing.filter((m) => !wasMissing(m));
  // State lost and the open issue unreadable: no way to tell a repeat, so no buy.
  const held = hold || (lost && openIssue && !(issueListed instanceof Set));
  const exempt = [];
  let buy = [];
  for (const m of newlyMissing) {
    const why = presenceExemption(m, tailSlugs);
    if (why) exempt.push({ ...m, why }); else buy.push(m);
  }
  const heldBuy = held ? buy : [];
  if (held) buy = [];
  let refused = null;
  if (buy.length) {
    const count = routeCountVerdict(buy, maxRoutes);
    const spend = spendCapVerdict(buy, maxSpendUsd);
    if (!count.ok) refused = count.reason;
    else if (!spend.ok) refused = spend.reason;
    if (refused) buy = [];
  }
  const state = { missing: {}, unreadable: 0, mcpSeen: [...seen].sort(), mcpMissing: mcpMissing.map((m) => m.key).sort(), absentSince };
  for (const m of repeat) state.missing[m.key] = Object.hasOwn(prevMissing, m.key) ? prevMissing[m.key] : "listed";
  for (const m of exempt) state.missing[m.key] = m.why;
  // A held route is not remembered: the next check sees it as new and may buy it.
  for (const m of buy) state.missing[m.key] = "bought";
  if (refused) for (const m of newlyMissing) if (!Object.hasOwn(state.missing, m.key) && !heldBuy.includes(m)) state.missing[m.key] = "refused";
  // Never close on lost state while a route is missing: the issue may be about it.
  const action = repeat.length ? (openIssue ? "update" : "open") : !openIssue ? "none" : lost && missing.length ? "none" : "close";
  return { readable: true, buy, refused, held: heldBuy, repeat, pendingFeed: pendingRoutes, exempt, newlyMissing, notYetListed, mcpMissing, mcpRepeat, mcpRetiredListed, mcpAction, mcpKeepalive, state, action, cause: repeat.length ? "missing" : null };
}

const NOTE = {
  bought: "a buy was sent on the check before",
  listed: "listed here before; not bought again",
  refused: "not bought: the check before refused the buy under its caps",
  quoted: "not bought here: quoted route with no fromInput, which no keep-alive pass buys (its example quotes over the list price)",
  "model-priced": "not bought here: model-priced route",
  "route-execute": "not bought here: route-execute tier",
  "lasting-effect": "not bought here: its effect outlives the answer",
  "above the ceiling": "not bought here: the pass above the ceiling buys it",
  unpriced: "not bought here: unpriced",
  "unreadable slug": "not bought here: unreadable slug",
};

/** The catalog slug the MCP listings pass takes for a missing MCP tool
 *  listing (`MCP /mcp#<tool>`), else null. */
export function mcpRerunSlug(m) {
  if (m?.method !== "MCP") return null;
  const tool = String(m.path || "").split("#")[1] || "";
  return mcpListingSlugOf(tool);
}

/** The issue body: fixed text and our own route paths, no figure or count. */
export function issueBody(decision, runUrl = "") {
  const run = runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl) ? `\n\nRun: ${runUrl}` : "";
  if (decision.cause === "unreadable") {
    return "The presence check could not complete a reading on several checks in a row, so it cannot tell whether every route of ours is listed. Nothing is bought until a reading completes. This issue closes on the next completed check that finds no route missing twice in a row." + run;
  }
  const lines = decision.repeat
    .filter((m) => PATH_RE.test(m.path))
    .map((m) => `- \`${m.method} ${m.path}\`: ${NOTE[decision.state.missing[m.key]] || "not bought here"}`);
  return [
    "These routes of ours were observed to leave the Bazaar discovery listing and were still missing on the next check (each check reads the listing in two full passes at least, and a route counts as missing only when every pass lacks it).",
    "",
    ...lines,
    "",
    "A route the check may buy is bought once per absence (scripts/bazaar-presence.js, then scripts/refresh-bazaar.js MODE=missing). A route still missing after that, or one of a kind the check never buys, needs a hand pass: `gh workflow run bazaar-keepalive.yml --ref main -f slugs=<slug>` for a route at or under the ceiling, `gh workflow run bazaar-keepalive-tail.yml --ref main` for one above it. A quoted route is bought by these passes with its fromInput (on /api/pricing), a body quoted inside its list price; one without a fromInput is refused by every pass, since the keep-alive never pays over the list price, and returns once its tool declares a fromInput. MCP tool listings page under their own issue. This issue closes on the next readable check with no route missing twice in a row.",
  ].join("\n") + run;
}

/** The MCP listing issue's body: fixed text only (it is never edited while
 *  open, so it names no listing; each check's log does), no figure. */
export function mcpIssueBody(runUrl = "") {
  const run = runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl) ? `\n\nRun: ${runUrl}` : "";
  return [
    "An MCP tool listing of ours (`MCP /mcp#<tool>`) that was seen in the Bazaar discovery listing was missing on two checks in a row (each check reads the listing in two full passes at least, and a listing counts as missing only when every pass lacks it).",
    "",
    "Every presence check's log names each missing MCP tool listing and its catalog slug. The presence check never buys one: `gh workflow run bazaar-mcp-listings.yml --ref main -f slugs=<slug>` buys it through the connector, and that workflow's schedule does while the repo variable `BAZAAR_MCP_KEEPALIVE` is on. This issue closes on the next readable check with no MCP tool listing missing twice in a row.",
  ].join("\n") + run;
}

/** The log lines for one decision: counts, paths and words, never a figure. */
export function logLines(d) {
  if (!d.readable) return [`The listing or the catalog could not be read; nothing bought. Unreadable checks in a row: ${d.state.unreadable}.`];
  const out = [`Routes missing from every pass: ${d.newlyMissing.length + d.repeat.length} (newly missing ${d.newlyMissing.length}, missing on the check before too ${d.repeat.length}).`];
  for (const m of d.newlyMissing) {
    if (!PATH_RE.test(m.path)) continue;
    const ex = d.exempt.find((e) => e.key === m.key);
    out.push(`  missing ${m.method} ${m.path}${ex ? ` (not bought: ${ex.why})` : (d.held || []).includes(m) ? " (held: a keep-alive pass is running or queued, or the open issue could not be read)" : ""}`);
  }
  for (const m of d.repeat) if (PATH_RE.test(m.path)) out.push(`  still missing ${m.method} ${m.path}`);
  const pend = d.pendingFeed || [];
  if (pend.length) {
    out.push(`Routes absent from the feed that CDP's validator reports indexed within the feed's lag grace (${Math.round(FEED_LAG_GRACE_MS / 3_600_000)} h): ${pend.length}; not missing, not bought, not paged.`);
    for (const m of pend) {
      if (!PATH_RE.test(m.path)) continue;
      const ago = Number.isFinite(m.crawledAgoMs) ? Math.round(m.crawledAgoMs / 60_000) : "?";
      out.push(`  indexed by CDP ${ago} min ago, not yet in the public feed: ${m.method} ${m.path}`);
    }
  }
  const mcpMissing = d.mcpMissing || [];
  if (mcpMissing.length) {
    out.push(`MCP tool listings missing from every pass: ${mcpMissing.length} (missing on the check before too ${(d.mcpRepeat || []).length}); never bought here, ${d.mcpKeepalive ? "the scheduled MCP listings pass is on" : "and the scheduled MCP listings pass is off (BAZAAR_MCP_KEEPALIVE), so nothing re-buys them"}.`);
    for (const m of mcpMissing) {
      if (!PATH_RE.test(m.path)) continue;
      const slug = mcpRerunSlug(m);
      out.push(`${(d.mcpRepeat || []).includes(m) ? "  still missing" : "  missing"} ${m.method} ${m.path}${slug ? ` (catalog slug ${slug})` : ""}`);
    }
    out.push(`::warning::MCP tool listings missing from the Bazaar listing: ${mcpMissing.filter((m) => PATH_RE.test(m.path)).map((m) => m.path).join(", ")}`);
  }
  if ((d.mcpRetiredListed || []).length) out.push(`Retired MCP tool listings still in the Bazaar listing (expected after a flagship change; never counted, never paged): ${d.mcpRetiredListed.map((t) => mcpListingKey(t)).join(", ")}.`);
  if ((d.notYetListed || []).length) out.push(`MCP tool listings not yet listed (never seen in the listing, so not counted as missing): ${d.notYetListed.length}.`);
  if (d.refused) out.push(`Refusing the buy: ${d.refused}. Nothing bought.`);
  else out.push(`Routes to buy: ${d.buy.length}.`);
  return out;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!r.ok) throw new Error("not ok");
  return r.json();
}

/** Reads the catalog and the listing; null when either is unreadable, when the
 *  listing holds none of our routes (an empty listing is no reading), or when
 *  the whole reading has not completed within `deadlineMs`. Logs fixed words
 *  only: no status, no upstream message. */
export async function readListing({ target, registryUrl = BAZAAR_REGISTRY_URL, fetchJson = getJson, log = () => {}, deadlineMs = DEFAULT_READ_DEADLINE_MS }) {
  const host = new URL(target).host;
  let expired = false;
  const say = (m) => { if (!expired) log(m); };
  const bounded = async (url) => {
    if (expired) throw new Error("deadline");
    return fetchJson(url);
  };
  const read = async () => {
    try {
      const pricing = await bounded(`${target.replace(/\/+$/, "")}/api/pricing`);
      if (catalogRows(pricing).length === 0) { say("The catalog lists no routes."); return null; }
      const feed = await walkAgreed(registryUrl, {
        isOurs: (it) => pathOnHost(it?.resource, host) !== null,
        keyOf: (it) => listingKeyOnHost(it?.resource, host),
        fetchJson: bounded,
      });
      say(`The listing was read in ${feed.passes.length} full passes${feed.agreed ? "; the last two agree" : "; they disagree, so only a route absent from every pass counts as missing"}.`);
      if (feed.passes.some((p) => p.keys.size === 0)) { say("A pass held none of our routes; not a reading."); return null; }
      return { pricing, passes: feed.passes };
    } catch {
      say("The reading did not complete (a page could not be read).");
      return null;
    }
  };
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("deadline"), deadlineMs); });
  const out = await Promise.race([read(), deadline]);
  clearTimeout(timer);
  if (out === "deadline") {
    expired = true;
    log("The reading did not complete within its deadline; this check counts as unreadable.");
    return null;
  }
  return out;
}

function readState(file) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** One check; returns the exit code. Every dependency is injectable so
 *  scripts/test-bazaar-presence.js runs it offline. */
export async function run({ env = process.env, log = console.log, fetchJson = getJson, validate = validateOne } = {}) {
  const target = env.TARGET_URL || "https://agent402.tools";
  try { new URL(target); } catch { log("bazaar-presence: TARGET_URL is not a URL"); return 2; }
  const maxRoutes = env.MAX_ROUTES === undefined || env.MAX_ROUTES === "" ? DEFAULT_MAX_ROUTES : Number(env.MAX_ROUTES);
  const maxSpendUsd = env.MAX_SPEND_USD === undefined || env.MAX_SPEND_USD === "" ? DEFAULT_MAX_SPEND_USD : env.MAX_SPEND_USD;
  const pageAfter = Math.max(1, parseInt(env.UNREADABLE_PAGE_AFTER || "", 10) || UNREADABLE_PAGE_AFTER);
  const deadlineMs = Math.max(1, parseInt(env.READ_DEADLINE_MS || "", 10) || DEFAULT_READ_DEADLINE_MS);
  const prev = readState(env.STATE_FILE);
  const openIssue = /^\d+$/.test(String(env.OPEN_ISSUE || ""));
  const mcpOpenIssue = /^\d+$/.test(String(env.MCP_OPEN_ISSUE || ""));
  let issueListed = new Set();
  if (openIssue) {
    try { issueListed = issueListedKeys(readFileSync(env.OPEN_ISSUE_BODY_FILE || "", "utf8")); } catch { issueListed = null; }
  }
  if (!prev) log(openIssue ? "No saved state: the open issue's routes count as missing before." : "No saved state: this reads as a first check.");
  const hold = env.HOLD_BUY === "1";
  if (hold) log("A keep-alive pass is running or queued: this check buys nothing.");
  const readStart = Date.now();
  const reading = await readListing({ target, registryUrl: env.BAZAAR_REGISTRY_URL || BAZAAR_REGISTRY_URL, fetchJson, log, deadlineMs });
  // The validator step shares the reading's deadline and has its own cap.
  const deadlineAt = Math.min(readStart + deadlineMs, Date.now() + VALIDATE_PHASE_MAX_MS);
  const asked = await feedPendingRoutes({ reading, prev, target, validate, validateUrl: env.BAZAAR_VALIDATE_URL || undefined, deadlineAt });
  if (asked.asked || asked.skipped) log(`Asked CDP's validator about ${asked.asked} route(s) the feed lacks: ${asked.pending.size} indexed, ${asked.unreadable} not read (counted missing)${asked.skipped ? `; ${asked.skipped} not asked (per-run cap ${VALIDATE_MAX_PER_RUN}, counted missing)` : ""}.`);
  const pendingFeed = asked.pending;
  const mcpKeepalive = String(env.BAZAAR_MCP_KEEPALIVE || "").trim() === "on";
  const d = decide({ reading, prev, pendingFeed, openIssue, issueListed, mcpOpenIssue, hold, mcpKeepalive, maxSpendUsd, maxRoutes, unreadablePageAfter: pageAfter });
  for (const l of logLines(d)) log(l);
  log(`Issue: ${d.action}.`);
  log(`MCP listing issue: ${d.mcpAction}.`);
  if (env.STATE_FILE) writeFileSync(env.STATE_FILE, JSON.stringify({ v: 1, ...d.state }));
  if (env.OUT_DIR) {
    mkdirSync(env.OUT_DIR, { recursive: true });
    writeFileSync(join(env.OUT_DIR, "body.md"), issueBody(d, env.RUN_URL || ""));
    writeFileSync(join(env.OUT_DIR, "mcp-body.md"), mcpIssueBody(env.RUN_URL || ""));
  }
  if (env.GITHUB_OUTPUT) {
    const max = d.buy.reduce((m, r) => Math.max(m, r.micros), 0);
    appendFileSync(env.GITHUB_OUTPUT, `slugs=${d.buy.map((r) => r.slug).join(",")}\nmax_price=${d.buy.length ? microsToUsd(max) : ""}\naction=${d.action}\nmcp_action=${d.mcpAction}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => process.exit(code), (e) => { console.error("bazaar-presence:", String(e?.message || e).slice(0, 160)); process.exit(2); });
}
