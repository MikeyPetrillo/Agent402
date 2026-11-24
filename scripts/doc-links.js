// Link check for the repository's markdown: README.md, CONTRIBUTING.md,
// llms-install.md, wiki/, docs/ and every package README.
//
//   node scripts/doc-links.js              internal links, offline: exit 1 on a dead one
//   node scripts/doc-links.js --external   also probes every external URL (the
//                                          scheduled doc-links.yml run, never a push)
//
// Internal (offline, no network):
//   - a relative link ([x](docs/configuration.md), [x](../CLA.md)) names a file
//     or directory that exists, and its #anchor a heading in that file;
//   - a same-file #anchor names a heading in the file;
//   - a wiki link ([[Page]], [[Label|Page]], or [x](Page) inside wiki/) names
//     a wiki page;
//   - a link into this repository on GitHub (blob/main/<path>, tree/main/<path>,
//     raw.githubusercontent.com/<repo>/main/<path>, or wiki/<Page>) names a path
//     or page the tree holds.
// External (--external): each http(s) URL outside this repository is fetched
// (HEAD, then GET when HEAD is refused), ten seconds each, four at a time. A
// 404 or 410, or a host that does not resolve, is dead and fails the run; a
// 401, 403, 405, 429, 5xx or timeout is listed as unverified (hosts that refuse
// automated clients answer that way) and does not fail it.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTags } from "./lib/html-text.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const REPO = "MikeyPetrillo/Agent402";

/** The markdown files the check reads, repo-relative. */
export function docFiles(root = ROOT) {
  const out = [];
  for (const f of ["README.md", "CONTRIBUTING.md", "llms-install.md", "SECURITY.md"]) if (existsSync(join(root, f))) out.push(f);
  const md = (dir) => { try { return readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`); } catch { return []; } };
  out.push(...md("wiki"), ...md("docs"));
  for (const pkg of ["mcp", "client", "tollbooth", "openclaw", "facilitator"]) if (existsSync(join(root, pkg, "README.md"))) out.push(`${pkg}/README.md`);
  try { for (const a of readdirSync(join(root, "adapters"))) if (existsSync(join(root, "adapters", a, "README.md"))) out.push(`adapters/${a}/README.md`); } catch { /* no adapters */ }
  return out;
}

// GitHub's heading anchor: lower case, punctuation other than - and _ dropped,
// spaces to hyphens; a repeated heading gets -1, -2.
export function headingSlugs(text) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of String(text).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = stripTags(m[1], "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "").trim().toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of String(text).matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

// Links in one markdown text, outside fenced code and inline code spans.
export function linksIn(text) {
  const links = [];
  let fence = false;
  String(text).split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
    for (const m of line.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) links.push({ kind: "wiki", target: (m[2] || m[1]).trim(), line: i + 1 });
    for (const m of line.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ kind: "md", target: m[1], line: i + 1 });
    for (const m of line.matchAll(/(?:href|src)="([^"]+)"/g)) links.push({ kind: "md", target: m[1], line: i + 1 });
    for (const m of line.matchAll(/(?<![(<"\w/])(https?:\/\/[^\s)<>"'`\]]+)/g)) links.push({ kind: "bare", target: m[1].replace(/[.,;:!?*]+$/, ""), line: i + 1 });
  });
  return links;
}

const wikiPage = (name) => String(name).trim().replace(/ /g, "-");
const GH = new RegExp(`^https://github\\.com/${REPO.replace("/", "\\/")}/(blob|tree)/main/([^?#]+)(#.*)?$`, "i");
const RAW = new RegExp(`^https://raw\\.githubusercontent\\.com/${REPO.replace("/", "\\/")}/main/([^?#]+)$`, "i");
const GHWIKI = new RegExp(`^https://github\\.com/${REPO.replace("/", "\\/")}/wiki/?([^?#]*)(#.*)?$`, "i");

