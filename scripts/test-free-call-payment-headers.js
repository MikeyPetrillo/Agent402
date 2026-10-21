// A free call (proof-of-work or trial) skips x402 verification, so a payment
// header riding on it is unverified. Every free-accept branch must drop it
// before the handler, as the MPP and credits gates do, or payerFromRequest()
// reads its authorization.from as the payer: a forged header naming one of our
// wallets would move an outside call's outcome onto our own traffic's lane.
//
// Two halves:
//   - wiring: each branch in src/server.js that sets X-Pow-Accepted or
//     X-Trial-Accepted calls dropUnverifiedPaymentHeaders(req) before its
//     next(), and the helper removes both header spellings;
//   - live: a paid-mode server serves a valid proof-of-work call that also
//     carries a forged payment header naming our burner wallet (the drop
//     never breaks a free call).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { OUR_EVM_WALLETS } from "../src/revenue-live.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wiring
const src = readFileSync(join(ROOT, "src", "server.js"), "utf8");
const helper = /function dropUnverifiedPaymentHeaders\(req\) \{([\s\S]*?)\n\}/.exec(src);
ok(!!helper, "dropUnverifiedPaymentHeaders is defined");
ok(helper && ["payment-signature", "x-payment"].every((h) => helper[1].includes(`"${h}"`)), "the helper drops both payment header spellings");
const accepts = [...src.matchAll(/res\.setHeader\("X-(Pow|Trial)-Accepted", "true"\);/g)];
ok(accepts.length >= 3, `every free-accept branch found (got ${accepts.length})`);
for (const m of accepts) {
  const rest = src.slice(m.index);
  const nextAt = rest.search(/return next\(\);/);
  const line = src.slice(0, m.index).split("\n").length;
  ok(nextAt > 0 && rest.slice(0, nextAt).includes("dropUnverifiedPaymentHeaders(req);"), `X-${m[1]}-Accepted at server.js:${line} drops payment headers before next()`);
}

// ---- live
const [PORT] = await getFreePorts(1);
const BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network",
    X402_SYNC_ON_START: "false",
    X402_INDEX_CRAWL: "off",
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
    FREE_MODE: "",
  },
  stdio: "ignore",
});
function solve(challenge, difficulty) {
  for (let n = 0; n < 5_000_000; n++) {
    const h = createHash("sha256").update(challenge + ":" + n).digest();
    let bits = 0;
    for (const byte of h) { if (byte === 0) { bits += 8; continue; } bits += Math.clz32(byte) - 24; break; }
    if (bits >= difficulty) return n;
  }
  throw new Error("solver gave up");
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const ours = [...OUR_EVM_WALLETS][0];
  ok(typeof ours === "string" && ours.startsWith("0x"), "an own EVM wallet to forge");
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from: ours, to: "0x000000000000000000000000000000000000dEaD", value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } } })).toString("base64");
  const ch = await (await fetch(`${BASE}/api/pow/challenge?slug=hash`)).json();
  const nonce = solve(ch.challenge, ch.difficulty);
  const r = await fetch(`${BASE}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": `${ch.token}:${nonce}`, "X-Payment": forged, "Payment-Signature": forged },
    body: JSON.stringify({ text: "hello world" }),
  });
  ok(r.status === 200 && r.headers.get("x-pow-accepted") === "true", `proof-of-work call with a forged payment header is served (got ${r.status})`);
  const body = await r.json().catch(() => ({}));
  ok(typeof body.hex === "string" && body.hex.startsWith("b94d27b9"), "the answer is the tool's own");
} finally {
  proc.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
