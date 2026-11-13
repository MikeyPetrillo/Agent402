// Offline guard for scripts/bazaar-validate.js (stub validator, no network).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateOne, FLAGSHIP_PATHS, defaultEndpoints, NON_JSON_LISTING_MAX, runDeadlineMs } from "./bazaar-validate.js";

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
  const run = async (invalidPath, { throttled = false, env = {} } = {}) => {
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
          if (throttled) { res.statusCode = 429; res.setHeader("retry-after", "60"); return res.end(""); }
          const bad = path === invalidPath;
          return res.end(JSON.stringify({ valid: !bad, statusCode: 402, preflight: bad ? [{ check: "resource.mimeType", passed: false, severity: "required", detail: "stub rejection" }] : [], simulation: { outcome: bad ? "rejected" : "accepted" }, index: { active: true } }));
        }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    let out = "";
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bazaar-validate.js", import.meta.url))], { env: { ...process.env, TARGET_URL: base, BAZAAR_VALIDATE_URL: `${base}/validate`, BAZAAR_VALIDATE_CONCURRENCY: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    // A run that outlives this is stopped and reads as a failure (code null).
    const stop = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await new Promise((r) => child.on("exit", r));
    clearTimeout(stop);
    await new Promise((r) => stub.close(r));
    return { code, asked, out };
  };
  const bad = await run("/api/qr");
  ok(bad.asked.includes("/api/qr") && !bad.asked.includes("/api/plain"), `a no-argument run validates the binary listing and no plain non-flagship row (asked ${bad.asked.join()})`);
  ok(bad.code === 1 && /FAIL GET \/api\/qr/.test(bad.out), `an INVALID binary listing fails the run (exit ${bad.code})`);
  const good = await run(null);
  ok(good.code === 0 && good.asked.length === 2, `control: the same catalog passes when the validator accepts it (exit ${good.code}, ${good.asked.length} calls)`);

  // A validator that answers 429 with Retry-After 60 to every call: the run
  // ends at its deadline with every route unreadable (exit 2, which the
  // callers warn on), instead of waiting a minute per retry per route. The
  // retries are set here: this file zeroes them in its own environment above.
  const t0 = Date.now();
  const slow = await run(null, { throttled: true, env: { BAZAAR_VALIDATE_DEADLINE_MS: "1500", BAZAAR_VALIDATE_429_RETRIES: "4" } });
  const took = Date.now() - t0;
  ok(slow.code === 2 && took < 20_000, `a throttled validator ends the run at its deadline with exit 2 (exit ${slow.code}, ${took} ms)`);
  ok((slow.out.match(/^\?\? .*run deadline reached/gm) || []).length === 2 && !/BAZAAR VALIDATION OK/.test(slow.out), "every route the deadline cut is reported unreadable, never valid");
  ok(runDeadlineMs(false, {}) === 480_000 && runDeadlineMs(true, {}) === 0 && runDeadlineMs(false, { BAZAAR_VALIDATE_DEADLINE_MS: "90000" }) === 90_000 && runDeadlineMs(true, { BAZAAR_VALIDATE_DEADLINE_MS: "0" }) === 0 && runDeadlineMs(false, { BAZAAR_VALIDATE_DEADLINE_MS: "junk" }) === 480_000, "the deadline defaults to 8 minutes (none for --all) and BAZAAR_VALIDATE_DEADLINE_MS overrides it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
