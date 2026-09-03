// Locks the wrong-method-405 fix (2026-08-16 audit): 408 of 531 POST-only
// catalog routes returned a bare, generic HTML 404 on a wrong-method GET -
// indistinguishable from "this route doesn't exist at all" to a naive
// client, when the real answer is "you used the wrong HTTP method". Express
// registers each tool on exactly one verb (app[lowerMethod](path, ...)), so
// a mismatched method never matched any route and fell straight through to
// Express's default 404.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wrong-method-405.js
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A POST-only catalog route hit with GET is SERVED through the POST gate
// chain (2026-08-28): in free mode the handler answers its own 400 naming
// the field it needs; never a 405, never Express's bare HTML 404. A method
// no tool has (PUT) still 405s with Allow and a JSON body.
{
  const res = await fetch(`${BASE}/api/hash`, { method: "GET" });
  ok(res.status !== 405 && res.status !== 404 && (res.headers.get("content-type") || "").includes("application/json"), `GET on POST-only /api/hash is not a dead end (got ${res.status}, JSON)`);
  const put = await fetch(`${BASE}/api/hash`, { method: "PUT" });
  ok(put.status === 405, `PUT on /api/hash -> 405 (got ${put.status})`);
  ok(put.headers.get("allow") === "POST", `Allow header names the real method (got "${put.headers.get("allow")}")`);
  ok((put.headers.get("content-type") || "").includes("application/json"), "405 response is JSON, not Express's default HTML 404 page");
  const body = await put.json();
  ok(Array.isArray(body.allow) && body.allow.includes("POST"), `JSON body's allow[] also names the method (got ${JSON.stringify(body.allow)})`);
}

// The correct method on the same route must be completely unaffected.
{
  const res = await fetch(`${BASE}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  ok(res.status !== 405, `POST (the real method) on /api/hash is never 405'd (got ${res.status})`);
}

// POST on a GET-only tool is SERVED (2026-08-28): the JSON body is the input,
// the same gate chain runs. Agents POST everything; a paying buyer walked the
// catalog and got 405 on every GET tool.
{
  const res = await fetch(`${BASE}/api/random`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ min: 40, max: 41 }) });
  ok(res.status !== 405 && res.status !== 404, `POST on GET-only /api/random is not refused for its method (got ${res.status})`);
  if (res.status === 200) {
    const body = await res.json();
    const v = Number(Array.isArray(body.integers) ? body.integers[0] : (body.value ?? body.number ?? body.result));
    ok(v === 40 || v === 41, `the JSON body reached the handler as input (got ${JSON.stringify(body).slice(0, 80)})`);
  }
}
// A path that isn't in the catalog AT ALL must fall through to the
// existing 404 behavior unchanged - the fix must not swallow every 404.
{
  const res = await fetch(`${BASE}/api/this-route-genuinely-does-not-exist-xyz`, { method: "GET" });
  ok(res.status === 404, `a path outside the catalog entirely still 404s normally (got ${res.status})`);
  ok(res.headers.get("allow") === null, "no spurious Allow header on a genuinely unmatched path");
}

// A non-catalog page (marketing/HTML surface, not an /api tool) must be
// completely unaffected by this catalog-scoped check.
{
  const res = await fetch(`${BASE}/marketplace`, { method: "GET" });
  ok(res.status === 200, `a non-catalog page renders normally, untouched by the catalog-scoped 405 check (got ${res.status})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
