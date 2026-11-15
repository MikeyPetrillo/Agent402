#!/usr/bin/env node
// A challenge must outlive the run it pays for (src/challenge-life.js), and
// the settle breaker keys an address by its IPv6 /64.
//
// Booted PAID server (scripts/lib/paid-wires-rig.js) with the card gate on:
// the model upstream, the card token read and the card processor are local
// stubs (the preload sends the card client's requests to the rig and refuses,
// loudly, any other connection that is not loopback; the rig fails the suite
// if the server tried one). The stub declines a capture unless told
// otherwise, so a card run that reaches the handler ends 402 (not captured)
// after one upstream call and one capture attempt.
//   - Card: a challenge with a few seconds left is refused BEFORE the handler
//     (402, a fresh challenge, no upstream call, nothing charged); the same
//     credential shape with a full life reaches the handler (control).
//   - Tempo pull: the same rule; a challenge with a full life settles.
//   - MPP evm: the shim settles by the authorization's own validBefore, so a
//     challenge that expires during the run still settles (the rule is not
//     needed there, and is not applied).
//   - The breaker: card runs from one address use up its count; another
//     address in the same IPv6 /64 is refused with it, and an address in
//     another /64 is served.
// And the decision itself, offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";
import { challengeLifeShortfall, CAPTURE_ALLOWANCE_SECONDS, routeRunSeconds } from "../src/challenge-life.js";
import { STRIPE_DEFAULT_RUN_SECONDS } from "../src/mpp-stripe.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

// ---- the decision, offline ----
{
  const now = 1_000_000;
  const at = (s) => now + s * 1000;
  await ok(challengeLifeShortfall({ expiresAtMs: at(CAPTURE_ALLOWANCE_SECONDS), nowMs: now }) === null, "a route with no run bound needs the capture allowance, and exactly that passes");
  await ok(challengeLifeShortfall({ expiresAtMs: at(CAPTURE_ALLOWANCE_SECONDS - 1), nowMs: now })?.requiredSeconds === CAPTURE_ALLOWANCE_SECONDS, "one second under the allowance is short");
  await ok(challengeLifeShortfall({ expiresAtMs: at(29), defaultRunSeconds: 20, nowMs: now })?.remainingSeconds === 29 && challengeLifeShortfall({ expiresAtMs: at(30), defaultRunSeconds: 20, nowMs: now }) === null, "a gate's default run seconds are added for a route with none of its own");
  await ok(challengeLifeShortfall({ expiresAtMs: at(100), runSeconds: 180, defaultRunSeconds: 20, nowMs: now })?.requiredSeconds === 190 && challengeLifeShortfall({ expiresAtMs: at(190), runSeconds: 180, nowMs: now }) === null, "a route's own run bound replaces the default");
  await ok(challengeLifeShortfall({ expiresAtMs: NaN, nowMs: now }) === null, "an expiry that does not parse is left to the expiry check");
  await ok(routeRunSeconds("v1-videos") === 240 && routeRunSeconds("sql-guard") === 0 && routeRunSeconds("toString") === 0, "a route's run seconds are the measured table's, 0 for a route with none");
}

