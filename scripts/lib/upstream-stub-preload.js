// Test preload: answers the embeddings upstream with a canned body, so a
// booted PAID server can run a /v1 handler to a 200 (and so reach settlement)
// with no key, no network and nothing spent. Every other request goes to the
// real fetch untouched.
//
// Loaded with `node --import ./scripts/lib/upstream-stub-preload.js src/server.js`
// by scripts/test-paid-settle-breaker.js. Installed before the server's own
// fetch wrappers (drain-abort, facilitator diagnostics), which wrap whatever
// fetch they find, so the stub sits underneath them exactly like the network.
const realFetch = globalThis.fetch;
const EMBEDDINGS = "https://api.openai.com/v1/embeddings";
globalThis.fetch = async function stubbedUpstream(input, init) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (url === EMBEDDINGS) {
    let n = 1;
    try { const b = JSON.parse(init?.body || "{}"); n = Array.isArray(b.input) ? b.input.length : 1; } catch { /* one item */ }
    const body = {
      object: "list",
      data: Array.from({ length: n }, (_, index) => ({ object: "embedding", index, embedding: [0.01, 0.02, 0.03] })),
      model: "text-embedding-3-small",
      usage: { prompt_tokens: n, total_tokens: n },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
};
