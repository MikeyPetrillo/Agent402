// REAL end-to-end proof the IPv4 egress fix killed the charged failures: buy the
// exact wallet-only tools that were 504ing on the IPv6 race — treasury-debt,
// treasury-avg-rates, gov-data — many times through PROD with the real Base burner,
// and assert every paid call returns actual data. Pre-fix these failed ~15% of the
// time (a buyer paying and getting nothing); post-fix it must be 0. Skips w/o a key.
import { assertOwnPaidTarget } from "./lib/buyer-guard.js";
import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Agent402 } from "../client/index.js";

const TARGET = assertOwnPaidTarget(process.env.TARGET_URL || "https://agent402.tools", "test-treasury-paid-live");
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.log("SKIP: no BURNER_KEY / KEY_FILE — real paid test needs a signer"); process.exit(0); }

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// Preserve the X-PAYMENT header when @x402/fetch passes a Request (build via
// new Request, don't rebuild), + mark internal traffic so buys don't pollute the
// external sales ledger.
const secret = (process.env.POW_SECRET || "").trim();
const synthFetch = (input, init) => {
  const req = new Request(input, init);
  if (secret) req.headers.set("X-Heartbeat-Token", createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60000)}`).digest("base64url").slice(0, 32));
  return fetch(req);
};
const payFetch = wrapFetchWithPayment(synthFetch, client);
const a = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch });
console.log(`buyer ${account.address} on ${TARGET}`);

// The tools that were 504ing on the IPv6 race, and how to tell a real result from a fail.
const TOOLS = [
  { slug: "treasury-debt", n: 12, input: {}, ok: (r) => r && (r.totalDebt || r.tot_pub_debt_out_amt || r.latestDate || r.recordDate) },
  { slug: "treasury-avg-rates", n: 10, input: {}, ok: (r) => r && !r.error && typeof r === "object" && Object.keys(r).length > 0 },
  { slug: "gov-data", n: 8, input: { q: "electric vehicle charging stations", rows: 5 }, ok: (r) => r && !r.error && typeof r === "object" },
];

let totalOk = 0, totalFail = 0;
for (const t of TOOLS) {
  let ok = 0, fail = 0; const errs = [];
  for (let i = 0; i < t.n; i++) {
    try {
      const r = await a.call(t.slug, t.input, { cache: false });
      if (t.ok(r)) ok++; else { fail++; errs.push(JSON.stringify(r).slice(0, 50)); }
    } catch (e) { fail++; errs.push((e.message || String(e)).slice(0, 60)); }
  }
  console.log(`${t.slug.padEnd(20)} ${ok}/${t.n} paid calls returned real data${fail ? ` — ${fail} CHARGED FAILURE(S): ${errs.slice(0, 2).join(" | ")}` : "  ✓"}`);
  totalOk += ok; totalFail += fail;
}
const total = TOOLS.reduce((s, t) => s + t.n, 0);
console.log(`\n${totalFail === 0 ? "OK" : "FAILED"}: ${totalOk}/${total} real paid calls delivered data, ${totalFail} charged failures`);
process.exit(totalFail === 0 ? 0 : 1);
