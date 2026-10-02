// Every tool route and skill pack we ever published, so a retirement that
// forgets src/retired-tools.js fails CI instead of turning a route an outside
// index still lists into the guessed-slug 404.
//
// The snapshot (scripts/published-slugs.json) holds two lists:
//   tools: the first path segment after /api/ of every tool route we served
//          (the segment retiredEntryFor matches on; usually the slug)
//   packs: every skill-pack slug served at /api/skill/<slug>
// The retired pairwise converters are excluded: server.js answers those with
// their own 410 (RETIRED_CONVERT_API_RE).
//
// The rule it enforces (scripts/test-retired-routes.js runs the check): every
// snapshot entry is live in the booted catalog, listed only when a key is
// present (the env-gated kits), or retired in src/retired-tools.js. And every
// live entry is in the snapshot, so adding a tool means regenerating it:
//
//   node scripts/published-slugs.js            check (boots a free server)
//   node scripts/published-slugs.js --write    union the live catalog, the
//                                              env-gated kits and the registry
//                                              into the snapshot
//   node scripts/published-slugs.js --write --history
//                                              also union every route and pack
//                                              git history of origin/main
//                                              ever carried (how the first
//                                              snapshot was built)
// Entries are never removed by --write: a route once published stays in the
// snapshot for good, which is the point.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getFreePort } from "./lib/free-port.js";
import { RETIRED_TOOLS, RETIRED_PACKS } from "../src/retired-tools.js";

export const SNAPSHOT_URL = new URL("./published-slugs.json", import.meta.url);

const isConvert = (seg) => seg === "convert" || /^convert-[a-z0-9-]+-to-[a-z0-9-]+$/.test(seg);

/** Split route paths ("/api/x", "/api/skill/y", "POST /api/x") into tool segments and packs. */
export function segmentsOf(paths) {
  const tools = new Set();
  const packs = new Set();
  for (const raw of paths) {
    const path = String(raw || "").replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+/, "");
    const pack = /^\/api\/skill\/([a-z0-9-]+)$/.exec(path);
    if (pack) { packs.add(pack[1]); continue; }
    const tool = /^\/api\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(path);
    if (tool && tool[1] !== "skill" && !isConvert(tool[1])) tools.add(tool[1]);
  }
  return { tools, packs };
}

/** Routes of the kits that are listed only when their key is present. A keyless
 *  boot does not serve them, so they count as live here, not as retired. */
export async function envGatedSegments() {
  const kits = await Promise.all([
    import("../src/tools/llm-gateway-kit.js").then((m) => m.LLM_GATEWAY_TOOLS),
    import("../src/tools/farcaster-social-kit.js").then((m) => m.FARCASTER_SOCIAL_TOOLS),
    import("../src/tools/x-data-kit.js").then((m) => m.X_DATA_TOOLS),
    import("../src/tools/exa-kit.js").then((m) => m.EXA_TOOLS),
    import("../src/tools/judge-kit.js").then((m) => m.JUDGE_TOOLS),
    import("../src/tools/b2b-enrich-kit.js").then((m) => m.B2B_ENRICH_TOOLS),
  ]);
  return segmentsOf(kits.flat().map((t) => t.route));
}

export function loadSnapshot() {
  const j = JSON.parse(readFileSync(SNAPSHOT_URL, "utf8"));
  return { tools: new Set(j.tools || []), packs: new Set(j.packs || []) };
}

