// Reader searches find the article extractor through its aliases (demand board,
// 2026-10-31), against the real catalog on a booted free-mode server, on both
// /api/find and /api/route; the neighboring tools keep their own searches, and
// a search to clean up a piece of text (no page, no URL) does not go to the
// extractor, which fetches a URL.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await getFreePort();
const out = [];
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { out.push(String(c)); if (out.length > 200) out.shift(); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* not listening yet */ }
    if (!up) await sleep(500);
  }
  ok(up, "server booted");
  if (!up) { console.log(out.join("").slice(-3000)); throw new Error("server did not boot"); }
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
} finally {
  proc.kill();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
