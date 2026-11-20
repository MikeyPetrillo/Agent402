// Open-Meteo host and key selection (src/tools/weather-kit.js), offline.
//
//   1. openMeteoRequest: with OPEN_METEO_API_KEY set, every API reads its
//      "customer-" host with `apikey`; without it, the public host and no key.
//   2. Each weather tool, with a stubbed fetch and resolver: the URL it fetched
//      (host and key), and an answer whose `source` names the public host only.
//   3. A 429 on the keyed host is a 503 (no charge), fetched once: no retry and
//      no second try on the public host. A 401/403 there, or a 400 whose
//      reason names the key or a plan (Open-Meteo's answer to an invalid or
//      revoked key), is our 503: not charged, not shed (the tool-failure
//      monitor counts it), one operator log line. A 400 for a real bad input
//      stays the buyer's 4xx. A 5xx keeps its one retry on the keyed host.
//   3b. The openMeteo word follows the last keyed outcome: unknown until the
//      first one, ok on a keyed success, refused on two keyed refusals in a
//      row or one 400 whose reason names the API key, and no change with time.
//   4. No error message, error field or console line carries the key or the
//      keyed host name, and redactSecrets drops an apikey query value from any
//      URL in text, configured or not.
//
//   node scripts/test-open-meteo-keyed.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";

let pass = 0, fail = 0;
const lines = [];
const ok = (cond, msg) => { if (cond) { pass++; lines.push(`ok - ${msg}`); } else { fail++; lines.push(`FAIL - ${msg}`); } };

// Every console line the kit (or anything it calls) writes, kept and scanned.
const captured = [];
const realConsole = {};
for (const m of ["log", "info", "warn", "error", "debug"]) {
  realConsole[m] = console[m];
  console[m] = (...args) => { captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
}

const KEY = "omk" + "Zx7Qp2Lw9Rt4Vb8Nc3";
delete process.env.OPEN_METEO_API_KEY;
const { WEATHER_TOOLS, openMeteoRequest, openMeteoStatus, _resetOpenMeteoStatus } = await import("../src/tools/weather-kit.js");
const { redactSecrets } = await import("../src/tools/redact.js");

const restoreResolver = stubGuardResolver((host, family) => (/(^|\.)open-meteo\.com$/.test(host) ? (family === 4 ? ["93.184.216.34"] : []) : undefined));

// --- 1. URL selection ---
const P = { latitude: 1, longitude: 2 };
for (const [api, path, pub] of [
  ["forecast", "/v1/forecast", "api.open-meteo.com"],
  ["archive", "/v1/archive", "archive-api.open-meteo.com"],
  ["airQuality", "/v1/air-quality", "air-quality-api.open-meteo.com"],
]) {
  const free = new URL(openMeteoRequest(api, path, P, {}).url);
  ok(free.host === pub && !free.searchParams.has("apikey") && free.pathname === path, `${api}: no key -> ${pub}, no apikey`);
  const blank = new URL(openMeteoRequest(api, path, P, { OPEN_METEO_API_KEY: "  " }).url);
  ok(blank.host === pub && !blank.searchParams.has("apikey"), `${api}: blank key -> public host`);
  const r = openMeteoRequest(api, path, P, { OPEN_METEO_API_KEY: KEY });
  const keyed = new URL(r.url);
  ok(keyed.host === `customer-${pub}` && keyed.searchParams.get("apikey") === KEY && keyed.searchParams.get("latitude") === "1", `${api}: key -> customer-${pub} with apikey`);
  ok(r.publicHost === pub && r.keyed === true, `${api}: public host kept for messages`);
}

// --- 2. Each tool's fetch ---
const fetched = [];
let reply = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;
// A real response names the URL it answered for; safeFetch's messages read it.
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const r = await reply(String(url));
  Object.defineProperty(r, "url", { value: String(url) });
  return r;
};

