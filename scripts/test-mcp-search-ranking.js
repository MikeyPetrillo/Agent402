// Smoke test for the MCP search_tools ranker against the *live* catalog.
//
// test-find-ranking.js locks the HTTP /api/find ranker on natural-language
// agent queries. The MCP connector's `search_tools` tool is a separate ranker
// (src/mcp-http.js:60 — slug-exact / slug-includes / hay-includes, simpler than
// findTools), and it's the surface most directory-installed clients (Claude
// Desktop, Cursor, Smithery, mcp.so installs) hit first. A drift in this
// ranker degrades discoverability for those clients silently, even when
// /api/find still looks fine.
//
// This test boots a FREE_MODE server, drives the MCP endpoint over JSON-RPC,
// and locks top-1 (or top-N) slugs for a curated set of phrasings. If a
// ranking change quietly demotes the obvious tool, this will tell you before
// an MCP client does.
//
//   node scripts/test-mcp-search-ranking.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (ct === "text/event-stream") {
    const text = await res.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// top1: the slug an MCP client would obviously expect at rank 1 for this query.
// topN: a looser lock — the slug must appear in the top N. search_tools has no
// directional tiebreak (unlike findTools), so symmetric convert pairs go in
// TOPN rather than TOP1.
const TOP1 = [
  ["qr code",                       "qr"],
  ["whois lookup",                  "whois"],
  ["geocode address",                "geocode"],
  ["validate email",                "email-validate"],
  ["stock quote",                   "stock-quote"],
  ["weather forecast",              "weather-forecast"],
  ["jwt decode",                    "jwt-decode"],
  ["image ocr",                     "image-ocr"],
  ["generate uuid",                  "uuid"],
  ["spf check",                     "spf-check"],
  ["earthquakes",                   "earthquakes"],
];

const TOPN = [
  // `pdf` slug-exact-matches the "pdf" token (+10) and outranks `pdf-info` for
  // any "pdf <qualifier>" query — that's the simple ranker correctly preferring
  // the umbrella slug. Just lock that pdf-info is *visible* for the extractor
  // query, since it's the right answer for that intent.
  ["pdf metadata",                  "pdf-info", 5],
  // search_tools ties on slug-includes score for symmetric pairs (no directional
  // tiebreak, unlike findTools — see test-find-ranking.js for the HTTP-ranker
  // lock). Top-N is the honest contract here: both directions must be visible
  // in the top K so a client can pick by intent.
  ["convert kilometers to miles",   "convert-kilometers-to-miles", 5],
  ["convert miles to kilometers",   "convert-miles-to-kilometers", 5],
  ["html to markdown",              "html-to-markdown", 3],
  ["markdown to html",              "markdown-to-html", 3],
];

const searchSlugs = async (query, limit = 5) => {
  const r = await rpc("tools/call", { name: "search_tools", arguments: { query, limit } });
  if (r.result?.isError) throw new Error(`search_tools "${query}" returned isError: ${r.result?.content?.[0]?.text ?? ""}`);
  const text = r.result?.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return (parsed.results || []).map((x) => x.slug);
  } catch {
    // No-match returns a plain-text "No tools matched …" string — surface as empty.
    return [];
  }
};

try {
  // Boot wait — server initializes the catalog + free-slug set before /mcp is useful.
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Sanity: MCP surface is up and the connector exposes search_tools.
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-mcp-search-ranking", version: "0.0.0" },
  });
  ok(init.result?.serverInfo?.name === "agent402", `initialize returns serverInfo.name=agent402`);

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  ok(names.includes("search_tools"), `tools/list exposes search_tools (got ${names.join(",")})`);

  for (const [q, expected] of TOP1) {
    const found = await searchSlugs(q, 3);
    ok(found[0] === expected, `mcp top-1 for "${q}" is ${expected} (got ${found.join(",") || "none"})`);
  }
  for (const [q, expected, k] of TOPN) {
    const found = await searchSlugs(q, k);
    ok(found.includes(expected), `mcp top-${k} for "${q}" includes ${expected} (got ${found.join(",") || "none"})`);
  }

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
