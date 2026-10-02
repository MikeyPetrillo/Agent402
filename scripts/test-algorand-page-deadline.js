// /algorand waited on two Algorand indexer scans with no deadline, so a
// stalled indexer hung every request until the proxy's 300 s cutoff (502).
// Boots the server against an indexer and node that accept and never answer,
// and requires the page to render within the page deadline plus slack.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); process.exit(1); } pass++; console.log(`ok - ${m}`); };

const stall = createServer(() => { /* accept, never answer */ });
await new Promise((r) => stall.listen(0, "127.0.0.1", r));
const stallUrl = `http://127.0.0.1:${stall.address().port}`;
const port = await getFreePort();
const dir = mkdtempSync(join(tmpdir(), "a402-alg-"));
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off",
    X402_ECONOMY_DB: join(dir, "econ.db"), ALGORAND_PAGE_WAIT_MS: "3000",
    ALGORAND_INDEXER_URLS: stallUrl, ALGORAND_ALGOD_URLS: stallUrl, ALGORAND_RELAY_URL: "", ALGORAND_RELAY_TOKEN: "",
    ALGORAND_WALLET_ADDRESS: "C7IIHJ4ZS2KS7ZMPYGD4F3VUEPGXOHORC5RS6LCLTNNC4QZJCRAC2SXGVM" },
  stdio: "ignore",
});
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const t0 = Date.now();
  const res = await fetch(`${base}/algorand`, { signal: AbortSignal.timeout(30_000) });
  const html = await res.text();
  const ms = Date.now() - t0;
  ok(res.status === 200, `/algorand answers 200 with the indexer stalled (got ${res.status})`);
  ok(ms < 9_000, `it renders within the page deadline, not the scan's (${ms} ms, deadline 3000 ms)`);
  ok(/unavailable/.test(html), "the stalled sections say unavailable rather than inventing figures");
} finally { proc.kill("SIGTERM"); stall.close(); }
console.log(`OK: ${pass} passed`);
