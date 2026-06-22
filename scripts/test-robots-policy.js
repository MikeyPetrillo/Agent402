// /robots.txt encodes Agent402's pay-per-crawl posture: every major LLM
// crawler is *explicitly* allowed (because the catalog is FOR them), the
// wallet-keyed memory namespace is disallowed (because /api/memory rows are
// per-owner and shouldn't appear in search results), and the sitemap is
// pinned so crawlers can find every tool page + skill pack.
//
// A regression here is a regression in posture: a wildcard-block
// inadvertently shadowing the bot allowlist, or the sitemap reference
// silently dropped, would meaningfully change how the host is crawled. There
// is no contract test today.
//
// This test boots FREE_MODE and locks:
//
//   1. Content-type is text/plain (otherwise crawlers don't trust it).
//   2. Every documented LLM crawler UA has its own `User-agent` block and an
//      explicit `Allow: /`. The catalog exists for these agents — letting
//      one silently slip through to the wildcard rule is a regression.
//   3. `User-agent: *` carries `Disallow: /api/memory` (per-wallet rows
//      shouldn't appear in third-party search results).
//   4. The sitemap reference points at /sitemap.xml on the same origin.
//   5. The machine-readable catalogs hint is present (so a crawler that
//      reads robots.txt knows where to look next).
//
//   node scripts/test-robots-policy.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3085;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/robots.txt`);
  ok(res.status === 200, `/robots.txt → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("text/plain"), `content-type is text/plain (got ${res.headers.get("content-type")})`);
  const txt = await res.text();

  // Every documented LLM crawler. If one of these silently drops, the catalog
  // is invisible to that crawler — losing reach to a sizable audience.
  const LLM_BOTS = [
    "GPTBot",         // OpenAI
    "OAI-SearchBot",  // OpenAI search
    "ChatGPT-User",   // ChatGPT user-triggered
    "ClaudeBot",      // Anthropic
    "anthropic-ai",   // Anthropic
    "PerplexityBot",  // Perplexity
    "Google-Extended",// Gemini training
    "Applebot-Extended", // Apple Intelligence
    "CCBot",          // Common Crawl (LLM training data)
    "Bytespider",     // ByteDance / Doubao
    "Amazonbot",      // Amazon
    "cohere-ai",      // Cohere
    "Meta-ExternalAgent", // Meta AI
  ];

  // Each bot must get its own User-agent block (not fall through to *) AND
  // carry an explicit Allow: /. We assert both: a block exists AND the line
  // immediately after the block is permissive.
  for (const bot of LLM_BOTS) {
    const re = new RegExp(`User-agent:\\s*${bot}\\s*\\n\\s*Allow:\\s*/`, "i");
    ok(re.test(txt), `robots.txt explicitly Allows ${bot} (own UA block + Allow: /)`);
  }

  // Wildcard block — present, and disallows the wallet-keyed memory route.
  // A regression that drops the wildcard block entirely would surface here
  // (no Disallow at all). A regression that broadens the Disallow to /api
  // would also break the test (we'd see Disallow: /api alone).
  ok(/User-agent:\s*\*[\s\S]*?Allow:\s*\//.test(txt), "robots.txt has wildcard User-agent: * with Allow: /");
  ok(/Disallow:\s*\/api\/memory/.test(txt), "robots.txt Disallows /api/memory (wallet-keyed rows shouldn't appear in third-party search)");
  // Sanity: the Disallow is /api/memory specifically — not all of /api.
  ok(!/Disallow:\s*\/api\s*$/m.test(txt), "robots.txt does NOT disallow all of /api (that would block catalog discovery)");

  // Sitemap reference — same origin, points at /sitemap.xml.
  ok(txt.includes(`Sitemap: ${BASE}/sitemap.xml`), `robots.txt references Sitemap: ${BASE}/sitemap.xml`);

  // Machine-readable catalogs hint — robots.txt advertises the orientation
  // surfaces a crawler should read next (llms.txt, openapi.json, etc).
  ok(txt.includes("/llms.txt") && txt.includes("/openapi.json"), "robots.txt advertises /llms.txt + /openapi.json as machine-readable catalogs");

  console.log(`\n${pass} passed (${LLM_BOTS.length} LLM bots explicitly allowed)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