// ---- the preload refuses, loudly, a connection that is not loopback ----
{
  const run = (code, env = {}) => spawnSync(process.execPath, ["--import", "./scripts/lib/paid-wires-preload.js", "--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url), env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });
  const viaHttps = run(`import https from "node:https"; const r = https.request({ host: "api.third-party.invalid", port: 443, path: "/v1/x", method: "POST" }); r.on("error", (e) => { console.log("ERR " + e.code); }); r.end();`);
  await ok(/\[paid-wires-preload\] BLOCKED outbound connection to api\.third-party\.invalid/.test(viaHttps.stderr) && /ERR ECONNREFUSED/.test(viaHttps.stdout), `the preload refuses an https request to a host that is not loopback and says so (${viaHttps.stderr.trim().slice(0, 90)})`);
  const viaNet = run(`import net from "node:net"; const s = net.connect(443, "203.0.113.9"); s.on("error", (e) => { console.log("ERR " + e.code); });`);
  await ok(/BLOCKED outbound connection to 203\.0\.113\.9/.test(viaNet.stderr) && /ERR ECONNREFUSED/.test(viaNet.stdout), "a raw socket to an address that is not loopback is refused the same way");
  const local = run(`import http from "node:http"; const srv = http.createServer((q, s) => { s.end("local " + q.url); }); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const body = await new Promise((r) => http.get({ host: "127.0.0.1", port: srv.address().port, path: "/x" }, (res) => { let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => r(b)); })); console.log(body); srv.close();`);
  await ok(local.status === 0 && /local \/x/.test(local.stdout) && !/BLOCKED/.test(local.stderr), "a loopback connection is left alone");
}

const SK = "sk_test_challenge_life_never_used", PROFILE = "profile_test_challenge_life";
const CHAT = { method: "POST", path: "/v1/premium/chat/completions", body: { messages: [{ role: "user", content: "say ok" }], max_tokens: 16 } };
const SQL = { method: "POST", path: "/api/sql-guard", body: { sql: "select 1" } };
const MAX = 3;
rig = await bootPaidWires({ label: "challenge-life", env: {
  STRIPE_SECRET_KEY: SK, STRIPE_PROFILE_ID: PROFILE, STRIPE_WEBHOOK_SECRET: "", STRIPE_TOKEN_STUB: "on",
  GATEWAY_SETTLE_BREAKER_MAX: String(MAX), GATEWAY_SETTLE_BREAKER_UNKNOWN_MAX: String(MAX), GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", TRUST_PROXY_HOPS: "1",
} });
const { Challenge, Credential } = rig;
try {
  const o = await rig.offerOf(CHAT);
  const seen = o.challenges.find((c) => c.method === "stripe");
  await ok(!!seen && Date.parse(seen.expires) - Date.now() > 200_000, `the route offers a card challenge with minutes of life (${seen ? Math.round((Date.parse(seen.expires) - Date.now()) / 1000) : "none"} s)`);
  const cardSecret = createHmac("sha256", SK).update("mpp-challenge-signing").digest("base64");
  let n = 0;
  const card = (ttlSeconds, ip) => ({
    Authorization: Credential.serialize({ challenge: Challenge.from({ ...seen, id: undefined, expires: new Date(Date.now() + ttlSeconds * 1000 + (n++)), secretKey: cardSecret }), payload: { type: "spt", spt: `spt_test_token_${n}` } }),
    ...(ip ? { "X-Forwarded-For": ip } : {}),
  });
  const need = STRIPE_DEFAULT_RUN_SECONDS + CAPTURE_ALLOWANCE_SECONDS;

  // Card, a challenge about to expire: refused before the handler.
  rig.st.llmDelayMs = 3000;
  for (const ttl of [3, need - 3]) {
    const c0 = rig.st.completions, t0 = Date.now();
    const r = await rig.send(CHAT, card(ttl, "198.51.100.7"));
    await ok(r.status === 402 && rig.st.completions === c0 && Date.now() - t0 < 2500, `card: a challenge with ${ttl} s left is refused before the handler (${r.status}, upstream calls +${rig.st.completions - c0}, ${Date.now() - t0} ms)`);
    await ok(/expires in about \d+ s/.test(r.text) && /Nothing ran and nothing was charged/.test(r.text) && /fresh challenge/.test(r.text), `card: the refusal says the challenge expires before the run can finish, that nothing ran or was charged, and to take a fresh challenge (${r.text.slice(0, 140).replace(/\s+/g, " ")}...)`);
    await ok(/method="stripe"/.test(r.headers.get("www-authenticate") || ""), "card: the refusal carries a fresh card challenge");
  }
  // Card, a challenge with its full life: the handler runs (control).
  {
    const c0 = rig.st.completions, k0 = rig.st.captures;
    const r = await rig.send(CHAT, card(280, "198.51.100.8"));
    await ok(rig.st.completions === c0 + 1 && rig.st.captures === k0 + 1 && r.status === 402 && /did not capture/.test(r.text), `card: a challenge with its full life reaches the handler, and one capture is attempted after it at the local stub, which declines (${r.status}, upstream calls +${rig.st.completions - c0}, captures +${rig.st.captures - k0})`);
    rig.st.stripeCapture = "ok";
    const paid = await rig.send(CHAT, card(280, "198.51.100.10"));
    rig.st.stripeCapture = "decline";
    await ok(paid.status === 200 && rig.st.captures === k0 + 2 && !!paid.headers.get("payment-receipt"), `card: a capture the stub accepts is a served call with a receipt (${paid.status})`);
    const k1 = rig.st.captures;
    await rig.send(CHAT, card(3, "198.51.100.11"));
    await ok(rig.st.captures === k1, "card: a challenge refused for its remaining life attempts no capture");
  }
  // Card, a challenge that would expire mid-run on a handler that reads its
  // window: the model call is cut off before the expiry, uncharged.
  {
    rig.st.llmDelayMs = 30_000;
    const c0 = rig.st.completions, t0 = Date.now();
    const r = await rig.send(CHAT, card(need + 6, "198.51.100.9"));
    const took = Date.now() - t0;
    rig.st.llmDelayMs = 0;
    await ok(r.status === 504 && rig.st.completions === c0 + 1 && took < (need + 6 - CAPTURE_ALLOWANCE_SECONDS) * 1000, `card: a model call still running when the capture must begin is cut off (${r.status} after ${took} ms)`);
  }
  rig.st.llmDelayMs = 0;

  // Tempo pull: the same rule.
  {
    const w = await rig.wallet("tempo");
    const c0 = rig.st.completions, v0 = rig.st.verifies;
    const r = await rig.pay(w, CHAT, { ttlMs: 4000 });
    await ok(r.status === 402 && rig.st.completions === c0 && rig.outcomesOf(w).attempts === 0, `Tempo pull: a challenge with 4 s left is refused before the handler (${r.status}, upstream calls +${rig.st.completions - c0})`);
    await ok(/expires in about \d+ s/.test(r.text) && /Nothing ran and nothing was charged/.test(r.text) && rig.st.verifies === v0, `Tempo pull: the refusal says why, and the relay was not asked (${r.text.slice(0, 120).replace(/\s+/g, " ")}...)`);
    const good = await rig.pay(w, CHAT);
    await ok(good.status === 200 && rig.outcomesOf(w).settled === 1, `Tempo pull: a challenge with its full life is served and settled (${good.status})`);
    const edge = await rig.pay(w, SQL, { ttlMs: (CAPTURE_ALLOWANCE_SECONDS + 3) * 1000 });
    await ok(edge.status === 200 && rig.outcomesOf(w).settled === 2, `Tempo pull: a challenge just past the allowance is served and settled on a fast run (${edge.status})`);
    const short = await rig.pay(w, SQL, { ttlMs: (CAPTURE_ALLOWANCE_SECONDS - 3) * 1000 });
    await ok(short.status === 402 && rig.outcomesOf(w).attempts === 2, `Tempo pull: one just under it is refused before the handler (${short.status})`);
  }
  // Tempo pull: the moment the broadcast must begin is the run's window, so a
  // model call still running then is cut off instead of being served unpaid.
  {
    const w = await rig.wallet("tempo");
    rig.st.llmDelayMs = 30_000;
    const c0 = rig.st.completions, t0 = Date.now();
    const r = await rig.pay(w, CHAT, { ttlMs: 22_000 });
    const took = Date.now() - t0;
    rig.st.llmDelayMs = 0;
    await ok(r.status === 504 && rig.st.completions === c0 + 1 && took < 12_000 && rig.outcomesOf(w).attempts === 0, `Tempo pull: a model call still running when the broadcast must begin is cut off, unsettled (${r.status} after ${took} ms)`);
  }
  // MPP evm: the challenge's expiry is not read at settlement.
  {
    const w = await rig.wallet("mpp-evm");
    rig.st.llmDelayMs = 2500;
    const r = await rig.pay(w, CHAT, { ttlMs: 1500 });
    rig.st.llmDelayMs = 0;
    await ok(r.status === 200 && rig.outcomesOf(w).settled === 1, `MPP evm: a challenge that expires during the run still settles by the authorization's own window (${r.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
  }

  // The breaker's address key is the IPv6 /64.
  {
    const A1 = "2001:db8:9:9::1", A2 = "2001:db8:9:9::2", B1 = "2001:db8:9:a::1";
    for (let i = 1; i <= MAX; i++) {
      const c0 = rig.st.completions;
      const r = await rig.send(CHAT, card(280, A1));
      await ok(r.status === 402 && rig.st.completions === c0 + 1, `address 1, card run ${i}: served and not captured (${r.status})`);
    }
    await sleep(100);
    let c0 = rig.st.completions;
    let r = await rig.send(CHAT, card(280, A1));
    await ok(r.status === 429 && rig.st.completions === c0, `address 1 is refused at its count, before the handler (${r.status})`);
    c0 = rig.st.completions;
    r = await rig.send(CHAT, card(280, A2));
    await ok(r.status === 429 && rig.st.completions === c0, `another address in the same /64 is refused with it, before the handler (${r.status}, upstream calls +${rig.st.completions - c0})`);
    c0 = rig.st.completions;
    r = await rig.send(CHAT, card(280, B1));
    await ok(r.status === 402 && rig.st.completions === c0 + 1, `an address in another /64 is served (${r.status}, upstream calls +${rig.st.completions - c0})`);
    const w = await rig.wallet("evm");
    r = await rig.send(SQL, { ...(await rig.credentialFor(w, SQL)), "X-Forwarded-For": A2 });
    await ok(r.status === 200, `a wallet paying from the refused /64 is served: the address key is used only when no payer is known (${r.status})`);
  }
} finally { await rig.stop(); }
console.log(`\n${pass} checks passed`);
