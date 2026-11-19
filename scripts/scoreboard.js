#!/usr/bin/env node
// The weekly scoreboard, read from a running server and from outside it.
//
//   AGENT402_OPERATOR_TOKEN=... node scripts/scoreboard.js [--out file.json] [--no-listing] [--no-markdown]
//
// Reads, against TARGET_URL (default https://agent402.tools):
//   /__operator/scoreboard.json  operators, repeat share, organic dollars per
//                                day, concentration, new payers, conversion,
//                                the first-call allowance, refunds (src/scoreboard.js)
//   Bazaar rank                  for the ten queries scripts/bazaar-rank-monitor.js
//                                builds (two flagships and the top tools by demand):
//                                the position of our first route in the open search
//                                (1-based, up to the search's limit), or null
//   Bazaar listing count         routes of ours in the CDP listing, read in full
//                                passes by scripts/bazaar-presence.js (--no-listing skips it)
//   MPP rank                     our row's rank on /api/mpp-leaderboard, when ranked
// Prints the JSON (or writes --out). Run locally, it also writes a markdown
// report under the private scoreboard directory (SCOREBOARD_PRIVATE_DIR, by
// default ~/.claude/projects/<this checkout's project folder>/private/scoreboard),
// mode 0600; never under CI and never inside the repository.
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildQueries, ourRoutes, isOurs, getJson, SEARCH_URL, SEARCH_LIMIT, PAUSE_MS } from "./bazaar-rank-monitor.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The 1-based position of our first route in one search reply, null when absent, undefined when unreadable. */
export function positionIn(body, routes, host) {
  if (!body || typeof body !== "object" || body.partialResults === true || !Array.isArray(body.resources)) return undefined;
  const i = body.resources.findIndex((r) => isOurs(r && r.resource, routes, host));
  return i < 0 ? null : i + 1;
}

/** Our rank on the MPP leaderboard answer, or null with why. */
export function mppRankOf(board) {
  if (!board || !Array.isArray(board.rows)) return { rank: null, of: null, why: "unreadable" };
  const row = board.rows.find((r) => r && r.self === true);
  if (!row) return { rank: null, of: board.rows.length, why: "not ranked" };
  return { rank: Number.isFinite(row.rank) ? row.rank : board.rows.indexOf(row) + 1, of: board.rows.length, stale: board.stale === true };
}

/** Bazaar positions for each query: [{ query, flagship, position|null, ok }]. */
export async function bazaarRanks(queries, routes, host, { fetchImpl = fetch, sleep = realSleep, pauseMs = PAUSE_MS, deadline = Infinity, now = Date.now } = {}) {
  const out = [];
  for (const q of queries) {
    const u = new URL(SEARCH_URL);
    u.searchParams.set("query", q.query);
    u.searchParams.set("limit", String(SEARCH_LIMIT));
    let position;
    try { position = positionIn(await getJson(u.href, { fetchImpl, sleep, deadline, now }), routes, host); } catch { position = undefined; }
    out.push({ query: q.query, flagship: q.flagship === true, ok: position !== undefined, position: position === undefined ? null : position });
    await sleep(pauseMs);
  }
  return out;
}

/** Claude Code's project folder name for a checkout path. */
export const projectSlugOf = (path) => String(path).replace(/[^A-Za-z0-9]/g, "-");

