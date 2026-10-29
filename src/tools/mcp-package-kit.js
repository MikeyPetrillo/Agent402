// MCP package check: the published facts about an npm package that ships an
// MCP server, read before an agent runs `npx -y <package>` against it.
//
// Sources, both read only through fetch-guard's safeFetch (size cap, timeout,
// SSRF guard):
//   * registry.npmjs.org: the package document (dist-tags, every version's
//     manifest, publish times, maintainers). A document past the byte cap
//     falls back to the single version document, which carries everything
//     except publish times and the version count; the answer says so.
//   * api.github.com: one keyless read of the repository the manifest names,
//     when it names one on GitHub. A refusal, a rate limit or an outage never
//     fails the call; the block is marked unread and the answer is partial.
//
// The answer is observations, each in its own field plus a `signals` list of
// short neutral statements. There is no score and no verdict: whether a
// three-day-old version with a postinstall script and no provenance is fine
// is the caller's decision, with the facts in front of it.
//
// Egress -> wallet-only by default (src/free-tier.js does not list the slug).

import { safeFetch } from "./fetch-guard.js";
import { partialFields } from "../partial-answer.js";

const REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com";
// A popular package's document carries every version ever published plus the
// readme; the cap keeps one answer from streaming tens of megabytes. Past it
// the version document (a few KB) answers instead.
const PACKUMENT_MAX_BYTES = 6 * 1024 * 1024;
const VERSION_DOC_MAX_BYTES = 1024 * 1024;
const GITHUB_MAX_BYTES = 512 * 1024;
const REGISTRY_TIMEOUT_MS = 10_000;
const GITHUB_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const MAX_LIST = 20;
const MAX_INPUT_CHARS = 512;

// npm's own name rule: optional @scope/, then URL-safe characters; a legacy
// package may carry uppercase, and the registry is exact on it, so the name
// is never case-folded here.
const NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const NAME_MAX = 214;
// An exact version or a dist-tag. A range (^, ~, >, *, x) is not resolved by
// the registry's version document and is refused up front.
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Hooks npm runs when the package is installed from the registry, in order,
// plus `prepare`, which npm runs for a git dependency and a local install but
// not for a registry tarball.
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const OTHER_HOOKS = ["prepare"];

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// --- input ------------------------------------------------------------------

/**
 * Split `name@version` on the last "@" that is not the scope marker.
 * "@scope/name" alone has no version.
 */
function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * The package a command string would run: `npx -y name@ver`, `npx --yes -p
 * name@ver cmd`, `npm exec name` and `npm x -- name`. A flag is skipped; `-p`
 * and `--package` name the package explicitly and win over the first bare
 * token. Returns the spec string or null when nothing in the line is one.
 */
export function packageFromCommand(line) {
  const tokens = String(line).trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
  let i = 0;
  if (tokens[i] === "npx") i++;
  else if (tokens[i] === "npm" && (tokens[i + 1] === "exec" || tokens[i + 1] === "x")) i += 2;
  else return null;
  let bare = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") { if (bare === null && tokens[i + 1]) bare = tokens[i + 1]; break; }
    if (t === "-p" || t === "--package") { if (tokens[i + 1]) return tokens[i + 1]; continue; }
    if (t.startsWith("--package=")) return t.slice("--package=".length);
    if (t.startsWith("-")) continue;
    if (bare === null) { bare = t; break; }
  }
  return bare;
}

/**
 * Validate the caller's input into { name, version }. `package` is a name, a
 * `name@version` spec or an npx/npm exec command line; `version` (when given)
 * must agree with any version the spec carries. Pure: refuses before egress.
 */
