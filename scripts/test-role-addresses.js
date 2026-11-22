// Public contact surfaces name the role addresses: security@ for
// vulnerability reports, help@ for everything else. The personal mailbox
// appears only where another record fixes the address: the copyright agent's
// block on /terms (the address registered for that agent), the package
// author fields (they change with a release), the default a registry claim
// was made under, and the contact a data source's fair-access policy was
// given. Any other tracked file that names it fails here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const PERSONAL = ["mike", "agent402.tools"].join("@");
const HELP = "help@agent402.tools", SECURITY = "security@agent402.tools";

// file -> how many times it may name the personal mailbox, and why.
const KEPT = new Map([
  ["src/terms.js", [2, "the copyright agent's registered address, as link and text"]],
  ["src/server.js", [1, "the default maintainer address of the registry manifest"]],
  ["src/tools/edgar-kit.js", [1, "the contact in the User-Agent given to the filings source"]],
  ["docs/configuration.md", [1, "generated from the registry manifest default"]],
  ["scripts/test-compliance-surfaces.js", [1, "reads the copyright agent block"]],
  ["scripts/test-edgar-kit.js", [1, "the same User-Agent"]],
  ["scripts/test-glama-manifest.js", [2, "reads the registry manifest default"]],
]);
const isAuthorFile = (f) => /(^|\/)package\.json$|(^|\/)pyproject\.toml$/.test(f);
const tracked = execFileSync("git", ["grep", "-l", "-F", PERSONAL, "--", "."], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => f !== "scripts/test-role-addresses.js");
const count = (f) => read(f).split(PERSONAL).length - 1;
const strays = tracked.filter((f) => !isAuthorFile(f) && !(KEPT.has(f) && count(f) <= KEPT.get(f)[0])).map((f) => `${f} (${count(f)})`);
ok(strays.length === 0, `no contact surface names the personal mailbox (${strays.join(", ") || "none"})`);
const authorOnly = tracked.filter(isAuthorFile).filter((f) => count(f) !== 1 || !new RegExp(`(author|authors)[^\\n]*${PERSONAL.replace(".", "\\.")}`).test(read(f))).map((f) => f);
ok(authorOnly.length === 0, `a package file names it once, in its author field (${authorOnly.join(", ") || "all"})`);
ok([...KEPT.keys()].every((f) => tracked.includes(f)), `each kept use is still there (gone: ${[...KEPT.keys()].filter((f) => !tracked.includes(f)).join(", ") || "none"})`);
{
  const terms = read("src/terms.js");
  const at = terms.indexOf(PERSONAL);
  ok(at > 0 && /Copyright agent/.test(terms.slice(Math.max(0, at - 400), at)) && terms.includes(HELP), "/terms keeps the registered address in the copyright agent block and names the help address elsewhere");
}

// Security reports go to the security address, on every surface that takes them.
const { COMPANY_MAILBOXES } = await import("../src/company.js");
ok(COMPANY_MAILBOXES.operator === HELP && COMPANY_MAILBOXES.security === SECURITY, "the company page's role addresses are help@ and security@");
ok(read("SECURITY.md").includes(`**${SECURITY}**`) && !read("SECURITY.md").includes(HELP), "SECURITY.md names the security address");
ok(read("src/security-page.js").includes(`mailto:${SECURITY}`) && new RegExp(`SECURITY_CONTACT_EMAIL[^\\n]*"${SECURITY.replace(".", "\\.")}"`).test(read("src/server.js")), "/security and the security.txt default name the security address");
ok(read("src/trust-page.js").includes("COMPANY_MAILBOXES.security"), "/trust sends a vulnerability report to the security address");
// Support, privacy, legal and corrections go to the help address.
const helpSurfaces = ["README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLA.md", "TRADEMARKS.md", "NOTICE", ".github/PULL_REQUEST_TEMPLATE.md", "wiki/FAQ.md", "wiki/Seller-Reputation.md", "src/privacy.js", "src/terms.js", "src/pages.js", "src/seo.js", "src/site-org.js", "src/acp.js", "src/discovery.js", "src/crawler-page.js", "src/ledger-chrome.js", "src/payments.js", "src/market-page.js"];
const noHelp = helpSurfaces.filter((f) => !read(f).includes(HELP));
ok(noHelp.length === 0, `each contact surface names the help address (${noHelp.join(", ") || `${helpSurfaces.length} read`})`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
