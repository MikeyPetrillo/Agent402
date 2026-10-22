// mcp-package-kit offline: a stub npm registry and a stub GitHub API on one
// HTTP server bound to 127.0.0.1:0. The kit keeps reading through safeFetch
// (which refuses a loopback target by design), so a fetch shim rewrites the
// two public origins to the stub and forwards the request as-is; the size
// cap, the timeout and the body streaming inside safeFetch all run for real.
//
// Pinned: input parsing (names, specs, npx command lines) refuses before any
// egress; dist-tag and exact-version resolution; the facts and signals for a
// version with provenance, one with install scripts, a deprecated one; a
// package document over the cap falling back to the version document and
// saying so; a rate-limited GitHub read skipped and marked partial; a renamed
// repository; a missing package and a missing version as 404; caching.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MCP_PACKAGE_TOOLS, parsePackageInput, packageFromCommand, githubRepoOf, describePackage, __test } from "../src/tools/mcp-package-kit.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const h = MCP_PACKAGE_TOOLS.find((t) => t.slug === "mcp-package-check").handler;
const throws = async (p, status, m, re) => {
  try { await p; } catch (e) { ok(e.statusCode === status && (!re || re.test(e.message)), `${m} (${e.statusCode} ${String(e.message).slice(0, 90)})`); return e; }
  ok(false, `${m} (did not throw)`);
};
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

