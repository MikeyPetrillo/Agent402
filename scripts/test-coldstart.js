#!/usr/bin/env node
// A wallet-less agent must be able to reach its FIRST successful call using
// only what we publish.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-coldstart.js
//
// WHY: the proof-of-work challenge returns TWO strings — `challenge` (the
// 32-hex value you hash) and `token` (the signed value you send). Nothing in
// the docs said they were different fields, and submitting the one you just
// hashed produced a 402 byte-identical to never having paid. That is a silent
// failure on the only path that converts an agent with no wallet into a user,
// and it was found by following our own published instructions literally and
// failing.
//
// This drives the documented cold start end to end and, just as importantly,
// asserts that the WRONG field produces an error that says which field to use.
// A dead end that explains itself is the difference between a lost agent and a
// retry that works.
import { createHash } from "node:crypto";
import { getFreePort } from "./lib/free-port.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Boots its own PAID-mode server: under FREE_MODE every tool is served free, so
// no 402 and no proof-of-work challenge ever appears and this test would assert
// against a paywall that is not there. Same stub-facilitator pattern as
// scripts/test-trial.js - @x402/core refuses to BUILD a 402 for a scheme the
// facilitator does not advertise, and nothing is ever settled here.
const PORT = await getFreePort();
const FAC_PORT = PORT + 100;
const TARGET = `http://127.0.0.1:${PORT}`;
let log = "";
const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT), FREE_MODE: "", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    NODE_ENV: "test", X402_INDEX_CRAWL: "off",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    STATS_ALLOW_EPHEMERAL: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const done = (code) => {
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { facilitator.close(); } catch { /* */ }
  process.exit(code);
};
let up = false;
for (let i = 0; i < 240; i++) {
  try { if ((await fetch(`${TARGET}/health`)).ok) { up = true; break; } } catch { /* booting */ }
  await wait(250);
}
ok(up, `server booted on :${PORT}`);
if (!up) { console.error(log.slice(-2000) || "(no output)"); done(1); }

// 1. Resolve a task the way llms.txt tells an agent to.
const find = await (await fetch(`${TARGET}/api/find?q=${encodeURIComponent("hash a string with sha256")}`)).json();
const t = find.results?.[0];
ok(Boolean(t), `/api/find resolves a plain-language task (got ${t?.slug})`);
ok(Boolean(t?.route && t?.price), "the result carries a callable route and a price");
ok(Boolean(t?.example), "the result carries a ready-to-send example");

const [method, path] = String(t.route).split(" ");
const send = (headers = {}) => fetch(`${TARGET}${path}`, {
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(method === "POST" ? { body: JSON.stringify(t.example) } : {}),
});

// 2. Unpaid call must advertise the wallet-free route.
const unpaid = await send();
ok(unpaid.status === 402, `an unpaid call is refused with 402 (got ${unpaid.status})`);
const chUrl = unpaid.headers.get("x-pow-challenge");
ok(Boolean(chUrl), "the 402 names the proof-of-work challenge URL");

// 3. The challenge must SAY that hashing and submitting use different fields.
const ch = await (await fetch(chUrl)).json();
ok(typeof ch.challenge === "string" && typeof ch.token === "string", "challenge response carries both `challenge` and `token`");
ok(ch.challenge !== ch.token, "they are DIFFERENT values — the whole reason this test exists");
ok(/hash the `challenge`/i.test(ch.submitNote || "") && /submit the `token`/i.test(ch.submitNote || ""),
  "the challenge response states which field to hash and which to send");

// 4. Solve it exactly as documented.
const need = "0".repeat((ch.difficulty ?? 16) / 4);
let nonce = 0, digest;
for (;;) {
  digest = createHash("sha256").update(`${ch.challenge}:${nonce}`).digest("hex");
  if (digest.startsWith(need)) break;
  if (++nonce > 8_000_000) break;
}
ok(digest.startsWith(need), `solved the puzzle as documented (nonce=${nonce})`);

// 5. The NATURAL MISTAKE must explain itself rather than look like non-payment.
const wrong = await send({ "X-Pow-Solution": `${ch.challenge}:${nonce}` });
const wrongReason = wrong.headers.get("x-pow-error") || "";
ok(wrong.status === 402, "submitting the challenge instead of the token is refused");
ok(/send the 'token' field/i.test(wrongReason),
  `...and the refusal NAMES the fix rather than saying only "malformed" (got: ${wrongReason || "(none)"})`);

// 6. The documented path succeeds, with no wallet and no money.
const right = await send({ "X-Pow-Solution": `${ch.token}:${nonce}` });
ok(right.status === 200, `the documented cold start SUCCEEDS (got ${right.status})`);
const body = await right.json().catch(() => ({}));
ok(Boolean(body && Object.keys(body).length), "and returns a real result the agent can use");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
