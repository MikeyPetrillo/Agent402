#!/usr/bin/env node
// Offline test for src/wallet-digest.js: proof rules (a wallet must SIGN the
// exact message, a credits key must be live), double opt-in, the weekly
// digest's content and cadence, quiet weeks, unsubscribe dropping the
// address, the credits pre-enrol link, caps and counts-only stats.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";
import { createWalletDigest, digestProofMessage, DIGEST_PERIOD_MS, MAX_PER_EMAIL, PROOF_MAX_AGE_MS } from "../src/wallet-digest.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throws = async (p, code, m) => { try { await p; ok(false, `${m} (no throw)`); } catch (e) { ok(e?.statusCode === code, `${m} -> ${e?.statusCode} ${String(e?.message).slice(0, 60)}`); } };

const dir = mkdtempSync(join(tmpdir(), "wd-"));
let clock = Date.parse("2026-09-03T00:00:00Z");
const sent = [];
const usageByPayer = {};
const keys = { a402_livekey: "k1abc" };
const balances = { k1abc: 12.5 };
const engine = createWalletDigest({
  storePath: join(dir, "digest.json"), secret: "test-secret", baseUrl: "https://t.example", now: () => clock, log: () => {},
  sendEmail: async (m) => { sent.push(m); return true; },
  usage: (payer, { days }) => usageByPayer[payer] || { totals: { calls: 0, paidUsd: 0 }, bySlug: [], byNetwork: {} },
  creditsBalance: (keyId) => balances[keyId] ?? null,
  creditsKeyId: (key) => keys[key] || null,
  verifySignature: ({ address, message, signature }) => verifyMessage({ address, message, signature }),
});
const acct = privateKeyToAccount(generatePrivateKey());
const wallet = acct.address;
const email = "Buyer@Example.com";

