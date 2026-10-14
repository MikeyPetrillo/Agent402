// MPP nano/charge for the tollbooth - offline, mocked Nano node RPC.
// Run from the repo root (uses mppx from the root node_modules only to prove
// the challenge interoperates with the reference codec, as tempo.test.js does).
import express from "express";
import { createHash } from "node:crypto";
import { Challenge } from "mppx";
import { createTollbooth, nanoFromEnv, nanoConfig, mintNanoChallenge, parseNanoCredential, checkNanoBinding, nanoAddressToPublicKey, NANO_MAINNET } from "./index.js";
import { blake2b, NANO_SUFFIX_SPACE } from "./nano.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const SECRET = "tollbooth-nano-test-secret";
// Spec example recipient (draft-nano-charge-00) and the Nano genesis account.
const RECIPIENT = "nano_36kmuzhss55gmjo9gc4c134gykk16k44jxzqk5kh5r4917gybfh3f7enradc";
const RECIPIENT_KEY = "9253DFDF9C8C6E9C6A77284A0044EF4A40248428F7F790E4F1E047015DE4B5E1";
const OTHER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const PRICE_RAW = "1000000000000000000000000000"; // 0.001 XNO
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const listen = (app) => new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })); });

// ---- BLAKE2b + addresses ----
ok(blake2b(Buffer.from("abc"), 64).equals(createHash("blake2b512").update("abc").digest()) && blake2b(Buffer.alloc(300, 7), 64).equals(createHash("blake2b512").update(Buffer.alloc(300, 7)).digest()), "blake2b: 512-bit output matches node:crypto blake2b512 (1 and 3 blocks)");
ok(blake2b(Buffer.from("abc"), 32).toString("hex") === "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319", "blake2b: 256-bit 'abc' vector");
ok(nanoAddressToPublicKey(RECIPIENT) === RECIPIENT_KEY, "address: spec example decodes to the link key in its send block");
ok(nanoAddressToPublicKey(OTHER) === "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA", "address: genesis account decodes to its known public key");
ok(nanoAddressToPublicKey(RECIPIENT.replace(/^nano_/, "xrb_")) === RECIPIENT_KEY, "address: legacy xrb_ prefix names the same key");
ok(nanoAddressToPublicKey(RECIPIENT.slice(0, -1) + "d") === null && nanoAddressToPublicKey("nano_123") === null, "address: bad checksum and bad length refused");

// ---- config + env ----
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
ok(/checksum/.test(threw(() => nanoConfig({ recipient: RECIPIENT.slice(0, -1) + "d", priceRaw: PRICE_RAW, rpcUrl: "http://node.test" }))), "config: recipient with a bad checksum throws");
ok(/priceRaw/.test(threw(() => nanoConfig({ recipient: RECIPIENT, priceRaw: "0.001", rpcUrl: "http://node.test" }))), "config: priceRaw must be an integer raw amount");
ok(/rpcUrl/.test(threw(() => nanoConfig({ recipient: RECIPIENT, priceRaw: PRICE_RAW }))), "config: rpcUrl required (no default third-party node)");
ok(nanoFromEnv({}) === null, "env: no TOLLBOOTH_NANO_RECIPIENT -> off");
const envCfg = nanoFromEnv({ TOLLBOOTH_NANO_RECIPIENT: RECIPIENT, TOLLBOOTH_NANO_PRICE_RAW: PRICE_RAW, TOLLBOOTH_NANO_RPC_URL: "http://node.test" });
ok(envCfg.recipient === RECIPIENT && envCfg.priceRaw === PRICE_RAW && envCfg.rpcUrl === "http://node.test", "env: recipient, price, rpc parse");

// ---- minting ----
const cfg = nanoConfig({ recipient: RECIPIENT, priceRaw: PRICE_RAW, rpcUrl: "http://node.test" });
const www = mintNanoChallenge({ realm: "site.test", secretKey: SECRET, nano: cfg });
const parsed = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www }));
ok(parsed.length === 1 && parsed[0].method === "nano" && parsed[0].intent === "charge", "mint: mppx parses our challenge as nano/charge");
ok(Challenge.verify(parsed[0], { secretKey: SECRET }), "mint: mppx Challenge.verify agrees with our HMAC id binding");
const r0 = parsed[0].request;
const a0 = BigInt(r0.amount);
ok(r0.currency === "XNO" && r0.recipient === RECIPIENT && r0.methodDetails.network === NANO_MAINNET && r0.methodDetails.binding === "amount", `mint: request per draft-nano-charge-00 (${JSON.stringify(r0).slice(0, 140)})`);
ok(a0 > BigInt(PRICE_RAW) && a0 < BigInt(PRICE_RAW) + NANO_SUFFIX_SPACE, "mint: amount is price plus a suffix below 10^24 raw");
const r1 = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": mintNanoChallenge({ realm: "site.test", secretKey: SECRET, nano: cfg }) }))[0].request;
ok(r1.amount !== r0.amount, "mint: every challenge gets its own amount (the binding)");
ok(parseNanoCredential("Payment zzz") === null && parseNanoCredential(`Payment ${b64url(JSON.stringify({ challenge: { method: "tempo", intent: "charge" }, payload: { type: "hash", hash: "AB".repeat(32) } }))}`) === null, "parseNanoCredential: garbage and other methods are not nano");

