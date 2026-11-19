#!/usr/bin/env node
// A wallet session signed out on one container is refused by the other, over
// a REAL Redis (src/wallet-sign-in.js, the shared flag `wsess-out`).
//
// Two real servers share one SIWE_SESSION_SECRET, one BASE_URL and one Redis,
// as two replicas do:
//   - CONTROL: a session minted on A reads the wallet's usage on A and on B;
//   - DELETE /api/wallet-session on A answers signedOut true;
//   - the same token is then refused (401) on B, which never saw the DELETE,
//     and on A;
//   - CONTROL: a second session, not signed out, still answers on B;
//   - a third server C, started after the sign-out (a restart), refuses the
//     signed-out token too: the record outlives the process that took it.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-wallet-sign-out-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import "./lib/own-stats.js"; // a stats store of its own (scripts/lib/own-stats.js); REDIS_URL stays as the lane sets it
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { bootServer } from "./lib/boot-server.js";

if (!process.env.REDIS_URL) {
  if (process.env.CI) { console.error("FAIL - REDIS_URL is not set under CI: this suite needs a real Redis"); process.exit(1); }
  console.log("skipped: set REDIS_URL=redis://127.0.0.1:<port> to run this suite against a local redis-server");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

const BASE = "https://agent402.example.test";
const env = {
  FREE_MODE: "true", BASE_URL: BASE, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", POSTHOG_API_KEY: "",
  SIWE_SESSION_SECRET: randomBytes(32).toString("hex"),
  REDIS_URL: process.env.REDIS_URL,
  // This run's keys only: another suite on the same Redis never reads them.
  SHARED_LIMITS_PREFIX: `wsout-${process.pid}-${randomBytes(4).toString("hex")}:`,
};
const alice = privateKeyToAccount(generatePrivateKey());
const signIn = async (base) => {
  const n = await (await fetch(`${base}/api/wallet-session/nonce`)).json();
  const message = createSiweMessage({ domain: n.domain, address: alice.address, statement: n.statement, uri: n.uri, version: "1", chainId: 8453, nonce: n.nonce, issuedAt: new Date() });
  const r = await fetch(`${base}/api/wallet-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature: await alice.signMessage({ message }) }) });
  return (await r.json()).token;
};
const usage = async (base, token) => {
  const r = await fetch(`${base}/api/my-usage`, { method: "POST", headers: { "content-type": "application/json", "x-wallet-session": token }, body: "{}" });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, wallet: b.wallet || null, error: b.error || null };
};

const [a, b] = await Promise.all([bootServer({ env, stores: "wallet-sign-out-a" }), bootServer({ env, stores: "wallet-sign-out-b" })]);
let c = null;
try {
  const mode = async (srv) => (await (await fetch(`${srv.url}/api/gateway-status`)).json())?.sharedLimits;
  console.log(`# shared limits word: A ${JSON.stringify(await mode(a))}, B ${JSON.stringify(await mode(b))}`);
  const token = await signIn(a.url);
  const keep = await signIn(a.url);
  const [ua, ub] = [await usage(a.url, token), await usage(b.url, token)];
  ok(typeof token === "string" && ua.status === 200 && ub.status === 200 && ub.wallet === alice.address.toLowerCase(), `CONTROL: a session minted on A answers on A and on B (${ua.status}, ${ub.status})`);
  const out = await fetch(`${a.url}/api/wallet-session`, { method: "DELETE", headers: { "x-wallet-session": token } });
  const ob = await out.json();
  ok(out.status === 200 && ob.signedOut === true, `the sign-out on A is acknowledged (${out.status} ${JSON.stringify(ob)})`);
  const afterB = await usage(b.url, token);
  ok(afterB.status === 401 && /signed_out/.test(afterB.error || ""), `B, which never saw the sign-out, refuses the token (${afterB.status} ${afterB.error})`);
  ok((await usage(a.url, token)).status === 401, "A refuses it too");
  const other = await usage(b.url, keep);
  ok(other.status === 200 && other.wallet === alice.address.toLowerCase(), `CONTROL: a session that was not signed out still answers on B (${other.status})`);
  const mem = await fetch(`${b.url}/api/memory?key=k1`, { headers: { "x-wallet-session": token } });
  ok(mem.status === 401, `the signed-out token reads no memory on B either (${mem.status})`);
  c = await bootServer({ env, stores: "wallet-sign-out-c" });
  const afterC = await usage(c.url, token);
  ok(afterC.status === 401 && (await usage(c.url, keep)).status === 200, `a server started after the sign-out refuses the token, and serves the live one (${afterC.status})`);
  const again = await fetch(`${b.url}/api/wallet-session`, { method: "DELETE", headers: { "x-wallet-session": token } });
  ok(again.status === 200 && (await again.json()).signedOut === true, "signing the same token out again, on another container, is the same answer");
} finally {
  await Promise.all([a, b, c].filter(Boolean).map((s) => s.stop().catch(() => {})));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
