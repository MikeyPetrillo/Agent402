// One-shot paid render smoke test (owner-approved). Buys a single /api/render
// from production with real USDC on Base to prove Chromium actually LAUNCHES and
// renders a page under the current image — the end-to-end check the Dockerfile
// changes (R-06 build gate + Phase-1 setuid strip) couldn't confirm without a
// paid call. Marks the buy as internal traffic (X-Heartbeat-Token) so it does
// not pollute the sales ledger / PostHog. Cost: ~$0.02.
//
//   BURNER_KEY=0x… POW_SECRET=… node scripts/smoke-render.js
import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
// Render a content-rich, always-up public page (our own guide) so Readability
// reliably yields markdown — a sparse page (example.com) can 422 on extraction
// and would be a false negative for "did Chromium render".
const RENDER_URL = process.env.RENDER_URL || `${TARGET}/guides/x402-in-5-minutes`;

const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.error("smoke-render: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
console.log(`buyer: ${account.address}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// Same internal-traffic marker the canary uses so this buy is not counted as
// external demand (X-Heartbeat-Token = HMAC(POW_SECRET, UTC-minute)).
const secret = (process.env.POW_SECRET || "").trim();
if (!secret) console.warn("WARN  POW_SECRET not set — this buy records as EXTERNAL demand in the ledger");
const synthFetch = !secret ? fetch : (input, init) => {
  const minute = Math.floor(Date.now() / 60_000);
  const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
  const req = new Request(input, init);
  req.headers.set("X-Heartbeat-Token", token);
  return fetch(req);
};
const payFetch = wrapFetchWithPayment(synthFetch, client);

console.log(`buying one render of ${RENDER_URL} …`);
const res = await payFetch(`${TARGET}/api/render`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ url: RENDER_URL }),
});
const body = await res.json().catch(() => ({}));
console.log(`render status: ${res.status}`);
console.log(`  markdown chars: ${body.markdown ? body.markdown.length : 0} | rendered: ${body.rendered} | untrustedContent: ${body.untrustedContent} | title: ${JSON.stringify(body.title)}`);

const okMarkdown = res.status === 200 && typeof body.markdown === "string" && body.markdown.length > 0;
if (!okMarkdown) {
  console.error("SMOKE FAIL: the paid render did not return markdown — Chromium may not be launching under the current image.");
  console.error(JSON.stringify(body).slice(0, 300));
  process.exit(1);
}
console.log("SMOKE OK: Chromium launched and rendered under the current image, payment settled (~$0.02).");
