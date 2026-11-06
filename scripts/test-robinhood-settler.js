#!/usr/bin/env node
// robinhoodSettler on /api/gateway-status (src/robinhood-order.js): ok while
// the listed Robinhood Chain facilitator settles first, relayer once our own
// relayer has been first without a break for longer than
// ROBINHOOD_RELAYER_FIRST_ALERT_HOURS, off without an order or with the alert
// disabled. The order's since lives in a store, so a fresh process (a deploy,
// another replica) keeps the clock. The heartbeat step and the status Worker
// page on relayer under one title and close on ok / off. Offline: an
// in-memory store stands in for the state database
// (scripts/test-robinhood-settler-pg.js runs the real one).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import * as order from "../src/robinhood-order.js";

let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => console.log(`  ok   ${name}`))
  .catch((e) => { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); });

const { createRobinhoodOrder } = order;
const RH = "eip155:4663";
const HOST = "facilitator.example";
const H = 3_600_000;
const T0 = 1_800_000_000_000;
const row = (at, over = {}) => ({ network: RH, facilitator: HOST, signer: "0x" + "11".repeat(20), balanceEth: 0.001, runway: 600, status: "ok", at, ...over });
const dry = (at) => [row(at, { runway: 3, status: "low", balanceEth: 0.000001 })];
const funded = (at) => [row(at, { runway: 2000 })];
const memStore = () => { const s = { body: null, saves: 0, async load() { return s.body ? JSON.parse(JSON.stringify(s.body)) : null; }, async save(b) { s.saves++; s.body = JSON.parse(JSON.stringify(b)); } }; return s; };
const ENV = {}; // the default threshold (6 hours)
const mk = (clock, store = null) => createRobinhoodOrder({ host: HOST, now: () => clock.t, log: () => {}, store });
const word = (o, clock, env = ENV) => o.status({ env, at: clock.t }).status;

await check("the threshold: unset or junk is 6 hours, a number tunes it, 0 and off disable", () => {
  assert.equal(typeof order.relayerFirstAlertHours, "function", "relayerFirstAlertHours is exported");
  assert.equal(order.relayerFirstAlertHours({}), 6);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "" }), 6);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "junk" }), 6);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "-3" }), 6);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "2.5" }), 2.5);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "0" }), null);
  assert.equal(order.relayerFirstAlertHours({ ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: " OFF " }), null);
});

await check("relayer first for longer than the threshold reads relayer; shorter reads ok", () => {
  const clock = { t: T0 };
  const o = mk(clock);
  assert.equal(typeof o.status, "function", "the order has a status word");
  assert.equal(word(o, clock), "ok", "no reading yet: ok");
  o.update(dry(clock.t));
  assert.equal(o.ownFirst(), true);
  assert.equal(word(o, clock), "ok", "just turned: ok");
  clock.t = T0 + 5.9 * H; o.update(dry(clock.t));
  assert.equal(word(o, clock), "ok", "under six hours: ok");
  clock.t = T0 + 6 * H + 60_000; o.update(dry(clock.t));
  assert.equal(word(o, clock), "relayer", "past six hours: relayer");
  assert.equal(word(o, clock, { ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "12" }), "ok", "a longer threshold: ok");
  assert.equal(word(o, clock, { ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: "1" }), "relayer");
});

await check("the facilitator first again reads ok and resets the clock", () => {
  const clock = { t: T0 };
  const o = mk(clock);
  o.update(dry(clock.t));
  clock.t = T0 + 7 * H; o.update(dry(clock.t));
  assert.equal(word(o, clock), "relayer");
  clock.t = T0 + 7 * H + 600_000; o.update(funded(clock.t));
  assert.equal(o.ownFirst(), false);
  assert.equal(word(o, clock), "ok", "facilitator first: ok");
  clock.t = T0 + 8 * H; o.update(dry(clock.t));
  assert.equal(o.ownFirst(), true);
  clock.t = T0 + 9 * H; o.update(dry(clock.t));
  assert.equal(word(o, clock), "ok", "dry again an hour ago: the clock started over");
  clock.t = T0 + 14 * H + 60_000; o.update(dry(clock.t));
  assert.equal(word(o, clock), "relayer");
});

