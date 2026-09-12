#!/usr/bin/env node
// The chain namespace: a name a buyer can guess, pointed at the route we already sell.
//
// Two things have to stay true or this becomes a liability rather than a door:
//
//   1. EVERY VERB RESOLVES. The map is hand-written and the catalog moves under
//      it. A retired or renamed tool would leave `/api/chain/<verb>` pointing at
//      nothing, and the failure is a 404 for a buyer who followed our own index
//      - worse than never having offered the verb. Checked against the BOOTED
//      server, not against a copy of the catalog in this file.
//
//   2. THE REWRITE IS INVISIBLE. An aliased call must be the canonical call:
//      same handler, same price, same paywall. If a verb ever became its own
//      resource we would be listing one capability twice on every index that
//      reads our manifest, which is the registry inflation we decline to do.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { CHAIN_VERB_ROUTES, CHAIN_OWN_ROUTES, chainVerbOf, chainRouteFor, chainNamespaceMap, chainNamespaceMiddleware } from "../src/chain-namespace.js";

const TARGET = process.env.TARGET_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- 1. the verb parser --------------------------------------------------
ok(chainVerbOf("/api/chain/nonce") === "nonce", "a verb is read off the path");
ok(chainVerbOf("/api/chain/ERC20-Balance") === "erc20-balance", "verbs are case-insensitive: an agent typing the RPC name in camelCase is not wrong");
ok(chainVerbOf("/api/chain/nonce/") === "nonce", "a trailing slash is the same verb");
ok(chainVerbOf("/api/chain") === null, "the bare prefix is not a verb - it is the index");
ok(chainVerbOf("/api/chain/a/b") === null, "a nested path is NOT a verb: the namespace is one level, so nothing can smuggle a second path segment through the rewrite");
ok(chainVerbOf("/api/chain-info") === null, "a route that merely starts with the same letters is untouched");
for (const v of [null, undefined, 42, {}]) ok(chainVerbOf(v) === null, `${JSON.stringify(v)} is not a path`);

// --- 2. own routes are served where they stand ---------------------------
for (const verb of CHAIN_OWN_ROUTES.keys()) {
  ok(chainRouteFor(verb) === null, `"${verb}" has its own route and is never rewritten`);
}
ok(chainRouteFor("erc20-balance") === "/api/token-balances", "an alias resolves to the canonical route");
{
  // The invariant behind the belt in chainRouteFor: a verb lives in exactly one
  // map. Both would mean a verb with its own route that is also rewritten
  // somewhere else, and which of the two answers would depend on lookup order.
  const both = [...CHAIN_OWN_ROUTES.keys()].filter((v) => CHAIN_VERB_ROUTES.has(v));
  ok(both.length === 0, `no verb is both an alias and its own route${both.length ? ` - ${both.join(", ")}` : ""}`);
}
ok(chainRouteFor("not-a-verb") === null, "an unknown verb resolves to nothing and falls through to the 404");

// --- 3. the middleware rewrites the URL and keeps the query --------------
{
  const run = (url) => {
    const req = { url, path: url.split("?")[0] };
    chainNamespaceMiddleware(req, null, () => {});
    return req;
  };
  ok(run("/api/chain/block-number?network=base").url === "/api/block-number?network=base",
    "the query string survives the rewrite - it carries every parameter of a GET verb");
  ok(run("/api/chain/erc20-balance").url === "/api/token-balances", "a bare alias rewrites to the canonical path");
  ok(run("/api/chain/nonce?address=0x1").url === "/api/chain/nonce?address=0x1", "a verb with its own route is left alone");
  ok(run("/api/chain/not-a-verb").url === "/api/chain/not-a-verb", "an unknown verb is left alone so the 404 can answer it");
  ok(run("/api/chain/block-number").__chainVerb === "block-number", "the verb rides on the request for telemetry");
}

