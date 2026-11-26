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
  isUpstreamErrorShape, isKeyedRequest, upstreamHostsForSlug, failuresBetween, requestMatchesDefinition,
  directReadFails, directReadStatus, upstreamOutageVerdict, accessRefusalStatus,
  bundleLegAnswer, bundleOutageVerdict, declaresUpstreamHosts, legRefusalStatus,
  hollowAnswerVerdict, HOLLOW_READS,
} from "./lib/upstream-outage.js";
import { BUNDLE_LEGS } from "../src/tools/bundle-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { isHost } from "./lib/url-host.js";
import { runCheck, CHECKS } from "./live-public-data-check.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} - ${msg}`); if (!cond) failed++; };

const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const up = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"features":[]}'); });
const down = await listen((req, res) => { res.writeHead(503); res.end("busy"); });
const notFound = await listen((req, res) => { res.writeHead(404); res.end("no"); });
const forbidden = await listen((req, res) => { res.writeHead(403); res.end("blocked"); });
const unauth = await listen((req, res) => { res.writeHead(401); res.end("who"); });
const limited = await listen((req, res) => { res.writeHead(429, { "retry-after": "60" }); res.end("slow down"); });
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
  // cert-transparency's own words for its log's deadline and 5xx or 429.
  const ctLate = { error: "The upstream cert transparency log did not respond within 10 s; try again later" };
  ok(isUpstreamErrorShape(502, ctLate) && isUpstreamErrorShape(502, { error: "crt.sh returned HTTP 503" }) && isUpstreamErrorShape(502, { error: "crt.sh returned HTTP 429" }), "cert-transparency's log deadline and 5xx/429 answers (502) are upstream-error answers");
  ok(!isUpstreamErrorShape(502, { error: "crt.sh returned HTTP 404" }) && !isUpstreamErrorShape(502, { error: "crt.sh returned non-JSON - try again later" }) && !isUpstreamErrorShape(422, { error: "crt.sh returned HTTP 400" }), "control: its mislabelled 404, its parse failure and a 4xx it relays are not");
  ok(JSON.stringify([...upstreamHostsForSlug("cert-transparency")]) === JSON.stringify(["crt.sh"]), `cert-transparency declares the keyless log it reads (${[...upstreamHostsForSlug("cert-transparency")].join(", ")})`);
  {
    const ctLog = join(work, "ct-failures.jsonl");
    const ctUrl = "https://crt.sh/?q=%25.example.com&output=json&exclude=expired";
    writeFileSync(ctLog, `${JSON.stringify({ t: 1000, host: "crt.sh", url: ctUrl, method: "GET", keyed: false, error: "AbortError" })}\n`);
    const ct = (o) => upstreamOutageVerdict({ slug: "cert-transparency", status: 502, body: ctLate, t0: 900, t1: 1100, logPath: ctLog, ...o });
    let readUrl = null;
    const v1 = await ct({ readFails: async (u) => { readUrl = u; return true; } });
    ok(v1.verdict === "upstream" && readUrl === ctUrl, `cert-transparency's log deadline, recorded in the call and refused to the runner's direct read of the same request: excused (${v1.evidence || v1.reason})`);
    const v2 = await ct({ readFails: async () => false });
    ok(v2.verdict === "fail", `control: the same answer while crt.sh answers the runner's direct read FAILS (${v2.reason})`);
    const v3 = await ct({ t0: 1200, t1: 1300, readFails: async () => true });
    ok(v3.verdict === "fail", "control: no crt.sh failure recorded during the call excuses nothing");
  }

  // ---- keyed requests are never re-read
  ok(isKeyedRequest(new URL("https://h.example/x?api_key=1"), {}) && isKeyedRequest(new URL("https://h.example/x?token=1"), {}), "a key-like query parameter marks the request keyed");
  ok(isKeyedRequest(new URL("https://h.example/x"), { Authorization: "Bearer x" }) && isKeyedRequest(new URL("https://h.example/x"), new Headers({ "x-api-key": "k" })), "a credential header (object or Headers) marks it keyed");
  ok(!isKeyedRequest(new URL("https://api.weather.gov/alerts/active?area=CA"), { "User-Agent": "a", Accept: "b", "If-None-Match": "c" }), "a keyless request with the fetch helper's own headers is keyless");
  // A key in the URL path: by host, or by a configured credential's value.
  ok(isKeyedRequest(new URL("https://base-mainnet.g.alchemy.com/v2/abc"), {}, {}), "a host that takes its key in the path marks the request keyed");
  const env = { SOME_API_KEY: "pathSecretValue12345", PLAIN: "pathSecretValue12345x" };
  ok(isKeyedRequest(new URL("https://rpc.example/v1/pathSecretValue12345/call"), {}, env) && isKeyedRequest(new URL("https://rpc.example/q?x=pathSecretValue12345"), {}, env), "a configured credential's value in a path segment or a query value marks the request keyed");
  ok(!isKeyedRequest(new URL("https://rpc.example/v1/public/call"), {}, env) && !isKeyedRequest(new URL("https://rpc.example/v1/pathSecretValue1234/call"), {}, { SOME_API_KEY: "short" }), "control: a URL without the value, or a value too short to be a credential, stays keyless");

  // ---- a URL we built wrong is ours, whatever the upstream answers
  ok(requestMatchesDefinition("weather-alerts", "https://api.weather.gov/alerts/active?area=CA"), "weather-alerts' own request matches the path its definition writes");
  ok(!requestMatchesDefinition("weather-alerts", "https://api.weather.gov/points/1,2"), "a path the definition never writes does not match");
  ok(!requestMatchesDefinition("weather-alerts", "https://api.weather.gov/alerts/active?area=undefined") && !requestMatchesDefinition("weather-alerts", "https://api.weather.gov/alerts/active?area=%5Bobject%20Object%5D") && !requestMatchesDefinition("weather-alerts", "https://api.weather.gov/alerts//active"), "an interpolation's residue (undefined, an object's string form) or an empty segment does not match");

  // ---- hosts are derived from the tool definitions in src/tools/
  ok(upstreamHostsForSlug("weather-alerts").has("api.weather.gov"), "weather-alerts' upstream host (api.weather.gov) is read from its definition");
  ok(upstreamHostsForSlug("earthquakes").has("earthquake.usgs.gov"), "earthquakes' upstream host (earthquake.usgs.gov) is read from its definition");
  ok([...upstreamHostsForSlug("weather-current")].some((h) => h === "open-meteo.com" || h.endsWith(".open-meteo.com")), "weather-current's upstream host is an Open-Meteo host from the weather kit");
  ok(!upstreamHostsForSlug("weather-alerts").has("earthquake.usgs.gov"), "a tool's hosts are its own definition's, not its kit neighbors'");
  ok(upstreamHostsForSlug("no-such-tool-slug").size === 0, "an unknown slug names no host");
  for (const c of CHECKS) ok(upstreamHostsForSlug(c.slug).size > 0, `the live check for ${c.slug} has a derived upstream host`);

  // ---- a stub kit tree whose tool reads the loopback stub host
  const kitRoot = join(work, "root");
  mkdirSync(join(kitRoot, "src", "tools"), { recursive: true });
  writeFileSync(join(kitRoot, "src", "tools", "stub-kit.js"), `export const T = [{ route: "GET /api/stub", slug: "stub-tool", handler: () => getJson("http://127.0.0.1:1/alerts") }, { route: "GET /api/other", slug: "other-tool", handler: () => getJson("https://other.example/x") }, { route: "POST /api/stub-bundle", slug: "stub-bundle", upstreamHosts: ["stub.example"], sources: ["https://cited.example/page"], handler: () => legs() }, made({ slug: "made-tool", upstreamHosts: ["made.example"] }), { route: "GET /api/named", slug: "named-tool", upstreamHosts: NAMED_HOSTS, handler: () => legs() }, { route: "GET /api/unnamed", slug: "unnamed-tool", upstreamHosts: NO_SUCH_LIST, handler: () => legs() }];\n`);
  writeFileSync(join(kitRoot, "src", "tools", "named-endpoint.js"), `export const NAMED_HOSTS = Object.freeze(["named.example", "alt.named.example"]);\n`);
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
  rmSync(log, { force: true }); row({ url: at(down, "/wrong/place") });
  ok(await verdictFor({}) === "fail", "(stub) a 5xx to a path the definition never builds, refused to the runner too, is ours: FAILS");
  rmSync(log, { force: true }); row({ url: at(down, "/alerts/undefined") });
  ok(await verdictFor({}) === "fail", "(stub) a 5xx to a URL with an interpolation's residue is ours: FAILS");
  rmSync(log, { force: true }); row({ url: at(down), method: "POST" });
  ok(await verdictFor({}) === "fail", "(stub) a POST is never re-sent and excuses nothing");
  // ---- an access refusal: excused only when the runner gets the same status
  const refusedBody = (n) => ({ error: `The host refused this server's request (HTTP ${n}) - this is access, not a bad URL: the resource may require credentials we do not hold, or the host may block this server's requests while serving yours` });
  ok(accessRefusalStatus(422, refusedBody(403)) === 403 && accessRefusalStatus(422, refusedBody(401)) === 401, "our access-refusal 422 names the upstream status (403, 401)");
  ok(accessRefusalStatus(503, { error: "The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at h; retry later" }) === 429, "our rate-limit 503 names the upstream 429");
  ok(accessRefusalStatus(503, { error: "The host rate-limited or timed out this server (HTTP 408) - the URL is fine" }) === null && accessRefusalStatus(500, refusedBody(403)) === null && accessRefusalStatus(422, { error: "Source URL returned HTTP 404 - check the URL" }) === null, "a 408, a 500 with the words, or a caller 404 is not an access refusal");
  const refusedFor = (n, o = {}) => verdictFor({ status: 422, body: refusedBody(n), ...o });
  rmSync(log, { force: true }); row({ url: at(forbidden), status: 403 });
  ok(await refusedFor(403) === "upstream", "(stub) a 403 refusal recorded in the call + the runner's direct read refused 403 too: excused");
  rmSync(log, { force: true }); row({ url: at(up), status: 403 });
  ok(await refusedFor(403) === "fail", "(stub) a 403 refusal while the host answers the runner's direct read 200: FAILS");
  rmSync(log, { force: true }); row({ url: at(unauth), status: 403 });
  ok(await refusedFor(403) === "fail", "(stub) a 403 refusal while the runner's direct read gets a different refusal (401): FAILS");
  rmSync(log, { force: true }); row({ url: at(down), status: 403 });
  ok(await refusedFor(403) === "fail", "(stub) a 403 refusal while the runner's direct read gets a 503: FAILS");
  rmSync(log, { force: true }); row({ url: at(forbidden), status: 503 });
  ok(await refusedFor(403) === "fail", "(stub) a 403 answer with only a 5xx recorded in the call excuses nothing");
  rmSync(log, { force: true }); row({ url: at(forbidden), status: 403, method: "POST" });
  ok(await refusedFor(403) === "fail", "(stub) a refused POST is never re-sent and excuses nothing");
  rmSync(log, { force: true }); row({ status: 403, keyed: true });
  ok(await refusedFor(403) === "fail", "(stub) a refused keyed request is never re-read and excuses nothing");
  rmSync(log, { force: true }); row({ url: at(forbidden), status: 403 });
  ok(await refusedFor(403, { slug: "other-tool" }) === "fail", "(stub) a refusal on a host the tool's definition does not name excuses nothing");
  ok(await verdictFor({}) === "fail", "(stub) a relayed 5xx with only a 403 recorded in the call excuses nothing");
  ok(await directReadStatus(at(forbidden)) === 403 && await directReadStatus("http://127.0.0.1:1/") === 0, "the runner's direct read status: 403 as answered, 0 for no answer");

  // ---- a bundle product's failure is read as its leg's, against the hosts the bundle declares
  {
    const limitedWords = "The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at api.open-meteo.com; retry later";
    const bundleBody = (leg, words, unit = "Chicago DC") => ({ error: `6 of 6 unit(s) could not be completed on the source's side (first: ${unit}, ${leg}: ${words}). Nothing was charged. Retry later.` });
    const legs = ["stub-tool", "other-tool"];
    const inner = bundleLegAnswer(503, bundleBody("stub-tool", limitedWords), legs);
    ok(inner?.leg === "stub-tool" && inner.status === 503 && inner.body.error === limitedWords, "a bundle's source-side failure names its leg and carries the leg's own message");
    ok(bundleLegAnswer(503, bundleBody("stub-tool", limitedWords, "41.88,-87.63"), legs)?.leg === "stub-tool" && bundleLegAnswer(503, bundleBody("stub-tool", limitedWords, "A, other-tool: B"), legs)?.leg === "other-tool", "the leg is the first one the answer names after the unit, whatever the unit's label holds");
    ok(bundleLegAnswer(503, bundleBody("unknown-tool", limitedWords), legs) === null && bundleLegAnswer(503, bundleBody("stub-tool", limitedWords), []) === null && bundleLegAnswer(503, { error: limitedWords }, legs) === null, "a leg the bundle does not run, a tool with no legs, or an answer in other words is not a bundle failure");
    ok(bundleLegAnswer(500, bundleBody("stub-tool", limitedWords), legs) === null && bundleLegAnswer(422, { error: "2 of 6 input(s) could not be read: X (bad). Fix or remove them and send again; nothing was charged" }, legs) === null, "a 500 in those words, or the bundle's caller-input 422, is not one");
    const row0 = row;
    // The bundle declares a named host; the stub rows carry it and a loopback URL to re-read.
    const brow = (o) => row0({ host: "stub.example", ...o });
    const bundleFor = (o = {}) => bundleOutageVerdict({ slug: "stub-bundle", legs, status: 503, body: bundleBody("stub-tool", limitedWords), t0: 900, t1: 1100, logPath: log, root: kitRoot, ...o });
    rmSync(log, { force: true }); brow({ url: at(limited), status: 429 });
    const excused = await bundleFor();
    ok(excused?.verdict === "upstream" && excused.leg === "stub-tool", "(stub) a bundle whose leg was rate-limited (429 recorded in the call) while the runner's direct read gets 429 too: excused, leg named");
    rmSync(log, { force: true }); brow({ url: at(up), status: 429 });
    ok((await bundleFor())?.verdict === "fail", "(stub) a bundle whose leg was rate-limited while the host answers the runner's direct read 200: FAILS");
    rmSync(log, { force: true }); brow({ url: at(down), status: 429 });
    ok((await bundleFor())?.verdict === "fail", "(stub) a bundle's 429 while the runner's direct read gets a 503: FAILS");
    rmSync(log, { force: true }); brow({ url: at(limited), status: 429, keyed: true });
    ok((await bundleFor())?.verdict === "fail", "(stub) a bundle's 429 on a keyed request is never re-read: FAILS");
    rmSync(log, { force: true }); brow({ url: at(limited), status: 429, host: "undeclared.example" });
    ok((await bundleFor())?.verdict === "fail", "(stub) a 429 from a host the bundle does not declare excuses nothing");
    rmSync(log, { force: true }); brow({ url: at(limited, "/wrong/place"), status: 429 });
    ok((await bundleFor())?.verdict === "fail", "(stub) a 429 to a path the leg's definition never builds is ours: FAILS");
    rmSync(log, { force: true }); brow({ url: at(down) });
    ok((await bundleFor({ status: 502, body: bundleBody("stub-tool", relayed.error) }))?.verdict === "upstream", "(stub) a bundle whose leg relayed an upstream 5xx the runner is refused too: excused");
    rmSync(log, { force: true }); brow({ url: at(up) });
    ok((await bundleFor({ status: 502, body: bundleBody("stub-tool", relayed.error) }))?.verdict === "fail", "(stub) a bundle whose leg relayed a 5xx while the upstream answers the runner: FAILS");
    rmSync(log, { force: true }); brow({ url: at(limited), status: 429 });
    ok(await bundleFor({ body: bundleBody("stub-tool", "Upstream returned non-JSON"), status: 502 }) === null && await bundleFor({ body: { error: "Internal error" }, status: 500 }) === null, "(stub) a leg's own failure, or any other answer of the bundle, is not read as an outage (graded by the other rules)");
    // The declared list is the whole answer: a host the definition only cites is not read.
    ok([...upstreamHostsForSlug("stub-bundle", kitRoot)].join() === "stub.example" && declaresUpstreamHosts("stub-bundle", kitRoot) && !declaresUpstreamHosts("stub-tool", kitRoot), "a declared upstreamHosts list is the tool's hosts, without the hosts it cites");
    ok([...upstreamHostsForSlug("made-tool", kitRoot)].join() === "made.example", "a definition built by a factory (no route literal) is found by its slug");
    ok([...upstreamHostsForSlug("named-tool", kitRoot)].sort().join() === "alt.named.example,named.example" && declaresUpstreamHosts("named-tool", kitRoot), "a declaration that names another module's exported list reads that list's hosts");
    ok(upstreamHostsForSlug("unnamed-tool", kitRoot).size === 0 && !declaresUpstreamHosts("unnamed-tool", kitRoot), "a declaration naming a list no module defines declares no host");

    // The shipped tree: each bundle product is a network tool, declares the
    // hosts its legs read, and every leg is a network tool too.
    for (const [slug, own] of Object.entries(BUNDLE_LEGS)) {
      ok(WALLET_ONLY_SLUGS.has(slug), `${slug} is classed as a network tool (WALLET_ONLY_SLUGS), so a sweep never grades it as pure computation`);
      ok(declaresUpstreamHosts(slug), `${slug} declares the upstream hosts its legs read`);
      ok(own.every((leg) => WALLET_ONLY_SLUGS.has(leg)), `${slug}'s legs are network tools`);
    }
    const hostsOf = (slug) => [...upstreamHostsForSlug(slug)];
    // Membership in the declared host set, read with Set.has: each name is a whole
    // declared host, never a substring of a URL.
    const declares = (slug, host) => upstreamHostsForSlug(slug).has(host);
    ok(["api.open-meteo.com", "archive-api.open-meteo.com", "air-quality-api.open-meteo.com", "ensemble-api.open-meteo.com", "geocoding-api.open-meteo.com"].every((h) => hostsOf("weather-risk-brief").includes(h)), "weather-risk-brief declares every Open-Meteo host its legs read");
    ok(declares("filings-brief", "data.sec.gov") && declares("filings-brief", "efts.sec.gov") && ["api.coingecko.com", "pro-api.coingecko.com"].every((h) => hostsOf("token-diligence").includes(h)), "filings-brief declares the SEC hosts and token-diligence the CoinGecko host");
    for (const slug of ["bank-holidays", "school-holidays", "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar"]) {
      ok(WALLET_ONLY_SLUGS.has(slug) && declaresUpstreamHosts(slug) && declares(slug, "nagerholidays.com") && !declares(slug, "www.opm.gov"), `${slug} is a network tool and declares the holiday source's host, not the pages it cites`);
    }
    for (const slug of ["weather-thresholds", "weather-window", "weather-probability", "weather-market-brackets", "weather-market-board"]) {
      ok(hostsOf(slug).some((h) => h.endsWith(".open-meteo.com")), `${slug} (reads through the weather kit's helper) names an Open-Meteo host`);
    }
    // The exact answer that failed a sweep: the forecast host rate-limited the runner.
    const real = { error: "6 of 6 unit(s) could not be completed on the source's side (first: Chicago DC, weather-thresholds: The host rate-limited or timed out this server (HTTP 429) - the URL is fine, this is throttling at api.open-meteo.com; retry later). Nothing was charged. Retry later." };
    const realRow = { url: "https://api.open-meteo.com/v1/forecast?latitude=41.88&longitude=-87.63&hourly=temperature_2m&forecast_hours=168", host: "api.open-meteo.com", status: 429 };
    const realFor = (got) => bundleOutageVerdict({ slug: "weather-risk-brief", legs: BUNDLE_LEGS["weather-risk-brief"], status: 503, body: real, t0: 900, t1: 1100, logPath: log, readStatus: async () => got });
    rmSync(log, { force: true }); row(realRow);
    ok((await realFor(429))?.verdict === "upstream", "weather-risk-brief's rate-limited leg is excused when the runner's direct read of the same request gets 429 too");
    ok((await realFor(200))?.verdict === "fail", "weather-risk-brief's rate-limited leg FAILS when the forecast host answers the runner's direct read");
    // A leg that reads through its own helper names the limit in that helper's words.
    const cgWords = "Market data upstream rate-limited this request - retry in about 60 seconds";
    ok(legRefusalStatus(503, { error: cgWords }) === 429 && legRefusalStatus(503, { error: limitedWords }) === 429 && legRefusalStatus(502, { error: cgWords }) === null && legRefusalStatus(503, { error: "Market data is not configured on this deployment. You were not charged." }) === null && legRefusalStatus(503, { error: "This server paces its Market data requests and has no room this moment; retry in 1 s." }) === null,
      "a market leg's rate-limit answer reads as the source's 429; its other 503s (not configured, our own pacing) do not");
    const cgBody = { error: `4 of 4 unit(s) could not be completed on the source's side (first: bitcoin, coin-profile: ${cgWords}). Nothing was charged. Retry later.` };
    const cgRow = { url: "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&market_data=true", host: "api.coingecko.com", status: 429 };
    const cgFor = (got, o = {}) => bundleOutageVerdict({ slug: "token-diligence", legs: BUNDLE_LEGS["token-diligence"], status: 503, body: cgBody, t0: 900, t1: 1100, logPath: log, readStatus: async () => got, ...o });
    rmSync(log, { force: true }); row(cgRow);
    const cgExcused = await cgFor(429);
    ok(cgExcused?.verdict === "upstream" && cgExcused.leg === "coin-profile", "token-diligence's rate-limited leg is excused when the runner's direct read of the same request gets 429 too");
    ok((await cgFor(200))?.verdict === "fail", "token-diligence's rate-limited leg FAILS when the market host answers the runner's direct read");
    rmSync(log, { force: true }); row({ ...cgRow, keyed: true, url: undefined });
    ok((await cgFor(429))?.verdict === "fail", "token-diligence's rate-limited leg on a keyed request is never re-read: FAILS");
    rmSync(log, { force: true }); row({ ...cgRow, status: 503 });
    ok((await cgFor(429))?.verdict === "fail", "a rate-limit answer with only a 5xx recorded in the call excuses nothing");
  }

  ok(await directReadFails(at(down)) === true && await directReadFails(at(up)) === false && await directReadFails("http://127.0.0.1:1/") === true, "the runner's direct read: 503 and no answer fail, 200 answers");

  // ---- the preload records failed outbound requests, keyed ones without their URL
  const plog = join(work, "preload.jsonl");
  const child = `
    await fetch(${JSON.stringify(at(down))}).catch(() => {});
    await fetch(${JSON.stringify(at(up))}).catch(() => {});
    await fetch(${JSON.stringify(at(down, "/x?api_key=SECRETVALUE"))}).catch(() => {});
    await fetch(${JSON.stringify(at(down, "/h"))}, { headers: { Authorization: "Bearer SECRETVALUE" } }).catch(() => {});
    await fetch("http://127.0.0.1:1/").catch(() => {});
    await fetch(${JSON.stringify(at(forbidden, "/f"))}, { headers: { Accept: "text/html" } }).catch(() => {});
    await fetch(${JSON.stringify(at(notFound, "/n"))}).catch(() => {});
    await fetch(${JSON.stringify(at(down, "/v2/PATHSECRETVALUE99"))}).catch(() => {});
  `;
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", join(ROOT, "scripts/lib/upstream-failure-log-preload.js"), "--input-type=module", "-e", child], { env: { ...process.env, UPSTREAM_FAILURE_LOG: plog, STUB_RPC_API_KEY: "PATHSECRETVALUE99" }, stdio: "inherit" });
    p.on("exit", resolve);
  });
  ok(code === 0, "the preload child ran");
  const text = existsSync(plog) ? readFileSync(plog, "utf8") : "";
  const rows = failuresBetween(0, Date.now() + 1, plog);
  const byUrl = rows.filter((r) => !r.keyed);
  ok(rows.length === 6, `only failed requests are logged: 503 x4, one with no answer and one 403, never the 200 or the 404 (${rows.length} rows)`);
  ok(byUrl.some((r) => r.status === 403 && r.accept === "text/html" && r.url === at(forbidden, "/f")), "a keyless refusal is logged with its URL, status and Accept header");
  ok(byUrl.length === 3 && byUrl.some((r) => r.url === at(down) && r.status === 503) && byUrl.some((r) => r.error && isHost(r.url, "127.0.0.1") && new URL(r.url).port === "1"), "a keyless failure is logged with its URL and status or error");
  ok(rows.filter((r) => r.keyed).length === 3 && rows.filter((r) => r.keyed).every((r) => !("url" in r)), "a keyed failure (query key, credential header, or a configured key in the path) is logged by host only");
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

  // ---- hollow examples: excused only per tool, only when the runner's direct
  // read of the same request is empty or failing too
  {
    const input = { domain: "agent402.tools" };
    let asked = [];
    const reads = (status, text) => async (u) => { asked.push(u); return { status, text }; };
    // The entry's URL is the one the tool builds for the same input.
    const { NETWORK_TOOLS2 } = await import("../src/tools/network-kit2.js");
    const ct = NETWORK_TOOLS2.find((t) => t.slug === "cert-transparency");
    const realFetch = globalThis.fetch, built = [];
    const savedKey = process.env.CERTSPOTTER_API_KEY;
    delete process.env.CERTSPOTTER_API_KEY;
    globalThis.fetch = async (u) => { built.push(String(u)); return { ok: true, status: 200, text: async () => "[]" }; };
    try { await ct.handler(input); await ct.handler({ ...input, includeExpired: true }); } finally { globalThis.fetch = realFetch; if (savedKey !== undefined) process.env.CERTSPOTTER_API_KEY = savedKey; }
    const entry = HOLLOW_READS["cert-transparency"];
    ok(built[0] === entry.url(input) && built.at(-1) === entry.url({ ...input, includeExpired: true }), `(hollow) the crt.sh read the sweep makes is the one the tool builds (${built[0]})`);
    ok(declaresUpstreamHosts("cert-transparency") && upstreamHostsForSlug("cert-transparency").has("crt.sh"), "(hollow) cert-transparency declares crt.sh");
    let v = await hollowAnswerVerdict({ slug: "cert-transparency", input, read: reads(200, "[]") });
    ok(v?.verdict === "upstream" && /crt\.sh/.test(v.evidence), `(hollow) tool empty and the runner's direct read empty: excused with the reason (${v?.evidence})`);
    for (const [st, text] of [[0, ""], [502, "busy"], [404, "502 Bad Gateway"], [200, '{"error":"busy"}'], [200, "<html>"]]) {
      v = await hollowAnswerVerdict({ slug: "cert-transparency", input, read: reads(st, text) });
      ok(v?.verdict === "upstream", `(hollow) the runner's direct read failing (HTTP ${st || "none"}, ${text.slice(0, 16) || "no body"}) excuses it too`);
    }
    v = await hollowAnswerVerdict({ slug: "cert-transparency", input, read: reads(200, '[{"id":1,"name_value":"agent402.tools"}]') });
    ok(v?.verdict === "fail" && /with rows/.test(v.reason), `(hollow) tool empty while the runner's direct read has rows: FAILS (${v?.reason})`);
    asked = [];
    v = await hollowAnswerVerdict({ slug: "dns-lookup", input, read: reads(200, "[]") });
    ok(v === null && asked.length === 0, "(hollow) a tool with no hollow-read entry is never excused, and nothing is read");
    v = await hollowAnswerVerdict({ slug: "cert-transparency", input: {}, read: reads(200, "[]") });
    ok(v?.verdict === "fail", "(hollow) no direct read built from the input excuses nothing");
    v = await hollowAnswerVerdict({ slug: "stub-tool", input, read: reads(200, "[]"), reads: { "stub-tool": entry }, root: kitRoot });
    ok(v?.verdict === "fail" && /does not declare crt\.sh/.test(v.reason), "(hollow) an entry for a tool that does not declare its host excuses nothing");
    ok(Object.keys(HOLLOW_READS).join() === "cert-transparency", "(hollow) only cert-transparency holds a hollow-read entry");
  }

  // ---- wiring: the strict sweep grades a bundle's failure by the bundle rule
  // after the pure-computation grade and before its rate-limit skip
  {
    const sweepSrc = readFileSync(join(ROOT, "scripts/test-non-metered-examples.js"), "utf8");
    const pure = sweepSrc.indexOf("if (isPureCpuSlug(t.slug)) {"), graded = sweepSrc.indexOf("await bundleFailureGrade(t, r)"), skip = sweepSrc.indexOf("if (isRateLimited(r.status, r.body, r.threw)) {");
    ok(pure > 0 && graded > pure && skip > graded, "the strict sweep reads a bundle's failure against the runner before its rate-limit skip");
  }
  // ---- wiring: both CI boots load the preload, the live step runs the check
  const yml = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
  const boots = yml.split("\n").filter((l) => /--import \.\/scripts\/lib\/upstream-failure-log-preload\.js src\/server\.js/.test(l));
  ok(boots.length >= 2, `the strict sweep's and the live-sites step's servers load the failure-log preload (${boots.length} boots)`);
  ok(/node scripts\/live-public-data-check\.js/.test(yml) && !/weather-alerts malformed/.test(yml), "the live-sites step runs live-public-data-check.js, not a bare curl assert");
  const sweep = readFileSync(join(ROOT, "scripts/test-non-metered-examples.js"), "utf8");
  ok(sweep.includes("upstreamOutageVerdict(") && sweep.includes("upstream-failure-log-preload.js"), "the strict sweep reads the outage verdict and boots its own server with the preload");
  ok(/if \(hollow\.length\) \{\s*const g = await hollowGrade\(t, hollow\)/.test(sweep), "the strict sweep grades an empty documented array by the hollow-read rule");
} finally {
  for (const s of [limited, up, down, notFound, forbidden, unauth]) s.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
