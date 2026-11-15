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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
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
  // A read answers from the process copy once the store has answered, and the
  // store takes the step in the background: wait for it, so a "restart" reads
  // what this read stored.
  const read = async (m) => { m.__setBuyerBalanceReaderForTest(readers.get(m)); const w = (await m.upstreamBuyerStatus()).trend; await m.flushBuyerTrend(); return w; };
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
    await m.flushBuyerTrend();
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

// The store failing, rewriting, hanging, and many reads at once. A file store
// is made unwritable by a directory where its temporary file goes (the write
// fails for any user, root included) while the stored body still reads.
{
  const dir = mkdtempSync(join(tmpdir(), "buyer-trend-store-"));
  const savedKey = process.env.X402_UPSTREAM_BUYER_KEY, savedFile = process.env.UPSTREAM_BUYER_TREND_FILE;
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + "22".repeat(32);
  let gen = 0;
  const load = async (file) => {
    process.env.UPSTREAM_BUYER_TREND_FILE = file;
    return import(`../src/upstream-buyer-status.js?store=${++gen}`);
  };
  const read = async (m, balance) => { m.__setBuyerBalanceReaderForTest(async () => balance); const w = (await m.upstreamBuyerStatus()).trend; await m.flushBuyerTrend(); return w; };
  const block = (file) => mkdirSync(`${file}.${process.pid}.tmp`);
  const unblock = (file) => rmSync(`${file}.${process.pid}.tmp`, { recursive: true, force: true });
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...a) => { warned.push(a.join(" ")); };
  try {
    // 1. Two reads below the mark, restart, the store unwritable: unknown,
    // never ok (the empty process copy would take 30 as a new mark).
    const fileA = join(dir, "a.json");
    let m = await load(fileA);
    await read(m, 40);
    ok(await read(m, 30) === "ok" && await read(m, 30) === "ok", "store failing: two reads below the mark are not yet an alarm");
    ok(JSON.parse(readFileSync(fileA, "utf8")).belowReads === 2, "store failing: the count of two is stored");
    block(fileA);
    m = await load(fileA);
    const failing = [await read(m, 30), await read(m, 30), await read(m, 30)];
    ok(failing.every((w) => w === "unknown"), `after a restart with the store unwritable the trend reads unknown, never ok (${failing})`);
    ok(JSON.parse(readFileSync(fileA, "utf8")).highWater === 40, "and the stored mark is untouched");
    unblock(fileA);
    ok(await read(m, 30) === "draining", "once the store answers, the third read below the mark reads draining");
    ok(await read(m, 30) === "draining", "and keeps reading draining");

    // 5. An unwritable store is named once per process, not once per read.
    const lines = warned.filter((l) => l.includes("[upstream-buyer]") && l.includes("trend store"));
    ok(lines.length === 1 && lines[0].includes("(file)") && !/\b(30|40)\b/.test(lines[0]), `an unwritable trend store logs one warn line per process (${lines.length}: ${lines[0]})`);
    warned.length = 0;
    const fileE = join(dir, "e.json");
    block(fileE);
    const e = await load(fileE);
    for (let i = 0; i < 4; i++) await read(e, 12);
    ok(warned.filter((l) => l.includes("[upstream-buyer]")).length === 1, `a fresh process with an unwritable file warns once over four reads (${warned.length})`);
    unblock(fileE);

    // 2. A read that changes nothing does not rewrite the document. A marker
    // field in the stored body survives only while nothing is written.
    const fileB = join(dir, "b.json");
    const b = await load(fileB);
    await read(b, 20);
    writeFileSync(fileB, JSON.stringify({ ...JSON.parse(readFileSync(fileB, "utf8")), marker: "unwritten" }));
    const before = statSync(fileB, { bigint: true });
    const N = 10;
    const same = [];
    for (let i = 0; i < N; i++) same.push(await read(b, i % 2 ? 20 : 19.8));
    const after = statSync(fileB, { bigint: true });
    ok(same.every((w) => w === "ok") && JSON.parse(readFileSync(fileB, "utf8")).marker === "unwritten" && after.ino === before.ino && after.mtimeNs === before.mtimeNs,
      `${N} reads that change nothing (at the mark, and a dip inside tolerance) cause zero writes`);
    await read(b, 25);
    ok(JSON.parse(readFileSync(fileB, "utf8")).highWater === 25, "a read that does change the state is still written");

    // 3. A hung store: after one good answer a status read answers from the
    // process copy without waiting; the first read after a restart still
    // waits for the store and reads unknown without it.
    const store = { body: null, hang: false, writes: 0 };
    const fake = {
      backend: "pg",
      update(fn) {
        if (store.hang) return new Promise(() => {});
        const out = fn(store.body == null ? null : JSON.parse(JSON.stringify(store.body)));
        if (typeof out === "symbol") return Promise.resolve({ ok: true, body: store.body, changed: false });
        store.body = out; store.writes++;
        return Promise.resolve({ ok: true, body: out, changed: true });
      },
    };
    // The store deadline's timer is unref'd (it never holds a server open);
    // here nothing else would keep the process alive while a read waits on it.
    const keep = setInterval(() => {}, 1000);
    const h = await load("");
    h.__setTrendDocumentForTest(fake);
    await read(h, 50);
    store.hang = true;
    const timeRead = async (bal) => { h.__setBuyerBalanceReaderForTest(async () => bal); const t = performance.now(); const w = (await h.upstreamBuyerStatus()).trend; return { w, ms: Math.round(performance.now() - t) }; };
    const hung = [await timeRead(50), await timeRead(40), await timeRead(40)];
    console.log(`# hung store, after one good answer: ${hung.map((x) => `${x.w} ${x.ms} ms`).join(", ")}`);
    ok(hung.every((x) => x.ms < 250), `a hung store does not hold a status read (${hung.map((x) => x.ms)} ms; the store deadline is ${h.TREND_STORE_MS} ms)`);
    ok(hung.map((x) => x.w).join() === "ok,ok,ok", "and the word comes from the process copy");
    ok((await timeRead(40)).w === "draining", "the process copy still counts a drain while the store hangs");
    const h2 = await load("");
    h2.__setTrendDocumentForTest(fake);
    h2.__setBuyerBalanceReaderForTest(async () => 40);
    const t0 = performance.now();
    const first = (await h2.upstreamBuyerStatus()).trend;
    const firstMs = Math.round(performance.now() - t0);
    clearInterval(keep);
    console.log(`# hung store, first read after a restart: ${first} ${firstMs} ms`);
    ok(first === "unknown" && firstMs >= h2.TREND_STORE_MS - 50, `the first read after a restart waits for the store and reads unknown without it (${first}, ${firstMs} ms)`);

    // 4. Twenty reads at once: one balance read, and the fall counted once.
    const fileD = join(dir, "d.json");
    const s = await load(fileD);
    await read(s, 40);
    let rpc = 0;
    s.__setBuyerBalanceReaderForTest(async () => { rpc++; await new Promise((r) => setTimeout(r, 30)); return 30; });
    const words = await Promise.all(Array.from({ length: 20 }, () => s.upstreamBuyerStatus()));
    await s.flushBuyerTrend();
    ok(rpc === 1, `twenty concurrent status reads make one balance read (${rpc})`);
    ok(JSON.parse(readFileSync(fileD, "utf8")).belowReads === 1 && words.every((w) => w.trend === "ok"), `and the fall is counted once (${readFileSync(fileD, "utf8").includes('"belowReads":1')})`);
  } finally {
    console.warn = realWarn;
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