/** Every /api tool route and skill pack that git history of origin/main carried. */
export function historySegments(ref = "origin/main") {
  const log = execFileSync("git", ["log", "-p", "-m", "--first-parent", "--format=", ref, "--", "src/tools", "src/server.js", "src/skills.js"], { maxBuffer: 1 << 30, encoding: "utf8" });
  const paths = [];
  let inSkills = false;
  for (const line of log.split("\n")) {
    if (line.startsWith("+++ ")) { inSkills = line.endsWith("/src/skills.js"); continue; }
    if (!line.startsWith("+")) continue;
    for (const m of line.matchAll(/route:\s*["'`](?:GET|POST) (\/api\/[^"'`\s$?]+)["'`]/g)) paths.push(m[1]);
    const pack = inSkills && /^\+ {4}slug: "([a-z0-9-]+)",\s*$/.exec(line);
    if (pack) paths.push(`/api/skill/${pack[1]}`);
  }
  return segmentsOf(paths);
}

/** Boot a free server and read the live catalog's route segments. */
export async function liveSegments() {
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const pricing = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    return segmentsOf((pricing.endpoints || []).map((e) => e.path));
  } finally { proc.kill("SIGTERM"); }
}

/** What the rule finds wrong. Empty arrays everywhere = consistent. */
export function accountFor({ snapshot, live, gated, retiredTools = RETIRED_TOOLS, retiredPacks = RETIRED_PACKS }) {
  const unaccounted = [];
  for (const t of snapshot.tools) if (!live.tools.has(t) && !gated.tools.has(t) && !Object.hasOwn(retiredTools, t)) unaccounted.push(`tool ${t}`);
  for (const p of snapshot.packs) if (!live.packs.has(p) && !Object.hasOwn(retiredPacks, p)) unaccounted.push(`pack ${p}`);
  const missingFromSnapshot = [
    ...[...live.tools, ...gated.tools].filter((t) => !snapshot.tools.has(t)).map((t) => `tool ${t}`),
    ...[...live.packs].filter((p) => !snapshot.packs.has(p)).map((p) => `pack ${p}`),
    ...Object.keys(retiredTools).filter((t) => !snapshot.tools.has(t)).map((t) => `retired tool ${t}`),
    ...Object.keys(retiredPacks).filter((p) => !snapshot.packs.has(p)).map((p) => `retired pack ${p}`),
  ];
  return { unaccounted: [...new Set(unaccounted)].sort(), missingFromSnapshot: [...new Set(missingFromSnapshot)].sort() };
}

async function main() {
  const write = process.argv.includes("--write");
  const withHistory = process.argv.includes("--history");
  const [live, gated] = await Promise.all([liveSegments(), envGatedSegments()]);
  if (live.tools.size < 100) { console.error(`published-slugs: the booted catalog listed only ${live.tools.size} tools; refusing to trust it`); process.exit(1); }
  if (write) {
    let prior = { tools: new Set(), packs: new Set() };
    try { prior = loadSnapshot(); } catch { /* first write */ }
    const hist = withHistory ? historySegments() : { tools: new Set(), packs: new Set() };
    const tools = new Set([...prior.tools, ...live.tools, ...gated.tools, ...hist.tools, ...Object.keys(RETIRED_TOOLS)]);
    const packs = new Set([...prior.packs, ...live.packs, ...hist.packs, ...Object.keys(RETIRED_PACKS)]);
    const out = {
      _note: "Every /api tool route segment and skill pack ever published. Regenerate with `node scripts/published-slugs.js --write`; entries are never removed. See the script header.",
      tools: [...tools].sort(),
      packs: [...packs].sort(),
    };
    writeFileSync(SNAPSHOT_URL, JSON.stringify(out, null, 2) + "\n");
    console.log(`published-slugs: wrote ${out.tools.length} tools and ${out.packs.length} packs`);
  }
  const { unaccounted, missingFromSnapshot } = accountFor({ snapshot: loadSnapshot(), live, gated });
  if (missingFromSnapshot.length) console.error(`published-slugs: live or retired but missing from the snapshot (run --write): ${missingFromSnapshot.join(", ")}`);
  if (unaccounted.length) console.error(`published-slugs: published, not live, and not in src/retired-tools.js (add each with its retirement date): ${unaccounted.join(", ")}`);
  if (missingFromSnapshot.length || unaccounted.length) process.exit(1);
  console.log("published-slugs: every published route is live, key-gated, or retired");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
