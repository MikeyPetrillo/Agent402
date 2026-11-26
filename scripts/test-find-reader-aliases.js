// Reader searches find the article extractor through its aliases (demand board,
// 2026-10-31), against the real catalog on a booted free-mode server, on both
// /api/find and /api/route; the neighboring tools keep their own searches, and
// a search to clean up a piece of text (no page, no URL) does not go to the
// extractor, which fetches a URL. "readclean" (demand board, 2026-11-26)
// reaches the extractor on /api/find, MCP catalog.find and catalog.search
// through the find synonym table, strongly enough that the demand board reads
// it served; its words split ("read", "clean") stay other tools' searches.
// The same table sends junk in a text or a log to the text hygiene pack on all
// three surfaces; "junk" with no text or log beside it, a build log to triage
// and the line deduper's own search keep their tools.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { WISH_SERVED_MIN_SCORE } from "../src/wish.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Port 0, read back from the listening line (scripts/lib/boot-server.js); its own stores.
const srv = await bootServer({ stores: "find-aliases", env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
const proc = srv.child;
const base = srv.url;
try {
  ok(true, "server booted");
  const findTop = async (q) => (await (await fetch(`${base}/api/find?q=${encodeURIComponent(q)}&k=3`)).json()).results?.[0]?.slug;
  const routeTop = async (q) => (await (await fetch(`${base}/api/route?q=${encodeURIComponent(q)}&include=local&top=3`)).json()).results?.[0]?.slug;
  for (const q of ["reader mode", "clean readable text from a web page", "page to markdown", "readable text"]) {
    const f = await findTop(q), r = await routeTop(q);
    ok(f === "extract", `find "${q}" -> extract (got ${f})`);
    ok(r === "extract", `route "${q}" -> extract (got ${r})`);
  }
  for (const [q, want] of [["html to markdown", "html-to-markdown"], ["pdf to markdown", "pdf-to-markdown"], ["watch a url for changes", "page-change"], ["extract article text from url", "extract"]]) {
    const s = await findTop(q);
    ok(s === want, `find "${q}" -> ${want} (got ${s})`);
  }
  for (const q of ["clean text", "clean up text whitespace"]) {
    const f = await findTop(q), r = await routeTop(q);
    ok(f !== "extract", `find "${q}" does not go to the URL extractor (got ${f})`);
    ok(r !== "extract", `route "${q}" does not go to the URL extractor (got ${r})`);
  }
  // "readclean": one word, any case, first on /api/find with no miss hint,
  // at or over the score the demand board reads as served.
  for (const q of ["readclean", "ReadClean", "readclean https://example.com/post"]) {
    const j = await (await fetch(`${base}/api/find?q=${encodeURIComponent(q)}&k=3`)).json();
    const top = j.results?.[0];
    ok(top?.slug === "extract", `find "${q}" -> extract (got ${top?.slug})`);
    ok(!j.hint, `find "${q}" is not a miss (hint ${j.hint})`);
    ok(top?.score >= WISH_SERVED_MIN_SCORE, `find "${q}" scores ${top?.score} >= the served bar ${WISH_SERVED_MIN_SCORE}`);
  }
  // The split words are not the reader: each keeps the tool it had.
  for (const [q, want] of [["readability", "readability"], ["clean up and read json", "json-repair"], ["read clean text from pdf", "pdf"]]) {
    const s = await findTop(q);
    ok(s === want, `find "${q}" -> ${want} (got ${s})`);
  }
  // The MCP connector: catalog.find (findTools) and catalog.search (its own ranker).
  let id = 1;
  const rpc = async (method, params) => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
    const text = await res.text();
    return (res.headers.get("content-type") || "").startsWith("text/event-stream") ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")) : JSON.parse(text);
  };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-find-reader-aliases", version: "0.0.0" } });
  const mcpTop = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    try { return JSON.parse(r.result?.content?.[0]?.text ?? "").results?.[0]?.slug; } catch { return undefined; }
  };
  for (const q of ["readclean", "ReadClean"]) {
    const f = await mcpTop("catalog.find", { task: q, limit: 3 });
    ok(f === "extract", `mcp catalog.find "${q}" -> extract (got ${f})`);
    const s = await mcpTop("catalog.search", { query: q, limit: 3 });
    ok(s === "extract", `mcp catalog.search "${q}" -> extract (got ${s})`);
  }
  // Controls on catalog.search: an unrelated query and a synonym the table already held.
  for (const [q, want] of [["readability", "readability"], ["calculator", "calc"], ["base64", "base64"]]) {
    const s = await mcpTop("catalog.search", { query: q, limit: 3 });
    ok(s === want, `mcp catalog.search "${q}" -> ${want} (got ${s})`);
  }
  // Junk in a text or a log: the text hygiene pack, on catalog.find and catalog.search.
  for (const q of ["clean up log file, remove junk from text", "clean up a log file and drop junk lines"]) {
    const f = await mcpTop("catalog.find", { task: q, limit: 3 });
    ok(f === "skill-text-hygiene", `mcp catalog.find "${q}" -> skill-text-hygiene (got ${f})`);
    const s = await mcpTop("catalog.search", { query: q, limit: 3 });
    ok(s === "skill-text-hygiene", `mcp catalog.search "${q}" -> skill-text-hygiene (got ${s})`);
  }
  for (const [q, want] of [["triage a failing build log", "build-log-triage"], ["dedupe lines", "dedupe-lines"], ["junk email check", "email-deliverability"], ["hash string or text for integrity verification", "hash"], ["verify x402 payment", "x402-verify"], ["parse and normalize timestamps from various formats including unix epoch", "log-timestamps"]]) {
    const s = await findTop(q);
    ok(s === want, `find "${q}" -> ${want} (got ${s})`);
    const f = await mcpTop("catalog.find", { task: q, limit: 3 });
    ok(f === want, `mcp catalog.find "${q}" -> ${want} (got ${f})`);
  }
} finally {
  proc.kill();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
