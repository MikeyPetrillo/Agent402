// The rail canary's ROUTE gate, against a real booted server.
//
// scripts/test-mpp-subscriptions.js proves the engine's half of this offline.
// The other half lives in server.js: the canary product is mintable only for a
// caller carrying a POW_SECRET-signed heartbeat token, and that decision is
// made from the REQUEST, which an engine-level test cannot see. This is the
// class the free-tier egress probe exists for in its own domain: a hand-set
// flag on an internal function is only as safe as the route that sets it.
//
// Boots its own server, so it needs no live prod and spends nothing.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const PORT = 3079;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mpp-canary-secret";
const POW = "test-pow-canary-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); if (proc) proc.kill(); process.exit(1); } };

const hb = () => createHmac("sha256", POW).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);

let proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "true",
    MPP_SECRET_KEY: SECRET, POW_SECRET: POW,
    TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    TEMPO_CURRENCY: "usdc", TEMPO_DECIMALS: "6",
    // The rail is gated on a gas sponsor (see subscriptionFeePayer): without one
    // the unsponsored mppx path signs a zero gas price and the chain refuses it,
    // so the engine deliberately does not mount. A throwaway key here - this
    // test never broadcasts.
    TEMPO_SUBSCRIPTION_FEE_PAYER_KEY: "0x" + "22".repeat(32),
    MONITOR_SCHEDULER: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    STRIPE_SECRET_KEY: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
  },
  stdio: "ignore",
});

try {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "server booted");

  // The engine must actually be mounted, or every assertion below passes
  // vacuously against a server that has no subscriptions at all.
  const off = await (await fetch(`${B}/api/mpp/monitors`)).json();
  ok(Array.isArray(off.products) && off.products.length > 0, `the subscription engine is mounted and offers ${off.products?.length} product(s) - without this the gate assertions below would pass vacuously`);

  ok(!off.products.some((p) => p.product === "rail-canary"),
    "the canary product is NOT on the public offer: it is gated, and a public listing would be the leak");

  const subscribe = (headers, product = "rail-canary") => fetch(`${B}/api/mpp/monitors/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ product, target: "canary-gate-test" }),
  });

  const noTok = await subscribe({});
  ok(noTok.status === 400, `an UNGATED caller asking for the canary product gets 400, never a 402 challenge (got ${noTok.status})`);
  const noTokBody = await noTok.json().catch(() => ({}));
  ok(/unknown monitor product/i.test(noTokBody.error || ""),
    "and the refusal is the generic unknown-product message: the gate does not confirm the product exists");

  const forged = await subscribe({ "X-Heartbeat-Token": "not-a-real-token" });
  ok(forged.status === 400, `a FORGED heartbeat token is refused exactly like no token at all (got ${forged.status})`);

  // The token is HMAC'd over the UTC minute, so a token minted for a different
  // secret must not open the gate either.
  const wrongSecret = createHmac("sha256", "some-other-secret").update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);
  const wrong = await subscribe({ "X-Heartbeat-Token": wrongSecret });
  ok(wrong.status === 400, `a well-formed token signed with the WRONG secret is refused (got ${wrong.status})`);

  const good = await subscribe({ "X-Heartbeat-Token": hb() });
  ok(good.status === 402, `a VALID heartbeat token mints the canary challenge (got ${good.status})`);
  const wa = good.headers.get("www-authenticate") || "";
  ok(/^Payment\s/i.test(wa) && /tempo/i.test(wa), "the 402 carries a tempo Payment challenge in WWW-Authenticate");

  // A real product must behave identically with and without the token: the gate
  // decides reachability of the canary product only, and nothing else.
  const realPlain = await subscribe({}, "domain-monitor");
  const realTok = await subscribe({ "X-Heartbeat-Token": hb() }, "domain-monitor");
  ok(realPlain.status === realTok.status,
    `a REAL product answers identically with and without the token (${realPlain.status} vs ${realTok.status}): the gate changes nothing for real buyers`);

  console.log(`\n${pass} passed, 0 failed`);
} finally {
  if (proc) proc.kill();
}
