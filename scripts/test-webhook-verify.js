// Exact-scheme tests for webhook-verify (util-kit): per-provider known-good
// vectors computed with node:crypto, tampered/wrong-secret rejections,
// raw-body string enforcement, stripe/slack replay tolerance, and the
// secret-never-echoed invariant. Pure functions, no server needed.
import { createHmac } from "node:crypto";
import { UTIL_TOOLS } from "../src/tools/util-kit.js";

const tool = UTIL_TOOLS.find((t) => t.slug === "webhook-verify");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (input) => tool.handler(input);
const throws400 = (input) => { try { run(input); return false; } catch (e) { return e.statusCode === 400; } };

const SECRET = "whsec_test_5up3r";
const PAYLOAD = '{"id":"evt_1","amount":1999}';
const noSecret = (r) => !JSON.stringify(r).includes(SECRET);

// ---------------------------------------------------------------- github
const ghSig = "sha256=" + createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
let r = run({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: ghSig });
ok(r.valid === true && r.provider === "github", `github: known-good sha256 vector verifies (${r.scheme})`);
ok(noSecret(r), "github: secret never appears in output");
r = run({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: ghSig.replace(/=(.)/, (m, c) => "=" + (c === "0" ? "1" : "0")) });
ok(r.valid === false, "github: tampered signature -> valid:false");
r = run({ provider: "github", payload: PAYLOAD, secret: "wrong-secret", signature: ghSig });
ok(r.valid === false && noSecret(r), "github: wrong secret -> valid:false (secret not echoed)");
const ghSha1 = "sha1=" + createHmac("sha1", SECRET).update(PAYLOAD).digest("hex");
r = run({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: ghSha1 });
ok(r.valid === true && r.scheme.includes("SHA1"), "github: legacy sha1= X-Hub-Signature accepted");
r = run({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: createHmac("sha256", SECRET).update(PAYLOAD).digest("hex") });
ok(r.valid === true, "github: bare hex (no sha256= prefix) accepted");
ok(throws400({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: "sha256=not-hex!!" }), "github: malformed (non-hex) signature -> 400");

// ---------------------------------------------------------------- stripe
const T = "1700000000"; // fixed epoch: deterministic, far in the past
const stripeSig = createHmac("sha256", SECRET).update(`${T}.${PAYLOAD}`).digest("hex");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${T},v1=${stripeSig}`, toleranceSeconds: 0 });
ok(r.valid === true, "stripe: t=,v1= header verifies with t parsed from the header (tolerance 0)");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${T},v1=deadbeef,v1=${stripeSig}`, toleranceSeconds: 0 });
ok(r.valid === true, "stripe: matches ANY v1 among multiple");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: stripeSig, timestamp: T, toleranceSeconds: 0 });
ok(r.valid === true, "stripe: bare hex signature + explicit timestamp verifies");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${T},v1=${"0".repeat(64)}`, toleranceSeconds: 0 });
ok(r.valid === false, "stripe: tampered v1 -> valid:false");
r = run({ provider: "stripe", payload: PAYLOAD, secret: "wrong-secret", signature: `t=${T},v1=${stripeSig}`, toleranceSeconds: 0 });
ok(r.valid === false && noSecret(r), "stripe: wrong secret -> valid:false");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${T},v1=${stripeSig}`, toleranceSeconds: 300 });
ok(r.valid === false && /replay tolerance/.test(r.reason) && typeof r.timestampAgeSeconds === "number" && r.timestampAgeSeconds > 300,
  `stripe: 2023 timestamp outside 300s tolerance -> valid:false with age (${r.timestampAgeSeconds}s)`);
const nowT = String(Math.floor(Date.now() / 1000));
const nowSig = createHmac("sha256", SECRET).update(`${nowT}.${PAYLOAD}`).digest("hex");
r = run({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${nowT},v1=${nowSig}` });
ok(r.valid === true && r.timestampAgeSeconds <= 5, "stripe: fresh timestamp passes the default 300s tolerance");
ok(throws400({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: stripeSig, toleranceSeconds: 0 }), "stripe: missing timestamp -> 400");
ok(throws400({ provider: "stripe", payload: PAYLOAD, secret: SECRET, signature: `t=${T},v0=abc`, toleranceSeconds: 0 }), "stripe: header without v1 -> 400");

// ---------------------------------------------------------------- shopify
const shopSig = createHmac("sha256", SECRET).update(PAYLOAD).digest("base64");
r = run({ provider: "shopify", payload: PAYLOAD, secret: SECRET, signature: shopSig });
ok(r.valid === true && r.scheme.includes("base64"), "shopify: base64 HMAC verifies");
r = run({ provider: "shopify", payload: PAYLOAD, secret: SECRET, signature: Buffer.from("x".repeat(32)).toString("base64") });
ok(r.valid === false, "shopify: tampered signature -> valid:false");
r = run({ provider: "shopify", payload: PAYLOAD, secret: "wrong-secret", signature: shopSig });
ok(r.valid === false && noSecret(r), "shopify: wrong secret -> valid:false");
ok(throws400({ provider: "shopify", payload: PAYLOAD, secret: SECRET, signature: "!!!not-base64!!!" }), "shopify: malformed base64 -> 400");

// ---------------------------------------------------------------- slack
const slackSig = "v0=" + createHmac("sha256", SECRET).update(`v0:${T}:${PAYLOAD}`).digest("hex");
r = run({ provider: "slack", payload: PAYLOAD, secret: SECRET, signature: slackSig, timestamp: T, toleranceSeconds: 0 });
ok(r.valid === true, "slack: v0 base-string vector verifies (tolerance 0)");
r = run({ provider: "slack", payload: PAYLOAD, secret: SECRET, signature: "v0=" + "0".repeat(64), timestamp: T, toleranceSeconds: 0 });
ok(r.valid === false, "slack: tampered signature -> valid:false");
r = run({ provider: "slack", payload: PAYLOAD, secret: "wrong-secret", signature: slackSig, timestamp: T, toleranceSeconds: 0 });
ok(r.valid === false && noSecret(r), "slack: wrong secret -> valid:false");
r = run({ provider: "slack", payload: PAYLOAD, secret: SECRET, signature: slackSig, timestamp: T, toleranceSeconds: 300 });
ok(r.valid === false && /replay tolerance/.test(r.reason) && r.timestampAgeSeconds > 300, "slack: stale timestamp outside 300s tolerance -> valid:false");
ok(throws400({ provider: "slack", payload: PAYLOAD, secret: SECRET, signature: slackSig, toleranceSeconds: 0 }), "slack: missing timestamp -> 400");

// ---------------------------------------------------------------- shared guards
ok(throws400({ provider: "github", payload: { hello: "world" }, secret: SECRET, signature: "sha256=aa" }), "non-string payload (object) -> 400 (raw body required)");
ok(throws400({ provider: "gitlab", payload: PAYLOAD, secret: SECRET, signature: "aa" }), "unknown provider -> 400");
ok(throws400({ provider: "slack", payload: PAYLOAD, secret: SECRET, signature: slackSig, timestamp: "not-a-number", toleranceSeconds: 0 }), "non-numeric timestamp -> 400");
ok(throws400({ provider: "github", payload: PAYLOAD, secret: SECRET, signature: ghSig, toleranceSeconds: -1 }), "negative toleranceSeconds -> 400");

// discovery example answers itself (answers-own-example CI depends on this)
r = run(tool.discovery.input);
ok(r.valid === true && r.provider === "github", "discovery example -> valid:true (answers its own example)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
