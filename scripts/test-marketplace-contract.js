// Guards the marketplace registration contract against the class of bug that
// silently broke marketplace buys: a changed bridge-token format must actually
// propagate to an ALREADY-LISTED service (registration must UPDATE, not skip).
// Runs the real register script against a mock agent402.app — offline, no
// secrets, no money.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marketplaceSlugToken } from "../src/marketplace-token.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const TOKEN = "test-master-secret";
const SITE = "https://agent402.tools";
const AGENT_ID = "agent1";

const reqs = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    reqs.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (req.method === "GET" && u === "/api/v1/agents") return json([{ id: AGENT_ID, name: "Agent402 Tools", status: "active", is_published: true }]);
    if (req.method === "GET" && u === `/api/v1/agents/${AGENT_ID}/services`)
      return json([{ id: "svc-extract", slug: "extract", name: "Extract Article", service_endpoint: `${SITE}/mkt/OLD_MASTER_TOKEN/extract` }]);
    if (req.method === "PATCH" && u.startsWith(`/api/v1/agents/${AGENT_ID}/services/`)) return json({ id: u.split("/").pop() });
    if (req.method === "POST" && u === `/api/v1/agents/${AGENT_ID}/services`) return json({ id: "new", invoke_url: "https://agent402.app/invoke" });
    if (req.method === "DELETE") return json({ ok: true });
    return json({ id: AGENT_ID, ok: true });
  });
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const script = join(dirname(fileURLToPath(import.meta.url)), "marketplace-register.js");
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [script], {
    env: { ...process.env, A402APP_BASE: base, A402APP_KEY: "test", MARKETPLACE_TOKEN: TOKEN, SITE, DRY_RUN: "" },
    stdio: "inherit",
  });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("register exited " + code))));
});
server.close();

const expected = `${SITE}/mkt/${marketplaceSlugToken(TOKEN, "extract")}/extract`;

// 1) The already-listed "extract" service must be UPDATED (PATCH) or recreated
//    (DELETE+POST) with the NEW per-slug endpoint — never silently skipped.
const updated = reqs.find((r) =>
  (r.method === "PATCH" && r.url === `/api/v1/agents/${AGENT_ID}/services/svc-extract` && r.body?.service_endpoint === expected) ||
  (r.method === "POST" && r.url === `/api/v1/agents/${AGENT_ID}/services` && r.body?.slug === "extract" && r.body?.service_endpoint === expected)
);
if (!updated) fail("existing 'extract' service was not updated with the per-slug endpoint (registration skipped it)");
console.log("1. registration updates an existing service's endpoint (per-slug) ✓");

// 2) The stale master-token endpoint must never be re-sent anywhere.
if (reqs.some((r) => JSON.stringify(r.body || "").includes("OLD_MASTER_TOKEN"))) fail("a stale master-token endpoint was re-sent");
console.log("2. no stale master-token endpoint re-sent ✓");

// 3) Shared per-slug token is deterministic and 32 hex chars.
if (!/^[0-9a-f]{32}$/.test(marketplaceSlugToken(TOKEN, "extract"))) fail("token format wrong");
if (marketplaceSlugToken("", "x") !== "") fail("empty master must yield empty token");
console.log("3. shared per-slug token is deterministic ✓");

console.log("\nmarketplace contract: all assertions passed ✓");