export function parsePackageInput(input = {}) {
  const raw = typeof input.package === "string" ? input.package.trim() : "";
  if (!raw) throw bad(`"package" is required: an npm package name, name@version, or an "npx -y name@version" command`);
  if (raw.length > MAX_INPUT_CHARS) throw bad(`"package" is longer than ${MAX_INPUT_CHARS} characters`);
  const spec = /^(?:npx|npm)\b/.test(raw) ? packageFromCommand(raw) : raw;
  if (!spec) throw bad(`"package" names no package: the command line carries only flags`);
  const { name, version: specVersion } = splitSpec(spec);
  if (!NAME_RE.test(name) || name.length > NAME_MAX || name.includes("..")) {
    throw bad(`"${name.slice(0, 80)}" is not an npm package name (optional @scope/, then letters, digits, . _ ~ -; up to ${NAME_MAX} characters)`);
  }
  let version = null;
  if (input.version !== undefined && input.version !== null && input.version !== "") {
    if (typeof input.version !== "string") throw bad(`"version" must be a string`);
    version = input.version.trim();
  }
  if (specVersion !== null && specVersion !== "") {
    if (version && version !== specVersion) throw bad(`"version" (${version}) disagrees with the version in "package" (${specVersion})`);
    version = specVersion;
  }
  if (version === null) version = "latest";
  if (!VERSION_RE.test(version) || version.includes("..")) {
    throw bad(`"version" must be an exact version or a dist-tag such as latest (a range is not resolved)`);
  }
  return { name, version };
}

// --- reads ------------------------------------------------------------------

const packumentCache = new Map();
const githubCache = new Map();

function cached(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (hit) map.delete(key);
  return undefined;
}
function remember(map, key, value) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, { at: Date.now(), value });
  return value;
}

function encodeName(name) {
  // The scope separator travels as %2F; everything else in a valid name is URL-safe.
  return name.replace(/\//g, "%2F");
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw bad(`${what} returned a document that is not JSON`, 502); }
}

function ghHeaders() {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  // Optional, like github-repo: keyless reads share one per-IP ceiling; a
  // token raises it and changes nothing else.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/**
 * The package document, or `{ oversize: true }` when it passed the byte cap.
 * A missing package is a 404 of ours (the registry's 404 is a caller-attributed
 * 422 inside safeFetch, which would read as "check the URL").
 */
async function readPackument(name) {
  const hit = cached(packumentCache, name);
  if (hit !== undefined) return hit;
  let text;
  try {
    ({ html: text } = await safeFetch(`${REGISTRY}/${encodeName(name)}`, {
      headers: { Accept: "application/json" }, maxBytes: PACKUMENT_MAX_BYTES, timeoutMs: REGISTRY_TIMEOUT_MS,
    }));
  } catch (err) {
    if (err?.statusCode === 413) return remember(packumentCache, name, { oversize: true });
    if (err?.upstreamStatus === 404) throw bad(`Package "${name}" is not on the npm registry`, 404);
    throw err;
  }
  const doc = parseJson(text, "The npm registry");
  if (!doc || typeof doc !== "object" || !doc.versions || typeof doc.versions !== "object") {
    throw bad("The npm registry returned a document without versions", 502);
  }
  return remember(packumentCache, name, doc);
}

/** One version's manifest, by exact version or dist-tag. */
async function readVersionDoc(name, version) {
  let text;
  try {
    ({ html: text } = await safeFetch(`${REGISTRY}/${encodeName(name)}/${encodeURIComponent(version)}`, {
      headers: { Accept: "application/json" }, maxBytes: VERSION_DOC_MAX_BYTES, timeoutMs: REGISTRY_TIMEOUT_MS,
    }));
  } catch (err) {
    if (err?.upstreamStatus === 404) throw bad(`Package "${name}" has no version or dist-tag "${version}" on the npm registry`, 404);
    throw err;
  }
  const doc = parseJson(text, "The npm registry");
  if (!doc || typeof doc !== "object" || typeof doc.version !== "string") throw bad("The npm registry returned a version document without a version", 502);
  return doc;
}

/**
 * The repository record, or `{ skipped: reason }`. Never throws: the
 * repository is the second source, and the registry facts stand on their own.
 */
async function readGithub(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = cached(githubCache, key);
  if (hit !== undefined) return hit;
  let text;
  try {
    ({ html: text } = await safeFetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: ghHeaders(), maxBytes: GITHUB_MAX_BYTES, timeoutMs: GITHUB_TIMEOUT_MS,
    }));
  } catch (err) {
    const s = err?.upstreamStatus;
    const reason = s === 404 ? "repository not found on GitHub (HTTP 404)"
      : s === 403 || s === 429 ? `GitHub rate limit or refusal (HTTP ${s})`
      : s ? `GitHub answered HTTP ${s}`
      : err?.statusCode === 413 ? "GitHub record over the size cap"
      : "GitHub did not answer in time";
    // A rate limit clears on its own; a 404 or a size cap would not, but the
    // record is cached only briefly either way.
    return remember(githubCache, key, { skipped: reason });
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return remember(githubCache, key, { skipped: "GitHub returned a document that is not JSON" }); }
  if (!doc || typeof doc !== "object" || typeof doc.full_name !== "string") return remember(githubCache, key, { skipped: "GitHub returned a record without a name" });
  // A private repository a configured token can read answers exactly like a
  // missing one: nothing about it leaves through this tool.
  if (doc.private === true) return remember(githubCache, key, { skipped: "repository not found on GitHub (HTTP 404)" });
  return remember(githubCache, key, doc);
}

