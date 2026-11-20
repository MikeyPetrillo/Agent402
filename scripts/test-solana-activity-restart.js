// A restart resumes the Solana activity chart from the store, through the
// server's own page path (getActivityForChain in src/server.js): the first
// boot reads a wallet's window through the public lane, the drain writes its
// state, and the second boot serves the same chart with no transaction read
// and no activity-cold read, even with every history lane down.
//
// Two FREE_MODE boots (port 0, read back) share one store directory; stub Solana lanes
// count every call (scripts/lib/solana-rpc-stub.mjs). No network.
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { existsSync, readFileSync } from "node:fs";
import { ownStoreEnv } from "./lib/own-stores.js";
import { bootServer } from "./lib/boot-server.js";
import { makeWorld, startLane, addr } from "./lib/solana-rpc-stub.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guard = setTimeout(() => { console.error("FAIL - the suite did not finish in time"); process.exit(1); }, 240_000);

const world = makeWorld();
const pub = await startLane(world, "public");
const keyed = await startLane(world, "keyed");
const head = await startLane(world, "head");
const WALLET = addr(11);
const PAYMENTS = 23;
world.addPayments(WALLET, PAYMENTS, { ageSec: 600, gapSec: 7200 });

const TOKEN = "activity-restart-operator-token-0123456789";
const stores = ownStoreEnv("activity-restart"); // one directory for both boots: the second reads what the first wrote
const servers = new Set();
async function boot() {
  // stores: false, with this suite's own directory: the second boot must read what the first wrote.
  const srv = await bootServer({ stores: false, env: {
    ...stores, FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
    AGENT402_OPERATOR_TOKEN: TOKEN, SOR_EVM_CHAINS: "", ALCHEMY_API_KEY: "",
    SOLANA_WALLET_ADDRESS: WALLET, OUR_SOLANA_WALLETS: "",
    // The head lane answers the account and signature reads; the public and keyed lanes the history reads.
    SOLANA_RPCS: head.url, SOLANA_RPC_URL: keyed.url, SOLANA_HISTORY_PUBLIC_RPCS: pub.url,
    SOLANA_HISTORY_PUBLIC_RPS: "1000", SOLANA_ACTIVITY_COLD_FAST_READS: "0", REVENUE_WARMUP: "off",
  } });
  servers.add(srv);
  // The drain writes the waiting scan states; give it its time before the helper's hard stop.
  const stop = async () => {
    const exited = new Promise((r) => srv.child.once("exit", r));
    srv.child.kill("SIGTERM");
    await Promise.race([exited, sleep(60_000)]);
    await srv.stop();
    servers.delete(srv);
  };
  return { base: srv.url, up: true, stop, log: srv.log };
}
const op = async (base) => (await (await fetch(`${base}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } })).json());
const panel = async (base) => (await (await fetch(`${base}/api/market/solana/panel`)).json()).html || "";
// The TRANSACTIONS card's figure.
const txCard = (html) => { const m = /TRANSACTIONS<\/div>\s*<div[^>]*>([\d,]+)</.exec(html); return m ? Number(m[1].replace(/,/g, "")) : null; };

try {
  // ---- the first boot: a cold wallet, read through the public lane ----------
  const a = await boot();
  ok(a.up, "the first server booted");
  let html = "", st = null;
  for (let i = 0; i < 80; i++) { html = await panel(a.base); if (txCard(html) === PAYMENTS) break; await sleep(250); }
  st = await op(a.base);
  const cold = st.solanaHistory?.callers?.["activity-cold"];
  ok(txCard(html) === PAYMENTS, `the first boot's panel shows the wallet's ${PAYMENTS} payments (${txCard(html)})`);
  ok(cold?.public === PAYMENTS && cold?.keyed === 0, `read cold through the public lane (${JSON.stringify({ public: cold?.public, keyed: cold?.keyed })})`);
  ok(st.solanaHistory?.activityStore?.misses === 1 && st.solanaHistory.activityStore.waiting === 1, `the store had no row for it and one state waits to be written (${JSON.stringify(st.solanaHistory?.activityStore)})`);
  ok(!existsSync(stores.SOLANA_ACTIVITY_FILE), "control: nothing was written on the page's path");
  const coldReads = pub.calls.getTransaction + keyed.calls.getTransaction;
  await a.stop();
  ok(existsSync(stores.SOLANA_ACTIVITY_FILE) && Object.keys(JSON.parse(readFileSync(stores.SOLANA_ACTIVITY_FILE, "utf8")).wallets).join() === WALLET, "the drain wrote the wallet's scan state");

  // ---- the second boot: every history lane is down --------------------------
  pub.mode = "error"; keyed.mode = "error";
  for (const l of [pub, keyed, head]) l.reset();
  const b = await boot();
  ok(b.up, "the second server booted on the same store");
  const html2 = await panel(b.base);
  ok(txCard(html2) === PAYMENTS, `the first view after the restart shows the same ${PAYMENTS} payments at once (${txCard(html2)})`);
  const st2 = await op(b.base);
  const callers = st2.solanaHistory?.callers || {};
  ok(!callers["activity-cold"] && !callers["activity-refresh"], `no activity-cold and no activity-refresh read was made (${Object.keys(callers).join(",") || "no caller"})`);
  ok(st2.solanaHistory?.activityStore?.hits === 1 && st2.solanaHistory.activity?.cold === 0, `the chart came from the stored row (${JSON.stringify(st2.solanaHistory?.activityStore)})`);
  ok(coldReads >= PAYMENTS && head.calls.getSignaturesForAddress + head.calls.getTokenAccountsByOwner === 0, `control: the first boot cost ${coldReads} transaction reads; the second made no account or signature read for the chart`);
  await b.stop();
} finally {
  for (const srv of servers) { try { srv.child.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const l of [pub, keyed, head]) await l.close();
}

clearTimeout(guard);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
