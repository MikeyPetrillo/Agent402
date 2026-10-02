// Test-only preload: every fetch to https://openrouter.ai/... goes to a local
// stub instead, keeping the path.
//
// Loaded with `node --import ./scripts/lib/openrouter-stub-preload.js src/server.js`
// by scripts/test-hangup-settlement.js, which drives the LLM gateway and the
// image tier against a stub it controls (delays, early-close detection). The
// server installs its own fetch wrappers at boot (drain-aware fetch, facilitator
// diagnostics) ON TOP of this one, so every signal they attach still reaches
// the stub - which is what lets the test see an upstream call cut off.
//
// Precedent: scripts/egress-probe-preload.js. The rule that matters: with no
// OPENROUTER_STUB_URL this preload refuses to load, and a call that reaches
// it anyway is refused too, so a test boot can never spend upstream.
const STUB = process.env.OPENROUTER_STUB_URL;
if (!STUB) throw new Error("openrouter-stub-preload: OPENROUTER_STUB_URL is unset; refusing to boot a server that could reach the real upstream");
const ORIGIN = "https://openrouter.ai";
const base = STUB.replace(/\/+$/, "");
const realFetch = globalThis.fetch;

globalThis.fetch = function openRouterStubFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && (url === ORIGIN || url.startsWith(`${ORIGIN}/`))) {
    if (!STUB) return Promise.reject(new Error("openrouter-stub-preload: no stub configured"));
    const target = base + url.slice(ORIGIN.length);
    if (typeof Request !== "undefined" && input instanceof Request) return realFetch.call(this, new Request(target, input), init);
    return realFetch.call(this, target, init);
  }
  return realFetch.call(this, input, init);
};
