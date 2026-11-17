#!/usr/bin/env node
// A keyless public upstream's 5xx passes a sweep only when the runner's own
// direct read of the same request fails too (scripts/lib/upstream-outage.js,
// scripts/lib/upstream-failure-log-preload.js, scripts/live-public-data-check.js).
// Offline: loopback stub upstreams, a stub kit tree, and a child process that
// loads the preload. Our own 5xx with a healthy upstream fails.
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  isUpstreamErrorShape, isKeyedRequest, upstreamHostsForSlug, failuresBetween,
  directReadFails, upstreamOutageVerdict,
} from "./lib/upstream-outage.js";
import { runCheck, CHECKS } from "./live-public-data-check.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} - ${msg}`); if (!cond) failed++; };

const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const up = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"features":[]}'); });
const down = await listen((req, res) => { res.writeHead(503); res.end("busy"); });
const notFound = await listen((req, res) => { res.writeHead(404); res.end("no"); });
const at = (s, p = "/alerts/active?area=CA") => `http://127.0.0.1:${s.address().port}${p}`;

const work = mkdtempSync(join(tmpdir(), "upstream-outage-"));
try {
  // ---- shapes: only the shared fetch helper's upstream-failure answers
  const relayed = { error: "Source URL's host returned HTTP 503 - upstream issue, try again later" };
  ok(isUpstreamErrorShape(502, relayed), "a relayed upstream 5xx (502) is an upstream-error answer");
  ok(isUpstreamErrorShape(504, { error: "Source URL did not respond within our 15 s limit; check that the URL is correct and publicly reachable, or retry" }), "an upstream timeout (504) is an upstream-error answer");
  ok(isUpstreamErrorShape(504, { error: "Could not connect to source URL: fetch failed (ECONNRESET); check that the URL is correct" }), "an upstream connect failure (504) is an upstream-error answer");
  ok(!isUpstreamErrorShape(500, relayed) && !isUpstreamErrorShape(500, { error: "Internal error" }), "our 500 is never an upstream-error answer");
  ok(!isUpstreamErrorShape(502, { error: "Upstream returned non-JSON" }) && !isUpstreamErrorShape(503, { error: "Weather data is temporarily unavailable because of a service problem on our side" }), "our parse 502 and our own 503 are never upstream-error answers");
  ok(!isUpstreamErrorShape(200, { alerts: [] }) && !isUpstreamErrorShape(502, null), "a 200 or an empty body is not one");

  // ---- keyed requests are never re-read
  ok(isKeyedRequest(new URL("https://h.example/x?api_key=1"), {}) && isKeyedRequest(new URL("https://h.example/x?token=1"), {}), "a key-like query parameter marks the request keyed");
  ok(isKeyedRequest(new URL("https://h.example/x"), { Authorization: "Bearer x" }) && isKeyedRequest(new URL("https://h.example/x"), new Headers({ "x-api-key": "k" })), "a credential header (object or Headers) marks it keyed");
  ok(!isKeyedRequest(new URL("https://api.weather.gov/alerts/active?area=CA"), { "User-Agent": "a", Accept: "b", "If-None-Match": "c" }), "a keyless request with the fetch helper's own headers is keyless");

  // ---- hosts are derived from the tool definitions in src/tools/
  ok(upstreamHostsForSlug("weather-alerts").has("api.weather.gov"), "weather-alerts' upstream host (api.weather.gov) is read from its definition");
  ok(upstreamHostsForSlug("earthquakes").has("earthquake.usgs.gov"), "earthquakes' upstream host (earthquake.usgs.gov) is read from its definition");
  ok([...upstreamHostsForSlug("weather-current")].some((h) => h.endsWith("open-meteo.com")), "weather-current's upstream host is an Open-Meteo host from the weather kit");
  ok(!upstreamHostsForSlug("weather-alerts").has("earthquake.usgs.gov"), "a tool's hosts are its own definition's, not its kit neighbors'");
  ok(upstreamHostsForSlug("no-such-tool-slug").size === 0, "an unknown slug names no host");
  for (const c of CHECKS) ok(upstreamHostsForSlug(c.slug).size > 0, `the live check for ${c.slug} has a derived upstream host`);

  // ---- a stub kit tree whose tool reads the loopback stub host
  const kitRoot = join(work, "root");
  mkdirSync(join(kitRoot, "src", "tools"), { recursive: true });
  writeFileSync(join(kitRoot, "src", "tools", "stub-kit.js"), `export const T = [{ route: "GET /api/stub", slug: "stub-tool", handler: () => getJson("http://127.0.0.1:1/alerts") }, { route: "GET /api/other", slug: "other-tool", handler: () => getJson("https://other.example/x") }];\n`);
  const log = join(work, "failures.jsonl");
  const row = (o) => writeFileSync(log, `${JSON.stringify({ t: 1000, host: "127.0.0.1", method: "GET", keyed: false, status: 503, ...o })}\n`, { flag: "a" });

  const verdictFor = async (o) => (await upstreamOutageVerdict({ slug: "stub-tool", status: 502, body: relayed, t0: 900, t1: 1100, logPath: log, root: kitRoot, ...o })).verdict;

  rmSync(log, { force: true }); row({ url: at(down) });
  ok(await verdictFor({}) === "upstream", "(stub) relayed 5xx + failure recorded in the call + the runner's direct read refused too: excused");
  rmSync(log, { force: true }); row({ url: at(up) });
  ok(await verdictFor({}) === "fail", "(stub) relayed 5xx while the upstream answers the runner's direct read: FAILS (ours)");
  rmSync(log, { force: true }); row({ url: at(notFound) });
  ok(await verdictFor({}) === "fail", "(stub) the runner's direct read answers 404 (our request is wrong, not an outage): FAILS");
  rmSync(log, { force: true }); row({ url: at(down) });
  ok(await verdictFor({ status: 500, body: { error: "Internal error" } }) === "fail", "(stub) our own 500 fails even while the upstream refuses the runner");
  ok(await verdictFor({ status: 502, body: { error: "Upstream returned non-JSON" } }) === "fail", "(stub) our own parse 502 fails even while the upstream refuses the runner");
  ok(await verdictFor({ t0: 1200, t1: 1300 }) === "fail", "(stub) a failure recorded outside the call's window excuses nothing");
  ok(await verdictFor({ slug: "other-tool" }) === "fail", "(stub) a failure on a host the tool's definition does not name excuses nothing");
  ok(await verdictFor({ logPath: join(work, "missing.jsonl") }) === "fail", "(stub) no failure log (server booted without the preload) excuses nothing");
  rmSync(log, { force: true }); row({ keyed: true });
  ok(await verdictFor({}) === "fail", "(stub) a keyed request is never re-read and excuses nothing");
  rmSync(log, { force: true }); row({ url: at(down), method: "POST" });
  ok(await verdictFor({}) === "fail", "(stub) a POST is never re-sent and excuses nothing");
  ok(await directReadFails(at(down)) === true && await directReadFails(at(up)) === false && await directReadFails("http://127.0.0.1:1/") === true, "the runner's direct read: 503 and no answer fail, 200 answers");

  // ---- the preload records failed outbound requests, keyed ones without their URL
  const plog = join(work, "preload.jsonl");
  const child = `
    await fetch(${JSON.stringify(at(down))}).catch(() => {});
    await fetch(${JSON.stringify(at(up))}).catch(() => {});
    await fetch(${JSON.stringify(at(down, "/x?api_key=SECRETVALUE"))}).catch(() => {});
    await fetch(${JSON.stringify(at(down, "/h"))}, { headers: { Authorization: "Bearer SECRETVALUE" } }).catch(() => {});
    await fetch("http://127.0.0.1:1/").catch(() => {});
  `;
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", join(ROOT, "scripts/lib/upstream-failure-log-preload.js"), "--input-type=module", "-e", child], { env: { ...process.env, UPSTREAM_FAILURE_LOG: plog }, stdio: "inherit" });
    p.on("exit", resolve);
  });
  ok(code === 0, "the preload child ran");
  const text = existsSync(plog) ? readFileSync(plog, "utf8") : "";
  const rows = failuresBetween(0, Date.now() + 1, plog);
  const byUrl = rows.filter((r) => !r.keyed);
  ok(rows.length === 4, `only failed requests are logged: 503 x3 and one with no answer, never the 200 (${rows.length} rows)`);
  ok(byUrl.length === 2 && byUrl.some((r) => r.url === at(down) && r.status === 503) && byUrl.some((r) => r.error && r.url.startsWith("http://127.0.0.1:1/")), "a keyless failure is logged with its URL and status or error");
  ok(rows.filter((r) => r.keyed).length === 2 && rows.filter((r) => r.keyed).every((r) => !("url" in r)), "a keyed failure (query key or credential header) is logged by host only");
  ok(!text.includes("SECRETVALUE"), "no credential reaches the log");

  // ---- the live-sites step: pass, outage, our defect
  const stubCheck = { slug: "stub-tool", path: "/api/stub", pass: (b) => Array.isArray(b?.alerts) };
  process.env.LIVE_CHECK_RETRY_MS = "0";
  const fixed = (status, body) => async () => ({ status, body, t0: 900, t1: 1100 });
  const verdict = (url) => async (a) => { rmSync(log, { force: true }); row({ url }); return upstreamOutageVerdict({ ...a, logPath: log, root: kitRoot }); };
  ok((await runCheck(stubCheck, { callTool: fixed(200, { alerts: [] }), verdict: verdict(at(down)) })).outcome === "pass", "(live check) a 200 with alerts passes");
  ok((await runCheck(stubCheck, { callTool: fixed(502, relayed), verdict: verdict(at(down)) })).outcome === "upstream", "(live check) an upstream outage the runner sees too passes with a warning");
  ok((await runCheck(stubCheck, { callTool: fixed(502, relayed), verdict: verdict(at(up)) })).outcome === "fail", "(live check) the same answer while the upstream answers the runner FAILS");
  ok((await runCheck(stubCheck, { callTool: fixed(200, { nope: 1 }), verdict: verdict(at(down)) })).outcome === "fail", "(live check) a malformed 200 FAILS");
  ok((await runCheck(stubCheck, { callTool: fixed(500, { error: "Internal error" }), verdict: verdict(at(down)) })).outcome === "fail", "(live check) our own 500 FAILS while the upstream is down");

  // ---- wiring: both CI boots load the preload, the live step runs the check
  const yml = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
  const boots = yml.split("\n").filter((l) => /--import \.\/scripts\/lib\/upstream-failure-log-preload\.js src\/server\.js/.test(l));
  ok(boots.length >= 2, `the strict sweep's and the live-sites step's servers load the failure-log preload (${boots.length} boots)`);
  ok(/node scripts\/live-public-data-check\.js/.test(yml) && !/weather-alerts malformed/.test(yml), "the live-sites step runs live-public-data-check.js, not a bare curl assert");
  const sweep = readFileSync(join(ROOT, "scripts/test-non-metered-examples.js"), "utf8");
  ok(sweep.includes("upstreamOutageVerdict(") && sweep.includes("upstream-failure-log-preload.js"), "the strict sweep reads the outage verdict and boots its own server with the preload");
} finally {
  for (const s of [up, down, notFound]) s.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
