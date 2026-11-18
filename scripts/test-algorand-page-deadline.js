// /algorand waited on two Algorand indexer scans with no deadline, so a
// stalled indexer hung every request until the proxy's 300 s cutoff (502).
// Boots the server against an indexer and node that accept and never answer,
// and requires the page to render within the page deadline plus slack.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); process.exit(1); } pass++; console.log(`ok - ${m}`); };

const stall = createServer(() => { /* accept, never answer */ });
await new Promise((r) => stall.listen(0, "127.0.0.1", r));
const stallUrl = `http://127.0.0.1:${stall.address().port}`;
const srv = await bootServer({
  stores: "alg-page",
  env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", ALGORAND_PAGE_WAIT_MS: "3000",
    ALGORAND_INDEXER_URLS: stallUrl, ALGORAND_ALGOD_URLS: stallUrl, ALGORAND_RELAY_URL: "", ALGORAND_RELAY_TOKEN: "",
    ALGORAND_WALLET_ADDRESS: "C7IIHJ4ZS2KS7ZMPYGD4F3VUEPGXOHORC5RS6LCLTNNC4QZJCRAC2SXGVM" },
});
try {
  const base = srv.url;
  const t0 = Date.now();
  const res = await fetch(`${base}/algorand`, { signal: AbortSignal.timeout(30_000) });
  const html = await res.text();
  const ms = Date.now() - t0;
  ok(res.status === 200, `/algorand answers 200 with the indexer stalled (got ${res.status})`);
  ok(ms < 9_000, `it renders within the page deadline, not the scan's (${ms} ms, deadline 3000 ms)`);
  ok(/unavailable/.test(html), "the stalled sections say unavailable rather than inventing figures");
} finally { await srv.stop(); stall.close(); }
console.log(`OK: ${pass} passed`);
