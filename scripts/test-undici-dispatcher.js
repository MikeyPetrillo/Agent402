// The SSRF guard (src/tools/fetch-guard.js), the buyers and the server's own
// global pool build undici Agents and hand them to Node's built-in fetch. That
// works only while what we hand it speaks the handler API built-in fetch
// speaks: Node bundles its own undici, and undici 8 (the package this repo
// resolves) dropped the v1 handler API built-in fetch uses, so a bare Agent is
// refused with UND_ERR_INVALID_ARG and every guarded fetch would fail while
// the guard's own suite, which mocks fetch, stayed green. src/fetch-dispatcher.js
// wraps each Agent in undici's Dispatcher1Wrapper. This drives a real socket
// through that pool and through the global dispatcher server.js installs.
//
//   node scripts/test-undici-dispatcher.js
import "./lib/offline-stores.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher, request } from "undici";
import { fetchAgent } from "../src/fetch-dispatcher.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.ok(pkg.dependencies?.undici, "undici is a declared dependency (src imports it), so a transitive bump cannot swap the copy we resolve");
console.log("ok - undici is declared directly:", pkg.dependencies.undici);
let pass = 1;

let seenVersion = null;
const srv = createServer((req, res) => { seenVersion = req.httpVersion; res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;
try {
  const pool = fetchAgent();
  const r = await fetch(url, { dispatcher: pool });
  assert.equal(await r.text(), "ok");
  assert.ok(r instanceof Response, "the answer is the global Response type");
  assert.equal(seenVersion, "1.1");
  console.log(`ok - built-in fetch accepts fetchAgent() as its dispatcher, HTTP/1.1, global Response (node bundles undici ${process.versions.undici})`);
  pass++;

  // The x402 buyer's paid-leg fallback hands the same pool to undici's request().
  const rr = await request(url, { dispatcher: pool, maxRedirections: 0 });
  assert.equal(await rr.body.text(), "ok");
  console.log("ok - undici request() accepts the same pool");
  pass++;
  await pool.close();

  // server.js installs its global pool with setGlobalDispatcher; built-in
  // fetch with no dispatcher must go through it.
  let used = 0;
  const inner = new Agent({ allowH2: false });
  const orig = inner.dispatch.bind(inner);
  inner.dispatch = (opts, handler) => { used++; return orig(opts, handler); };
  setGlobalDispatcher(inner);
  assert.equal(await (await fetch(url)).text(), "ok");
  assert.ok(used >= 1, "built-in fetch went through the dispatcher setGlobalDispatcher installed");
  console.log("ok - built-in fetch uses the global dispatcher undici's setGlobalDispatcher installs");
  pass++;
} catch (e) {
  assert.fail(`built-in fetch did not take the undici pool (${e?.cause?.code || e?.message})`);
} finally {
  srv.close();
}
console.log(`test-undici-dispatcher: ${pass} passed`);
