#!/usr/bin/env node
// Every body a seller writes (or a URL a caller chose serves) is read with a
// streaming byte cap: reading STOPS at the cap, it never buffers the whole body
// first and trims afterwards. Offline - each stub response is a pull-driven
// stream that counts the bytes the reader actually pulled, so the assertion is
// about memory held, not about what a function returned.
//
// The body under test is 24 MB; a capped reader pulls the cap plus at most one
// chunk of it.
//
// A capped read is still an honest read of an honest body: text is decoded the
// way Response.text() decodes it (a leading byte-order mark dropped), and the
// payer's two readers keep their character ceiling (a large non-ASCII answer
// under it is delivered whole). Each such case runs beside the cap it lives
// under.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "capped-body-reads-"));
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

const origFetch = globalThis.fetch;
const origWarn = console.warn; const origLog = console.log;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; origLog(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
console.warn = () => {}; console.log = () => {};

const MB = 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (text) => Buffer.concat([BOM, Buffer.from(text, "utf8")]);
const HUGE = 24 * MB;
const CHUNK = 64 * 1024;
/** A body of `size` bytes that is only produced as the reader pulls it. */
function metered(size = HUGE, fill = 0x61) {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (pulled >= size) { c.close(); return; }
      const n = Math.min(CHUNK, size - pulled);
      pulled += n;
      c.enqueue(new Uint8Array(n).fill(fill));
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => pulled };
}
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "5e".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
const challengeHdr = b64({ x402Version: 2, accepts: [accept] });
const receipt = b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" });
const isPaid = (init) => { const h = init?.headers || {}; return !!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"]); };
// Bounded = the cap plus at most two transport chunks (one in flight, one read ahead).
const bounded = (pulled, cap) => pulled <= cap + 2 * CHUNK;

// ---------------------------------------------------------------------------
// The helper itself
const cb = await import("../src/capped-body.js").catch(() => null);
ok(!!cb, "the shared capped reader exists (src/capped-body.js)");
if (cb) {
  const { readBytesCapped, readTextCapped, declaredLength } = cb;
  const m = metered();
  const r = await readBytesCapped(new Response(m.stream), 100_000);
  ok(r.truncated === true && r.bytes.length === 100_000 && bounded(m.pulled(), 100_000), `a 24 MB stream read with a 100 KB cap keeps exactly the cap and pulls ${m.pulled()} bytes`);
  const exact = metered(3 * CHUNK);
  const r2 = await readBytesCapped(new Response(exact.stream), 3 * CHUNK);
  ok(r2.truncated === false && r2.bytes.length === 3 * CHUNK, "a body exactly at the cap is whole, not truncated");
  const small = await readBytesCapped(new Response("hello"), 1024);
  ok(small.truncated === false && small.bytes.toString() === "hello", "CONTROL: a small body is returned whole");
  const empty = await readBytesCapped(new Response(null, { status: 204 }), 1024);
  ok(empty.bytes.length === 0 && empty.truncated === false, "a body-less response reads as empty");
  const nodeIter = await readBytesCapped({ body: (async function* () { for (let i = 0; i < 400; i++) yield Buffer.alloc(CHUNK, 0x62); })() }, 70_000);
  ok(nodeIter.truncated === true && nodeIter.bytes.length === 70_000, "a Node-style async-iterable body is capped the same way");
  const stub = await readBytesCapped({ text: async () => "x".repeat(5000) }, 100);
  ok(stub.truncated === true && stub.bytes.length === 100, "an object with no body stream (a test stub) falls back to its text(), capped");
  ok(await readTextCapped(new Response("héllo"), 1024) === "héllo", "text decodes as UTF-8");
  ok(declaredLength(new Response("x", { headers: { "content-length": "12345" } })) === 12345 && declaredLength(new Response("x")) === null, "declaredLength reads Content-Length, null when absent");
  let threw = null;
  try { await readBytesCapped(new Response(new ReadableStream({ pull(c) { c.error(new Error("socket reset")); } })), 1024); } catch (e) { threw = e; }
  ok(threw && /socket reset/.test(threw.message), "a stream error mid-body rejects, as text() would");
  // Decoding matches Response.text(): a UTF-8 byte-order mark is dropped.
  const bomJson = () => new Response(Buffer.concat([BOM, Buffer.from('{"a":1}')]));
  const viaText = await bomJson().text();
  const viaCapped = await readTextCapped(bomJson(), 1024);
  ok(viaCapped === viaText && viaCapped === '{"a":1}' && JSON.parse(viaCapped).a === 1, "a body opening with a byte-order mark decodes exactly as Response.text() decodes it");
  ok(typeof cb.decodeUtf8 === "function" && cb.decodeUtf8(Buffer.concat([BOM, Buffer.from("x")])) === "x" && cb.decodeUtf8(Buffer.from("x\ufeffy")) === "x\ufeffy", "decodeUtf8 drops only a LEADING mark");
}

const buyer = await import("../src/x402-buyer.js");

// ---------------------------------------------------------------------------
// payX402: the free-endpoint read (readCapped, a bare 200)
{
  const m = metered();
  globalThis.fetch = async () => new Response(m.stream, { status: 200, headers: { "content-type": "application/json" } });
  let e = null;
  try { await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (x) { e = x; }
  ok(e && e.statusCode === 502 && /size cap/.test(e.message), "payX402 bare 200 over the cap -> 502 size cap");
  ok(bounded(m.pulled(), 4 * 512 * 1024), `payX402 bare 200: pulled ${m.pulled()} bytes of 24 MB (byte ceiling 2 MB for a 512K-character cap)`);
  // A declared Content-Length over the cap is refused without reading.
  const m2 = metered();
  globalThis.fetch = async () => new Response(m2.stream, { status: 200, headers: { "content-type": "application/json", "content-length": String(HUGE) } });
  e = null;
  try { await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (x) { e = x; }
  ok(e && /size cap/.test(e.message) && m2.pulled() <= CHUNK, `an oversized Content-Length is refused before the body is read (pulled ${m2.pulled()})`);
  // CONTROL: a normal free answer is returned.
  globalThis.fetch = async () => new Response(JSON.stringify({ free: true }), { status: 200, headers: { "content-type": "application/json" } });
  const out = await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} });
  ok(out?.result?.free === true && out.quote === null, "CONTROL: a normal free endpoint still returns its JSON with no spend");
  // A free answer opening with a byte-order mark parses, as it did through text().
  globalThis.fetch = async () => new Response(withBom(JSON.stringify({ price: 1.23 })), { status: 200, headers: { "content-type": "application/json" } });
  const bom = await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }).catch((x) => ({ err: x }));
  ok(bom?.result?.price === 1.23, `a free JSON answer with a byte-order mark is parsed${bom?.err ? ` (threw ${bom.err.message})` : ""}`);
  // The ceiling is on characters: 200,000 CJK characters are 600 KB of UTF-8
  // and well under 512K characters, so they are delivered whole.
  const cjk = "\u6f22".repeat(200_000);
  globalThis.fetch = async () => new Response(JSON.stringify({ text: cjk }), { status: 200, headers: { "content-type": "application/json" } });
  const big = await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }).catch((x) => ({ err: x }));
  ok(big?.result?.text?.length === 200_000, `a 600 KB non-ASCII free answer under the character ceiling is delivered whole${big?.err ? ` (threw ${big.err.message})` : ""}`);
  // ...and the ceiling still holds on characters: 600K ASCII characters
  // (600 KB, under the byte ceiling) are over it.
  globalThis.fetch = async () => new Response(JSON.stringify({ text: "a".repeat(600_000) }), { status: 200, headers: { "content-type": "application/json" } });
  e = null;
  try { await buyer.payX402("https://free.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (x) { e = x; }
  ok(e && e.statusCode === 502 && /size cap/.test(e.message), "a free answer over 512K characters is refused, as before");
}

// payX402: the 402 body, the paid result (readAfterSpend), the refusal log and
// the X-PAYMENT sniff.
{
  const bare402 = metered();
  globalThis.fetch = async (url, init) => isPaid(init)
    ? new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } })
    : new Response(bare402.stream, { status: 402, headers: { "payment-required": challengeHdr } });
  const out = await buyer.payX402("https://s.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }).catch((e) => ({ err: e }));
  ok(out?.result?.ok === 1, `a huge 402 body does not stop a v2 header challenge from being paid${out?.err ? ` (threw ${out.err.message})` : ""}`);
  ok(bounded(bare402.pulled(), 256 * 1024), `the 402 body: pulled ${bare402.pulled()} bytes of 24 MB (cap 256 KB)`);

  const paidBody = metered(HUGE, 0x7b); // "{{{{..." - never valid JSON
  globalThis.fetch = async (url, init) => isPaid(init)
    ? new Response(paidBody.stream, { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } })
    : new Response("{}", { status: 402, headers: { "payment-required": challengeHdr } });
  const out2 = await buyer.payX402("https://s.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} });
  ok(out2?.result?._truncated === true && out2.receipt?.transaction, "a huge paid 200 is relayed truncated (never a throw after we paid), receipt kept");
  ok(bounded(paidBody.pulled(), 4 * 512 * 1024), `the paid result: pulled ${paidBody.pulled()} bytes of 24 MB (byte ceiling 2 MB for a 512K-character cap)`);

  // Paid answers an honest seller writes, delivered as they were through text().
  const paidWith = (body) => async (url, init) => isPaid(init)
    ? new Response(body, { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } })
    : new Response("{}", { status: 402, headers: { "payment-required": challengeHdr } });
  globalThis.fetch = paidWith(withBom(JSON.stringify({ answer: 42 })));
  const bomPaid = await buyer.payX402("https://s.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} });
  ok(bomPaid?.result?.answer === 42 && !("raw" in (bomPaid?.result || {})), "a paid JSON answer with a byte-order mark is delivered parsed, not as raw text");
  globalThis.fetch = paidWith(JSON.stringify({ text: "\u6f22".repeat(200_000) }));
  const cjkPaid = await buyer.payX402("https://s.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} });
  ok(cjkPaid?.result?.text?.length === 200_000 && cjkPaid.result._truncated === undefined, "a 600 KB non-ASCII paid answer under the character ceiling is delivered whole, not truncated");
  // A v1 seller carries its challenge in the 402 body; a mark in front of it
  // does not make the challenge unreadable.
  let v1Paid = 0;
  const v1Body = { x402Version: 1, accepts: [{ ...accept, network: "base", maxAmountRequired: "1000", resource: "https://v1.example/x", description: "", mimeType: "application/json" }] };
  globalThis.fetch = async (url, init) => {
    if (isPaid(init)) { v1Paid++; return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json", "x-payment-response": receipt } }); }
    return new Response(withBom(JSON.stringify(v1Body)), { status: 402, headers: { "content-type": "application/json" } });
  };
  const v1 = await buyer.payX402("https://v1.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }).catch((x) => ({ err: x }));
  ok(v1?.result?.ok === 1 && v1Paid === 1, `a v1 402 body with a byte-order mark is read, paid once and delivered${v1?.err ? ` (threw ${v1.err.message})` : ""}`);

  const refusal = metered(HUGE, 0x78);
  globalThis.fetch = async (url, init) => isPaid(init)
    ? new Response(refusal.stream, { status: 402, headers: { "content-type": "text/plain" } })
    : new Response("{}", { status: 402, headers: { "payment-required": challengeHdr } });
  const e3 = await buyer.payX402("https://s.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, notDebited: async () => ({ debited: true }) }).then(() => null, (e) => e);
  ok(e3 && /rejected the paid retry/.test(e3.message), "a paid retry refused with a huge body is still reported by status");
  ok(bounded(refusal.pulled(), 4 * 1024), `the refusal body (X-PAYMENT sniff + reason log): pulled ${refusal.pulled()} bytes of 24 MB`);
}

// Model-list read (resolve-time check on chat sellers).
{
  const m = metered();
  const verdict = await buyer.sellerServesModel("https://llm.example/v1/chat/completions", "gpt-x", { fetchImpl: async () => new Response(m.stream, { status: 200 }), trusted: true, now: 1 });
  ok(verdict.verdict === "unknown", "a huge model list is unreadable, and unknown never skips a seller");
  ok(bounded(m.pulled(), 512 * 1024), `the model list: pulled ${m.pulled()} bytes of 24 MB (cap 512 KB)`);
  buyer.__resetModelListsForTest();
  const listed = await buyer.sellerServesModel("https://llm2.example/v1/chat/completions", "gpt-x", { fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-y" }] }), { status: 200 }), trusted: true, now: 1 });
  ok(listed.verdict === "not-served", "CONTROL: a normal model list is still read and decides");
}

// Tempo buyer: the free-endpoint read and the paid read share readCapped.
{
  const { payTempo } = await import("../src/tempo-buyer.js");
  const m = metered();
  globalThis.fetch = async () => new Response(m.stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
  const out = await payTempo("https://tempo.example/x", { method: "POST", body: {}, maxAtomic: 5000n, trusted: true, createCredential: async () => "Payment x" });
  ok(out?.result?.truncated === true && bounded(m.pulled(), 512 * 1024), `Tempo: a huge body is truncated and pulled ${m.pulled()} bytes of 24 MB`);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  const small = await payTempo("https://tempo.example/x", { method: "POST", body: {}, maxAtomic: 5000n, trusted: true, createCredential: async () => "Payment x" });
  ok(small?.result?.ok === true, "Tempo CONTROL: a normal JSON body is parsed");
  globalThis.fetch = async () => new Response(withBom(JSON.stringify({ ok: true })), { status: 200, headers: { "content-type": "application/json" } });
  const bomT = await payTempo("https://tempo.example/x", { method: "POST", body: {}, maxAtomic: 5000n, trusted: true, createCredential: async () => "Payment x" });
  ok(bomT?.result?.ok === true, "Tempo: a JSON body with a byte-order mark is parsed");
}

// Seller payability: the unpaid leg reads a URL the CALLER chose.
{
  const { buildSellerPayabilityTool } = await import("../src/tools/seller-payability-kit.js");
  const m = metered();
  const tool = buildSellerPayabilityTool({
    pay: async () => { throw new Error("must not pay"); },
    fetchImpl: async () => new Response(m.stream, { status: 200, headers: { "content-type": "text/plain" } }),
    assertPublicUrl: async () => {},
    maySpend: () => ({ ok: true }), noteSpend: () => null, adjustSpend: () => {},
  });
  const out = await tool.handler({ url: "https://caller-chosen.example/x" }, {});
  ok(out?.unpaidCall?.status === 200 && typeof out.unpaidCall.bodySlice === "string" && out.unpaidCall.bodySlice.length === 400, "payability: the unpaid call is reported with its slice");
  ok(bounded(m.pulled(), 256 * 1024), `payability: pulled ${m.pulled()} bytes of 24 MB from the caller's URL (cap 256 KB)`);
  const m2 = metered();
  const tool2 = buildSellerPayabilityTool({
    pay: async () => ({ result: { ok: true }, quote: { usd: 0.001 }, receipt: { transaction: "0xtx", success: true } }),
    fetchImpl: async () => new Response(m2.stream, { status: 402, headers: { "payment-required": challengeHdr } }),
    assertPublicUrl: async () => {},
    maySpend: () => ({ ok: true }), noteSpend: () => null, adjustSpend: () => {},
  });
  const out2 = await tool2.handler({ url: "https://caller-chosen.example/x" }, {});
  ok(out2?.challenge?.readable === true && out2.payable === true && bounded(m2.pulled(), 256 * 1024), `payability CONTROL: a header challenge beside a huge body is decoded and paid (pulled ${m2.pulled()})`);
  // An honest v1 seller whose 402 body opens with a byte-order mark: the check
  // reads its challenge and pays it, as it did through text().
  const v1 = { x402Version: 1, accepts: [{ ...accept, network: "base", maxAmountRequired: "1000", resource: "https://v1.example/x", description: "", mimeType: "application/json" }] };
  let v1Pays = 0;
  const tool3 = buildSellerPayabilityTool({
    pay: async () => { v1Pays++; return { result: { ok: 1 }, quote: { usd: 0.001 }, receipt: { transaction: "0xtx", success: true } }; },
    fetchImpl: async () => new Response(withBom(JSON.stringify(v1)), { status: 402, headers: { "content-type": "application/json" } }),
    assertPublicUrl: async () => {},
    maySpend: () => ({ ok: true }), noteSpend: () => null, adjustSpend: () => {},
  });
  const out3 = await tool3.handler({ url: "https://v1.example/x" }, {});
  ok(out3?.challenge?.readable === true && out3.payment?.attempted === true && out3.payable === true && v1Pays === 1, `payability: a v1 challenge body with a byte-order mark is readable and paid (readable=${out3?.challenge?.readable}, reason=${out3?.challenge?.reason || "-"})`);
}

// The index crawler's live-402 read of a seller route.
{
  const { enrichLiveQuotes } = await import("../src/x402-index.js");
  const m = metered();
  globalThis.fetch = async () => new Response(m.stream, { status: 402, headers: { "payment-required": challengeHdr } });
  const rows = [{ seller: "example.com", route: "/huge", method: "POST", slug: "huge", price: null, networks: [] }];
  await enrichLiveQuotes(rows, "https://example.com", { ignoreBudget: true });
  ok(rows[0].price === 0.001, `the crawler still learns the header quote beside a huge body (price ${rows[0].price})`);
  ok(bounded(m.pulled(), 64_000), `the crawler: pulled ${m.pulled()} bytes of 24 MB from the seller route (cap 64 KB)`);
  // A 402 whose accepts ride in a body that opens with a byte-order mark
  // still yields its quote.
  const inBody = JSON.stringify({ x402Version: 2, accepts: [{ ...accept, amount: "2000" }] });
  globalThis.fetch = async () => new Response(withBom(inBody), { status: 402, headers: { "content-type": "application/json" } });
  const rows2 = [{ seller: "example.com", route: "/bom", method: "POST", slug: "bom", price: null, networks: [] }];
  await enrichLiveQuotes(rows2, "https://example.com", { ignoreBudget: true });
  ok(rows2[0].price === 0.002, `the crawler learns a body quote that opens with a byte-order mark (price ${rows2[0].price})`);
}

// Source pins where a behavioural drive needs a booted router.
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  ok(!/probe\.text\(\)/.test(fn) && (fn.match(/readTextCapped\(probe, 4000\)/g) || []).length === 2, "the resolver's two reads of a seller's probe body are capped streams");
  ok(/fetchImpl: async \(url, init\) => \{\s*const \{ ssrfDispatcher \} = await import\("\.\/tools\/fetch-guard\.js"\);\s*return fetch\(url, \{ \.\.\.init, dispatcher: ssrfDispatcher \}\);/.test(server),
    "the payability check still fetches through the pinned SSRF dispatcher");
  const pay = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const payFn = pay.slice(pay.indexOf("export async function payX402("));
  ok(!/\.text\(\)|\.json\(\)|\.arrayBuffer\(\)/.test(payFn.replace(/\/\/[^\n]*/g, "")), "payX402 reads no seller body whole (no text(), json() or arrayBuffer())");
  ok(/dispatcher: ssrfDispatcher,/.test(payFn) && /freshSsrfDispatcher\(\)/.test(payFn), "payX402 still pins both legs to the SSRF dispatcher");
  const tempo = readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
  ok(!/arrayBuffer\(\)/.test(tempo) && /readBytesCapped\(res, maxBytes\)/.test(tempo), "the Tempo buyer reads bodies through the capped stream");
  const readers = [pay, tempo, readFileSync(new URL("../src/capped-body.js", import.meta.url), "utf8")].map((t) => t.replace(/\/\/[^\n]*/g, "")).join("\n");
  ok(!/\.toString\(\s*["']utf-?8["']\s*\)/i.test(readers.replace(/Buffer\.from\([^)]*\)\.toString\("utf8"\)/g, "")), "no capped seller body is decoded with Buffer#toString (which keeps a byte-order mark); decodeUtf8 decodes them all");
}

console.warn = origWarn; console.log = origLog;
globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
