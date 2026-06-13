// Pull the agent402.app "Demand Intelligence" board: what agents are asking for
// that the marketplace can't yet supply. We don't know the exact endpoint, so
// try the documented candidates and dump whatever returns structured data.
// Runs in CI (the sandbox has no egress). Needs A402APP_KEY.
const API = (process.env.A402APP_BASE || "https://marketplace.agent402.app").replace(/\/$/, "");
const KEY = process.env.A402APP_KEY;
if (!KEY) { console.error("A402APP_KEY required"); process.exit(1); }

async function api(method, path) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: `ERR ${e.message}` };
  }
}

const candidates = [
  "/api/v1/demand", "/api/v1/demands", "/api/v1/demand-intelligence",
  "/api/v1/unmet", "/api/v1/unmet-demand", "/api/v1/insights/demand",
  "/api/v1/market/demand", "/api/v1/marketplace/demand", "/api/v1/analytics/demand",
  "/api/v1/searches", "/api/v1/queries", "/api/v1/gaps", "/api/v1/needs",
  "/api/v1/categories", "/api/v1/services", "/api/v1/discovery",
];

let hit = false;
for (const path of candidates) {
  const { status, json } = await api("GET", path);
  const summary = typeof json === "string" ? json.slice(0, 120) : JSON.stringify(json).slice(0, 160);
  console.log(`GET ${path} -> ${status}  ${summary}`);
  if (status === 200 && typeof json === "object") {
    hit = true;
    console.log("=== FULL PAYLOAD ===");
    console.log(JSON.stringify(json, null, 2).slice(0, 8000));
    console.log("=== END ===\n");
  }
}
if (!hit) console.log("\nNo demand endpoint returned 200 with JSON — inspect the 200/40x statuses above for the right path.");
