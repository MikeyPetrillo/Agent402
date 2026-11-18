#!/usr/bin/env node
// Signed receipts (src/receipt-signing.js): the key settings, the format and
// the paid path.
//
//   1. Offline: the one accepted key format (a PKCS8 Ed25519 PEM, base64 on
//      one line, with a key id) and every refusal, whose reason never quotes
//      the value; sign and verify round trip; a change to any record field,
//      the header or the signature fails; rotation (a retired key verifies
//      receipts issued inside its window only); the header stays under its
//      bound at every field's cap; signing costs under 1 ms a call; the
//      client package's verifyReceipt agrees.
//   2. A paid server WITH a key: every settling wire's 200 carries a receipt
//      that verifies against the published key document, names the
//      settlement the wire's own receipt header names, and digests the bytes
//      served and the request sent; an answer that failed (500) and a settle
//      that was refused (402) carry none; the conformance cells read true on
//      the rails it signs and false on the rest; POST /api/receipts/verify
//      answers the same verdicts.
//   3. Without a key (scripts/test-conformance.js section 2 runs the same
//      wires): no receipt header, the cells read false, the key document
//      lists no key.
//   4. A key with a retired list that does not read: signing refused at boot
//      with the reason (never the value), the cells read false, no receipt.
import "./lib/offline-stores.js";
import "./lib/file-mode.js";
import { generateKeyPairSync, createHmac } from "node:crypto";
import { bootPaidWires } from "./lib/paid-wires-rig.js";
import { loadReceiptKeys, buildReceiptRecord, signReceipt, verifyReceipt, requestDigest, responseDigest, receiptSignerMiddleware, RECEIPT_MAX_BYTES, RECEIPT_HEADER, RECEIPT_KEYS_PATH, RECEIPT_VERIFY_PATH, SIGNED_RAILS } from "../src/receipt-signing.js";
import { verifyReceipt as clientVerify, receiptRequestDigest } from "../client/receipt.js";
import { CONFORMANCE_PATH } from "../src/conformance.js";
import { LEAD_SENTENCE } from "../src/positioning.js";
// Page text for the copy checks (not a sanitizer): drop tags to a fixed point.
const textOf = (html) => { let s = String(html), prev; do { prev = s; s = s.replace(/<[^<>]*>/g, ""); } while (s !== prev); return s; };
const ledeOf = (html) => textOf((html.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "").replace(/\s+/g, " ").trim();

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const pemB64 = (keyObject) => Buffer.from(keyObject.export({ format: "pem", type: "pkcs8" })).toString("base64");
const ed = () => generateKeyPairSync("ed25519");
const A = ed(), B = ed();
const ENV_A = { RECEIPT_SIGNING_KEY: pemB64(A.privateKey), RECEIPT_SIGNING_KEY_ID: "r1-test" };
const xOf = (kp) => kp.publicKey.export({ format: "jwk" }).x;

// ---- 1. offline ----
{
  const off = loadReceiptKeys({});
  await ok(off.signer === null && off.error === null && off.keys.length === 0, "no key: signing off, no error");
  const on = loadReceiptKeys(ENV_A);
  await ok(on.signer?.kid === "r1-test" && on.keys.length === 1 && on.keys[0].x === xOf(A) && on.error === null, "a base64 PKCS8 Ed25519 PEM with a key id: signing on, the public key derived");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rawPem = A.privateKey.export({ format: "pem", type: "pkcs8" });
  const refusals = [
    [{ RECEIPT_SIGNING_KEY: ENV_A.RECEIPT_SIGNING_KEY }, /RECEIPT_SIGNING_KEY_ID/, "no key id"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY_ID: "has space" }, /RECEIPT_SIGNING_KEY_ID/, "a key id outside the alphabet"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY_ID: "x".repeat(33) }, /RECEIPT_SIGNING_KEY_ID/, "a key id over 32"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: rawPem }, /not one line of base64/, "the PEM itself, not base64"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: A.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") }, /PKCS8 PEM/, "base64 DER, not a PEM"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: Buffer.from(A.publicKey.export({ format: "pem", type: "spki" })).toString("base64") }, /PKCS8 PEM/, "a public key PEM"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: pemB64(rsa.privateKey) }, /rsa key, not Ed25519/, "an RSA key"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: pemB64(ec.privateKey) }, /ec key, not Ed25519/, "a P-256 key"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY: Buffer.from(`-----BEGIN ${"PRIVATE " + "KEY"}-----\nAAAA\n-----END ${"PRIVATE " + "KEY"}-----\n`).toString("base64") }, /does not parse/, "a PEM that does not parse"],
    [{ ...ENV_A, RECEIPT_SIGNING_KEY_VALID_FROM: "not a date" }, /VALID_FROM is not a date/, "a valid-from that is not a date"],
    [{ ...ENV_A, RECEIPT_RETIRED_KEYS: JSON.stringify([{ kid: "r1-test", x: xOf(B) }]) }, /also listed/, "the current kid also listed as retired"],
  ];
  for (const [env, re, what] of refusals) {
    const r = loadReceiptKeys(env);
    const leaked = typeof env.RECEIPT_SIGNING_KEY === "string" && env.RECEIPT_SIGNING_KEY.length > 24 && [0, 8, 40].some((i) => r.error?.includes(env.RECEIPT_SIGNING_KEY.slice(i, i + 16)));
    await ok(r.signer === null && re.test(r.error || "") && !leaked && !/PRIVATE KEY-----\n[A-Za-z0-9]/.test(r.error || ""), `refused, signing off: ${what} (${r.error})`);
  }
  // A retired list that does not read refuses signing (a receipt its keys
  // signed would stop verifying), with the reason and never the value.
  const retiredX = xOf(B);
  for (const [list, what] of [["{" + retiredX, "not JSON"], [JSON.stringify({ kid: "r0", x: retiredX }), "not an array"], [JSON.stringify([{ kid: "r0", x: retiredX }, { kid: "bad kid", x: retiredX }]), "an entry without a usable kid"], [JSON.stringify([{ kid: "r0", x: retiredX.slice(4) }]), "a short key"], [JSON.stringify([{ kid: "r0", x: retiredX, validUntil: "soon" }]), "a validUntil that is not a date"]]) {
    const r = loadReceiptKeys({ ...ENV_A, RECEIPT_RETIRED_KEYS: list });
    await ok(r.signer === null && r.keys.length === 0 && /RECEIPT_RETIRED_KEYS/.test(r.error || "") && /signing refused/.test(r.error || "") && !(r.error || "").includes(retiredX.slice(4, 24)), `a retired list that does not read refuses signing: ${what} (${r.error})`);
  }
  const twoRetired = loadReceiptKeys({ ...ENV_A, RECEIPT_RETIRED_KEYS: JSON.stringify([{ kid: "r0", x: retiredX, validUntil: "2026-06-01T00:00:00Z" }, { kid: "r00", x: xOf(ed()), validUntil: "2026-03-01T00:00:00Z" }]) });
  await ok(twoRetired.signer?.kid === "r1-test" && twoRetired.error === null && twoRetired.keys.map((k) => `${k.kid}:${k.status}`).join(",") === "r1-test:current,r0:retired,r00:retired", "a retired list that reads: the key signs and every retired key stays published");

  // Round trip and tamper.
  const signer = on.signer;
  const reqBody = { text: "hello" };
  const answer = Buffer.from(JSON.stringify({ sha256: "x" }));
  const rec = buildReceiptRecord({ iss: "https://example.test", method: "POST", path: "/api/hash", slug: "hash", requestSha256: requestDigest("POST", "/api/hash", reqBody), responseSha256: responseDigest(answer), priceUsd: 0.001, rail: "x402", network: "eip155:8453", payer: "0x" + "ab".repeat(20), settlement: "0x" + "cd".repeat(32) });
  const jws = signReceipt(rec, signer);
  const keys = on.keys;
  const v = verifyReceipt(jws, { keys, responseBody: answer, request: { method: "POST", path: "/api/hash", body: reqBody } });
  await ok(v.valid && v.checks.response && v.checks.request && v.record.id === rec.id, "sign and verify round trip, with the answer and request digests");
  await ok(receiptRequestDigest("POST", "/api/hash", reqBody) === rec.requestSha256, "the client computes the same request digest");
  const cv = await clientVerify(jws, { keys, body: answer, request: { method: "POST", path: "/api/hash", body: reqBody } });
  await ok(cv.valid && cv.record.settlement === rec.settlement, "the client package's verifyReceipt agrees");
  const [h, p, s] = jws.split(".");
  for (const field of Object.keys(rec)) {
    const t = { ...rec, [field]: typeof rec[field] === "boolean" ? !rec[field] : typeof rec[field] === "number" ? rec[field] + 1 : rec[field] == null ? "x" : `${rec[field]}x` };
    const forged = `${h}.${Buffer.from(JSON.stringify(t)).toString("base64url")}.${s}`;
    const r = verifyReceipt(forged, { keys });
    const c = await clientVerify(forged, { keys });
    await ok(!r.valid && !c.valid && (r.reason === "bad_signature" || r.reason === "unexpected_record"), `a changed ${field} fails (${r.reason}, client ${c.reason})`);
  }
  const sig = Buffer.from(s, "base64url"); sig[5] ^= 1;
  await ok(verifyReceipt(`${h}.${p}.${sig.toString("base64url")}`, { keys }).reason === "bad_signature", "a changed signature byte fails");
  const otherKid = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "r9", typ: "agent402-receipt+jws" })).toString("base64url");
  await ok(verifyReceipt(`${otherKid}.${p}.${s}`, { keys }).reason === "unknown_kid", "a header naming another kid fails");
  const noneAlg = Buffer.from(JSON.stringify({ alg: "none", kid: "r1-test", typ: "agent402-receipt+jws" })).toString("base64url");
  await ok(verifyReceipt(`${noneAlg}.${p}.${s}`, { keys }).reason === "unexpected_header" && verifyReceipt(`${noneAlg}.${p}.`, { keys }).valid === false, "alg none is refused");
  await ok(verifyReceipt(jws, { keys, responseBody: "other" }).reason === "response_mismatch", "another answer's bytes fail the response check");
  await ok(verifyReceipt(jws, { keys, request: { method: "POST", path: "/api/hash", body: { text: "other" } } }).reason === "request_mismatch", "another request fails the request check");
  await ok(verifyReceipt(jws, { keys: loadReceiptKeys({ ...ENV_A, RECEIPT_SIGNING_KEY: pemB64(B.privateKey) }).keys }).reason === "bad_signature", "a receipt checked against another key under the same kid fails");

  // Rotation: A retired at T, B current from T.
  const T = Date.parse("2026-11-01T00:00:00Z");
  const rot = loadReceiptKeys({ RECEIPT_SIGNING_KEY: pemB64(B.privateKey), RECEIPT_SIGNING_KEY_ID: "r2", RECEIPT_SIGNING_KEY_VALID_FROM: new Date(T).toISOString(), RECEIPT_RETIRED_KEYS: JSON.stringify([{ kid: "r1-test", x: xOf(A), validFrom: "2026-01-01T00:00:00Z", validUntil: new Date(T).toISOString() }]) });
  await ok(rot.signer.kid === "r2" && rot.keys.map((k) => `${k.kid}:${k.status}`).join(",") === "r2:current,r1-test:retired", "rotation: the current key and the retired one are both published");
  const old = signReceipt({ ...rec, iat: new Date(T - 1000).toISOString() }, signer);
  const late = signReceipt({ ...rec, iat: new Date(T + 1000).toISOString() }, signer);
  const fresh = signReceipt({ ...rec, iat: new Date(T + 1000).toISOString() }, rot.signer);
  const early = signReceipt({ ...rec, iat: new Date(T - 1000).toISOString() }, rot.signer);
  await ok(verifyReceipt(old, { keys: rot.keys }).valid, "rotation: a receipt the retired key signed inside its window still verifies");
  await ok(verifyReceipt(late, { keys: rot.keys }).reason === "key_not_valid_at_issue" && (await clientVerify(late, { keys: rot.keys })).reason === "key_not_valid_at_issue", "rotation: the retired key's receipt dated after its window fails");
  await ok(verifyReceipt(fresh, { keys: rot.keys }).valid && verifyReceipt(early, { keys: rot.keys }).reason === "key_not_valid_at_issue", "rotation: the new key verifies from its valid-from, not before");

  // Size bound at every cap.
  const big = buildReceiptRecord({ iss: "https://" + "h".repeat(400), method: "POST", path: "/" + "p".repeat(4000), slug: "s".repeat(400), requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), priceUsd: 123456.12345678, rail: "gateway-batched", network: "n".repeat(400), payer: "y".repeat(400), settlement: "z".repeat(4000), replay: true });
  const bigJws = signReceipt(big, signer);
  await ok(bigJws.length <= RECEIPT_MAX_BYTES, `every field at its cap: the header is ${bigJws.length} bytes, within ${RECEIPT_MAX_BYTES}`);
  await ok(jws.length < 1100, `a typical receipt is ${jws.length} bytes`);

  // Cost per paid call: record, digests of a 2 KB answer, sign.
  const body2k = Buffer.alloc(2048, 7);
  for (let i = 0; i < 200; i++) signReceipt(rec, signer);
  const N = 3000, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) signReceipt(buildReceiptRecord({ ...rec, requestSha256: requestDigest("POST", "/api/hash", reqBody), responseSha256: responseDigest(body2k) }), signer);
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  await ok(perCallMs < 1, `building and signing a receipt costs ${perCallMs.toFixed(3)} ms a call (under 1 ms)`);

  // The middleware alone: no receipt unless describe says settled and the
  // status is 200 in one end().
  const run = (status, desc, { write = false } = {}) => {
    const headers = new Map();
    const res = { statusCode: status, headersSent: false, setHeader: (k, val) => headers.set(k.toLowerCase(), val), write() { return true; }, end() { return this; } };
    const req = { method: "POST", path: "/api/hash", originalUrl: "/api/hash", body: reqBody };
    receiptSignerMiddleware({ describe: () => desc, signer: () => signer })(req, res, () => {});
    if (write) res.write("x");
    res.end(answer);
    return headers.get(RECEIPT_HEADER.toLowerCase()) || null;
  };
  const settled = { rail: "x402", network: "eip155:8453", payer: null, settlement: "0x01", priceUsd: 0.001, slug: "hash", replay: false };
  await ok(!!run(200, settled), "middleware: a settled 200 gets a receipt");
  for (const st of [400, 402, 404, 500, 502]) await ok(run(st, settled) === null, `middleware: a ${st} gets none`);
  await ok(run(200, null) === null, "middleware: a 200 with no settlement evidence gets none");
  await ok(run(200, { ...settled, rail: "credits" }) === null, "middleware: a rail it does not sign gets none");
  await ok(run(200, settled, { write: true }) === null, "middleware: a streamed answer (written before end) gets none");
  await ok(SIGNED_RAILS.join() === "x402,gateway-batched,mpp-evm,mpp-tempo,mpp-stripe", "the signed rails");
  // The method the buyer sent, though a later layer rewrites it (the POST/GET
  // alias in src/server.js) before the answer ends.
  for (const [sent, rewritten, body] of [["POST", "GET", { n: 1 }], ["GET", "POST", {}]]) {
    const headers = new Map();
    const res = { statusCode: 200, headersSent: false, setHeader: (k, val) => headers.set(k.toLowerCase(), val), write() { return true; }, end() { return this; } };
    const req = { method: sent, path: "/api/x", originalUrl: "/api/x?a=1", body };
    let seenAtEnd = null;
    receiptSignerMiddleware({ describe: (q) => { seenAtEnd = q.method; return settled; }, signer: () => signer })(req, res, () => { req.method = rewritten; });
    res.end(answer);
    const v = verifyReceipt(headers.get(RECEIPT_HEADER.toLowerCase()) || "", { keys, request: { method: sent, path: "/api/x?a=1", body: sent === "GET" ? undefined : body } });
    await ok(v.valid && v.record.method === sent && seenAtEnd === rewritten, `middleware: a ${sent} rewritten to ${rewritten} is named and digested as sent (${v.reason}, ${v.record?.method}); describe reads the rewritten method`);
  }
}