// ---- wallet proof rules
await throws(engine.signup({ email, wallet, message: "hello", signature: "0x00" }), 400, "a message that is not the digest proof is refused");
{
  const ts = clock;
  const msg = digestProofMessage({ address: wallet, email, ts });
  const sig = await acct.signMessage({ message: msg });
  const other = privateKeyToAccount(generatePrivateKey());
  const badSig = await other.signMessage({ message: msg });
  await throws(engine.signup({ email, wallet, message: msg, signature: badSig }), 403, "a signature from ANOTHER wallet is refused");
  const stale = digestProofMessage({ address: wallet, email, ts: clock - PROOF_MAX_AGE_MS - 1000 });
  await throws(engine.signup({ email, wallet, message: stale, signature: await acct.signMessage({ message: stale }) }), 400, "an expired proof is refused");
  await throws(engine.signup({ email: "other@example.com", wallet, message: msg, signature: sig }), 400, "the proof binds the email: a different address cannot ride the same signature");
  const r = await engine.signup({ email, wallet, message: msg, signature: sig });
  ok(r.ok && r.status === "pending" && sent.length === 1 && /Confirm/.test(sent[0].subject) && sent[0].to === "buyer@example.com", "a valid wallet signature creates a PENDING record and sends the confirmation (address normalised)");
  const again = await engine.signup({ email, wallet, message: msg, signature: sig });
  ok(again.status === "pending" && sent.length === 1, "a repeat inside 10 minutes re-sends nothing (no confirmation flood)");
}
// ---- credits proof
await throws(engine.signup({ email, creditsKey: "a402_unknown" }), 403, "an unknown credits key is refused");
const c = await engine.signup({ email: "cards@example.com", creditsKey: "a402_livekey" });
ok(c.ok && c.status === "pending" && sent.length === 2, "presenting a live credits key enrols its id (pending, confirmation sent)");
// ---- confirm
const store = engine._store();
const recW = Object.values(store.subs).find((s) => s.kind === "wallet");
const recC = Object.values(store.subs).find((s) => s.kind === "credits");
ok(recW.payer === wallet.toLowerCase() && recC.payer === "credits:k1abc", "wallet payer is lower-cased (the ledger's EVM form); credits payer is credits:<id>");
ok(engine.confirm(recW.id, "nope").ok === false, "a bad confirm token is refused");
ok(engine.confirm(recW.id, engine.sign(recW.id, "confirm")).ok === true && recW.status === "active", "the signed confirm link activates the wallet digest");
ok(engine.confirm(recC.id, engine.sign(recC.id, "confirm")).ok === true, "and the credits one");
// ---- first digest: sent even when quiet? No: quiet first week sends "no calls yet" once (sends=0) -> content check
usageByPayer[wallet.toLowerCase()] = { totals: { calls: 12, paidUsd: 0.1234 }, bySlug: [{ slug: "search", calls: 8, usd: 0.08 }, { slug: "hash", calls: 4, usd: 0.0434 }], byNetwork: { "eip155:8453": { calls: 12, usd: 0.1234 } } };
usageByPayer["k1abc"] = { totals: { calls: 3, paidUsd: 0.75 }, bySlug: [{ slug: "research", calls: 1, usd: 0.6 }, { slug: "search", calls: 2, usd: 0.15 }], byNetwork: {} };
sent.length = 0;
let t = await engine.tick();
ok(t.due === 2 && t.sent === 2, `first tick sends both digests (${JSON.stringify(t)})`);
const w = sent.find((m) => m.to === "buyer@example.com"), k = sent.find((m) => m.to === "cards@example.com");
ok(/12 calls, \$0\.1234/.test(w.subject) && /search: 8 calls, \$0\.08/.test(w.text) && /eip155:8453: 12 calls/.test(w.text), `wallet digest carries calls, dollars, top tools and chains (${w.subject})`);
ok(/Credits balance: \$12\.50/.test(k.text) && /\/credits/.test(k.text) && /research: 1 call, \$0\.60/.test(k.text), "credits digest carries the balance and a top-up link");
ok(/List-Unsubscribe/.test(Object.keys(w.headers || {}).join()) && /\/digest\/unsubscribe\?id=/.test(w.text), "every digest carries the signed unsubscribe link and the List-Unsubscribe header");
ok(!/a402_livekey|k1abc/.test(w.text + k.text), "no key material in any email");
// ---- cadence
t = await engine.tick();
ok(t.due === 0, "nothing is due again inside the week");
clock += DIGEST_PERIOD_MS + 1000;
usageByPayer[wallet.toLowerCase()] = { totals: { calls: 0, paidUsd: 0 }, bySlug: [], byNetwork: {} };
sent.length = 0;
t = await engine.tick();
ok(t.due === 2 && t.sent === 1 && t.quiet === 1 && sent.every((m) => m.to !== "buyer@example.com"), "a quiet week after the first digest sends nothing to that subscriber (the credits key had calls and got its digest)");
ok(Date.parse(new Date(recW.lastSentAt).toISOString()) === clock, "a quiet week still advances the clock (no catch-up flood later)");
// ---- unsubscribe
ok(engine.unsubscribe(recW.id, "bad").ok === false, "a bad unsubscribe token is refused");
ok(engine.unsubscribe(recW.id, engine.sign(recW.id, "unsubscribe")).ok === true && recW.email === null && recW.status === "unsubscribed", "unsubscribe drops the address");
clock += DIGEST_PERIOD_MS + 1000; sent.length = 0;
usageByPayer[wallet.toLowerCase()] = { totals: { calls: 5, paidUsd: 0.05 }, bySlug: [{ slug: "hash", calls: 5, usd: 0.05 }], byNetwork: {} };
await engine.tick();
ok(sent.every((m) => m.to !== "buyer@example.com"), "an unsubscribed record is never emailed again");
// ---- credits pre-enrol link (claim email)
const link = engine.preEnrolCredits({ keyId: "k2def", email: "new@example.com" });
ok(typeof link === "string" && /\/digest\/confirm\?id=dg_/.test(link) && /&k=/.test(link), `a new key's claim email gets a signed confirm link (${link.slice(0, 50)}...)`);
const recN = Object.values(store.subs).find((s) => s.payer === "credits:k2def");
ok(recN?.status === "pending" && engine.confirm(recN.id, new URL(link).searchParams.get("k")).ok === true, "clicking that link is the consent: the record goes active");
ok(engine.preEnrolCredits({ keyId: "k2def", email: "new@example.com" }) === null, "an active key+address pair gets no second link");
// ---- caps + stats
for (let i = 0; i < MAX_PER_EMAIL; i++) engine.preEnrolCredits({ keyId: `cap${i}`, email: "many@example.com" });
await throws(engine.signup({ email: "many@example.com", creditsKey: "a402_livekey" }), 400, `the per-address cap (${MAX_PER_EMAIL}) holds`);
const st = engine.stats();
// Counts only: no "@" (an email) and no payer id anywhere in the operator JSON.
const statsJson = JSON.stringify(st);
ok(typeof st.active === "number" && st.digestsSent >= 3 && !/@/.test(statsJson) && !statsJson.includes(wallet.toLowerCase()) && !statsJson.includes("k1abc"), "stats are counts only: no addresses, no payers");
// ---- disabled without a secret
const off = createWalletDigest({ storePath: join(dir, "off.json"), secret: "", sendEmail: async () => true, usage: () => ({}), verifySignature: async () => true, log: () => {} });
ok(off.enabled() === false && off.preEnrolCredits({ keyId: "x", email: "a@b.co" }) === null, "no secret: signup disabled and no link is ever minted (links must be unforgeable)");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
