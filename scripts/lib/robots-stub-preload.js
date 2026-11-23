// Test-only preload for scripts/test-robots-gate.js: the robots gate
// (src/tools/robots-gate.js) reads its robots.txt answers from here, and every
// fetch to a `.example` host is answered here and printed, so the suite can
// tell from the log whether a tool fetched a page after its robots.txt
// disallowed it.
//
//   robots-blocked.example  robots.txt disallows Agent402-Fetch everywhere
//   robots-open.example     robots.txt allows everything; each page fetch
//                           answers a new version of the page (a counter), so
//                           a second call shows whether the first was kept
//
// Loaded with `node --import ./scripts/lib/robots-stub-preload.js src/server.js`
// only when ROBOTS_STUB=1, so a boot that uses it names what it stubs.
// Worker threads inherit the --import with a narrowed env; they fetch
// nothing, so the stubs are installed on the main thread only.
import { isMainThread } from "node:worker_threads";

export const BLOCKED_HOST = "robots-blocked.example";
export const OPEN_HOST = "robots-open.example";

if (isMainThread) await install();

async function install() {
  if (process.env.ROBOTS_STUB !== "1") throw new Error("robots-stub-preload: ROBOTS_STUB is not 1; refusing to load");
  await import("./guard-dns-offline.js");
  const { __test } = await import("../../src/tools/robots-gate.js");

  __test.setFetchRobots(async (robotsUrl) => {
    const host = new URL(robotsUrl).hostname;
    console.log(`[robots-stub] robots ${host}`);
    if (host === BLOCKED_HOST) return "User-agent: Fetch\nAllow: /\n\nUser-agent: *\nAllow: /\n\nUser-agent: Agent402-Fetch\nUser-agent: Agent402Bot\nDisallow: /\n";
    if (host === OPEN_HOST) return "User-agent: *\nAllow: /\n";
    throw Object.assign(new Error("no robots.txt here"), { statusCode: 422 });
  });

  const realFetch = globalThis.fetch;
  let version = 0;
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  globalThis.fetch = function robotsStubFetch(input, init) {
    let url;
    try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url); } catch { return realFetch.call(this, input, init); }
    if (!url.hostname.endsWith(".example")) return realFetch.call(this, input, init);
    console.log(`[robots-stub] content fetch ${url.hostname}${url.pathname}`);
    if (url.hostname !== OPEN_HOST) return Promise.reject(new TypeError("fetch failed"));
    version++;
    const html = `<!doctype html><html><head><title>Stub page version ${version}</title></head><body><main><article><h1>Stub page version ${version}</h1><p>Version ${version}. ${words(80)}</p></article></main></body></html>`;
    const res = new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(res, "url", { value: url.href });
    return Promise.resolve(res);
  };
}
