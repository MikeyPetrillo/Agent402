// The hang-up forgiveness budget (src/hangup-forgiveness.js) holds ACROSS
// replicas on a REAL Redis: two processes, each its own module instance,
// reserve tickets at the same moment, and no budget grants more than it
// holds (the reservation is one script over every window the ticket is
// bounded by, not a read and separate adds):
//   - one payer, a different IP per replica: the payer budget bounds the sum;
//   - every ticket a fresh payer and IP: the service-wide budget bounds it;
//   - one payer, a price above the per-key budget: only the payer's first
//     hang-up is admitted, once across both replicas;
//   - control: released tickets free their room for the other replica.
// Requires REDIS_URL (under CI a missing one fails).
import { spawn } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-hangup-forgiveness-redis: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '') and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
const PRICE = 0.05, PER_PROC = 6;

if (process.argv[2] === "child") {
  const H = await import("../src/hangup-forgiveness.js");
  const at = Number(process.env.XC_AT) || 0;
  await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const mode = process.env.XC_MODE;
  const tickets = await Promise.all(Array.from({ length: PER_PROC }, (_, i) => {
    const req = {};
    const keys = mode === "payer"
      ? [process.env.XC_PAYER, `ip:${process.env.XC_IP}`]
      : [`0x${randomBytes(20).toString("hex")}`, `ip:10.${process.pid % 250}.${i}.${Math.floor(Math.random() * 250)}`];
    return Promise.resolve(H.reserveHangupForgiveness(req, { keys, priceUsd: Number(process.env.XC_PRICE) || PRICE, slug: "hash" })).then((t) => ({ t, req }));
  }));
  const granted = tickets.filter(({ t }) => t.granted).length;
  const reasons = [...new Set(tickets.filter(({ t }) => !t.granted).map(({ t }) => t.reason))];
  if (process.env.XC_RELEASE === "1") for (const { req } of tickets) H.settleHangupTicket(req, { abandoned: false });
  await new Promise((r) => setTimeout(r, 300));
  const { closeSharedRedis } = await import("../src/shared-limit.js");
  await closeSharedRedis();
  console.log(JSON.stringify({ granted, reasons }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const base = { HANGUP_FORGIVE_FILE: "off", STATE_DATABASE_URL: "", HANGUP_FORGIVE_SALT: `salt-${process.pid}` };
const replica = (env) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SELF, "child"], { env: { ...process.env, ...base, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`replica exited ${code}: ${out}`)); } });
});
const pair = (envA, envB) => { const at = String(Date.now() + 2500); return Promise.all([replica({ ...envA, XC_AT: at }), replica({ ...envB, XC_AT: at })]); };

// One payer, one IP per replica: the payer budget ($0.25 = 5 tickets) bounds the sum.
for (let i = 0; i < 3; i++) {
  const prefix = `hfr${process.pid}p${i}${Date.now().toString(36)}`;
  const payer = `0x${randomBytes(20).toString("hex")}`;
  const env = { SHARED_LIMITS_PREFIX: prefix, XC_MODE: "payer", XC_PAYER: payer, HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "100" };
  const [a, b] = await pair({ ...env, XC_IP: "10.1.0.1" }, { ...env, XC_IP: "10.1.0.2" });
  const total = a.granted + b.granted;
  ok(total === 5 && [...a.reasons, ...b.reasons].every((r) => r === "payer budget"), `payer race ${i + 1}: two replicas grant ${total} tickets of $${PRICE} for one payer (${a.granted}+${b.granted}), the payer budget's 5, refusals name the payer budget`);
}
// Fresh payer and IP per ticket: the service-wide budget ($0.30 = 6 tickets) bounds the sum.
for (let i = 0; i < 2; i++) {
  const env = { SHARED_LIMITS_PREFIX: `hfr${process.pid}g${i}${Date.now().toString(36)}`, XC_MODE: "fresh", HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "0.30" };
  const [a, b] = await pair(env, env);
  const total = a.granted + b.granted;
  ok(total === 6 && [...a.reasons, ...b.reasons].every((r) => r === "global budget"), `global race ${i + 1}: two replicas grant ${total} tickets in all (${a.granted}+${b.granted}), the service budget's 6`);
}
// One payer, $0.40 a ticket (over the $0.25 per-key budget): the first
// hang-up exemption admits exactly one ticket across both replicas.
for (let i = 0; i < 2; i++) {
  const env = { SHARED_LIMITS_PREFIX: `hfr${process.pid}f${i}${Date.now().toString(36)}`, XC_MODE: "payer", XC_PAYER: `0x${randomBytes(20).toString("hex")}`, XC_PRICE: "0.40", HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "100" };
  const [a, b] = await pair({ ...env, XC_IP: "10.3.0.1" }, { ...env, XC_IP: "10.3.0.2" });
  const total = a.granted + b.granted;
  ok(total === 1 && [...a.reasons, ...b.reasons].every((r) => r === "payer budget"), `first-hang-up race ${i + 1}: two replicas admit ${total} ticket above the per-key budget for one payer (${a.granted}+${b.granted}), refusals name the payer budget`);
}
// Control: tickets released (answered, not abandoned) free their room.
{
  const env = { SHARED_LIMITS_PREFIX: `hfr${process.pid}c${Date.now().toString(36)}`, XC_MODE: "payer", XC_PAYER: `0x${randomBytes(20).toString("hex")}`, XC_IP: "10.2.0.1", HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "100" };
  const a = await replica({ ...env, XC_RELEASE: "1" });
  const b = await replica(env);
  ok(a.granted === 5 && b.granted === 5, `released tickets free the payer's room for the other replica (${a.granted} then ${b.granted})`);
}

console.log(`\ntest-hangup-forgiveness-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
