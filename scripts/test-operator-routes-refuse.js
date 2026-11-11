#!/usr/bin/env node
// Every route registered under /__operator refuses a caller without the
// operator token, and the operator view of a public surface reads the token
// from X-Operator-Token only.
//
//   node scripts/test-operator-routes-refuse.js
//
// The route list is read from the booted app's own router
// (/__operator/routes.json, src/operator-routes.js), so a new operator route
// is covered the day it is registered. A second, independent reading of the
// source (every `.get(` / `.post(` ... call in src/ whose path is under
// /__operator) must be inside that list: a route the router reading missed,
// or one this boot did not register, fails the suite instead of going
// unchecked.
//
// Each route is called with no credential, with a wrong token in each place a
// token is read, with a forged session cookie and with the right token where
// no token is read (the query string, a schemeless or Basic Authorization
// header), and must answer 404 every time, with the status, the body bytes and
// the headers an unregistered /__operator path answers, on every method. Every call arrives from its own client address, so the refusal is the
// credential check and never the wrong-credential budget. The right token is
// sent only to a short sample of read-only GET routes (the live control: a
// suite where every answer is 404 proves nothing without it) and never to a
// route that writes or sends.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";
import { operatorRoutesOf } from "../src/operator-routes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// --- the router reading, on a stand-in app -----------------------------------
{
  const route = (path, methods) => ({ route: { path, methods } });
  const mounted = (answers) => ({ handle: { stack: [] }, match: () => answers });
  const read = operatorRoutesOf({ router: { stack: [
    route("/__operator/b.json", { get: true }),
    route(["/__operator/a", "/__operator/a.json"], { get: true, post: true }),
    route("/__operator", { get: true }),
    route("/__operatorx", { get: true }),
    route("/api/__operator/x", { get: true }),
    route("/__operator/all", { _all: true }),
    route(/^\/__operator\/re/, { get: true }),
    { handle: () => {} },
    mounted(true), mounted(false),
  ] } });
  ok(JSON.stringify(read.routes.map((r) => `${r.method} ${r.path}`)) === JSON.stringify(["GET /__operator", "GET /__operator/a", "POST /__operator/a", "GET /__operator/a.json", "POST /__operator/a.json", "ALL /__operator/all", "GET /__operator/b.json"]),
    `the router reading lists each method of each path under /__operator and nothing beside it (${read.routes.length})`);
  ok(read.nested === 1 && read.unreadable === 1, "a mounted router that answers an operator path, and a pattern path, are counted as not listed");
  ok(operatorRoutesOf(null).routes.length === 0 && operatorRoutesOf({}).routes.length === 0, "an app with no router reads as no routes");
}