// ---- 2. a paid server with a key ----
const DUB = { method: "POST", path: "/api/dub", body: { text: "hello world", targetLanguage: "es" } };
const HASH = { method: "POST", path: "/api/hash", body: { text: "receipt" } };
const STRIPE_SK = "sk_test_receipts_never_used";
rig = await bootPaidWires({ label: "receipts", env: { ...ENV_A, RECEIPT_SIGNING_KEY_VALID_FROM: "2026-01-01T00:00:00Z", STRIPE_SECRET_KEY: STRIPE_SK, STRIPE_PROFILE_ID: "profile_test_receipts", STRIPE_WEBHOOK_SECRET: "", STRIPE_TOKEN_STUB: "on" } });
try {
  const keyDoc = await (await fetch(`${rig.url}${RECEIPT_KEYS_PATH}`)).json();
  await ok(keyDoc.signing === true && keyDoc.keys.length === 1 && keyDoc.keys[0].kid === "r1-test" && keyDoc.keys[0].x === xOf(A) && keyDoc.keys[0].validFrom === "2026-01-01T00:00:00.000Z", "the key document publishes the public key, its id and valid-from");
  await ok(!JSON.stringify(keyDoc).includes(ENV_A.RECEIPT_SIGNING_KEY.slice(30, 60)) && !/"d"\s*:/.test(JSON.stringify(keyDoc)), "the key document carries no private part");
  const doc = await (await fetch(`${rig.url}${CONFORMANCE_PATH}`)).json();
  const row = (id) => doc.rails.find((r) => r.id === id);
  const trust = await (await fetch(`${rig.url}/trust`)).text();
  const llms = await (await fetch(`${rig.url}/llms-full.txt`)).text();
  await ok(trust.includes(RECEIPT_HEADER) && trust.includes(RECEIPT_KEYS_PATH) && !trust.includes("no signature added by this server"), "with a key: /trust offers the signed receipt and its keys");
  await ok(llms.includes(RECEIPT_HEADER) && llms.includes(RECEIPT_VERIFY_PATH) && !llms.includes("`signedReceipt` reads false"), "with a key: llms-full.txt names the header and the check");
  // A streamed answer gets no receipt (the head leaves before the body), so
  // every surface that offers one scopes it to non-streamed answers.
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const scoped = [["/trust", textOf(trust)], ["llms-full.txt", llms], ["the conformance cell", row("x402:exact:eip155:8453").features.signedReceipt.detail], ["README.md", readme.split("\n").find((l) => l.includes("`Agent402-Receipt`")) || ""], ["client/README.md", readFileSync(new URL("../client/README.md", import.meta.url), "utf8").replace(/\s+/g, " ")]];
  for (const [where, text] of scoped) await ok(/non-streamed|not streamed/.test(text), `${where}: the signed receipt is scoped to answers that are not streamed`);
  {
    const lede = ledeOf(await (await fetch(`${rig.url}/`)).text());
    const summary = (llms.match(/^> (.*)$/m) || [])[1] || "";
    await ok(lede === LEAD_SENTENCE && summary.startsWith(LEAD_SENTENCE), `with a key: the home lede and the llms summary carry the full lead sentence, signed receipt clause included ("${lede}")`);
  }
  const WIRE_ROW = { evm: "x402:exact:eip155:8453", svm: "x402:exact:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", avm: doc.rails.find((r) => /^x402:exact:algorand/.test(r.id)).id, stellar: "x402:exact:stellar:pubnet", "mpp-evm": "mpp:evm:eip155:8453", tempo: "mpp:tempo:pull" };
  for (const id of [...Object.values(WIRE_ROW), "mpp:tempo:push", "mpp:stripe"]) await ok(row(id).features.signedReceipt.supported === true && /Agent402-Receipt/.test(row(id).features.signedReceipt.detail), `${id}: with a key the cell reads signed`);
  for (const id of ["credits", "card:checkout"]) await ok(row(id).features.signedReceipt.supported === false, `${id}: no per-call receipt, still false`);
  await ok(row("pow").features.signedReceipt.supported === null, "pow: does not apply");

  for (const [wire, id] of Object.entries(WIRE_ROW)) {
    const w = await rig.wallet(wire);
    rig.fund(w, 10n ** 12n);
    rig.st.llmStatus = 500;
    const bad = await rig.pay(w, DUB);
    rig.st.llmStatus = 0;
    await ok(bad.status >= 400 && !bad.headers.get(RECEIPT_HEADER), `${wire}: a failed answer (${bad.status}) carries no receipt`);
    const good = await rig.pay(w, HASH);
    const r = good.headers.get(RECEIPT_HEADER);
    await ok(good.status === 200 && !!r, `${wire}: the settled 200 carries ${RECEIPT_HEADER}`);
    const v = verifyReceipt(r, { keys: keyDoc.keys, responseBody: good.text, request: { method: "POST", path: HASH.path, body: HASH.body } });
    await ok(v.valid && v.checks.response && v.checks.request, `${wire}: it verifies against the published keys, the bytes served and the request sent (${v.reason})`);
    const rec = v.record;
    const pr = good.headers.get("payment-response");
    const settle = pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")) : null;
    const mppRef = (good.headers.get("payment-receipt") || "") ? JSON.parse(Buffer.from(good.headers.get("payment-receipt"), "base64url").toString("utf8")).reference : null;
    const expectRail = wire === "mpp-evm" ? "mpp-evm" : wire === "tempo" ? "mpp-tempo" : "x402";
    await ok(rec.rail === expectRail && rec.slug === "hash" && rec.method === "POST" && rec.path === "/api/hash" && rec.priceUsd && rec.replay === false, `${wire}: rail ${rec.rail}, route and price named (${rec.priceUsd})`);
    await ok(rec.settlement && (rec.settlement === settle?.transaction || rec.settlement === mppRef), `${wire}: the settlement is the one the wire's own receipt names (${String(rec.settlement).slice(0, 16)})`);
    await ok(wire === "tempo" ? rec.network === "eip155:4217" : rec.network === settle?.network, `${wire}: network ${rec.network}`);
    if (wire === "evm" || wire === "mpp-evm") await ok(String(rec.payer).toLowerCase() === w.address.toLowerCase(), `${wire}: the payer is the signed payer`);
    const api = await (await fetch(`${rig.url}${RECEIPT_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: r, body: good.text, request: { method: "POST", path: HASH.path, body: HASH.body } }) })).json();
    await ok(api.valid === true && api.record.id === rec.id, `${wire}: POST ${RECEIPT_VERIFY_PATH} agrees`);
    const cl = await clientVerify(r, { baseUrl: rig.url, body: good.text });
    await ok(cl.valid === true, `${wire}: the client fetches the keys and agrees`);
  }
  // The card wire (mpp:stripe): a capture the stub accepts is a settled 200
  // with a receipt naming the payment the wire's own receipt names.
  {
    // Cards carry a minimum, so the card wire is offered on a route priced above it.
    const CARD = { method: "POST", path: "/v1/premium/chat/completions", body: { messages: [{ role: "user", content: "say ok" }], max_tokens: 16 } };
    const o = await rig.offerOf(CARD);
    const seen = o.challenges.find((c) => c.method === "stripe");
    await ok(!!seen, "card: the route offers a card challenge");
    const cardSecret = createHmac("sha256", STRIPE_SK).update("mpp-challenge-signing").digest("base64");
    const card = (n) => ({ Authorization: rig.Credential.serialize({ challenge: rig.Challenge.from({ ...seen, id: undefined, expires: new Date(Date.now() + 280_000 + n), secretKey: cardSecret }), payload: { type: "spt", spt: `spt_test_receipts_${n}` } }) });
    const declined = await rig.send(CARD, card(1));
    await ok(declined.status === 402 && !declined.headers.get(RECEIPT_HEADER), `card: a declined capture (${declined.status}) carries no receipt`);
    rig.st.stripeCapture = "ok";
    const paid = await rig.send(CARD, card(2));
    rig.st.stripeCapture = "decline";
    const r = paid.headers.get(RECEIPT_HEADER);
    const v = verifyReceipt(r || "", { keys: keyDoc.keys, responseBody: paid.text, request: CARD });
    const ref = paid.headers.get("payment-receipt") ? JSON.parse(Buffer.from(paid.headers.get("payment-receipt"), "base64url").toString("utf8")).reference : null;
    await ok(paid.status === 200 && v.valid && v.checks.response && v.checks.request && v.record.rail === "mpp-stripe" && v.record.slug && !!ref && v.record.settlement === ref && v.record.priceUsd, `card: the captured 200 carries a receipt that verifies, rail mpp-stripe, naming the card payment (${paid.status}, ${v.reason}, ${v.record?.rail}, ${v.record?.settlement})`);
  }
  // The POST/GET alias: a POST to a GET-only tool and a GET to a POST tool
  // are served through the other method's gate chain; the receipt names and
  // digests the request the buyer sent.
  for (const route of [{ method: "POST", path: "/api/uuid", body: { count: 1 } }, { method: "GET", path: "/api/hash?text=receipt" }]) {
    const w = await rig.wallet("evm");
    rig.fund(w, 10n ** 12n);
    const good = await rig.pay(w, route);
    const v = verifyReceipt(good.headers.get(RECEIPT_HEADER) || "", { keys: keyDoc.keys, responseBody: good.text, request: { method: route.method, path: route.path, body: route.body } });
    await ok(good.status === 200 && v.valid && v.checks.request && v.record.method === route.method, `${route.method} ${route.path.split("?")[0]} (served by the other method): the receipt verifies as sent (${good.status}, ${v.reason}, method ${v.record?.method})`);
  }
  // A keyed resend replays the served answer without a second charge and
  // without settlement evidence of its own: no new receipt (the first one
  // covers those bytes, and still verifies against them).
  {
    const w = await rig.wallet("evm");
    rig.fund(w, 10n ** 12n);
    const headers = { ...(await rig.credentialFor(w, HASH)), "Idempotency-Key": `receipts-${Date.now()}` };
    const first = await rig.send(HASH, headers);
    await new Promise((r) => setTimeout(r, 300));
    const second = await rig.send(HASH, headers);
    const a = verifyReceipt(first.headers.get(RECEIPT_HEADER) || "", { keys: keyDoc.keys, responseBody: second.text });
    await ok(second.headers.get("x-idempotent-replay") === "true" && rig.outcomesOf(w).settled === 1 && !second.headers.get(RECEIPT_HEADER) && a.valid && a.record.replay === false, `a keyed replay carries no new receipt, and the first one verifies against the replayed bytes (settled ${rig.outcomesOf(w).settled}, ${a.reason})`);
  }
  // A refused settle: the payer cannot cover the price.
  {
    const w = await rig.wallet("evm");
    rig.fund(w, 1n);
    const refused = await rig.pay(w, HASH);
    await ok(refused.status === 402 && !refused.headers.get(RECEIPT_HEADER), `a refused settle (${refused.status}) carries no receipt`);
  }
  // An unpaid call and a free surface: none.
  {
    const unpaid = await fetch(`${rig.url}${HASH.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(HASH.body) });
    await ok(unpaid.status === 402 && !unpaid.headers.get(RECEIPT_HEADER), "an unpaid call (402) carries none");
    const health = await fetch(`${rig.url}/health`);
    await ok(!health.headers.get(RECEIPT_HEADER), "a free surface carries none");
  }
  // The verify endpoint refuses junk plainly.
  {
    const r1 = await fetch(`${rig.url}${RECEIPT_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await ok(r1.status === 400, "verify: no receipt is a 400");
    const r2 = await (await fetch(`${rig.url}${RECEIPT_VERIFY_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "a.b.c" }) })).json();
    await ok(r2.valid === false && typeof r2.reason === "string", `verify: junk is not valid (${r2.reason})`);
  }
  {
    const w = await rig.wallet("evm");
    rig.fund(w, 10n ** 12n);
    const good = await rig.pay(w, HASH);
    await ok(/(^|,\s*)Agent402-Receipt(,|$)/.test(good.headers.get("access-control-expose-headers") || ""), "a browser client can read the header (CORS exposes it)");
  }
} finally { await rig.stop(); rig = null; }

