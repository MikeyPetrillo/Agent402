#!/usr/bin/env node
// Which clients' 402s carry MPP offers (src/mpp-offer-gate.js).
//
// A client whose User-Agent starts with a listed prefix (default
// "python-httpx/") gets a 402 with no `WWW-Authenticate: Payment` challenge:
// the x402 PAYMENT-REQUIRED header and the 402 body are unchanged, so it pays
// x402. `X-Payment-Offers: mpp` (or `all`) restores the MPP challenges. A
// request that carries an MPP credential (`Authorization: Payment`) is never
// gated. Every other client's 402 is untouched.
//
// Part 1 boots a PAID server with the MPP evm, Tempo and card challenges on,
// and reads EVERY priced route as Node, curl, no User-Agent, python-requests,
// python-httpx and python-httpx with the opt-in header:
//   - every non-gated client gets the same challenges, header and body as Node;
//   - python-httpx gets no Payment challenge, the same PAYMENT-REQUIRED header
//     and the same body as Node, and its 402 varies on the opt-in header;
//   - python-httpx with the opt-in header gets Node's challenges back;
//   - a python-httpx request carrying an MPP credential is challenged as today;
//   - the operator view counts withheld and opted-in 402s, the public view
//     publishes no count.
// Part 2 boots with MPP_OFFER_WITHHOLD_USER_AGENTS set to another list, and
// Part 3 with it set to off.
// Part 4 (offline) pins the predicate: prefix match, the opt-in values, the
// credential exemption and one count per request.
//
// The predicate's module is imported in Part 4 only, so on a tree without it
// Part 1 fails on the 402 itself.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootPaidServer } from "./lib/paid-boot.js";
import { Challenge } from "mppx";

let pass = 0;
let srv = null;
const fail = (m) => {
  console.error("FAIL:", m);
  if (srv) console.error(srv.log().slice(-2000));
  try { srv?.child?.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; if (!m.startsWith("·")) console.log(`ok - ${m}`); } else fail(m.replace(/^·\s*/, "")); };

const TOKEN = "offer-gate-operator-token";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const MPP_ENV = {
  MPP_SECRET_KEY: "offer-gate-secret",
  TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY,
  TEMPO_CURRENCY: "0x2000000000000000000000000000000000000000", TEMPO_API_BASE_URL: "http://127.0.0.1:9",
  STRIPE_SECRET_KEY: "sk_test_offer_gate", STRIPE_PROFILE_ID: "profile_offer_gate",
  AGENT402_OPERATOR_TOKEN: TOKEN,
  // Every route is read six times; the unpaid quote budget would answer 429.
  UNPAID_QUOTE_BUDGET_PER_HOUR: "off",
};
const HTTPX = "python-httpx/0.28.1";

const methodsOf = (r) => {
  const www = r.headers.get("www-authenticate");
  if (!www) return [];
  return Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })).map((c) => c.method);
};
const varyOf = (r) => String(r.headers.get("vary") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// The body carries no per-request field on these routes; a challenge id and
// expiry are per request, so the challenge is compared by its methods.
async function read(url, method, ua, extra = {}) {
  const headers = { "content-type": "application/json", "accept-encoding": "identity", "user-agent": ua ?? "", ...extra };
  const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : "{}" });
  const body = await r.text();
  return { status: r.status, methods: methodsOf(r), pr: r.headers.get("payment-required"), vary: varyOf(r), names: [...r.headers.keys()].filter((k) => !["date", "etag", "x-request-id"].includes(k)).sort(), body };
}

async function pricedRoutes(base) {
  const eps = (await (await fetch(`${base}/api/pricing`)).json()).endpoints || [];
  return eps.filter((e) => e.method && typeof e.path === "string" && !e.path.includes(":")).map((e) => ({ method: e.method, path: e.path }));
}

