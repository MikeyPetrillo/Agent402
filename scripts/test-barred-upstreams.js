// Barred data sources (src/barred-upstreams.js): a source whose terms bar
// commercial use of its data is not read, served, credited or described
// anywhere in this repository.
//   1. a scan of every tracked text file (code, ops scripts, docs, wiki,
//      package READMEs, the changelog) finds no barred host and no barred
//      name, and no tracked path names one (a logo or other asset);
//   2. the token tools that read one before are built on cleared sources:
//      no credit, no attribution export, no description, example or answer
//      names it, and each is cleared for resale;
//   3. CONTROLS: the pattern catches a host, a subdomain, a URL and the name,
//      and passes look-alikes.
//
//   node scripts/test-barred-upstreams.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);

const B = await import("../src/barred-upstreams.js");
const re = B.barredMentionPattern();
ok(B.BARRED_UPSTREAMS.length >= 1 && B.BARRED_UPSTREAMS.every((u) => u.name && u.hosts.length && u.reason && u.replacedBy), `each barred source names itself, its hosts, why and what replaced it (${B.BARRED_UPSTREAMS.length})`);

// ---- 3. controls first, so a pattern that matches nothing cannot pass -------
for (const s of ["https://api.gopluslabs.io/api/v1/token_security/1", "api.gopluslabs.io", "GoPlus token_security", "Powered by Go Plus", "go-plus", "GOPLUSLABS.IO"]) ok(re.test(s), `CONTROL: the pattern catches "${s}"`);
for (const s of ["algoplus", "goplusx", "notgopluslabs.io.example", "go plusher", "plus go"]) ok(!re.test(s), `CONTROL: the pattern passes "${s}"`);
{
  // Each host is read as literal text: a backslash or a metacharacter in a
  // host matches only itself.
  const lit = B.barredMentionPattern(["a\\d.example", "x+y.example"], ["nomatchname"]);
  ok(lit.test("a\\d.example") && !lit.test("a1.example") && !lit.test("a\\dxexample"), "CONTROL: a backslash in a host is matched literally, not as a class or escape");
  ok(lit.test("x+y.example") && !lit.test("xxy.example"), "CONTROL: a quantifier character in a host is matched literally");
  ok(B.barredMentionPattern().source === re.source, "the default lists are this file's own");
}
ok(B.isBarredUpstream("https://api.gopluslabs.io/x") && B.isBarredUpstream("gopluslabs.io") && !B.isBarredUpstream("https://evilgopluslabs.io") && !B.isBarredUpstream("not a url"), "the host check reads a URL's host and its subdomains only");

// ---- 1. the tracked tree ------------------------------------------------------
{
  const EXCUSED = new Set(["src/barred-upstreams.js", "scripts/test-barred-upstreams.js"]);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const pathHits = files.filter((f) => !EXCUSED.has(f) && re.test(f));
  ok(pathHits.length === 0, `no tracked path names a barred source (${pathHits.slice(0, 5).join(", ") || "none"})`);
  const TEXT = /\.(m?js|cjs|ts|json|md|txt|sh|ya?ml|html|svg|css|toml)$/i;
  const found = [];
  let scanned = 0;
  for (const f of files) {
    if (EXCUSED.has(f) || !TEXT.test(f) || /(^|\/)node_modules\//.test(f)) continue;
    let text;
    try { text = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    scanned++;
    if (!re.test(text)) continue;
    text.split("\n").forEach((line, i) => { if (re.test(line)) found.push(`${f}:${i + 1}`); });
  }
  ok(scanned > 1000, `the scan reads the tracked text files (${scanned})`);
  ok(found.length === 0, `no tracked file names a barred source (${found.slice(0, 8).join(", ") || "none"}; fix: read a cleared source, src/barred-upstreams.js says what replaced it)`);
}

// ---- 2. the tools that read one before ------------------------------------------
{
  const DA = await import("../src/data-attribution.js");
  const exported = Object.entries(DA).filter(([k, v]) => re.test(k) || (typeof v === "string" && re.test(v)) || (v && typeof v === "object" && re.test(JSON.stringify(v))));
  ok(exported.length === 0, `no attribution export names a barred source (${exported.map(([k]) => k).join(", ") || "none"})`);
  const { TOKEN_SAFETY_TOOLS } = await import("../src/tools/token-safety-kit.js");
  const { TOKEN_RISK_TOOLS } = await import("../src/tools/token-risk-kit.js");
  for (const t of [...TOKEN_SAFETY_TOOLS, ...TOKEN_RISK_TOOLS]) {
    const said = JSON.stringify({ d: t.description, n: t.name, c: t.credit ?? null, e: t.discovery?.output?.example, s: t.discovery?.inputSchema, l: t.creditLogo ?? null });
    ok(!re.test(said), `${t.slug}: no description, credit, logo or example names a barred source`);
    ok(t.resaleCleared === true && !t.creditLogo, `${t.slug}: cleared for resale on its computed sources, and carries no logo credit`);
  }
  // Each handler's source text reads no barred host.
  const kits = ["src/tools/token-facts.js", "src/tools/token-safety-kit.js", "src/tools/token-risk-kit.js"].map((f) => readFileSync(new URL(f, root), "utf8"));
  ok(kits.every((k) => !re.test(k)), "the token kits name no barred host or source");
}

console.log(`\ntest-barred-upstreams: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
