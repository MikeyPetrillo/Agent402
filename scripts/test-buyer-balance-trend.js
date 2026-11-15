// The spending wallet should never go down, so a FALL is the signal.
//
// Everything that spends from it settles into it (SELF_FUNDING_SLUGS), and every
// execution tier charges more than it can spend. Barring a manual withdrawal the
// balance is monotonically non-decreasing. A low-water alarm fires after the
// money is gone; this fires on the first unexplained dollar.
//
// The hard part is the TRANSIENT dip that settlement ordering guarantees: we pay
// the seller during the handler and collect afterwards. An alarm that cannot
// tell that from a drain would page on every healthy call.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { noteBuyerBalance, upstreamBuyerStatus } from "../src/upstream-buyer-status.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const fresh = (v) => noteBuyerBalance(v, { reset: true });

{
  ok(fresh(10) === "ok", "the first read is a baseline, never an alarm");
  ok(noteBuyerBalance(10.3) === "ok", "a rise is healthy - this is what a self-funding wallet does");
  ok(noteBuyerBalance(10.6) === "ok", "…and keeps re-baselining upward");
}

{
  // THE FALSE POSITIVE THIS MUST NOT HAVE. Settlement runs after the handler,
  // so the balance dips while a call is in flight and recovers when revenue
  // lands. Paging on that would make the alarm useless within a day.
  fresh(10);
  ok(noteBuyerBalance(9.7) === "ok", "a dip inside tolerance is an in-flight call, not a drain");
  ok(noteBuyerBalance(10.4) === "ok", "and it recovers when the buyer's payment settles");
}

{
  // THE REAL DRAIN. A fall past tolerance, sustained across consecutive reads.
  fresh(10);
  ok(noteBuyerBalance(7) === "ok", "one big fall is not yet an alarm - a single read could be an in-flight max-tier call");
  ok(noteBuyerBalance(6.9) === "ok", "two is still not");
  ok(noteBuyerBalance(6.8) === "draining", "three consecutive reads below the high-water mark is a drain");
}

{
  // A slow bleed sits INSIDE tolerance on every individual read. If a
  // within-tolerance read cleared the counter, a wallet losing $0.40 a read
  // would never alarm - it would just quietly empty.
  fresh(10);
  noteBuyerBalance(6.5); // past tolerance, counter 1
  noteBuyerBalance(6.4); // counter 2
  ok(noteBuyerBalance(9.6) === "ok",
    "a read within tolerance of the high-water mark does not itself alarm");
  fresh(10);
  ok([9.6, 9.55, 9.5].map((v) => noteBuyerBalance(v)).every((s) => s === "ok"),
    "…and a genuinely small wobble never alarms on its own");
}

{
  // Recovery must clear it, or one bad afternoon pages forever.
  fresh(10);
  noteBuyerBalance(6); noteBuyerBalance(5.9);
  ok(noteBuyerBalance(5.8) === "draining", "draining while it is falling");
  ok(noteBuyerBalance(11) === "ok", "a new high clears the alarm and re-baselines");
  ok(noteBuyerBalance(10.9) === "ok", "and the counter really was reset, not merely masked");
}

{
  ok(fresh(NaN) === "unknown", "an unreadable balance is unknown, never a drain");
  ok(noteBuyerBalance(undefined) === "unknown", "and never throws on junk");
}

{
  // A withdrawal looks exactly like a drain, and SHOULD: the alarm's job is to
  // say "this wallet fell and nobody told me". A human who withdrew can close
  // the issue; a silent fall is the one we must never miss.
  fresh(50);
  const seq = [20, 20, 20].map((v) => noteBuyerBalance(v));
  ok(seq[2] === "draining", "a manual withdrawal alarms too - indistinguishable on purpose");
}

{
  // Keyless boot: the status reads "unconfigured" and never throws, so
  // /api/gateway-status and the heartbeat see a word, not an error.
  const saved = process.env.X402_UPSTREAM_BUYER_KEY;
  delete process.env.X402_UPSTREAM_BUYER_KEY;
  const st = await upstreamBuyerStatus();
  ok(st.configured === false && st.status === "unconfigured" && st.attests === "balance-only", "keyless upstreamBuyerStatus is unconfigured and says it attests the balance only");
  if (saved !== undefined) process.env.X402_UPSTREAM_BUYER_KEY = saved;
}

