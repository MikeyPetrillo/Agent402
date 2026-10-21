// The wallet subscriber's manage routes (/api/mpp/monitors/:subId and its
// /cancel) read the manage token from an X-Manage-Token header or a JSON body
// as well as ?token= (the form in links already emailed), and every answer is
// no-store with no referrer. The reader is checked offline; the routes are
// checked against a booted server (its own, on a free port, MPP engine on,
// nothing broadcast).
//
// Run: node scripts/test-mpp-manage-token.js
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { manageTokenFrom, MANAGE_RESPONSE_HEADERS } from "../src/manage-token.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- the reader ------------------------------------------------------------
ok(manageTokenFrom({ headers: { "x-manage-token": "h" }, body: { token: "b" }, query: { token: "q" } }) === "h", "the header wins");
ok(manageTokenFrom({ headers: {}, body: { token: "b" }, query: { token: "q" } }) === "b", "then the JSON body");
ok(manageTokenFrom({ headers: {}, body: {}, query: { token: "q" } }) === "q", "then ?token=, so emailed links keep working");
ok(manageTokenFrom({ headers: {}, body: { token: ["x"] }, query: { token: ["y"] } }) === "", "a non-string token is no token");
ok(manageTokenFrom({}) === "" && manageTokenFrom(null) === "", "no token anywhere is empty");
ok(MANAGE_RESPONSE_HEADERS["Cache-Control"] === "no-store" && MANAGE_RESPONSE_HEADERS["Referrer-Policy"] === "no-referrer", "the response headers are no-store and no-referrer");

// ---- the routes use it -----------------------------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const mppManageTokenOf = "), src.indexOf("// Monitor scheduler: the recurring fulfilment engine."));
  ok(/const mppManageTokenOf = manageTokenFrom;/.test(block), "the routes read the token through manageTokenFrom");
  ok(/manageTokenOk\(subId, mppManageTokenOf\(req\)\)/.test(block) && /_mppSubs\.cancel\(String\(req\.params\.subId \|\| ""\), mppManageTokenOf\(req\)\)/.test(block), "both status and cancel check that token");
  ok(/app\.get\("\/api\/mpp\/monitors\/:subId", mppMonitorStatus\)/.test(block) && /app\.post\("\/api\/mpp\/monitors\/:subId", mppMonitorStatus\)/.test(block), "status answers GET and POST");
  ok(!/req\.query\.token\b/.test(block), "no route reads ?token= around the reader");
}

// ---- against a booted server -----------------------------------------------
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "true",
    MPP_SECRET_KEY: "test-mpp-manage-secret", POW_SECRET: "test-mpp-manage-pow",
    TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    TEMPO_CURRENCY: "usdc", TEMPO_DECIMALS: "6",
    // A throwaway sponsor key so the engine mounts; this test never broadcasts.
    TEMPO_SUBSCRIPTION_FEE_PAYER_KEY: "0x" + "33".repeat(32),
    MONITOR_SCHEDULER: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
    STRIPE_SECRET_KEY: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
  },
  stdio: "ignore",
});
try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
  ok(up, "server booted");
  const off = up ? await (await fetch(`${B}/api/mpp/monitors`)).json() : {};
  ok(Array.isArray(off.products) && off.products.length > 0, "the subscription engine is mounted (else the route checks below would be vacuous)");
  const heads = (r, what) => {
    ok(r.headers.get("cache-control") === "no-store", `${what}: Cache-Control no-store`);
    ok(r.headers.get("referrer-policy") === "no-referrer", `${what}: Referrer-Policy no-referrer (${r.headers.get("referrer-policy")})`);
  };
  const g = await fetch(`${B}/api/mpp/monitors/mpp_nosuch?token=abc`);
  ok(g.status === 404 && (await g.json()).error === "Unknown subscription", "GET with ?token= reaches the status handler");
  heads(g, "GET status");
  const h = await fetch(`${B}/api/mpp/monitors/mpp_nosuch`, { headers: { "X-Manage-Token": "abc" } });
  ok(h.status === 404 && (await h.json()).error === "Unknown subscription", "GET with X-Manage-Token reaches the status handler");
  heads(h, "GET status (header)");
  const p = await fetch(`${B}/api/mpp/monitors/mpp_nosuch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "abc" }) });
  ok(p.status === 404 && (await p.json()).error === "Unknown subscription", "POST with a JSON token reaches the status handler");
  heads(p, "POST status");
  const c = await fetch(`${B}/api/mpp/monitors/mpp_nosuch/cancel`, { method: "POST", headers: { "content-type": "application/json", "X-Manage-Token": "abc" }, body: "{}" });
  ok(c.status >= 400 && c.status < 500, `cancel with X-Manage-Token is refused for an unknown subscription (${c.status})`);
  heads(c, "POST cancel");
} finally {
  proc.kill("SIGKILL");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
