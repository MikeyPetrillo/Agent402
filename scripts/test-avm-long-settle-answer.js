#!/usr/bin/env node
// A settled answer arrives whole after a long settle. Production logged a paid
// Algorand call to POST /v1/images/generations as status 200, settle 6.3 s,
// and its response fully written (gone=no: res.writableFinished), while the
// buyer read an empty body. This suite pins the server's side of that: every
// gate buffers the handler's answer until settlement is decided and then
// replays it (the x402 middleware, src/payments.js), so a slow settle on any
// rail must still put every byte of a large answer on the wire, with its
// settlement header, once.
//   a. Algorand, a 6 s settle, a 2.2 MB image answer: 200, the whole body
//      parses and carries the image byte for byte, PAYMENT-RESPONSE names the
//      settlement, settled once;
//   b. the same payment sent again is refused as used (nothing runs or
//      settles twice);
//   c. Base (EVM), the same long settle and answer: the same whole body;
//   d. Algorand again through the CDN proxy (req.viaCdn: its sync window is
//      stamped and the image tier bounds its links by it): the same whole body.
// One PAID-mode server (scripts/lib/paid-wires-rig.js); the image tier's
// cost rows come from the private table (src/upstream-costs.js).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-avm-long-settle-answer");
const { bootPaidWires } = await import("./lib/paid-wires-rig.js");

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter((x) => /paid-timing|settle|error/i.test(x)).slice(-15)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const IMAGES = { method: "POST", path: "/v1/images/generations", body: { prompt: "a red fox in the snow" } };
// About 2.2 MB of base64, the size production served.
const IMAGE = Buffer.alloc(1_650_000, 0x5a).toString("base64");
const SETTLE_MS = 6_000;
const CDN_SECRET = "long-settle-origin-secret-0123456789";
const decode = (h) => { try { return JSON.parse(Buffer.from(String(h), "base64").toString("utf8")); } catch { return null; } };

rig = await bootPaidWires({
  label: "avm-long-settle",
  env: {
    UPSTREAM_COSTS_JSON: process.env.UPSTREAM_COSTS_JSON || "",
    UPSTREAM_COSTS_FILE: process.env.UPSTREAM_COSTS_FILE || "",
    LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
    // The CDN proxy path: a request from a listed edge address carrying the
    // origin secret is read as through the CDN (src/cdn-client-ip.js).
    CDN_PROXY: "on", CDN_ORIGIN_SECRET: CDN_SECRET, CF_IP_RANGES_EXTRA: "127.0.0.1/32",
  },
});
try {
  rig.st.imageB64 = IMAGE;
  rig.st.settleDelayMs = SETTLE_MS;
  for (let [wire, viaCdn] of [["avm", false], ["evm", false], ["avm", true]]) {
    const w = await rig.wallet(wire);
    const headers = { ...(await rig.credentialFor(w, IMAGES)), ...(viaCdn ? { "x-origin-auth": CDN_SECRET, "cf-connecting-ip": "203.0.113.9" } : {}) };
    if (viaCdn) wire = `${wire} through the CDN proxy`;
    const t0 = Date.now();
    const r = await rig.send(IMAGES, headers);
    const took = Date.now() - t0;
    const receipt = decode(r.headers.get("payment-response"));
    await ok(r.status === 200 && took >= SETTLE_MS, `${wire}: the paid image call answers 200 after the ${SETTLE_MS} ms settle (${r.status}, ${took} ms)`);
    await ok(r.text.length > 2_000_000 && r.json?.data?.[0]?.b64_json === IMAGE, `${wire}: the whole answer arrives and parses, the image byte for byte (${r.text.length} bytes)`);
    await ok(receipt?.success === true && typeof receipt.transaction === "string" && receipt.transaction.length > 0, `${wire}: the answer carries its settlement (${receipt?.transaction ? "tx present" : "no receipt"})`);
    await ok(rig.outcomesOf(w).settled === 1, `${wire}: settled once (${JSON.stringify(rig.outcomesOf(w))})`);
    if (wire === "avm" && !viaCdn) {
      // b. The same signed payment again: refused as used, nothing runs again.
      const images0 = rig.st.images;
      const again = await rig.send(IMAGES, headers);
      await ok(again.status === 409 && rig.st.images === images0 && rig.outcomesOf(w).settled === 1, `avm: the same payment sent again is refused as used, nothing runs or settles twice (${again.status})`);
    }
  }
} catch (e) {
  await fail(`unexpected error: ${e?.stack || e}`);
}
await rig.stop();
console.log(`\n${pass} passed, 0 failed`);