// ---- gate end to end, mocked node ----
const blocks = new Map(); // HASH -> block_info answer
const rpc = { calls: [], down: false, status: 200 };
const fakeFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  rpc.calls.push({ url, body });
  if (rpc.down) throw new Error("connect ECONNREFUSED");
  const answer = blocks.get(String(body.hash).toUpperCase()) || { error: "Block not found" };
  return { ok: rpc.status < 400, status: rpc.status, json: async () => answer };
};
const block = (amount, over = {}) => ({
  block_account: OTHER, amount: String(amount), balance: "2499000000000000000000000000000", confirmed: "true", subtype: "send",
  contents: { type: "state", account: OTHER, link: RECIPIENT_KEY, link_as_account: RECIPIENT }, ...over,
});
let nextHash = 1;
const newHash = () => (nextHash++).toString(16).toUpperCase().padStart(64, "A");

const NANO = { recipient: RECIPIENT, priceRaw: PRICE_RAW, rpcUrl: "http://node.test/rpc", fetch: fakeFetch };
const claims = [];
const store = new Map();
const replayStore = { claim(k, exp) { claims.push(k); if (store.has(k)) return false; store.set(k, exp); return true; } };
const gate = createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", replayStore, nano: NANO });
const app = express();
app.use(gate);
app.get("/paid", (req, res) => res.json({ result: "ok" }));
const { server, url } = await listen(app);

