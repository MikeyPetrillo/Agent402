// Reader searches find the article extractor through its aliases (demand board,
// 2026-10-31), against the real catalog on a booted free-mode server, and the
// neighbouring tools keep their own searches.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
  stdio: ["ignore", "ignore", "ignore"],
});
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
  ok(up, "server booted");
  const top = async (q) => (await (await fetch(`${base}/api/find?q=${encodeURIComponent(q)}&k=3`)).json()).results?.[0]?.slug;
  for (const q of ["reader mode", "clean readable text from a web page", "page to markdown", "readable text"]) {
    const s = await top(q);
    ok(s === "extract", `"${q}" -> extract (got ${s})`);
  }
  for (const [q, want] of [["html to markdown", "html-to-markdown"], ["pdf to markdown", "pdf-to-markdown"], ["watch a url for changes", "page-change"], ["extract article text from url", "extract"]]) {
    const s = await top(q);
    ok(s === want, `"${q}" -> ${want} (got ${s})`);
  }
} finally {
  proc.kill();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
