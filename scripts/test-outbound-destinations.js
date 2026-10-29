#!/usr/bin/env node
// New-destination watch over the outbound ledger (src/outbound-destinations.js).
//
// Every payment a spending wallet signs names a recipient. The first time a
// (chain, recipient) pair is paid it is recorded, and /api/gateway-status
// answers one word: ok (no first sighting in the window), new (at least one,
// expected), burst (more than the threshold). Addresses stay on the operator
// listing.
//
// Four parts: the pure pieces (key, word), the store on a file under a temp
// dir standing in for /data (first sighting once, window expiry, the burst
// threshold, persistence across a new instance), the ledger hook (a recorded
// payment reaches the store off the payment path; a released credential does
// not), and a booted server (word only in public, counts for the operator, the
// listing behind the operator token and 404 without it).
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createOutboundDestinationStore, destinationKey, destinationWord, DEFAULT_WINDOW_HOURS, DEFAULT_BURST_OVER } from "../src/outbound-destinations.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const H = 3600_000;
const EVM = "0xAbCdEf0000000000000000000000000000000001";
const SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ALGO = "ZKFACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. The pure pieces ------------------------------------------------------
{
  ok(destinationKey("base", EVM) === `base:${EVM.toLowerCase()}`, "an EVM address is one wallet in any letter case: keyed lowercased");
  ok(destinationKey("Base", EVM.toUpperCase().replace("0X", "0x")) === destinationKey("base", EVM), "chain and EVM case never make a second key");
  ok(destinationKey("solana", SOL) === `solana:${SOL}`, "a base58 address is kept exactly as quoted");
  ok(destinationKey("solana", SOL.toLowerCase()) !== destinationKey("solana", SOL), "a base58 address is never case-folded");
  ok(destinationKey("algorand", ALGO) === `algorand:${ALGO}`, "an Algorand address is kept exactly");
  ok(destinationKey("", EVM) === null && destinationKey("base", "") === null && destinationKey(null, null) === null, "no chain or no recipient is no key");
  ok(destinationKey("base", "x".repeat(129)) === null, "an oversized recipient is no key");
  ok(destinationWord(0) === "ok" && destinationWord(1) === "new" && destinationWord(10) === "new" && destinationWord(11) === "burst", `the word: 0 ok, 1..${DEFAULT_BURST_OVER} new, more burst`);
  ok(destinationWord(3, 2) === "burst" && destinationWord(2, 2) === "new", "the threshold is 'more than', and it is the store's to set");
  ok(destinationWord(null) === "unknown" && destinationWord(-1) === "unknown", "no count is unknown, never ok");
  ok(DEFAULT_WINDOW_HOURS === 24 && DEFAULT_BURST_OVER === 10, "defaults: a 24 h window, burst past 10 first-time recipients");
}

