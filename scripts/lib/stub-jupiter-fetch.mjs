// --import preload for scripts/test-sweep-upstream-refusal.js: requests to the
// Jupiter host answer what STUB_JUPITER_MODE names, nothing leaves the
// machine for it. "503": the keyless refusal; "garbage": a 200 that is not
// JSON (the tool then answers a 502 in its own words, not the upstream's).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || "");
  if (/^https:\/\/lite-api\.jup\.ag\//.test(url)) {
    const mode = process.env.STUB_JUPITER_MODE || "503";
    if (mode === "503") return new Response("Service Unavailable", { status: 503 });
    return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }
  return realFetch(input, init);
};