// --- 4. the map is honest about itself ----------------------------------
{
  const map = chainNamespaceMap();
  ok(map.length === CHAIN_VERB_ROUTES.size + CHAIN_OWN_ROUTES.size, "the published map covers every verb, aliases and own routes alike");
  ok(map.every((m) => m.route.startsWith("/api/")), "every route is an absolute API path");
  const own = new Set(CHAIN_OWN_ROUTES.keys());
  ok(map.filter((m) => m.own).every((m) => own.has(m.verb)), "only the verbs with their own route are flagged own");
  const dupes = map.map((m) => m.verb).filter((v, i, a) => a.indexOf(v) !== i);
  ok(dupes.length === 0, `no verb is defined twice (${dupes.join(", ") || "none"})`);
}

// --- 5. the middleware runs BEFORE every gate ---------------------------
// Pinned from source: the paywall, the replay guard and the idempotency cache
// all key on req.path, so a rewrite mounted after them would be priced as one
// route and served as another.
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mount = src.indexOf("app.use(chainNamespaceMiddleware)");
  ok(mount > 0, "the middleware is mounted");
  const gate = src.indexOf("app.use(x402mw");
  const dispatcher = src.indexOf("__methodAliased");
  ok(gate < 0 || mount < gate, "it is mounted before the x402 paywall");
  ok(dispatcher < 0 || mount < dispatcher, "and before the method alias, so a POST on a GET-only canonical route still resolves");
}

// --- 6. against the BOOTED server ---------------------------------------
const res = await fetch(`${TARGET}/api/pricing`).catch(() => null);
if (!res || !res.ok) {
  console.error(`SKIP: no server at ${TARGET}`);
} else {
  const pricing = await res.json();
  const live = new Map(pricing.endpoints.map((e) => [e.path, e]));

  // THE drift guard: every verb must point at a route this server serves.
  const dead = chainNamespaceMap().filter((m) => !live.has(m.route));
  ok(dead.length === 0, `every verb resolves to a live route${dead.length ? ` - DEAD: ${dead.map((d) => `${d.verb} -> ${d.route}`).join(", ")}` : ""}`);

  // The free index describes the namespace completely and quotes live prices.
  const idx = await (await fetch(`${TARGET}/api/chain`)).json();
  ok(idx.ok && Array.isArray(idx.verbs), "GET /api/chain answers an index");
  ok(idx.verbs.length === chainNamespaceMap().length, "the index lists every verb");
  ok(idx.verbs.every((v) => v.servedBy && v.price), "every listed verb names the tool that serves it and its price, read from the catalog rather than typed here");
  const aliasRow = idx.verbs.find((v) => v.verb === "erc20-balance");
  ok(aliasRow && /alias/.test(aliasRow.note || ""), "an alias says so in the index: nobody should think it is a second product");
  ok(!idx.verbs.find((v) => v.verb === "nonce")?.note, "a verb with its own route carries no alias note");

  // The rewrite really is the canonical tool: its own 400 comes back, naming
  // the canonical slug, which is how a buyer learns what they actually called.
  const r = await fetch(`${TARGET}/api/chain/erc20-balance`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }),
  });
  const body = await r.json().catch(() => ({}));
  ok(body.tool === "token-balances", "an aliased call is answered by the canonical tool, which names itself");

  // A verb on a GET-only canonical route must accept a POST: agents POST
  // everything, and that cost us paying buyers once already.
  const posted = await fetch(`${TARGET}/api/chain/block-number`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ network: "base" }),
  });
  ok(posted.status === 200, `POST on a GET-only verb is served (${posted.status})`);

  const missing = await fetch(`${TARGET}/api/chain/not-a-verb`);
  ok(missing.status === 404, "an unknown verb is a 404, not a silent default to some other read");

  // No verb may shadow a catalog route: `/api/chain/<verb>` must never be a
  // path the catalog also claims, or two things would answer one URL.
  const clash = chainNamespaceMap().filter((m) => !m.own && live.has(`/api/chain/${m.verb}`));
  ok(clash.length === 0, `no alias verb collides with a real catalog route${clash.length ? ` - ${clash.map((c) => c.verb).join(", ")}` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
