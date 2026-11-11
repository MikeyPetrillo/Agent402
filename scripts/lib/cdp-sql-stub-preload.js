// Test-only preload: every fetch to https://api.cdp.coinbase.com/... is
// answered here, so a booted server can run the onchain-sql handler with a
// test key, no network and nothing spent. With no CDP_SQL_STUB=1 this preload
// refuses to load, so a boot that uses it can never reach the real service.
//
// The query service's answer is chosen by a marker in the SQL text:
//   rowsize_<id>   the first query with that id answers the service's
//                  internal error (a result it will not send), the row-size
//                  measure answers a few rows over the per-row limit, and the
//                  filtered run answers the rows that fit: three queries;
//   nope_column    the service rejects the query (HTTP 400);
//   anything else  one row (the health probe's known-good query included).
// Every query answered prints one "[cdp-sql-stub] query" line, so a test can
// count what reached the service apart from what the server recorded. Any
// other path on the host answers 404.
//
// Loaded with `node --import ./scripts/lib/cdp-sql-stub-preload.js src/server.js`
// by scripts/test-onchain-sql-queries-route.js.
if (process.env.CDP_SQL_STUB !== "1") throw new Error("cdp-sql-stub-preload: CDP_SQL_STUB is not 1; refusing to boot a server that could reach the real service");
const ORIGIN = "https://api.cdp.coinbase.com";
const realFetch = globalThis.fetch;
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isMeasure = (q) => /countIf\(length\(toString\(tuple\(\*\)\)\)/.test(q);
const fitRows = Array.from({ length: 18 }, (_, i) => ({ ix: i, sk: "a" }));
const seen = new Map(); // rowsize id -> queries answered

globalThis.fetch = async function cdpSqlStubFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url !== "string" || !(url === ORIGIN || url.startsWith(`${ORIGIN}/`))) return realFetch.call(this, input, init);
  if (new URL(url).pathname !== "/platform/v2/data/query/run") return J(404, { errorMessage: "not stubbed" });
  let sql = "";
  try { sql = String(JSON.parse(init?.body || "{}").sql || ""); } catch { /* an empty query */ }
  console.log("[cdp-sql-stub] query");
  if (/nope_column/.test(sql)) return J(400, { errorMessage: "Unknown identifier" });
  const id = /rowsize_(\w+)/.exec(sql)?.[1];
  if (id) {
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n === 1) return J(500, {});
    return isMeasure(sql) ? J(200, { result: [{ n: 22, big: 4, maxRow: 65972 }] }) : J(200, { result: fitRows });
  }
  return J(200, { result: [{ n: 1 }] });
};
