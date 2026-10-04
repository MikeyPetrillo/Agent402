// /api/revenue publishes counts and totals, never who paid us. Each per-
// transfer row named its payer (`from`), and even without that field a tx hash
// resolves to its payer on chain, so the rows stay server-side and the one
// per-rail settle that leaves is our OWN (canary or volume run).
import { readFileSync } from "node:fs";
const { publicRevenueSnapshot, newestOwnSettle } = await import("../src/revenue-live.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const OUTSIDE = "0x1111111111111111111111111111111111111111";
const OUTSIDE_TX = "https://basescan.org/tx/0x" + "e".repeat(64);
const OWN_TX = "https://basescan.org/tx/0x" + "c".repeat(64);
const snap = {
  asOf: "2026-10-02T00:00:00.000Z",
  rails: [
    {
      rail: "Base", wallet: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", balance: 12.5, externalUsd: 0.002,
      recent: [
        { usd: 0.002, from: OUTSIDE, tx: OUTSIDE_TX, when: "2026-10-01T10:00:00Z", external: true, internal: false },
        { usd: 0.001, from: "0x902dcf34", tx: OWN_TX, when: "2026-10-01T09:00:00Z", external: false, internal: true },
      ],
      lastInbound: { when: "2026-10-01T09:00:00Z", tx: OWN_TX, usd: 0.001, internal: true },
    },
    // A carried-forward lastInbound from before the own-settle rule (no marker).
    { rail: "Solana", balance: 1, recent: [{ usd: 0.5, from: "So1Outside", tx: "https://solscan.io/tx/OUTSIDESIG", external: true }], lastInbound: { when: "2026-10-01T08:00:00Z", tx: "https://solscan.io/tx/OUTSIDESIG" } },
  ],
};
const pub = publicRevenueSnapshot(snap);
const blob = JSON.stringify(pub);
ok(!blob.includes(OUTSIDE) && !blob.includes(OUTSIDE.toLowerCase()), "no outside payer address leaves");
ok(!blob.includes(OUTSIDE_TX) && !blob.includes("OUTSIDESIG"), "no outside buyer's tx hash leaves (a hash resolves to its payer)");
ok(pub.rails.every((r) => !("recent" in r)), "per-transfer rows are not published");
ok(!/"from"/.test(blob), "no `from` field anywhere in the body");
ok(pub.rails[0].lastInbound?.tx === OWN_TX, "our own canary settle stays as the rail's proof row");
ok(!("lastInbound" in pub.rails[1]), "an unmarked (pre-rule) lastInbound is dropped, not trusted");
ok(pub.rails[0].balance === 12.5 && pub.rails[0].externalUsd === 0.002, "balances and totals stay");
ok(snap.rails[0].recent.length === 2 && snap.rails[1].lastInbound, "the cached snapshot is not mutated");

ok(newestOwnSettle(snap.rails[0].recent)?.tx === OWN_TX, "newestOwnSettle skips an outside transfer for our own");
ok(newestOwnSettle([{ when: "x", tx: "t", external: true }]) === null, "newestOwnSettle returns null with no own settle");

// The handler publishes through the filter, and the snapshot keeps lastInbound own-only.
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const at = server.indexOf('app.get("/api/revenue", ');
const handler = server.slice(at, at + 900);
ok(at > 0 && /publicRevenueSnapshot\(snap\)/.test(handler), "/api/revenue serializes through publicRevenueSnapshot");
const live = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
ok(/const seen = newestOwnSettle\(r\.recent\);/.test(live), "the snapshot's lastInbound is chosen from our own settles only");

// The /revenue page: the proof column links our own settle only, card MPP
// settlements read as USD (not a stablecoin), and the SOR lane names no
// retired kit.
{
  const { revenuePage } = await import("../src/revenue-live.js");
  const html = revenuePage("https://agent402.tools", {
    asOf: "2026-10-02T00:00:00.000Z",
    rails: [{ rail: "Base", asset: "USDC", balance: 1, recent: snap.rails[0].recent, lastInbound: snap.rails[0].lastInbound }],
    allTime: { perChain: {} },
    mpp: { count: 3, rails: { stripe: { count: 3, external: 3, externalUsd: 2, lastAt: null, txs: [] } } },
  });
  // Owner's call 2026-10-04: the rails table links the newest settlement on the
  // rail whoever paid. Here the outside buyer's is newest; their address is
  // still never printed on the page.
  ok(/\$0\.002(<\/a>)? <span[^>]*>2026-10-01</.test(html) && !html.includes(OUTSIDE_TX) && !html.includes(OUTSIDE), "/revenue shows the newest settlement (an outside buyer's here) with no tx hash and no payer address");
  const ownNewest = revenuePage("https://agent402.tools", {
    asOf: "2026-10-02T00:00:00.000Z",
    rails: [{ rail: "Base", asset: "USDC", balance: 1, recent: snap.rails[0].recent.map((t) => (t.internal ? { ...t, when: "2026-10-01T11:00:00Z" } : t)), lastInbound: snap.rails[0].lastInbound }],
    allTime: { perChain: {} },
  });
  ok(/\$0\.001(<\/a>)? <span[^>]*>2026-10-01 · ours</.test(ownNewest) && !ownNewest.includes(OWN_TX), "when our own run is newest it is the row, marked ours, with no tx hash");
  const linked = revenuePage("https://agent402.tools", { asOf: "2026-10-02T00:00:00.000Z", rails: [{ rail: "Base", asset: "USDC", balance: 1, explorer: "https://basescan.org/address/0xabf4", recent: snap.rails[0].recent, lastInbound: snap.rails[0].lastInbound }], allTime: { perChain: {} } });
  ok(linked.includes('<a href="https://basescan.org/address/0xabf4" rel="noopener">$0.002</a>'), "the latest settle links to our wallet's explorer page");
  const mppSeg = html.slice(html.indexOf("MPP wire"), html.indexOf("MPP wire") + 4000);
  ok(/Card<\/strong> <span[^>]*>USD</.test(mppSeg) && !/stripe<\/strong> <span[^>]*>USDC/i.test(mppSeg), "card settlements over MPP are labelled USD, not USDC");
  ok(!/Blockscout kit/.test(html), "the SOR lane names no retired kit");
  const withCard = revenuePage("https://agent402.tools", {
    asOf: "2026-10-02T00:00:00.000Z", rails: [{ rail: "Base", asset: "USDC", balance: 1, recent: [] }],
    allTime: { perChain: {}, allTimeInboundCount: 10, allTimeExternalCount: 4, allTimeExternalUsd: 0.5 },
    card: { allTimeCount: 2, allTimeUsd: 7 },
  });
  ok(/2<\/strong> card purchases \(\$7\.00\)/.test(withCard), "the hero's card purchase total carries its dollar sign");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