try {
  // -------------------------------------------------------------------------
  // Part 1: the default list, every priced route
  // -------------------------------------------------------------------------
  srv = await bootPaidServer({ label: "mpp-offer-gate", env: MPP_ENV });
  const routes = await pricedRoutes(srv.url);
  ok(routes.length > 400, `the catalog lists ${routes.length} priced routes`);
  const seen = { tempo: 0, evm: 0, stripe: 0 };
  let httpx402 = 0, optIn402 = 0;
  for (const { method, path } of routes) {
    const url = srv.url + path;
    const node = await read(url, method, "node");
    ok(node.status === 402, `· ${method} ${path} answers Node 402 (got ${node.status})`);
    ok(node.methods.length > 0, `· ${method} ${path} offers Node an MPP challenge`);
    for (const m of node.methods) seen[m] = (seen[m] || 0) + 1;
    ok(!node.vary.includes("x-payment-offers"), `· ${method} ${path}: Node's 402 does not vary on X-Payment-Offers`);
    for (const [label, ua] of [["curl", "curl/8.7.1"], ["no User-Agent", ""], ["python-requests", "python-requests/2.32.3"], ["a prefix inside the string", `my-${HTTPX}`]]) {
      const o = await read(url, method, ua);
      ok(o.status === 402 && o.methods.join() === node.methods.join() && o.pr === node.pr && o.body === node.body && o.names.join() === node.names.join() && o.vary.join() === node.vary.join(),
        `· ${method} ${path}: ${label} gets Node's 402 (methods ${o.methods.join()} vs ${node.methods.join()})`);
    }
    const httpx = await read(url, method, HTTPX);
    ok(httpx.status === 402 && httpx.methods.length === 0, `· ${method} ${path}: python-httpx gets no Payment challenge (got ${httpx.methods.join()})`);
    ok(httpx.pr === node.pr, `· ${method} ${path}: python-httpx gets Node's PAYMENT-REQUIRED header byte for byte`);
    ok(httpx.body === node.body, `· ${method} ${path}: python-httpx gets Node's 402 body byte for byte`);
    ok(httpx.vary.includes("x-payment-offers") && httpx.vary.includes("user-agent"), `· ${method} ${path}: python-httpx's 402 varies on X-Payment-Offers and User-Agent`);
    httpx402++;
    for (const value of ["mpp", "MPP", " all ", "x402, mpp"]) {
      const o = await read(url, method, HTTPX, { "X-Payment-Offers": value });
      ok(o.status === 402 && o.methods.join() === node.methods.join() && o.pr === node.pr && o.body === node.body,
        `· ${method} ${path}: python-httpx with X-Payment-Offers: ${value} gets Node's challenges back (got ${o.methods.join()})`);
      optIn402++;
    }
    const refused = await read(url, method, HTTPX, { "X-Payment-Offers": "x402" });
    ok(refused.methods.length === 0, `· ${method} ${path}: X-Payment-Offers: x402 restores nothing`);
    httpx402++;
  }
  ok(seen.tempo > 0 && seen.evm > 0 && seen.stripe > 0, `the sweep covered every challenge kind (tempo ${seen.tempo}, evm ${seen.evm}, card ${seen.stripe})`);
  ok(true, `on all ${routes.length} routes: curl, no User-Agent and python-requests get Node's 402; python-httpx gets no challenge with the x402 header and body unchanged; the opt-in header restores Node's challenges`);

  // A python-httpx request that carries an MPP credential is verified as
  // today: its 402 (here a malformed credential's) carries fresh challenges.
  {
    const node = await read(`${srv.url}/api/uuid`, "GET", "node", { Authorization: "Payment not-a-credential" });
    const httpx = await read(`${srv.url}/api/uuid`, "GET", HTTPX, { Authorization: "Payment not-a-credential" });
    ok(node.status === 402 && node.methods.length > 0, "a Node request with a malformed MPP credential gets a 402 with challenges");
    ok(httpx.status === 402 && httpx.methods.join() === node.methods.join() && httpx.body === node.body,
      `a python-httpx request carrying an MPP credential gets the same 402 as Node (methods ${httpx.methods.join()})`);
    ok(/malformed/i.test(httpx.body), "and the same problem document naming why");
  }

  // Counts: operator view only.
  {
    const op = await (await fetch(`${srv.url}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } })).json();
    const g = op?.mppEvmDomainFallback?.offerGate;
    ok(g && g.enabled === true, "the operator view says the offer gate is on");
    ok(Array.isArray(g.userAgentPrefixes) && g.userAgentPrefixes.join() === "python-httpx/", `the operator view names the prefix list (${JSON.stringify(g?.userAgentPrefixes)})`);
    ok(g.withheld === httpx402, `the operator view counts ${httpx402} python-httpx 402s sent with MPP withheld (got ${g?.withheld})`);
    ok(g.optedIn === optIn402, `the operator view counts ${optIn402} opted-in 402s (got ${g?.optedIn})`);
    const pub = await (await fetch(`${srv.url}/api/gateway-status`)).json();
    ok(JSON.stringify(Object.keys(pub?.mppEvmDomainFallback || {})) === JSON.stringify(["enabled"]), "the public view publishes no count and no list");
  }
  await srv.stop();
  srv = null;

  // -------------------------------------------------------------------------
  // Part 2: another list
  // -------------------------------------------------------------------------
  srv = await bootPaidServer({ label: "mpp-offer-gate-list", env: { ...MPP_ENV, MPP_OFFER_WITHHOLD_USER_AGENTS: " Python-Requests/ , Go-http-client/" } });
  {
    const u = `${srv.url}/api/uuid`;
    const node = await read(u, "GET", "node");
    ok((await read(u, "GET", "python-requests/2.32.3")).methods.length === 0, "a configured prefix is matched without regard to case");
    ok((await read(u, "GET", "Go-http-client/2.0")).methods.length === 0, "every prefix in the list is gated");
    ok((await read(u, "GET", HTTPX)).methods.join() === node.methods.join(), "python-httpx is offered MPP when the list leaves it out");
  }
  await srv.stop();
  srv = null;

  // -------------------------------------------------------------------------
  // Part 3: off
  // -------------------------------------------------------------------------
  srv = await bootPaidServer({ label: "mpp-offer-gate-off", env: { ...MPP_ENV, MPP_OFFER_WITHHOLD_USER_AGENTS: "off" } });
  {
    const u = `${srv.url}/api/uuid`;
    const node = await read(u, "GET", "node");
    const httpx = await read(u, "GET", HTTPX);
    ok(httpx.methods.length > 0 && httpx.methods.join() === node.methods.join() && httpx.vary.join() === node.vary.join(), "off: python-httpx gets Node's 402, Vary included");
    const op = await (await fetch(`${srv.url}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } })).json();
    ok(op?.mppEvmDomainFallback?.offerGate?.enabled === false && op.mppEvmDomainFallback.offerGate.withheld === 0, "off: the operator view says the gate is off and counts nothing");
  }
  await srv.stop();
  srv = null;

  // -------------------------------------------------------------------------
  // Part 4: the predicate, offline
  // -------------------------------------------------------------------------
  const gate = await import("../src/mpp-offer-gate.js");
  const { withheldUserAgentPrefixes, mppOffersWithheldFor, requestOptsIntoMppOffers, mppOfferGateStatus, _resetMppOfferGate, OFFER_REQUEST_HEADER, DEFAULT_WITHHELD_USER_AGENT_PREFIXES } = gate;
  ok(OFFER_REQUEST_HEADER === "X-Payment-Offers", "the opt-in header is X-Payment-Offers");
  ok(DEFAULT_WITHHELD_USER_AGENT_PREFIXES.join() === "python-httpx/", "the default list is python-httpx/");
  ok(withheldUserAgentPrefixes({}).join() === "python-httpx/" && withheldUserAgentPrefixes({ MPP_OFFER_WITHHOLD_USER_AGENTS: "  " }).join() === "python-httpx/", "unset or blank reads the default");
  ok(withheldUserAgentPrefixes({ MPP_OFFER_WITHHOLD_USER_AGENTS: "OFF" }).length === 0, "off (any case) disables the gate");
  ok(withheldUserAgentPrefixes({ MPP_OFFER_WITHHOLD_USER_AGENTS: "A/, ,b/" }).join() === "a/,b/", "a comma list, trimmed, lowercased, blanks dropped");

  const saved = process.env.MPP_OFFER_WITHHOLD_USER_AGENTS;
  delete process.env.MPP_OFFER_WITHHOLD_USER_AGENTS;
  _resetMppOfferGate();
  const req = (ua, extra = {}, raw = null) => {
    const headers = { ...(ua == null ? {} : { "user-agent": ua }), ...extra };
    const rawHeaders = raw || Object.entries(headers).flat();
    return { headers, rawHeaders };
  };
  ok(mppOffersWithheldFor(req(HTTPX)) === true, "python-httpx is withheld");
  ok(mppOffersWithheldFor(req("Python-HTTPX/0.27.0")) === true, "the prefix is matched without regard to case");
  ok(mppOffersWithheldFor(req(`  ${HTTPX}`)) === true, "leading spaces in the User-Agent are ignored");
  for (const ua of ["python-requests/2.32.3", "node", "", null, "curl/8.7.1", `x ${HTTPX}`, "python-httpx"]) {
    ok(mppOffersWithheldFor(req(ua)) === false, `${JSON.stringify(ua)} is not withheld`);
  }
  for (const v of ["mpp", "MPP", "all", " All ", "x402,mpp", "x402 , ALL"]) {
    ok(requestOptsIntoMppOffers(req(HTTPX, { "x-payment-offers": v })) === true, `X-Payment-Offers: ${JSON.stringify(v)} opts in`);
    ok(mppOffersWithheldFor(req(HTTPX, { "x-payment-offers": v })) === false, `python-httpx with X-Payment-Offers: ${JSON.stringify(v)} is offered MPP`);
  }
  for (const v of ["", "x402", "none", "mppx", "allx"]) {
    ok(mppOffersWithheldFor(req(HTTPX, { "x-payment-offers": v })) === true, `X-Payment-Offers: ${JSON.stringify(v)} does not opt in`);
  }
  ok(requestOptsIntoMppOffers(req(HTTPX, { "x-payment-offers": ["x402", "mpp"] })) === true, "a header sent twice is read as one list");
  ok(mppOffersWithheldFor(req(HTTPX, { authorization: "Payment abc" })) === false, "a request carrying an MPP credential is not withheld");
  ok(mppOffersWithheldFor(req(HTTPX, { authorization: "payment abc" })) === false, "the credential scheme is read without regard to case");
  ok(mppOffersWithheldFor(req(HTTPX, { authorization: "Bearer a402_x" })) === true, "a bearer credential is not an MPP credential");
  {
    // The MPP shim consumes the header once it translates the credential: the
    // raw header list still says the request arrived with one.
    const r = req(HTTPX, {}, ["User-Agent", HTTPX, "Authorization", "Payment abc"]);
    ok(mppOffersWithheldFor(r) === false, "a credential the shim already consumed still exempts the request");
    const r2 = req(HTTPX);
    r2.mppCredential = true;
    ok(mppOffersWithheldFor(r2) === false, "the shim's own mark exempts the request too");
  }

  // One count per request, however many appenders ask.
  _resetMppOfferGate();
  const once = req(HTTPX);
  for (let i = 0; i < 3; i++) mppOffersWithheldFor(once);
  const opted = req(HTTPX, { "x-payment-offers": "mpp" });
  for (let i = 0; i < 3; i++) mppOffersWithheldFor(opted);
  mppOffersWithheldFor(req("node"));
  const st = mppOfferGateStatus();
  ok(st.withheld === 1 && st.optedIn === 1, `each request is counted once (withheld ${st.withheld}, optedIn ${st.optedIn})`);
  ok(st.enabled === true && st.userAgentPrefixes.join() === "python-httpx/", "the status names the switch and the list");
  {
    // A Vary is added on the gated client's response only.
    const vary = [];
    const r = req(HTTPX);
    r.res = { vary: (h) => vary.push(h) };
    mppOffersWithheldFor(r);
    const n = req("node");
    n.res = { vary: (h) => vary.push(`node:${h}`) };
    mppOffersWithheldFor(n);
    ok(vary.join() === "X-Payment-Offers", `only the gated client's response varies on the opt-in header (${vary.join()})`);
  }
  process.env.MPP_OFFER_WITHHOLD_USER_AGENTS = "off";
  _resetMppOfferGate();
  ok(mppOffersWithheldFor(req(HTTPX)) === false && mppOfferGateStatus().withheld === 0 && mppOfferGateStatus().enabled === false, "off: nothing is withheld or counted");
  if (saved === undefined) delete process.env.MPP_OFFER_WITHHOLD_USER_AGENTS; else process.env.MPP_OFFER_WITHHOLD_USER_AGENTS = saved;

  console.log(`\n${pass} passed`);
  process.exit(0);
} catch (e) {
  fail(e?.stack || e);
}