/** Dead internal links: [{ file, line, target, why }]. */
export function internalProblems(root = ROOT, files = docFiles(root)) {
  const problems = [];
  const slugCache = new Map();
  const slugsOf = (rel) => {
    if (!slugCache.has(rel)) slugCache.set(rel, headingSlugs(readFileSync(join(root, rel), "utf8")));
    return slugCache.get(rel);
  };
  const wikiExists = (page) => !page || page === "Home" || existsSync(join(root, "wiki", `${wikiPage(page)}.md`));
  const checkAnchor = (file, rel, anchor, line, target) => {
    if (!anchor || !rel.endsWith(".md")) return;
    const a = decodeURIComponent(anchor.slice(1)).toLowerCase();
    if (/^L\d+/i.test(anchor.slice(1))) return;
    if (!slugsOf(rel).has(a)) problems.push({ file, line, target, why: `no heading #${a} in ${rel}` });
  };
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const inWiki = file.startsWith("wiki/");
    for (const { kind, target, line } of linksIn(text)) {
      if (kind === "wiki") {
        if (!wikiExists(target)) problems.push({ file, line, target, why: `no wiki page wiki/${wikiPage(target)}.md` });
        continue;
      }
      let m;
      if ((m = GH.exec(target))) {
        const rel = decodeURIComponent(m[2]).replace(/\/+$/, "");
        if (!existsSync(join(root, rel))) problems.push({ file, line, target, why: `no ${rel} in the tree` });
        else if (m[3]) checkAnchor(file, rel, m[3], line, target);
        continue;
      }
      if ((m = RAW.exec(target))) {
        if (!existsSync(join(root, decodeURIComponent(m[1])))) problems.push({ file, line, target, why: `no ${m[1]} in the tree` });
        continue;
      }
      if ((m = GHWIKI.exec(target))) {
        if (!wikiExists(decodeURIComponent(m[1]))) problems.push({ file, line, target, why: `no wiki page wiki/${m[1]}.md` });
        else if (m[2] && m[1]) checkAnchor(file, `wiki/${wikiPage(decodeURIComponent(m[1]))}.md`, m[2], line, target);
        continue;
      }
      if (kind === "bare" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      if (target.startsWith("#")) { checkAnchor(file, file, target, line, target); continue; }
      if (target.startsWith("/")) continue; // a site path on the hosted origin, not a repo file
      const [pathPart, hash] = target.split(/(?=#)/);
      const clean = decodeURIComponent(pathPart.split("?")[0]);
      if (inWiki && !clean.includes("/") && !clean.includes(".")) {
        if (!wikiExists(clean)) problems.push({ file, line, target, why: `no wiki page wiki/${wikiPage(clean)}.md` });
        else if (hash) checkAnchor(file, `wiki/${wikiPage(clean)}.md`, hash, line, target);
        continue;
      }
      const abs = resolve(join(root, dirname(file)), clean);
      const rel = relative(root, abs);
      if (rel.startsWith("..") || !existsSync(abs)) { problems.push({ file, line, target, why: `no ${rel} in the tree` }); continue; }
      if (hash && statSync(abs).isFile()) checkAnchor(file, rel, hash, line, target);
    }
  }
  return problems;
}

// Hosts that are examples, placeholders or API bases rather than pages.
const SKIP_HOST = /(^|\.)(example\.(com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0|your-[\w-]+\.[\w.]+|[\w-]+\.example|[\w-]+\.internal)$/i;

/** External URLs the files name, deduplicated, with where each appears. */
export function externalUrls(root = ROOT, files = docFiles(root)) {
  const urls = new Map();
  for (const file of files) {
    for (const { target, line } of linksIn(readFileSync(join(root, file), "utf8"))) {
      if (!/^https?:\/\//i.test(target) || GH.test(target) || RAW.test(target) || GHWIKI.test(target)) continue;
      let host;
      try { host = new URL(target).hostname; } catch { continue; }
      if (SKIP_HOST.test(host) || /[<>{}$]|\.\.\.|…/.test(target)) continue;
      if (!urls.has(target)) urls.set(target, []);
      urls.get(target).push(`${file}:${line}`);
    }
  }
  return urls;
}

export function classify(status, error) {
  if (error) return /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error) ? "dead" : "unverified";
  if (status === 404 || status === 410) return "dead";
  if (status >= 200 && status < 400) return "ok";
  return "unverified";
}

async function probe(url) {
  const once = async (method) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const r = await fetch(url, { method, redirect: "follow", signal: ac.signal, headers: { "user-agent": "agent402-doc-links (+https://github.com/MikeyPetrillo/Agent402)" } });
      return { status: r.status };
    } catch (e) { return { error: String(e?.cause?.code || e?.cause?.message || e?.message || e) }; }
    finally { clearTimeout(t); }
  };
  let r = await once("HEAD");
  if (r.error || r.status === 405 || r.status === 403 || r.status === 404 || r.status >= 500) r = await once("GET");
  return r;
}

async function main() {
  const problems = internalProblems();
  for (const p of problems) console.error(`dead internal link ${p.file}:${p.line} ${p.target} (${p.why})`);
  console.log(`internal links: ${problems.length} dead across ${docFiles().length} files`);
  let failed = problems.length > 0;
  if (process.argv.includes("--external")) {
    const urls = [...externalUrls()];
    const results = [];
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < urls.length) {
        const [url, where] = urls[i++];
        const r = await probe(url);
        results.push({ url, where, ...r, verdict: classify(r.status, r.error) });
      }
    }));
    const dead = results.filter((r) => r.verdict === "dead");
    const unverified = results.filter((r) => r.verdict === "unverified");
    for (const r of dead) console.error(`dead external link ${r.url} (${r.status ?? r.error}) in ${r.where.slice(0, 3).join(", ")}`);
    for (const r of unverified) console.log(`unverified ${r.url} (${r.status ?? r.error})`);
    console.log(`external links: ${results.length} read, ${dead.length} dead, ${unverified.length} unverified`);
    if (dead.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
