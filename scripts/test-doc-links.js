// The repository's markdown links resolve (scripts/doc-links.js), offline:
//   - controls: a planted tree with one live and one dead link of each kind
//     (relative file, anchor, wiki page, GitHub blob and wiki URL) reports
//     exactly the dead ones;
//   - the real tree has no dead internal link;
//   - the external check runs on a schedule only (doc-links.yml), never on a push.
//
//   node scripts/test-doc-links.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalProblems, docFiles, headingSlugs, linksIn, classify, ROOT } from "./doc-links.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- controls ---
const t = mkdtempSync(join(tmpdir(), "doc-links-"));
mkdirSync(join(t, "wiki")); mkdirSync(join(t, "docs"));
writeFileSync(join(t, "docs", "configuration.md"), "# Configuration reference\n\n## Payments and x402\n");
writeFileSync(join(t, "wiki", "Self-Hosting.md"), "# Self-Hosting\n\n## Environment variables\n");
writeFileSync(join(t, "wiki", "Home.md"), [
  "# Home", "",
  "[[Self-Hosting]] [[Gone Page]] [[Label|Self-Hosting]]",
  "[a](Self-Hosting#environment-variables) [b](Self-Hosting#no-such-heading)",
  "[c](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md#payments-and-x402)",
  "[d](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/missing.md)",
  "[e](https://github.com/MikeyPetrillo/Agent402/wiki/Self-Hosting) [f](https://github.com/MikeyPetrillo/Agent402/wiki/Nope)",
  "`[[Inside Code]]` and [g](https://elsewhere.test/page)",
  "```", "[[In A Fence]] [h](nofile.md)", "```",
].join("\n"));
writeFileSync(join(t, "README.md"), "# Readme\n\n## Run it\n\n[1](docs/configuration.md) [2](docs/nope.md) [3](#run-it) [4](#walk-it) [5](docs/configuration.md#payments-and-x402) [6](wiki/Home.md) [7](/pricing)\n");
const probs = internalProblems(t, ["README.md", "wiki/Home.md"]);
const dead = probs.map((p) => p.target).sort();
const want = ["#walk-it", "Gone Page", "Self-Hosting#no-such-heading", "docs/nope.md", "https://github.com/MikeyPetrillo/Agent402/blob/main/docs/missing.md", "https://github.com/MikeyPetrillo/Agent402/wiki/Nope"].sort();
ok(JSON.stringify(dead) === JSON.stringify(want), `control: exactly the planted dead links are reported (got ${JSON.stringify(dead)})`);
ok(probs.every((p) => p.line > 0 && p.why), "each report names its line and why");
ok(headingSlugs("## Pay per call from a wallet\n## What's in the catalog (500+ tools)\n## Run it\n## Run it").has("whats-in-the-catalog-500-tools") && headingSlugs("## Run it\n## Run it").has("run-it-1"), "control: heading anchors follow GitHub's rule, repeats numbered");
ok(linksIn("```\n[x](a.md)\n```\n`[y](b.md)` [z](c.md)").map((l) => l.target).join() === "c.md", "control: links in fences and code spans are not read");
ok(classify(404) === "dead" && classify(410) === "dead" && classify(null, "getaddrinfo ENOTFOUND x") === "dead", "control: 404, 410 and an unresolvable host are dead");
ok(["unverified", "unverified", "unverified", "ok"].join() === [classify(403), classify(429), classify(null, "AbortError"), classify(200)].join(), "control: 403, 429 and a timeout are unverified, 200 ok");

// --- the real tree ---
const files = docFiles();
ok(files.includes("README.md") && files.includes("wiki/_Sidebar.md") && files.includes("docs/configuration.md") && files.includes("client/README.md") && files.some((f) => f.startsWith("adapters/")), `the check reads README, wiki, docs and the package READMEs (${files.length} files)`);
const real = internalProblems();
ok(real.length === 0, `no dead internal link in the repository's markdown${real.length ? `:\n  ${real.slice(0, 30).map((p) => `${p.file}:${p.line} ${p.target} (${p.why})`).join("\n  ")}` : ""}`);

// --- the external check is scheduled, not on push ---
const wf = readFileSync(join(ROOT, ".github/workflows/doc-links.yml"), "utf8");
ok(/\n  schedule:\n/.test(wf) && !/\n  (push|pull_request|pull_request_target):/.test(wf), "doc-links.yml runs on a schedule (and by hand), never on a push or pull request");
ok(/node scripts\/doc-links\.js --external/.test(wf) && /permissions:\n\s+contents: read/.test(wf), "it runs the external check with a read-only token");

console.log(`\ntest-doc-links: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
