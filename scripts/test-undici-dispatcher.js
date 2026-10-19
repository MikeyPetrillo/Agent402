// The SSRF guard (src/tools/fetch-guard.js) builds an undici Agent and hands it
// to Node's built-in fetch as its dispatcher. That only works while the undici
// package this repo resolves is one built-in fetch accepts: a dependency bump
// once hoisted a newer major to the top of node_modules, and every guarded
// fetch failed with UND_ERR_INVALID_ARG while the guard's own suite, which
// mocks fetch, stayed green. This drives a real socket through the same Agent.
//
//   node scripts/test-undici-dispatcher.js
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Agent } from "undici";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.ok(pkg.dependencies?.undici, "undici is a declared dependency (src imports it), so a transitive bump cannot swap the copy we resolve");
console.log("ok - undici is declared directly:", pkg.dependencies.undici);

const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
try {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { dispatcher: new Agent() });
  assert.equal(await r.text(), "ok");
  console.log(`ok - built-in fetch accepts the resolved undici Agent as its dispatcher (node bundles undici ${process.versions.undici})`);
} catch (e) {
  assert.fail(`built-in fetch refused the undici Agent (${e?.cause?.code || e?.message}): the resolved undici major does not match Node's fetch`);
} finally {
  srv.close();
}
console.log("test-undici-dispatcher: 2 passed");