// --- facts ------------------------------------------------------------------

/** owner/repo from a manifest `repository` field, when it points at GitHub. */
export function githubRepoOf(repository) {
  const url = typeof repository === "string" ? repository : repository && typeof repository.url === "string" ? repository.url : "";
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i)
    || url.trim().match(/^(?:github:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(repo) || repo === "." || repo === ".." || repo.includes("..")) return null;
  return { owner, repo };
}

const daysSince = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : null;
};
const agePhrase = (days) => (days === null ? null : days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX_LIST) : []);
const countOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : 0);

/**
 * Observations from the manifests and the optional repository record. Pure,
 * so the fixtures drive it directly; `now` only for the age arithmetic.
 */
export function describePackage({ name, requestedVersion, versionDoc, packument = null, github = null, skippedReads = [] }) {
  const version = versionDoc.version;
  const time = packument?.time && typeof packument.time === "object" ? packument.time : null;
  const publishedAt = typeof time?.[version] === "string" ? time[version] : null;
  const createdAt = typeof time?.created === "string" ? time.created : null;
  const versionCount = packument ? countOf(packument.versions) : null;
  const distTags = packument?.["dist-tags"] && typeof packument["dist-tags"] === "object" ? packument["dist-tags"] : null;
  const tagsForVersion = distTags ? Object.entries(distTags).filter(([, v]) => v === version).map(([t]) => t).slice(0, MAX_LIST) : [];

  const maintainerList = Array.isArray(versionDoc.maintainers) ? versionDoc.maintainers : Array.isArray(packument?.maintainers) ? packument.maintainers : [];
  const maintainerNames = maintainerList.map((m) => (typeof m === "string" ? m : m?.name)).filter((n) => typeof n === "string").slice(0, MAX_LIST);

  const scripts = versionDoc.scripts && typeof versionDoc.scripts === "object" ? versionDoc.scripts : {};
  const runOnInstall = INSTALL_HOOKS.filter((h) => typeof scripts[h] === "string" && scripts[h].trim());
  const otherHooks = OTHER_HOOKS.filter((h) => typeof scripts[h] === "string" && scripts[h].trim());

  const dist = versionDoc.dist && typeof versionDoc.dist === "object" ? versionDoc.dist : {};
  const attestations = dist.attestations && typeof dist.attestations === "object" ? dist.attestations : null;
  const provenance = {
    attested: Boolean(attestations),
    predicateType: typeof attestations?.provenance?.predicateType === "string" ? attestations.provenance.predicateType : null,
    attestationsUrl: typeof attestations?.url === "string" ? attestations.url : null,
    registrySignatures: Array.isArray(dist.signatures) ? dist.signatures.length : 0,
    integrity: typeof dist.integrity === "string" ? dist.integrity : null,
  };

  const bundledRaw = versionDoc.bundleDependencies ?? versionDoc.bundledDependencies;
  const bundled = bundledRaw === true ? Object.keys(versionDoc.dependencies || {}).slice(0, MAX_LIST) : listOf(bundledRaw);
  const binaries = typeof versionDoc.bin === "string" ? [name.split("/").pop()] : versionDoc.bin && typeof versionDoc.bin === "object" ? Object.keys(versionDoc.bin).slice(0, MAX_LIST) : [];
  const deprecated = typeof versionDoc.deprecated === "string" ? versionDoc.deprecated.slice(0, 300) : null;

  const declaredRepo = typeof versionDoc.repository === "string" ? versionDoc.repository : typeof versionDoc.repository?.url === "string" ? versionDoc.repository.url : null;
  const gh = githubRepoOf(versionDoc.repository);
  const repository = {
    declared: declaredRepo,
    directory: typeof versionDoc.repository?.directory === "string" ? versionDoc.repository.directory : null,
    github: gh ? `${gh.owner}/${gh.repo}` : null,
    read: false,
    matchesManifest: null,
    resolvedName: null,
    url: null,
    archived: null,
    fork: null,
    disabled: null,
    createdAt: null,
    pushedAt: null,
    stars: null,
    defaultBranch: null,
    license: null,
  };
  if (github && !github.skipped) {
    const same = typeof github.full_name === "string" && gh && github.full_name.toLowerCase() === `${gh.owner}/${gh.repo}`.toLowerCase();
    Object.assign(repository, {
      read: true,
      matchesManifest: same,
      resolvedName: github.full_name,
      url: typeof github.html_url === "string" ? github.html_url : null,
      archived: Boolean(github.archived),
      fork: Boolean(github.fork),
      disabled: Boolean(github.disabled),
      createdAt: typeof github.created_at === "string" ? github.created_at : null,
      pushedAt: typeof github.pushed_at === "string" ? github.pushed_at : null,
      stars: Number.isFinite(github.stargazers_count) ? github.stargazers_count : null,
      defaultBranch: typeof github.default_branch === "string" ? github.default_branch : null,
      license: github.license?.spdx_id && github.license.spdx_id !== "NOASSERTION" ? github.license.spdx_id : github.license?.name ?? null,
    });
  }

  const versionAgeDays = daysSince(publishedAt);
  const packageAgeDays = daysSince(createdAt);

  const signals = [];
  if (deprecated) signals.push(`version is deprecated: ${deprecated}`);
  if (versionAgeDays !== null) signals.push(`version ${version} published ${agePhrase(versionAgeDays)}`);
  else signals.push(`publish date of ${version} not read (package document over the size cap)`);
  if (packageAgeDays !== null) signals.push(`package first published ${agePhrase(packageAgeDays)}${versionCount !== null ? `, ${versionCount} version${versionCount === 1 ? "" : "s"}` : ""}`);
  signals.push(maintainerNames.length === 1 ? "single maintainer" : `${maintainerNames.length} maintainers`);
  signals.push(provenance.attested ? `provenance attestation present${provenance.predicateType ? ` (${provenance.predicateType})` : ""}` : "no provenance attestation");
  signals.push(runOnInstall.length ? `install script present: ${runOnInstall.join(", ")}` : "no install script declared");
  if (otherHooks.length) signals.push(`${otherHooks.join(", ")} script declared (runs for a git or local install, not a registry install)`);
  signals.push(binaries.length ? `declares ${binaries.length} binar${binaries.length === 1 ? "y" : "ies"}: ${binaries.join(", ")}` : "declares no binary");
  signals.push(`${countOf(versionDoc.dependencies)} runtime dependencies, ${countOf(versionDoc.optionalDependencies)} optional`);
  if (bundled.length) signals.push(`${bundled.length} bundled dependencies: ${bundled.join(", ")}`);
  if (!declaredRepo) signals.push("no repository declared in the manifest");
  else if (!gh) signals.push("repository declared outside GitHub; not read");
  else if (repository.read) {
    signals.push(repository.matchesManifest ? "GitHub repository matches the manifest" : `GitHub resolves the manifest repository to ${repository.resolvedName}`);
    if (repository.archived) signals.push("GitHub repository is archived");
    if (repository.fork) signals.push("GitHub repository is a fork");
    if (repository.disabled) signals.push("GitHub repository is disabled");
  } else signals.push(`GitHub repository not read: ${github?.skipped || "skipped"}`);

  const planned = 1 + (gh ? 1 : 0);
  const completed = planned - skippedReads.length;
  const coverage = partialFields(planned, completed);

  return {
    package: name,
    requestedVersion,
    version,
    distTags: tagsForVersion,
    publishedAt,
    versionAgeDays,
    createdAt,
    packageAgeDays,
    versionCount,
    maintainers: { count: maintainerNames.length, names: maintainerNames },
    provenance,
    installScripts: { present: runOnInstall.length > 0, runOnInstall, otherHooks },
    dependencies: {
      runtime: countOf(versionDoc.dependencies),
      optional: countOf(versionDoc.optionalDependencies),
      peer: countOf(versionDoc.peerDependencies),
      bundled,
    },
    binaries,
    deprecated,
    license: typeof versionDoc.license === "string" ? versionDoc.license : null,
    engines: versionDoc.engines && typeof versionDoc.engines === "object" ? versionDoc.engines : null,
    repository,
    signals,
    reads: {
      registry: packument ? "package document" : "version document",
      github: !gh ? "not applicable" : repository.read ? "read" : "skipped",
    },
    skippedReads,
    complete: coverage.complete,
    partial: coverage.truncated,
    sources: ["registry.npmjs.org", ...(repository.read ? ["api.github.com"] : [])],
  };
}