const BODY = {
  current: { time: "2026-01-01T00:00", temperature_2m: 1, weather_code: 0, us_aqi: 10, pm2_5: 1 },
  daily: { time: ["2026-01-01"], weather_code: [0], temperature_2m_max: [2], temperature_2m_min: [1], sunrise: ["2026-01-01T07:00"], sunset: ["2026-01-01T17:00"] },
  hourly: { time: ["2026-01-01T00:00"], temperature_2m: [1], weather_code: [0] },
};
reply = () => new Response(JSON.stringify(BODY), { status: 200, headers: { "content-type": "application/json" } });
const EXPECT = {
  "weather-current": "api.open-meteo.com",
  "weather-daily": "api.open-meteo.com",
  "weather-hourly": "api.open-meteo.com",
  "weather-history": "archive-api.open-meteo.com",
  "weather-air-quality": "air-quality-api.open-meteo.com",
};
const tool = (slug) => WEATHER_TOOLS.find((t) => t.slug === slug);
for (const keyed of [false, true]) {
  if (keyed) process.env.OPEN_METEO_API_KEY = KEY; else delete process.env.OPEN_METEO_API_KEY;
  for (const [slug, pub] of Object.entries(EXPECT)) {
    fetched.length = 0;
    const t = tool(slug);
    const out = await t.handler(t.discovery.input);
    const u = new URL(fetched[0]);
    const sendsKey = keyed;
    const want = sendsKey ? `customer-${pub}` : pub;
    ok(fetched.length === 1 && u.host === want, `${slug} (${keyed ? "key" : "no key"}): fetched ${u.host}`);
    ok(sendsKey ? u.searchParams.get("apikey") === KEY : !u.searchParams.has("apikey"), `${slug} (${keyed ? "key" : "no key"}): apikey ${sendsKey ? "sent" : "absent"}`);
    const text = JSON.stringify(out);
    ok(!text.includes(KEY) && !text.includes("customer-") && /open-meteo\.com \(CC BY 4\.0\)/.test(out.source), `${slug} (${keyed ? "key" : "no key"}): answer names the public host only`);
  }
}

// --- 2b. Copernicus credits (src/data-attribution.js) ---
{
  const { ATTRIBUTIONS, CAMS_CREDIT, C3S_CREDIT, attributionTailOf } = await import("../src/data-attribution.js");
  const DISCLAIMER = "Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.";
  ok(CAMS_CREDIT === `Contains modified Copernicus Atmosphere Monitoring Service information (CAMS ENSEMBLE data provider). ${DISCLAIMER}`, "air quality credit: modified CAMS information, the CAMS ENSEMBLE data provider, the clause 5.1.3 disclaimer");
  ok(C3S_CREDIT === `Contains modified Copernicus Climate Change Service information. ${DISCLAIMER}`, "archive credit: modified C3S information, the clause 5.1.3 disclaimer");
  ok(ATTRIBUTIONS["open-meteo-cams"] === `Weather data by Open-Meteo.com (CC BY 4.0). ${CAMS_CREDIT}` && ATTRIBUTIONS["open-meteo-c3s"] === `Weather data by Open-Meteo.com (CC BY 4.0). ${C3S_CREDIT}`, "both combined credits end with the disclaimer");
  ok(/from 1940 to the most recent days/.test(tool("weather-history").description) && !/5 days ago/.test(tool("weather-history").description), "weather-history: the archive range reaches the most recent days");
  for (const [slug, key, credit] of [["weather-air-quality", "open-meteo-cams", CAMS_CREDIT], ["weather-history", "open-meteo-c3s", C3S_CREDIT]]) {
    const t = tool(slug);
    ok(t.attribution === key && attributionTailOf(t.description) === ATTRIBUTIONS[key] && t.description.endsWith(`Open-Meteo.com (CC BY 4.0). ${credit}`), `${slug}: attribution ${key}, description ends with the Open-Meteo and Copernicus credits`);
    const out = await t.handler(t.discovery.input);
    ok(out.credit === credit && t.discovery.output.example.credit === credit, `${slug}: the answer and its published example carry the Copernicus credit`);
  }
  for (const slug of ["weather-current", "weather-daily", "weather-hourly"]) ok(tool(slug).attribution === "open-meteo" && !/Copernicus/.test(tool(slug).description), `${slug}: Open-Meteo credit only`);
  for (const t of WEATHER_TOOLS) ok(!/\bno key\b/i.test(t.description), `${t.slug}: the description does not say "no key"`);
}

