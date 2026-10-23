// Opt-in idempotency, tested against a server with the x402 paywall ACTIVE (so
// the gate is real). Exercises the proof-of-work credential path: a retry with
// the same Idempotency-Key + same PoW token replays the result without
// re-charging, while the security properties hold — no header, or a different
// key, never replays (and never leaks a paid result). PoW bypasses settlement
// entirely. The paid path then runs against a stub facilitator (verify says
// valid for a well-formed authorization, settle succeeds once per nonce):
// a re-sent signed payment with no key is answered from its first answer with
// no second settle and no second sale, a different input or route under the
// same nonce is not, an explicit key still wins, a replay past the store's
// window is not served, and a route with a lasting effect never replays.
import "./lib/file-mode.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const OP_TOKEN = "idempotency-test-operator-token-0123456789";
const IDEM_TTL_MS = 4000; // shortened so the past-window case can be run
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog.slice(-20)) console.error("  server:", l); proc.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const solve = (c) => { let n = 0; while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++; return n; };

// The stub facilitator: /verify accepts a well-formed EIP-3009 authorization,
// /settle succeeds once per nonce and refuses a nonce it already settled (the
// chain's single-use rule), counting every call so the test can tell a served
// replay (no settle) from a re-run (a settle).
let verifies = 0, settles = 0;
const settledNonces = new Set();
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* ignore */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    const wellFormed = !!auth && /^0x[0-9a-f]{64}$/i.test(String(auth.nonce || "")) && /^0x[0-9a-fA-F]{40}$/.test(String(auth.from || ""));
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply(200, wellFormed ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" }); }
    if (req.url === "/settle") {
      settles++;
      const nonce = String(auth?.nonce || "").toLowerCase();
      if (!wellFormed) return reply(200, { success: false, errorReason: "malformed authorization", transaction: "", network: "eip155:8453", payer });
      if (settledNonces.has(nonce)) return reply(200, { success: false, errorReason: "nonce already used", transaction: "", network: "eip155:8453", payer });
      settledNonces.add(nonce);
      return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(nonce).digest("hex"), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    SALES_LEDGER_DB: join(mkdtempSync(join(tmpdir(), "idem-sales-")), "sales.db"),
    AGENT402_OPERATOR_TOKEN: OP_TOKEN, IDEM_TTL_MS: String(IDEM_TTL_MS),
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 300)); } if (serverLog.length > 60) serverLog.splice(0, serverLog.length - 60); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/api/pow`)).ok) break; } catch {} await sleep(500); }

  const powFor = async () => { const c = await (await fetch(`${B}/api/pow/challenge?slug=hash`)).json(); return `${c.token}:${solve(c)}`; };
  const hash = (sol, idem) => fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": sol, ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: JSON.stringify({ text: "hello world" }),
  });
  let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

  // 1. First paid+keyed call succeeds.
  const sol1 = await powFor();
  let r = await hash(sol1, "key-1");
  ok(r.status === 200 && (await r.json()).hex.slice(0, 8) === "b94d27b9", "first PoW call with Idempotency-Key -> 200");

  // 2. Retry with the SAME key + SAME (now-used) token replays instead of "already used".
  r = await hash(sol1, "key-1");
  ok(r.status === 200 && r.headers.get("x-idempotent-replay") === "true", "retry (same key + credential) replays without re-charging");

  // 2b. Same key + credential on a DIFFERENT route must NOT replay this result
  // (the cache key is bound to the route). Reusing the hash PoW token elsewhere
  // also fails the gate, so this can never leak the hash result to another path.
  const other = await fetch(`${B}/api/base64`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": sol1, "Idempotency-Key": "key-1" },
    body: JSON.stringify({ text: "x", mode: "encode" }),
  });
  const otherBody = await other.text();
  ok(other.headers.get("x-idempotent-replay") !== "true" && !otherBody.includes("b94d27b9"), `same key+credential on a different route does not replay (got ${other.status})`);

  // 3. Replaying the used token WITHOUT a key keeps normal behavior: rejected.
  r = await hash(sol1, null);
  ok(r.status !== 200, `used token without Idempotency-Key is rejected (got ${r.status})`);

  // 4. Used token + a DIFFERENT key: cache miss, no replay, no leak.
  r = await hash(sol1, "key-DIFFERENT");
  ok(r.status !== 200, `used token + different key does not replay (got ${r.status})`);

  // 4b. CROSS-BODY (invariant: the cache key binds method+path+credential+body).
  // Same Idempotency-Key but a DIFFERENT body must NEVER return the first body's
  // cached paid result — a changed body hashes to a different key, so it's a
  // cache MISS that re-enters the gate and can only reflect the NEW body's
  // outcome. This is the core anti-replay property for mutated payloads.
  const bodyHash = (sol, idem, body) => fetch(`${B}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pow-Solution": sol, ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: JSON.stringify(body),
  });
  const solA = await powFor();
  const rA = await bodyHash(solA, "xbody", { text: "cross-body-A" });
  const jA = await rA.json().catch(() => ({}));
  ok(rA.status === 200 && !!jA.hex, `cross-body setup: body A paid+keyed -> 200 (got ${rA.status})`);
  // Same key, same (now-spent) credential, DIFFERENT body -> different cache key
  // -> miss -> gate re-runs (token already used) -> non-200, never body A's hex.
  const rBspent = await bodyHash(solA, "xbody", { text: "cross-body-B-different" });
  const bBspent = await rBspent.text();
  ok(rBspent.headers.get("x-idempotent-replay") !== "true" && !bBspent.includes(jA.hex),
    `same key + different body does NOT replay body A's result (got ${rBspent.status})`);
  // Fresh credential + same key + body B -> a genuine new charge yields body B's
  // OWN result (different hash), never a replay of body A.
  const solB = await powFor();
  const rBfresh = await bodyHash(solB, "xbody", { text: "cross-body-B-different" });
  const jBfresh = await rBfresh.json().catch(() => ({}));
  ok(rBfresh.status === 200 && !!jBfresh.hex && jBfresh.hex !== jA.hex && rBfresh.headers.get("x-idempotent-replay") !== "true",
    `same key + different body + fresh credential -> body B's own fresh result, not a replay of A (got ${rBfresh.status})`);

  // 4c. STREAMED routes are NEVER idempotency-replayable. The idem cache hook
  // wraps res.json ONLY; a streaming gateway tier returns the __sse sentinel and
  // the route binder (src/server.js) writes SSE straight to the socket without
  // ever calling res.json — so a streamed 200 can never be stored, and no repeat
  // can be served X-Idempotent-Replay. We supply an X-Pow-Solution so the idem
  // middleware is actually engaged for the route (cred is non-null), yet the
  // streamed response is still never cached. A live 200 SSE needs
  // OPENROUTER_API_KEY (the paid canary's llm-stream leg covers that in prod);
  // here we assert the cache is never engaged for a streamed route across two
  // identical keyed requests.
  const streamReq = () => fetch(`${B}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "stream-key", "X-Pow-Solution": "irrelevant:0" },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const s1 = await streamReq();
  await s1.text().catch(() => "");
  const s2 = await streamReq();
  await s2.text().catch(() => "");
  ok(s1.status !== 200 && s2.status !== 200 &&
    s1.headers.get("x-idempotent-replay") !== "true" && s2.headers.get("x-idempotent-replay") !== "true",
    `streamed route is never served from the idempotency cache (got ${s1.status}/${s2.status})`);

  // 5. Idempotency-Key but NO credential on an unproven call: gate still applies
  // (the paywall returns 402 with egress; 5xx here where the facilitator host is
  // unreachable — either way it never returns a result or a replay).
  r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "key-x" }, body: JSON.stringify({ text: "hi" }) });
  ok(r.status !== 200 && r.headers.get("x-idempotent-replay") !== "true", `Idempotency-Key without payment/PoW does not get through or replay (got ${r.status})`);

  // 6. Free-tier discoverability: a bare 402 for a PoW-ELIGIBLE tool must carry
  // the altPayment hint (protocol=proof-of-work + a slug-scoped challengeUrl) so
  // unfunded agents learn the compute path at the moment of rejection; a
  // wallet-only tool's 402 must NOT advertise it.
  r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  if (r.status === 402) {
    const body = await r.json().catch(() => ({}));
    ok(body.altPayment?.protocol === "proof-of-work" && String(body.altPayment?.challengeUrl || "").includes("slug=hash"), "402 for a PoW-eligible tool advertises the free proof-of-work path");
    const w = await fetch(`${B}/api/stock-quote?symbol=AAPL`);
    const wb = w.status === 402 ? await w.json().catch(() => ({})) : {};
    ok(!wb.altPayment, `wallet-only tool's 402 does not advertise PoW (got ${w.status})`);
  } else {
    // Facilitator host unreachable in this sandbox → the paywall 5xxes before
    // building a challenge; the hint can't be exercised here. Skip honestly.
    console.log(`skip - altPayment hint (paywall returned ${r.status}, no 402 body to inspect)`);
  }

  // 7. SECURITY REGRESSION: the cache key must bind to the credential the
  // paywall would actually settle from (payment-signature, per @x402/express's
  // own precedence — node_modules/@x402/express), never to x-payment when both
  // are present. Proven with externally observable behavior, not by trusting
  // that the shared helper exists: seed a cache entry via valid PoW while ALSO
  // attaching two divergent payment-shaped headers, then replay with the SAME
  // x-payment value but a DIFFERENT payment-signature value and no usable PoW
  // of its own. If the cache key were still derived from x-payment (the
  // pre-fix behavior), this would replay the first result for free; bound to
  // payment-signature (the fix), it's a cache miss with nothing left to admit it.
  const solSec = await powFor();
  const seed = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pow-Solution": solSec,
      "Idempotency-Key": "sec-key",
      "X-Payment": "unchanged-attacker-chosen-value",
      "Payment-Signature": "seed-signature-value",
    },
    body: JSON.stringify({ text: "sec-probe" }),
  });
  const seedBody = await seed.json().catch(() => ({}));
  ok(seed.status === 200 && !!seedBody.hex, `security regression setup: PoW-admitted call with divergent payment headers seeds the cache (got ${seed.status})`);

  const replaySameXPayment = await fetch(`${B}/api/hash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "sec-key",
      "X-Payment": "unchanged-attacker-chosen-value", // SAME as seed
      "Payment-Signature": "different-signature-value", // CHANGED from seed
      // No X-Pow-Solution: this request has no admission path of its own.
    },
    body: JSON.stringify({ text: "sec-probe" }),
  });
  ok(replaySameXPayment.status !== 200 && replaySameXPayment.headers.get("x-idempotent-replay") !== "true",
    `same x-payment + different payment-signature does NOT replay (cache key binds to payment-signature, got ${replaySameXPayment.status})`);

  // 8. A RE-SENT PAYMENT IS SERVED FROM ITS FIRST ANSWER (2026-10-23). A buyer's
  // client re-sent a request with the same signed authorization a few seconds
  // after the first copy; the first settled and was served, the second ran the
  // handler and reverted at settle (nonce used), so the buyer read a 402 for a
  // paid call. With no explicit key the payment's identity (network, signed
  // payer, nonce) is the key: the copy is answered from the store, marked, with
  // no verify, no settle and no second sale.
  const PAYER = "0x00000000000000000000000000000000000000a1";
  const TOOL = "/api/demand-radar?limit=1"; // wallet-only, answers from local state
  let nonceN = 0;
  const freshNonce = () => "0x" + (++nonceN).toString(16).padStart(64, "0");
  const acceptFor = async (path, method = "GET", body) => {
    const r = await fetch(`${B}${path}`, { method, headers: { "content-type": "application/json" }, body });
    ok(r.status === 402, `unpaid ${method} ${path} -> 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    const accept = (req402.accepts || []).find((a) => a.network === "eip155:8453");
    ok(!!accept, `${path} offers exact on Base`);
    return accept;
  };
  const credential = (accept, nonce) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce } },
  })).toString("base64");
  const pay = (path, cred, { method = "GET", body, headers = {} } = {}) => fetch(`${B}${path}`, { method, headers: { "content-type": "application/json", "payment-signature": cred, ...headers }, body });
  const replayed = (r) => r.headers.get("x-replayed-answer") === "1";
  const opJson = async (path) => (await fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).json();

  const accept = await acceptFor(TOOL);
  const nonce1 = freshNonce();
  const cred1 = credential(accept, nonce1);
  // a. The first copy: verified, served, settled.
  const first = await pay(TOOL, cred1);
  const firstBody = await first.text();
  ok(first.status === 200 && settles === 1 && verifies === 1 && !replayed(first) && first.headers.get("x-idempotent-replay") !== "true",
    `paid call with a fresh nonce: verified, served, settled once (status ${first.status}, verifies ${verifies}, settles ${settles})`);
  // b. The same request again (same header bytes): the stored answer, marked,
  // with no verify and no settle.
  const copy = await pay(TOOL, cred1);
  const copyBody = await copy.text();
  ok(copy.status === 200 && replayed(copy) && copy.headers.get("x-idempotent-replay") === "true" && copyBody === firstBody && settles === 1 && verifies === 1,
    `the re-sent payment is answered from the first answer with X-Replayed-Answer: 1, no verify, no settle (status ${copy.status}, verifies ${verifies}, settles ${settles})`);
  ok(/no-store/.test(copy.headers.get("cache-control") || ""), "the replayed answer is still no-store");
  // c. The same nonce with a DIFFERENT input, and on a DIFFERENT route: not a
  // replay. Each takes the normal path, where the used nonce is refused before
  // or at settlement; neither carries the marker or the first answer.
  const otherInput = await pay("/api/demand-radar?limit=2", cred1);
  const otherInputBody = await otherInput.text();
  ok(otherInput.status !== 200 && !replayed(otherInput) && otherInputBody !== firstBody,
    `the same nonce with a different input is not a replay (got ${otherInput.status})`);
  const otherRoute = await pay("/api/hash", cred1, { method: "POST", body: JSON.stringify({ text: "hello world" }) });
  const otherRouteBody = await otherRoute.text();
  ok(otherRoute.status !== 200 && !replayed(otherRoute) && !otherRouteBody.includes("b94d27b9"),
    `the same nonce on a different route is not a replay and serves nothing (got ${otherRoute.status})`);
  ok(settles === 1, `neither mutated copy settled (settles ${settles})`);
  // d. An explicit key wins: the entry is bound to it, so the same nonce
  // re-sent WITHOUT the key is not a replay, and re-sent WITH it is an
  // Idempotency-Key replay (no implicit marker).
  const nonce2 = freshNonce();
  const cred2 = credential(accept, nonce2);
  const keyed = await pay(TOOL, cred2, { headers: { "Idempotency-Key": "k-with-nonce" } });
  ok(keyed.status === 200 && settles === 2, `a keyed paid call settles (status ${keyed.status}, settles ${settles})`);
  const keyedAgain = await pay(TOOL, cred2, { headers: { "Idempotency-Key": "k-with-nonce" } });
  ok(keyedAgain.status === 200 && keyedAgain.headers.get("x-idempotent-replay") === "true" && !replayed(keyedAgain) && settles === 2,
    `the same key + payment replays as an Idempotency-Key replay, not an implicit one (status ${keyedAgain.status})`);
  const unkeyedAgain = await pay(TOOL, cred2);
  ok(unkeyedAgain.status !== 200 && !replayed(unkeyedAgain) && settles === 2,
    `the same payment without its key is not served from the keyed entry (got ${unkeyedAgain.status}, settles ${settles})`);
  // e. A route whose effect outlives the answer never replays implicitly: the
  // memory writer settles, and its re-sent copy takes the normal path.
  const memAccept = await acceptFor("/api/memory", "POST", JSON.stringify({ key: "idem/test", value: { n: 1 } }));
  const cred3 = credential(memAccept, freshNonce());
  const memBody = JSON.stringify({ key: "idem/test", value: { n: 1 } });
  const mem = await pay("/api/memory", cred3, { method: "POST", body: memBody });
  ok(mem.status === 200 && settles === 3, `memory-write (lasting effect) settles (status ${mem.status}, settles ${settles})`);
  const memCopy = await pay("/api/memory", cred3, { method: "POST", body: memBody });
  ok(memCopy.status !== 200 && !replayed(memCopy), `its re-sent copy is not served from the store (got ${memCopy.status})`);
  // f. Past the store's window the first payment is no longer replayed.
  await sleep(IDEM_TTL_MS + 600);
  const late = await pay(TOOL, cred1);
  ok(late.status !== 200 && !replayed(late) && settles === 3, `a copy re-sent after the window is not served from the store (got ${late.status}, settles ${settles})`);
  // g. The sale is booked once per settled payment: three settles, three usdc
  // sales (the PoW calls above are usage rows on their own rail), none for
  // the replays.
  let sales = -1;
  for (let i = 0; i < 30 && sales !== settles; i++) { sales = (await opJson("/__operator/sales.json")).totals?.byRail?.["external:usdc"] ?? 0; if (sales !== settles) await sleep(100); }
  ok(sales === 3, `the sales ledger holds one usdc sale per settled payment and none for a replay (sales ${sales}, settles ${settles})`);
  // h. Replays are counted per slug on the operator detail: one implicit, one keyed.
  const tf = await opJson("/__operator/tool-failures.json");
  const row = (tf.replays || []).find((r) => r.slug === "demand-radar");
  ok(row && row.hour.implicit === 1 && row.hour.keyed === 1 && tf.replayTotals?.hour?.implicit === 1,
    `the operator detail counts the replays by slug (${JSON.stringify(row)})`);
  ok(!JSON.stringify(tf.replays).toLowerCase().includes(PAYER.slice(2, 12)), "and names no payer");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
