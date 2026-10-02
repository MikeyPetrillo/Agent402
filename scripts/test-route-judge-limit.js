// The free /api/route answer is judged per caller only up to an hourly limit.
//
// Each uncached question on /api/route costs one judgment-model call. Without a
// per-caller bound, one client could spend the day's judgment budget on a free
// endpoint and leave the paid route-execute path on the lexical fallback. Boots
// the real server (FREE_MODE, keyless) against a stub judgment endpoint with
// ROUTE_JUDGE_PER_IP_HOUR=2 and asks three different questions: two are judged,
// the third is answered with the same lexical rows and judged:{skipped:"rate"},
// never an error. The free path's share of the daily ceiling is pinned in
// test-tool-judge.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, proc = null, judge = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); judge?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let judgeCalls = 0;
judge = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    judgeCalls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answers: { best: { choice: "c1", confidence: 0.97 } } }));
  });
});
const [PORT, JUDGE_PORT] = [await getFreePort(), await getFreePort()];
await new Promise((r) => judge.listen(JUDGE_PORT, "127.0.0.1", r));
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", REDIS_URL: "",
    TYPESAFE_API_KEY: "test-judge-key", TYPESAFE_API_URL: `http://127.0.0.1:${JUDGE_PORT}/v1/systemone`,
    ROUTE_JUDGE_PER_IP_HOUR: "2" },
  stdio: "ignore",
});
const B = `http://127.0.0.1:${PORT}`;

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  const ask = async (q) => { const r = await fetch(`${B}/api/route?q=${encodeURIComponent(q)}&include=local&top=5`); return { status: r.status, body: await r.json() }; };
  const qs = ["convert json to csv", "hash a string with sha256", "decode a base64 string"];
  const a = await ask(qs[0]);
  ok(a.status === 200 && Array.isArray(a.body.results) && a.body.results.length >= 2, `a local route query answers rows (${a.status}, ${a.body.results?.length})`);
  ok(a.body.judged && !a.body.judged.skipped && judgeCalls === 1, `the first question is judged (${JSON.stringify(a.body.judged)}, judge calls ${judgeCalls})`);
  const b = await ask(qs[1]);
  ok(b.body.judged && !b.body.judged.skipped && judgeCalls === 2, "the second question is judged");
  const c = await ask(qs[2]);
  ok(c.status === 200 && Array.isArray(c.body.results) && c.body.results.length >= 2, "over the limit the caller still gets rows, not an error");
  ok(c.body.judged?.skipped === "rate" && /hourly allowance/.test(c.body.judged.note || "") && judgeCalls === 2, `over the limit no model call is made and the answer says why (${JSON.stringify(c.body.judged)}, judge calls ${judgeCalls})`);
  // The allowance is per caller: another client is still judged.
  const other = await fetch(`${B}/api/route?q=${encodeURIComponent("resize an image")}&include=local&top=5`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
  const ob = await other.json();
  ok(other.status === 200 && ob.judged && !ob.judged.skipped && judgeCalls === 3, `another caller keeps its own allowance (${JSON.stringify(ob.judged)}, judge calls ${judgeCalls})`);
  console.log(`\nPASS - ${pass} checks (route judge limit)`);
  proc.kill("SIGKILL"); judge.close();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
