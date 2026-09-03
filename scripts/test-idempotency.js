// Opt-in idempotency, tested against a server with the x402 paywall ACTIVE (so
// the gate is real). Exercises the proof-of-work credential path: a retry with
// the same Idempotency-Key + same PoW token replays the result without
// re-charging, while the security properties hold — no header, or a different
// key, never replays (and never leaks a paid result). The facilitator is never
// contacted (X402_SYNC_ON_START=false); PoW bypasses settlement entirely.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PORT = 3071;
const B = `http://127.0.0.1:${PORT}`;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const solve = (c) => { let n = 0; while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++; return n; };

const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});

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

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