// ---- fixtures ---------------------------------------------------------------
const GOOD = {
  name: "good-pkg",
  "dist-tags": { latest: "1.2.0", next: "1.3.0-beta.1" },
  time: { created: iso(400), modified: iso(3), "1.0.0": iso(400), "1.2.0": iso(3), "1.3.0-beta.1": iso(0) },
  maintainers: [{ name: "alice", email: "a@example.org" }, { name: "bob", email: "b@example.org" }],
  versions: {
    "1.0.0": { name: "good-pkg", version: "1.0.0", dist: { integrity: "sha512-old" }, maintainers: [{ name: "alice" }] },
    "1.2.0": {
      name: "good-pkg", version: "1.2.0", license: "MIT", engines: { node: ">=20" },
      bin: { "good-pkg": "index.js", "good-pkg-admin": "admin.js" },
      scripts: { build: "tsc", test: "node test.js" },
      dependencies: { a: "1", b: "2", c: "3" }, optionalDependencies: { d: "1" }, peerDependencies: { e: "1" },
      repository: { type: "git", url: "git+https://github.com/Acme/Good-Pkg.git", directory: "packages/good" },
      maintainers: [{ name: "alice", email: "a@example.org" }, { name: "bob", email: "b@example.org" }],
      dist: {
        integrity: "sha512-abc", signatures: [{ keyid: "k", sig: "s" }],
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/good-pkg@1.2.0", provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      },
    },
    "1.3.0-beta.1": { name: "good-pkg", version: "1.3.0-beta.1", dist: { integrity: "sha512-beta" }, repository: "github:Acme/Good-Pkg" },
  },
};
const SCRIPTED = {
  name: "@acme/scripted",
  "dist-tags": { latest: "0.0.3" },
  time: { created: iso(1), "0.0.3": iso(1) },
  maintainers: [{ name: "mallory" }],
  versions: {
    "0.0.3": {
      name: "@acme/scripted", version: "0.0.3", bin: "cli.js",
      scripts: { postinstall: "node setup.js", prepare: "husky", preinstall: " " },
      dependencies: { x: "1" }, bundleDependencies: ["x"],
      maintainers: [{ name: "mallory" }],
      dist: { integrity: "sha512-xyz", signatures: [] },
    },
  },
};
const OLD = {
  name: "old-pkg",
  "dist-tags": { latest: "2.0.0" },
  time: { created: iso(2000), "2.0.0": iso(900) },
  maintainers: [{ name: "carol" }],
  versions: { "2.0.0": { name: "old-pkg", version: "2.0.0", deprecated: "use new-pkg instead", repository: "https://gitlab.com/carol/old-pkg", dist: {} } },
};
const LIMITED = { ...GOOD, name: "limited-pkg", versions: { "1.2.0": { ...GOOD.versions["1.2.0"], name: "limited-pkg", repository: "https://github.com/acme/limited" } }, "dist-tags": { latest: "1.2.0" } };
const RENAMED = { ...GOOD, name: "renamed-pkg", versions: { "1.2.0": { ...GOOD.versions["1.2.0"], name: "renamed-pkg", repository: "https://github.com/acme/old-name" } }, "dist-tags": { latest: "1.2.0" } };
const HIDDEN = { ...GOOD, name: "hidden-pkg", versions: { "1.2.0": { ...GOOD.versions["1.2.0"], name: "hidden-pkg", repository: "https://github.com/acme/hidden" } }, "dist-tags": { latest: "1.2.0" } };
const GONE = { ...GOOD, name: "gone-pkg", versions: { "1.2.0": { ...GOOD.versions["1.2.0"], name: "gone-pkg", repository: "https://github.com/acme/gone" } }, "dist-tags": { latest: "1.2.0" } };
const BIG_VERSION_DOC = { name: "big-pkg", version: "7.0.0", scripts: { postinstall: "x" }, maintainers: [{ name: "dave" }], dist: { integrity: "sha512-big" }, repository: "https://github.com/acme/big" };
const BIG_BODY = JSON.stringify({ name: "big-pkg", "dist-tags": { latest: "7.0.0" }, versions: { "7.0.0": BIG_VERSION_DOC }, readme: "x".repeat(__test.PACKUMENT_MAX_BYTES + 1024) });

const GH = (full, extra = {}) => ({ full_name: full, html_url: `https://github.com/${full}`, archived: false, fork: false, disabled: false, created_at: "2024-01-01T00:00:00Z", pushed_at: "2026-10-01T00:00:00Z", stargazers_count: 12, default_branch: "main", license: { spdx_id: "MIT" }, ...extra });

const REGISTRY = new Map([
  ["/good-pkg", GOOD], ["/@acme%2Fscripted", SCRIPTED], ["/old-pkg", OLD], ["/limited-pkg", LIMITED], ["/renamed-pkg", RENAMED], ["/gone-pkg", GONE], ["/hidden-pkg", HIDDEN],
  ["/big-pkg/latest", BIG_VERSION_DOC], ["/big-pkg/7.0.0", BIG_VERSION_DOC],
]);
const GITHUB = new Map([
  ["/repos/Acme/Good-Pkg", { status: 200, body: GH("Acme/Good-Pkg") }],
  ["/repos/acme/limited", { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: { message: "API rate limit exceeded" } }],
  ["/repos/acme/old-name", { status: 200, body: GH("acme/new-name", { archived: true, fork: true }) }],
  ["/repos/acme/gone", { status: 404, body: { message: "Not Found" } }],
  // What a token with access to a private repository would see.
  ["/repos/acme/hidden", { status: 200, body: GH("acme/hidden", { private: true, description: "internal notes", stargazers_count: 3 }) }],
  ["/repos/acme/big", { status: 200, body: GH("acme/big") }],
]);

const hits = [];
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  hits.push(`${req.headers["x-stub-origin"]}${path}`);
  if (req.headers["x-stub-origin"] === "registry") {
    if (path === "/big-pkg") { res.writeHead(200, { "content-type": "application/json" }); return res.end(BIG_BODY); }
    const doc = REGISTRY.get(path);
    if (!doc) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Not found" })); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(doc));
  }
  const gh = GITHUB.get(path) || { status: 404, body: { message: "Not Found" } };
  res.writeHead(gh.status, { "content-type": "application/json", ...(gh.headers || {}) });
  res.end(JSON.stringify(gh.body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (url, init = {}) => {
  fetches++;
  const u = new URL(String(url));
  const origin = u.origin === "https://registry.npmjs.org" ? "registry" : u.origin === "https://api.github.com" ? "github" : null;
  if (!origin) throw new Error(`stub: unexpected origin ${u.origin}`);
  // Forward everything but the SSRF dispatcher, which would refuse the loopback stub.
  const { dispatcher, ...rest } = init;
  return realFetch(`${STUB}${u.pathname}${u.search}`, { ...rest, headers: { ...(rest.headers || {}), "x-stub-origin": origin } });
};
const reset = () => { __test.reset(); hits.length = 0; fetches = 0; };

try {
  // ---- parsing, no egress --------------------------------------------------
  reset();
  await throws(h({}), 400, "missing package -> 400");
  await throws(h({ package: "   " }), 400, "blank package -> 400");
  await throws(h({ package: "Bad Name!" }), 400, "a name with a space -> 400");
  await throws(h({ package: "../etc" }), 400, "a path-shaped name -> 400");
  await throws(h({ package: "good-pkg", version: "^1.0.0" }), 400, "a range -> 400", /exact version or a dist-tag/);
  await throws(h({ package: "good-pkg@1.2.0", version: "1.0.0" }), 400, "version disagreeing with the spec -> 400");
  await throws(h({ package: "npx -y --yes" }), 400, "a command line with no package -> 400");
  await throws(h({ package: "x".repeat(600) }), 400, "an oversized input -> 400");
  ok(fetches === 0, "every refusal happens before any egress");

  ok(packageFromCommand("npx -y agent402-mcp@latest") === "agent402-mcp@latest", "npx -y name@tag");
  ok(packageFromCommand("npx --yes -p @scope/pkg@1.0.0 run-it --flag") === "@scope/pkg@1.0.0", "-p names the package over the command");
  ok(packageFromCommand("npx --package=@scope/pkg cmd") === "@scope/pkg", "--package= form");
  ok(packageFromCommand("npm exec -- some-pkg arg") === "some-pkg", "npm exec -- form");
  ok(packageFromCommand("npm x some-pkg") === "some-pkg", "npm x form");
  ok(packageFromCommand("node index.js") === null, "not a package runner");
  assert.deepEqual(parsePackageInput({ package: "@acme/scripted" }), { name: "@acme/scripted", version: "latest" });
  assert.deepEqual(parsePackageInput({ package: "npx -y good-pkg@next" }), { name: "good-pkg", version: "next" });
  assert.deepEqual(parsePackageInput({ package: "good-pkg@1.2.0", version: "1.2.0" }), { name: "good-pkg", version: "1.2.0" });
  assert.deepEqual(parsePackageInput({ package: "JSONStream" }), { name: "JSONStream", version: "latest" });
  ok(true, "specs, scopes, dist-tags and legacy casing parse as written");
  assert.deepEqual(githubRepoOf({ url: "git+ssh://git@github.com/Acme/Good-Pkg.git" }), { owner: "Acme", repo: "Good-Pkg" });
  assert.deepEqual(githubRepoOf("github:acme/x"), { owner: "acme", repo: "x" });
  ok(githubRepoOf("https://gitlab.com/carol/old-pkg") === null && githubRepoOf("https://github.com/acme/../x") === null, "repository parsing: GitHub only, no path tricks");

  // ---- a version with provenance and a matching repository ----------------
  reset();
  const good = await h({ package: "good-pkg" });
  ok(good.version === "1.2.0" && good.requestedVersion === "latest" && good.distTags.includes("latest"), "latest resolves through dist-tags");
  ok(good.versionAgeDays === 3 && good.packageAgeDays === 400 && good.versionCount === 3, "ages from the time map, version count from versions");
  ok(good.maintainers.count === 2 && good.maintainers.names.join() === "alice,bob", "maintainers counted and named, emails dropped");
  ok(good.provenance.attested === true && good.provenance.predicateType.includes("slsa") && good.provenance.registrySignatures === 1, "provenance attestation read from dist");
  ok(good.installScripts.present === false && good.installScripts.runOnInstall.length === 0, "build and test scripts are not install scripts");
  ok(good.dependencies.runtime === 3 && good.dependencies.optional === 1 && good.dependencies.peer === 1 && good.dependencies.bundled.length === 0, "dependency counts");
  ok(good.binaries.join() === "good-pkg,good-pkg-admin" && good.license === "MIT" && good.engines.node === ">=20", "binaries, license, engines");
  ok(good.repository.github === "Acme/Good-Pkg" && good.repository.read && good.repository.matchesManifest === true && good.repository.directory === "packages/good", "GitHub record read and matched to the manifest");
  ok(good.complete === true && good.partial === false && good.skippedReads.length === 0 && good.reads.github === "read", "both reads done -> complete");
  ok(good.signals.includes("provenance attestation present (https://slsa.dev/provenance/v1)") && good.signals.includes("no install script declared") && good.signals.includes("version 1.2.0 published 3 days ago") && good.signals.includes("GitHub repository matches the manifest"), "signals are neutral statements of the facts");
  ok(!/\b(safe|secure|risk|trust|score)\b/i.test(JSON.stringify(good.signals)), "no verdict words in the signals");
  ok(hits.join() === "registry/good-pkg,github/repos/Acme/Good-Pkg", `one registry read and one GitHub read (${hits.join(", ")})`);

  const again = await h({ package: "good-pkg@1.2.0" });
  ok(again.version === "1.2.0" && hits.length === 2, "the second call answers from the cache (no new reads)");
  const next = await h({ package: "npx -y good-pkg@next" });
  ok(next.version === "1.3.0-beta.1" && next.versionAgeDays === 0 && next.signals.includes("version 1.3.0-beta.1 published today") && next.distTags.join() === "next", "another dist-tag from the same cached document");
  ok(next.provenance.attested === false && next.signals.includes("no provenance attestation"), "a version without attestations says so");

  // ---- install scripts, bundled deps, a scoped name ------------------------
  reset();
  const scripted = await h({ package: "@acme/scripted" });
  ok(hits[0] === "registry/@acme%2Fscripted", "a scoped name travels with the scope separator encoded");
  ok(scripted.installScripts.present === true && scripted.installScripts.runOnInstall.join() === "postinstall" && scripted.installScripts.otherHooks.join() === "prepare", "postinstall counted, a blank preinstall ignored, prepare listed apart");
  ok(scripted.signals.includes("install script present: postinstall") && scripted.signals.some((s) => s.startsWith("prepare script declared")), "install script signals");
  ok(scripted.dependencies.bundled.join() === "x" && scripted.binaries.join() === "scripted" && scripted.maintainers.count === 1, "bundled list, a string bin named after the package, single maintainer");
  ok(scripted.signals.includes("single maintainer") && scripted.signals.includes("package first published 1 day ago, 1 version"), "maintainer and age signals");
  ok(scripted.reads.github === "not applicable" && scripted.signals.includes("no repository declared in the manifest") && scripted.complete === true, "no repository: nothing to read, still complete");

  // ---- deprecated, repository outside GitHub -------------------------------
  reset();
  const old = await h({ package: "old-pkg" });
  ok(old.deprecated === "use new-pkg instead" && old.signals[0] === "version is deprecated: use new-pkg instead", "deprecation is the first signal");
  ok(old.repository.github === null && old.reads.github === "not applicable" && old.signals.includes("repository declared outside GitHub; not read"), "a repository elsewhere is named, not read");
  ok(hits.length === 1, "no GitHub read for a repository elsewhere");

  // ---- GitHub rate limited: skipped, partial, never fatal -------------------
  reset();
  const limited = await h({ package: "limited-pkg" });
  ok(limited.version === "1.2.0" && limited.provenance.attested === true, "registry facts answer when GitHub refuses");
  ok(limited.repository.read === false && limited.reads.github === "skipped" && limited.partial === true && limited.complete === false, "GitHub skipped -> partial");
  ok(limited.skippedReads.length === 1 && /rate limit or refusal \(HTTP 403\)/.test(limited.skippedReads[0].reason), `the skipped read names the reason (${limited.skippedReads[0]?.reason})`);
  ok(limited.signals.some((s) => s.startsWith("GitHub repository not read:")), "the skip is a signal too");

  // ---- renamed / archived / fork, and a missing repository -----------------
  reset();
  const renamed = await h({ package: "renamed-pkg" });
  ok(renamed.repository.matchesManifest === false && renamed.repository.resolvedName === "acme/new-name" && renamed.signals.includes("GitHub resolves the manifest repository to acme/new-name"), "a renamed repository is reported, not matched");
  ok(renamed.repository.archived === true && renamed.repository.fork === true && renamed.signals.includes("GitHub repository is archived") && renamed.signals.includes("GitHub repository is a fork"), "archived and fork flags");
  const gone = await h({ package: "gone-pkg" });
  ok(gone.partial === true && /not found on GitHub \(HTTP 404\)/.test(gone.skippedReads[0].reason), "a repository GitHub does not have is a skipped read");
  const hidden = await h({ package: "hidden-pkg" });
  ok(hidden.repository.read === false && hidden.skippedReads[0]?.reason === gone.skippedReads[0].reason && !JSON.stringify(hidden).includes("internal notes"),
    `a private repository answers exactly like a missing one (${hidden.skippedReads[0]?.reason})`);

  // ---- oversize package document -> version document -----------------------
  reset();
  const big = await h({ package: "big-pkg" });
  ok(hits.join() === "registry/big-pkg,registry/big-pkg/latest,github/repos/acme/big", `oversize document, then the version document, then GitHub (${hits.join(", ")})`);
  ok(big.version === "7.0.0" && big.reads.registry === "version document" && big.publishedAt === null && big.versionAgeDays === null && big.versionCount === null, "the version document answers without dates or a count");
  ok(big.partial === true && big.skippedReads[0].read === "package document" && /over the 6MB cap/.test(big.skippedReads[0].reason), "the oversize read is named");
  ok(big.signals.includes("publish date of 7.0.0 not read (package document over the size cap)") && big.installScripts.present === true, "the missing date is a signal; the version's own facts still read");
  const bigExact = await h({ package: "big-pkg@7.0.0" });
  ok(bigExact.version === "7.0.0" && hits.filter((x) => x === "registry/big-pkg").length === 1, "the oversize verdict is cached; an exact version reads its own document");

  // ---- missing package, missing version ------------------------------------
  reset();
  await throws(h({ package: "nope-pkg" }), 404, "unknown package -> 404", /not on the npm registry/);
  await throws(h({ package: "good-pkg@9.9.9" }), 404, "unknown version -> 404 naming the dist-tags", /dist-tags: latest, next/);
  await throws(h({ package: "big-pkg@9.9.9" }), 404, "unknown version on the fallback path -> 404");

  // ---- describePackage is pure -----------------------------------------------
  const pure = describePackage({ name: "p", requestedVersion: "latest", versionDoc: { version: "1.0.0" } });
  ok(pure.signals.length >= 5 && pure.complete === true && pure.maintainers.count === 0 && pure.sources.join() === "registry.npmjs.org", "an empty manifest still describes itself");

  console.log(`\n${n} checks passed`);
} finally {
  globalThis.fetch = realFetch;
  server.close();
}
