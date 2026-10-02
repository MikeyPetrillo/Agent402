// The public source link is the one surface that still carried a PERSON.
//
// This site publishes receiving wallet addresses on purpose: being checkable
// against the chain is the product. A wallet is only a number until something
// ties it to a person, and the repository URL was that something - it appeared
// in the footer of every page, in six Organization JSON-LD `sameAs` blocks
// (which is precisely what a search engine reads to join an entity to an
// account), on /company, /terms, /security and /why, in the connector copy
// agents read, in the discovery manifest, and in the User-Agent other
// operators see in their own logs.
//
// Moving the repository to an organisation account is the real fix and it
// happens on GitHub. What this pins is that the move stays a ONE-LINE change:
// every served surface reads src/repo-link.js, so a new page cannot quietly
// re-hardcode a spelling that the next rename would then miss.
//
//   node scripts/test-repo-link.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// ---------------------------------------------------------------------------
// The constant itself.
// ---------------------------------------------------------------------------
const { REPO_URL, REPO_SLUG, REPO_NAMESPACE, repoUrl } = await import("../src/repo-link.js");
ok(/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(REPO_URL), `REPO_URL is a bare repo URL (${REPO_URL})`);
ok(!REPO_URL.endsWith("/"), "no trailing slash, so repoUrl() cannot produce a double slash");
ok(REPO_SLUG === REPO_URL.replace("https://github.com/", ""), `REPO_SLUG is owner/name (${REPO_SLUG})`);
ok(REPO_NAMESPACE === `io.github.${REPO_SLUG.split("/")[0]}`, `REPO_NAMESPACE follows the owner (${REPO_NAMESPACE})`);
ok(repoUrl("issues") === `${REPO_URL}/issues`, "repoUrl joins a path");
ok(repoUrl("/issues") === `${REPO_URL}/issues`, "a leading slash on the path does not double up");
ok(repoUrl() === REPO_URL, "repoUrl() with no path is the bare URL");

// The override is the whole point: if it does not take, the rename is still a
// sweep through forty files.
const OVERRIDE = "https://github.com/some-org/Agent402";
process.env.AGENT402_REPO_URL = OVERRIDE;
const reread = await import(`../src/repo-link.js?override=${Date.now()}`);
ok(reread.REPO_URL === OVERRIDE, `AGENT402_REPO_URL overrides the default (got ${reread.REPO_URL})`);
ok(reread.REPO_SLUG === "some-org/Agent402", "the slug follows the override");
ok(reread.REPO_NAMESPACE === "io.github.some-org", "the registry namespace follows the override");
ok(reread.repoUrl("wiki/Security-Model") === `${OVERRIDE}/wiki/Security-Model`, "paths follow the override");
delete process.env.AGENT402_REPO_URL;

// ---------------------------------------------------------------------------
// The sweep. A served module may not spell the URL out again.
// ---------------------------------------------------------------------------
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
});

// Deliberate keeps, each with its reason stated. A file added here needs one.
const EXEMPT = new Map([
  ["src/repo-link.js", "the definition itself"],
  ["src/tools/enrich-kit.js", "a documented EXAMPLE INPUT for the github-repo tool, not a link to us; the CI example check drives it against the live API, so the repo named there is test data"],
]);

const files = walk(join(ROOT, "src")).map((p) => relative(ROOT, p));
const offenders = [];
for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  const src = readFileSync(join(ROOT, rel), "utf8");
  // Strip line comments: a comment naming the old URL is documentation, not a
  // served surface, and failing on one would train the next author to delete
  // the explanation rather than the link.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (/github\.com\/MikeyPetrillo/i.test(code)) offenders.push(rel);
}
ok(offenders.length === 0, `no served module hardcodes the repository URL (offenders: ${offenders.join(", ") || "none"})`);

// CONTROL. A sweep that has never seen a hit cannot tell "clean" from "blind".
const control = "const x = `<a href=\"https://github.com/MikeyPetrillo/Agent402\">source</a>`;";
ok(/github\.com\/MikeyPetrillo/i.test(control), "control: the sweep's own pattern matches a planted hardcoded link");

// And the reach: the surfaces that most need to follow a move must actually
// import it, or the sweep above passes while they render a stale URL from
// somewhere the pattern does not look.
const MUST_IMPORT = ["src/chrome.js", "src/ledger-chrome.js", "src/ledger-home.js", "src/company.js",
  "src/terms.js", "src/security-page.js", "src/why.js", "src/discovery.js", "src/transparency.js",
  "src/seo.js", "src/tools/web-kit.js"];
for (const rel of MUST_IMPORT) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  ok(/from "\.\.?\/repo-link\.js"/.test(src), `${rel} reads the constant`);
}

console.log(`\n${pass} passed (${files.length} modules swept)`);
