// The leaderboard's RPC failure messages reach the PUBLIC /api/leaderboard
// body (rpcCall throws -> refresh catches into cached.lastError ->
// getLeaderboardSnapshot() -> res.json). Its Alchemy RPC entry carries
// ALCHEMY_API_KEY in the URL PATH, and until 2026-08-18 the failure message
// interpolated the full URL — so an ordinary Alchemy outage would have
// published the key on an unauthenticated endpoint. Three sibling loops in
// this repo already redact (b20-kit, x402-kit) or name the host only
// (revenue-live laneName); this pins that leaderboard.js does too.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const FAKE_KEY = "alch_LEAKCANARY_0123456789abcdef";
process.env.ALCHEMY_API_KEY = FAKE_KEY;
const { rpcCall } = await import("../src/leaderboard.js");

// Stub "Alchemy": answers a JSON-RPC error that echoes the request URL (an
// upstream can echo anything), plus a non-JSON responder, plus a dead port.
const echo = createServer((req, res) => {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: `rate limited for ${req.url}` } }));
});
const junk = createServer((req, res) => { res.writeHead(502); res.end("<html>bad gateway</html>"); });
await Promise.all([new Promise((r) => echo.listen(0, r)), new Promise((r) => junk.listen(0, r))]);
const urls = [
  `http://127.0.0.1:${echo.address().port}/v2/${FAKE_KEY}`,
  `http://127.0.0.1:${junk.address().port}/v2/${FAKE_KEY}`,
  `http://127.0.0.1:1/v2/${FAKE_KEY}`, // connection refused -> thrown fetch error
];

for (const [label, rpcs] of [["json-rpc error echoing the URL", [urls[0]]], ["non-JSON body", [urls[1]]], ["fetch itself throws", [urls[2]]], ["all three", urls]]) {
  let msg = "";
  try { await rpcCall(rpcs, "eth_blockNumber", [], { passes: 1 }); } catch (e) { msg = String(e?.message || e); }
  ok(msg.startsWith("All RPCs failed for eth_blockNumber"), `${label}: rpcCall throws the failure summary`);
  ok(!msg.includes(FAKE_KEY), `${label}: the API key is NOT in the thrown message (got: ${msg.slice(0, 120)})`);
  // Our OWN naming is host-only; an upstream that echoes its request path
  // (the first stub does, on purpose) still gets its echo redacted, so the
  // path may appear there with the key replaced — the key check above is
  // the invariant, this one pins host-only naming where nothing echoes.
  if (!label.startsWith("json-rpc")) ok(!/\/v2\//.test(msg), `${label}: no URL path in the message (host-only naming)`);
}
echo.close(); junk.close();

// ---- MPP board: the Tempo transfer feed's lastError is published on the
// PUBLIC /api/mpp-leaderboard (window.feed.lastError) and persisted to /data;
// the board's own lastError renders on /mpp-marketplace. Same class as above
// (leak audit 2026-08-19): an upstream error body quoting the key must not
// reach either. The stub API echoes the request's key header in its error.
{
  const TEMPO_KEY = "tdk_LEAKCANARY_abcdef0123456789";
  process.env.TEMPO_DATA_API_KEY = TEMPO_KEY;
  const { emptyFeedState, syncTempoTransfers } = await import("../src/tempo-transfers.js");
  const page = (n, data, next) => ({ ok: true, status: 200, json: async () => ({ data, nextCursor: next }) });
  const good = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sender: "0x01", timestamp: new Date(Date.now() - 60e3 * (i + 1)).toISOString(), sourceAmount: { baseUnits: "1000" }, sourceToken: { address: "0x20C000000000000000000000b9537d11c60E8b50" } }));
  // (a) page 2 answers 401 with a body echoing the key -> state.lastError
  const st = emptyFeedState(); let n = 0;
  await syncTempoTransfers(st, { apiKey: TEMPO_KEY, fetchImpl: async (url, init) => { n++; if (n === 1) return page(1, good, "c2"); return { ok: false, status: 401, json: async () => ({ error: { code: "unauthorized", message: `invalid key ${init.headers["tempo-api-key"]}` } }) }; } });
  ok(typeof st.lastError === "string" && /HTTP 401/.test(st.lastError), `mpp feed: page-2 failure recorded (got: ${st.lastError})`);
  ok(!st.lastError.includes(TEMPO_KEY), "mpp feed: the API key is NOT in the published lastError (code only, no upstream message)");
  // (b) fetch throws with the key in its message (an undici error can quote the URL)
  const st2 = emptyFeedState(); n = 0;
  await syncTempoTransfers(st2, { apiKey: TEMPO_KEY, fetchImpl: async () => { n++; if (n === 1) return page(1, good, "c2"); throw new Error(`socket hang up fetching https://api.tempo.xyz/v1/transfers?key=${TEMPO_KEY}`); } });
  ok(st2.lastError && !st2.lastError.includes(TEMPO_KEY), `mpp feed: a thrown fetch error is redacted before it is recorded (got: ${st2.lastError})`);
  // (c) first page unreadable -> thrown message (the leaderboard stores it as its own lastError)
  let thrown = "";
  try { await syncTempoTransfers(emptyFeedState(), { apiKey: TEMPO_KEY, fetchImpl: async () => { throw new Error(`boom ${TEMPO_KEY}`); } }); } catch (e) { thrown = String(e?.message || e); }
  ok(thrown && !thrown.includes(TEMPO_KEY), `mpp feed: first-page failure message is redacted (got: ${thrown.slice(0, 100)})`);
}
console.log(`\nAll ${pass} assertions passed`);
