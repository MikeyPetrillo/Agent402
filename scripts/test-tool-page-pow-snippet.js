// Every GET tool page that offers the free tier publishes a proof-of-work
// snippet: fetch a challenge, solve it, send the tool request with
// X-Pow-Solution. The snippet's request used to be `${path}` with no query
// string, so the documented input never reached the tool: a tool with a
// required field (qr, timezone-convert, date-format, seller-trust, mime,
// country-info ...) answered 400, and the gate had already spent the token.
//
// This boots the paid-mode server (paywall and PoW gate on, as
// test-pow-solve-roundtrip.js does), reads each GET PoW tool's own page,
// extracts the URL its snippet fetches, solves a real challenge and sends
// exactly that request. Every one must answer 200.
//
//   node scripts/test-tool-page-pow-snippet.js
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { getFreePort } from "./lib/free-port.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); if (proc) proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; if (process.env.VERBOSE) console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
function solve(challenge, difficulty) {
  for (let n = 0; n < 5_000_000; n++) {
    if (leadingZeroBits(createHash("sha256").update(challenge + ":" + n).digest()) >= difficulty) return n;
  }
  throw new Error("solver gave up");
}

const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "a402-pow-snippet-"));
proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network",
    X402_SYNC_ON_START: "false",
    X402_INDEX_CRAWL: "off",
    X402_ECONOMY_DB: join(scratch, "economy.db"),
    POW_DIFFICULTY: "8",
    BASE_URL: BASE,
    PORT: String(PORT),
    FREE_MODE: "",
    AGENT402_MCP_MAX_PER_MIN: "999999",
  },
  stdio: process.env.VERBOSE ? "inherit" : "ignore",
});

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "paid-mode server booted");

  const pow = await (await fetch(`${BASE}/api/pow`)).json();
  const powSlugs = new Set(pow.eligibleTools || []);
  ok(powSlugs.size > 50, `PoW-eligible slug list read (${powSlugs.size})`);
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const list = (pricing.endpoints || pricing.tools || []).filter((t) => t.slug && t.method === "GET" && powSlugs.has(t.slug));
  ok(list.length >= 10, `GET PoW tools found (${list.length})`);

  const withQuery = [];
  for (const t of list) {
    const html = await (await fetch(`${BASE}/tools/${t.slug}`)).text();
    const m = html.match(/await fetch\(&quot;([^&]*(?:&amp;[^&]*)*?)&quot;, \{ method: &quot;GET&quot;, headers: \{ &quot;X-Pow-Solution&quot;/);
    ok(!!m, `/tools/${t.slug}: page carries a GET proof-of-work snippet`);
    const url = decode(m[1]);
    ok(url.startsWith(`${BASE}${t.path}`), `/tools/${t.slug}: snippet targets the tool path (${url})`);
    if (url.includes("?")) withQuery.push(t.slug);

    const c = await (await fetch(`${BASE}/api/pow/challenge?slug=${encodeURIComponent(t.slug)}`)).json();
    const n = solve(c.challenge, c.difficulty);
    const r = await fetch(url, { method: "GET", headers: { "X-Pow-Solution": c.token + ":" + n } });
    const body = await r.text();
    ok(r.status === 200, `/tools/${t.slug}: the published snippet request answers 200 (got ${r.status}: ${body.slice(0, 160)})`);
  }
  // The tools named when the defect was found all take required input.
  for (const slug of ["qr", "timezone-convert", "date-format", "seller-trust", "mime", "country-info"]) {
    if (list.some((t) => t.slug === slug)) ok(withQuery.includes(slug), `/tools/${slug}: snippet sends the documented input as a query string`);
  }

  console.log(`\n${pass} passed (${list.length} GET proof-of-work snippets sent)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.stack || e.message);
}
