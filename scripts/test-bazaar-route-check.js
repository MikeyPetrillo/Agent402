// The vendor's per-route bazaar check runs after boot, in slices, never in
// one synchronous loop while the server is starting (src/bazaar-route-check.js).
//   - control: the vendor middleware built plainly runs its check on its own
//     (an invalid declaration is warned about shortly after construction);
//   - built through withBazaarHidden it does not, and every route keeps its
//     own bazaar declaration object afterwards;
//   - the sliced check validates every route, warns as the vendor does, and
//     yields between short slices.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from "@x402/express";
import { x402ResourceServer } from "@x402/core/server";
import { checkBazaarRoutesInSlices, withBazaarHidden } from "../src/bazaar-route-check.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accepts = { scheme: "exact", network: "eip155:8453", payTo: "0x000000000000000000000000000000000000dEaD", price: "$0.001" };
const bazaar = (n) => ({ info: { input: { type: "http", method: "POST", bodyType: "json", body: { n } } }, schema: { type: "object", properties: { input: { type: "object", properties: { body: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } } } } } });
const makeRoutes = () => ({
  "POST /api/good": { accepts, description: "good", extensions: { bazaar: bazaar("text") } },
  "POST /api/bad": { accepts, description: "bad", extensions: { bazaar: bazaar(7) } }, // a number where the schema says string
});
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
try {
  {
    const routes = makeRoutes();
    paymentMiddlewareFromHTTPServer(new x402HTTPResourceServer(new x402ResourceServer([]), routes), undefined, undefined, false);
    await sleep(300);
    ok(warnings.some((w) => /api\/bad.*invalid bazaar extension/.test(w)), `control: the plainly built middleware runs the vendor's check by itself (${warnings.length} warning(s))`);
  }
  warnings.length = 0;
  {
    const routes = makeRoutes();
    const before = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, v.extensions.bazaar]));
    const httpServer = new x402HTTPResourceServer(new x402ResourceServer([]), routes);
    const mw = withBazaarHidden(routes, () => paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
    await sleep(300);
    ok(typeof mw === "function", "the middleware is built");
    ok(warnings.length === 0, `built with the declarations hidden, the vendor runs no check of its own (${warnings.length} warning(s))`);
    ok(Object.entries(routes).every(([k, v]) => v.extensions?.bazaar === before[k]), "every route keeps its own bazaar declaration object");
    ok(httpServer.routes === routes, "the server still reads the same route objects");

    const r = await checkBazaarRoutesInSlices(routes);
    ok(r.routes === 2, `the sliced check visits every declared route (${r.routes})`);
    ok(warnings.some((w) => /api\/bad.*invalid bazaar extension/.test(w)) && !warnings.some((w) => /api\/good/.test(w)), "it warns as the vendor does, for the invalid route only");
  }
  {
    const routes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`POST /api/r${i}`, { accepts, extensions: { bazaar: bazaar("x") } }]));
    // The slicing is pinned as work first: each check burns 4 ms, so a 15 ms
    // slice holds four of them (five with a late clock read), on any host. A
    // turn that held more ran past its slice. The time is then the least of
    // three runs: a host busy with other work stretches one turn of one run.
    let seen = 0, yields = 0, inTurn = 0, mostInTurn = 0, longest = Infinity;
    const burn = () => { seen++; inTurn++; mostInTurn = Math.max(mostInTurn, inTurn); const end = performance.now() + 4; while (performance.now() < end) { /* work */ } };
    for (let k = 0; k < 3 && longest >= 40; k++) {
      seen = 0; yields = 0; inTurn = 0;
      const r = await checkBazaarRoutesInSlices(routes, { sliceMs: 15, validate: burn, yieldTurn: () => { yields++; inTurn = 0; return new Promise((res) => setImmediate(res)); } });
      longest = Math.min(longest, r.longestTurnMs);
    }
    ok(seen === 60, `all 60 routes checked (${seen})`);
    ok(yields >= 10 && mostInTurn <= 5, `the work is cut into turns of a slice each (${yields} yields, at most ${mostInTurn} checks in one turn)`);
    ok(longest < 40, `...and the turns are short (longest ${longest} ms, the least of up to three runs)`);
  }
} finally {
  console.warn = origWarn;
}
console.log(`\ntest-bazaar-route-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
