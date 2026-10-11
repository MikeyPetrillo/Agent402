// Treasury wallet balances are operator-only. /api/revenue publishes each
// receiving wallet's address (anyone can read its holdings on chain) but no
// balance field and no combined total; /__operator/revenue.json carries the
// full reading for an authed operator and answers 404 to everyone else. The
// handlers are mounted here exactly as server.js mounts them, on port 0.
import { readFileSync } from "node:fs";
import express from "express";
import { revenueApiHandlers, publicRevenueSnapshot, lastGoodSnapshot, revenuePage } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BALANCE_KEYS = ["balance", "staleBalance", "balanceAsOf", "totalUsd", "balanceUsd"];
// Every key anywhere in a JSON value, at any depth.
const keysOf = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

const snap = {
  spec: "agent402-revenue/1", asOf: "2026-10-11T00:00:00.000Z", totalUsd: 1234.567891, windowExternalUsd: 0.01,
  rails: [
    { rail: "Base", asset: "USDC", wallet: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0", explorer: "https://basescan.org/address/0xabf4", balance: 1000.123457, balanceAsOf: "2026-10-11T00:00:00.000Z", externalUsd: 0.01, recent: [] },
    { rail: "Solana", asset: "USDC", wallet: "So1Wallet", balance: 234.444434, staleBalance: true, balanceAsOf: "2026-10-10T23:00:00.000Z", recent: [] },
    { rail: "Stellar", asset: "USDC", wallet: "GWALLET", balance: null, error: "timed out", recent: [] },
  ],
};
const ledger = { allTime: { allTimeInboundCount: 5 }, sales: { count: 1 } };
const AUTH = "test-operator-token";
const app = express();
const api = revenueApiHandlers({ snapshot: async () => snap, ledger: () => ledger, authed: (req) => req.headers.authorization === `Bearer ${AUTH}` });
app.get("/api/revenue", api.publicHandler);
app.get("/__operator/revenue.json", api.operatorHandler);
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;
try {
  const pubRes = await fetch(`${base}/api/revenue`);
  const pubText = await pubRes.text();
  const pub = JSON.parse(pubText);
  const pubKeys = keysOf(pub);
  ok(pubRes.status === 200, "public /api/revenue answers 200");
  ok(BALANCE_KEYS.every((k) => !pubKeys.has(k)), `public /api/revenue carries no balance field (found: ${BALANCE_KEYS.filter((k) => pubKeys.has(k)).join(", ") || "none"})`);
  ok(!pubText.includes("1000.123457") && !pubText.includes("234.444434") && !pubText.includes("1234.567891"), "no balance figure appears anywhere in the public body");
  ok(pub.rails[0].wallet === snap.rails[0].wallet && pub.rails[0].explorer, "wallet addresses and explorer links stay public");
  ok(pub.rails.map((r) => r.status).join() === "live,cached,unreachable", "each rail carries its reachability word instead");
  ok(pub.allTime?.allTimeInboundCount === 5 && pub.sales?.count === 1, "the ledger counts still ride the public body");
  ok(/not published/.test(pub.note) && !/totalUsd/.test(pub.note), "the note says balances are not published");
  ok(/public/.test(pubRes.headers.get("cache-control") || ""), "the public body stays cacheable");

  const anon = await fetch(`${base}/__operator/revenue.json`);
  ok(anon.status === 404, "the operator view answers 404 without the operator credential");
  const wrong = await fetch(`${base}/__operator/revenue.json`, { headers: { authorization: "Bearer nope" } });
  ok(wrong.status === 404, "...and 404 with a wrong one");
  const opRes = await fetch(`${base}/__operator/revenue.json`, { headers: { authorization: `Bearer ${AUTH}` } });
  const op = await opRes.json();
  ok(opRes.status === 200 && op.operatorView === true, "the operator view answers an authed operator");
  ok(op.totalUsd === 1234.567891 && op.rails[0].balance === 1000.123457 && op.rails[1].staleBalance === true, "the operator view still carries balances and the combined total");
  ok(/no-store/.test(opRes.headers.get("cache-control") || ""), "the operator view is never cached");
} finally {
  srv.close();
}

// The cold path (saved reading) goes through the same filter.
{
  const cold = publicRevenueSnapshot(lastGoodSnapshot({ asOf: "2026-10-11T00:00:00.000Z", rails: [{ rail: "Base", balance: 9.5, recent: [] }] }));
  ok(BALANCE_KEYS.every((k) => !keysOf(cold).has(k)) && cold.rails[0].status === "cached", "a saved last-good reading is published without balances, marked cached");
}

// The page renders no balance figure and no balance wording.
{
  const html = revenuePage("https://agent402.tools", { ...snap, allTime: { perChain: {} } });
  ok(!html.includes("1000.12") && !html.includes("234.44") && !html.includes("1234.56"), "/revenue prints no balance figure");
  ok(!/balances? (as of|are live)/i.test(html), "/revenue says the rails were read, not that balances were");
}

// server.js mounts these handlers on these paths, with the real operator check.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.get\("\/api\/revenue", revenueApi\.publicHandler\)/.test(server), "server.js serves /api/revenue through the public handler");
  ok(/app\.get\("\/__operator\/revenue\.json", revenueApi\.operatorHandler\)/.test(server), "server.js serves the operator view through the operator handler");
  const decl = server.slice(server.indexOf("const revenueApi = revenueApiHandlers("), server.indexOf("const revenueApi = revenueApiHandlers(") + 600);
  ok(/authed: \(req\) => operatorAuthed\(req\)/.test(decl), "the operator view is gated by operatorAuthed");
  ok(!/publicRevenueSnapshot|\.balance\b|totalUsd/.test(server.slice(server.indexOf('app.get("/revenue"'), server.indexOf('app.get("/revenue"') + 3000)), "the /revenue route publishes nothing balance-shaped itself");
}

// The announcement cards read /api/revenue and print no balance.
for (const f of ["celo-card.js", "robinhood-card.js"]) {
  const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  ok(!/\.balance\b|merchant balance/.test(src), `${f} prints no wallet balance`);
}
// The transparency page says what is and is not published.
{
  const { transparencyPage } = await import("../src/transparency.js");
  const tp = transparencyPage("https://agent402.tools");
  ok(/not\s+published/.test(tp) && !/publishes them/.test(tp), "/transparency says balances are not published");
}

console.log(`\ntest-revenue-no-balances: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
