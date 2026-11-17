#!/usr/bin/env node
// The CI sweeps' server answers the published examples that name its own
// files (https://agent402.tools/samples/..., /fixtures/...) from itself
// (scripts/lib/own-examples-preload.js), so a sweep never depends on what
// production serves at that minute: a2a-card-fetch's sample card answered
// production's 404 to the strict sweep once.
//
// The booted server here cannot reach agent402.tools at all: a first preload
// answers every fetch to that origin with a stand-in card of another name,
// and the address guard's name lookups answer offline (guard-dns-offline.js).
// So:
//   - the published a2a-card-fetch example answering 200 with the sample card
//     proves the server read its own copy;
//   - the control (a path on the same origin the server does not serve as a
//     sample) reaching the stand-in proves that layer is live, so the first
//     result is not the outer fetch that happened to work;
//   - a fixture example (pdf-info on /fixtures/sample-invoice.pdf) is read
//     from this server too, and reports the published URL, not the loopback.
// Offline: nothing leaves the machine.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// The stand-in for production: every fetch to that origin that reaches it
// answers a card of a different name, so which layer answered is visible.
const STAND_IN = "data:text/javascript," + encodeURIComponent(
  'const real = globalThis.fetch; globalThis.fetch = (input, init) => { const u = typeof input === "string" ? input : input?.url || String(input); if (u.startsWith("https://agent402.tools")) return Promise.resolve(new Response(JSON.stringify({ name: "Production Stand-in", description: "x", url: "https://example.com/a2a", version: "1.0.0", protocolVersion: "0.3.0", capabilities: {}, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [{ id: "s", name: "s", description: "s", tags: ["t"] }] }), { status: 200, headers: { "content-type": "application/json" } })); return real(input, init); };',
);

const srv = await bootServer({
  stores: "own-examples",
  // Order matters: the stand-in is installed first, so the own-examples
  // preload wraps it and anything it passes on meets the stand-in.
  args: ["--import", STAND_IN, "--import", "./scripts/lib/guard-dns-offline.js", "--import", "./scripts/lib/own-examples-preload.js"],
  env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
});
const post = (path, body) => fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  // The example exactly as the sweeps read it: the OpenAPI request example.
  const spec = await (await fetch(`${srv.url}/openapi.json`)).json();
  const exampleUrl = spec.paths?.["/api/a2a-card-fetch"]?.post?.requestBody?.content?.["application/json"]?.example?.url;
  ok(exampleUrl === "https://agent402.tools/samples/a2a-agent-card.json", `the published a2a-card-fetch example still names production (${exampleUrl})`);

  const r = await post("/api/a2a-card-fetch", { url: exampleUrl });
  const body = await r.json().catch(() => ({}));
  ok(r.status === 200 && body.valid === true && body.summary?.name === "Sample Weather Agent" && body.source === exampleUrl,
    `the published example is answered from this server's own sample card (${r.status} ${body.summary?.name} ${body.source})`);

  // Control: same origin, a path the server does not serve as a sample, so
  // the preload passes it on and the production stand-in answers.
  const c = await post("/api/a2a-card-fetch", { url: "https://agent402.tools/not-a-sample/agent-card.json" });
  const cb = await c.json().catch(() => ({}));
  ok(c.status === 200 && cb.card?.name === "Production Stand-in", `control: a path outside /samples and /fixtures reaches the production stand-in (${c.status} ${cb.card?.name})`);

  const p = await post("/api/pdf-info", { url: "https://agent402.tools/fixtures/sample-invoice.pdf" });
  const pb = await p.json().catch(() => ({}));
  ok(p.status === 200 && pb.pages === 1, `a /fixtures/ example is read from this server too (${p.status} pages=${pb.pages})`);
  ok(!/127\.0\.0\.1/.test(JSON.stringify(pb)), "the answer names the published URL, never the loopback hop");
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
