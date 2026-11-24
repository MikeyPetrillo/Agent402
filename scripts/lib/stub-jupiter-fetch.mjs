// --import preload for scripts/test-sweep-upstream-refusal.js: requests to the
// Jupiter host answer what STUB_JUPITER_MODE names, nothing leaves the
// machine for it. "503": the keyless refusal; "garbage": a 200 that is not
// JSON (the tool then answers a 502 in its own words, not the upstream's).
// The risk summary the same route reads beside it answers a clean summary, so
// the Jupiter leg alone decides the route's answer.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || "");
  if (/^https:\/\/api\.rugcheck\.xyz\/v1\/tokens\/[^/]+\/report\/summary$/.test(url)) {
    return new Response(JSON.stringify({ tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", score: 1, score_normalised: 1, risks: [], lpLockedPct: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (/^https:\/\/lite-api\.jup\.ag\//.test(url)) {
    const mode = process.env.STUB_JUPITER_MODE || "503";
    if (mode === "503") return new Response("Service Unavailable", { status: 503 });
    return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }
  return realFetch(input, init);
};
