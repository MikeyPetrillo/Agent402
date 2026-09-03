// /proof + /api/proof: the metered tier's settled-vs-quote receipts.
// Offline: a scratch ledger, then the feed and the page.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SALES_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "a402-proof-")), "sales.db");
const { recordSale, proofFeed } = await import("../src/sales-ledger.js");
const { proofPage, txLink } = await import("../src/proof.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

let f = proofFeed();
ok(f.external.count === 0 && f.external.latest === null && f.internal.latest === null, "empty ledger: zero counts, no rows");
let html = proofPage("https://agent402.tools", f);
ok(/No settlement recorded yet/.test(html) && /Receipts/.test(html), "page renders the empty state");

// A flat-route sale carries no quote and never appears on the metered feed.
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: "0x" + "1".repeat(40), tx: "0x" + "a".repeat(64), synthetic: false, wire: "x402" });
// Internal canary metered settle (upto): quote 0.0012, settled 0.001.
recordSale({ slug: "v1-chat-metered", priceUsd: 0.001, rail: "usdc", network: "base", payer: "0x" + "2".repeat(40), tx: "0x" + "b".repeat(64), synthetic: true, wire: "x402", quoteUsd: 0.0012 });
// External metered settle: quote 0.0031, settled 0.0025.
recordSale({ slug: "v1-chat-metered", priceUsd: 0.0025, rail: "usdc", network: "base", payer: "0x" + "3".repeat(40), tx: "0x" + "c".repeat(64), synthetic: false, wire: "x402", quoteUsd: 0.0031 });
f = proofFeed();
ok(f.external.count === 1 && f.external.latest.settledUsd === 0.0025 && f.external.latest.quoteUsd === 0.0031 && f.external.latest.underQuote === true, "external metered row: settled + quote + underQuote");
ok(f.internal.count === 1 && f.internal.latest.tx === "0x" + "b".repeat(64), "internal (canary) row kept separate and labelled by side");
ok(!JSON.stringify(f).includes("0x" + "3".repeat(40)) && !JSON.stringify(f).includes("payer"), "the feed carries no payer");
ok(/T\d\d:00:00\.000Z$/.test(f.external.latest.at) && f.external.latest.atPrecision === "hour", "the external row's timestamp is truncated to the hour");
ok(f.internal.latest.atPrecision === "second", "our own canary row keeps the exact time");
ok(!JSON.stringify(f).includes("\"hash\""), "flat-route sales never enter the metered feed");
recordSale({ slug: "v1-chat-metered", priceUsd: 0.004, rail: "usdc", network: "base", payer: "0x" + "4".repeat(40), tx: "0x" + "d".repeat(64), synthetic: false, wire: "x402", quoteUsd: 0.004 });
f = proofFeed();
ok(f.external.count === 2 && f.external.latest.tx === "0x" + "d".repeat(64) && f.external.quotedUsd === 0.0071, "aggregates sum settled and quoted; latest is the newest row only");
ok(f.external.buyers7d === 2 && f.external.settlements7d === 2 && !("buyers7d" in f.internal), "7-day external buyer + settlement COUNTS ride the feed (never a roster); the internal side carries none");
html = proofPage("https://agent402.tools", f);
ok(html.includes("basescan.org/tx/0x" + "d".repeat(64)) && /LATEST EXTERNAL/.test(html) && /our own daily canary/i.test(html), "page links the settle tx and labels the internal row as ours");
ok(/:00 UTC \(to the hour\)/.test(html), "page shows the external time to the hour and says so");
ok(!html.includes("0x" + "4".repeat(40)), "page shows no payer");
ok(txLink("solana", "sig") === "https://solscan.io/tx/sig" && txLink("unknown", "x") === null && txLink("base", null) === null, "txLink maps known networks and refuses unknown ones");
console.log(`\n${pass} passed`);
