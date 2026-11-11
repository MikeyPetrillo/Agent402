// Boot src/server.js in paid mode (one EVM network, x402 gate mounted) against
// a stub facilitator on a port of its own, with every fetch to a host other
// than loopback failing at once. For suites that read an unpaid 402 and never
// pay: /verify and /settle answer 404.
//
//   const srv = await bootPaidServer({ label: "my-suite", env: { ... } });
//   const r = await fetch(`${srv.url}/api/extract`, { method: "POST", ... }); // 402
//   await srv.stop();
import { createServer } from "node:http";
import { bootServer } from "./boot-server.js";

export async function bootPaidServer({ label = "paid", env = {}, args = [], ipc = false } = {}) {
  const fac = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const known = req.url === "/supported" || req.url === "/rpc";
      res.writeHead(known ? 200 : 404, { "content-type": "application/json" });
      if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
      if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
      res.end("{}");
    });
  });
  await new Promise((r) => fac.listen(0, "127.0.0.1", r));
  const F = `http://127.0.0.1:${fac.address().port}`;
  const closeFac = () => new Promise((r) => { fac.closeAllConnections?.(); fac.close(() => r()); });
  let srv;
  try {
    srv = await bootServer({
      stores: label, ipc,
      args: ["--import", "./scripts/lib/loopback-only-preload.js", ...args],
      env: {
        FREE_MODE: "", NODE_ENV: "test",
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
        FACILITATOR_URL: F, AGENT402_BASE_RPC: `${F}/rpc`, FACILITATOR_GAS_CHECK: "off",
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
        MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "",
        REDIS_URL: "", TARGET_URL: "",
        STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
        MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
        ...env,
      },
    });
  } catch (e) { await closeFac(); throw e; }
  const stop = srv.stop;
  return { ...srv, facilitatorUrl: F, stop: async () => { await stop(); await closeFac(); } };
}