const challenge = async () => {
  const r = await fetch(`${url}/paid`);
  const h = r.headers.get("www-authenticate") || "";
  const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": h }))[0];
  return { status: r.status, header: h, amount: BigInt(c.request.amount), ch: { id: c.id, realm: c.realm, method: "nano", intent: "charge", request: h.match(/request="([^"]+)"/)[1], expires: c.expires } };
};
const pay = (ch, hash, over = {}) => fetch(`${url}/paid`, { headers: { Authorization: `Payment ${b64url(JSON.stringify({ challenge: { ...ch, ...over }, payload: { type: "hash", hash } }))}` } });
const problemOf = async (r) => { const j = await r.json(); return j.problem || {}; };

const c1 = await challenge();
ok(c1.status === 402 && /method="nano"/.test(c1.header) && /realm="site.test"/.test(c1.header), "gate: unpaid -> 402 with a nano challenge, no x402 middleware needed");

const h1 = newHash();
blocks.set(h1, block(c1.amount));
let r = await pay(c1.ch, h1);
const receipt = JSON.parse(Buffer.from(r.headers.get("payment-receipt") || "", "base64url").toString("utf8") || "{}");
ok(r.status === 200 && (await r.json()).result === "ok" && r.headers.get("x-tollbooth-paid") === "mpp-nano", `gate: confirmed exact send to the recipient -> 200 (got ${r.status})`);
ok(receipt.method === "nano" && receipt.reference === h1 && receipt.status === "success", "gate: Payment-Receipt names the block hash");
ok(rpc.calls.at(-1).url === "http://node.test/rpc" && rpc.calls.at(-1).body.action === "block_info" && rpc.calls.at(-1).body.json_block === "true", "gate: asks the node with block_info");
ok(claims.at(-1) === `nano:${h1}` && gate.stats().nanoPaid === 1, "gate: hash claimed in the shared replayStore as nano:<HASH>, nanoPaid counted");

r = await pay(c1.ch, h1);
ok(r.status === 402 && (await problemOf(r)).type.endsWith("invalid-challenge"), "replay: same credential again -> 402 invalid-challenge");
r = await pay(c1.ch, h1.toLowerCase());
ok(r.status === 402 && (await problemOf(r)).type.endsWith("invalid-challenge"), "replay: same hash in lowercase -> still refused (canonical key)");
const c2 = await challenge();
r = await pay(c2.ch, h1);
ok(r.status === 402 && r.headers.get("x-tollbooth-error") !== null, "replay: old block against a fresh challenge -> 402 (amount differs)");

const under = newHash(); blocks.set(under, block(c2.amount - 1n));
r = await pay(c2.ch, under);
ok(r.status === 402 && (await problemOf(r)).type.endsWith("payment-insufficient"), "underpaid by 1 raw -> 402 payment-insufficient");
const over = newHash(); blocks.set(over, block(c2.amount + 1n));
r = await pay(c2.ch, over);
ok(r.status === 402 && (await problemOf(r)).type.endsWith("verification-failed"), "amount binding: overpaid -> 402 (only the exact amount answers a challenge)");
const recv = newHash(); blocks.set(recv, block(c2.amount, { subtype: "receive" }));
r = await pay(c2.ch, recv);
ok(r.status === 402 && /not a send/.test((await problemOf(r)).detail), "receive block -> 402 verification-failed");
const wrong = newHash(); blocks.set(wrong, block(c2.amount, { contents: { type: "state", link: "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA", link_as_account: OTHER } }));
r = await pay(c2.ch, wrong);
ok(r.status === 402 && /recipient/.test((await problemOf(r)).detail), "send to another account -> 402 verification-failed");

const pending = newHash(); blocks.set(pending, block(c2.amount, { confirmed: "false" }));
r = await pay(c2.ch, pending);
ok(r.status === 402 && /not confirmed/.test((await problemOf(r)).detail) && r.headers.get("retry-after") === "1", "unconfirmed -> 402 verification-failed with Retry-After");
ok(!store.has(`nano:${pending}`), "unconfirmed: hash NOT consumed");
blocks.set(pending, block(c2.amount));
r = await pay(c2.ch, pending);
ok(r.status === 200, "unconfirmed then confirmed: the same credential now pays");

const c3 = await challenge();
let before = rpc.calls.length;
r = await pay(c3.ch, "XYZ");
ok(r.status === 402 && (await problemOf(r)).type.endsWith("malformed-credential") && rpc.calls.length === before, "malformed hash -> 402 malformed-credential, node never asked");
r = await pay(c3.ch, newHash(), { id: "x".repeat(43) });
ok(r.status === 402 && /HMAC/.test((await problemOf(r)).detail) && rpc.calls.length === before, "HMAC: tampered id -> 402 invalid-challenge, node never asked");
const cheap = b64url(JSON.stringify({ ...JSON.parse(Buffer.from(c3.ch.request, "base64url").toString()), amount: "1" }));
r = await pay(c3.ch, newHash(), { request: cheap });
ok(r.status === 402 && /HMAC/.test((await problemOf(r)).detail) && rpc.calls.length === before, "HMAC: request rewritten to 1 raw -> 402 invalid-challenge");
r = await pay(c3.ch, newHash(), { expires: new Date(Date.now() - 1000).toISOString() });
ok(r.status === 402 && (await problemOf(r)).type.endsWith("invalid-challenge"), "expired (or re-dated) challenge -> 402 invalid-challenge");

const fresh = newHash(); blocks.set(fresh, block(c3.amount));
rpc.down = true;
r = await pay(c3.ch, fresh);
ok(r.status === 402 && /unreachable/.test((await problemOf(r)).detail) && !store.has(`nano:${fresh}`), "RPC down -> 402 verification-failed, hash not consumed");
rpc.down = false; rpc.status = 500;
r = await pay(c3.ch, fresh);
ok(r.status === 402 && /HTTP 500/.test((await problemOf(r)).detail), "RPC 500 -> 402 verification-failed");
rpc.status = 200;
r = await pay(c3.ch, newHash());
ok(r.status === 402 && /not found/.test((await problemOf(r)).detail), "unknown block -> 402 verification-failed");
r = await pay(c3.ch, fresh);
ok(r.status === 200, "node back: same credential pays");

ok(checkNanoBinding(parseNanoCredential(`Payment ${b64url(JSON.stringify({ challenge: c3.ch, payload: { type: "hash", hash: fresh } }))}`), { secretKey: SECRET, realm: "other.test", nano: cfg }).ok === false, "binding: realm must be ours");
server.close();

// ---- Nano unset: the 402 is what it was before this rail existed ----
{
  const plain = express();
  plain.use(createTollbooth({ price: "$0.001", mode: "all", pow: false }));
  plain.get("/", (req, res) => res.send("hi"));
  const s = await listen(plain);
  const res = await fetch(`${s.url}/`);
  const text = await res.text();
  ok(res.status === 402 && res.headers.get("www-authenticate") === null && res.headers.get("retry-after") === null, "unset: 402 carries no Payment challenge");
  ok(text === JSON.stringify({ error: "Payment Required", message: "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.", accepts: [] }), `unset: 402 body byte-identical to the gate without nano (${text.length} bytes)`);
  const res2 = await fetch(`${s.url}/`, { headers: { Authorization: `Payment ${b64url(JSON.stringify({ challenge: c3.ch, payload: { type: "hash", hash: fresh } }))}` } });
  ok(res2.status === 402 && res2.headers.get("x-tollbooth-error") === null && (await res2.text()) === text, "unset: a nano credential is ignored, same 402");
  s.server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
