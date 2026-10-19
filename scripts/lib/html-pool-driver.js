// One process for scripts/test-html-pool.js: loads the real HTML tools (which
// parse in the HTML worker pool), runs one named scenario from argv (JSON:
// { scenario }) under the pool settings the parent put in the environment, and
// prints its result as the last JSON line. The parent passes data only.
import { HTML_TOOLS } from "../../src/tools/html-kit.js";
import { htmlPoolState } from "../../src/tools/html-pool.js";

const strip = HTML_TOOLS.find((t) => t.slug === "html-strip");
// Nested tables: the slowest shape per byte for the parser (a few seconds here).
const DEEP = "<table><tr><td>".repeat(2500) + "x";
const LARGE = "<p>" + "a".repeat(1_200_000) + "</p>";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (p) => p.then((r) => ({ ok: true, chars: r.chars }), (e) => ({ ok: false, status: e.statusCode, message: String(e.message) }));

// Largest gap between 20 ms timer ticks while `p` runs: how long the main
// thread was unavailable to anything else.
async function lagWhile(p) {
  let last = performance.now(), worst = 0, done = false;
  const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 20); last = n; }, 20);
  const r = await p.finally(() => { done = true; });
  clearInterval(tick);
  return { r, worstLagMs: Math.round(worst), done };
}

const { scenario } = JSON.parse(process.argv[2] || "{}");
async function run() {
  switch (scenario) {
    case "responsive": {
      const t0 = performance.now();
      const { r, worstLagMs } = await lagWhile(outcome(strip.handler({ html: DEEP })));
      return { ...r, worstLagMs, parseMs: Math.round(performance.now() - t0) };
    }
    case "timeout": {
      const t0 = performance.now();
      const slow = await outcome(strip.handler({ html: DEEP }));
      const elapsedMs = Math.round(performance.now() - t0);
      const after = await outcome(strip.handler({ html: "<p>still works</p>" }));
      return { slow, elapsedMs, after };
    }
    case "errors": {
      const missing = await outcome(strip.handler({}));
      const badSelector = await outcome(strip.handler({ html: "<p>x</p>", selector: "p[" }));
      const fine = await outcome(strip.handler({ html: "<h1>T</h1><p>a</p>" }));
      return { missing, badSelector, fine };
    }
    case "queue": {
      const jobs = [strip.handler({ html: DEEP }), strip.handler({ html: DEEP }), strip.handler({ html: DEEP })].map(outcome);
      await sleep(50);
      const state = htmlPoolState();
      return { state, results: await Promise.all(jobs) };
    }
    case "large": {
      const a = outcome(strip.handler({ html: LARGE }));
      const b = outcome(strip.handler({ html: LARGE }));
      const small = outcome(strip.handler({ html: "<p>small</p>" }));
      await sleep(30);
      const state = htmlPoolState();
      return { state, results: await Promise.all([a, b, small]) };
    }
    // One job, then return without process.exit: the parent checks that idle
    // workers never hold the process open.
    case "exits": return outcome(strip.handler({ html: "<p>bye</p>" }));
    default: return { error: `unknown scenario ${scenario}` };
  }
}

const result = await run();
console.log(JSON.stringify(result));
if (scenario !== "exits") process.exit(0);