// --- 3. Failures on the keyed host ---
process.env.OPEN_METEO_API_KEY = KEY;
const errorText = (e) => JSON.stringify({ message: e?.message, ...e });
async function failing(status, headers = {}, reason = `echo apikey=${KEY}`) {
  fetched.length = 0;
  reply = () => new Response(JSON.stringify({ error: true, reason }), { status, headers });
  try { await tool("weather-current").handler({ lat: 1, lon: 2 }); return null; } catch (e) { return e; }
}
let e = await failing(429, { "retry-after": "7" });
ok(e?.statusCode === 503 && e.upstreamStatus === 429 && e.retryAfter === 7, "keyed 429 -> 503 with Retry-After 7 (not charged)");
ok(fetched.length === 1 && fetched.every((u) => new URL(u).host === "customer-api.open-meteo.com"), "keyed 429: one fetch, no retry, no public-host fallback");
ok(!errorText(e).includes(KEY) && !errorText(e).includes("customer-"), "keyed 429: error carries neither key nor keyed host");

_resetOpenMeteoStatus();
ok(openMeteoStatus().status === "unknown" && openMeteoStatus({ env: {} }).status === "off", "openMeteo word: unknown with a key and no keyed outcome yet, off without a key");
const ourRefusal = (e2) => e2?.statusCode === 503 && e2.attribution === "ours" && e2.shed !== true && /service problem on our side/.test(e2.message) && !/key|plan|professional|enterprise|subscription/i.test(errorText(e2));
for (const [st, reason, label, wordAfterOne] of [
  [401, `echo apikey=${KEY}`, "401", "unknown"],
  [403, `echo apikey=${KEY}`, "403", "unknown"],
  [400, "The supplied API key is invalid.", "400 invalid key", "refused"],
  [400, "Your subscription plan does not include this API", "400 plan", "unknown"],
  [403, "This API requires the API Professional or Enterprise plan", "403 plan", "unknown"],
]) {
  _resetOpenMeteoStatus({ logs: true });
  const before = captured.length;
  e = await failing(st, {}, reason);
  ok(ourRefusal(e) && fetched.length === 1 && new URL(fetched[0]).host === "customer-api.open-meteo.com", `keyed ${label} -> our 503 (not charged, not shed: counted as a tool failure), one fetch on the keyed host`);
  ok(!errorText(e).includes(KEY) && !errorText(e).includes("customer-") && !("upstreamBody" in JSON.parse(JSON.stringify({ ...e }))), `keyed ${label}: error is clean and carries no upstream body`);
  ok(captured.slice(before).some((l) => l.includes("[open-meteo] keyed request refused") && l.includes(`HTTP ${st}`)), `keyed ${label}: one operator log line names the refusal`);
  ok(openMeteoStatus().status === wordAfterOne, `keyed ${label}: one refusal on a fresh process reads ${wordAfterOne}`);
  await failing(st, {}, reason);
  ok(openMeteoStatus().status === "refused", `keyed ${label}: a second refusal in a row reads refused`);
}

