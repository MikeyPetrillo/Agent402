#!/usr/bin/env node
// A configured-but-DOWN facilitator must cost ONE chain, never the service.
//
//   node scripts/test-rail-outage-isolation.js
//
// WHY, measured rather than reasoned: on 2026-08-02 Celo's facilitator was
// returning HTTP 500. `celo` was configured with a valid URL and key, so the
// missing-config guards did not apply - the client was added, its /supported
// handshake failed, and the network stayed in the offer with nothing able to
// settle it. @x402/core then refuses to BUILD the 402, and EVERY paid route on
// EVERY chain answers 500. /health stays 200 throughout, so it reads healthy
// while all revenue is dead.
//
// Reproduced exactly here: base healthy, celo's facilitator always-500.
//   before the fix: POST /api/hash -> 500 RouteConfigurationError
//   after:          POST /api/hash -> 402 offering Base only
//
// The only thing protecting production was that `celo` had been manually
// removed from PAYMENT_NETWORKS. This test is what makes that unnecessary.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 4200 + (process.pid % 60);
const OK_FAC = PORT + 100;   // healthy: advertises Base
const DEAD_FAC = PORT + 200; // configured but always 500, like Celo's was

const healthy = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    }
    res.writeHead(404); res.end();
  });
});
const dead = createServer((_req, res) => { res.writeHead(500); res.end("Internal Server Error"); });
await new Promise((r) => healthy.listen(OK_FAC, r));
await new Promise((r) => dead.listen(DEAD_FAC, r));

const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT), FREE_MODE: "", NETWORK: "base",
    PAYMENT_NETWORKS: "base,celo",
    FACILITATOR_URL: `http://127.0.0.1:${OK_FAC}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    CELO_FACILITATOR_URL: `http://127.0.0.1:${DEAD_FAC}`,
    CELO_FACILITATOR_KEY: "testkey",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "", STATS_ALLOW_EPHEMERAL: "true",
    NODE_ENV: "test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const done = (code) => {
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { healthy.close(); dead.close(); } catch { /* */ }
  process.exit(code);
};

let up = false;
for (let i = 0; i < 240; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch { /* booting */ }
  await wait(250);
}
ok(up, `server booted with a DOWN facilitator configured (:${PORT})`);
if (!up) { console.error(log.slice(-1500)); done(1); }

// THE PROPERTY: a paid route still quotes, on the healthy chain.
const r = await fetch(`http://localhost:${PORT}/api/hash`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }),
});
ok(r.status === 402, `a paid route answers 402, not 500, while one rail's facilitator is down (got ${r.status})`);

// ...and the 402 must be PAYABLE, not an empty shell. A 402 with no accepts
// would pass a status check while being just as unusable to a buyer.
const hdr = r.headers.get("payment-required") || "";
let decoded = null;
try { decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); } catch { /* */ }
const nets = (decoded?.accepts || []).map((a) => a.network);
ok(nets.includes("eip155:8453"), `the 402 still offers the healthy chain (got ${JSON.stringify(nets)})`);
ok(!nets.includes("eip155:42220"), "the DOWN chain is absent from the offer rather than poisoning it");

// The drop must be reportable, not just survivable.
const rails = await (await fetch(`http://localhost:${PORT}/api/rails`)).json();
ok(rails.degraded === 1, `/api/rails reports exactly one degraded rail (got ${rails.degraded})`);
const celo = (rails.rails || []).find((x) => x.network === "celo");
ok(celo && celo.offered === false && typeof celo.reason === "string",
  `celo is reported un-offered WITH a reason (${celo?.reason})`);
ok(/dropping it from the offer/i.test(log), "the drop is logged loudly at boot, not silently");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
