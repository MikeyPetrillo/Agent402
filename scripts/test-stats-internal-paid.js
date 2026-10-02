// A settled USDC/Tempo call paid by OUR OWN wallets (signed heartbeat token on
// a paid request: the daily canary, the Tempo volume runner at ~1,000 buys a
// day) is real on-chain settlement but NOT external demand. Before 2026-08-19
// the heartbeat class was recognised only on the PoW path, so such a call was
// booked as a paid external call: viaUSDC (the homepage "paid calls" counter),
// viaMPPWire (the MPP-adoption signal), the per-chain split and the paid-tool
// ranks. This pins that an internal settled call lands in viaUSDCInternal /
// viaMPPWireInternal only, and that an EXTERNAL settled call still books as
// before. Runs against the module's /tmp ephemeral DB (no /data here).
process.env.STATS_ALLOW_EPHEMERAL = "true";
const { recordServedCall, getStats } = await import("../src/stats.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const snap = () => getStats({ wallet: "0x0", walletName: null, network: "base", toolCount: 1, baseUrl: "http://x", prices: {} }).toolCallsServed;

const before = snap();
recordServedCall("uuid", "usdc", "tempo", "mpp", { internal: true });
const a = snap();
ok(a.viaUSDC === before.viaUSDC, `internal settled call does NOT bump viaUSDC (${before.viaUSDC} -> ${a.viaUSDC})`);
ok(a.viaMPPWire === before.viaMPPWire, "internal settled MPP call does NOT bump viaMPPWire");
ok((a.viaUSDCByNetwork?.tempo ?? 0) === (before.viaUSDCByNetwork?.tempo ?? 0), "internal settled call does NOT bump the per-chain split");
ok(a.viaUSDCInternal === (before.viaUSDCInternal ?? 0) + 1 && a.viaMPPWireInternal === (before.viaMPPWireInternal ?? 0) + 1, `...it lands in viaUSDCInternal/viaMPPWireInternal (${a.viaUSDCInternal}/${a.viaMPPWireInternal})`);
ok(a.total === before.total + 1, "...and still counts as a served call");

recordServedCall("uuid", "usdc", "tempo", "mpp"); // external: no internal flag
const b = snap();
ok(b.viaUSDC === a.viaUSDC + 1 && b.viaMPPWire === a.viaMPPWire + 1 && (b.viaUSDCByNetwork?.tempo ?? 0) === (a.viaUSDCByNetwork?.tempo ?? 0) + 1, "an external settled MPP call still bumps viaUSDC, viaMPPWire and the chain split");
ok(b.viaUSDCInternal === a.viaUSDCInternal, "...and not the internal counter");

recordServedCall("uuid", "pow", null, null, { internal: true });
const c = snap();
ok(c.viaProofOfWork === b.viaProofOfWork + 1 && c.viaUSDCInternal === b.viaUSDCInternal, "the internal flag only reclassifies usdc (a PoW call is unaffected)");

// Our jobs that pay WITHOUT the heartbeat token (the Bazaar keep-alive, seller
// sweeps) are booked internal by payer too, and the keep-alive now signs the
// token. Pinned from source: both halves are one line each.
{
  const { readFileSync: rf } = await import("node:fs");
  const srv = rf(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/internal: method === "usdc" && \(isSyntheticRequest\(req\) \|\| isOwnWallet\(payerFromRequest\(req\)\)\)/.test(srv), "the odometer books an own-wallet payer as internal even without the token");
  const rb = rf(new URL("./refresh-bazaar.js", import.meta.url), "utf8");
  ok((rb.match(/headers: \{ \.\.\.heartbeatHeaders\(\)/g) || []).length === 2, "both keep-alive fetch sites send the heartbeat token");
  const wf = rf(new URL("../.github/workflows/bazaar-keepalive.yml", import.meta.url), "utf8");
  ok(/POW_SECRET: \$\{\{ secrets\.POW_SECRET \}\}/.test(wf), "the keep-alive job holds POW_SECRET to sign it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
