#!/usr/bin/env node
// The one issue of the MCP tool listings pass (.github/workflows/
// bazaar-mcp-listings.yml): what to do with it after a run.
//
// The issue records the listings a failed pass did not buy, as catalog slugs
// (the names the re-run command takes). It closes only when a later run BUYS
// every listing it names: a run that bought nothing (the schedule's switch
// off, an empty dispatch, a run off main) or bought other listings leaves it
// open. An issue that names no listing (a refused list, a failed plan job)
// has nothing to buy: it closes on the next run whose plan passes and whose
// buy job did not fail, whether or not that run bought anything.
//
// Env: PLAN, BUY (the jobs' results), PLANNED, BOUGHT, FAILED (comma lists of
// catalog slugs), OPEN_ISSUE (its number, or empty), OPEN_ISSUE_BODY_FILE,
// RUN_URL, OUT_DIR. Writes OUT_DIR/action (open | update | close | none) and,
// for open and update, OUT_DIR/body.md. Reads nothing else and pays nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_LISTING_TOOLS } from "./lib/mcp-listings.js";

const ORDER = Object.keys(MCP_LISTING_TOOLS);
const known = (list) => ORDER.filter((s) => list.includes(s));
const listOf = (v) => known(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const NOT_BOUGHT = "Listings not bought:";
const UNNAMED = "not recorded (the pass failed before it named a listing)";

/** The catalog slugs an open issue's body records as not bought. */
export function recordedSlugs(body) {
  const line = String(body || "").split("\n").find((l) => l.startsWith(NOT_BOUGHT)) || "";
  return known([...line.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
}

/** The issue body: fixed text, catalog slugs and tool names, no figure. */
export function issueBody(slugs, runUrl = "") {
  const run = runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl) ? `\n\nRun: ${runUrl}` : "";
  const names = slugs.map((s) => `\`${s}\` (${MCP_LISTING_TOOLS[s]})`).join(", ");
  return [
    "The pass that buys the hosted connector's MCP tool listings did not buy every listing it was asked for. Listings have been observed to leave the Bazaar listing after about 30 days without a settlement, so this pass keeps those tools listed. The run log names a refused list, a failed buy or a missing key; a buy is never sent twice, so a failed one is bought again only by a new run.",
    "",
    `${NOT_BOUGHT} ${slugs.length ? names : UNNAMED}`,
    "",
    `Re-run: \`gh workflow run bazaar-mcp-listings.yml --ref main -f slugs=${slugs.length ? slugs.join(",") : "<slug>"}\` (a listing is named by its catalog slug or its tool name).`,
    "",
    slugs.length ? "This issue closes when a run buys every listing named above." : "This issue names no listing, so it closes on the next run whose plan passes.",
  ].join("\n") + run;
}

/** What to do with the issue: { action, slugs } (slugs: what the body names). */
export function decide({ plan, buy, planned, bought, failed, open, openBody }) {
  const P = listOf(planned), B = listOf(bought);
  const ran = buy === "success" || buy === "failure";
  const recorded = open ? recordedSlugs(openBody) : [];
  const planFailed = plan !== "success";
  // A buy job that did not end in success or was never needed: failure,
  // cancelled and timed out all leave listings unbought. With no `failed`
  // output (the job died first) every planned listing counts.
  const buyFailed = !planFailed && buy !== "success" && buy !== "skipped";
  if (planFailed || buyFailed) {
    const now = buyFailed ? (String(failed ?? "").trim() ? listOf(failed) : P.filter((s) => !B.includes(s))) : [];
    const slugs = known([...recorded, ...now].filter((s) => !(ran && B.includes(s) && !now.includes(s))));
    if (!open) return { action: "open", slugs };
    return slugs.join() === recorded.join() ? { action: "none", slugs } : { action: "update", slugs };
  }
  if (!open) return { action: "none", slugs: [] };
  // An issue that names no listing is closed by this clean plan: no later
  // buy could clear it, and a schedule with nothing due buys nothing.
  if (!recorded.length) return { action: "close", slugs: [] };
  // A run that bought nothing never closes an issue that names a listing.
  if (buy !== "success" || !B.length) return { action: "none", slugs: recorded };
  const left = recorded.filter((s) => !B.includes(s));
  if (!left.length) return { action: "close", slugs: [] };
  return left.length === recorded.length ? { action: "none", slugs: recorded } : { action: "update", slugs: left };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  let openBody = "";
  if (env.OPEN_ISSUE) { try { openBody = readFileSync(env.OPEN_ISSUE_BODY_FILE || "", "utf8"); } catch { console.error("mcp-listings-issue: the open issue's body could not be read; it is left as it is."); process.exit(1); } }
  const d = decide({ plan: env.PLAN, buy: env.BUY, planned: env.PLANNED, bought: env.BOUGHT, failed: env.FAILED, open: Boolean(env.OPEN_ISSUE), openBody });
  const out = env.OUT_DIR || "out";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "action"), d.action);
  if (d.action === "open" || d.action === "update") writeFileSync(join(out, "body.md"), issueBody(d.slugs, env.RUN_URL || ""));
  console.log(`Issue: ${d.action}${d.slugs.length ? ` (${d.slugs.join(", ")})` : ""}.`);
}