await check("a deploy: a fresh process with the stored since keeps the clock", async () => {
  const store = memStore();
  const clock = { t: T0 };
  const a = mk(clock, store);
  a.update(dry(clock.t));
  await a.synced();
  assert.equal(store.body?.ownFirst, true, "the turn is stored");
  assert.equal(store.body?.since, T0);
  // The new build boots seven hours later and reads the same dry signer.
  clock.t = T0 + 7 * H;
  const b = mk(clock, store);
  b.update(dry(clock.t));
  await b.synced();
  assert.equal(word(b, clock), "relayer", "the clock carried across the deploy");
  assert.equal(b.status({ full: true, env: ENV, at: clock.t }).since, new Date(T0).toISOString());
  // A second replica that turned later adopts the earlier start too.
  const c = mk(clock, store);
  c.update(dry(clock.t));
  await c.synced();
  assert.equal(word(c, clock), "relayer");
  assert.equal(store.body.since, T0, "the earlier start is never replaced by a later one");
});

await check("a deploy that finds the facilitator funded writes it, and a later dry reading starts a fresh clock", async () => {
  const store = memStore();
  const clock = { t: T0 };
  const a = mk(clock, store);
  a.update(dry(clock.t));
  await a.synced();
  clock.t = T0 + 7 * H;
  const b = mk(clock, store);
  b.update(funded(clock.t));
  await b.synced();
  assert.equal(word(b, clock), "ok");
  assert.equal(store.body.ownFirst, false, "the stored order follows the fresh process");
  clock.t = T0 + 8 * H;
  const c = mk(clock, store);
  c.update(dry(clock.t));
  await c.synced();
  assert.equal(word(c, clock), "ok", "a stale start is not adopted after the facilitator was first");
  assert.equal(store.body.since, T0 + 8 * H);
});

await check("a store that throws leaves the process's own clock", async () => {
  const clock = { t: T0 };
  const o = mk(clock, { async load() { throw new Error("db down"); }, async save() { throw new Error("db down"); } });
  o.update(dry(clock.t));
  await o.synced();
  clock.t = T0 + 7 * H; o.update(dry(clock.t));
  await o.synced();
  assert.equal(word(o, clock), "relayer");
});

await check("threshold off (0 or off) reads off however long our relayer is first", () => {
  const clock = { t: T0 };
  const o = mk(clock);
  o.update(dry(clock.t));
  clock.t = T0 + 72 * H; o.update(dry(clock.t));
  for (const v of ["0", "off"]) assert.equal(word(o, clock, { ROBINHOOD_RELAYER_FIRST_ALERT_HOURS: v }), "off", v);
});

