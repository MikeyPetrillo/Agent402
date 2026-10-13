#!/usr/bin/env node
// The heavy tool-only packages (src/tools/lazy-deps.js) stay out of the boot
// graph and still serve their tools on the first call.
//
//   node scripts/test-lazy-deps.js
//
// Boots a FREE_MODE server under scripts/lib/boot-graph-hook.mjs, which records
// every script compiled before the first macrotask (the synchronous module graph
// the entry evaluates before it can listen). Asserts:
//   - none of LAZY_PACKAGES is in that graph (jsdom, pdfjs with its canvas, the
//     barcode decoders, jimp, turndown, tesseract, ...);
//   - with the warm-up off, each lazy tool answers its own published example 200
//     on its FIRST call, and answers a bad input 400 both before and after its
//     package has loaded;
//   - with the warm-up on (a second boot), it loads every lazy package and logs
//     the count.
// Offline: the examples used here carry their input inline.
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { LAZY_PACKAGES } from "../src/tools/lazy-deps.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Tools whose first call must load a lazy package. Inline examples only.
const LAZY_SLUGS = ["html-select", "html-strip", "html-to-markdown", "xml-to-json", "barcode-decode", "image-resize"];
const WARMED = 10; // loaders in lazy-deps.js WARMERS

async function boot(extraEnv) {
  const port = await getFreePort();
  const graphFile = join(mkdtempSync(join(tmpdir(), "a402-lazy-")), "boot-graph.json");
  const proc = spawn(process.execPath, ["--import", "./scripts/lib/boot-graph-hook.mjs", "src/server.js"], {
    env: {
      ...process.env, FREE_MODE: "true", PORT: String(port), BOOT_GRAPH_OUT: graphFile,
      INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false",
      MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { proc, port, graphFile, log: "", base: `http://127.0.0.1:${port}` };
  proc.stdout.on("data", (d) => { s.log += d; });
  proc.stderr.on("data", (d) => { s.log += d; });
  s.until = (re, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { if (re.test(s.log)) return res(); if (Date.now() - t0 > ms || proc.exitCode !== null) return rej(new Error(`waited ${ms}ms for ${re}; exit ${proc.exitCode}\n${s.log.slice(-2000)}`)); setTimeout(tick, 50); };
    tick();
  });
  s.post = async (route, body) => {
    const r = await fetch(`${s.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await r.arrayBuffer();
    return r.status;
  };
  s.stop = async () => { proc.kill("SIGTERM"); await new Promise((res) => { proc.once("exit", res); setTimeout(res, 5000); }); };
  await s.until(/Agent402 listening on/, 60_000);
  return s;
}

// Boot 1: warm-up off, so every load below is the first caller's.
let srv = null;
try {
  srv = await boot({ LAZY_DEPS_WARM: "off" });

  // 1. Boot graph excludes every lazy package.
  const graph = JSON.parse(readFileSync(srv.graphFile, "utf8"));
  ok(graph.scripts > 1000, `boot graph recorded (${graph.scripts} scripts, ${(graph.bytes / 1048576).toFixed(1)} MB)`);
  const present = LAZY_PACKAGES.filter((p) => graph.packages[p]);
  ok(present.length === 0, present.length ? `lazy packages in the boot graph: ${present.join(", ")}` : `none of the ${LAZY_PACKAGES.length} lazy packages is in the boot graph`);
  ok(graph.packages.express > 0, "the hook saw the graph (express is in it)");

  // 2. A bad input is refused before any lazy package has loaded.
  let st = await srv.post("/api/html-select", { html: "<p>x</p>", selector: ":::not-a-selector" });
  ok(st === 400, `html-select refuses a malformed selector before jsdom has loaded (${st})`);
  st = await srv.post("/api/barcode-decode", {});
  ok(st === 400, `barcode-decode refuses a missing image before the decoders have loaded (${st})`);

  // 3. Every lazy tool answers its published example on the first call.
  const spec = await (await fetch(`${srv.base}/openapi.json`)).json();
  for (const slug of LAZY_SLUGS) {
    const op = spec.paths[`/api/${slug}`]?.post;
    const example = op?.requestBody?.content?.["application/json"]?.example;
    ok(example && typeof example === "object", `${slug} publishes an inline example`);
    const t0 = Date.now();
    const first = await srv.post(`/api/${slug}`, example ?? {});
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    const second = await srv.post(`/api/${slug}`, example ?? {});
    ok(first === 200 && second === 200, `${slug} answers its example 200 on the first call and again (${first}/${second}; ${firstMs}ms then ${Date.now() - t1}ms)`);
  }

  // 4. The same bad inputs are still 400 after the packages have loaded.
  st = await srv.post("/api/html-select", { html: "<p>x</p>", selector: ":::not-a-selector" });
  ok(st === 400, `html-select still refuses a malformed selector after jsdom loaded (${st})`);
  st = await srv.post("/api/html-select", { html: 123, selector: "p" });
  ok(st === 400, `html-select refuses a non-string html (${st})`);
  ok(!/\[lazy-deps\] warmed/.test(srv.log), "LAZY_DEPS_WARM=off ran no warm-up");
} catch (e) {
  ok(false, `warm-up-off boot: ${e.message}`);
} finally {
  if (srv) await srv.stop();
}

// Boot 2: the default warm-up loads every lazy package after listen.
srv = null;
try {
  srv = await boot({ LAZY_DEPS_WARM_DELAY_MS: "200" });
  const graph = JSON.parse(readFileSync(srv.graphFile, "utf8"));
  const present = LAZY_PACKAGES.filter((p) => graph.packages[p]);
  ok(present.length === 0, present.length ? `lazy packages in the boot graph with warm-up on: ${present.join(", ")}` : "the warm-up does not put a lazy package back in the boot graph");
  await srv.until(/\[lazy-deps\] warmed \d+ packages/, 30_000);
  const m = /\[lazy-deps\] warmed (\d+) packages in (\d+)ms/.exec(srv.log);
  ok(Number(m[1]) === WARMED, `post-listen warm-up loaded ${m[1]} of ${WARMED} lazy packages in ${m[2]}ms`);
} catch (e) {
  ok(false, `warm-up boot: ${e.message}`);
} finally {
  if (srv) await srv.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
