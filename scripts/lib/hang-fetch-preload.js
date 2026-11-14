// Test-only preload: a fetch to one of the hosts in HANG_FETCH_HOSTS (comma
// list) never answers. It ends only when its own signal aborts, and prints
// one "[hang-fetch] <host> aborted after <ms> ms" line then, so a test can see
// that an upstream call was cut off (and when), not merely abandoned.
//
// Loaded with `node --import ./scripts/lib/hang-fetch-preload.js src/server.js`
// by scripts/test-referral-gate.js. With no HANG_FETCH_HOSTS this preload
// refuses to load, so a boot that uses it names what it stalls.
const HOSTS = new Set(String(process.env.HANG_FETCH_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
if (!HOSTS.size) throw new Error("hang-fetch-preload: HANG_FETCH_HOSTS is unset; refusing to load");
const realFetch = globalThis.fetch;

globalThis.fetch = function hangFetch(input, init) {
  let host = "";
  try { host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url).hostname.toLowerCase(); } catch { /* not a URL: the real fetch says so */ }
  if (!HOSTS.has(host)) return realFetch.call(this, input, init);
  const signal = init?.signal || (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
  const started = Date.now();
  console.log(`[hang-fetch] ${host} called`);
  return new Promise((_resolve, reject) => {
    const end = () => { console.log(`[hang-fetch] ${host} aborted after ${Date.now() - started} ms`); reject(signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError" })); };
    if (!signal) return; // no signal: it hangs for good, which is what the test would then show
    if (signal.aborted) return end();
    signal.addEventListener("abort", end, { once: true });
  });
};
