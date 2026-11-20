#!/usr/bin/env node
// The browser tools' published examples (render on /playground, screenshot and
// page-speed on the home page) load this server's own pages on a sweep's boot,
// never production's: a sweep that loaded production in a real Chrome counted
// as a visit to the site on every run.
//
// The booted server's Chromium goes out through a recording proxy that refuses
// every connection (RENDER_EGRESS_PROXY_URL), so nothing here reaches the
// network, and which hosts the browser tried is visible:
//   - each published browser example answers 200 and the proxy saw no
//     connection to agent402.tools: the own-examples preload answered every
//     request of the page load (the document, its scripts and styles);
//   - render's answer carries this server's playground title;
//   - control: another origin (www.agent402.tools) reaches the proxy, so the
//     proxy is in the path and the first result is not a browser that loaded
//     nothing.
// Needs Playwright Chromium: under CI a missing browser fails; locally it
// skips loudly.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// A proxy that records the host of every request and CONNECT and refuses each.
const seen = [];
const proxy = http.createServer((req, res) => {
  try { seen.push(new URL(req.url).hostname); } catch { seen.push(String(req.headers.host || "")); }
  res.writeHead(403).end();
});
proxy.on("connect", (req, socket) => {
  seen.push(String(req.url).replace(/:\d+$/, ""));
  socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const srv = await bootServer({
  stores: "own-examples-browser",
  args: ["--import", "./scripts/lib/guard-dns-offline.js", "--import", "./scripts/lib/own-examples-preload.js"],
  env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", RENDER_EGRESS_PROXY_URL: proxyUrl, GA_MEASUREMENT_ID: "" },
});

const browserUnavailable = (status, text) => status === 503 && /browser unavailable|executable doesn't exist|playwright/i.test(text);
let skipped = false;
try {
  const spec = await (await fetch(`${srv.url}/openapi.json`)).json();
  const exampleOf = (path, method) => {
    const op = spec.paths?.[path]?.[method];
    if (method === "get") return Object.fromEntries((op?.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => [p.name, p.example]));
    return op?.requestBody?.content?.["application/json"]?.example;
  };
  const call = async (path, method, input) => {
    const r = method === "get"
      ? await fetch(`${srv.url}${path}?${new URLSearchParams(input)}`)
      : await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const type = r.headers.get("content-type") || "";
    const body = /json/.test(type) ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer());
    return { status: r.status, type, body, text: Buffer.isBuffer(body) ? "" : JSON.stringify(body) };
  };

  const shot = exampleOf("/api/screenshot", "get");
  ok(/^https:\/\/agent402\.tools\/?$/.test(shot?.url || ""), `the published screenshot example still names production (${shot?.url})`);
  const first = await call("/api/screenshot", "get", shot);
  if (browserUnavailable(first.status, first.text)) {
    if (process.env.CI) ok(false, `Chromium unavailable in CI: ${first.text.slice(0, 160)}`);
    else { skipped = true; console.log(`skip - Playwright Chromium unavailable locally (${first.text.slice(0, 120)})`); }
  } else {
    ok(first.status === 200 && /image\/png/.test(first.type) && first.body.length > 1000, `screenshot's published example answers a PNG of this server's page (${first.status} ${first.type} ${first.body.length} bytes)`);

    const ps = exampleOf("/api/page-speed", "post");
    const speed = await call("/api/page-speed", "post", ps);
    ok(/^https:\/\/agent402\.tools\/?$/.test(ps?.url || "") && speed.status === 200 && speed.body.status === 200 && speed.body.transfer?.requestCount > 0 && speed.body.heaviestResources?.length > 0 && !speed.body.error,
      `page-speed's published example measures this server's page (${speed.status} page ${speed.body.status}, ${speed.body.transfer?.requestCount} requests, ${speed.body.transfer?.totalBytes} bytes)`);

    const rd = exampleOf("/api/render", "post");
    const render = await call("/api/render", "post", rd);
    ok(/^https:\/\/agent402\.tools\/playground$/.test(rd?.url || "") && render.status === 200 && /playground/i.test(render.body.title || ""),
      `render's published example reads this server's playground (${render.status} "${render.body.title}" rendered=${render.body.rendered})`);

    const own = seen.filter((h) => h === "agent402.tools");
    ok(own.length === 0, `no browser request for agent402.tools reached the network (${own.length}; proxy saw: ${[...new Set(seen)].join(", ") || "nothing"})`);

    // Control: another origin goes out through the proxy (and is refused there).
    const before = seen.length;
    await call("/api/screenshot", "get", { url: "https://www.agent402.tools/" });
    ok(seen.slice(before).includes("www.agent402.tools"), `control: another origin reaches the recording proxy (${seen.slice(before).join(", ") || "nothing"})`);
  }
} finally {
  await srv.stop();
  proxy.close();
}

// The routing wrapper on its own: a read of the published origin is fulfilled
// from the loopback with the published URL kept; anything else, and a POST to
// the published origin, reaches the tool's own handler.
{
  const { answerInBrowser, wrapContextRoutes } = await import("./lib/own-examples-preload.js");
  const local = http.createServer((req, res) => {
    if (req.url === "/moved") { res.writeHead(302, { location: `http://127.0.0.1:${local.address().port}/there?x=1` }).end(); return; }
    res.writeHead(200, { "content-type": "text/html", "x-path": req.url }).end(`<title>${req.url}</title>`);
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const port = local.address().port;
  const fakeRoute = (url, method = "GET") => {
    const r = { fulfilled: null, aborted: null, request: () => ({ url: () => url, method: () => method, headers: () => ({ accept: "text/html", host: "agent402.tools" }) }) };
    r.fulfill = async (o) => { r.fulfilled = o; };
    r.abort = async (why) => { r.aborted = why; };
    return r;
  };
  try {
    const a = fakeRoute("https://agent402.tools/playground?tab=1");
    ok(await answerInBrowser(a, port) === true && a.fulfilled?.status === 200 && a.fulfilled.headers["x-path"] === "/playground?tab=1" && String(a.fulfilled.body).includes("<title>/playground?tab=1</title>"),
      "a read of the published origin is answered from this server");
    const m = fakeRoute("https://agent402.tools/moved");
    await answerInBrowser(m, port);
    ok(m.fulfilled?.status === 302 && m.fulfilled.headers.location === "https://agent402.tools/there?x=1", `a redirect to the loopback names the published origin again (${m.fulfilled?.headers.location})`);
    for (const [url, method] of [["https://www.agent402.tools/", "GET"], ["https://example.com/", "GET"], ["https://agent402.tools/api/hash", "POST"]]) {
      ok(await answerInBrowser(fakeRoute(url, method), port) === false, `not answered here: ${method} ${url}`);
    }
    // Wrapped: the tool's own handler sees only what the wrapper did not answer.
    const handled = [];
    let installed = null;
    const ctx = { route: (pattern, handler) => { installed = handler; return Promise.resolve(); } };
    wrapContextRoutes(ctx, () => port);
    await ctx.route("**/*", async (route) => { handled.push(route.request().url()); });
    const own = fakeRoute("https://agent402.tools/");
    const other = fakeRoute("https://example.com/");
    await installed(own, own.request());
    await installed(other, other.request());
    ok(own.fulfilled?.status === 200 && handled.length === 1 && handled[0] === "https://example.com/", `the tool's handler sees only the other origin (${handled.join(", ")})`);
    const down = fakeRoute(`https://agent402.tools/`);
    const ctx2 = { route: (pattern, handler) => { installed = handler; return Promise.resolve(); } };
    wrapContextRoutes(ctx2, () => 1);
    await ctx2.route("**/*", async (route) => { handled.push(route.request().url()); });
    await installed(down, down.request());
    ok(down.aborted && handled.length === 1, "a published-origin read this server cannot answer is aborted, never passed on to production");
  } finally {
    local.close();
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed${skipped ? " (browser checks skipped: no local Chromium)" : ""}`);
process.exit(fail ? 1 : 0);