// The trend state is stored (src/json-document.js: the state database, else
// UPSTREAM_BUYER_TREND_FILE), so a restart carries both a real drain and an
// operator's acknowledgement. A "restart" is a fresh instance of the module
// reading the same store.
{
  const dir = mkdtempSync(join(tmpdir(), "buyer-trend-"));
  const savedKey = process.env.X402_UPSTREAM_BUYER_KEY, savedFile = process.env.UPSTREAM_BUYER_TREND_FILE;
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + "11".repeat(32);
  let gen = 0;
  const instance = async (file, balanceOf) => {
    process.env.UPSTREAM_BUYER_TREND_FILE = file;
    const m = await import(`../src/upstream-buyer-status.js?restart=${++gen}`);
    readers.set(m, async () => balanceOf());
    return m;
  };
  const readers = new Map();
  // Each status read is a fresh read: setting the reader drops the 5-minute cache.
  const read = async (m) => { m.__setBuyerBalanceReaderForTest(readers.get(m)); return (await m.upstreamBuyerStatus()).trend; };
  try {
    // A withdrawal: 50 -> 23.75 for three reads is draining; acknowledged, the next read is ok.
    const fileA = join(dir, "a.json");
    let bal = 50;
    let m = await instance(fileA, () => bal);
    ok(await read(m) === "ok", "stored: the first read baselines");
    bal = 23.75;
    const words = [];
    for (let i = 0; i < 3; i++) words.push(await read(m));
    ok(words.join() === "ok,ok,draining", `stored: a fall past the tolerance for three reads reads draining (${words})`);
    const ack = await m.acknowledgeBuyerTrend({ now: Date.parse("2026-11-15T12:00:00Z") });
    ok(ack.configured && ack.baseline === "current" && ack.stored === "file" && ack.acknowledgedAt === "2026-11-15T12:00:00.000Z" && !("balance" in ack) && !JSON.stringify(ack).includes("23.75"),
      `acknowledge re-baselines to the current balance, records when, and names no figure (${JSON.stringify(ack)})`);
    ok((await m.upstreamBuyerStatus()).trend === "ok", "acknowledged: the very next status read is fresh and reads ok (the 5-minute cache was dropped)");
    // Restart: a new module instance reading the same store.
    m = await instance(fileA, () => bal);
    ok(await read(m) === "ok", "acknowledged: still ok after a restart (the baseline was stored, not only held in memory)");
    ok([await read(m), await read(m), await read(m)].every((w) => w === "ok"), "and stays ok on later reads at the acknowledged balance");
    // A real drain survives a restart: two reads below, restart, the third reads draining.
    const fileB = join(dir, "b.json");
    let b = 40;
    let d = await instance(fileB, () => b);
    await read(d);
    b = 30;
    ok(await read(d) === "ok" && await read(d) === "ok", "drain: two reads below the mark are not yet an alarm");
    d = await instance(fileB, () => b);
    ok(await read(d) === "draining", "drain: the third read below, after a restart, reads draining (the count was stored)");
    d = await instance(fileB, () => b);
    ok(await read(d) === "draining", "drain: and a second restart does not forget it");
    // With no store configured the trend lives in memory, as before.
    const mem = await instance("", () => 10);
    ok(await read(mem) === "ok" && !existsSync(join(dir, "c.json")), "no store configured: the trend is kept in process memory");
    // An unreadable balance at acknowledgement baselines at the next readable read.
    const fileC = join(dir, "c.json");
    let c = 9;
    const u = await instance(fileC, () => c);
    await read(u); c = 3; await read(u); await read(u);
    ok(await read(u) === "draining", "unreadable-at-ack setup: draining");
    u.__setBuyerBalanceReaderForTest(async () => null);
    const ack2 = await u.acknowledgeBuyerTrend();
    ok(ack2.baseline === "next-read" && ack2.stored === "file", `an acknowledgement with the balance unreadable baselines at the next read (${JSON.stringify(ack2)})`);
    ok(await read(u) === "ok", "and that next read reads ok");
  } finally {
    if (savedKey === undefined) delete process.env.X402_UPSTREAM_BUYER_KEY; else process.env.X402_UPSTREAM_BUYER_KEY = savedKey;
    if (savedFile === undefined) delete process.env.UPSTREAM_BUYER_TREND_FILE; else process.env.UPSTREAM_BUYER_TREND_FILE = savedFile;
    rmSync(dir, { recursive: true, force: true });
  }
}

// The operator route: registered on the app, header token only. No buyer key
// on this boot, so the authorized call answers 409 and reads no balance (no
// outbound read); without the token, or with it in Authorization, 404.
{
  const TOKEN = "buyer-trend-operator-token-" + process.pid;
  const srv = await bootServer({ env: { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, X402_UPSTREAM_BUYER_KEY: "" }, stores: "buyer-trend" });
  try {
    const url = `${srv.url}/__operator/upstream-buyer/acknowledge`;
    const none = await fetch(url, { method: "POST" });
    const bearer = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    const header = await fetch(url, { method: "POST", headers: { "X-Operator-Token": TOKEN } });
    const hb = await header.json().catch(() => null);
    ok(none.status === 404, `acknowledge without the token answers 404 (${none.status})`);
    ok(bearer.status === 404, `acknowledge with the token in Authorization answers 404: header token only (${bearer.status})`);
    ok(header.status === 409 && hb?.status === "unconfigured" && /no-store/.test(header.headers.get("cache-control") || ""), `acknowledge with X-Operator-Token reaches the handler (${header.status} ${JSON.stringify(hb)})`);
  } finally { await srv.stop(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
