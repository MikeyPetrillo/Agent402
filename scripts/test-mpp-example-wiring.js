// MPP request-example wiring, end to end through the production pieces,
// offline: a registry row verified by the MPP index (src/mpp-index.js
// verifyMppSeller, which reads the seller's llms.txt) -> the index snapshot ->
// the Tempo catalog and ranker (src/tempo-sellers.js) -> the resolver's
// candidate builders (src/sor-candidates.js, the functions resolveExternalSeller
// in src/server.js uses) -> route-execute -> payTempo against a stub MPP
// seller. The body the seller receives must be the reshaped one and the
// receipt must name the rename. Each unit test of these pieces injects the
// next piece's input, so a break in the hand-off between them passed every
// one of them.
import "./lib/file-mode.js";
import { mintTempoTestCredential } from "./lib/tempo-test-credential.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge } from "mppx";

const scratch = mkdtempSync(join(tmpdir(), "mpp-example-wiring-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

// The payout screen refuses every payment while no sanctions list is held;
// this suite drives the payer, so it holds a fixture list.
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const { verifyMppSeller, mppIndexSnapshot, __testSetRegistryRow, __testReset } = await import("../src/mpp-index.js");
const { __testResetLlmsExamples } = await import("../src/mpp-input-examples.js");
const { tempoCatalog, rankTempoResources } = await import("../src/tempo-sellers.js");
const { tempoCandidateOf, resolvedCandidateOf } = await import("../src/sor-candidates.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const { payTempo, TEMPO_USDC } = await import("../src/tempo-buyer.js");
(await import("../src/x402-buyer.js")).__setBuyerAddressGuardForTest(false); // this suite's sellers are local stubs

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the resolver uses the builders this test drives (source guard) ----
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = src.indexOf("async function resolveExternalSeller(");
  const nextTop = src.slice(start + 1).search(/\n(?:async function|function|const|let|app\.|export) /);
  const fn = src.slice(start, nextTop > 0 ? start + 1 + nextTop : start + 20000);
  ok(/rankTempoResources\(tempoCatalog\(\), task, [^\n]*\)\s*\n\s*\.slice\(0, 5\)[\s\S]{0,400}?\.map\(tempoCandidateOf\);/.test(fn), "the resolver's Tempo branch maps ranked catalog rows through tempoCandidateOf");
  ok(/resolved\.push\(resolvedCandidateOf\(r, \{/.test(fn) && !/resolved\.push\(\{/.test(fn), "the resolver pushes every live candidate through resolvedCandidateOf");
}

// ---- stub MPP seller: answers a tempo/charge challenge, echoes the paid body ----
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const challenge = () => Challenge.serialize(Challenge.from({
  realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
  request: { amount: "1000", currency: TEMPO_USDC, recipient: RECIPIENT, methodDetails: { chainId: 4217, feePayer: true } }, secretKey: "seller-secret",
}));
let received = null;
const seller = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    if (!/^Payment /.test(req.headers.authorization || "")) { res.writeHead(402, { "www-authenticate": challenge() }); return res.end("{}"); }
    received = body ? JSON.parse(body) : null;
    res.writeHead(200, { "content-type": "application/json", "payment-receipt": Buffer.from(JSON.stringify({ method: "tempo", status: "success", reference: "0xfeed", timestamp: new Date().toISOString() })).toString("base64url") });
    res.end(JSON.stringify({ contents: ["page text"] }));
  });
});
await new Promise((r) => seller.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${seller.address().port}`;

// ---- index: a registry row, verified, its llms.txt read ----
const ORIGIN = "https://contents-seller.example";
const LLMS = ["# Contents API", "", "## POST /api/contents", "Fetch page contents for a list of URLs.", "```json", '{"urls":["https://example.com"]}', "```"].join("\n");

async function run({ llms = LLMS, params = { url: "https://example.com" } } = {}) {
  __testReset();
  __testResetLlmsExamples();
  received = null;
  __testSetRegistryRow(ORIGIN, {
    name: "Contents", serviceUrl: ORIGIN, description: "extract page content from URLs",
    endpoints: [{ method: "POST", path: "/api/contents", description: "Extract content from a list of URLs", payment: { intent: "charge", method: "tempo", currency: TEMPO_USDC, decimals: 6, amount: "1000" } }],
  });
  let probed = null;
  const entry = await verifyMppSeller(ORIGIN, {
    probe: async (target) => { probed = target; return { ok: true, status: 402, url: target.url, at: Date.now(), offers: [], error: null }; },
    fetchText: async (url) => { ok(url === `${ORIGIN}/llms.txt`, "the index reads the seller's own llms.txt"); return { html: llms }; },
  });
  ok(entry.verified === true && probed?.url === `${ORIGIN}/api/contents`, "the index verified the registry row by probing its listed endpoint");

  // The resolver's Tempo branch, through the same builders.
  const tier = EXEC_TIERS[0];
  const resolveExternal = async (task, { cap }) => rankTempoResources(tempoCatalog(mppIndexSnapshot()), task, { capUsd: cap })
    .slice(0, 5).map(tempoCandidateOf).map((r) => resolvedCandidateOf(r, {}));
  let paidUrl = null;
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier, resolveExternal,
    // The real MPP payer; only the host moves to the local stub (the index
    // admits https origins only) and the chain proof is answered.
    payExternal: (url, opts) => { paidUrl = url; return payTempo(url.replace(ORIGIN, STUB), { ...opts, createCredential: async (res402) => mintTempoTestCredential(res402), proof: async () => 4000 }); },
    externalEnabled: () => true, externalChains: () => ["tempo"],
  });
  const req = { ip: "192.0.2.10", headers: {}, header: () => undefined, mppTempoCredential: true };
  const r = await tool.handler({ task: "extract content from URLs", include: "external", params }, req);
  ok(paidUrl === `${ORIGIN}/api/contents`, `route-execute paid the indexed seller's endpoint (paid ${paidUrl})`);
  return r;
}

{
  const r = await run();
  ok(same(received, { urls: ["https://example.com"] }), `the seller received the body in its documented shape (got ${JSON.stringify(received)})`);
  ok(same(r.receipt?.paramsAdapted, ["url->urls"]), `the receipt names the rename (got ${JSON.stringify(r.receipt?.paramsAdapted)})`);
  ok(r.receipt?.wire === "mpp", "the receipt says the call settled over MPP");
}
{
  // Control: with no request example in llms.txt the same call is sent as written.
  const r = await run({ llms: "# Contents API\n\nNo examples here.\n" });
  ok(same(received, { url: "https://example.com" }) && !("paramsAdapted" in (r.receipt || {})), "control: with no documented example the body is the buyer's params, unchanged");
}

seller.close();
console.log(`\n${pass} passed`);
process.exit(0);