// --- the source reading -------------------------------------------------------
// Route registrations whose first argument is a string or an array of strings
// under /__operator, in any file under src/. A `.use(` mount is middleware, not
// a route: each one is named below with what it does, so a new one is read by
// a person before this suite passes.
const KNOWN_MOUNTS = new Map([
  ["/__operator", "cache policy, write-origin check and session sync ahead of every operator route"],
  ["/__operator/seller-verification", "the token check ahead of the large-body parser of the POST route of the same path"],
]);
const sourceRoutes = [], sourceMounts = [];
{
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) { if (e.name !== "generated") walk(join(dir, e.name)); } else if (e.name.endsWith(".js")) files.push(join(dir, e.name)); } };
  walk(join(ROOT, "src"));
  const CALL = /\.(get|post|put|patch|delete|all|use|head|options)\(\s*(\[[^\]\n]{0,400}\]|"[^"\n]{0,200}"|'[^'\n]{0,200}'|`[^`\n]{0,200}`)/g;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!text.includes("/__operator")) continue;
    for (const m of text.matchAll(CALL)) {
      const paths = [...m[2].matchAll(/["'`](\/__operator(?:\/[^"'`]*)?)["'`]/g)].map((x) => x[1]);
      for (const p of paths) (m[1] === "use" ? sourceMounts : sourceRoutes).push({ method: m[1].toUpperCase(), path: p, file: f.slice(ROOT.length + 1) });
    }
  }
}
ok(sourceRoutes.length >= 60, `the source names ${sourceRoutes.length} operator route registrations`);
{
  const strange = sourceMounts.filter((m) => !KNOWN_MOUNTS.has(m.path));
  ok(strange.length === 0, `every middleware mounted under /__operator is one this suite names (${strange.map((m) => `${m.file}: use ${m.path}`).join("; ") || "all"})`);
}

const TOKEN = "operator-routes-right-token-0123456789abcdef";
const WRONG = "operator-routes-wrong-token-0123456789abcdef";
// A Stripe key (never used: the preload fails every non-loopback fetch) so the
// routes registered only with card checkout exist in this boot too.
const srv = await bootServer({
  stores: "operator-routes",
  args: ["--import", "./scripts/lib/loopback-only-preload.js"],
  env: {
    FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, TRUST_PROXY_HOPS: "1", STRIPE_SECRET_KEY: "sk_test_operator_routes", STRIPE_WEBHOOK_SECRET: "",
    REDIS_URL: "", TARGET_URL: "", CDN_PROXY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
    TWEET_QUEUE: "", LATE_SETTLE_RECONCILE: "off",
  },
});

// One client address per call (TRUST_PROXY_HOPS=1 reads it from the header).
let caller = 0;
const nextAddress = () => { caller++; return `10.${(caller >> 16) & 255}.${(caller >> 8) & 255}.${caller & 255}`; };
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(srv.url + path, { method, redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "x-forwarded-for": nextAddress(), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
};

try {
  // The live control for the listing itself, and the list.
  const listing = await call("GET", "/__operator/routes.json", { "x-operator-token": TOKEN });
  let listed = null; try { listed = JSON.parse(listing.text); } catch { /* asserted below */ }
  ok(listing.status === 200 && Array.isArray(listed?.routes) && listed.routes.length > 0, `the right token reads the route list from the router (${listing.status}, ${listed?.routes?.length ?? 0} routes)`);
  if (!Array.isArray(listed?.routes)) throw new Error("no route list to check");
  const routes = listed.routes;
  ok(listed.nested === 0 && listed.unreadable === 0, `no operator route sits where the router reading cannot list it (${listed.nested} mounted routers, ${listed.unreadable} pattern paths)`);
  const has = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const unlisted = sourceRoutes.filter((s) => !has.has(`${s.method} ${s.path}`));
  ok(unlisted.length === 0, `every operator route the source registers is in the booted router's list (${unlisted.map((s) => `${s.method} ${s.path}`).join(", ") || "all"})`);
  ok(routes.every((r) => r.method !== "ALL"), "no operator route is registered for every method");

  // The three routes that are reachable without a session by design; each is
  // asserted on its own below.
  const OPEN = new Set(["GET /__operator/login", "POST /__operator/login", "POST /__operator/logout"]);
  const gated = routes.filter((r) => !OPEN.has(`${r.method} ${r.path}`));
  ok(gated.length === routes.length - OPEN.size, "the sign-in form, sign-in and sign-out are the only routes read apart");

  const urlOf = (path) => path.replace(/:[A-Za-z_]\w*[?*+]?/g, "x").replace(/\*\w*/g, "x");
  const basic = `Basic ${Buffer.from(`operator:${TOKEN}`).toString("base64")}`;
  const variants = (path) => [
    ["no credential", path, {}],
    ["a wrong X-Operator-Token", path, { "x-operator-token": WRONG }],
    ["a wrong Bearer token", path, { authorization: `Bearer ${WRONG}` }],
    ["the right token cut short", path, { "x-operator-token": TOKEN.slice(0, -1) }],
    ["a forged session cookie", path, { cookie: "a402_op=0123456789abcdef0123456789abcdef", "sec-fetch-site": "same-origin" }],
    ["the right token in the query string", `${path}?token=${TOKEN}&operator_token=${TOKEN}`, {}],
    ["the right token in Authorization with no scheme", path, { authorization: TOKEN }],
    ["the right token in a Basic Authorization", path, { authorization: basic }],
    ["the right token in a cookie", path, { cookie: `a402_op=${TOKEN}; operator_token=${TOKEN}`, "sec-fetch-site": "same-origin" }],
  ];
  // What an unregistered operator path answers to the same calls: the status,
  // the body and the headers a refused route must repeat, so a caller without
  // the token cannot tell a registered path from one that is not.
  const ABSENT = "/__operator/no-such-route-here";
  // Headers whose value is the moment or the request, never the route.
  const PER_REQUEST = new Set(["date", "x-request-id", "server-timing", "x-response-time"]);
  const headersOf = (a) => [...a.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const differs = (a, b) => {
    if (a.status !== b.status) return `status ${a.status}, not ${b.status}`;
    if (a.text !== b.text) return `body ${JSON.stringify(a.text.slice(0, 80))}, not ${JSON.stringify(b.text.slice(0, 80))}`;
    const ha = headersOf(a), hb = headersOf(b);
    const na = ha.map((h) => h[0]).join(","), nb = hb.map((h) => h[0]).join(",");
    if (na !== nb) return `header names [${na}], not [${nb}]`;
    for (let i = 0; i < ha.length; i++) if (!PER_REQUEST.has(ha[i][0]) && ha[i][1] !== hb[i][1]) return `header ${ha[i][0]}: ${ha[i][1]}, not ${hb[i][1]}`;
    return null;
  };
  const bodiesOf = (method) => (method === "GET" || method === "HEAD" || method === "OPTIONS" ? [undefined] : ["{}", "{not json"]);
  const absentAnswers = new Map();
  const absentFor = async (method, variant, body) => {
    const key = `${method} ${variant} ${body}`;
    if (!absentAnswers.has(key)) {
      const [, p, h] = variants(ABSENT).find((v) => v[0] === variant);
      absentAnswers.set(key, await call(method, p, h, body));
    }
    return absentAnswers.get(key);
  };
  const absent = {};
  for (const method of ["GET", "POST"]) {
    for (const [name] of variants(ABSENT)) absent[`${method} ${name}`] = (await absentFor(method, name, method === "POST" ? "{}" : undefined)).status;
  }
  ok(Object.values(absent).every((s) => s === 404), `an unregistered operator path answers 404 to every form of call (${[...new Set(Object.values(absent))].join(", ")})`);
  // A body the JSON parser cannot read is refused by the parser that sits
  // ahead of every route on the site, registered or not: the answer to one is
  // the answer an unregistered operator path gives, so it tells a caller
  // nothing about the route.
  const absentBadBody = await absentFor("POST", "no credential", "{not json");
  ok(absentBadBody.status === 400 || absentBadBody.status === 404, `an unregistered operator path answers an unparseable body with a 400 or a 404 (${absentBadBody.status})`);
  // Two calls to the unregistered path agree with each other, so the
  // comparison below reads the route and nothing that changes per request.
  {
    const again = await call("GET", ABSENT, {});
    const d = differs(again, await absentFor("GET", "no credential", undefined));
    ok(d === null, `two answers of an unregistered operator path are the same bytes and headers (${d || "same"})`);
  }

  const open = [], told = [];
  let calls = 0;
  // Every method a caller can send, the route's own and the ones it does not
  // register: none of them may answer differently from the unregistered path.
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  for (const r of gated) {
    const path = urlOf(r.path);
    for (const [name, p, h] of variants(path)) {
      for (const body of bodiesOf(r.method)) {
        const a = await call(r.method, p, h, body);
        calls++;
        if (body === "{not json") {
          if (a.status !== 404 && !(a.status === absentBadBody.status && a.text === absentBadBody.text)) open.push(`${r.method} ${r.path} with ${name} and an unparseable body: ${a.status}, not what an unregistered path answers`);
        } else if (a.status !== 404) open.push(`${r.method} ${r.path} with ${name}: ${a.status}`);
        if (/no-store/.test(a.headers.get("cache-control") || "") === false) open.push(`${r.method} ${r.path} with ${name}: its 404 may be stored (${a.headers.get("cache-control")})`);
        const d = differs(a, await absentFor(r.method, name, body));
        if (d) told.push(`${r.method} ${r.path} with ${name}${body === "{not json" ? " and an unparseable body" : ""}: ${d}`);
      }
    }
    for (const method of METHODS) {
      if (method === r.method) continue;
      for (const body of bodiesOf(method)) {
        const a = await call(method, path, {}, body);
        calls++;
        const d = differs(a, await absentFor(method, "no credential", body));
        if (d) told.push(`${method} to ${r.method} ${r.path}${body === "{not json" ? " with an unparseable body" : ""}: ${d}`);
      }
    }
  }
  for (const o of open.slice(0, 60)) console.error(`  open: ${o}`);
  ok(open.length === 0, `each of ${gated.length} operator routes refuses every call without the token with a never-stored 404 (${calls} calls, ${open.length} did not)`);
  for (const o of told.slice(0, 60)) console.error(`  told apart: ${o}`);
  ok(told.length === 0, `each refusal is the unregistered path's answer: same status, same body bytes, same header names and values, for every method (${told.length} differed)`);
  // The sign-in routes answer without a session by design; a method they do
  // not register still answers as an unregistered path does.
  {
    const apart = [];
    for (const path of ["/__operator/login", "/__operator/logout"]) {
      for (const method of METHODS) {
        if (OPEN.has(`${method} ${path}`) || (method === "HEAD" && OPEN.has(`GET ${path}`))) continue;
        for (const body of bodiesOf(method)) {
          const d = differs(await call(method, path, {}, body), await absentFor(method, "no credential", body));
          if (d) apart.push(`${method} ${path}: ${d}`);
        }
      }
    }
    ok(apart.length === 0, `a method the sign-in routes do not register answers as an unregistered path does (${apart.join("; ") || "all"})`);
  }

  // The routes read apart.
  {
    const form = await call("GET", "/__operator/login");
    ok(form.status === 200 && !form.text.includes(TOKEN) && !form.headers.get("set-cookie"), `the sign-in form is public, sets no cookie and holds no token (${form.status})`);
    const wrong = await call("POST", "/__operator/login", {}, JSON.stringify({ token: WRONG }));
    ok(wrong.status === 401 && !wrong.headers.get("set-cookie"), `sign-in with a wrong token: 401, no session (${wrong.status})`);
    const header = await call("POST", "/__operator/login", { "x-operator-token": WRONG, authorization: `Bearer ${WRONG}` }, "{}");
    ok(header.status === 401 && !header.headers.get("set-cookie"), `sign-in with no token in the body: 401, no session (${header.status})`);
    const query = await call("POST", `/__operator/login?token=${TOKEN}`, {}, "{}");
    ok(query.status === 401 && !query.headers.get("set-cookie"), `sign-in with the token in the query string: 401, no session (${query.status})`);
    const out = await call("POST", "/__operator/logout");
    ok(out.status === 303 && /\/__operator\/login$/.test(out.headers.get("location") || "") && !/a402_op=[^;]/.test(out.headers.get("set-cookie") || ""), `sign-out without a session: a redirect to the form that grants nothing (${out.status})`);
    // The router matches a path in any case and with a trailing slash, and
    // answers HEAD with GET's route: the open routes stay open in each form.
    const head = await call("HEAD", "/__operator/login");
    ok(head.status === 200 && !head.headers.get("set-cookie"), `HEAD of the sign-in form is served as its GET (${head.status})`);
    const upper = await call("GET", "/__operator/Login");
    ok(upper.status === 200 && upper.text === form.text, `the sign-in form at /__operator/Login is the same form (${upper.status})`);
    const slash = await call("GET", "/__operator/login/");
    ok(slash.status !== 404 && (slash.status === 200 ? slash.text === form.text : /\/__operator\/login$/.test(slash.headers.get("location") || "")), `the sign-in form at /__operator/login/ is the form or a redirect to it, never the refusal (${slash.status})`);
    for (const path of ["/__operator/logout/", "/__operator/Logout", "/__operator/LOGOUT/"]) {
      const o = await call("POST", path);
      ok(o.status === 303 && /\/__operator\/login$/.test(o.headers.get("location") || ""), `sign-out at ${path} is the same sign-out (${o.status})`);
    }
  }

  // The refusal is the machine 404 every unknown machine path answers: a
  // JSON body of exactly ok false and error "not-found", the shape an unknown
  // /api path opens with too, so a caller learns nothing from its wording.
  {
    const none = await call("GET", "/__operator/no-such-route-here");
    const gatedRead = await call("GET", "/__operator/routes.json");
    const api = await call("GET", "/api/no-such-tool-here");
    let noneBody = null, apiBody = null;
    try { noneBody = JSON.parse(none.text); } catch { /* asserted below */ }
    try { apiBody = JSON.parse(api.text); } catch { /* asserted below */ }
    ok(none.status === 404 && none.text === JSON.stringify({ ok: false, error: "not-found" }), `an unregistered operator path answers the machine 404 body (${none.status} ${none.text.slice(0, 80)})`);
    ok(gatedRead.status === 404 && gatedRead.text === none.text, `a registered route refused at the mount answers the same body (${gatedRead.status} ${gatedRead.text.slice(0, 80)})`);
    ok(api.status === 404 && apiBody?.ok === noneBody?.ok && apiBody?.error === noneBody?.error, `and that body has the ok and error an unknown /api path answers (${JSON.stringify({ ok: apiBody?.ok, error: apiBody?.error })})`);
  }

  // Live control: the right token is let in, by either header, on read-only GETs.
  {
    const SAFE = ["/__operator", "/__operator/routes.json", "/__operator/followups.json", "/__operator/seo-meta.json", "/__operator/serving-health.json", "/__operator/tweet-queue.json"];
    for (const path of SAFE) {
      ok(has.has(`GET ${path}`), `control route GET ${path} is a registered route`);
      const a = await call("GET", path, { "x-operator-token": TOKEN });
      ok(a.status !== 404 && a.status < 500, `control: X-Operator-Token with the right token is let in at GET ${path} (${a.status})`);
      const b = await call("GET", path, { authorization: `Bearer ${TOKEN}` });
      ok(b.status !== 404 && b.status < 500, `control: a Bearer Authorization with the right token is let in at GET ${path} (${b.status})`);
    }
    // The wrong-credential calls above did not spend a budget that would have
    // refused for them: an address used once is still compared.
    const again = await call("GET", "/__operator/seo-meta.json", { "x-operator-token": TOKEN });
    ok(again.status === 200, `after the sweep a new address with the right token is still let in (${again.status})`);
  }

  // The operator view of a public surface: X-Operator-Token only. The surfaces
  // are every handler that calls operatorView(req, res), read from the source.
  {
    const src = readFileSync(join(ROOT, "src/server.js"), "utf8").split("\n");
    const surfaces = new Set();
    let current = null;
    for (const line of src) {
      const reg = /^\s*app\.(get|post)\(\s*(\[[^\]]*\]|"[^"]*")/.exec(line);
      if (reg) current = { method: reg[1].toUpperCase(), paths: [...reg[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]) };
      if (/\boperatorView\(req, res\)/.test(line) && !/^\s*function operatorView/.test(line) && current) for (const p of current.paths) surfaces.add(`${current.method} ${p}`);
    }
    ok(surfaces.size >= 6 && surfaces.has("GET /api/gateway-status") && surfaces.has("GET /health"), `the source names ${surfaces.size} public surfaces with an operator view (${[...surfaces].join(", ")})`);
    const shape = (a) => { let keys = "(not json)"; try { const j = JSON.parse(a.text); keys = Object.keys(j && typeof j === "object" ? j : {}).sort().join(","); } catch { /* a page or a redirect */ } return `${a.status}|${keys}|${/private/.test(a.headers.get("cache-control") || "") ? "private" : "shared"}`; };
    for (const s of surfaces) {
      const [method, path] = s.split(" ");
      const anon = await call(method, path);
      const viaAuth = await call(method, path, { authorization: `Bearer ${TOKEN}` });
      const viaSchemeless = await call(method, path, { authorization: TOKEN });
      const viaQuery = await call(method, `${path}?token=${TOKEN}`);
      const viaCookie = await call(method, path, { cookie: `a402_op=${TOKEN}` });
      const viaWrong = await call(method, path, { "x-operator-token": WRONG });
      const elevated = await call(method, path, { "x-operator-token": TOKEN });
      ok(anon.status < 500 && /x-operator-token/i.test(anon.headers.get("vary") || ""), `${s}: the public answer varies on X-Operator-Token (${anon.status})`);
      ok(shape(elevated) !== shape(anon), `control: ${s} with the right X-Operator-Token is the operator view (${shape(anon).slice(0, 60)} -> ${shape(elevated).slice(0, 60)})`);
      for (const [name, a] of [["a Bearer Authorization", viaAuth], ["a schemeless Authorization", viaSchemeless], ["the query string", viaQuery], ["a cookie", viaCookie], ["X-Operator-Token with a wrong value", viaWrong]]) {
        ok(shape(a) === shape(anon), `${s}: the token in ${name} gets the public answer (${shape(a).slice(0, 70)})`);
      }
    }
  }
  ok(srv.exited() === null, "the server is still up");
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  console.error(srv.log().slice(-1500));
} finally {
  await srv.stop();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
