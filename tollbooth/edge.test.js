// Offline test for the edge gate (Web Crypto + Fetch globals; Node 20+).
import { createEdgeTollbooth, createEdgePow, memorySink } from "./edge.js";
import worker from "./worker.js";
import { CLIENT_TRUST_HEADERS, HOP_BY_HOP_HEADERS } from "./strip-headers.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const lz = (bytes) => { let n = 0; for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const solve = async (chal, diff) => { let n = 0; while (lz(await sha(`${chal}:${n}`)) < diff) n++; return n; };

// verifyX402 is required for this build to ADVERTISE a usdc quote: it used to
// emit one whenever payTo was set, with no code path able to accept a payment,
// so a crawler that paid was 402d forever. This gate offers both rails, so it
// supplies a verifier; the withheld-quote case is asserted in features.test.js.
const gate = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 16, payTo: "0x000000000000000000000000000000000000dEaD", verifyX402: async () => false });
const req = (ua, extra = {}) => new Request("https://site.test/article", { headers: { "user-agent": ua, ...extra } });
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

// 1. Human allowed (gate returns null).
let res = await gate(req(HUMAN));
if (res !== null) fail("human should be allowed (null)");
console.log("1. human -> allow (null) ✓");

// 2. Bot charged 402 with both rails.
res = await gate(req(BOT));
if (!res || res.status !== 402) fail(`bot should be charged 402, got ${res && res.status}`);
const q = await res.json();
if (!q.proofOfWork?.challenge) fail("402 must include a proof-of-work challenge");
if (!q.accepts?.[0]?.payTo) fail("402 must include an x402 quote");
console.log("2. bot -> 402 with PoW challenge + x402 quote ✓");

// 3. Solve the PoW -> allowed.
const nonce = await solve(q.proofOfWork.challenge, q.proofOfWork.difficulty);
const solution = `${q.proofOfWork.token}:${nonce}`;
res = await gate(req(BOT, { "x-pow-solution": solution }));
if (res !== null) fail("valid PoW should be allowed (null)");
console.log("3. bot solves proof-of-work -> allow ✓");

// 4. Replay rejected (single-use).
res = await gate(req(BOT, { "x-pow-solution": solution }));
if (res === null) fail("replayed PoW solution must not be accepted");
console.log(`4. replayed solution -> ${res.status} (single-use) ✓`);

// 5. Resource-bound: a /article token must not unlock /other.
const gate2 = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 16 });
res = await gate2(new Request("https://site.test/other", { headers: { "user-agent": BOT, "x-pow-solution": solution } }));
if (res === null) fail("PoW token bound to /article must not work on /other");
console.log(`5. cross-resource reuse -> ${res.status} (resource-bound) ✓`);

// 6. REGRESSION (bug 1.1): dotted paths + query strings must work on the edge.
for (const path of ["/blog/post.html", "/a?v=1.2.3", "/feed.xml?since=2024.01"]) {
  let rr = await gate(new Request(`https://site.test${path}`, { headers: { "user-agent": BOT } }));
  if (!rr || rr.status !== 402) fail(`edge dotted path ${path} should 402`);
  const qq = await rr.json();
  const nn = await solve(qq.proofOfWork.challenge, qq.proofOfWork.difficulty);
  rr = await gate(new Request(`https://site.test${path}`, { headers: { "user-agent": BOT, "x-pow-solution": `${qq.proofOfWork.token}:${nn}` } }));
  if (rr !== null) fail(`edge dotted path ${path} should unlock with valid PoW, got ${rr && rr.status}`);
}
console.log("6. edge: dotted paths + query strings unlock correctly ✓");

// 7. Stats counter exists on the edge gate (regression: didn't before 0.3.0).
const counted = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 12 });
await counted(req(HUMAN));
await counted(req(BOT));
const s = counted.stats();
if (s.requests !== 2 || s.freeAllowed !== 1 || s.charged !== 1) fail(`edge stats wrong: ${JSON.stringify(s)}`);
console.log("7. edge gate exposes .stats() counters ✓");