// --- tool -------------------------------------------------------------------

async function check(input) {
  const { name, version: requestedVersion } = parsePackageInput(input);
  const skippedReads = [];
  let packument = await readPackument(name);
  let versionDoc;
  if (packument.oversize) {
    packument = null;
    skippedReads.push({ read: "package document", reason: `over the ${Math.round(PACKUMENT_MAX_BYTES / 1048576)}MB cap; the version document answered instead (no publish dates, no version count)` });
    versionDoc = await readVersionDoc(name, requestedVersion);
  } else {
    const distTags = packument["dist-tags"] && typeof packument["dist-tags"] === "object" ? packument["dist-tags"] : {};
    const resolved = typeof distTags[requestedVersion] === "string" ? distTags[requestedVersion] : packument.versions[requestedVersion] ? requestedVersion : null;
    if (!resolved || !packument.versions[resolved] || typeof packument.versions[resolved] !== "object") {
      const tags = Object.keys(distTags).slice(0, 10);
      throw bad(`Package "${name}" has no version or dist-tag "${requestedVersion}"${tags.length ? ` (dist-tags: ${tags.join(", ")})` : ""}`, 404);
    }
    versionDoc = { ...packument.versions[resolved], version: resolved };
  }
  let github = null;
  const gh = githubRepoOf(versionDoc.repository);
  if (gh) {
    github = await readGithub(gh.owner, gh.repo);
    if (github.skipped) skippedReads.push({ read: "github repository", reason: github.skipped });
  }
  return describePackage({ name, requestedVersion, versionDoc, packument, github, skippedReads });
}

