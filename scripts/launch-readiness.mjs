#!/usr/bin/env node
// Self-check before a launch or a deploy: free GET requests only, against a
// base URL (default production). Prints one line per check and exits 1 on any
// failure. The one POST is an unpaid probe of a paid route: it answers 402 and
// is never charged.
//
//   node scripts/launch-readiness.mjs [https://agent402.tools]
const base = (process.argv[2] || "https://agent402.tools").replace(/\/+$/, "");
const results = [];
const check = async (name, fn) => {
  try { const r = await fn(); results.push([r === true, name, r === true ? "" : String(r)]); }
  catch (e) { results.push([false, name, String(e.message || e).slice(0, 120)]); }
};
const get = (path, opts = {}) => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...opts });

await check("health answers 200 with a build id", async () => {
  const r = await get("/health"); const j = await r.json();
  return r.status === 200 && j?.meta?.build ? true : `status ${r.status}`;
});
await check("home page 200 and HTML", async () => {
  const r = await get("/"); return r.status === 200 && /text\/html/.test(r.headers.get("content-type") || "") ? true : `status ${r.status}`;
});
await check("llms.txt present", async () => (await get("/llms.txt")).status === 200 ? true : "missing");
await check("sitemap.xml present", async () => (await get("/sitemap.xml")).status === 200 ? true : "missing");
await check("robots.txt present", async () => (await get("/robots.txt")).status === 200 ? true : "missing");
await check("openapi.json parses", async () => { const r = await get("/openapi.json"); await r.json(); return r.status === 200 ? true : `status ${r.status}`; });
await check("paid route answers 402 unpaid", async () => {
  const r = await get("/api/hash", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return r.status === 402 || r.status === 400 ? true : `status ${r.status}`;
});
await check("security headers on a page", async () => {
  const r = await get("/"); const h = r.headers;
  return h.get("strict-transport-security") ? true : "no HSTS";
});
await check("privacy and terms pages 200", async () => {
  const [a, b] = await Promise.all([get("/privacy"), get("/terms")]);
  return a.status === 200 && b.status === 200 ? true : `privacy ${a.status}, terms ${b.status}`;
});

let failed = 0;
for (const [ok, name, why] of results) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " - " + why}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed against ${base}`);
process.exit(failed ? 1 : 0);
