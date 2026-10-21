// HEAD paywall-bypass regression lock (found 2026-07-23 via MPPScan's prober):
// Express serves HEAD through app.get(), but every gate keyed on
// "METHOD /path" — so an unpaid HEAD skipped the funnel, PoW gate, replay
// guard AND the x402 paywall and executed the handler for free (upstream-
// metered GET tools burned real quota with zero revenue). The fix rewrites
// HEAD on catalog GET routes to GET for the gate chain and suppresses the
// body at res.end (RFC 9110 HEAD semantics).
//
// Locks:
//   1. unpaid HEAD on a catalog GET route -> 402 (not 200), EMPTY body,
//      with the same challenge headers a GET gets (PAYMENT-REQUIRED +
//      WWW-Authenticate when the MPP shim is on);
//   2. unpaid GET on the same route still 402s (no regression);
//   3. HEAD on free surfaces (/health, /llms.txt) stays 200 — only paid
//      catalog routes are gated.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";

const PORT = 3087;
const FAC_PORT = 3088;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The spelling variants go out over node:http, so no URL parser on the
// client side rewrites the path before the server reads it.
const rawRequest = (method, path) => new Promise((resolve, reject) => {
  const body = method === "POST" ? "{}" : null;
  const rq = httpRequest({ host: "127.0.0.1", port: PORT, method, path, headers: body ? { "content-type": "application/json", "content-length": String(body.length) } : {} }, (r) => {
    let bodyLength = 0;
    r.on("data", (c) => { bodyLength += c.length; });
    r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, bodyLength }));
  });
  rq.on("error", reject);
  if (body) rq.write(body);
  rq.end();
});

// Stub facilitator: only /supported is needed — the test never pays, it only
// needs the paywall able to mint 402 challenges (requires synced kinds).
facilitator = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    MPP_SECRET_KEY: "test-mpp-secret",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  const head = await fetch(`${B}/api/uuid`, { method: "HEAD" });
  ok(head.status === 402, `unpaid HEAD on a paid GET tool -> 402 (got ${head.status})`);
  ok(!!head.headers.get("payment-required"), "HEAD 402 carries PAYMENT-REQUIRED (same as GET)");
  ok(!!head.headers.get("www-authenticate"), "HEAD 402 carries WWW-Authenticate (MPP challenge)");
  const headBody = await head.text();
  ok(headBody.length === 0, `HEAD body is empty (got ${headBody.length} bytes)`);

  // A path that differs from the catalog's only by case or trailing slashes
  // takes the same gate chain (Express routes those to the same handler).
  for (const variant of ["/API/UUID", "/api/uuid/", "/Api/Uuid//", "/api/uuid/?version=4"]) {
    for (const method of ["HEAD", "GET", "POST"]) {
      const r = await fetch(`${B}${variant}`, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
      ok(r.status === 402 && !!r.headers.get("payment-required"), `unpaid ${method} ${variant} -> 402 with PAYMENT-REQUIRED (got ${r.status})`);
    }
  }
  // A percent-encoded or repeated-slash spelling resolves the way the
  // load-shed gate and the unpaid-quote budget resolve it
  // (normalizeCatalogPath), so it takes the same gate chain too. Sent over
  // node:http so the path reaches the server exactly as written.
  for (const variant of ["/api/%75uid", "/api/%75%75id", "//api//uuid", "/api//uuid", "//API//UUID//", "/%61pi/uuid/", "/api/%55UID?version=4"]) {
    for (const method of ["HEAD", "GET", "POST"]) {
      const r = await rawRequest(method, variant);
      ok(r.status === 402 && !!r.headers["payment-required"], `unpaid ${method} ${variant} -> 402 with PAYMENT-REQUIRED (got ${r.status})`);
      if (method === "HEAD") ok(r.bodyLength === 0, `HEAD ${variant} body is empty (got ${r.bodyLength} bytes)`);
    }
  }
  const headPostVariant = await fetch(`${B}/API/HASH/`, { method: "HEAD" });
  ok(headPostVariant.status === 402, `unpaid HEAD on a case-changed POST-only path -> 402 (got ${headPostVariant.status})`);

  const get = await fetch(`${B}/api/uuid`);
  ok(get.status === 402, `unpaid GET still 402s (got ${get.status})`);
  // POST on a GET-only tool takes the SAME gate chain (2026-08-28 alias): an
  // unpaid POST is a 402 with the same challenge, never a free execution.
  const postAlias = await fetch(`${B}/api/uuid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 4 }) });
  ok(postAlias.status === 402 && !!postAlias.headers.get("payment-required"), `unpaid POST on a GET-only paid tool -> 402 with PAYMENT-REQUIRED, not 405 and never free (got ${postAlias.status})`);
  // ... and the other direction: GET / HEAD on a POST-only paid tool answers
  // the same unpaid 402 (the paywall is VISIBLE to GET-only trust indexers).
  const getOnPost = await fetch(`${B}/api/hash`);
  ok(getOnPost.status === 402 && !!getOnPost.headers.get("payment-required"), `unpaid GET on POST-only /api/hash -> 402 with PAYMENT-REQUIRED, not 405 (got ${getOnPost.status})`);
  const headOnPost = await fetch(`${B}/api/hash`, { method: "HEAD" });
  ok(headOnPost.status === 402 && !!headOnPost.headers.get("payment-required") && (await headOnPost.text()).length === 0, `unpaid HEAD on POST-only /api/hash -> 402, same headers, empty body (got ${headOnPost.status})`);
  const postGarbage = await fetch(`${B}/api/uuid`, { method: "POST", headers: { "Content-Type": "application/json", "payment-signature": "bm90LWEtcGF5bWVudA" }, body: "{}" });
  ok(postGarbage.status === 402, `a POST with a garbage payment header on a GET-only tool is refused like a GET would be (got ${postGarbage.status})`);
  ok((await get.text()).length > 0, "GET 402 keeps its JSON body (no over-suppression)");

  const health = await fetch(`${B}/health`, { method: "HEAD" });
  ok(health.status === 200, `HEAD /health stays 200 (got ${health.status})`);
  const llms = await fetch(`${B}/llms.txt`, { method: "HEAD" });
  ok(llms.status === 200, `HEAD /llms.txt stays 200 (got ${llms.status})`);

  console.log(`\nPASS - ${pass} checks (HEAD paywall bypass closed)`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
