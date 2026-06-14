// Verify the agent402.app listing actually works end to end.
//
//   No-spend checks (always):
//     1. The production bridge serves a real tool result (paywall bypassed by token).
//     2. The marketplace invoke URL returns HTTP 402 with a price quote
//        (proves their platform fronts our service).
//   Paid check (only if BURNER_KEY / AGENT_KEY is set — settles real USDC):
//     3. Pay through their invoke URL with the x402 client and get a real result,
//        proving caller → agent402.app facilitator → our wallet → bridge → tool.
//        Uses the cheapest stateless service; the burner pays our own wallet.

import { createHmac } from "node:crypto";

const API = (process.env.A402APP_BASE || "https://marketplace.agent402.app").replace(/\/$/, "");
const KEY = process.env.A402APP_KEY;
const SITE = (process.env.SITE || "https://agent402.tools").replace(/\/$/, "");
const TOKEN = process.env.MARKETPLACE_TOKEN;
// Per-slug bridge token (matches the server) — the master never goes in a URL.
const slugToken = (slug) => createHmac("sha256", TOKEN).update(String(slug)).digest("hex").slice(0, 32);
const BURNER = process.env.BURNER_KEY || process.env.AGENT_KEY || "";
const AGENT_NAME = "Agent402 Tools";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
if (!KEY || !TOKEN) fail("A402APP_KEY and MARKETPLACE_TOKEN are required");

async function api(path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY } });
  if (!r.ok) fail(`GET ${path} → ${r.status}`);
  return r.json();
}
const arr = (x) => (Array.isArray(x) ? x : x.services || x.agents || x.data || []);

const agents = arr(await api("/api/v1/agents"));
const agent = agents.find((a) => a.name === AGENT_NAME);
if (!agent) fail(`agent "${AGENT_NAME}" not found — run the registration first`);
console.log(`agent ${agent.id} status=${agent.status} published=${agent.is_published}`);

const services = arr(await api(`/api/v1/agents/${agent.id}/services`));
const svc = services.find((s) => s.slug === "extract") || services[0];
if (!svc) fail("no services on the agent");
const invokeUrl = svc.invoke_url?.startsWith("http") ? svc.invoke_url : `https://agent402.app${svc.invoke_url || `/agents/${agent.id}/${svc.slug}/invoke`}`;
console.log(`testing service "${svc.name}" (${svc.slug}) → ${invokeUrl}\n`);

const body = { url: "https://example.com" };

// 1) Production bridge serves a real tool result.
const b = await fetch(`${SITE}/mkt/${slugToken(svc.slug)}/${svc.slug}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const bjson = await b.json().catch(() => ({}));
if (b.status !== 200 || !(bjson.title || bjson.markdown)) fail(`bridge did not serve a result: HTTP ${b.status} ${JSON.stringify(bjson).slice(0, 200)}`);
console.log(`1. production bridge served "${svc.slug}" → 200, title="${(bjson.title || "").slice(0, 50)}" ✓`);

// 1b) ffmpeg works in the production image (media-info through the bridge).
const m = await fetch(`${SITE}/mkt/${slugToken("media-info")}/media-info`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg" }),
});
const mjson = await m.json().catch(() => ({}));
if (m.status === 200 && mjson.durationSec > 1) {
  console.log(`1b. production ffmpeg works (media-info: ${mjson.formatName}, ${mjson.durationSec}s) ✓`);
} else {
  console.log(`1b. production media-info not ready yet: HTTP ${m.status} ${JSON.stringify(mjson).slice(0, 120)} (image may still be rolling out)`);
}

// 2) Marketplace invoke URL quotes a 402.
const q = await fetch(invokeUrl, {
  method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
});
if (q.status !== 402) {
  const t = await q.text();
  fail(`expected 402 from the marketplace invoke URL, got ${q.status}: ${t.slice(0, 200)}`);
}
const quote = await q.json().catch(() => ({}));
const nets = (quote.accepts || []).map((a) => `${a.network} ${a.amount} → ${a.payTo}`).join("; ");
console.log(`2. marketplace invoke quoted 402 ✓  accepts: ${nets || JSON.stringify(quote).slice(0, 150)}`);

// 3) Full paid roundtrip (optional — real USDC).
if (!BURNER) {
  console.log("\n3. paid roundtrip SKIPPED (set BURNER_KEY to settle a real invoke through agent402.app).");
  console.log("\nmarketplace verify: no-spend checks passed");
  process.exit(0);
}
console.log("\n3. paying through the marketplace with the burner wallet …");
const { x402Client } = await import("@x402/core/client");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
const { wrapFetchWithPayment } = await import("@x402/fetch");
const { privateKeyToAccount } = await import("viem/accounts");
const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(BURNER.startsWith("0x") ? BURNER : `0x${BURNER}`) });
const payFetch = wrapFetchWithPayment(fetch, client);
const r = await payFetch(invokeUrl, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const rjson = await r.json().catch(() => ({}));
if (r.status !== 200 || !(rjson.title || rjson.markdown)) fail(`paid invoke failed: HTTP ${r.status} ${JSON.stringify(rjson).slice(0, 200)}`);
console.log(`   paid invoke settled → 200, title="${(rjson.title || "").slice(0, 50)}" ✓`);
console.log("   caller → agent402.app facilitator → our wallet → bridge → tool → result.");
console.log("\nmarketplace verify: FULL paid roundtrip passed");
