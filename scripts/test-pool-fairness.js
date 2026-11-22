// The Office, image, HTML and PDF worker pools share their queues fairly by
// caller (src/pool-admission.js over src/caller-places.js): one party filling
// a queue cannot keep a newcomer out, and a caller alone still fills it to the
// same bound as before. Each pool runs on a stand-in worker
// (scripts/lib/stub-pool-worker.js) that holds its thread until this test
// opens the job's gate, so who runs, who waits and who is refused is read
// exactly, with no real decode.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT } from "../src/tools/kit.js";
import { runAsCallerOf } from "../src/dispatch-caller.js";
import { createPoolAdmission } from "../src/pool-admission.js";
import * as office from "../src/tools/office-pool.js";
import * as image from "../src/tools/image-pool.js";
import * as html from "../src/tools/html-pool.js";
import * as pdf from "../src/tools/pdf-offthread.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB = fileURLToPath(new URL("./lib/stub-pool-worker.js", import.meta.url));
const SLOTS = 200;

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(5); }
  return cond();
}

// One pool, driven the same way: `submit(data)` runs one job carrying `data`
// for the caller in scope; `waiting()` reads the pool's queue length.
async function scenario(name, { setWorker, submit, waiting, callers, workers, soft, hard }) {
  setWorker(STUB);
  const gate = new SharedArrayBuffer(4 * SLOTS), started = new SharedArrayBuffer(4 * SLOTS);
  const g = new Int32Array(gate), st = new Int32Array(started);
  let next = 0;
  const outcomes = new Map();
  const send = (ip) => {
    const idx = next++;
    const p = runAsCallerOf({ ip, headers: {} }, () => submit({ gate, started, idx }));
    const o = Promise.resolve(p).then((r) => ({ ok: true, tag: r?.tag ?? r?.result?.tag }), (e) => ({ ok: false, status: e?.statusCode, message: String(e?.message || e) }));
    outcomes.set(idx, o);
    return idx;
  };
  const open = (idx) => { Atomics.store(g, idx, 1); Atomics.notify(g, idx); };
  const settledWithin = async (idx, ms = 150) => Promise.race([outcomes.get(idx), sleep(ms).then(() => null)]);
  const A = "203.0.113.7", B = "198.51.100.9";
  try {
    // A fills every worker, then the queue.
    const running = Array.from({ length: workers }, () => send(A));
    ok(await until(() => running.every((i) => st[i] === 1)), `${name}: one caller's first ${workers} jobs hold every worker`);
    const queued = Array.from({ length: soft }, () => send(A));
    await sleep(20);
    ok(waiting() === soft && (await Promise.all(queued.map((i) => settledWithin(i, 1)))).every((x) => x === null), `${name}: a caller alone fills the queue to its bound (${waiting()} of ${soft} waiting)`);
    const ownExcess = send(A);
    const own = await settledWithin(ownExcess);
    ok(own && own.ok === false && own.status === 503 && /this caller's earlier/.test(own.message), `${name}: that caller's next job past the bound is answered busy at once, 503, nothing charged (${own?.status}, ${own?.message})`);
    // A newcomer from another address is queued over the bound.
    const newcomer = send(B);
    const nb = await settledWithin(newcomer);
    ok(nb === null && waiting() === soft + 1, `${name}: a newcomer from another address is queued over the bound, not refused (${nb ? `${nb.status} ${nb.message}` : "waiting"}, ${waiting()} waiting)`);
    // The next free worker takes the newcomer, ahead of the first caller's queue.
    open(running[0]);
    await until(() => st[newcomer] === 1 || queued.some((i) => st[i] === 1), 3000);
    ok(st[newcomer] === 1 && queued.every((i) => st[i] === 0), `${name}: the next free worker takes the newcomer's job, ahead of the ${soft} the first caller queued`);
    // Newcomers from distinct addresses fill to the hard bound; past it a
    // newcomer takes the newest place of the party holding the most.
    const fill = [];
    while (waiting() < hard && fill.length <= hard) fill.push(send(`192.0.2.${fill.length + 1}`));
    await sleep(20);
    ok(waiting() === hard && (await Promise.all(fill.map((i) => settledWithin(i, 1)))).every((x) => x === null), `${name}: newcomers are admitted over the bound up to the hard bound (${waiting()} of ${hard})`);
    const late = send("192.0.2.250");
    const evicted = await settledWithin(queued[queued.length - 1], 300);
    ok(evicted && evicted.ok === false && evicted.status === 503 && waiting() === hard && (await settledWithin(late, 1)) === null && (await settledWithin(queued[0], 1)) === null, `${name}: at the hard bound a newcomer takes the newest place of the caller holding the most, which is answered busy (${evicted?.status}, ${waiting()} waiting)`);
    // Everything else runs to its answer.
    for (let i = 0; i < next; i++) open(i);
    const all = await Promise.all([...outcomes.values()]);
    ok(all.filter((x) => x.ok).length === next - 2 && waiting() === 0 && callers() === 0, `${name}: every other job is answered and every place released (${all.filter((x) => x.ok).length} of ${next}, ${callers()} callers still counted)`);
  } finally {
    for (let i = 0; i < SLOTS; i++) open(i);
    await Promise.allSettled([...outcomes.values()]);
    setWorker(null);
  }
}

await scenario("office", {
  setWorker: office.__setOfficeWorkerForTest, workers: office.OFFICE_POOL_MAX, soft: office.OFFICE_QUEUE_MAX, hard: office.OFFICE_QUEUE_HARD_MAX,
  submit: (d) => office.runOfficeOp("xlsx", d), waiting: () => office.officePoolState().waiting, callers: () => office.officePoolState().callers,
});
await scenario("image", {
  setWorker: image.__setImageWorkerForTest, workers: 2, soft: 32, hard: 48,
  submit: (d) => image.runImageOffThread({ op: "resize", buffer: Buffer.from("stand-in"), params: d, timeoutMs: 20_000 }), waiting: () => image.imagePoolState().waiting, callers: () => image.imagePoolState().callers,
});
await scenario("html", {
  setWorker: html.__setHtmlWorkerForTest, workers: 2, soft: 32, hard: 48,
  submit: (d) => html.runHtml("tool", d, 10), waiting: () => html.htmlPoolState().queued, callers: () => html.htmlPoolState().callers,
});
// The tools that parse in the HTML worker (P13: xml-to-json, feed-parse,
// the page-change selector) take places by caller like every other HTML job:
// one caller flooding the free xml-to-json tool, through its real handler,
// cannot keep a paid HTML call from another caller out.
{
  html.__setHtmlWorkerForTest(STUB);
  const xml = KIT.find((t) => t.slug === "xml-to-json");
  const dir = mkdtempSync(join(tmpdir(), "a402-xmlflood-"));
  const gate = new SharedArrayBuffer(4 * 4), started = new SharedArrayBuffer(4 * 4);
  const g = new Int32Array(gate), st = new Int32Array(started);
  const A = "203.0.113.70", B = "198.51.100.90";
  const outcomes = [];
  const settle = (p) => Promise.resolve(p).then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e?.statusCode, message: String(e?.message || e) }));
  const flood = (i) => { const o = settle(runAsCallerOf({ ip: A, headers: {} }, () => xml.handler({ xml: `<hold idx="${i}" dir="${dir}"/>` }))); outcomes.push(o); return o; };
  const within = (o, ms) => Promise.race([o, sleep(ms).then(() => null)]);
  try {
    ok(xml && /runHtml\("xmlToJson"/.test(String(xml.handler)), "xml-to-json parses through the HTML pool (runHtml), so its admission applies");
    for (let i = 0; i < 2; i++) flood(i);
    ok(await until(() => existsSync(join(dir, "started-0")) && existsSync(join(dir, "started-1"))), "xml flood: one caller's first two xml-to-json calls hold both HTML workers");
    for (let i = 2; i < 34; i++) flood(i);
    await sleep(20);
    const own = await within(flood(34), 300);
    ok(html.htmlPoolState().queued === 32 && own && own.ok === false && own.status === 503, `xml flood: the flooding caller fills the queue to its bound and its next call is answered busy (${html.htmlPoolState().queued} waiting, ${own?.status})`);
    const paid = settle(runAsCallerOf({ ip: B, headers: {} }, () => html.runHtml("tool", { gate, started, idx: 0 }, 10)));
    outcomes.push(paid);
    ok((await within(paid, 150)) === null, "xml flood: a paid HTML call from another caller is queued, not refused");
    writeFileSync(join(dir, "open-0"), "");
    await until(() => st[0] === 1 || existsSync(join(dir, "started-2")), 3000);
    ok(st[0] === 1 && !existsSync(join(dir, "started-2")), "xml flood: the next free worker takes the other caller's paid call, ahead of the flood");
  } finally {
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `open-${i}`), "");
    Atomics.store(g, 0, 1); Atomics.notify(g, 0);
    await Promise.allSettled(outcomes);
    ok(html.htmlPoolState().callers === 0 && html.htmlPoolState().queued === 0, "xml flood: every place is released");
    html.__setHtmlWorkerForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
}
await scenario("pdf", {
  setWorker: pdf.__setPdfWorkerForTest, workers: pdf.PDF_WORKERS_MAX, soft: pdf.PDF_QUEUE_MAX, hard: pdf.PDF_QUEUE_HARD_MAX,
  submit: (d) => pdf.runPdfOp("info", [Buffer.from("stand-in")], [d]), waiting: () => pdf.pdfPoolState().waiting, callers: () => pdf.pdfPoolState().callers,
});
ok(office.OFFICE_QUEUE_HARD_MAX === 24 && pdf.PDF_QUEUE_HARD_MAX === 24 && pdf.PDF_QUEUE_HARD_BYTES === 320 * 1024 * 1024, "the hard bounds: office 24, pdf 24 calls and 320 MB, image and html 48");

// The byte bound past the soft count (the PDF pool's): a newcomer whose
// document does not fit takes the newest places of the party holding the
// most until it does; one that would fit is admitted with nobody giving way.
{
  const adm = createPoolAdmission({ soft: 2, hard: 10, hardBytes: 100 });
  const q = [];
  const join = (who, bytes) => { const r = adm.admit(q, who, bytes); if (!r.refused) { adm.hold(who); q.push({ who, bytes }); } return r; };
  join(["ip:a"], 40); join(["ip:a"], 40);
  ok(join(["ip:a"], 10).refused === "own", "bytes: the caller's own excess past the soft count is refused");
  const small = join(["ip:b"], 10);
  ok(!small.refused && small.evicted.length === 0, "bytes: a newcomer that fits the byte bound is admitted, nobody giving way");
  const big = join(["ip:c"], 50);
  ok(!big.refused && big.evicted.length === 1 && big.evicted[0].who[0] === "ip:a", `bytes: a newcomer past the byte bound takes the newest place of the party holding the most (${big.evicted?.length})`);
  for (const v of big.evicted) adm.free(v.who);
  ok(q.reduce((n, j) => n + j.bytes, 0) <= 100, "bytes: the waiting jobs then hold no more than the byte bound");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
