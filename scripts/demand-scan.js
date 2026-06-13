// Pull the agent402.app "Demand Intelligence" board: what agents search for that
// the marketplace can't supply. Endpoints per the marketplace API docs. Runs in
// CI (sandbox has no egress). Needs A402APP_KEY.
const API = (process.env.A402APP_BASE || "https://marketplace.agent402.app").replace(/\/$/, "");
const KEY = process.env.A402APP_KEY;
if (!KEY) { console.error("A402APP_KEY required"); process.exit(1); }

async function api(path) {
  try {
    const res = await fetch(`${API}${path}`, {
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

const reports = [
  ["UNMET DEMAND (0-result searches — the build list)", "/api/v1/demand/unmet?period=30d&limit=100"],
  ["TOP SEARCHES (30d)", "/api/v1/demand/top-searches?period=30d&limit=50"],
  ["TRENDING (7d growth)", "/api/v1/demand/trending?period=7d&limit=30"],
  ["OVERVIEW", "/api/v1/demand/overview"],
];

for (const [label, path] of reports) {
  const { status, json } = await api(path);
  console.log(`\n===== ${label} =====  GET ${path} -> ${status}`);
  if (status === 200) {
    console.log(JSON.stringify(json, null, 2).slice(0, 6000));
  } else {
    console.log(typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json).slice(0, 400));
  }
}
