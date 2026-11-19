#!/usr/bin/env node
// Charts on /scorecard, /proof and /leaderboard (src/svg-charts.js):
//   - each draws from the data its page already publishes, and nothing is
//     drawn without data (an empty chart is left out, not a blank frame);
//   - the scorecard chart counts wallets only (no dollar figure), withheld
//     months draw no bar, and columns run oldest first;
//   - the proof chart shows settled as a share of its own ceiling (percent
//     only), never above 100%;
//   - the leaderboard chart is the table's top ten by USDC settled, our own
//     wallet left out, as the table does;
//   - marks are SVG hidden from assistive technology inside a labeled figure,
//     and no script or third-party resource is involved.
// Run with --print to write the fixture pages to stdout (for a visual check).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { columnChart, barChart, CHART_CSS } from "../src/svg-charts.js";
import { scorecardBody, scorecardChartHtml, scorecardPage } from "../src/scorecard.js";
import { proofChartHtml, proofPage } from "../src/proof.js";
import { leaderboardChartHtml, ledgerLeaderboardPage } from "../src/ledger-leaderboard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

export const FIXTURES = {
  scorecard: scorecardBody({
    now: Date.parse("2026-11-18T12:00:00Z"),
    months: [
      { month: "2026-05", wallets: 2, returningWallets: 0, multiDayWallets: 0, calls: 4, usd: 0.02, networks: [] },
      { month: "2026-06", wallets: 9, returningWallets: 0, multiDayWallets: 3, calls: 140, usd: 1.2, networks: [{ network: "Base", wallets: 9, calls: 140, usd: 1.2 }] },
      { month: "2026-07", wallets: 17, returningWallets: 5, multiDayWallets: 6, calls: 410, usd: 3.9, networks: [{ network: "Base", wallets: 17, calls: 410, usd: 3.9 }] },
      { month: "2026-08", wallets: 26, returningWallets: 9, multiDayWallets: 11, calls: 880, usd: 7.4, networks: [{ network: "Base", wallets: 26, calls: 880, usd: 7.4 }] },
      { month: "2026-09", wallets: 31, returningWallets: 14, multiDayWallets: 12, calls: 1210, usd: 9.8, networks: [{ network: "Base", wallets: 31, calls: 1210, usd: 9.8 }] },
      { month: "2026-10", wallets: 44, returningWallets: 19, multiDayWallets: 20, calls: 2050, usd: 15.1, networks: [{ network: "Base", wallets: 44, calls: 2050, usd: 15.1 }] },
      { month: "2026-11", wallets: 38, returningWallets: 21, multiDayWallets: 15, calls: 1630, usd: 12.6, networks: [{ network: "Base", wallets: 38, calls: 1630, usd: 12.6 }] },
    ],
  }, { asOf: "2026-11-18T12:00:00.000Z", publishTx: false }),
  proof: {
    external: { count: 41, settledUsd: 0.2611, quotedUsd: 0.7302, latest: { quoteUsd: 0.0214, settledUsd: 0.0061, network: "base", wire: "x402", tx: null, txWithheld: true, at: "2026-11-18T09:00:00.000Z", atPrecision: "hour" } },
    internal: { count: 30, settledUsd: 0.1203, quotedUsd: 0.3311, latest: { quoteUsd: 0.0119, settledUsd: 0.0041, network: "base", wire: "x402", tx: "0x" + "ab".repeat(32), at: "2026-11-18T06:00:00.000Z" } },
  },
  leaderboard: {
    windowLabel: "24h", scannedSellers: 120, walletsQueried: 120, scannedBlocks: 43000, bazaarTotal: 900,
    leaderboard: Array.from({ length: 14 }, (_, i) => ({ name: i === 3 ? null : `Example seller ${String.fromCharCode(65 + i)}`, wallet: `0x${String(i + 1).padStart(40, "0")}`, wallets: [`0x${String(i + 1).padStart(40, "0")}`], totalUsd: Math.round(4000 / (i + 1)) / 10, callsSettled: 9000 - i * 500, uniqueBuyers: 300 - i * 15, homepage: `https://seller-${i}.example` })),
  },
};

