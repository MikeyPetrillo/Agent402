// The receipt-verify catalog tool and POST /api/receipts/verify read a
// submission through one function (checkReceiptSubmission,
// src/receipt-signing.js), so they give the same verdict: a receipt minted by
// the signer under a key the server publishes verifies on both, a tampered
// field or an unpublished key id fails on both with the reason, the tool
// refuses an oversized or malformed field with a 400 that names it, and its
// published example answers the same verdict on any server. Discovery:
// /api/find and the connector's catalog.find rank the tool first for receipt
// queries and keep x402-verify and jwt-verify first for theirs.
// Boots a FREE_MODE server on port 0 with a test receipt key (offline).
import "./lib/offline-stores.js";
import { generateKeyPairSync } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";
import { loadReceiptKeys, buildReceiptRecord, signReceipt, requestDigest, responseDigest, RECEIPT_VERIFY_PATH, RECEIPT_REQUEST_MAX_DEPTH } from "../src/receipt-signing.js";
import { KIT2 } from "../src/tools/kit2.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const pemB64 = (k) => Buffer.from(k.export({ format: "pem", type: "pkcs8" })).toString("base64");
const A = generateKeyPairSync("ed25519");
const OTHER = generateKeyPairSync("ed25519");
const ENV = { RECEIPT_SIGNING_KEY: pemB64(A.privateKey), RECEIPT_SIGNING_KEY_ID: "rv-test" };
const { signer } = loadReceiptKeys(ENV);
ok(!!signer, "the test key loads as a signer");

