// A database that refuses connections for the first ~2 s of a boot, then
// answers: every store whose first load failed must recover on its own,
// without a deploy. One child process boots the stores through a TCP proxy
// that drops every connection while "down"; after the database is back the
// child exercises each store (credits authorize, Decide redeem and bookRun,
// card checkout fulfil and peek, stats flush and health, status and economy
// write and read, the shared PoW replay pull, the Stripe shadow enqueue, the
// wish board and append, the revenue ledger's first load).
// Requires STATE_DATABASE_URL (CI fails without it).
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-store-boot-blip-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = new URL("..", import.meta.url).pathname;
const target = new URL(url);

// A wish already on the board before the boot: the rebuild must find it.
await sdb.logLines.append("wishes", { need: "seeded wish before the blip", source: "api", ts: Date.now() });

let up = false;
const socks = new Set();
const proxy = net.createServer((c) => {
  if (!up) { c.destroy(); return; }
  const u = net.connect(Number(target.port || 5432), target.hostname);
  socks.add(c); socks.add(u);
  c.pipe(u); u.pipe(c);
  const drop = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
  u.on("error", drop); c.on("error", drop); u.on("close", drop); c.on("close", drop);
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `${target.protocol}//${target.username ? `${target.username}@` : ""}127.0.0.1:${proxy.address().port}${target.pathname}${target.search}`;
setTimeout(() => { up = true; }, 2000);

const d = mkdtempSync(join(tmpdir(), "store-blip-"));
const code = `
  const res = {};
  const t = async (name, f) => { try { res[name] = await f(); } catch (e) { res[name] = "threw: " + String(e?.message || e).slice(0, 100); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const { createHash } = await import("node:crypto");
  const db = await import("./src/state-db.js");
  const st = await import("./src/stats.js");
  const ss = await import("./src/status-store.js");
  const ec = await import("./src/x402-economy.js");
  const pw = await import("./src/pow.js");
  const sh = await import("./src/stripe-shadow-ledger.js");
  const wi = await import("./src/wish.js");
  const rv = await import("./src/revenue-ledger.js");
  const sl = await import("./src/sales-ledger.js");
  const rl = await import("./src/refund-ledger.js");
  const { createCredits } = await import("./src/credits.js");
  const { openDecideLedger } = await import("./src/decide/ledger.js");
  const { createHumanCheckout } = await import("./src/human-checkout.js");
  const H = process.env.H_DIR;
  const sessions = {
    cs_credit: { id: "cs_credit", mode: "payment", payment_status: "paid", payment_intent: "pi_c", customer_details: { email: null }, metadata: { credits_pack: "credits-20" } },
    cs_report: { id: "cs_report", payment_status: "paid", payment_intent: "pi_r", customer_details: { email: null }, metadata: { product: "dossier", input: "AAPL" } },
  };
  const stripe = { checkout: { sessions: { retrieve: async (id) => sessions[id] } }, refunds: { create: async () => ({ id: "re_1" }) } };
  const credits = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: H + "/credits", log: () => {} });
  const decide = openDecideLedger(H + "/decide.db");
  const hc = createHumanCheckout({ stripe, generate: async () => ({ report: "# R\\n\\nText. [1]", title: "T", sources: [], tables: [] }), baseUrl: "https://agent402.tools", storeDir: H + "/checkout", onSale: () => {}, log: () => {} });
  const shadow = sh.createShadowLedger({ env: { ...process.env, STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_SHADOW_INTERVAL_MS: "0" }, dbFile: H + "/shadow.db", log: () => {} });
  shadow.record({ slug: "early", priceUsd: 0.01, rail: "usdc", network: "base", tx: "0x" + "2".repeat(64) }); // during the outage
  // The server's boot wiring: the retrying stores' labels feed the status.
  db.setUnloadedStoresProbe((await import("./src/store-retry.js")).unloadedStores);
  const bootWait = await db.stateStoresReady({ timeoutMs: 500 });
  res.statusDuring = { wait: bootWait, word: db.stateDbStatus(), unloaded: db.unloadedStateStores() };
  await wait(6000); // the database has been back for about 4 s; nothing has called most stores since the boot

  await t("credits", async () => { const m = await credits.claim("cs_credit"); const a = await credits.authorize(m.key, 0.01); return m.status === "minted" && a.ok === true; });
  await t("decide", async () => {
    await decide.ready;
    await decide.saveDecision({ decisionId: "d1", depth: 1, priceUsd: 0.01, payer: "0xp", plan: { steps: [] }, costViaUsd: 0 });
    const c = await decide.mintCredit({ decisionId: "d1", amountUsd: 0.01, ttlMs: 60000, payer: "0xp" });
    await decide.activateCredit(c.hash);
    const got = await decide.redeemCredit(c.token, "d1", "run1");
    const booked = await decide.bookRun({ runId: "run1", decisionId: "d1", payer: "0xp", budgetUsd: 0.01, creditUsd: 0.01 });
    return got > 0 && booked !== false && (await decide.getDecision("d1"))?.id === "d1";
  });
  await t("checkout", async () => { await hc.fulfill("cs_report"); for (let i = 0; i < 100; i++) { const p = await hc.peek("cs_report"); if (p?.status === "done") return true; await wait(20); } return false; });
  await t("stats", async () => { st.recordServedCall("blip-tool", "pow"); const flushed = await st.statsFlush(); const n = Number((await db.stateQuery("SELECT n FROM " + db.stateDbSchema() + ".stats_tool_counts WHERE slug = 'blip-tool'")).rows[0]?.n || 0); return flushed !== false && n === 1 && st.dbHealthy() === true; });
  await t("status", async () => { ss.recordProbe({ ts: Date.now(), source: "x", component: "blip", ok: true }); await ss.statusStoreFlush(); const n = Number((await db.stateQuery("SELECT count(*) n FROM " + db.stateDbSchema() + ".status_probes WHERE component = 'blip'")).rows[0].n); return (await ss.statusStoreReady()) === true && n === 1 && ss.probeRows("blip", 0).length === 1; });
  await t("economy", async () => { const w = await ec.recordDailyHistory([{ day: "2026-01-02", settlements: 7, payers: 2 }]); const n = Number((await db.stateQuery("SELECT settlements FROM " + db.stateDbSchema() + ".economy_daily WHERE day = '2026-01-02'")).rows[0]?.settlements || 0); return (await ec.economyHistoryReady()) === true && w === true && n === 7; });
  await t("pow", async () => {
    if (!(await pw.powReplayReady())) return "not ready";
    const ch = pw.issueChallenge("hash");
    let sol = null;
    for (let n = 0; n < 5000000 && !sol; n++) { const h = createHash("sha256").update(ch.challenge + ":" + n).digest(); let bits = 0; for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } if (bits >= ch.difficulty) sol = ch.token + ":" + n; }
    // Another container accepted it: the row is in the shared table only. The pull timer must bring it here.
    await db.stateQuery("INSERT INTO " + db.stateDbSchema() + ".pow_used (challenge, exp) VALUES ($1, $2)", [ch.challenge, Math.floor(Date.now() / 1000) + 300]);
    await wait(1500);
    return pw.verifySolution(sol, "hash").reason === "challenge already used";
  });
  await t("shadow", async () => { shadow.record({ slug: "late", priceUsd: 0.01, rail: "usdc", network: "base", tx: "0x" + "1".repeat(64) }); await shadow.flush(); const n = Number((await db.stateQuery("SELECT count(*) n FROM " + db.stateDbSchema() + ".stripe_shadow")).rows[0].n); return n === 2 && shadow.report().live !== false; });
  await t("wish", async () => { wi.recordWish({ need: "a wish after the blip", source: "api" }); await wait(300); const n = Number((await db.stateQuery("SELECT count(*) n FROM " + db.stateDbSchema() + ".log_lines WHERE stream = 'wishes'")).rows[0].n); return n === 2 && wi.getWishesAggregate().totalWishes === 2; });
  await t("revenue", async () => !(await rv.ledgerStoreReady()).error);
  res.statusAfter = { word: db.stateDbStatus(), unloaded: db.unloadedStateStores() };
  console.log("RESULT " + JSON.stringify(res));
  process.exit(0);
`;
const env = {
  ...process.env, STATE_DATABASE_URL: proxyUrl, STATE_DB_SCHEMA: schema, NODE_ENV: "test", FREE_MODE: "true", H_DIR: d,
  STATE_STORE_RETRY_MS: "300", STATE_STORE_RETRY_MAX_MS: "1000", POW_PG_REFRESH_MS: "500", POW_SECRET: "blip-secret", POW_DIFFICULTY: "8", POW_ALLOW_EPHEMERAL: "true",
  STATS_DB_DIR: d, POW_DB_PATH: join(d, "pow.db"), STATUS_DB_PATH: join(d, "status.db"), X402_ECONOMY_DB: join(d, "econ.db"), WISH_FILE: join(d, "wishes.jsonl"),
  REVENUE_LEDGER_DB: join(d, "rev.db"), SALES_LEDGER_DB: join(d, "sales.db"), REFUND_DB_DIR: d, STATE_DB_POOL_MAX: "6",
};
const out = await new Promise((res) => {
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env });
  let o = "", e = "";
  c.stdout.on("data", (x) => (o += x)); c.stderr.on("data", (x) => (e += x));
  const kill = setTimeout(() => c.kill("SIGKILL"), 60_000);
  c.on("exit", () => { clearTimeout(kill); res({ o, e }); });
});
const m = out.o.match(/RESULT (.*)/);
if (!m) console.error(out.e.slice(-2000));
const r = m ? JSON.parse(m[1]) : {};
for (const k of ["credits", "decide", "checkout", "stats", "status", "economy", "pow", "shadow", "wish", "revenue"]) {
  ok(r[k] === true, `${k}: works once the database answers after a failed first load (${JSON.stringify(r[k])})`);
}
// While a first load is still failing the status says so and names the store;
// once every store has landed it reads on and names none.
const during = r.statusDuring || {};
ok(during.wait === "timeout" && during.word === "degraded" && ["stats tally", "status history", "economy history", "sales ledger", "refund ledger"].every((l) => (during.unloaded || []).includes(l)), `status during the outage: degraded, the retrying stores named (${JSON.stringify(during).slice(0, 300)})`);
ok(new Set(during.unloaded || []).size === (during.unloaded || []).length, "a store is named once");
ok(r.statusAfter?.word === "on" && (r.statusAfter?.unloaded || []).length === 0, `status after recovery: on, nothing unloaded (${JSON.stringify(r.statusAfter)})`);
// The server sets the same probe before its boot wait.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "src/server.js"), "utf8");
  const at = src.indexOf("setUnloadedStoresProbe(unloadedStores)"), wait = src.indexOf("await stateStoresReady(");
  ok(at > 0 && wait > at, "src/server.js sets the retrying stores' probe before its boot wait");
}
proxy.close(); for (const s of socks) s.destroy();
await sdb.__dropStateSchema().catch(() => {});
await sdb.closeStateDb();
rmSync(d, { recursive: true, force: true });
console.log(`\ntest-store-boot-blip-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
