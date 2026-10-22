// /health?ready=1 (the deploy healthcheck) answers not-ready right after listen until the router worker has
// loaded, so a container in a deploy overlap takes no traffic while route
// queries would run on its main thread; and never longer than
// READY_ROUTER_WAIT_MS, so a worker that will not load cannot fail a deploy.
// With ROUTER_WORKERS=0 there is no worker to wait for and readiness answers
// 200 at once.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), ROUTER_WORKERS: "1", ROUTER_WORKER_TEST_HOOKS: "1", X402_INDEX_CRAWL: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const seen = [];
  const t0 = Date.now();
  let listenAt = 0;
  while (Date.now() - t0 < 90_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health?ready=1`, { signal: AbortSignal.timeout(2000) });
      const live = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      const path = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (!listenAt) listenAt = Date.now();
      seen.push({ at: Date.now() - listenAt, status: r.status, path: path.status, live: live.status, loaded: /worker \d+ loaded/.test(log) });
      if (r.status === 200) break;
    } catch { /* not listening yet */ }
    await wait(150);
  }
  child.kill("SIGTERM");
  await wait(300);
  return { seen, log };
}

{
  const { seen } = await boot({ ROUTER_WORKER_TEST_WARM_DELAY_MS: "4000", READY_ROUTER_WAIT_MS: "30000" });
  const first = seen[0], last = seen[seen.length - 1];
  ok(first?.status === 503 && first.loaded === false, `right after listen, with the worker still loading, /health is 503 (${JSON.stringify(first)})`);
  ok(last?.status === 200 && last.loaded === true, `it turns 200 once the worker has loaded (${JSON.stringify(last)})`);
  ok(seen.filter((s) => s.status === 503).every((s) => !s.loaded || s.at < 1000), "it never stays 503 after the worker loaded");
  ok(seen.every((s) => s.live === 200), "plain /health (liveness, the monitors) answers 200 throughout");
  ok(seen[seen.length - 1].path === 200, "/health/ready turns 200 with /health?ready=1 (the path form Railway's setting accepts)");
  ok(seen.some((s) => s.path === 503), "/health/ready is 503 while the worker loads");
}
{
  const { seen } = await boot({ ROUTER_WORKER_TEST_WARM_DELAY_MS: "60000", READY_ROUTER_WAIT_MS: "3000" });
  const last = seen[seen.length - 1];
  ok(last?.status === 200 && last.loaded === false && last.at >= 2500 && last.at < 8000, `a worker that will not load holds /health only for READY_ROUTER_WAIT_MS (${JSON.stringify(last)})`);
}
{
  const { seen } = await boot({ ROUTER_WORKER_TEST_WARM_DELAY_MS: "60000", READY_ROUTER_WAIT_MS: "0" });
  ok(seen[0]?.status === 200, `READY_ROUTER_WAIT_MS=0 turns the wait off (${JSON.stringify(seen[0])})`);
}

{
  const { seen } = await boot({ ROUTER_WORKERS: "0", READY_ROUTER_WAIT_MS: "60000" });
  ok(seen[0]?.status === 200 && seen[0]?.path === 200, `ROUTER_WORKERS=0: readiness does not wait for a worker (${JSON.stringify(seen[0])})`);
}
console.log(`\ntest-health-router-warming: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
