// html-frames runs buyer-written script, so it is held apart from the
// public-page browser and bounded per payer:
//   1. its browser is launched with V8's JIT off (--jitless), on a pipe (no
//      remote-debugging port), and the public-page browser keeps its own args;
//   2. the document's content policy carries no 'wasm-unsafe-eval', and in the
//      real browser WebAssembly is unavailable to the document while plain
//      script (the published example) still renders;
//   3. failed documents (4xx, never charged) are bounded per payer: after
//      HTML_FRAMES_FAIL_MAX failures in the window the next call is a 429 with
//      Retry-After, before the handler runs; another payer is unaffected,
//      successes and capacity refusals do not count, and the window expires.
// Needs Playwright's Chromium for part 2; under CI a missing browser fails.
//
//   node scripts/test-html-frames-isolation.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { PNG } from "pngjs";
import {
  __test, renderHtmlFrames, launchArgsFor, FRAMES_BROWSER_ARGS, HTML_FRAMES_CSP,
  createFramesFailureWindow, withHtmlFramesFailureBound, HTML_FRAMES_FAIL_MAX, HTML_FRAMES_FAIL_WINDOW_MS,
} from "../src/tools/render.js";
import { BROWSER_MEASURE_TOOLS } from "../src/tools/browser-measure-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- 1. launch arguments ----------------------------------------------------
{
  const frames = launchArgsFor(FRAMES_BROWSER_ARGS, "http://127.0.0.1:1");
  const pages = launchArgsFor([], "http://127.0.0.1:1");
  ok(frames.includes("--js-flags=--jitless"), "the html-frames browser is launched with --js-flags=--jitless");
  ok(!pages.some((a) => /jitless/.test(a)), "the public-page browser keeps the JIT");
  ok(![...frames, ...pages].some((a) => /remote-debugging-port|remote-debugging-address/.test(a)), "no launch opens a remote-debugging port");
  ok(frames.includes("--proxy-server=http://127.0.0.1:1") && frames.includes("--proxy-bypass-list=<-loopback>"), "the html-frames browser keeps the egress proxy arguments");
}

// ---- 2. content policy and the real browser -----------------------------------
ok(!/wasm-unsafe-eval/.test(HTML_FRAMES_CSP), `the document policy carries no 'wasm-unsafe-eval' (${HTML_FRAMES_CSP.split("; ")[1]})`);
let chromiumOk = true, launchErr = null;
try { const { chromium } = await import("playwright"); const b = await chromium.launch(); await b.close(); } catch (e) { chromiumOk = false; launchErr = e; }
if (!chromiumOk) {
  const msg = `Playwright Chromium is not available (${String(launchErr?.message || launchErr).split("\n")[0]})`;
  if (process.env.CI) ok(false, msg); else console.log(`SKIP - ${msg}`);
} else {
  // Green: no WebAssembly global at all (V8 runs jitless; the content policy
  // alone would leave the global and refuse compiles). Blue: the global is
  // there but a compile is refused. Red: a module compiles.
  const probeDoc = `<!doctype html><body style="margin:0"><canvas id=c width=16 height=16></canvas><script>
let color = "#00ff00";
if (typeof WebAssembly !== "undefined") {
  color = "#0000ff";
  try { if (new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))) color = "#ff0000"; } catch (e) { /* refused */ }
}
const x = document.getElementById("c").getContext("2d");
window.renderAt = (t) => { x.fillStyle = color; x.fillRect(0, 0, 16, 16); };
</script></body>`;
  const r = await renderHtmlFrames(probeDoc, [0], { width: 16, height: 16 });
  const px = PNG.sync.read(Buffer.from(r.frames[0].pngBase64, "base64")).data;
  ok(px[0] < 50 && px[1] > 200 && px[2] < 50, `the document runs in the jitless browser: no WebAssembly global (pixel rgb ${px[0]},${px[1]},${px[2]}; blue = global present, red = a module compiled)`);
  const tool = BROWSER_MEASURE_TOOLS.find((t) => t.slug === "html-frames");
  const ex = await tool.handler(tool.discovery.input);
  ok(ex.frameCount === tool.discovery.input.times.length && ex.frames.every((f) => f.bytes > 0), `the published example still renders every frame (${ex.frameCount})`);
  __test.reset();
}

// ---- 3. per-payer bound on failed documents --------------------------------------
ok(HTML_FRAMES_FAIL_MAX >= 1 && HTML_FRAMES_FAIL_WINDOW_MS >= 60_000, `defaults: ${HTML_FRAMES_FAIL_MAX} failures per ${HTML_FRAMES_FAIL_WINDOW_MS / 60_000} minutes`);
{
  let t = 1_000_000;
  const failures = createFramesFailureWindow({ max: 3, windowMs: 600_000, now: () => t });
  let runs = 0;
  let mode = "bad";
  const handler = async () => {
    runs++;
    if (mode === "bad") throw Object.assign(new Error("renderAt threw"), { statusCode: 400 });
    if (mode === "busy") throw Object.assign(new Error("pool full"), { statusCode: 503 });
    return { frameCount: 1 };
  };
  const bounded = withHtmlFramesFailureBound(handler, (ctx) => ctx?.payer, failures);
  for (let i = 0; i < 3; i++) await rejects(bounded({}, { payer: "0xaaa" }));
  ok(runs === 3, "three failed documents each ran");
  const runsBefore = runs;
  const refused = await rejects(bounded({}, { payer: "0xaaa" }));
  ok(refused?.statusCode === 429 && Number.isInteger(refused.retryAfter) && refused.retryAfter > 0 && refused.retryAfter <= 600, `the next call from that payer is a 429 with Retry-After (${refused?.statusCode} ${refused?.retryAfter} s: ${refused?.message})`);
  ok(runs === runsBefore, "the refused call never reaches the handler");
  ok(/retry in \d+ s/.test(refused?.message || "") && !/0x/.test(refused?.message || ""), "the refusal names the wait and not the payer");
  mode = "ok";
  ok((await bounded({}, { payer: "0xbbb" }))?.frameCount === 1, "another payer is unaffected");
  mode = "busy";
  for (let i = 0; i < 5; i++) await rejects(bounded({}, { payer: "0xccc" }));
  mode = "ok";
  ok((await bounded({}, { payer: "0xccc" }))?.frameCount === 1, "capacity refusals (503) do not count as failed documents");
  for (let i = 0; i < 10; i++) await bounded({}, { payer: "0xddd" });
  mode = "bad";
  for (let i = 0; i < 2; i++) await rejects(bounded({}, { payer: "0xddd" }));
  mode = "ok";
  ok((await bounded({}, { payer: "0xddd" }))?.frameCount === 1, "successes do not count toward the bound");
  t += 600_001;
  ok((await bounded({}, { payer: "0xaaa" }))?.frameCount === 1, "the payer may run again once the window passes");
  // IPv6 addresses inside one /64 share a key, as the other limiters do.
  mode = "bad";
  for (let i = 0; i < 3; i++) await rejects(bounded({}, { payer: `2001:db8:1:2::${i + 1}` }));
  const v6 = await rejects(bounded({}, { payer: "2001:db8:1:2::99" }));
  ok(v6?.statusCode === 429, "client addresses in one IPv6 /64 share one bound");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