// ---- 3. without a key ----
rig = await bootPaidWires({ label: "receipts-off" });
try {
  const keyDoc = await (await fetch(`${rig.url}${RECEIPT_KEYS_PATH}`)).json();
  await ok(keyDoc.signing === false && keyDoc.keys.length === 0, "no key: the key document lists no key and says signing is off");
  const doc = await (await fetch(`${rig.url}${CONFORMANCE_PATH}`)).json();
  await ok(doc.rails.every((r) => r.features.signedReceipt.supported !== true), "no key: no row claims a signed receipt");
  const trust = await (await fetch(`${rig.url}/trust`)).text();
  const llms = await (await fetch(`${rig.url}/llms-full.txt`)).text();
  await ok(!trust.includes(RECEIPT_HEADER) && trust.includes("no signature added by this server") && !llms.includes(RECEIPT_HEADER), "no key: /trust and llms-full.txt do not offer a signed receipt");
  {
    const lede = ledeOf(await (await fetch(`${rig.url}/`)).text());
    const summary = (llms.match(/^> (.*)$/m) || [])[1] || "";
    await ok(lede.startsWith("Agent402 is the payment and trust layer for agent commerce") && !/signed receipt/.test(lede + summary.slice(0, 300)), `no key: the home lede and the llms summary drop the signed receipt clause ("${lede}")`);
  }
  const w = await rig.wallet("evm");
  rig.fund(w, 10n ** 12n);
  const good = await rig.pay(w, HASH);
  await ok(good.status === 200 && good.headers.get("payment-response") && !good.headers.get(RECEIPT_HEADER), "no key: a settled 200 carries the settlement receipt and no signed one");
} finally { await rig.stop(); rig = null; }

