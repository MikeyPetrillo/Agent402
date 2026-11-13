// Offline guard for scripts/bazaar-validate.js (stub validator, no network).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateOne, FLAGSHIP_PATHS, defaultEndpoints, NON_JSON_LISTING_MAX } from "./bazaar-validate.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const ep = { method: "GET", path: "/api/search", slug: "search" };
const seen = [];
const fetchWith = (script) => { let i = 0; return async (url, init) => { seen.push(JSON.parse(init.body)); const step = script[Math.min(i++, script.length - 1)]; return typeof step === "function" ? step() : step; }; };

ok(FLAGSHIP_PATHS.length >= 10 && FLAGSHIP_PATHS.every((p) => p.startsWith("/api/") || p.startsWith("/v1/")), "flagship set is a short list of /api and /v1 paths");

// method travels from the catalog (a GET route probed as POST reads 405 as 'not x402')
let r = await validateOne(ep, { fetchImpl: fetchWith([resp(200, { valid: true, statusCode: 402, preflight: [{ check: "returns_402", passed: true, severity: "required" }], simulation: { outcome: "accepted" }, index: { active: true, lastCrawledAt: "2026-08-19T00:00:00Z" } })]), base: "https://x.test" });
ok(seen[0].method === "GET" && seen[0].resource === "https://x.test/api/search", `validator is asked with the catalog method + full https resource (${JSON.stringify(seen[0])})`);
ok(r.ok && r.valid && r.indexed && r.failed.length === 0, "valid + indexed response parses");

// required failure -> invalid with the check named; advisory-only -> still valid
r = await validateOne(ep, { fetchImpl: fetchWith([resp(200, { valid: false, statusCode: 405, preflight: [{ check: "returns_402", passed: false, severity: "required", detail: "Endpoint returned HTTP 405 instead of 402" }], simulation: { outcome: "rejected", rejectionReason: "endpoint failed preflight checks" }, index: null })]) });
ok(r.ok && !r.valid && /returns_402: Endpoint returned HTTP 405/.test(r.failed[0]) && !r.indexed, `required preflight failure -> invalid, check named (${r.failed[0]})`);
r = await validateOne(ep, { fetchImpl: fetchWith([resp(200, { valid: true, statusCode: 402, preflight: [{ check: "bazaar.info.output.example", passed: false, severity: "advisory", detail: "no example" }], simulation: { outcome: "accepted" }, index: { active: true } })]) });
ok(r.ok && r.valid && r.failed.length === 0 && r.advisory[0] === "bazaar.info.output.example", "advisory-only failures do not make a route invalid but are surfaced");

// 429 -> retry after Retry-After -> success; exhausted 429 -> unreadable (never a verdict)
seen.length = 0;
r = await validateOne(ep, { fetchImpl: fetchWith([resp(429, "", { "retry-after": "0.01" }), resp(200, { valid: true, statusCode: 402, preflight: [], simulation: { outcome: "accepted" }, index: { active: true } })]) });
ok(r.ok && r.valid && seen.length === 2, `429 is retried after Retry-After, not reported as unreadable (${seen.length} calls)`);
process.env.BAZAAR_VALIDATE_429_RETRIES = "0";
// MAX_429_RETRIES is read at import time, so exercise exhaustion with the default by feeding 429 forever and a tiny Retry-After
const forever429 = fetchWith([resp(429, "", { "retry-after": "0.01" })]);
r = await validateOne(ep, { fetchImpl: forever429 });
ok(!r.ok && /429/.test(r.error), `exhausted 429s -> unreadable (${r.error})`);
r = await validateOne(ep, { fetchImpl: fetchWith([resp(502, "<html>bad gateway</html>")]) });
ok(!r.ok && /502/.test(r.error), "validator 5xx/non-JSON -> unreadable, never valid");
r = await validateOne(ep, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
ok(!r.ok && /unreachable/.test(r.error), "network error -> unreadable");

// The default run covers every non-JSON listing on /api/pricing beside the
// flagship set, derived from the rows (mimeType), capped.
{
  const row = (path, extra = {}) => ({ method: "GET", path, slug: path.slice(5), ...extra });
  const catalog = [row("/api/search"), row("/api/hash"), row("/api/other"), row("/api/bytes", { mimeType: "image/png" }), row("/api/json-typed", { mimeType: "application/json" })];
  const d = defaultEndpoints(catalog);
  ok(d.chosen.map((e) => e.path).join() === "/api/search,/api/hash,/api/bytes", `default set = flagship rows in the catalog + the non-JSON listing (${d.chosen.map((e) => e.path).join()})`);
  const many = Array.from({ length: NON_JSON_LISTING_MAX + 3 }, (_, i) => row(`/api/b${i}`, { mimeType: "image/png" }));
  const capped = defaultEndpoints(many);
  ok(capped.nonJson.length === NON_JSON_LISTING_MAX && capped.nonJsonSkipped === 3, `non-JSON listings are capped at ${NON_JSON_LISTING_MAX} and the remainder is counted (${capped.nonJsonSkipped})`);
}

// The guard as the deploy job and the heartbeat run it (no arguments), against
// a stub catalog and a stub validator: a binary listing the validator calls
// INVALID fails the run, and the same catalog passes when it is valid.
{
  const run = async (invalidPath) => {
    const asked = [];
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/pricing") {
          return res.end(JSON.stringify({ endpoints: [
            { method: "GET", path: "/api/hash", slug: "hash", price: "$0.001" },
            { method: "GET", path: "/api/plain", slug: "plain", price: "$0.001" },
            { method: "GET", path: "/api/qr", slug: "qr", price: "$0.001", mimeType: "image/png" },
          ] }));
        }
        if (req.url === "/validate") {
          const { resource } = JSON.parse(body || "{}");
          const path = new URL(resource).pathname;
          asked.push(path);
          const bad = path === invalidPath;
          return res.end(JSON.stringify({ valid: !bad, statusCode: 402, preflight: bad ? [{ check: "resource.mimeType", passed: false, severity: "required", detail: "stub rejection" }] : [], simulation: { outcome: bad ? "rejected" : "accepted" }, index: { active: true } }));
        }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    let out = "";
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bazaar-validate.js", import.meta.url))], { env: { ...process.env, TARGET_URL: base, BAZAAR_VALIDATE_URL: `${base}/validate`, BAZAAR_VALIDATE_CONCURRENCY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const code = await new Promise((r) => child.on("exit", r));
    await new Promise((r) => stub.close(r));
    return { code, asked, out };
  };
  const bad = await run("/api/qr");
  ok(bad.asked.includes("/api/qr") && !bad.asked.includes("/api/plain"), `a no-argument run validates the binary listing and no plain non-flagship row (asked ${bad.asked.join()})`);
  ok(bad.code === 1 && /FAIL GET \/api\/qr/.test(bad.out), `an INVALID binary listing fails the run (exit ${bad.code})`);
  const good = await run(null);
  ok(good.code === 0 && good.asked.length === 2, `control: the same catalog passes when the validator accepts it (exit ${good.code}, ${good.asked.length} calls)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