{
  ok(columnChart({ label: "x", columns: [] }) === "" && columnChart({ label: "x", columns: [{ label: "a", parts: [] }] }) === "" && barChart({ label: "x", rows: [] }) === "", "no data draws no chart");
  const c = columnChart({ label: "Wallets", columns: [{ label: "Jan", parts: [{ value: 3, tone: "a" }, { value: 1, tone: "b" }] }, { label: "Feb", parts: [{ value: 8, tone: "a" }] }] });
  ok(/<figure class="sc-chart" role="img" aria-label="Wallets">/.test(c) && /aria-hidden="true"/.test(c) && !/<script/i.test(c), "a labeled figure; marks hidden from assistive technology; no script");
  ok(/<rect class="sc-a" x="0" y="0" width="10" height="100"\/>/.test(c) && /<rect class="sc-a" x="0" y="62.5" width="10" height="37.5"\/>/.test(c), "columns scale to the tallest stack, stacked bottom first");
  const b = barChart({ label: "x", rows: [{ label: "a", value: 30, of: 100, valueText: "30%" }, { label: "b", value: 150, of: 100, valueText: "150%" }] });
  ok(/class="sb-fill" x="0" y="0" width="30"/.test(b) && /class="sb-fill" x="0" y="0" width="100"/.test(b), "a bar against its own track, clamped to the track");
  ok(/--i:5/.test(columnChart({ label: "x", columns: Array.from({ length: 8 }, (_, i) => ({ label: String(i), parts: [{ value: i + 1 }] })) })) && !/--i:[6-9]/.test(columnChart({ label: "x", columns: Array.from({ length: 8 }, (_, i) => ({ label: String(i), parts: [{ value: i + 1 }] })) })), "the stagger step stops at the sixth member");
  ok(/var\(--dur-slow\)/.test(CHART_CSS) && /var\(--stagger\)/.test(CHART_CSS) && !/#[0-9a-f]{3,6}\b/i.test(CHART_CSS), "chart styles are on the design tokens");
}
{
  const s = scorecardChartHtml(FIXTURES.scorecard.months);
  const labels = [...s.matchAll(/class="sc-lab">([^<]+)</g)].map((m) => m[1]);
  ok(labels.join(",") === "May,Jun,Jul,Aug,Sep,Oct,Nov", `columns run oldest first (${labels.join(",")})`);
  ok(!/\$/.test(s), "the scorecard chart carries no dollar figure");
  const may = s.split('class="sc-col"')[1];
  ok(/sc-val">&lt;3</.test(may) && !/<rect/.test(may), "a withheld month shows <3 and draws no bar");
  const page = scorecardPage("https://agent402.tools", FIXTURES.scorecard);
  ok(page.indexOf('class="sc-chart"') > 0 && page.indexOf('class="sc-chart"') < page.indexOf("<table"), "the scorecard page draws the chart above its table");
}
{
  const p = proofChartHtml(FIXTURES.proof);
  const vals = [...p.matchAll(/class="sb-val">([^<]+)</g)].map((m) => m[1]);
  ok(vals.length === 4 && vals.every((v) => /^\d+%$/.test(v)), `proof bars are percentages only (${vals.join(", ")})`);
  ok(!/\$/.test(p), "the proof chart prints no dollar figure");
  ok(proofChartHtml({ external: { count: 0, latest: null }, internal: { count: 0, latest: null } }) === "", "no settlements, no proof chart");
  ok(/class="sc-chart"/.test(proofPage("https://agent402.tools", FIXTURES.proof)), "the proof page draws the chart");
}
{
  const l = leaderboardChartHtml(FIXTURES.leaderboard, `0x${String(1).padStart(40, "0")}`);
  const names = [...l.matchAll(/class="sb-lab">(?:<a [^>]+>)?([^<]+)</g)].map((m) => m[1]);
  ok(names.length === 10 && names[0] === "Example seller B", `the top ten by USDC settled, our own wallet left out (${names.length}, first ${names[0]})`);
  ok(names.includes("0x0000…0004"), "a row with no name reads its short wallet");
  ok(/rel="noopener"/.test(l), "a seller's homepage link opens with noopener");
  const page = ledgerLeaderboardPage("https://agent402.tools", FIXTURES.leaderboard, { walletAddress: "", stats: {} });
  ok(page.indexOf('class="sc-chart"') > 0 && page.indexOf('class="sc-chart"') < page.indexOf('class="lb-scroll"'), "the leaderboard page draws the chart above its table");
  ok(!/class="sc-chart"/.test(ledgerLeaderboardPage("https://agent402.tools", { leaderboard: [] }, { stats: {} })), "an empty board draws no chart");
}

console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
