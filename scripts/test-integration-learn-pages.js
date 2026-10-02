#!/usr/bin/env node
// /integrations/<package>, /learn, /learn/<term> and /llms-full.txt.
//
//   node scripts/test-integration-learn-pages.js
//
// Boots FREE_MODE on an OS-assigned port and asserts, for every page the two
// modules declare (so a new entry is covered with no edit here):
//   - 200 text/html, a unique <title>, exactly one <h1>, a canonical equal to
//     BASE_URL + path, a BreadcrumbList in the JSON-LD;
//   - the URL is listed in /sitemap-learn.xml AND in the /sitemap.xml monolith
//     (the one scripts/indexnow-submit.js reads), and the sub-sitemap is in
//     the sitemap index;
//   - integration pages link at least four live tool pages, their npm/PyPI
//     package and their GitHub source, and the /integrations hub links each;
//   - each learn page carries a DefinedTerm and 300-600 words of prose, and
//     the glossary links it;
//   - /llms-full.txt lists every route /api/pricing publishes and every learn
//     summary, and /llms.txt links /llms-full.txt.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { INTEGRATIONS } from "../src/integration-pages.js";
import { LEARN } from "../src/learn.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
const BASE_URL = "https://agent402.tools";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", BASE_URL },
  stdio: "ignore",
});

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  if (!up) throw new Error("server did not come up within 60 s");

  const text = async (p) => { const r = await fetch(B + p); return { status: r.status, type: r.headers.get("content-type") || "", body: await r.text() }; };
  const sub = await text("/sitemap-learn.xml");
  const mono = await text("/sitemap.xml");
  const index = await text("/sitemapindex.xml");
  ok(sub.status === 200 && /<urlset/.test(sub.body), "/sitemap-learn.xml serves a urlset");
  ok(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sub.body), "/sitemap-learn.xml carries lastmod");
  ok(index.body.includes(`${BASE_URL}/sitemap-learn.xml`), "sitemap index lists sitemap-learn.xml");

  const pages = [
    "/learn",
    ...LEARN.map((l) => `/learn/${l.slug}`),
    ...INTEGRATIONS.map((i) => `/integrations/${i.slug}`),
  ];
  const titles = new Map();
  for (const path of pages) {
    const r = await text(path);
    ok(r.status === 200 && r.type.includes("text/html"), `${path}: 200 text/html`);
    const title = (r.body.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    ok(title.length > 10, `${path}: has a title (${title})`);
    ok(!titles.has(title), `${path}: title is unique${titles.has(title) ? ` (also ${titles.get(title)})` : ""}`);
    titles.set(title, path);
    ok((r.body.match(/<h1[\s>]/g) || []).length === 1, `${path}: exactly one <h1>`);
    ok(r.body.includes(`<link rel="canonical" href="${BASE_URL}${path}">`), `${path}: canonical is ${BASE_URL}${path}`);
    ok(/"@type":"BreadcrumbList"/.test(r.body), `${path}: BreadcrumbList JSON-LD`);
    ok(sub.body.includes(`<loc>${BASE_URL}${path}</loc>`), `${path}: in /sitemap-learn.xml`);
    ok(mono.body.includes(`<loc>${BASE_URL}${path}</loc>`), `${path}: in /sitemap.xml (read by indexnow-submit)`);
  }

  const hub = (await text("/integrations")).body;
  for (const i of INTEGRATIONS) {
    const body = (await text(`/integrations/${i.slug}`)).body;
    const main = body.split("<main>")[1] || "";
    const toolLinks = new Set([...main.matchAll(/href="\/tools\/([^"]+)"/g)].map((m) => m[1]));
    ok(toolLinks.size >= 4, `/integrations/${i.slug}: links ${toolLinks.size} tool pages (>= 4)`);
    for (const slug of toolLinks) {
      const r = await fetch(`${B}/tools/${slug}`);
      ok(r.status === 200, `/integrations/${i.slug}: /tools/${slug} resolves`);
    }
    const registry = i.registry === "pypi" ? `https://pypi.org/project/${i.pkg}/` : `https://www.npmjs.com/package/${i.pkg}`;
    ok(main.includes(registry), `/integrations/${i.slug}: links its package (${registry})`);
    ok(main.includes(`/tree/main/${i.dir}`), `/integrations/${i.slug}: links its GitHub source`);
    ok(/"@type":"SoftwareSourceCode"/.test(body), `/integrations/${i.slug}: SoftwareSourceCode JSON-LD`);
    ok(main.includes(i.install.replace(/"/g, "&quot;")), `/integrations/${i.slug}: shows its install line`);
    ok(hub.includes(`href="/integrations/${i.slug}"`), `/integrations links /integrations/${i.slug}`);
  }

  const glossary = (await text("/glossary")).body;
  for (const l of LEARN) {
    const body = (await text(`/learn/${l.slug}`)).body;
    ok(/"@type":"DefinedTerm"/.test(body), `/learn/${l.slug}: DefinedTerm JSON-LD`);
    const prose = (body.split("<main>")[1] || "").split("<footer")[0]
      .replace(/<nav[\s\S]*?<\/nav>/, "").replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");
    const words = prose.split(/\s+/).filter(Boolean).length;
    ok(words >= 300 && words <= 650, `/learn/${l.slug}: ${words} words of prose (300-600 plus the related list)`);
    ok(/<pre>/.test(body), `/learn/${l.slug}: carries a worked example`);
    ok(glossary.includes(`href="/learn/${l.slug}"`), `/glossary links /learn/${l.slug}`);
  }

  const full = await text("/llms-full.txt");
  ok(full.status === 200 && full.type.includes("text/plain"), "/llms-full.txt: 200 text/plain");
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const endpoints = pricing.endpoints || [];
  ok(endpoints.length >= 400, `/api/pricing publishes ${endpoints.length} routes`);
  const missing = endpoints.filter((e) => !full.body.includes(` | ${e.method} ${e.path} | `));
  ok(missing.length === 0, `/llms-full.txt lists every catalog route${missing.length ? ` (missing ${missing.slice(0, 5).map((e) => `${e.method} ${e.path}`).join(", ")})` : ""}`);
  for (const l of LEARN) ok(full.body.includes(l.summary), `/llms-full.txt carries the ${l.slug} summary`);
  const llms = (await text("/llms.txt")).body;
  ok(llms.includes(`${BASE_URL}/llms-full.txt`), "/llms.txt links /llms-full.txt");
  ok(full.body.startsWith(llms.trimEnd().split("\n")[0]), "/llms-full.txt opens with the /llms.txt content");

  const guide = (await text("/guides/agent-hosts")).body;
  ok(/href="\/integrations\/[a-z-]+"/.test(guide), "/guides/agent-hosts links an integration page");

  ok((await fetch(`${B}/integrations/not-a-package`)).status === 404, "unknown integration slug is a 404");
  ok((await fetch(`${B}/learn/not-a-term`)).status === 404, "unknown learn slug is a 404");
} catch (e) {
  fail++;
  console.error("FAIL -", e.message);
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
