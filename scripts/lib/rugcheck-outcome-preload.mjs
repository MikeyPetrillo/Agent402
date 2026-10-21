// --import preload for scripts/test-rugcheck-pause.js: RugCheck answers
// in-process by the mint's prefix, nothing leaves the machine for it.
//   Bad...  HTTP 502 (RugCheck down for that read)
//   Gen...  HTTP 400 {"error":"unable to generate report"} (no report for that mint)
// Any other RugCheck URL answers 404. Every other fetch passes through.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || "");
  const rc = /^https:\/\/api\.rugcheck\.xyz\/v1\/tokens\/([1-9A-HJ-NP-Za-km-z]+)\//.exec(url);
  if (rc) {
    if (rc[1].startsWith("Bad")) return new Response("bad gateway", { status: 502 });
    if (rc[1].startsWith("Gen")) return new Response(JSON.stringify({ error: "unable to generate report" }), { status: 400, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  if (/^https:\/\/api\.rugcheck\.xyz\//.test(url)) return new Response("{}", { status: 404 });
  return realFetch(input, init);
};
