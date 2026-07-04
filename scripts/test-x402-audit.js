// x402-audit grader (new tool) — deterministic, offline unit tests of
// gradeX402Response(). The tool probes a live seller's 402 and grades its
// externally-observable payment-security posture against the "Five Attacks on
// x402" failure modes; here we feed the grader synthetic probed responses (no
// network, no SSRF guard in the way) and assert the scoring is correct and
// honest.
import { gradeX402Response } from "../src/tools/x402-kit.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const find = (r, id) => r.checks.find((c) => c.id === id);

// A well-run v2 seller (like Agent402 post-M5): https, no-store, well-formed
// terms in the PAYMENT-REQUIRED header, clean body.
const goodHeader = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "base", payTo: "0x" + "a".repeat(40), maxAmountRequired: "1000" }],
})).toString("base64");
{
  const r = gradeX402Response({
    href: "https://good.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "no-store, private", bodyText: "{}", paymentRequiredHeader: goodHeader,
  });
  ok(r.grade === "A" && r.score >= 90, `well-run seller grades A (got ${r.grade} ${r.score})`);
  ok(find(r, "transport-tls").status === "pass", "TLS pass on https");
  ok(find(r, "cache-hygiene").status === "pass", "no-store → cache hygiene pass");
  ok(find(r, "terms-present").status === "pass", "well-formed terms pass");
  ok(find(r, "version").status === "pass", "v2 detected");
  ok(find(r, "error-hygiene").status === "pass", "clean body → no leak");
  ok(/can't be graded from a black-box/.test(r.summary), "summary is honest about un-observable attacks (II, IV)");
}

// Cache leakage (Attack III): a 402 that is publicly cacheable → hard fail on
// the highest-weighted check, dragging the grade down.
{
  const r = gradeX402Response({
    href: "https://leaky.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "public, max-age=600", bodyText: "{}", paymentRequiredHeader: goodHeader,
  });
  ok(find(r, "cache-hygiene").status === "fail", "public cache-control → cache-hygiene fail");
  ok(r.score < 90, `cache leak drops the score below A (got ${r.score})`);
}
{
  // No Cache-Control header at all is also a fail (nothing stops a shared cache).
  const r = gradeX402Response({
    href: "https://nocc.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "", bodyText: "{}", paymentRequiredHeader: goodHeader,
  });
  ok(find(r, "cache-hygiene").status === "fail", "missing Cache-Control → cache-hygiene fail");
}
{
  // private/no-cache is a partial credit (weaker than no-store).
  const r = gradeX402Response({
    href: "https://priv.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "private", bodyText: "{}", paymentRequiredHeader: goodHeader,
  });
  ok(find(r, "cache-hygiene").status === "warn", "private-only → cache-hygiene warn");
}

// Transport: http → the payment authorization is interceptable.
{
  const r = gradeX402Response({
    href: "http://insecure.example/api/paid", protocol: "http:", status: 402,
    cacheControl: "no-store", bodyText: "{}", paymentRequiredHeader: goodHeader,
  });
  ok(find(r, "transport-tls").status === "fail", "http → TLS fail");
  ok(r.grade !== "A", `http seller cannot grade A (got ${r.grade})`);
}

// Terms: 402 with no accepts anywhere → buyers can't learn how to pay.
{
  const r = gradeX402Response({
    href: "https://noterms.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "no-store", bodyText: "{}", paymentRequiredHeader: null,
  });
  ok(find(r, "terms-present").status === "fail", "no accepts → terms fail");
}

// v1 seller: terms in the body, not the header. Malformed payTo → warn.
{
  const r = gradeX402Response({
    href: "https://v1.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "no-store",
    bodyText: JSON.stringify({ accepts: [{ scheme: "exact", network: "base", payTo: "not-an-address", maxAmountRequired: "1000" }] }),
    paymentRequiredHeader: null,
  });
  ok(find(r, "terms-present").status === "pass", "v1 body terms parsed");
  ok(find(r, "payto-format").status === "warn", "malformed payTo → warn");
  ok(find(r, "version").status === "warn", "no version → warn");
}

// Solana payTo (base58) is accepted as well-formed.
{
  const solHeader = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", maxAmountRequired: "1000" }],
  })).toString("base64");
  const r = gradeX402Response({
    href: "https://sol.example/api/paid", protocol: "https:", status: 402,
    cacheControl: "no-store", bodyText: "{}", paymentRequiredHeader: solHeader,
  });
  ok(find(r, "payto-format").status === "pass", "base58 solana payTo → well-formed");
}

// Info leak: a stack trace in the body → error-hygiene fail.
{
  const r = gradeX402Response({
    href: "https://leak.example/api/paid", protocol: "https:", status: 500,
    cacheControl: "no-store",
    bodyText: "TypeError: cannot read x\n    at /home/app/src/server.js:42:10\n    at /usr/lib/node_modules/express/lib/router.js",
    paymentRequiredHeader: null,
  });
  ok(find(r, "error-hygiene").status === "fail", "stack trace in body → error-hygiene fail");
}

// Non-402 URL: payment-posture checks become informational, TLS + error still apply.
{
  const r = gradeX402Response({
    href: "https://free.example/api/open", protocol: "https:", status: 200,
    cacheControl: "public", bodyText: '{"ok":true}', paymentRequiredHeader: null,
  });
  ok(r.paymentRequired === false, "non-402 flagged not paymentRequired");
  ok(find(r, "payment-required").status === "info", "non-402 → informational, not a fail");
  ok(!find(r, "cache-hygiene"), "cache-hygiene not applied to a non-gated 200 (public caching is fine there)");
  ok(r.grade === "A" && r.score === 100, `clean https non-paid endpoint scores full on applicable checks (got ${r.grade} ${r.score})`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
