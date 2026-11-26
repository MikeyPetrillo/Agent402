// Test-only preload: every fetch to https://api.github.com/... goes to a local
// stub instead, keeping the path and query, with the host it was meant for in
// `x-stub-host`. The SSRF guard's dispatcher is dropped for that one host only
// (the stub listens on loopback). With no GITHUB_STUB_URL this preload refuses
// to load, so a boot that uses it can never reach the real upstream.
//
// Loaded with `node --import ./scripts/lib/github-stub-preload.js src/server.js`
// by scripts/test-upstream-key.js.
const STUB = process.env.GITHUB_STUB_URL;
if (!STUB) throw new Error("github-stub-preload: GITHUB_STUB_URL is unset; refusing to boot a server that could reach the real upstream");
const ORIGIN = "https://api.github.com";
const base = STUB.replace(/\/+$/, "");
const realFetch = globalThis.fetch;

globalThis.fetch = function githubStubFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && (url === ORIGIN || url.startsWith(`${ORIGIN}/`))) {
    const { dispatcher: _guarded, ...rest } = init || {};
    const headers = new Headers(rest.headers || {});
    headers.set("x-stub-host", "api.github.com");
    return realFetch.call(this, base + url.slice(ORIGIN.length), { ...rest, headers });
  }
  return realFetch.call(this, input, init);
};
