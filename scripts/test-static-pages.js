// Static, server-rendered HTML surfaces: /privacy, /terms, /economy, /shop,
// /leaderboard, /index, /tools, /skills, /. These are the human-readable
// counterparts to the JSON discovery surfaces — listing portals link to them,
// Google indexes them, and a /privacy or /terms 500 silently breaks the
// "site is up" perception even when every API is fine.
//
// A render-time regression in any one page handler (e.g., a NaN in
// economyPage, an undefined snapshot field in leaderboardPage) returns 500
// in a way that the API-only health probe never sees. This smoke test boots
// FREE_MODE and asserts each page:
//
//   1. Returns 200 with text/html.
//   2. Has a non-trivial body length (a blank 200 is a regression too).
//   3. Carries a page-specific anchor string in the title — so a future
//      change that silently swaps two handlers (e.g., /terms returning the
//      shop page) surfaces here instead of in production.
//
//   node scripts/test-static-pages.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3089;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each page is keyed by its path with the anchor string we expect to find
// inside the served <title>. The anchor proves we got the right handler;
// a 200 with a wrong-but-valid HTML body would pass a content-type check.
const PAGES = [
  { path: "/privacy",     titleSubstr: "Privacy" },
  { path: "/terms",       titleSubstr: "Terms" },
  { path: "/economy",     titleSubstr: "economy" },
  { path: "/shop",        titleSubstr: "shop" },
  { path: "/leaderboard", titleSubstr: "Leaderboard" },
  { path: "/index",       titleSubstr: "Index" },
  { path: "/tools",       titleSubstr: "Catalog" },
  { path: "/skills",      titleSubstr: "skill" },
  { path: "/",            titleSubstr: "Agent402" },
];

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  for (const { path, titleSubstr } of PAGES) {
    const res = await fetch(`${BASE}${path}`);
    ok(res.status === 200, `${path} → 200 (got ${res.status})`);
    const ct = res.headers.get("content-type") || "";
    ok(ct.includes("text/html"), `${path} content-type is text/html (got ${ct})`);
    const body = await res.text();
    // 1KB floor — every page in this set carries a layout shell, head, nav,
    // and substantial content; a blank-template regression renders well
    // under this.
    ok(body.length >= 1024, `${path} body is non-trivial (got ${body.length} bytes)`);
    // Anchor lookup is case-insensitive so a future title rephrase doesn't
    // flake the test, but the anchor itself is specific enough that two
    // pages can't both match it.
    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    ok(titleMatch != null, `${path} has a <title> tag`);
    const title = titleMatch?.[1] ?? "";
    ok(title.toLowerCase().includes(titleSubstr.toLowerCase()), `${path} title contains '${titleSubstr}' (got '${title}')`);
  }

  console.log(`\n${pass} passed (${PAGES.length} pages)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