const callBody = { text: "hello", algorithm: "sha256" };
const answer = JSON.stringify({ hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
const rec = buildReceiptRecord({ iss: "http://127.0.0.1", method: "POST", path: "/api/hash", slug: "hash", requestSha256: requestDigest("POST", "/api/hash", callBody), responseSha256: responseDigest(Buffer.from(answer)), priceUsd: "0.25", rail: "x402", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000aa", settlement: "0x" + "ab".repeat(32) });
const good = signReceipt(rec, signer);
// A tampered field: the same signature over a payload whose amount was raised.
const [h, , s] = good.split(".");
const tampered = `${h}.${Buffer.from(JSON.stringify({ ...rec, priceUsd: "9" })).toString("base64url")}.${s}`;
const unknownKid = signReceipt(rec, { kid: "not-published", privateKey: OTHER.privateKey });

const tool = KIT2.find((t) => t.slug === "receipt-verify");
ok(!!tool && tool.route === "POST /api/receipt-verify", "receipt-verify is a kit tool at POST /api/receipt-verify");
const jwt = KIT2.find((t) => t.slug === "jwt-verify");
ok(tool?.price === jwt?.price, `priced at jwt-verify's tier (${tool?.price} vs ${jwt?.price})`);
ok(FREE_TIER_SLUGS.has("receipt-verify") && !WALLET_ONLY_SLUGS.has("receipt-verify"), "on the free tier allowlist and not wallet-only");

const srv = await bootServer({ stores: "receipt-verify-tool", env: { FREE_MODE: "true", ...ENV, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
const post = async (path, body) => {
  const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const VERDICT = (v) => JSON.stringify({ valid: v?.valid, reason: v?.reason, kid: v?.kid, record: v?.record, checks: v?.checks });
const both = async (label, sub, want) => {
  const t = await post("/api/receipt-verify", sub);
  const r = await post(RECEIPT_VERIFY_PATH, sub);
  ok(t.status === 200 && r.status === 200, `${label}: both answer 200 (tool ${t.status}, route ${r.status})`);
  ok(VERDICT(t.j) === VERDICT(r.j), `${label}: the tool and the route give the same verdict`);
  ok(t.j?.valid === want.valid && t.j?.reason === want.reason, `${label}: valid ${want.valid}, reason ${want.reason} (got ${t.j?.valid}, ${t.j?.reason})`);
  return t.j;
};
try {
  const v = await both("minted receipt", { receipt: good }, { valid: true, reason: null });
  ok(v?.kid === "rv-test" && v?.fields?.route === "POST /api/hash" && v?.fields?.priceUsd === "0.25" && v?.fields?.network === "eip155:8453" && v?.fields?.transaction === rec.settlement && v?.fields?.issuedAt === rec.iat, "the signed fields read back: key id, route, amount, network, transaction, time");
  ok(Array.isArray(v?.keys) && v.keys.some((k) => k.kid === "rv-test" && k.status === "current"), "the answer names the published key set");
  await both("minted receipt with its answer", { receipt: good, body: answer, request: { method: "POST", path: "/api/hash", body: callBody } }, { valid: true, reason: null });
  await both("minted receipt with its answer digest", { receipt: good, bodySha256: responseDigest(Buffer.from(answer)) }, { valid: true, reason: null });
  await both("another answer", { receipt: good, body: answer + " " }, { valid: false, reason: "response_mismatch" });
  await both("another request", { receipt: good, request: { method: "POST", path: "/api/hash", body: { text: "bye" } } }, { valid: false, reason: "request_mismatch" });
  const tv = await both("tampered amount", { receipt: tampered }, { valid: false, reason: "bad_signature" });
  ok(typeof tv?.detail === "string" && tv.detail.length > 10, "an invalid verdict carries a reason sentence");
  await both("unpublished key id", { receipt: unknownKid }, { valid: false, reason: "unknown_kid" });
  await both("garbage that is a string", { receipt: "not.a-receipt" }, { valid: false, reason: "not_a_compact_jws" });

  // A request body nested too deep: both answer 400 with the field named,
  // never a 500 (the text is built by hand: serializing such a value is what fails).
  {
    const raw = async (path, text) => { const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }); return { status: r.status, j: await r.json().catch(() => null) }; };
    const nested = (n) => `${"[".repeat(n)}1${"]".repeat(n)}`; // two bytes a level: under both body limits
    const sub = (n) => `{"receipt":${JSON.stringify(good)},"request":{"method":"POST","path":"/api/hash","body":${nested(n)}}}`;
    for (const n of [40_000, RECEIPT_REQUEST_MAX_DEPTH + 1]) {
      const t = await raw("/api/receipt-verify", sub(n)), r = await raw(RECEIPT_VERIFY_PATH, sub(n));
      ok(r.status === 400 && r.j?.field === "request.body" && /request\.body/.test(r.j?.error || "") && /nested/.test(r.j?.error || ""), `a request body nested ${n} levels: the route answers 400 naming request.body (${r.status}, ${String(r.j?.error).slice(0, 60)})`);
      ok(t.status === 400 && /nested/.test(t.j?.error || ""), `and the tool answers 400 (${t.status}, ${String(t.j?.error).slice(0, 60)})`);
    }
    const fits = await raw(RECEIPT_VERIFY_PATH, sub(RECEIPT_REQUEST_MAX_DEPTH));
    ok(fits.status === 200 && fits.j?.reason === "request_mismatch", `control: a body nested exactly ${RECEIPT_REQUEST_MAX_DEPTH} levels is read and judged (${fits.status}, ${fits.j?.reason})`);
    const after = await post(RECEIPT_VERIFY_PATH, { receipt: good });
    ok(after.status === 200 && after.j?.valid === true, "and the route still answers after them");
  }

  // The tool's own bounds: a 400 that names the field.
  const refusals = [
    [{ receipt: "x".repeat(5000) }, "receipt"],
    [{}, "receipt"],
    [{ receipt: { toString: 1 } }, "receipt"],
    [{ receipt: good, body: { a: 1 } }, "body"],
    [{ receipt: good, body: "y".repeat(65_537) }, "body"],
    [{ receipt: good, bodySha256: "zz" }, "bodySha256"],
    [{ receipt: good, request: [1] }, "request"],
    [{ receipt: good, request: { method: "P O", path: "/x" } }, "request.method"],
    [{ receipt: good, request: { method: "POST", path: "x".repeat(10) } }, "request.path"],
  ];
  for (const [sub, field] of refusals) {
    const t = await post("/api/receipt-verify", sub);
    ok(t.status === 400 && String(t.j?.error || "").includes(`"${field}"`), `refused 400 naming "${field}" (got ${t.status} ${String(t.j?.error || "").slice(0, 80)})`);
  }

  // The published example: the same verdict on any server, never empty.
  const ex = await post("/api/receipt-verify", tool.discovery.input);
  const doc = tool.discovery.output.example;
  ok(ex.status === 200 && ex.j?.valid === doc.valid && ex.j?.reason === doc.reason && ex.j?.kid === doc.kid && JSON.stringify(ex.j?.fields) === JSON.stringify(doc.fields) && JSON.stringify(ex.j?.record) === JSON.stringify(doc.record), "the published example answers its documented verdict and fields");

  // Discovery on both surfaces.
  const mcpFind = async (task) => {
    const r = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.find", arguments: { task } } }) });
    let text = await r.text();
    if ((r.headers.get("content-type") || "").startsWith("text/event-stream")) text = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    const res = JSON.parse(text).result;
    const out = res?.structuredContent ?? JSON.parse(res?.content?.[0]?.text || "{}");
    return (out.results || []).map((x) => x.slug);
  };
  const expect = [
    ["verify cryptographic signature on receipt data", "receipt-verify"],
    ["check receipt signature", "receipt-verify"],
    ["verify agent402 receipt", "receipt-verify"],
    ["verify x402 payment", "x402-verify"],
    ["verify a jwt", "jwt-verify"],
  ];
  for (const [q, want] of expect) {
    const j = await (await fetch(`${srv.url}/api/find?q=${encodeURIComponent(q)}&k=3`)).json();
    ok(j.results?.[0]?.slug === want, `/api/find "${q}" ranks ${want} first (got ${(j.results || []).map((x) => x.slug).join(",")})`);
    const m = await mcpFind(q);
    ok(m[0] === want, `catalog.find "${q}" ranks ${want} first (got ${m.join(",")})`);
  }
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
