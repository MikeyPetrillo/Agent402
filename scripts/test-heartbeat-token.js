// Unit tests for the heartbeat-token signer/verifier in src/pow.js.
//
// Before this fix the operator dashboard split traffic into USDC / PoW /
// Heartbeat by sniffing the User-Agent (any caller could spoof "agent402-
// heartbeat/x" and poison the internal rail). The token is HMAC(POW_SECRET,
// "heartbeat:" + minute) truncated to 32 base64url chars, with a ±5 minute
// skew window — so only callers that know POW_SECRET can mint a valid token,
// and replays from outside the window naturally expire.
//
// Offline, no server. We seed POW_SECRET before importing pow.js so the same
// secret is used for both sides of the HMAC.
process.env.POW_SECRET = "test-heartbeat-secret-do-not-use-in-prod";

const { issueHeartbeatToken, verifyHeartbeatToken } = await import("../src/pow.js");

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// 1. Token minted now verifies now.
{
  const now = Date.now();
  const t = issueHeartbeatToken(now);
  ok(typeof t === "string" && t.length === 32, `token shape (len=${t.length})`);
  ok(verifyHeartbeatToken(t, now), "fresh token verifies");
}

// 2. Skew tolerance: a token from 4 minutes ago still verifies.
{
  const now = Date.now();
  const t = issueHeartbeatToken(now - 4 * 60_000);
  ok(verifyHeartbeatToken(t, now), "4 min old token still in window");
}

// 3. Outside the skew window (6 min old) is rejected.
{
  const now = Date.now();
  const t = issueHeartbeatToken(now - 6 * 60_000);
  ok(!verifyHeartbeatToken(t, now), "6 min old token rejected");
}

// 4. Future skew also tolerated (clock drift could go either way).
{
  const now = Date.now();
  const t = issueHeartbeatToken(now + 4 * 60_000);
  ok(verifyHeartbeatToken(t, now), "4 min future token accepted");
}

// 5. Tampered token rejected.
{
  const now = Date.now();
  const t = issueHeartbeatToken(now);
  const tampered = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
  ok(!verifyHeartbeatToken(tampered, now), "tampered token rejected");
}

// 6. Empty / wrong-type input rejected without throwing.
{
  ok(!verifyHeartbeatToken("", Date.now()), "empty string rejected");
  ok(!verifyHeartbeatToken(undefined, Date.now()), "undefined rejected");
  ok(!verifyHeartbeatToken(null, Date.now()), "null rejected");
  ok(!verifyHeartbeatToken(12345, Date.now()), "number rejected");
}

// 7. Different secret -> different token (separation of trust domains).
{
  // We can't easily re-import pow.js with a different SECRET in the same
  // process (the module caches it), so we verify the negative case instead:
  // a hand-rolled HMAC with the WRONG secret must NOT verify.
  const { createHmac } = await import("node:crypto");
  const minute = Math.floor(Date.now() / 60_000);
  const wrong = createHmac("sha256", "not-the-real-secret").update("heartbeat:" + minute).digest("base64url").slice(0, 32);
  ok(!verifyHeartbeatToken(wrong, Date.now()), "token signed with wrong secret rejected");
}

console.log("test-heartbeat-token: 7 scenarios, all passed");