// 8. Observe mode: never returns a 402; bumps wouldCharge.
const obs = createEdgeTollbooth({ secret: "test-secret", observe: true, powDifficulty: 12 });
const oRes = await obs(req(BOT));
if (oRes !== null) fail(`observe must never 402, got ${oRes && oRes.status}`);
const oStats = obs.stats();
if (oStats.wouldCharge !== 1 || oStats.observe !== true) fail(`observe stats wrong: ${JSON.stringify(oStats)}`);
console.log("8. edge observe mode: bot lets through, wouldCharge counted ✓");

// 9. Pluggable statsSink: snapshot() returns the sink's view (durable path).
const externalSink = memorySink();
const piped = createEdgeTollbooth({ secret: "test-secret", powDifficulty: 12, statsSink: externalSink });
await piped(req(HUMAN));
await piped(req(BOT));
const durable = await piped.snapshot();
if (durable.requests !== 2 || durable.charged !== 1) fail(`edge durable snapshot wrong: ${JSON.stringify(durable)}`);
// flush() is a no-op for memorySink but must resolve.
await piped.flush();
console.log("9. edge statsSink: snapshot() reads from sink, flush() resolves ✓");

console.log("\nedge tollbooth: all assertions passed ✓");

// ---- MPP on the edge (edge-mpp.js): Web Crypto HMAC, same verifier ------------
{
  const { mintEdgeChallenge, translateEdgeCredential, toBaseUnits, edgeChainId } = await import("./edge-mpp.js");
  if (toBaseUnits("$0.001") !== "1000" || toBaseUnits("0.25") !== "250000" || toBaseUnits("$0.0000001") !== null || toBaseUnits("abc") !== null) fail("toBaseUnits");
  if (edgeChainId("base") !== 8453 || edgeChainId("eip155:42220") !== 42220 || edgeChainId("solana") !== null) fail("edgeChainId");
  const seen = [];
  const mppGate = createEdgeTollbooth({
    secret: "test-secret", powDifficulty: 16, payTo: "0x000000000000000000000000000000000000dEaD",
    verifyX402: async (r, reqs) => { seen.push({ sig: r.headers.get("payment-signature"), auth: r.headers.get("authorization"), reqs }); return true; },
  });
  // 1. the 402 carries ONE evm/charge challenge for the quote
  const r402 = await mppGate(req(BOT));
  const www = r402.headers.get("www-authenticate") || "";
  if (!/^Payment id="[^"]+", realm="site\.test", method="evm", intent="charge", request="[^"]+", expires="[^"]+", opaque="[^"]+"$/.test(www)) fail(`402 must carry one Payment challenge, got: ${www.slice(0, 120)}`);
  const param = (k) => (www.match(new RegExp(`${k}="((?:[^"\\\\]|\\\\.)*)"`)) || [])[1];
  const decode = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0))));
  const request = decode(param("request"));
  if (request.amount !== "1000" || request.currency !== "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" || request.recipient !== "0x000000000000000000000000000000000000dEaD" || request.methodDetails.chainId !== 8453) fail(`challenge request wrong: ${JSON.stringify(request)}`);
  const opaque = decode(param("opaque"));
  const accepted = JSON.parse(opaque.x402);
  if (accepted.network !== "eip155:8453" || accepted.amount !== "1000" || accepted.extra.name !== "USD Coin" || opaque.resource !== "https://site.test/article") fail(`opaque binding wrong: ${JSON.stringify(opaque)}`);
  if (!(await r402.json()).accepts?.[0]?.payTo) fail("the x402 accepts block still rides beside the MPP challenge");
  console.log("11. edge 402 carries one HMAC-bound MPP evm/charge challenge for the quote ✓");
  // 2. a credential built from that challenge reaches verifyX402 as PAYMENT-SIGNATURE
  const challenge = { id: param("id"), realm: param("realm"), method: "evm", intent: "charge", request: param("request"), expires: param("expires"), opaque: param("opaque") };
  const payload = { type: "authorization", from: "0x" + "11".repeat(20), to: "0x000000000000000000000000000000000000dEaD", value: "1000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "22".repeat(32), signature: "0x" + "33".repeat(65) };
  const cred = (c, p) => "Payment " + btoa(JSON.stringify({ challenge: c, payload: p })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const paid = await mppGate(req(BOT, { authorization: cred(challenge, payload) }));
  if (paid !== null || seen.length !== 1) fail("valid MPP credential must be verified and allowed");
  if (seen[0].auth !== null || !seen[0].sig) fail("verifier must see PAYMENT-SIGNATURE and no Authorization");
  const sig = JSON.parse(atob(seen[0].sig));
  if (sig.x402Version !== 2 || sig.accepted.amount !== "1000" || sig.payload.authorization.nonce !== payload.nonce || sig.payload.signature !== payload.signature) fail(`translated payload wrong: ${JSON.stringify(sig).slice(0, 200)}`);
  if (seen[0].reqs.resource !== "https://site.test/article" || seen[0].reqs.accepted?.network !== "eip155:8453") fail("verifier requirements must carry the resource and the accept");
  if (mppGate.stats().mppPaid !== 1) fail("mppPaid counted");
  console.log("12. MPP credential -> PAYMENT-SIGNATURE -> the same verifyX402 -> allow ✓");
  // 3. tampered / foreign / wrong-resource / expired credentials never reach the verifier
  const tampered = await mppGate(req(BOT, { authorization: cred({ ...challenge, request: challenge.request.slice(0, -2) + "AA" }, payload) }));
  if (tampered === null || seen.length !== 1) fail("tampered challenge must be refused before the verifier");
  const other = await mppGate(new Request("https://site.test/other", { headers: { "user-agent": BOT, authorization: cred(challenge, payload) } }));
  if (other === null || seen.length !== 1) fail("a credential minted for /article must not pay for /other");
  const badPayload = await mppGate(req(BOT, { authorization: cred(challenge, { ...payload, nonce: "0x12" }) }));
  if (badPayload === null || seen.length !== 1) fail("a malformed payload never reaches the verifier");
  const expiredMint = await mintEdgeChallenge({ secret: "test-secret", realm: "site.test", price: "$0.001", network: "base", payTo: payload.to, resource: "https://site.test/article", ttlSeconds: -1 });
  const expiredParam = (k) => (expiredMint.header.match(new RegExp(`${k}="((?:[^"\\\\]|\\\\.)*)"`)) || [])[1];
  const expired = await translateEdgeCredential(cred({ id: expiredParam("id"), realm: "site.test", method: "evm", intent: "charge", request: expiredParam("request"), expires: expiredParam("expires"), opaque: expiredParam("opaque") }, payload), { secret: "test-secret" });
  if (expired !== null) fail("an expired challenge is refused");
  const wrongSecret = await translateEdgeCredential(cred(challenge, payload), { secret: "other-secret" });
  if (wrongSecret !== null) fail("another operator's secret does not verify our id");
  console.log("13. tampered, foreign-resource, malformed, expired and wrong-secret MPP credentials are refused ✓");
  // 4. no MPP without the pieces that make the quote real
  const noVerifier = createEdgeTollbooth({ secret: "s", payTo: payload.to, verifyX402: null });
  if ((await noVerifier(req(BOT))).headers.get("www-authenticate")) fail("no verifier -> no MPP challenge (a price we cannot take)");
  const off = createEdgeTollbooth({ secret: "s", payTo: payload.to, verifyX402: async () => true, mpp: false });
  if ((await off(req(BOT))).headers.get("www-authenticate")) fail("mpp:false -> no challenge");
  const usdg = createEdgeTollbooth({ secret: "s", payTo: payload.to, verifyX402: async () => true, network: "eip155:4663", asset: "USDG" });
  if ((await usdg(req(BOT))).headers.get("www-authenticate")) fail("a token the table does not know mints nothing (never a guessed address)");
  const custom = createEdgeTollbooth({ secret: "s", payTo: payload.to, verifyX402: async () => true, network: "eip155:4663", asset: "USDG", mppAssetAddress: "0x" + "ab".repeat(20), mppAssetName: "USDG" });
  if (!(await custom(req(BOT))).headers.get("www-authenticate")) fail("an explicit token address mints a challenge");
  console.log("14. MPP is withheld without verifier/secret, when mpp:false, or for an unknown token (unless named) ✓");
}

// 15. A solution is held to the CONFIGURED difficulty, not only the one its token claims.
{
  const low = createEdgePow({ secret: "shared-secret", difficulty: 4 });
  const high = createEdgePow({ secret: "shared-secret", difficulty: 12 });
  const c = await low.challenge("https://site.test/article");
  // a nonce that meets 4 bits but not 12, so the policy check is what refuses
  let guess = 0;
  for (;;) { const bits = lz(await sha(`${c.challenge}:${guess}`)); if (bits >= 4 && bits < 12) break; guess++; }
  const v = await high.verify(`${c.token}:${guess}`, "https://site.test/article");
  if (v.ok || v.reason !== "difficulty below policy") fail(`a token minted at 4 bits must not pass a 12-bit gate (got ${JSON.stringify(v)})`);
  const same = await low.verify(`${c.token}:${guess}`, "https://site.test/article");
  if (!same.ok) fail(`control: the same solution passes the 4-bit gate that minted it (got ${JSON.stringify(same)})`);
  console.log("15. claimed difficulty below the configured difficulty is refused (control passes) ✓");
}

// 16. Worker: the public placeholder secret is refused; client-IP headers are stripped.
{
  const base = { TOLLBOOTH_UPSTREAM: "https://origin.test", TOLLBOOTH_OBSERVE: "true" };
  const r1 = await worker.fetch(new Request("https://site.test/a", { headers: { "user-agent": HUMAN } }), { ...base, TOLLBOOTH_SECRET: "change-me-to-a-long-random-string" }, null);
  if (r1.status !== 500 || !/placeholder/.test(await r1.text())) fail("worker must refuse the change-me placeholder secret");
  const r1b = await worker.fetch(new Request("https://site.test/a", { headers: { "user-agent": HUMAN } }), { ...base, TOLLBOOTH_SECRET: "Change-Me-please" }, null);
  if (r1b.status !== 500) fail("worker refuses any change-me prefix, case-insensitive, like the CLI");
  const origFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (url, init) => { forwarded = { url, headers: new Headers(init.headers) }; return new Response("origin ok"); };
  try {
    const spoof = Object.fromEntries(CLIENT_TRUST_HEADERS.map((h) => [h, "1.2.3.4"]));
    const r2 = await worker.fetch(new Request("https://site.test/a", { headers: { "user-agent": HUMAN, ...spoof, "x-keep": "yes" } }), { ...base, TOLLBOOTH_SECRET: "a-real-secret-for-tests" }, null);
    if (r2.status !== 200 || !forwarded) fail(`control: a real secret proxies to the origin (got ${r2.status})`);
    const leaked = CLIENT_TRUST_HEADERS.filter((h) => forwarded.headers.get(h) === "1.2.3.4");
    if (leaked.length) fail(`worker forwarded client-set trust headers: ${leaked.join(", ")}`);
    if (forwarded.headers.get("x-keep") !== "yes") fail("worker keeps ordinary headers");
    if (!new URL(forwarded.url).hostname.endsWith("origin.test")) fail("worker proxies to the configured upstream");
  } finally { globalThis.fetch = origFetch; }
  for (const h of ["x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fastly-client-ip", "x-forwarded-proto", "x-forwarded-port", "via", "forwarded", "x-forwarded-host"]) {
    if (!CLIENT_TRUST_HEADERS.includes(h)) fail(`shared strip list lost ${h}`);
  }
  if (HOP_BY_HOP_HEADERS.some((h) => CLIENT_TRUST_HEADERS.includes(h))) fail("hop-by-hop and trust lists overlap");
  console.log("16. worker refuses the placeholder secret and strips the shared client-trust header list ✓");
}
