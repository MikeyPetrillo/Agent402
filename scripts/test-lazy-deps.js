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
//   - the server's MAIN thread never loads a package whose every caller runs in
//     a worker pool (jsdom, Readability, turndown, pdf-lib, the barcode decoders,
//     jimp): importing one is synchronous CPU (jsdom alone held the loop about
//     200 ms on a laptop and 300-560 ms on a CI runner, which the loop-lag log
//     pinned on whatever skill pack was in flight). Each first call of a tool
//     that parses with jsdom holds the main thread under a bound, read inside
//     the server (scripts/lib/loop-gap-preload.js);
//   - with the warm-up on (a second boot), it loads exactly the packages the
//     main thread uses (MAIN_THREAD_PACKAGES) and logs the count, and the main
//     thread resolves no other.
// Offline: the examples used here carry their input inline; feed-parse's
// example names this server's own feed, answered by this process
// (scripts/lib/own-examples-preload.js) after a name lookup answered in
// process (scripts/lib/guard-dns-offline.js).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { LAZY_PACKAGES, MAIN_THREAD_PACKAGES } from "../src/tools/lazy-deps.js";
import { bound } from "./lib/ours-clock.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Tools whose first call must load a lazy package. Inline examples only.
const LAZY_SLUGS = ["html-select", "html-strip", "html-to-markdown", "xml-to-json", "barcode-decode", "image-resize"];
const WARMED = MAIN_THREAD_PACKAGES.length; // what the main-thread warm-up loads
// Loaded only inside a worker (html-worker.js, image-worker.js, pdf-worker.js):
// the main thread must never resolve them, so their import never holds its loop.
const WORKER_ONLY = ["jsdom", "@mozilla/readability", "turndown", "pdf-lib", "@zxing/library", "jsqr", "jimp"];
// A first call's longest main-thread turn: route code compiles on a first call;
// a package import (jsdom: about 200 ms on a laptop) is what this bound is for.
const FIRST_CALL = bound(100, 5);

async function boot(extraEnv) {
  const graphFile = join(mkdtempSync(join(tmpdir(), "a402-lazy-")), "boot-graph.json");
  // The listening line is enough (readyPath null): the boot graph is waited for below.
  const b = await bootServer({
    stores: false,
    args: ["--import", "./scripts/lib/boot-graph-hook.mjs", "--import", "./scripts/lib/loop-gap-preload.js", "--import", "./scripts/lib/main-thread-packages-preload.js", "--import", "./scripts/lib/guard-dns-offline.js", "--import", "./scripts/lib/own-examples-preload.js"],
    ipc: true,
    readyPath: null,
    timeoutMs: 60_000,
    env: {
      FREE_MODE: "true", BOOT_GRAPH_OUT: graphFile,
      INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false",
      MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", ...extraEnv,
    },
  });
  const proc = b.child;
  const s = { proc, port: b.port, graphFile, get log() { return b.log(); }, base: b.url };
  // The preloads answer over the IPC channel: the loop meter and the packages
  // the main thread has resolved.
  let seq = 0;
  const waiting = new Map();
  proc.on("message", (m) => { const key = m && `${m.loopGap || m.mainPackages}:${m.id}`; const w = waiting.get(key); if (w) { waiting.delete(key); w(m); } });
  const ask = (msg, reply) => new Promise((res, rej) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(`${reply}:${id}`); rej(new Error(`no ${reply} answer within 30 s`)); }, 30_000);
    waiting.set(`${reply}:${id}`, (m) => { clearTimeout(t); res(m); });
    proc.send({ ...msg, id });
  });
  s.mainPackages = async () => (await ask({ mainPackages: "read" }, "result")).seen;
  // One call, with the main thread's longest turn while it ran (ours clock).
  s.held = async (fn) => {
    await ask({ loopGap: "start" }, "started");
    const out = await fn();
    const g = await ask({ loopGap: "stop" }, "result");
    return { out, worst: g.worst };
  };
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
  s.stop = b.stop;
  // The hook writes the graph from a timer armed during the entry module's
  // evaluation; under a loaded runner that timer can fire after the listen
  // line, so wait for the file itself rather than assume the order.
  for (let i = 0; i < 300 && !existsSync(s.graphFile); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(s.graphFile)) throw new Error(`boot graph never written to ${s.graphFile}; server log tail: ${s.log.slice(-1500)}`);
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
    const { out: first, worst } = await srv.held(() => srv.post(`/api/${slug}`, example ?? {}));
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    const second = await srv.post(`/api/${slug}`, example ?? {});
    ok(first === 200 && second === 200, `${slug} answers its example 200 on the first call and again (${first}/${second}; ${firstMs}ms then ${Date.now() - t1}ms)`);
    ok(worst <= FIRST_CALL.ms, `${slug}: its first call held the main thread at most ${worst.toFixed(1)} ms (${FIRST_CALL.note})`);
  }

  // 3b. The other tools that parse with jsdom: feed-parse on its published
  // example (this server's own feed), and page-change's selector check (a
  // malformed selector is refused before any fetch).
  {
    const example = spec.paths["/api/feed-parse"]?.post?.requestBody?.content?.["application/json"]?.example;
    const { out: r, worst } = await srv.held(async () => {
      const res = await fetch(`${srv.base}/api/feed-parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(example) });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    ok(r.status === 200 && r.body?.format === "rss2" && r.body.items?.length === example?.limit && r.body.itemCount >= example?.limit, `feed-parse answers its example 200 with ${example?.limit} items (${r.status}, ${r.body?.items?.length ?? r.body?.error})`);
    ok(worst <= FIRST_CALL.ms, `feed-parse: its first call held the main thread at most ${worst.toFixed(1)} ms (${FIRST_CALL.note})`);
    const pc = await srv.held(() => srv.post("/api/page-change", { url: "https://example.com/", selector: ":::not-a-selector" }));
    ok(pc.out === 400, `page-change refuses a malformed selector before any fetch (${pc.out})`);
    ok(pc.worst <= FIRST_CALL.ms, `page-change: its selector check held the main thread at most ${pc.worst.toFixed(1)} ms (${FIRST_CALL.note})`);
  }
  {
    const seen = await srv.mainPackages();
    const onMain = WORKER_ONLY.filter((p) => seen.includes(p));
    ok(onMain.length === 0, onMain.length ? `the main thread loaded worker-only packages: ${onMain.join(", ")}` : `the main thread loaded none of ${WORKER_ONLY.join(", ")} (it resolved: ${seen.join(", ") || "none"})`);
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
  const seen = await srv.mainPackages();
  const missing = MAIN_THREAD_PACKAGES.filter((p) => !seen.includes(p));
  const onMain = WORKER_ONLY.filter((p) => seen.includes(p));
  ok(missing.length === 0 && onMain.length === 0, `the warm-up loads on the main thread exactly the packages it uses (${MAIN_THREAD_PACKAGES.join(", ")})${missing.length ? `; not loaded: ${missing.join(", ")}` : ""}${onMain.length ? `; worker-only loaded: ${onMain.join(", ")}` : ""}`);
} catch (e) {
  ok(false, `warm-up boot: ${e.message}`);
} finally {
  if (srv) await srv.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
