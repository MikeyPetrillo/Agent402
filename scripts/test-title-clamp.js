#!/usr/bin/env node
// No served page needs its <title> clamped. src/seo-meta.js cuts a title past
// META_TITLE_MAX at a separator or a word, which keeps the tag inside the
// bar but serves a sentence cut short: /marketplace read "... tool count,
// network and" in search results for weeks because its source title was one
// character over and every length check looked at the served tag, which
// passed. The shell records each clamp (clampedTitles), the operator route
// /__operator/seo-meta.json lists them, and this test renders every HTML page
// in the sitemap on a booted server and fails when the list is not empty:
// the fix is a shorter source title, never a looser clamp.
//
//   node scripts/test-title-clamp.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { metaTitle, clampedTitles, META_TITLE_MAX } from "../src/seo-meta.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the registry itself ------------------------------------------------------------
{
  const short = "Pricing - Agent402";
  metaTitle(short);
  ok(!clampedTitles.has(short), "a title within the bar is not recorded");
  const long = `${"word ".repeat(20).trim()} - Agent402 marketplace of x402 sellers`;
  const served = metaTitle(long);
  ok(served.length <= META_TITLE_MAX && clampedTitles.get(long) === served, "a clamped title is recorded as source -> served");
  metaTitle(long);
  ok(clampedTitles.size === 1, "the same source is recorded once");
  clampedTitles.clear();
}

// --- every sitemap page on a booted server ------------------------------------------
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "title-clamp-test-token";
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", AGENT402_OPERATOR_TOKEN: TOKEN },
  stdio: "ignore",
});
try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "server booted");
  const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const machine = /^\/(api|\.well-known)\/|\.(json|txt|md|xml)$/;
  const paths = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname + new URL(m[1]).search))].filter((p) => !machine.test(p));
  ok(paths.length >= 400, `sitemap lists the HTML pages to render (${paths.length})`);
  const statuses = new Map();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      try {
        const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
        await r.arrayBuffer();
        statuses.set(p, r.status);
      } catch (e) { statuses.set(p, `error ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const notOk = [...statuses].filter(([, s]) => s !== 200);
  ok(notOk.length === 0, `every sitemap page renders 200 (${statuses.size} pages${notOk.length ? `; not 200: ${notOk.slice(0, 5).map(([p, s]) => `${p} ${s}`).join(", ")}` : ""})`);
  const anon = await fetch(`${BASE}/__operator/seo-meta.json`);
  ok(anon.status === 404, `the clamp list is operator-only (anonymous read: ${anon.status})`);
  const r = await fetch(`${BASE}/__operator/seo-meta.json`, { headers: { "x-operator-token": TOKEN } });
  const j = r.status === 200 ? await r.json() : null;
  ok(j && j.titleMax === META_TITLE_MAX && Array.isArray(j.clampedTitles), `operator route answers (${r.status})`);
  const clamped = (j && j.clampedTitles) || [];
  ok(clamped.length === 0, clamped.length
    ? `${clamped.length} served title(s) were clamped; shorten the source:\n${clamped.map((c) => `  "${c.source}" (${c.source.length}) -> "${c.served}"`).join("\n")}`
    : `no served title needed the ${META_TITLE_MAX}-character clamp across ${statuses.size} pages`);
} catch (e) {
  ok(false, e.message);
} finally {
  proc.kill("SIGKILL");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
