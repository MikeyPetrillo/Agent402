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
//      monitor counts it), one operator log line, the openMeteo word reads
//      refused for 15 minutes. A 400 for a real bad input stays the buyer's
//      4xx. A 5xx keeps its one retry on the keyed host.
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
const { WEATHER_TOOLS, openMeteoRequest, openMeteoStatus, _resetOpenMeteoStatus, OPEN_METEO_REFUSED_WINDOW_MS } = await import("../src/tools/weather-kit.js");
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
  const { ATTRIBUTIONS, CAMS_ATTRIBUTION, C3S_ATTRIBUTION, attributionTailOf } = await import("../src/data-attribution.js");
  ok(CAMS_ATTRIBUTION === "Generated using Copernicus Atmosphere Monitoring Service information." && C3S_ATTRIBUTION === "Contains modified Copernicus Climate Change Service information.", "the two Copernicus sentences");
  for (const [slug, key, credit] of [["weather-air-quality", "open-meteo-cams", CAMS_ATTRIBUTION], ["weather-history", "open-meteo-c3s", C3S_ATTRIBUTION]]) {
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

ok(openMeteoStatus().status === "ok" && openMeteoStatus({ env: {} }).status === "off", "openMeteo word: ok with a key and no refusal, off without a key");
const ourRefusal = (e2) => e2?.statusCode === 503 && e2.attribution === "ours" && e2.shed !== true && /service problem on our side/.test(e2.message) && !/key|plan|professional|enterprise|subscription/i.test(errorText(e2));
for (const [st, reason, label] of [
  [401, `echo apikey=${KEY}`, "401"],
  [403, `echo apikey=${KEY}`, "403"],
  [400, "The supplied API key is invalid.", "400 invalid key"],
  [400, "Your subscription plan does not include this API", "400 plan"],
  [403, "This API requires the API Professional or Enterprise plan", "403 plan"],
]) {
  _resetOpenMeteoStatus({ logs: true });
  const before = captured.length;
  e = await failing(st, {}, reason);
  ok(ourRefusal(e) && fetched.length === 1 && new URL(fetched[0]).host === "customer-api.open-meteo.com", `keyed ${label} -> our 503 (not charged, not shed: counted as a tool failure), one fetch on the keyed host`);
  ok(!errorText(e).includes(KEY) && !errorText(e).includes("customer-") && !("upstreamBody" in JSON.parse(JSON.stringify({ ...e }))), `keyed ${label}: error is clean and carries no upstream body`);
  ok(captured.slice(before).some((l) => l.includes("[open-meteo] keyed request refused") && l.includes(`HTTP ${st}`)), `keyed ${label}: one operator log line names the refusal`);
  ok(openMeteoStatus().status === "refused", `keyed ${label}: the openMeteo word reads refused`);
}
ok(openMeteoStatus({ now: Date.now() + OPEN_METEO_REFUSED_WINDOW_MS + 1000 }).status === "ok", "openMeteo word: refused clears to ok once the window passes with no new refusal");
ok(OPEN_METEO_REFUSED_WINDOW_MS === 15 * 60_000, "the refused window is 15 minutes");
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
  ok(openMeteoStatus().status === "ok", "a bad-input 400 leaves the openMeteo word ok");
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