/** Where the markdown goes, or null when it must not be written (CI, or a path inside the repository). */
export function privateDirFor({ env = process.env, root = ROOT, home = homedir() } = {}) {
  if (env.CI || env.GITHUB_ACTIONS) return null;
  const dir = resolve(env.SCOREBOARD_PRIVATE_DIR || join(home, ".claude", "projects", projectSlugOf(root), "private", "scoreboard"));
  const rel = relative(root, dir);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return null;
  return dir;
}

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x == null ? "n/a" : `$${Number(x).toFixed(2)}`);
/** The private markdown report for one scoreboard. */
export function markdownOf(sb) {
  const L = [];
  L.push(`# Scoreboard ${sb.week?.from || "?"} to ${sb.week?.to || "?"}`, "", `Generated ${sb.generatedAt}.`, "");
  const o = sb.operators;
  L.push("## Buyers", "");
  if (o) {
    L.push(`- Outside paying operators: ${o.operators} (upper bound; ${o.wallets} wallets, ${o.resolvedWallets} resolved: payTo ${o.bySource?.payTo ?? 0}, ENS ${o.bySource?.ens ?? 0}, Basename ${o.bySource?.basename ?? 0}; pending ${o.pendingWallets}, unreadable ${o.unreadableWallets})`);
    L.push(`- Operator repeat share: ${pct(o.repeatShare)}; largest operator: ${pct(o.topOperatorShare)} of the week's dollars`);
  } else L.push("- Operators: not measured");
  if (sb.wallets) L.push(`- Wallet repeat share ${pct(sb.wallets.repeatShare)}, returning ${pct(sb.wallets.returningShare)}`);
  L.push("", "## Organic dollars per day", "");
  for (const d of sb.organic?.usdPerDay || []) L.push(`- ${d.day}: ${usd(d.revenueUsd)}`);
  if (sb.organic) L.push(`- Average: ${usd(sb.organic.usdPerDayAvg)}`);
  const c = sb.concentration;
  L.push("", "## Concentration (30 days)", "");
  if (c) L.push(`- Outside ${usd(c.outsideUsd)} from ${c.payingWallets} wallets over ${c.toolsSold} tools; largest wallet ${pct(c.topWalletShare)} (target at most 25%), largest tool ${pct(c.topToolShare)} (${c.topTool || "n/a"}; target at most 35%)`);
  else L.push("- not measured");
  L.push("", "## Bazaar", "");
  for (const r of sb.bazaarRank || []) L.push(`- ${r.flagship ? "[flagship] " : ""}${r.query}: ${!r.ok ? "unreadable" : r.position == null ? "absent from the first page" : `#${r.position}`}`);
  if (sb.bazaarListing) L.push(`- Listed routes: ${sb.bazaarListing.listed ?? "n/a"} of ${sb.listing?.catalogRoutes ?? "?"} in the catalog${sb.bazaarListing.agreed === false ? " (passes disagree)" : ""}`);
  L.push("", "## MPP", "");
  L.push(sb.mppRank?.rank ? `- Rank ${sb.mppRank.rank} of ${sb.mppRank.of}${sb.mppRank.stale ? " (stale board)" : ""}` : `- ${sb.mppRank?.why || "not measured"}`);
  L.push("", "## Conversion by arrival", "");
  for (const [a, v] of Object.entries(sb.conversion || {})) L.push(`- ${a}: ${v.probes} probes, ${v.settled} settled, ${v.settledPerProbe ?? "n/a"} per probe, callers converted ${v.callerConversion ?? "n/a"}`);
  L.push("", "## First-call allowance", "");
  const f = sb.firstCallAllowance;
  if (f) {
    L.push(`- ${f.enabled ? "on" : "off"} (${f.status}); today ${f.today ? `${f.today.grants} grants, ${usd(f.today.usd)}` : "n/a"}`);
    if (f.returnedPayers && typeof f.returnedPayers === "object") L.push(`- Returned payers: ${JSON.stringify(f.returnedPayers)}`);
  } else L.push("- not read");
  L.push("", "## New paying wallets per day (Arc excluded)", "");
  for (const d of sb.newPayersPerDay?.days || []) L.push(`- ${d.day}: ${d.newPayers}`);
  if (sb.refunds) L.push("", "## Refunds", "", `- Owed ${sb.refunds.owed?.n ?? 0} (${usd(sb.refunds.owed?.usd)}), sending ${sb.refunds.sending?.n ?? 0}`);
  return L.join("\n") + "\n";
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const target = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
  const host = new URL(target).hostname;
  const token = process.env.AGENT402_OPERATOR_TOKEN || process.env.OPERATOR_TOKEN || "";
  if (!token) { console.error("scoreboard: set AGENT402_OPERATOR_TOKEN"); process.exit(2); }
  const r = await fetch(`${target}/__operator/scoreboard.json`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) { console.error(`scoreboard: operator route answered ${r.status}`); process.exit(1); }
  const sb = await r.json();
  const deadline = Date.now() + 8 * 60_000;
  try {
    const pricing = await getJson(`${target}/api/pricing`, { deadline });
    let topTools = null;
    try { const stats = await getJson(`${target}/api/stats`, { deadline }); if (Array.isArray(stats?.topTools)) topTools = stats.topTools; } catch { /* ranking unreadable */ }
    const routes = ourRoutes(pricing.endpoints);
    sb.bazaarRank = await bazaarRanks(buildQueries(topTools, pricing.endpoints), routes, host, { deadline });
  } catch { sb.bazaarRank = null; }
  if (!process.argv.includes("--no-listing")) {
    try {
      const { readListing } = await import("./bazaar-presence.js");
      const reading = await readListing({ target });
      const last = reading?.passes?.at(-1);
      sb.bazaarListing = last ? { listed: last.keys.size, passes: reading.passes.length } : null;
    } catch { sb.bazaarListing = null; }
  }
  try { sb.mppRank = mppRankOf(await getJson(`${target}/api/mpp-leaderboard`, { deadline })); } catch { sb.mppRank = { rank: null, of: null, why: "unreadable" }; }
  const json = JSON.stringify(sb, null, 2) + "\n";
  const out = arg("--out");
  if (out) writeFileSync(out, json); else process.stdout.write(json);
  const dir = process.argv.includes("--no-markdown") ? null : privateDirFor();
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `scoreboard-${String(sb.generatedAt || new Date().toISOString()).slice(0, 10)}.md`);
    writeFileSync(file, markdownOf(sb), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.error(`scoreboard: report written to ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`scoreboard failed: ${e?.message || e}`); process.exit(1); });
}