// --- 2. The store on a file --------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "outbound-dest-"));
const file = join(dir, "outbound-destinations.json");
{
  let t = Date.parse("2026-10-20T12:00:00Z");
  const now = () => t;
  const logs = [];
  const store = createOutboundDestinationStore({ file, now, windowHours: 24, burstOver: 3, log: (m) => logs.push(m) });
  ok(store.backend === "file", `the store is on the file (${store.backend})`);
  ok(store.word() === "ok" && store.newInWindow() === 0, "an empty store reads ok, not unknown: the file's absence is a read body");

  const a = await store.note({ chain: "base", payTo: EVM, origin: "https://seller-a.example/api/x?key=secret", slug: "route-execute" });
  ok(a.new === true, "the first payment to a recipient is new");
  ok(store.word() === "new", "one first sighting inside the window reads new");
  const again = await store.note({ chain: "base", payTo: EVM.toLowerCase(), origin: "https://seller-a.example/" });
  ok(again.new === false, "the same EVM recipient in another case is not new again");
  t += 1;
  const other = await store.note({ chain: "solana", payTo: EVM });
  ok(other.new === true, "the same address on another chain is another destination");
  const none = await store.note({ chain: "base", payTo: "" });
  ok(none.new === false && none.key === null, "an unusable pair records nothing and is not new");
  const listing = await store.list();
  ok(listing.recent.length === 2 && listing.recent[0].chain === "solana" && listing.recent[1].payTo === EVM.toLowerCase(), "the listing has each first sighting, newest first, with the recipient");
  ok(listing.recent[1].origin === "seller-a.example" && !JSON.stringify(listing).includes("secret"), "an origin is kept as its host only: a query string never reaches the store");
  ok(!("usd" in listing.recent[0]) && !("amountAtomic" in listing.recent[0]), "the listing carries no amount");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  ok(stored.seen && Object.keys(stored.seen).length === 2 && stored.seen[`base:${EVM.toLowerCase()}`].firstAt === new Date(t - 1).toISOString(), "the file holds the first-seen time per key");

  // Burst: past the threshold inside the window.
  t += H;
  await store.note({ chain: "base", payTo: "0x" + "2".repeat(40) });
  ok(store.word() === "new" && store.newInWindow() === 3, "at the threshold it still reads new (burst is 'more than')");
  await store.note({ chain: "base", payTo: "0x" + "3".repeat(40) });
  ok(store.word() === "burst" && store.newInWindow() === 4, "one past the threshold reads burst");
  const st = await store.status({ full: true });
  ok(st.status === "burst" && st.windowHours === 24 && st.burstOver === 3 && st.newInWindow === 4 && st.known === 4, `the operator status carries the window, threshold and counts (${JSON.stringify(st)})`);
  ok(JSON.stringify(await store.status()) === JSON.stringify({ status: "burst" }), "the public status is the word alone");
  ok(!JSON.stringify(st).match(/0x[0-9a-f]{40}/i), "no address on the status, even for the operator");

  // Window expiry: the clock moves on, the sightings age out, repeats stay known.
  t += 23 * H + 1;
  ok(store.word() === "new" && store.newInWindow() === 2, "the first two sightings left the window; the later two remain");
  t += 2 * H;
  ok(store.word() === "ok" && store.newInWindow() === 0, "with every sighting outside the window the word is ok");
  const repeat = await store.note({ chain: "base", payTo: EVM });
  ok(repeat.new === false && store.word() === "ok", "a recipient paid before the window is still known: paying it again is not new");
  const l2 = await store.list({ limit: 3 });
  ok(l2.recent.length === 0 && l2.earlier.length === 3 && l2.truncated === true && l2.known === 4, "the listing caps the rows and says when it did");
  ok(logs.length === 0, `nothing was logged on the happy path (${logs.join(" | ")})`);

  // Persistence across a restart: a new instance on the same file.
  const t2 = t;
  const store2 = createOutboundDestinationStore({ file, now: () => t2, windowHours: 24, burstOver: 3 });
  ok(store2.size === 0, "a fresh instance starts with nothing in memory");
  const r = await store2.note({ chain: "base", payTo: "0x" + "3".repeat(40) });
  ok(r.new === false && store2.size === 4, "after a restart a recipient paid before is not new: the file is the memory");
  const r2 = await store2.note({ chain: "solana", payTo: SOL });
  ok(r2.new === true && store2.word() === "new", "and a recipient never paid is new");
  const store3 = createOutboundDestinationStore({ file, now: () => t2 - 25 * H, windowHours: 24, burstOver: 3 });
  store3.load();
  ok(store3.word() === "burst" && store3.newInWindow() === 5, `the word after a restart comes from the stored first-seen times, not from the restart (${store3.newInWindow()})`);

  // Two concurrent first payments to one recipient record it once.
  const store4 = createOutboundDestinationStore({ file: join(dir, "race.json"), now, windowHours: 24, burstOver: 3 });
  const both = await Promise.all([store4.note({ chain: "base", payTo: "0x" + "9".repeat(40) }), store4.note({ chain: "base", payTo: "0x" + "9".repeat(40) })]);
  ok(both.filter((x) => x.new).length === 1 && store4.newInWindow() === 1, "two first payments to one recipient at once: new once, counted once");

  // A store that cannot write says so once and never throws.
  const blocked = createOutboundDestinationStore({ file: join(file, "under-a-file", "x.json"), now, log: (m) => logs.push(m) });
  const b1 = await blocked.note({ chain: "base", payTo: EVM });
  const b2 = await blocked.note({ chain: "base", payTo: "0x" + "4".repeat(40) });
  ok(b1.new === false && b2.new === false, "an unwritable store never reports a sighting it could not keep");
  ok(logs.length === 1 && /update failed|could not record/.test(logs[0]), `an unwritable store logs once per ten minutes, not per payment (${logs.length} lines)`);

  // Memory only (no file): the words still work for a process without a volume.
  const mem = createOutboundDestinationStore({ now, windowHours: 1, burstOver: 1 });
  await mem.note({ chain: "base", payTo: EVM });
  await mem.note({ chain: "base", payTo: "0x" + "5".repeat(40) });
  ok(mem.backend === "memory" && mem.word() === "burst", "without a file the store answers from memory");
}