// --- 3b. The word's transitions ---
const succeed = async () => {
  reply = () => new Response(JSON.stringify(BODY), { status: 200, headers: { "content-type": "application/json" } });
  await tool("weather-current").handler({ lat: 1, lon: 2 });
};
const word = () => openMeteoStatus().status;
{
  _resetOpenMeteoStatus();
  ok(word() === "unknown", "fresh process with a key: unknown (the pagers neither open nor close)");
  await succeed();
  ok(word() === "ok", "unknown -> ok on a keyed success");
  await failing(403);
  ok(word() === "ok", "ok + one transient 403 stays ok (no page on one refusal)");
  await succeed();
  await failing(403);
  ok(word() === "ok", "a success between two 403s breaks the run: still ok");
  await failing(401);
  ok(word() === "refused", "ok -> refused on two keyed refusals in a row");
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 3600_000;
  ok(word() === "refused", "refused does not decay with time (a day later, no traffic: still refused)");
  Date.now = realNow;
  await failing(429);
  await failing(500);
  ok(word() === "refused", "a 429 or a 5xx is not a keyed outcome: refused stays");
  await succeed();
  ok(word() === "ok", "refused -> ok on the next keyed success");
  await failing(400, {}, "The supplied API key is invalid.");
  ok(word() === "refused", "ok -> refused at once on one 400 whose reason names the API key");
  await succeed();
  await failing(400, {}, "Your subscription plan does not include this API");
  ok(word() === "ok", "one 400 naming only a plan counts toward the run, not at once");
  await failing(400, {}, "Parameter 'start_date' is out of allowed range");
  ok(word() === "ok", "a bad-input 400 is not a refusal and leaves the word");
  _resetOpenMeteoStatus();
  await failing(403);
  await failing(429);
  ok(word() === "unknown", "fresh process: one refusal and a 429 stay unknown");
  await failing(403);
  ok(word() === "refused", "fresh process: two refusals in a row read refused (a 429 between them neither breaks nor counts)");
  delete process.env.OPEN_METEO_API_KEY;
  await succeed();
  ok(word() === "off", "no key: off, and an unkeyed success is not a keyed outcome");
  process.env.OPEN_METEO_API_KEY = KEY;
  ok(word() === "refused", "the unkeyed success left the keyed word as it was");
  _resetOpenMeteoStatus();
}
// The word holds per API: a key that covers the forecast but not air quality
// reads refused while air quality's last keyed outcome is a refusal, however
// many forecast reads succeed after it (one shared outcome let any success
// clear another API's refusal, so the word flapped between ok and refused).
{
  _resetOpenMeteoStatus();
  const aq = async (status) => {
    reply = () => (status === 200 ? new Response(JSON.stringify(BODY), { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: true, reason: "This API requires the API Professional or Enterprise plan" }), { status }));
    try { await tool("weather-air-quality").handler({ lat: 3, lon: 4 }); } catch { /* the refusal is the point */ }
  };
  await succeed();
  // 401 here, so the block below still sees its own first air-quality 403 log line.
  await aq(401); await aq(401);
  ok(word() === "refused", "per API: two air-quality refusals read refused");
  await succeed();
  ok(word() === "refused", "per API: a forecast success does not clear air quality's refusal");
  await aq(401);
  await succeed();
  ok(word() === "refused", "per API: forecast successes between air-quality refusals leave the word refused");
  await aq(200);
  ok(word() === "ok", "per API: the refused API's own success reads ok again");
  _resetOpenMeteoStatus();
  await succeed();
  await aq(401);
  ok(word() === "ok", "per API: one air-quality refusal after a forecast success stays ok (its own run of one)");
  _resetOpenMeteoStatus();
}
// The keyed host refusing an API the key does not cover: the body names the
// plan; the buyer gets our 503 (never a 502), and the operator line its reason.
{
  const before = captured.length;
  fetched.length = 0;
  reply = () => new Response(JSON.stringify({ error: true, reason: "This API requires the API Professional or Enterprise plan" }), { status: 403 });
  try { await tool("weather-air-quality").handler({ lat: 1, lon: 2 }); e = null; } catch (x) { e = x; }
  ok(ourRefusal(e) && fetched.length === 1, "keyed plan refusal (403) -> 503 uncharged, not shed, one fetch, no public-host fallback");
  ok(!/plan|professional|enterprise/i.test(errorText(e)), "keyed plan refusal: the buyer's answer names no plan");
  ok(captured.slice(before).some((l) => /\[open-meteo\] keyed request refused \(HTTP 403\) for the airQuality API .*does not cover/.test(l)), "keyed plan refusal: operator log line gives the reason");
}
{
  const before = captured.length;
  await failing(403);
  ok(!captured.slice(before).some((l) => l.includes("[open-meteo]")), "a repeat refusal inside the minute logs no second line");
}
e = await failing(500);
ok(e?.statusCode === 502 && fetched.length === 2 && fetched.every((u) => new URL(u).host === "customer-api.open-meteo.com"), "keyed 500 -> 502 after one retry on the keyed host");
ok(!errorText(e).includes(KEY) && !errorText(e).includes("customer-"), "keyed 500: error is clean");
for (const reason of ["Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-11", "Cannot initialize WeatherVariable from invalid String value nope"]) {
  _resetOpenMeteoStatus();
  e = await failing(400, {}, reason);
  ok(e?.statusCode === 422 && e.attribution === "caller" && !errorText(e).includes(KEY) && !errorText(e).includes("customer-"), `keyed 400 for a bad input stays the buyer's 4xx (422), clean: ${reason.slice(0, 30)}`);
  ok(openMeteoStatus().status === "unknown", "a bad-input 400 is not a keyed outcome: the word stays unknown");
}
// Without a key, a 400 naming a key is not ours to judge: the public host has no key.
delete process.env.OPEN_METEO_API_KEY;
e = await failing(400, {}, "The supplied API key is invalid.");
ok(e?.statusCode === 422 && openMeteoStatus().status === "off", "no key: a 400 is the buyer's 4xx and the word reads off");
process.env.OPEN_METEO_API_KEY = KEY;

