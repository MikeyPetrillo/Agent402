#!/usr/bin/env node
// The CI sweeps' server answers the published examples that name its own
// origin (https://agent402.tools: the home page, /samples/..., /fixtures/...) from itself
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
//   - the control (www.agent402.tools, another origin) reaching the stand-in
//     proves that layer is live, so the first result is not the outer fetch
//     that happened to work;
//   - the home-page examples (http-check, site-map) are read from this
//     server too, and report the published URL;
//   - a fixture example (pdf-info on /fixtures/sample-invoice.pdf) is read
//     from this server too, and reports the published URL, not the loopback.
// Offline: nothing leaves the machine.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { isHost } from "./lib/url-host.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// The stand-in for production: every fetch to that origin that reaches it
// answers a card of a different name, so which layer answered is visible.
// It routes on the parsed host (scripts/lib/url-host.js), imported by file URL
// since a data: module has no directory of its own.
const URL_HOST = new URL("./lib/url-host.js", import.meta.url).href;
const STAND_IN = "data:text/javascript," + encodeURIComponent(
  `import { isHost } from ${JSON.stringify(URL_HOST)}; ` +
  'const real = globalThis.fetch; globalThis.fetch = (input, init) => { if (isHost(input, "agent402.tools") || isHost(input, "www.agent402.tools")) return Promise.resolve(new Response(JSON.stringify({ name: "Production Stand-in", description: "x", url: "https://example.com/a2a", version: "1.0.0", protocolVersion: "0.3.0", capabilities: {}, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [{ id: "s", name: "s", description: "s", tags: ["t"] }] }), { status: 200, headers: { "content-type": "application/json" } })); return real(input, init); };',
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

  // Control: another origin (the www name), so the preload passes it on and
  // the production stand-in answers.
  const c = await post("/api/a2a-card-fetch", { url: "https://www.agent402.tools/samples/a2a-agent-card.json" });
  const cb = await c.json().catch(() => ({}));
  ok(c.status === 200 && cb.card?.name === "Production Stand-in", `control: another origin's path reaches the production stand-in (${c.status} ${cb.card?.name})`);

  // The home-page examples: the stand-in answers JSON, so an HTML home page
  // with its own title can only be this server's.
  const examples = (path) => spec.paths?.[path]?.post?.requestBody?.content?.["application/json"]?.example;
  const hc = await post("/api/http-check", examples("/api/http-check"));
  const hcb = await hc.json().catch(() => ({}));
  ok(examples("/api/http-check")?.url === "https://agent402.tools" && hc.status === 200 && hcb.status === 200 && /text\/html/.test(hcb.headers?.["content-type"] || "") && /^https:\/\/agent402\.tools\/?$/.test(hcb.finalUrl || ""),
    `the http-check example reads this server's home page and reports the published URL (${hc.status} ${hcb.status} ${hcb.headers?.["content-type"]} ${hcb.finalUrl})`);
  const sm = await post("/api/site-map", { ...examples("/api/site-map"), limit: 5 });
  const smb = await sm.json().catch(() => ({}));
  ok(sm.status === 200 && Array.isArray(smb.urls) && smb.urls.length > 0 && smb.urls.every((u) => isHost(u, "agent402.tools")),
    `the site-map example reads this server's robots.txt and sitemap (${sm.status} ${smb.urls?.length} urls)`);

  const p = await post("/api/pdf-info", { url: "https://agent402.tools/fixtures/sample-invoice.pdf" });
  const pb = await p.json().catch(() => ({}));
  ok(p.status === 200 && pb.pages === 1, `a /fixtures/ example is read from this server too (${p.status} pages=${pb.pages})`);
  ok(!/127\.0\.0\.1/.test(JSON.stringify(pb)), "the answer names the published URL, never the loopback hop");

  // A call to a paid route on this origin is not a read of a file: this
  // free-mode boot has no paywall, so answered here the example would read
  // 200 where the published route answers 402. It goes to the origin (here
  // the stand-in), and a hash answer would mean this server answered it.
  const sp = await post("/api/seller-payability", examples("/api/seller-payability"));
  const spb = await sp.json().catch(() => ({}));
  ok(examples("/api/seller-payability")?.method === "POST" && sp.status === 200 && /Production Stand-in/.test(spb.unpaidCall?.bodySlice || "") && !/"hex"/.test(spb.unpaidCall?.bodySlice || ""),
    `the seller-payability example's POST to a paid route is sent to the published origin, not answered here (${sp.status} ${String(spb.unpaidCall?.bodySlice).slice(0, 60)})`);
} finally {
  await srv.stop();
}

// Only this server's own origin is redirected: the same /samples/ path on
// another host, or on plain http, goes to the network untouched.
{
  const { ownExampleUrl, EXAMPLE_ORIGIN } = await import("./lib/own-examples-preload.js");
  ok(ownExampleUrl(`${EXAMPLE_ORIGIN}/samples/a2a-agent-card.json`, 4321) === "http://127.0.0.1:4321/samples/a2a-agent-card.json", "control: this origin's /samples/ file maps to the loopback");
  ok(ownExampleUrl(EXAMPLE_ORIGIN, 4321) === "http://127.0.0.1:4321/" && ownExampleUrl(`${EXAMPLE_ORIGIN}/sitemap.xml?x=1`, 4321) === "http://127.0.0.1:4321/sitemap.xml?x=1", "control: this origin's home page and other paths map to the loopback");
  ok(ownExampleUrl(`${EXAMPLE_ORIGIN}/api/hash`, 4321, "POST") === null && ownExampleUrl(`${EXAMPLE_ORIGIN}/api/hash`, 4321, "post") === null && ownExampleUrl(`${EXAMPLE_ORIGIN}/health`, 4321, "HEAD") === "http://127.0.0.1:4321/health",
    "a POST to this origin is not redirected (a paid route has no paywall on a free-mode boot); a HEAD is");
  for (const other of ["https://www.agent402.tools/", "https://user:pw@agent402.tools/", "https://agent402.tools:8443/", "https://other.example/samples/a2a-agent-card.json", "http://agent402.tools/samples/a2a-agent-card.json", "https://agent402.tools.evil.example/samples/a2a-agent-card.json", "https://other.example/fixtures/sample-invoice.pdf"]) {
    ok(ownExampleUrl(other, 4321) === null, `another origin's sample path is not redirected (${other})`);
  }
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