// --- 3. The ledger hook ------------------------------------------------------
{
  const ldir = mkdtempSync(join(tmpdir(), "outbound-ledger-"));
  process.env.OUTBOUND_LEDGER_FILE = join(ldir, "outbound-spend.ndjson");
  process.env.OUTBOUND_NEW_DEST_BURST = "1";
  const { recordOutbound } = await import("../src/outbound-ledger.js");
  const { outboundDestinationStore } = await import("../src/outbound-destinations.js");
  const store = outboundDestinationStore();
  const t0 = Date.now();
  recordOutbound({ chain: "base", payTo: EVM, amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "route-execute", origin: "https://seller-a.example/x", result: "delivered", tx: "0xtx" });
  ok(store.size === 0 && Date.now() - t0 < 50, "the ledger write returns before the store is touched: nothing on the payment path waits");
  recordOutbound({ chain: "base", payTo: "0x" + "6".repeat(40), amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "s", origin: "https://seller-b.example/", result: "undelivered", tx: null });
  recordOutbound({ chain: "base", payTo: "0x" + "7".repeat(40), amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "s", origin: "https://seller-c.example/", result: "refused", tx: null });
  recordOutbound({ chain: "base", payTo: null, amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "s", origin: null, result: "delivered", tx: null });
  for (let i = 0; i < 50 && store.size < 2; i++) await sleep(20);
  ok(store.size === 2, `a delivered and an undelivered payment each reach the store (${store.size})`);
  await sleep(100);
  const l = await store.list();
  ok(!l.recent.some((r) => r.payTo === "0x" + "7".repeat(40)), "a released credential (refused: no debit on chain) paid nobody and records no destination");
  ok(l.recent.length === 2 && store.word() === "burst", "the store reads from the environment: two first sightings past OUTBOUND_NEW_DEST_BURST=1 reads burst");
  const sidecar = JSON.parse(readFileSync(join(ldir, "outbound-destinations.json"), "utf8"));
  ok(Object.keys(sidecar.seen).length === 2, "the destination file sits beside the ledger file");
  const ledger = readFileSync(process.env.OUTBOUND_LEDGER_FILE, "utf8").trim().split("\n");
  ok(ledger.length === 4, "the ledger itself still records every signed payment, the refused one included");
  delete process.env.OUTBOUND_NEW_DEST_BURST;
  rmSync(ldir, { recursive: true, force: true });
}

// --- 4. A booted server ------------------------------------------------------
{
  const sdir = mkdtempSync(join(tmpdir(), "outbound-server-"));
  const recent = new Date(Date.now() - 2 * H).toISOString();
  const old = new Date(Date.now() - 80 * H).toISOString();
  writeFileSync(join(sdir, "outbound-destinations.json"), JSON.stringify({ version: 1, seen: {
    [`base:${EVM.toLowerCase()}`]: { firstAt: recent, chain: "base", origin: "seller-a.example", slug: "route-execute" },
    [`solana:${SOL}`]: { firstAt: recent, chain: "solana", origin: "seller-b.example", slug: null },
    [`base:0x${"8".repeat(40)}`]: { firstAt: old, chain: "base", origin: null, slug: null },
  } }));
  const PORT = await getFreePort();
  const TOKEN = "outbound-test-operator-token-0123456789";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
           AGENT402_OPERATOR_TOKEN: TOKEN, OUTBOUND_LEDGER_FILE: join(sdir, "outbound-spend.ndjson"), OUTBOUND_NEW_DEST_BURST: "1", OUTBOUND_NEW_DEST_WINDOW_H: "24" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break; } } catch {}
    await sleep(500);
  }
  ok(up, "the server booted");
  try {
    const pub = await (await fetch(`${base}/api/gateway-status`)).json();
    ok(JSON.stringify(pub.outboundDestinations) === JSON.stringify({ status: "burst" }), `the public field is the word alone, read from the stored body at boot (${JSON.stringify(pub.outboundDestinations)})`);
    ok(!JSON.stringify(pub).includes(EVM.toLowerCase()) && !JSON.stringify(pub).includes(SOL), "no recipient on the public endpoint");
    const op = await (await fetch(`${base}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } })).json();
    ok(op.outboundDestinations.status === "burst" && op.outboundDestinations.newInWindow === 2 && op.outboundDestinations.known === 3 && op.outboundDestinations.burstOver === 1, `the operator field carries the counts (${JSON.stringify(op.outboundDestinations)})`);
    ok(!JSON.stringify(op.outboundDestinations).includes(EVM.toLowerCase()), "and still no recipient");
    const anon = await fetch(`${base}/__operator/outbound-destinations.json`);
    ok(anon.status === 404, `the listing is not there without the operator token (${anon.status})`);
    const lr = await fetch(`${base}/__operator/outbound-destinations.json?limit=2`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const l = await lr.json();
    ok(lr.status === 200 && lr.headers.get("cache-control") === "no-store", "the operator listing answers and is never cached");
    ok(l.status === "burst" && l.recent.length === 2 && l.recent.every((r) => [EVM.toLowerCase(), SOL].includes(r.payTo)) && l.earlier.length === 0 && l.truncated === true, `the listing names the first-time recipients inside the window (${JSON.stringify(l.recent.map((r) => r.chain))})`);
    const full = await (await fetch(`${base}/__operator/outbound-destinations.json`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    ok(full.earlier.length === 1 && full.earlier[0].payTo === "0x" + "8".repeat(40) && full.truncated === false, "the earlier sightings follow the recent ones");
  } finally {
    child.kill();
    rmSync(sdir, { recursive: true, force: true });
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\ntest-outbound-destinations: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