// A transport failure whose text quotes the full request URL is scrubbed too.
fetched.length = 0;
reply = (url) => { throw Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: "ECONNRESET" } }); };
try { await tool("weather-current").handler({ lat: 1, lon: 2 }); e = null; } catch (x) { e = x; }
ok(e?.statusCode === 504 && !errorText(e).includes(KEY) && !errorText(e).includes("customer-"), "keyed transport error quoting the URL: clean");

// Without a key a 429 keeps today's answer: a 503, one fetch, public host.
delete process.env.OPEN_METEO_API_KEY;
e = await failing(429);
ok(e?.statusCode === 503 && fetched.length === 1 && new URL(fetched[0]).host === "api.open-meteo.com", "no key: 429 -> 503 on the public host, one fetch");

// --- 4. Redaction ---
for (const [txt, label] of [
  [`GET https://x.example/v1/a?lat=1&apikey=${KEY}&b=2`, "apikey"],
  [`https://x.example/v1/a?api_key=${KEY}`, "api_key"],
  [`see https://x.example/?API-KEY=${KEY}#frag`, "API-KEY"],
]) {
  const r = redactSecrets(txt);
  ok(!r.includes(KEY) && r.includes("=[redacted]"), `redactSecrets drops an unconfigured ${label} query value`);
}
ok(redactSecrets("set the apikey field; ?apikey=short") === "set the apikey field; ?apikey=short", "redactSecrets leaves prose and a short value alone");
process.env.OPEN_METEO_API_KEY = KEY;
ok(!redactSecrets(`upstream said ${KEY}`).includes(KEY), "redactSecrets drops the configured key value anywhere");

globalThis.fetch = realFetch;
restoreResolver();
for (const [m, f] of Object.entries(realConsole)) console[m] = f;
ok(captured.length > 0 && captured.every((l) => !l.includes(KEY) && !l.includes("customer-")), `no console line carries the key or keyed host (${captured.length} lines)`);

for (const l of lines) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
