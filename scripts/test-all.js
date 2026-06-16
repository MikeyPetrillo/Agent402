// Comprehensive coverage: call EVERY tool in the catalog with its own documented
// example and verify a sensible response. Drives itself from /openapi.json over
// HTTP, so it exercises real routing + handlers for all ~1070 endpoints.
//
//   TARGET_URL=http://localhost:3000 node scripts/test-all.js
//
// Pure-CPU tools must return 200 with no error. Network/browser tools are
// exercised but tolerant of upstream/sandbox failures (they need real egress;
// CI has it). Memory tools get a demo namespace and accept their valid 4xx.
const TARGET = process.env.TARGET_URL || "http://localhost:3000";

// Tools that reach the network/browser — lenient (need real egress).
const NETWORK = new Set([
  "/api/extract", "/api/meta", "/api/dns", "/api/render", "/api/screenshot", "/api/pdf",
  "/api/http-check", "/api/tls-cert", "/api/whois", "/api/robots-check", "/api/sitemap",
  "/api/email-validate", "/api/ip-info", "/api/search",
  "/api/pdf-info", "/api/pdf-merge", "/api/pdf-extract-pages", "/api/pdf-rotate", "/api/images-to-pdf",
  "/api/pdf-to-markdown",
  "/api/media-info", "/api/audio-convert", "/api/audio-normalize",
  "/api/gov-data", "/api/weather-alerts", "/api/earthquakes",
  "/api/geocode", "/api/reverse-geocode", "/api/place-search",
  "/api/barcode-lookup", "/api/fx-rate", "/api/weather-forecast",
  "/api/x402-quote", "/api/usdc-balance", "/api/tx-status", "/api/gas-estimate", "/api/x402-verify", "/api/ens-resolve",
]);
const isMemory = (p) => p.startsWith("/api/memory");

const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const paths = Object.entries(spec.paths);

let strictPass = 0, strictFail = 0, lenient = 0, serverErr = 0;
const failures = [];
const cats = {};

function buildGetUrl(path, op) {
  const qs = new URLSearchParams();
  for (const p of op.parameters ?? []) {
    if (p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
  }
  return `${TARGET}${path}${[...qs].length ? `?${qs}` : ""}`;
}

for (const [path, methods] of paths) {
  for (const [method, op] of Object.entries(methods)) {
    const cat = (op.tags && op.tags[0]) || "other";
    cats[cat] = cats[cat] || { pass: 0, total: 0 };
    cats[cat].total++;

    let url, init;
    if (method === "get") {
      url = buildGetUrl(path, op);
      init = {};
    } else {
      const example = op.requestBody?.content?.["application/json"]?.example ?? {};
      url = `${TARGET}${path}`;
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example) };
    }
    // Memory tools need an identity in free mode; give them a demo namespace.
    if (isMemory(path)) url += (url.includes("?") ? "&" : "?") + "ns=smoke-all";

    let status = 0, body = null, threw = null;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      status = res.status;
      const ct = res.headers.get("content-type") || "";
      body = ct.includes("application/json") ? await res.json() : (await res.arrayBuffer()).byteLength;
    } catch (e) {
      threw = e.message;
    }

    const okStrict = status === 200 && !(body && body.error);
    if (NETWORK.has(path)) {
      lenient++;
      // Tolerate upstream/egress failures (502/504) and browser-not-available
      // (503) — these tools need real network/Chromium, present in CI.
      if (status >= 500 && ![502, 503, 504].includes(status)) { serverErr++; failures.push(`${method} ${path} → server ${status}`); }
    } else if (isMemory(path)) {
      lenient++;
      if (threw || (status >= 500)) { serverErr++; failures.push(`${method} ${path} → ${threw || status}`); }
    } else {
      if (okStrict) { strictPass++; cats[cat].pass++; }
      else { strictFail++; failures.push(`${method} ${path} → ${threw || `HTTP ${status}`}${body && body.error ? " " + JSON.stringify(body.error).slice(0, 60) : ""}`); }
    }
  }
}

const totalOps = paths.reduce((a, [, m]) => a + Object.keys(m).length, 0);
console.log(`\nExercised ${totalOps} endpoints at ${TARGET}\n`);
for (const [cat, c] of Object.entries(cats).sort()) console.log(`  ${cat.padEnd(12)} ${c.pass}/${c.total} pure-CPU strict-pass`);
console.log(`\n  strict (pure-CPU): ${strictPass} passed, ${strictFail} failed`);
console.log(`  lenient (network/memory): ${lenient} exercised, ${serverErr} server errors`);
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ` + failures.slice(0, 40).join("\n  ") + (failures.length > 40 ? `\n  …and ${failures.length - 40} more` : ""));
}
// Fail the run only on a pure-CPU strict failure or a real server crash (5xx
// that isn't an upstream 502/504). Network flakiness alone does not fail.
process.exit(strictFail === 0 && serverErr === 0 ? 0 : 1);
