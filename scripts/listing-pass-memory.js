#!/usr/bin/env node
// The listing pass's purchase memory: download the pass records of this
// repository's recent listing runs into one directory, for
// scripts/payai-listing-pass.js --bought DIR. Nothing here pays; it reads the
// Actions API with the workflow's own token (permissions: actions: read).
//
// A record file is kept as a workflow artifact by each run that buys:
//
//   listing-pass        .github/workflows/listing-pass.yml (pass-<leg>.json)
//   payai-listing-pass  .github/workflows/payai-listing.yml (pass.json; the
//                       PayAI-only pass this workflow replaced)
//   mint-bazaar-rows    .github/workflows/mint-bazaar-rows.yml (pass-mint.json)
//
// The artifacts are listed by name (GET /repos/{repo}/actions/artifacts?name=),
// on any branch, and one counts when it has not expired, was created within
// --days (default 14), was uploaded by a run of this repository (not a fork's
// head) and its run's workflow file is the one that name belongs to (GET
// /repos/{repo}/actions/runs/{id}). Each is downloaded (GET
// .../artifacts/{id}/zip) and its JSON files unpacked under DIR/<artifact id>/.
// Any API or unpack failure exits 1, so a run that cannot read its memory
// never reaches the step that spends.
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/listing-pass-memory.js --out DIR [--days 14]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Artifact name -> the workflow file whose runs may carry it. */
export const MEMORY_ARTIFACTS = Object.freeze({
  "listing-pass": ".github/workflows/listing-pass.yml",
  "payai-listing-pass": ".github/workflows/payai-listing.yml",
  "mint-bazaar-rows": ".github/workflows/mint-bazaar-rows.yml",
});
export const DEFAULT_MEMORY_DAYS = 14;

/**
 * Pure: the listed artifacts worth downloading: a memory name, not expired,
 * created within `days`, uploaded by a run of this repository.
 */
export function pickArtifacts(artifacts, { now = Date.now(), days = DEFAULT_MEMORY_DAYS } = {}) {
  const since = now - days * 86_400_000;
  return (artifacts || []).filter((a) => {
    if (!a || !Object.hasOwn(MEMORY_ARTIFACTS, a.name) || a.expired === true) return false;
    const at = Date.parse(a.created_at || "");
    if (!Number.isFinite(at) || at < since) return false;
    const run = a.workflow_run || {};
    return run.id != null && run.repository_id != null && run.repository_id === run.head_repository_id;
  });
}

export async function fetchMemory({ repo, token, outDir, days = DEFAULT_MEMORY_DAYS, now = Date.now(), fetchImpl = fetch, unzip = unzipJson, log = (m) => console.log(m), api = "https://api.github.com" }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!token) throw new Error("GH_TOKEN (or GITHUB_TOKEN) is required");
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const getJson = async (path) => {
    const res = await fetchImpl(`${api}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const listed = [];
  for (const name of Object.keys(MEMORY_ARTIFACTS)) {
    for (let page = 1; page <= 20; page++) {
      const j = await getJson(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`);
      const items = Array.isArray(j?.artifacts) ? j.artifacts : [];
      listed.push(...items);
      if (items.length < 100) break;
    }
  }
  const picked = pickArtifacts(listed, { now, days });
  mkdirSync(outDir, { recursive: true });
  const runPath = new Map();
  let kept = 0;
  for (const a of picked) {
    const runId = a.workflow_run.id;
    if (!runPath.has(runId)) runPath.set(runId, String((await getJson(`/repos/${repo}/actions/runs/${runId}`))?.path || ""));
    if (runPath.get(runId) !== MEMORY_ARTIFACTS[a.name]) { log(`  ignored ${a.name} ${a.id}: run ${runId} is ${runPath.get(runId) || "an unknown workflow"}`); continue; }
    // The zip endpoint redirects to signed storage; the token is not sent there.
    const res = await fetchImpl(`${api}/repos/${repo}/actions/artifacts/${a.id}/zip`, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const loc = res.headers?.get?.("location");
    const blob = res.status >= 300 && res.status < 400 && loc ? await fetchImpl(loc, { signal: AbortSignal.timeout(60_000) }) : res;
    if (!blob.ok) throw new Error(`artifact ${a.id} (${a.name}): download HTTP ${blob.status}`);
    const dir = join(outDir, String(a.id));
    mkdirSync(dir, { recursive: true });
    const zip = join(outDir, `${a.id}.zip`);
    writeFileSync(zip, Buffer.from(await blob.arrayBuffer()));
    try { unzip(zip, dir); } finally { rmSync(zip, { force: true }); }
    kept++;
    log(`  ${a.name} ${a.id} from run ${runId} (${a.workflow_run.head_branch || "?"}), ${a.created_at}`);
  }
  log(`purchase memory: ${kept} artifact(s) within ${days} days under ${outDir}`);
  return kept;
}

/** Unpack only the JSON files of an artifact zip (unzip refuses paths outside dir). */
export function unzipJson(zip, dir) {
  execFileSync("unzip", ["-o", "-q", zip, "*.json", "-d", dir], { stdio: ["ignore", "inherit", "inherit"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : undefined; };
  const outDir = at("--out");
  const days = at("--days") == null ? DEFAULT_MEMORY_DAYS : Number(at("--days"));
  if (!outDir || !Number.isFinite(days) || days < DEFAULT_MEMORY_DAYS) { console.error(`listing-pass-memory: --out DIR required; --days at least ${DEFAULT_MEMORY_DAYS}`); process.exit(2); }
  fetchMemory({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN, outDir, days })
    .then(() => process.exit(0), (e) => { console.error(`listing-pass-memory: ${e?.message || e}`); process.exit(1); });
}