// ---- 4. a key with a retired list that does not read ----
{
  const badList = `[{"kid":"r0","x":"${xOf(B)}"`;
  rig = await bootPaidWires({ label: "receipts-bad-retired", env: { ...ENV_A, RECEIPT_RETIRED_KEYS: badList } });
  try {
    const log = rig.log();
    await ok(/\[receipts\] signing refused: RECEIPT_RETIRED_KEYS is not JSON/.test(log) && !log.includes(xOf(B).slice(2, 30)) && !log.includes(ENV_A.RECEIPT_SIGNING_KEY.slice(30, 60)) && !/\[receipts\] signing on/.test(log), "a retired list that does not read: the boot log says signing is refused and why, never the value");
    const keyDoc = await (await fetch(`${rig.url}${RECEIPT_KEYS_PATH}`)).json();
    await ok(keyDoc.signing === false, "a retired list that does not read: the key document says signing is off");
    const doc = await (await fetch(`${rig.url}${CONFORMANCE_PATH}`)).json();
    await ok(doc.rails.every((r) => r.features.signedReceipt.supported !== true), "a retired list that does not read: no conformance cell claims a signed receipt");
    const w = await rig.wallet("evm");
    rig.fund(w, 10n ** 12n);
    const good = await rig.pay(w, HASH);
    await ok(good.status === 200 && !good.headers.get(RECEIPT_HEADER), "a retired list that does not read: a settled 200 carries no signed receipt");
  } finally { await rig.stop(); rig = null; }
}

console.log(`\n${pass} checks passed`);