export const MCP_PACKAGE_TOOLS = [
  {
    route: "POST /api/mcp-package-check",
    name: "MCP package check",
    slug: "mcp-package-check",
    category: "data",
    price: "$0.005",
    description:
      "The published facts about an npm package that ships an MCP server, read before running it: resolved version and publish date, package and version age, maintainer count, provenance attestation, install scripts (preinstall, install, postinstall; prepare listed apart), dependency, optional and bundled counts, declared binaries, deprecation, and the GitHub repository the manifest names (one keyless read: resolved name against the manifest, archived, fork, last push). Accepts a name, name@version, or an npx command line. Observations only, each as a field plus a neutral sentence in signals; no score. A skipped read (oversize package document, GitHub rate limit) is named and the answer is marked partial.",
    tags: ["data", "npm", "mcp", "package", "supply-chain", "provenance", "github", "dev"],
    discovery: {
      bodyType: "json",
      input: { package: "@modelcontextprotocol/server-filesystem" },
      inputSchema: {
        properties: {
          package: { type: "string", description: "npm package name, name@version, or an npx / npm exec command line (\"npx -y agent402-mcp@0.13.22\")." },
          version: { type: "string", description: "Exact version or dist-tag to check (default latest). Must agree with any version in `package`." },
        },
        required: ["package"],
      },
      output: {
        example: {
          "package": "@modelcontextprotocol/server-filesystem",
          "requestedVersion": "latest",
          "version": "2.0.0",
          "distTags": [
            "latest"
          ],
          "publishedAt": "2026-10-19T06:49:57.471Z",
          "versionAgeDays": 1,
          "createdAt": "2024-11-21T19:14:54.330Z",
          "packageAgeDays": 697,
          "versionCount": 21,
          "maintainers": {
            "count": 6,
            "names": [
              "jspahrsummers",
              "pcarleton",
              "fweinberger",
              "thedsp",
              "ochafik-ant",
              "cliffhall"
            ]
          },
          "provenance": {
            "attested": true,
            "predicateType": "https://slsa.dev/provenance/v1",
            "attestationsUrl": "https://registry.npmjs.org/-/npm/v1/attestations/@modelcontextprotocol%2fserver-filesystem@2.0.0",
            "registrySignatures": 2,
            "integrity": "sha512-..."
          },
          "installScripts": {
            "present": false,
            "runOnInstall": [],
            "otherHooks": [
              "prepare"
            ]
          },
          "dependencies": {
            "runtime": 5,
            "optional": 0,
            "peer": 0,
            "bundled": []
          },
          "binaries": [
            "mcp-server-filesystem"
          ],
          "deprecated": null,
          "license": "SEE LICENSE IN LICENSE",
          "engines": {
            "node": ">=24"
          },
          "repository": {
            "declared": "git+https://github.com/modelcontextprotocol/servers.git",
            "directory": null,
            "github": "modelcontextprotocol/servers",
            "read": true,
            "matchesManifest": true,
            "resolvedName": "modelcontextprotocol/servers",
            "url": "https://github.com/modelcontextprotocol/servers",
            "archived": false,
            "fork": false,
            "disabled": false,
            "createdAt": "2024-11-19T01:10:17Z",
            "pushedAt": "2026-10-19T06:46:48Z",
            "stars": 91406,
            "defaultBranch": "main",
            "license": "Other"
          },
          "signals": [
            "version 2.0.0 published 1 day ago",
            "package first published 697 days ago, 21 versions",
            "6 maintainers",
            "provenance attestation present (https://slsa.dev/provenance/v1)",
            "no install script declared",
            "prepare script declared (runs for a git or local install, not a registry install)",
            "declares 1 binary: mcp-server-filesystem",
            "5 runtime dependencies, 0 optional",
            "GitHub repository matches the manifest"
          ],
          "reads": {
            "registry": "package document",
            "github": "read"
          },
          "skippedReads": [],
          "complete": true,
          "partial": false,
          "sources": [
            "registry.npmjs.org",
            "api.github.com"
          ]
        },
      },
    },
    handler: check,
  },
];

export const __test = {
  reset() { packumentCache.clear(); githubCache.clear(); },
  PACKUMENT_MAX_BYTES,
};