await check("the public surface shows only the word; the operator view has the clock", async () => {
  const clock = { t: T0 };
  const o = mk(clock);
  o.update(dry(clock.t));
  clock.t = T0 + 7 * H;
  assert.deepEqual(o.status({ env: ENV, at: clock.t }), { status: "relayer" });
  const full = o.status({ full: true, env: ENV, at: clock.t });
  assert.equal(full.status, "relayer");
  assert.equal(full.alertHours, 6);
  assert.equal(full.since, new Date(T0).toISOString());
  assert.doesNotMatch(JSON.stringify(o.status({ env: ENV, at: clock.t })), /facilitator\.example|\d{4}-\d\d/);
  const { robinhoodSettlerStatus } = await import("../src/payments.js");
  assert.deepEqual(robinhoodSettlerStatus(), { status: "off" }, "no order (no relayer key, Robinhood not offered): off");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(/robinhoodSettler: \(\(\) => \{ try \{ return robinhoodSettlerStatus\(\{ full \}\); \}/.test(server), "gateway-status carries the word, full only for the operator");
});

await check("payments.js builds the order with the state-database store", () => {
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  assert.ok(/createRobinhoodOrder\(\{ host: hostOfUrl\(robinhoodPrimaryUrl\), store: await stateDbOrderStore\(ROBINHOOD_CAIP2\) \}\)/.test(src), "the order gets the store");
});

// --- paging: the heartbeat step run as written (stub curl and gh), and the Worker ---
const TITLE = "robinhoodSettler: our own relayer has been settling Robinhood sales for hours";
const wf = yamlLoad(readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
const dir = mkdtempSync(join(tmpdir(), "hb-rhsettler-"));
writeFileSync(join(dir, "curl"), "#!/usr/bin/env bash\ncat \"$GS_FILE\"\n");
writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo 41 && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "gh"), 0o755);
function hb(gateway, open = "") {
  const gs = join(dir, "gs.json"), log = join(dir, "gh.log");
  writeFileSync(gs, JSON.stringify(gateway)); writeFileSync(log, "");
  const r = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_FILE: gs, GH_LOG: log, OPEN_TITLE: open }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, "utf8").split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
}
const OK = { toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, buyerRefusals: { status: "ok" } };

await check("heartbeat: relayer opens one issue (word and operator endpoint only), an open one gets a comment, ok and off close it, unknown does neither", () => {
  assert.ok(step, "heartbeat.yml has the failure-words step");
  let calls = hb({ ...OK, robinhoodSettler: { status: "relayer" } });
  const made = calls.filter((c) => c[1] === "create");
  assert.equal(made.length, 1, JSON.stringify(calls));
  assert.equal(made[0][made[0].indexOf("--title") + 1], TITLE);
  const body = made[0][made[0].indexOf("--body") + 1];
  assert.match(body, /robinhoodSettler\.status=relayer\./);
  assert.match(body, /\/__operator\/tool-failures\.json/);
  assert.doesNotMatch(body, /facilitator\.example|0x[0-9a-f]{6}/i);
  calls = hb({ ...OK, robinhoodSettler: { status: "relayer" } }, TITLE);
  assert.equal(calls.filter((c) => c[1] === "create").length, 0);
  assert.ok(calls.some((c) => c[1] === "comment" && c[2] === "41"));
  for (const w of ["ok", "off"]) {
    calls = hb({ ...OK, robinhoodSettler: { status: w } }, TITLE);
    assert.equal(calls.filter((c) => c[1] === "close" && c[2] === "41").length, 1, w);
  }
  calls = hb({ ...OK, robinhoodSettler: { status: "unknown" } }, TITLE);
  assert.equal(calls.filter((c) => c[1] === "close" || c[1] === "create").length, 0);
  calls = hb(OK, TITLE);
  assert.equal(calls.filter((c) => c[1] === "close" || c[1] === "create").length, 0, "a missing word does neither");
});

await check("status Worker: the same title; relayer bad, ok and off good, anything else quiet; the body names the word only", async () => {
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const a = ALARMS.find((x) => x.title === TITLE);
  assert.ok(a, "the Worker carries the alarm");
  const j = (gw) => judge({ gateway: gw })[TITLE];
  assert.equal(j({ robinhoodSettler: { status: "relayer" } }), "bad");
  assert.equal(j({ robinhoodSettler: { status: "ok" } }), "good");
  assert.equal(j({ robinhoodSettler: { status: "off" } }), "good");
  for (const w of ["unknown", "<b>"]) assert.equal(j({ robinhoodSettler: { status: w } }), "quiet", w);
  assert.equal(j({}), "quiet");
  const body = a.body({ gateway: { robinhoodSettler: { status: "<b>" } } });
  assert.match(body, /robinhoodSettler\.status=relayer\./);
  assert.match(body, /ROBINHOOD_RELAYER_FIRST_ALERT_HOURS/);
  assert.doesNotMatch(body, /<b>/);
});

rmSync(dir, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall robinhoodSettler checks passed");
process.exit(0);
