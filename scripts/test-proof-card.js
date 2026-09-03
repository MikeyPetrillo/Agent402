// proof-card: the weekly receipt card renders the right row with the right
// label, and a preview can never claim real output. Offline (SVG only).
import { cardSvg, pickRow } from "./proof-card.js";
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const row = (o) => ({ at: "2026-08-27T20:09:18.331Z", settledUsd: 0.001, quoteUsd: 0.001125, underQuote: true, network: "base", wire: "x402", rail: "usdc", tx: "0x" + "6c11e7f3".repeat(8), ...o });
const internalOnly = { external: { count: 0, settledUsd: 0, quotedUsd: null, latest: null }, internal: { count: 11, latest: row({}) } };
const withExternal = { external: { count: 2, settledUsd: 0.0065, quotedUsd: 0.0071, latest: row({ settledUsd: 0.0025, quoteUsd: 0.0031, tx: "0x" + "d".repeat(64), at: "2026-08-28T01:00:00.000Z" }) }, internal: internalOnly.internal };
ok(pickRow(internalOnly).side === "internal" && pickRow(withExternal).side === "external" && pickRow({}) === null, "external row wins when present; internal otherwise; nothing -> null");
const a = cardSvg(internalOnly, { fonts: false });
ok(/our own daily canary \(internal, labelled\)/.test(a) && /no outside buyer on this route yet/.test(a), "an internal-only feed is labelled as ours on the card and in the aggregate line");
ok(/\$0\.001125/.test(a) && /\$0\.001</.test(a) && /\(89% of the ceiling\)/.test(a), "quote, settled and the percentage are rendered");
ok(/real output · settled on base/.test(a) && !/preview data/.test(a), "a live render claims real output");
const b = cardSvg(withExternal, { fonts: false, preview: true });
ok(/an outside buyer/.test(b) && /\$0\.0031/.test(b) && /\$0\.0025/.test(b) && /2 external settlements · \$0\.0065 settled against \$0\.0071 quoted/.test(b), "an external row renders the buyer label and the external aggregate");
ok(/preview data - final card renders from live/.test(b) && !/real output/.test(b), "preview tag replaces the real-output claim");
ok(b.includes("0xdddddddddd…dddddddd") && !b.includes("0x" + "d".repeat(64)), "tx is shortened, never printed in full");
ok(!/[—]/.test(a + b), "no em dashes");
let threw = false; try { cardSvg({ external: {}, internal: {} }, { fonts: false }); } catch { threw = true; }
ok(threw, "an empty feed refuses to render (a card with no receipt is not a receipt)");
console.log(`\n${pass} passed`);
